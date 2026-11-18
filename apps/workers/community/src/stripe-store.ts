import { productPriceSource } from "@templ/chat/product-catalog";
import type {
  ProductCardBillingView,
  ProductPriceSource,
} from "@templ/chat/product-catalog";
import type { SupportCaseContributions } from "@templ/chat/support";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import {
  resolutionMonth,
  isPriceTable,
  normalizeStoredPriceTable,
  priceTableSteps,
  priceTableRaises,
  priceChangeAppliesAt,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import { PRODUCT_PRICE_VERSION } from "@templ/chat/plans";
import { HttpError, json, type Env } from "./common";
import { identityRequest } from "./account-identity";
import type { TemplStaffEnv } from "./templ-staff";
import { PRODUCT_STATE_KEY, readProductState } from "./product-entitlements";
import { emitCardAlerts } from "./product-alerts";
import { isProductPriceSource } from "./product-order-forms";
import { markWorkspaceStep } from "./funnel-metrics";
import { wakeRoomAt } from "./room-alarm";
import { nativeRecord } from "./native-rooms";
import { featureOn, workspaceFeatureEnvFor } from "./workspace-flags";
import { releaseActivationEnv } from "./release-activation";
import {
  stripeContributions,
  noteStripeInvoiceReasons,
  queueStripeInvoiceReasons,
  deliverStripeInvoiceReasons,
} from "./stripe-invoice-reasons";
import {
  StripeClient,
  assertCardBillingEnabled,
  cardBillingEnabled,
  cardBillingIngressEnabled,
  stripeObjectId,
  verifyStripeWebhook,
  reconcileStripeUsage,
  type StripeBillingEnv,
  type StripeEvent,
  type StripeFetcher,
  type StripePrice,
  type StripeActivationRequest,
} from "./stripe-billing";

type Storage = DurableObjectTransaction;
export type StripeStoreEnv = StripeBillingEnv &
  Partial<Pick<Env, "ROOMS" | "AUTH_RECORDS" | "TEMPL_STAFF_PRINCIPALS">>;
export const STRIPE_OWNER_PATH = "/private/product/stripe-owner";
export const STRIPE_INDEX_PATH = "/private/product/stripe-index";
export const STRIPE_ROOM_PATH = "/private/product/stripe-state";
export const STRIPE_ROOM_KEY = "product-stripe-room-v1";
export const STRIPE_COVERAGE_PREFIX = "product-stripe-coverage-v1:";
export const STRIPE_OUTBOX_PREFIX = "product-stripe-outbox-v1:";
export const STRIPE_OWNER_OUTBOX_PREFIX = "product-stripe-owner-outbox-v1:";
const OWNER_KEY = "product-stripe-owner-v1";
const INDEX_OBJECT = "stripe-billing-index";
const ROOM = /^room:[a-f0-9-]{36}$/;
const IDS = /^(cus|cs|sub|si|price|in)_[A-Za-z0-9_]+$/;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const unavailable = () => new HttpError(503, "Card billing is not available.");
export type StripeRoomState = {
  owner: string;
  customerId: string;
  subscriptionId: string | null;
  status: ProductCardBillingView["status"];
  card: ProductCardBillingView["card"];
  latestInvoice: { id: string; status: string } | null;
  unpaidInvoiceIds?: string[];
  cancelAtPeriodEnd: boolean;
  coverage: boolean;
  coverageStartedAt?: number | null;
  coverageEndedAt?: number | null;
  roomRevision?: number;
};
type OwnerState = StripeRoomState & {
  room: string | null;
  setupSessionId: string | null;
  setupRoom: string | null;
  subscriptionItemId: string | null;
  priceId: string | null;
  subscriptionVersion: { at: number; id: string; deleted: boolean } | null;
  invoiceVersion: { at: number; id: string; invoiceCreated?: number } | null;
  detached?: boolean;
  paymentMethodId?: string | null;
  customerVersion?: { at: number; id: string };
  setupPrice?: StripePrice;
};
type SubscriptionBinding = StripePrice & {
  room: string;
  itemId: string;
  priceVersion: string;
  priceIds?: string[];
};
type Usage = {
  customerId: string;
  subscriptionId: string;
  room: string;
  chargeId: string;
  finalAt: number;
  cents: number;
  contributions?: SupportCaseContributions;
  month: string;
  reported: boolean;
  credited: boolean;
  reportAttemptAt?: number;
  reportedAt?: number;
  creditAttemptAt?: number;
  creditMode?: "cancel" | "balance";
  adjustmentCents?: number;
  meterCanceled?: boolean;
  balanceAdjusted?: boolean;
  settlementAdjustmentCents?: number;
  settlementAdjusted?: boolean;
  eventName?: string;
};
const RETRY_WINDOW_MS = 23 * 3_600_000;
const retryReview = () =>
  new HttpError(
    409,
    "Card billing needs an operator review.",
    undefined,
    "stripe-retry-review",
  );
/** Stripe may forget request keys after 24 hours. An ambiguous older attempt never runs twice. */
async function beginAttempt(
  storage: Pick<Storage, "get" | "put">,
  key: string,
  now: number,
) {
  const first = await storage.get<number>(key);
  if (first !== undefined && now - first >= RETRY_WINDOW_MS)
    throw retryReview();
  if (first === undefined) await storage.put(key, now);
}
export type StripeUsageOutbox = {
  kind: "report" | "credit";
  owner: string;
  room: string;
  subscriptionId: string;
  chargeId: string;
  finalAt: number;
  cents: number;
  contributions?: SupportCaseContributions;
};
const post = (path: string, body: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function call(
  env: StripeStoreEnv,
  name: string,
  path: string,
  body: unknown,
): Promise<Record<string, any>> {
  if (!env.ROOMS) throw unavailable();
  const response = await env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(
    post(path, body),
  );
  if (!response.ok) {
    const reply = await response
      .json<{ error?: string; reason?: string }>()
      .catch(() => ({}));
    throw new HttpError(
      response.status,
      "error" in reply && typeof reply.error === "string"
        ? reply.error
        : "Card billing could not complete this step.",
      undefined,
      "reason" in reply && typeof reply.reason === "string"
        ? reply.reason
        : undefined,
    );
  }
  return response.json();
}
async function canonicalOwner(env: StripeStoreEnv, owner: string) {
  if (!env.AUTH_RECORDS) return owner;
  const identity = await identityRequest(env as Env, {
    op: "read",
    principalId: owner,
  });
  return identity.principalId;
}
function cardReleased(env: StripeStoreEnv) {
  return featureOn(env, undefined, "cardBilling");
}
async function stripeRoomEnv(
  env: StripeStoreEnv,
  room: string | null,
): Promise<StripeStoreEnv> {
  env = await releaseActivationEnv(env);
  if (cardReleased(env)) return env;
  if (!room || !ROOM.test(room) || !env.ROOMS) throw unavailable();
  return workspaceFeatureEnvFor(
    env as StripeStoreEnv & Pick<Env, "ROOMS">,
    room.slice(5),
  );
}
export async function stripeIndexRequest(
  storage: Pick<Storage, "get" | "put">,
  body: Record<string, unknown>,
) {
  const customer = body.customerId;
  if (typeof customer !== "string" || !/^cus_[A-Za-z0-9]+$/.test(customer))
    throw new HttpError(400, "Invalid Stripe customer.");
  const key = `stripe-customer-owner-v1:${customer}`;
  if (body.op === "register") {
    const owner = normalizeChatPrincipal(body.owner);
    if (!owner) throw new HttpError(400, "Invalid billing owner.");
    const old = await storage.get<string>(key);
    if (old && old !== owner) throw unavailable();
    await storage.put(key, owner);
    return json({ ok: true });
  }
  return json({ owner: (await storage.get<string>(key)) ?? null });
}
async function saveOwner(storage: Storage, state: OwnerState) {
  state.roomRevision = (state.roomRevision ?? 0) + 1;
  const room =
    state.status === "setup-pending"
      ? state.setupRoom
      : (state.room ?? state.setupRoom);
  if (state.detached || !room) {
    await storage.put(OWNER_KEY, state);
    return;
  }
  await storage.put({
    [OWNER_KEY]: state,
    [`${STRIPE_OWNER_OUTBOX_PREFIX}${String(state.roomRevision).padStart(16, "0")}:${room}`]:
      { ...state, room },
  });
  if ("setAlarm" in storage) await wakeRoomAt(storage, Date.now() + 1_000);
}
/** Owner mutations enqueue room updates. Delivery holds no owner lock or room transaction. */
export async function deliverStripeOwnerUpdates(
  storage: Pick<Storage, "get" | "list" | "delete">,
  env: StripeStoreEnv,
  now: number,
) {
  const rows = await storage.list<OwnerState & { room: string }>({
    prefix: STRIPE_OWNER_OUTBOX_PREFIX,
  });
  for (const [key, row] of rows) {
    if (!(await storage.get<boolean>(`stripe-detached-room-v1:${row.room}`)))
      await call(
        env,
        `native-room:${row.room.slice(5)}`,
        STRIPE_ROOM_PATH,
        row,
      );
    const latest = await storage.get<OwnerState>(key);
    if (latest?.roomRevision === row.roomRevision) await storage.delete(key);
  }
  return rows.size ? now + 1_000 : null;
}
const newer = (
  event: StripeEvent,
  version: { at: number; id: string } | null,
) =>
  !version ||
  event.created > version.at ||
  (event.created === version.at && event.id > version.id);
const version = (event: StripeEvent) => ({ at: event.created, id: event.id });
const tableTotal = (table: ResolutionPriceTable, cases: number) => {
  if (!isPriceTable(table) || !Number.isSafeInteger(cases) || cases < 0)
    throw unavailable();
  return priceTableSteps(table).reduce(
    (sum, step) =>
      sum +
      Math.max(0, Math.min(cases, step.toCase ?? cases) - step.fromCase + 1) *
        step.usdCents,
    0,
  );
};

async function subscriptionBinding(
  storage: Storage,
  subscriptionId: string,
): Promise<SubscriptionBinding> {
  const binding = await storage.get<SubscriptionBinding>(
    `stripe-subscription-v1:${subscriptionId}`,
  );
  const table = normalizeStoredPriceTable(binding?.table);
  if (
    !binding ||
    !table ||
    !binding.itemId ||
    !binding.meterId ||
    !binding.eventName ||
    !binding.priceId
  )
    throw unavailable();
  return { ...binding, table };
}

/** Update an active item's price at the catalog's notice date and preserve frozen charges. */
async function advanceSubscriptionPrice(
  storage: Storage,
  client: StripeClient,
  state: OwnerState,
  now: number,
) {
  if (!state.subscriptionId || state.detached) return null;
  const subscriptionId = state.subscriptionId;
  const binding = await subscriptionBinding(storage, subscriptionId);
  const catalog = await client.assertPrice();
  if (binding.priceId === catalog.priceId) return null;
  const publishedAt = Date.parse(`${PRODUCT_PRICE_VERSION}T00:00:00Z`);
  const appliesAt = priceTableRaises(binding.table, catalog.table)
    ? priceChangeAppliesAt(publishedAt)
    : publishedAt;
  if (now < appliesAt) return appliesAt;
  if (
    binding.meterId !== catalog.meterId ||
    binding.eventName !== catalog.eventName
  )
    throw retryReview();
  const key = `stripe-price-change-v1:${subscriptionId}:${catalog.priceId}`;
  let change = await storage.get<{
    at: number;
    old: SubscriptionBinding;
    next: StripePrice;
    month: string;
    adjustment: number;
    updated?: boolean;
    adjusted?: boolean;
  }>(key);
  if (!change) {
    const month = resolutionMonth(now),
      count =
        (await storage.get<number>(
          `stripe-meter-count-v1:${subscriptionId}:${month}`,
        )) ?? 0;
    change = {
      at: now,
      old: binding,
      next: catalog,
      month,
      adjustment:
        tableTotal(catalog.table, count) - tableTotal(binding.table, count),
    };
    await storage.put(key, change);
  }
  if (now - change.at >= RETRY_WINDOW_MS && !change.updated)
    throw retryReview();
  if (!change.updated) {
    const remote = await client.request(
      "POST",
      `/subscriptions/${subscriptionId}`,
      {
        "items[0][id]": binding.itemId,
        "items[0][price]": catalog.priceId,
        proration_behavior: "none",
      },
      `templ-price:${subscriptionId}:${catalog.priceId}`,
    );
    if (
      stripeObjectId(remote.customer) !== state.customerId ||
      !object(remote.items) ||
      !Array.isArray(remote.items.data) ||
      !remote.items.data.some(
        (item) =>
          object(item) &&
          item.id === binding.itemId &&
          stripeObjectId(item.price) === catalog.priceId,
      )
    )
      throw unavailable();
    change.updated = true;
    await storage.put(key, change);
  }
  if (change.adjustment && !change.adjusted) {
    if (now - change.at >= RETRY_WINDOW_MS) throw retryReview();
    await client.adjustCustomerBalance(
      {
        customerId: state.customerId,
        chargeId: `${subscriptionId}:${change.month}`,
        cents: change.adjustment,
      },
      `templ-price-month:${subscriptionId}:${catalog.priceId}:${change.month}`,
    );
    change.adjusted = true;
    await storage.put(key, change);
  }
  await storage.put(`stripe-subscription-v1:${subscriptionId}`, {
    ...binding,
    ...catalog,
    priceVersion: PRODUCT_PRICE_VERSION,
    priceIds: [
      ...new Set([
        ...(binding.priceIds ?? []),
        binding.priceId,
        catalog.priceId,
      ]),
    ],
  });
  state.priceId = catalog.priceId;
  await saveOwner(storage, state);
  return null;
}

function invoiceMonths(
  invoice: Record<string, unknown>,
  binding: Pick<SubscriptionBinding, "itemId" | "priceId" | "priceIds">,
) {
  const lines =
    object(invoice.lines) && Array.isArray(invoice.lines.data)
      ? invoice.lines.data
      : [];
  const months: string[] = [];
  for (const line of lines) {
    if (!object(line) || !object(line.period)) continue;
    const details =
      object(line.parent) && object(line.parent.subscription_item_details)
        ? line.parent.subscription_item_details
        : null;
    const pricing =
      object(line.pricing) && object(line.pricing.price_details)
        ? line.pricing.price_details
        : null;
    if (
      stripeObjectId(details?.subscription_item) !== binding.itemId ||
      ![binding.priceId, ...(binding.priceIds ?? [])].includes(
        stripeObjectId(pricing?.price) ?? "",
      ) ||
      !Number.isSafeInteger(line.period.start) ||
      !Number.isSafeInteger(line.period.end) ||
      Number(line.period.end) <= Number(line.period.start)
    )
      continue;
    months.push(resolutionMonth(Number(line.period.start) * 1_000));
  }
  return months;
}

async function invoiceMonthClosed(
  storage: Storage,
  client: StripeClient,
  state: OwnerState,
  binding: SubscriptionBinding,
  subscriptionId: string,
  month: string,
  now: number,
) {
  const key = `stripe-invoice-closed-month-v1:${subscriptionId}:${month}`;
  if ((await storage.get<boolean>(key)) === true) return true;
  let after = "";
  for (let page = 0; page < 100; page++) {
    const list = await client.request<{
      data: Record<string, unknown>[];
      has_more: boolean;
    }>("GET", "/invoices", {
      customer: state.customerId,
      subscription: subscriptionId,
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    if (!Array.isArray(list.data)) throw unavailable();
    for (const invoice of list.data) {
      const parent =
        object(invoice.parent) && object(invoice.parent.subscription_details)
          ? invoice.parent.subscription_details
          : null;
      if (
        stripeObjectId(invoice.customer) !== state.customerId ||
        stripeObjectId(parent?.subscription) !== subscriptionId
      )
        continue;
      if (
        invoiceMonths(invoice, binding).includes(month) &&
        ["open", "paid", "uncollectible", "void"].includes(
          String(invoice.status),
        )
      ) {
        await storage.put(key, true);
        return true;
      }
    }
    if (!list.has_more) {
      if (month < resolutionMonth(now)) throw retryReview();
      return false;
    }
    const last = list.data.at(-1)?.id;
    if (typeof last !== "string" || last === after) throw unavailable();
    after = last;
  }
  throw unavailable();
}

/** Owner alarms reconcile price changes and retry their durable workspace updates. */
export async function stripeOwnerAlarm(
  storage: DurableObjectStorage,
  env: StripeStoreEnv,
  now: number,
  serialize: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
) {
  const state = await storage.get<OwnerState>(OWNER_KEY);
  if (!state) return false;
  let due: number | null = null;
  try {
    env = await stripeRoomEnv(env, state.room ?? state.setupRoom);
    if (cardBillingEnabled(env))
      due = await serialize(async () => {
        try {
          const pending = await storage.get<StripeUsageOutbox>(
            "stripe-usage-pending-v1",
          );
          if (pending)
            await stripeOwnerRequest(
              storage as never,
              env,
              { op: "usage", owner: state.owner, usage: pending },
              now,
            );
          const moreReasons = await deliverStripeInvoiceReasons(
            storage,
            new StripeClient(env),
            now,
          );
          const current = await storage.get<OwnerState>(OWNER_KEY);
          const priceDue = current
            ? await advanceSubscriptionPrice(
                storage as never,
                new StripeClient(env),
                current,
                now,
              )
            : null;
          return moreReasons
            ? Math.min(priceDue ?? Infinity, now + 1_000)
            : priceDue;
        } catch {
          return now + 60_000;
        }
      });
    await deliverStripeOwnerUpdates(storage, env, now);
  } catch {
    due = now + 60_000;
  }
  if (due) await wakeRoomAt(storage, due);
  return true;
}

/** One customer and one active metered subscription per canonical billing owner. */
export async function stripeOwnerRequest(
  storage: Storage,
  env: StripeStoreEnv,
  body: Record<string, unknown>,
  now: number,
  fetcher?: StripeFetcher,
): Promise<Response> {
  env = await releaseActivationEnv(env);
  const owner = normalizeChatPrincipal(body.owner);
  if (!owner) throw new HttpError(400, "Invalid billing owner.");
  let state = await storage.get<OwnerState>(OWNER_KEY);
  if (state && state.owner !== owner) throw unavailable();
  let scopedRoom = state?.room ?? state?.setupRoom ?? null;
  if (body.op === "setup") {
    if (typeof body.room !== "string" || !ROOM.test(body.room))
      throw new HttpError(400, "Choose a workspace.");
    scopedRoom = body.room;
    if (!cardReleased(env)) {
      if (!env.ROOMS) throw unavailable();
      const { record } = await nativeRecord(
        env as StripeStoreEnv & Pick<Env, "ROOMS">,
        scopedRoom.slice(5),
      );
      if ((await canonicalOwner(env, record.room.creator)) !== owner)
        throw unavailable();
    }
  } else if (body.op === "usage") {
    const usage = body.usage;
    if (!state) throw unavailable();
    if (
      !object(usage) ||
      typeof usage.room !== "string" ||
      !ROOM.test(usage.room) ||
      typeof usage.subscriptionId !== "string" ||
      !/^sub_[A-Za-z0-9_]+$/.test(usage.subscriptionId)
    )
      throw new HttpError(400, "Invalid case usage.");
    const subscription = await storage.get<{ room: string }>(
      `stripe-subscription-v1:${usage.subscriptionId}`,
    );
    if (
      subscription?.room !== usage.room &&
      !(
        usage.subscriptionId === state.subscriptionId &&
        usage.room === state.room
      )
    )
      throw unavailable();
    scopedRoom = usage.room;
  }
  env = await stripeRoomEnv(env, scopedRoom);
  assertCardBillingEnabled(env);
  const client = new StripeClient(env, fetcher);
  if (body.op === "setup") {
    const setupRoom = scopedRoom!;
    if (state?.subscriptionId && state.room !== setupRoom)
      throw new HttpError(
        409,
        "This billing owner already pays by card for another workspace.",
        undefined,
        "stripe-owner-workspace-limit",
      );
    if (state?.subscriptionId)
      throw new HttpError(
        409,
        "Use Manage card to update your card.",
        undefined,
        "stripe-card-already-active",
      );
    const setupPrice = await client.assertPrice();
    if (
      body.priceSource !== undefined &&
      !isProductPriceSource(body.priceSource)
    )
      throw unavailable();
    const orderFormPrice =
      isProductPriceSource(body.priceSource) &&
      body.priceSource.kind === "order-form";
    if (
      orderFormPrice
        ? !isPriceTable(body.table, "order-form")
        : body.table &&
          (!isPriceTable(body.table) ||
            Object.keys(setupPrice.table).some(
              (key) =>
                (body.table as ResolutionPriceTable)[
                  key as keyof ResolutionPriceTable
                ] !== setupPrice.table[key as keyof ResolutionPriceTable],
            ))
    )
      throw unavailable();
    if (!state) {
      await beginAttempt(storage, "stripe-customer-create-at-v1", now);
      const customer = await client.createCustomer(owner);
      state = {
        owner,
        customerId: customer.id,
        room: null,
        setupSessionId: null,
        setupRoom: null,
        subscriptionId: null,
        subscriptionItemId: null,
        priceId: null,
        status: "none",
        card: null,
        latestInvoice: null,
        cancelAtPeriodEnd: false,
        coverage: false,
        subscriptionVersion: null,
        invoiceVersion: null,
      };
      await saveOwner(storage, state);
    }
    await call(env, INDEX_OBJECT, STRIPE_INDEX_PATH, {
      op: "register",
      customerId: state.customerId,
      owner,
    });
    const base = `${env.APP_ORIGIN}/inbox/${setupRoom.slice(5)}?tab=plan`;
    let setupAttempt = await storage.get<{
      id: string;
      at: number;
      room: string;
    }>("stripe-setup-attempt-v1");
    if (state.setupSessionId) {
      const existing = await client.request(
        "GET",
        `/checkout/sessions/${state.setupSessionId}`,
      );
      if (existing.status === "open" && typeof existing.url === "string") {
        if (state.setupRoom !== setupRoom)
          throw new HttpError(
            409,
            "Finish card setup for the other workspace first.",
            undefined,
            "stripe-setup-other-workspace",
          );
        const url = new URL(existing.url);
        if (url.origin !== "https://checkout.stripe.com") throw unavailable();
        return json({ url: existing.url, state });
      }
      if (existing.status === "complete")
        throw new HttpError(
          409,
          "We are checking with Stripe.",
          undefined,
          "stripe-setup-checking",
        );
      if (existing.status !== "expired") throw unavailable();
      state.setupSessionId = null;
      state.setupRoom = null;
      state.status = "none";
      setupAttempt = undefined;
      await storage.put("stripe-setup-attempt-v1", null);
      await saveOwner(storage, state);
    }
    if (state.setupRoom && state.setupRoom !== setupRoom)
      throw new HttpError(
        409,
        "Finish card setup for the other workspace first.",
        undefined,
        "stripe-setup-other-workspace",
      );
    if (
      setupAttempt &&
      (setupAttempt.room !== setupRoom ||
        now - setupAttempt.at >= RETRY_WINDOW_MS)
    )
      throw retryReview();
    if (!setupAttempt) {
      setupAttempt = { id: crypto.randomUUID(), at: now, room: setupRoom };
      await storage.put("stripe-setup-attempt-v1", setupAttempt);
    }
    const setup = await client.setupSession({
      customerId: state.customerId,
      successUrl: `${base}&stripeSetup=returned`,
      cancelUrl: `${base}&stripeSetup=canceled`,
      idempotencyKey: `templ-setup:${setupAttempt.id}`,
    });
    state.setupSessionId = setup.id;
    state.setupRoom = setupRoom;
    state.setupPrice = setupPrice;
    state.status = "setup-pending";
    await saveOwner(storage, state);
    return json({ url: setup.url, state });
  }
  if (!state) throw unavailable();
  if (body.op === "close-workspace") {
    if (typeof body.room !== "string" || !ROOM.test(body.room))
      throw unavailable();
    await storage.put(`stripe-detached-room-v1:${body.room}`, true);
    if (body.room !== state.room && body.room !== state.setupRoom)
      return json({ ok: true });
    if (state.subscriptionId)
      await client.cancelAtPeriodEnd(
        state.subscriptionId,
        `templ-cancel-sub:${state.subscriptionId}`,
      );
    else if (state.setupSessionId) {
      await client.request(
        "POST",
        `/checkout/sessions/${state.setupSessionId}/expire`,
        {},
        `templ-expire-setup:${state.setupSessionId}`,
      );
      state.setupSessionId = null;
      state.setupRoom = null;
      state.status = "none";
    }
    state.detached = true;
    await saveOwner(storage, state);
    return json({ ok: true });
  }
  if (body.op === "portal" || body.op === "method") {
    if (body.room !== state.room || !state.subscriptionId)
      throw new HttpError(409, "Finish card setup first.");
    if (body.op === "portal")
      return json(
        await client.portalSession({
          customerId: state.customerId,
          returnUrl: `${env.APP_ORIGIN}/inbox/${state.room!.slice(5)}?tab=plan`,
          idempotencyKey: `templ-portal:${state.room!.slice(5)}:${Math.floor(now / 60_000)}`,
        }),
      );
    await client.cancelAtPeriodEnd(
      state.subscriptionId,
      `templ-cancel-sub:${state.subscriptionId}`,
    );
    // Coverage and cancellation status change only when the signed subscription event arrives.
    return json({ cancelAtPeriodEnd: true });
  }
  if (body.op === "usage") {
    const row = body.usage as StripeUsageOutbox;
    if (
      !row ||
      !["report", "credit"].includes(row.kind) ||
      row.owner !== state.owner ||
      typeof row.room !== "string" ||
      !ROOM.test(row.room) ||
      !/^sub_[A-Za-z0-9_]+$/.test(row.subscriptionId) ||
      !/^[a-f0-9-]{36}:[a-f0-9]{16}$/.test(row.chargeId) ||
      row.chargeId.slice(0, 36) !== row.room.slice(5) ||
      !Number.isSafeInteger(row.finalAt) ||
      row.finalAt < 0 ||
      row.finalAt > now ||
      !Number.isSafeInteger(row.cents) ||
      row.cents <= 0
    )
      throw new HttpError(400, "Invalid case usage.");
    const subscription = await storage.get<{ room: string }>(
      `stripe-subscription-v1:${row.subscriptionId}`,
    );
    if (
      subscription?.room !== row.room &&
      !(row.subscriptionId === state.subscriptionId && row.room === state.room)
    )
      throw unavailable();
    // Finish an accepted Stripe effect before another case changes the graduated count.
    const pendingKey = "stripe-usage-pending-v1";
    const pending = await storage.get<StripeUsageOutbox | null>(pendingKey);
    if (
      pending &&
      (pending.chargeId !== row.chargeId || pending.kind !== row.kind)
    ) {
      await stripeOwnerRequest(
        storage,
        env,
        { op: "usage", owner, usage: pending },
        now,
        fetcher,
      );
    }
    if (
      !pending ||
      pending.chargeId !== row.chargeId ||
      pending.kind !== row.kind
    ) {
      const priceDue = await advanceSubscriptionPrice(
        storage,
        client,
        state,
        now,
      );
      if (priceDue && "setAlarm" in storage)
        await wakeRoomAt(storage, priceDue);
    }
    const binding = await subscriptionBinding(storage, row.subscriptionId);
    type SettledUsage = Usage & {
      invoiceClosedAtReport?: boolean;
      lateInvoiceDebited?: boolean;
    };
    const key = `stripe-usage-v1:${row.chargeId}`;
    const contributions = stripeContributions(row.contributions, row.finalAt);
    let usage = await storage.get<SettledUsage>(key);
    if (!usage)
      usage = {
        customerId: state.customerId,
        subscriptionId: row.subscriptionId,
        room: row.room,
        chargeId: row.chargeId,
        finalAt: row.finalAt,
        cents: row.cents,
        contributions,
        month: resolutionMonth(row.finalAt),
        reported: false,
        credited: false,
        eventName: binding.eventName,
      };
    if (
      usage.finalAt !== row.finalAt ||
      usage.customerId !== state.customerId ||
      usage.cents !== row.cents ||
      usage.subscriptionId !== row.subscriptionId ||
      usage.room !== row.room
    )
      throw unavailable();
    if (
      row.kind === "report" &&
      !(usage.credited && !usage.reported) &&
      JSON.stringify(usage.contributions) !== JSON.stringify(contributions)
    )
      throw unavailable();
    if (row.kind === "report" && usage.credited && !usage.reported)
      usage.contributions = contributions;
    const countKey = `stripe-meter-count-v1:${usage.subscriptionId}:${usage.month}`;
    await storage.put(pendingKey, row);
    if (row.kind === "report" && !usage.reported && !usage.credited) {
      if (
        usage.reportAttemptAt !== undefined &&
        now - usage.reportAttemptAt >= RETRY_WINDOW_MS
      )
        throw retryReview();
      usage.reportAttemptAt ??= now;
      usage.invoiceClosedAtReport ??= await invoiceMonthClosed(
        storage,
        client,
        state,
        binding,
        usage.subscriptionId,
        usage.month,
        now,
      );
      if (usage.settlementAdjustmentCents === undefined) {
        const count = (await storage.get<number>(countKey)) ?? 0;
        const before = tableTotal(binding.table, count);
        const after = tableTotal(binding.table, count + 1);
        usage.settlementAdjustmentCents = usage.invoiceClosedAtReport
          ? 0
          : after - before - usage.cents;
      }
      await storage.put(key, usage);
      await client.reportUsage({
        customerId: state.customerId,
        chargeId: row.chargeId,
        finalAt: row.finalAt,
        eventName: usage.eventName,
      });
      usage.reported = true;
      usage.reportedAt = usage.reportAttemptAt;
      await storage.put({
        [key]: usage,
        [countKey]: ((await storage.get<number>(countKey)) ?? 0) + 1,
      });
    }
    if (
      row.kind === "report" &&
      usage.reported &&
      usage.invoiceClosedAtReport &&
      !usage.lateInvoiceDebited
    ) {
      if (now - usage.reportAttemptAt! >= RETRY_WINDOW_MS) throw retryReview();
      // A closed invoice cannot collect this event. Charge its frozen amount on the next invoice.
      await client.adjustCustomerBalance(
        {
          customerId: state.customerId,
          chargeId: row.chargeId,
          cents: -usage.cents,
        },
        `templ-late-case:${row.chargeId}`,
      );
      usage.lateInvoiceDebited = true;
      await storage.put(key, usage);
    }
    if (
      row.kind === "report" &&
      usage.reported &&
      usage.settlementAdjustmentCents &&
      !usage.settlementAdjusted
    ) {
      if (now - usage.reportAttemptAt! >= RETRY_WINDOW_MS) throw retryReview();
      await client.adjustCustomerBalance(
        {
          customerId: state.customerId,
          chargeId: row.chargeId,
          cents: usage.settlementAdjustmentCents,
        },
        `templ-price-adjust:${row.chargeId}`,
      );
      usage.settlementAdjusted = true;
      await storage.put(key, usage);
    }
    if (row.kind === "credit" && !usage.credited) {
      if (usage.reported) {
        if (
          usage.creditAttemptAt !== undefined &&
          now - usage.creditAttemptAt >= RETRY_WINDOW_MS
        )
          throw retryReview();
        if (!usage.creditMode) {
          const closed = await invoiceMonthClosed(
            storage,
            client,
            state,
            binding,
            usage.subscriptionId,
            usage.month,
            now,
          );
          usage.creditMode =
            usage.invoiceClosedAtReport ||
            closed ||
            usage.reportedAt === undefined ||
            now - usage.reportedAt >= RETRY_WINDOW_MS
              ? "balance"
              : "cancel";
          if (usage.creditMode === "cancel") {
            const count = await storage.get<number>(countKey);
            if (!Number.isSafeInteger(count) || count! < 1) throw retryReview();
            const before = tableTotal(binding.table, count!);
            const after = tableTotal(binding.table, count! - 1);
            usage.adjustmentCents = usage.cents - (before - after);
          }
        }
        usage.creditAttemptAt ??= now;
        await storage.put(key, usage);
        if (usage.creditMode === "balance")
          await client.creditCustomer({
            customerId: state.customerId,
            chargeId: row.chargeId,
            cents: row.cents,
          });
        else {
          if (!usage.meterCanceled) {
            await client.cancelUsage(
              row.chargeId,
              `templ-cancel:${row.chargeId}`,
              usage.eventName,
            );
            usage.meterCanceled = true;
            await storage.put({
              [key]: usage,
              [countKey]: ((await storage.get<number>(countKey)) ?? 1) - 1,
            });
          }
          if (usage.adjustmentCents && !usage.balanceAdjusted) {
            await client.adjustCustomerBalance(
              {
                customerId: state.customerId,
                chargeId: row.chargeId,
                cents: usage.adjustmentCents,
              },
              `templ-tier-credit:${row.chargeId}`,
            );
            usage.balanceAdjusted = true;
          }
        }
      }
      usage.credited = true;
    }
    await noteStripeInvoiceReasons(storage, usage);
    await storage.put(key, usage);
    await storage.put(pendingKey, null);
    return json({ reported: usage.reported, credited: usage.credited });
  }
  if (body.op !== "webhook" || !object(body.event))
    throw new HttpError(400, "Invalid billing request.");
  const event = body.event as StripeEvent;
  const key = `stripe-event-v1:${event.id}`;
  if (await storage.get(key)) return json({ received: true });
  const data = event.data.object;
  // A known customer must match independently of every metadata field.
  if (
    (event.type === "customer.updated"
      ? data.id
      : stripeObjectId(data.customer)) !== state.customerId
  )
    if (event.type === "invoice.created") throw unavailable();
    else return json({ received: true });
  if (event.type === "invoice.created") {
    const parent =
      object(data.parent) && object(data.parent.subscription_details)
        ? data.parent.subscription_details
        : null;
    const subscriptionId = stripeObjectId(parent?.subscription);
    const binding = subscriptionId
      ? await storage.get<SubscriptionBinding>(
          `stripe-subscription-v1:${subscriptionId}`,
        )
      : null;
    if (
      !/^in_[A-Za-z0-9_]+$/.test(data.id) ||
      !binding ||
      !subscriptionId ||
      data.status !== "draft"
    )
      throw unavailable();
    const months = [...new Set(invoiceMonths(data, binding))];
    if (
      !months.length ||
      months.length > 2 ||
      (object(data.lines) && data.lines.has_more === true)
    )
      throw unavailable();
    const pending = await storage.get<StripeUsageOutbox>(
      "stripe-usage-pending-v1",
    );
    if (pending)
      await stripeOwnerRequest(
        storage,
        env,
        { op: "usage", owner, usage: pending },
        now,
        fetcher,
      );
    await queueStripeInvoiceReasons(storage, {
      invoiceId: data.id,
      customerId: state.customerId,
      subscriptionId,
      eventId: event.id,
      months,
      footer: data.footer,
      now,
    });
    if ("setAlarm" in storage) await wakeRoomAt(storage, now + 1_000);
    await deliverStripeInvoiceReasons(storage, client, now, data.id);
    await storage.put(key, { at: now });
    return json({ received: true });
  }
  if (
    event.type === "payment_method.attached" ||
    event.type === "payment_method.updated"
  ) {
    if (!/^pm_[A-Za-z0-9_]+$/.test(data.id) || !object(data.card))
      return json({ received: true });
    const card = data.card;
    if (
      typeof card.brand !== "string" ||
      !/^[a-zA-Z0-9 _-]{1,24}$/.test(card.brand) ||
      typeof card.last4 !== "string" ||
      !/^\d{4}$/.test(card.last4)
    )
      return json({ received: true });
    const cardKey = `stripe-card-webhook-v1:${data.id}`;
    const old = await storage.get<{
      at: number;
      id: string;
      card: { brand: string; last4: string };
    }>(cardKey);
    if (newer(event, old ?? null)) {
      const next = {
        ...version(event),
        card: { brand: card.brand, last4: card.last4 },
      };
      await storage.put(cardKey, next);
      if (data.id === state.paymentMethodId) state.card = next.card;
    }
  } else if (event.type === "customer.updated") {
    if (
      newer(event, state.customerVersion ?? null) &&
      object(data.invoice_settings)
    ) {
      state.customerVersion = version(event);
      state.paymentMethodId = stripeObjectId(
        data.invoice_settings.default_payment_method,
      );
      const saved = state.paymentMethodId
        ? await storage.get<{ card: ProductCardBillingView["card"] }>(
            `stripe-card-webhook-v1:${state.paymentMethodId}`,
          )
        : null;
      state.card = saved?.card ?? null;
    }
  } else if (event.type === "checkout.session.completed") {
    if (
      data.id !== state.setupSessionId ||
      data.mode !== "setup" ||
      !state.setupRoom ||
      !stripeObjectId(data.setup_intent)
    )
      return json({ received: true });
    if (!state.subscriptionId) {
      const attemptKey = `stripe-activation-request-v1:${data.id}`;
      let attempt = await storage.get<{
        at: number;
        request: StripeActivationRequest;
      }>(attemptKey);
      const retry = Boolean(attempt);
      if (!attempt) {
        const catalog = await client.assertPrice();
        const old = state.setupPrice;
        const noticeAt = priceChangeAppliesAt(
          Date.parse(`${PRODUCT_PRICE_VERSION}T00:00:00Z`),
        );
        const selected =
          old && priceTableRaises(old.table, catalog.table) && now < noticeAt
            ? old
            : catalog;
        attempt = {
          at: now,
          request: await client.prepareActivation(
            {
              customerId: state.customerId,
              setupIntentId: stripeObjectId(data.setup_intent)!,
              idempotencyKey: `templ-activate:${data.id}`,
              nowMs: now,
            },
            selected,
          ),
        };
        await storage.put(attemptKey, attempt);
      }
      const activated = await client.activateSubscription(
        attempt.request,
        retry,
        now - attempt.at >= RETRY_WINDOW_MS,
      );
      await storage.put(`stripe-subscription-v1:${activated.subscriptionId}`, {
        room: state.setupRoom,
        itemId: activated.subscriptionItemId,
        priceId: activated.priceId,
        meterId: activated.meterId,
        eventName: activated.eventName,
        table: activated.table,
        priceVersion: PRODUCT_PRICE_VERSION,
      } satisfies SubscriptionBinding);
      state.detached = false;
      state.subscriptionId = activated.subscriptionId;
      state.subscriptionItemId = activated.subscriptionItemId;
      state.priceId = activated.priceId;
      state.room = state.setupRoom;
      state.paymentMethodId = activated.paymentMethodId;
      state.customerVersion = version(event);
      const signedCard = await storage.get<{
        card: ProductCardBillingView["card"];
      }>(`stripe-card-webhook-v1:${activated.paymentMethodId}`);
      state.card = signedCard?.card ?? null;
      state.coverageStartedAt = now;
      state.coverageEndedAt = null;
      state.coverage = true;
      state.status = "active";
      state.subscriptionVersion = { ...version(event), deleted: false };
    }
  } else if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed" ||
    event.type === "invoice.finalized"
  ) {
    const parent =
      object(data.parent) && object(data.parent.subscription_details)
        ? data.parent.subscription_details
        : null;
    const subscriptionId = stripeObjectId(parent?.subscription);
    if (!subscriptionId) return json({ received: true });
    const binding = await storage.get<SubscriptionBinding>(
      `stripe-subscription-v1:${subscriptionId}`,
    );
    if (!binding) return json({ received: true });
    for (const month of invoiceMonths(data, binding))
      await storage.put(
        `stripe-invoice-closed-month-v1:${subscriptionId}:${month}`,
        true,
      );
    const invoiceKey = `stripe-invoice-v1:${data.id}`;
    const old = await storage.get<{ at: number; id: string; paid: boolean }>(
      invoiceKey,
    );
    const paid = event.type === "invoice.paid";
    if (
      (!old ||
        event.created > old.at ||
        (event.type !== "invoice.finalized" &&
          !old.paid &&
          event.created >= old.at)) &&
      !(old?.paid && !paid)
    ) {
      await storage.put(invoiceKey, { ...version(event), paid });
      const unpaid = new Set(state.unpaidInvoiceIds ?? []);
      if (paid) unpaid.delete(data.id);
      else if (event.type === "invoice.payment_failed") unpaid.add(data.id);
      state.unpaidInvoiceIds = [...unpaid];
      const invoiceCreated = Number.isSafeInteger(data.created)
        ? (data.created as number)
        : event.created;
      const previousCreated =
        state.invoiceVersion?.invoiceCreated ?? state.invoiceVersion?.at ?? -1;
      if (
        (subscriptionId === state.subscriptionId ||
          state.subscriptionId === null) &&
        (!state.invoiceVersion ||
          invoiceCreated > previousCreated ||
          (state.latestInvoice?.id === data.id && paid))
      ) {
        state.latestInvoice = {
          id: data.id,
          status: paid
            ? "paid"
            : event.type === "invoice.finalized"
              ? "open"
              : "payment_failed",
        };
        state.invoiceVersion = { ...version(event), invoiceCreated };
      }
      if (state.coverage)
        state.status = unpaid.size
          ? "past-due"
          : state.cancelAtPeriodEnd
            ? "canceling"
            : "active";
    }
  } else if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    if (data.id !== state.subscriptionId) return json({ received: true });
    const deleted =
      event.type === "customer.subscription.deleted" ||
      data.status === "canceled" ||
      data.status === "incomplete_expired";
    const at = state.subscriptionVersion?.at ?? -1;
    // A deletion wins a same-second update. Event ids do not order Stripe state transitions.
    const lateUnpaid = data.status === "past_due" || data.status === "unpaid";
    const paidAt =
      state.latestInvoice?.status === "paid"
        ? (state.invoiceVersion?.at ?? -1)
        : -1;
    const sameSecondCancel =
      event.created === at &&
      data.cancel_at_period_end === true &&
      !state.cancelAtPeriodEnd;
    if (
      (event.created > at ||
        (deleted && event.created >= at) ||
        sameSecondCancel ||
        (lateUnpaid && event.created === at && paidAt < event.created)) &&
      !state.subscriptionVersion?.deleted
    ) {
      state.subscriptionVersion = { ...version(event), deleted };
      if (deleted) {
        state.coverageEndedAt = Math.max(
          state.coverageStartedAt ?? 0,
          event.created * 1_000,
        );
        state.coverage = false;
        state.status = "none";
        state.cancelAtPeriodEnd = false;
        state.subscriptionId = null;
        state.setupSessionId = null;
        state.setupRoom = null;
      } else {
        state.cancelAtPeriodEnd = data.cancel_at_period_end === true;
        state.status =
          lateUnpaid || state.unpaidInvoiceIds?.length
            ? "past-due"
            : state.cancelAtPeriodEnd
              ? "canceling"
              : "active";
        if (
          object(data.default_payment_method) &&
          object(data.default_payment_method.card)
        ) {
          const card = data.default_payment_method.card;
          if (
            typeof card.brand === "string" &&
            /^[a-zA-Z0-9 _-]{1,24}$/.test(card.brand) &&
            typeof card.last4 === "string" &&
            /^\d{4}$/.test(card.last4)
          )
            state.card = { brand: card.brand, last4: card.last4 };
        }
      }
    }
  }
  await saveOwner(storage, state);
  await storage.put(key, { at: now });
  return json({ received: true });
}

/** The public endpoint accepts only a verified raw signed event, never a browser return. */
export async function stripeWebhookRoute(
  request: Request,
  env: StripeStoreEnv,
  now = Date.now(),
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/billing/stripe/webhook")
    return null;
  if (!cardBillingIngressEnabled(env)) throw unavailable();
  if (request.method !== "POST")
    throw new HttpError(405, "Send a Stripe event.");
  const raw = await request.text();
  const event = await verifyStripeWebhook(
    raw,
    request.headers.get("Stripe-Signature"),
    env.STRIPE_WEBHOOK_SECRET!,
    now,
  );
  if (event.livemode !== /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY!))
    throw new HttpError(400, "Stripe event mode is invalid.");
  if (
    ![
      "checkout.session.completed",
      "invoice.created",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.finalized",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "payment_method.attached",
      "payment_method.updated",
      "customer.updated",
    ].includes(event.type)
  )
    return json({ received: true });
  const customerId =
    event.type === "customer.updated"
      ? event.data.object.id
      : stripeObjectId(event.data.object.customer);
  if (!customerId || !/^cus_[A-Za-z0-9]+$/.test(customerId))
    return json({ received: true });
  const index = await call(env, INDEX_OBJECT, STRIPE_INDEX_PATH, {
    op: "lookup",
    customerId,
  });
  if (!normalizeChatPrincipal(index.owner)) {
    if (event.type === "invoice.created") throw unavailable();
    return json({ received: true });
  }
  return json(
    await call(env, `stripe-billing-owner:${index.owner}`, STRIPE_OWNER_PATH, {
      op: "webhook",
      owner: index.owner,
      event,
    }),
  );
}

export async function stripeRoomStateRequest(
  storage: Storage,
  body: Record<string, unknown>,
  now: number,
  env: TemplStaffEnv = {},
) {
  const product = await readProductState(storage, now, env);
  if (
    body.room !== product.room ||
    !normalizeChatPrincipal(body.owner) ||
    typeof body.customerId !== "string" ||
    !IDS.test(body.customerId) ||
    typeof body.coverage !== "boolean"
  )
    throw unavailable();
  if (
    body.unpaidInvoiceIds !== undefined &&
    (!Array.isArray(body.unpaidInvoiceIds) ||
      body.unpaidInvoiceIds.length > 128 ||
      body.unpaidInvoiceIds.some(
        (id) => typeof id !== "string" || !/^in_[A-Za-z0-9_]+$/.test(id),
      ))
  )
    throw unavailable();
  const state: StripeRoomState = {
    owner: body.owner as string,
    customerId: body.customerId,
    subscriptionId:
      typeof body.subscriptionId === "string" ? body.subscriptionId : null,
    status: body.status as StripeRoomState["status"],
    card: body.card as StripeRoomState["card"],
    latestInvoice: body.latestInvoice as StripeRoomState["latestInvoice"],
    unpaidInvoiceIds: Array.isArray(body.unpaidInvoiceIds)
      ? [...new Set(body.unpaidInvoiceIds as string[])]
      : [],
    cancelAtPeriodEnd: body.cancelAtPeriodEnd === true,
    coverage: body.coverage,
    coverageStartedAt:
      typeof body.coverageStartedAt === "number"
        ? body.coverageStartedAt
        : null,
    coverageEndedAt:
      typeof body.coverageEndedAt === "number" ? body.coverageEndedAt : null,
  };
  const old = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
  if (
    typeof body.roomRevision === "number" &&
    old?.roomRevision !== undefined &&
    body.roomRevision < old.roomRevision
  )
    return json({ ok: true });
  state.roomRevision =
    typeof body.roomRevision === "number" ? body.roomRevision : undefined;
  await storage.put(STRIPE_ROOM_KEY, state);
  if (
    state.coverage &&
    state.subscriptionId &&
    state.coverageStartedAt !== null &&
    state.coverageStartedAt !== undefined
  ) {
    await storage.put(`${STRIPE_COVERAGE_PREFIX}${state.subscriptionId}`, {
      owner: state.owner,
      customerId: state.customerId,
      subscriptionId: state.subscriptionId,
      startsAt: state.coverageStartedAt,
      endsAt: null,
    } satisfies StripeCoverage);
  } else if (old?.subscriptionId) {
    const interval = await storage.get<StripeCoverage>(
      `${STRIPE_COVERAGE_PREFIX}${old.subscriptionId}`,
    );
    if (interval)
      await storage.put(`${STRIPE_COVERAGE_PREFIX}${old.subscriptionId}`, {
        ...interval,
        endsAt: Math.max(interval.startsAt, state.coverageEndedAt ?? now),
      });
  }
  if (state.coverage && !old?.coverage)
    await markWorkspaceStep(storage, "card_setup_confirmed", now);
  if (
    state.latestInvoice?.status === "paid" &&
    (old?.latestInvoice?.id !== state.latestInvoice.id ||
      old.latestInvoice.status !== "paid")
  )
    await markWorkspaceStep(storage, "card_invoice_paid", now);
  product.cardCoverage = state.coverage;
  await storage.put(PRODUCT_STATE_KEY, product);
  if (state.status === "past-due" || state.unpaidInvoiceIds?.length)
    await emitCardAlerts(storage, state, now, env);
  return json({ ok: true });
}

export async function managerStripeAction(
  storage: Storage,
  env: StripeStoreEnv,
  input: {
    action: string;
    room: string;
    nowMs: number;
    body: Record<string, unknown>;
    creator?: string;
    priceTable?: ResolutionPriceTable;
    priceSource?: ProductPriceSource;
    complete?: (result: Record<string, any>) => Promise<void>;
  },
) {
  assertCardBillingEnabled(env);
  if (
    Object.keys(input.body).some(
      (name) => !["confirmed", "expectedPrincipalId", "method"].includes(name),
    )
  )
    throw new HttpError(400, "Save your card on Stripe.");
  if (input.action === "method" && input.body.method !== "usdc")
    throw new HttpError(400, "Choose Prepay with USDC.");
  const product = await readProductState(storage, input.nowMs, env);
  const creator = input.creator ?? product.creator;
  const owner = await canonicalOwner(env, creator);
  const result = await call(
    env,
    `stripe-billing-owner:${owner}`,
    STRIPE_OWNER_PATH,
    {
      op: input.action,
      owner,
      room: input.room,
      table: input.priceTable ?? product.prices.table,
      priceSource:
        input.priceSource ?? productPriceSource(product.priceVersion)!,
    },
  );
  if (input.complete) await input.complete(result);
  else if (input.action === "setup" && object(result.state)) {
    await storage.put(STRIPE_ROOM_KEY, result.state);
    await markWorkspaceStep(storage, "checkout_started", input.nowMs);
  }
  return json(input.action === "setup" ? { url: result.url } : result);
}

export type StripeCoverage = {
  owner: string;
  customerId: string;
  subscriptionId: string;
  startsAt: number;
  endsAt: number | null;
};
/** The signed coverage interval that contains a case's final time. */
export async function stripeCoverageAt(
  storage: Pick<Storage, "get" | "list">,
  at: number,
): Promise<StripeCoverage | null> {
  const current = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
  if (
    current?.subscriptionId &&
    current.coverage &&
    current.coverageStartedAt !== undefined &&
    current.coverageStartedAt !== null &&
    current.coverageStartedAt <= at &&
    (current.coverageEndedAt == null || at < current.coverageEndedAt)
  ) {
    return {
      owner: current.owner,
      customerId: current.customerId,
      subscriptionId: current.subscriptionId,
      startsAt: current.coverageStartedAt,
      endsAt: current.coverageEndedAt ?? null,
    };
  }
  const rows = await storage.list<StripeCoverage>({
    prefix: STRIPE_COVERAGE_PREFIX,
    limit: 512,
  });
  return (
    [...rows.values()].find(
      (row) => row.startsAt <= at && (row.endsAt === null || at < row.endsAt),
    ) ?? null
  );
}
/** The charge transaction writes intent before any Stripe request. */
export async function queueStripeUsage(
  storage: Storage,
  input: {
    kind: "report" | "credit";
    room: string;
    ref: string;
    finalAt: number;
    cents: number;
    subscriptionId?: string;
    contributions?: SupportCaseContributions;
  },
  now: number,
) {
  const current = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
  const coverage =
    input.kind === "report"
      ? await stripeCoverageAt(storage, input.finalAt)
      : null;
  const subscriptionId =
    input.subscriptionId ?? coverage?.subscriptionId ?? current?.subscriptionId;
  if (
    !current ||
    !subscriptionId ||
    (input.kind === "report" && coverage?.subscriptionId !== subscriptionId)
  )
    throw unavailable();
  const chargeId = `${input.room.slice(5)}:${input.ref}`;
  const key = `${STRIPE_OUTBOX_PREFIX}${chargeId}:${input.kind}`;
  if (!(await storage.get(key)))
    await storage.put(key, {
      ...input,
      owner: current.owner,
      subscriptionId,
      chargeId,
    } satisfies StripeUsageOutbox);
  await wakeRoomAt(storage, now + 1_000);
}
export async function deliverStripeUsage(
  storage: Pick<Storage, "get" | "put" | "delete" | "list">,
  env: StripeStoreEnv,
  now: number,
) {
  if (!cardBillingEnabled(env)) return null;
  const rows = await storage.list<StripeUsageOutbox>({
    prefix: STRIPE_OUTBOX_PREFIX,
    limit: 25,
  });
  for (const [key, usage] of rows) {
    // Reporting precedes a credit, including when both were queued during a retry.
    if (usage.kind === "credit") {
      const reportKey = `${STRIPE_OUTBOX_PREFIX}${usage.chargeId}:report`;
      const report = await storage.get<StripeUsageOutbox>(reportKey);
      if (report) {
        await call(
          env,
          `stripe-billing-owner:${report.owner}`,
          STRIPE_OWNER_PATH,
          { op: "usage", owner: report.owner, usage: report },
        );
        await storage.delete(reportKey);
      }
    }
    await call(env, `stripe-billing-owner:${usage.owner}`, STRIPE_OWNER_PATH, {
      op: "usage",
      owner: usage.owner,
      usage,
    });
    await storage.delete(key);
  }
  return rows.size === 25 ? now + 1_000 : null;
}
export async function readStripeView(
  storage: Pick<Storage, "get" | "list">,
  now: number,
): Promise<{
  billingMethod: "card" | "usdc";
  cardBilling: ProductCardBillingView;
}> {
  const state = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
  const month = await storage.get<{
    cardCases?: number;
    cardCents?: number;
    cardCreditedCents?: number;
  }>(`product-charge-month-v1:${resolutionMonth(now)}`);
  const cases = month?.cardCases ?? 0;
  return {
    billingMethod: state?.coverage ? "card" : "usdc",
    cardBilling: {
      status: state?.status ?? "none",
      card: state?.card ?? null,
      latestInvoice: state?.latestInvoice ?? null,
      cancelAtPeriodEnd: state?.cancelAtPeriodEnd ?? false,
      monthCases: cases,
      monthEstimateCents: Math.max(
        0,
        (month?.cardCents ??
          reconcileStripeUsage({
            billableFinalCases: cases,
            reportedCases: cases,
          }).estimateCents) - (month?.cardCreditedCents ?? 0),
      ),
    },
  };
}
