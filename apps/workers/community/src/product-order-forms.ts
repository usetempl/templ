import {
  isProductUsageTerms,
  usageResolutionTable,
  type ProductUsageTerms,
} from "@templ/chat/usage-billing";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import {
  productPriceSource,
  type ProductPriceSource,
} from "@templ/chat/product-catalog";
import {
  PRODUCT_ORDER_FORM_LIMITS,
  PRODUCT_PRICE_VERSION,
} from "@templ/chat/plans";
import {
  isPriceTable,
  normalizeStoredPriceTable,
  priceChangeAppliesAt,
  priceTableRaises,
  resolutionPriceTable,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import {
  isPilotOrderFormTerms,
  type PilotOrderFormTerms,
} from "@templ/chat/pilot-pricing";
import type {
  ProductPaymentReceipt,
  ProductPaymentIntent,
} from "@templ/chat/product-payment";
import { HttpError } from "./common";
import type { TemplStaffEnv } from "./templ-staff";
import {
  readProductState,
  readTopUps,
  recordProductEvent,
  PRODUCT_STATE_KEY,
  type ProductState,
  type ProductStorage,
} from "./product-entitlements";
import { queueFinanceEmail } from "./product-finance-email";
import { roomPermissionHolders } from "./support-alert-emit";
import { queueNotificationJob } from "./support-notifications";
import { wakeRoomAt } from "./room-alarm";
import { appendAuditToStream } from "./room-audit";
import { featureOn } from "./workspace-flags";

export const PRODUCT_ORDER_FORM_KEY = "product-order-form-v1";
const FORM_ID = /^OF-\d{4}-\d{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_HISTORY = 256;
export type ProductOrderForm = {
  id: string;
  revision: number;
  workspace: string;
  table: ResolutionPriceTable;
  service: "software" | "managed-ai" | "done-for-you";
  startsAt: number;
  endsAt: number;
  documentSha256: string;
  approvedBy: ChatPrincipalId;
  createdBy: ChatPrincipalId;
  pilot?: PilotOrderFormTerms;
  usage?: ProductUsageTerms;
};
export type PilotOrderFormActivation = {
  at: number;
  paymentIds: string[];
  creditedCents: number;
};
export type OrderFormNotice = {
  id: string;
  source: ProductPriceSource;
  table: ResolutionPriceTable;
  earliestAt: number;
  recipients: ChatPrincipalId[];
  delivered: Record<string, number>;
  noticeAt: number | null;
};
export type ProductOrderForms = {
  schema: 1;
  history: ProductOrderForm[];
  ended: Record<string, number>;
  notices: OrderFormNotice[];
  activations?: Record<string, PilotOrderFormActivation>;
};
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const offerDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  natural(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function priceSourceVersion(source: ProductPriceSource) {
  return source.kind === "public"
    ? source.version
    : `${source.id}:${source.revision}`;
}
export function isProductPriceSource(
  value: unknown,
): value is ProductPriceSource {
  if (!object(value)) return false;
  const keys = Object.keys(value).sort().join();
  if (value.kind === "public")
    return (
      keys === "kind,version" &&
      productPriceSource(value.version)?.kind === "public"
    );
  if (
    value.kind !== "order-form" ||
    keys !== "id,kind,revision" ||
    typeof value.id !== "string" ||
    !natural(value.revision)
  )
    return false;
  return (
    productPriceSource(`${value.id}:${value.revision}`)?.kind === "order-form"
  );
}

function orderFormEndLimit(startsAt: number) {
  const date = new Date(startsAt);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(
    date.getUTCFullYear() + PRODUCT_ORDER_FORM_LIMITS.maxMonths / 12,
  );
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}
export function isProductOrderForm(value: unknown): value is ProductOrderForm {
  return (
    object(value) &&
    Object.keys(value).sort().join() ===
      [
        "approvedBy",
        "createdBy",
        "documentSha256",
        "endsAt",
        "id",
        "revision",
        "service",
        "startsAt",
        "table",
        "workspace",
        ...(value.pilot === undefined ? [] : ["pilot"]),
        ...(value.usage === undefined ? [] : ["usage"]),
      ]
        .sort()
        .join() &&
    typeof value.id === "string" &&
    FORM_ID.test(value.id) &&
    natural(value.revision) &&
    value.revision > 0 &&
    typeof value.workspace === "string" &&
    /^room:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.workspace,
    ) &&
    (value.usage === undefined
      ? isPriceTable(value.table, "order-form")
      : isProductUsageTerms(value.usage) &&
        JSON.stringify(value.table) ===
          JSON.stringify(usageResolutionTable(value.usage))) &&
    ["software", "managed-ai", "done-for-you"].includes(
      String(value.service),
    ) &&
    natural(value.startsAt) &&
    natural(value.endsAt) &&
    value.endsAt > value.startsAt &&
    value.endsAt <= orderFormEndLimit(value.startsAt) &&
    typeof value.documentSha256 === "string" &&
    SHA256.test(value.documentSha256) &&
    normalizeChatPrincipal(value.approvedBy) !== null &&
    normalizeChatPrincipal(value.approvedBy) === value.approvedBy &&
    normalizeChatPrincipal(value.createdBy) !== null &&
    normalizeChatPrincipal(value.createdBy) === value.createdBy &&
    (value.usage === undefined ||
      (isProductUsageTerms(value.usage) &&
        value.service === "software" &&
        value.pilot === undefined)) &&
    (value.pilot === undefined ||
      (isPilotOrderFormTerms(value.pilot) &&
        value.service === "software" &&
        value.endsAt - value.startsAt ===
          value.pilot.durationDays * 86_400_000))
  );
}
export async function readProductOrderForms(
  storage: Pick<ProductStorage, "get">,
): Promise<ProductOrderForms> {
  const raw = await storage.get<unknown>(PRODUCT_ORDER_FORM_KEY);
  if (raw === undefined)
    return { schema: 1, history: [], ended: {}, notices: [] };
  const withTable = (entry: unknown) => {
    if (!object(entry)) return entry;
    if (entry.usage !== undefined) return entry;
    const table = normalizeStoredPriceTable(entry.table, "order-form");
    return table ? { ...entry, table } : entry;
  };
  const stored = object(raw)
    ? {
        ...raw,
        history: Array.isArray(raw.history)
          ? raw.history.map(withTable)
          : raw.history,
        notices: Array.isArray(raw.notices)
          ? raw.notices.map(withTable)
          : raw.notices,
      }
    : raw;
  if (
    !object(stored) ||
    stored.schema !== 1 ||
    !Array.isArray(stored.history) ||
    stored.history.length > MAX_HISTORY ||
    !stored.history.every(isProductOrderForm) ||
    !object(stored.ended) ||
    !Object.entries(stored.ended).every(
      ([id, at]) => FORM_ID.test(id) && natural(at),
    ) ||
    !Array.isArray(stored.notices) ||
    !stored.notices.every(isOrderFormNotice) ||
    (stored.activations !== undefined &&
      (!object(stored.activations) ||
        !Object.entries(stored.activations).every(
          ([key, activation]) =>
            /^OF-\d{4}-\d{3}:[1-9]\d*$/.test(key) &&
            object(activation) &&
            Object.keys(activation).sort().join() ===
              "at,creditedCents,paymentIds" &&
            natural(activation.at) &&
            natural(activation.creditedCents) &&
            Array.isArray(activation.paymentIds) &&
            activation.paymentIds.length > 0 &&
            activation.paymentIds.every((id) => typeof id === "string") &&
            new Set(activation.paymentIds).size ===
              activation.paymentIds.length,
        )))
  )
    throw new HttpError(503, "The order form could not be checked.");
  const record = stored as ProductOrderForms;
  const native = await storage.get<{ room?: { id?: string } }>("native-room");
  const state = await storage.get<{ room?: string }>(PRODUCT_STATE_KEY);
  const workspace = native?.room?.id ? `room:${native.room.id}` : state?.room;
  if (
    !workspace ||
    (native?.room?.id && state?.room && workspace !== state.room) ||
    record.history.some((form) => form.workspace !== workspace) ||
    new Set(record.history.map((form) => `${form.id}:${form.revision}`))
      .size !== record.history.length ||
    new Set(record.notices.map((notice) => notice.id)).size !==
      record.notices.length ||
    Object.entries(record.activations ?? {}).some(([key, activation]) => {
      const form = record.history.find(
        (item) => `${item.id}:${item.revision}` === key,
      );
      return !form?.pilot || activation.creditedCents < form.pilot.upfrontCents;
    }) ||
    record.history.some((form) => {
      const first = record.history.find((item) => item.id === form.id);
      return Boolean(
        form.pilot && (!first?.pilot || form.startsAt !== first.startsAt),
      );
    }) ||
    record.notices.some((notice) => {
      const source = notice.source;
      if (source.kind !== "order-form") return false;
      const form = record.history.find(
        (item) => item.id === source.id && item.revision === source.revision,
      );
      return !form || !samePriceTable(form.table, notice.table);
    })
  )
    throw new HttpError(503, "The order form could not be checked.");
  const paymentEvidence = new Map<
    string,
    Awaited<ReturnType<typeof pilotUpfrontCreditCents>>
  >();
  for (const [key, activation] of Object.entries(record.activations ?? {})) {
    const form = record.history.find(
      (item) => `${item.id}:${item.revision}` === key,
    )!;
    let evidence = paymentEvidence.get(form.id);
    if (!evidence) {
      const latest = [...record.history]
        .reverse()
        .find((item) => item.id === form.id)!;
      evidence = await pilotUpfrontCreditCents(storage, latest);
      paymentEvidence.set(form.id, evidence);
    }
    if (
      activation.paymentIds.some(
        (id) =>
          !evidence!.paymentIds.includes(id) ||
          evidence!.revisionByPayment[id] > form.revision ||
          evidence!.creditedAtByPayment[id] > activation.at,
      ) ||
      activation.paymentIds.reduce(
        (sum, id) => sum + (evidence.paidCentsByPayment[id] ?? 0),
        0,
      ) !== activation.creditedCents
    )
      throw new HttpError(503, "The pilot payment could not be checked.");
  }
  return record;
}
export function activeOrderForm(
  record: ProductOrderForms,
  now: number,
): ProductOrderForm | null {
  const form = [...record.history]
    .reverse()
    .find(
      (item) =>
        item.startsAt <= now &&
        (!item.pilot ||
          (record.activations?.[`${item.id}:${item.revision}`]?.at ??
            Infinity) <= now),
    );
  return form &&
    form.endsAt > now &&
    (record.ended[form.id] === undefined || record.ended[form.id] > now)
    ? form
    : null;
}
export async function activeProductOrderForm(
  storage: Pick<ProductStorage, "get">,
  now: number,
) {
  return activeOrderForm(await readProductOrderForms(storage), now);
}
/** Only stored verified receipts that credited this workspace cover a pilot. */
export async function pilotUpfrontCreditCents(
  storage: Pick<ProductStorage, "get">,
  form: ProductOrderForm,
) {
  const ids = (await storage.get<string[]>("product-payment-intents-v1")) ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 512 ||
    !ids.every((id) => typeof id === "string")
  )
    throw new HttpError(503, "The pilot payment could not be checked.");
  const state = await storage.get<{ creditedPayments?: string[] }>(
    PRODUCT_STATE_KEY,
  );
  const credited = new Set(state?.creditedPayments ?? []);
  const receipts = new Map<string, ProductPaymentReceipt>();
  for (const id of ids) {
    const intent = await storage.get<
      ProductPaymentIntent & {
        receipts?: ProductPaymentReceipt[];
        receipt?: ProductPaymentReceipt;
      }
    >(`product-payment-intent-v1:${id}`);
    if (
      !intent ||
      intent.id !== id ||
      intent.orderFormId !== form.id ||
      intent.workspace !== form.workspace ||
      intent.room !== form.workspace ||
      !natural(intent.orderFormRevision) ||
      intent.orderFormRevision === 0 ||
      intent.orderFormRevision > form.revision ||
      !offerDate(intent.offerVersion)
    )
      continue;
    for (const receipt of intent.receipts ??
      (intent.receipt ? [intent.receipt] : [])) {
      if (
        receipt.requestId !== intent.id ||
        receipt.orderFormId !== form.id ||
        receipt.orderFormRevision !== intent.orderFormRevision ||
        receipt.rail !== intent.rail ||
        receipt.network !== intent.network ||
        receipt.chainId !== intent.chainId ||
        receipt.kind !== intent.kind ||
        receipt.payer !== intent.payer ||
        receipt.recipient !== intent.recipient ||
        receipt.token !== intent.token ||
        receipt.asset.address !== intent.asset.address ||
        receipt.asset.decimals !== intent.asset.decimals ||
        receipt.offerVersion !== intent.offerVersion ||
        receipt.bonusCents !== 0 ||
        !natural(receipt.usdCents) ||
        receipt.usdCents === 0 ||
        !credited.has(receipt.paymentId) ||
        !Number.isSafeInteger(Date.parse(receipt.creditedAt))
      )
        continue;
      receipts.set(receipt.paymentId, receipt);
    }
  }
  const paymentIds = [...receipts.keys()];
  const topUps = await readTopUps(storage);
  return {
    paymentIds,
    paidCentsByPayment: Object.fromEntries(
      [...receipts].map(([id, receipt]) => [id, receipt.usdCents]),
    ),
    creditedAtByPayment: Object.fromEntries(
      [...receipts].map(([id, receipt]) => [
        id,
        Date.parse(receipt.creditedAt),
      ]),
    ),
    revisionByPayment: Object.fromEntries(
      [...receipts].map(([id, receipt]) => [id, receipt.orderFormRevision!]),
    ),
    paidCents: [...receipts.values()].reduce(
      (sum, receipt) => sum + receipt.usdCents,
      0,
    ),
    availableCents: topUps.topUps
      .filter((row) => receipts.has(row.id))
      .reduce((sum, row) => sum + row.paidLeft, 0),
  };
}

/** Activation follows receipt verification in the same room transaction. */
export async function reconcilePilotOrderFormActivations(
  storage: Storage,
  now: number,
  env: TemplStaffEnv = {},
) {
  if (!(await featureOn(env, storage, "pilotOrderForms"))) return false;
  const record = await readProductOrderForms(storage);
  let changed = false;
  for (const form of record.history) {
    const key = `${form.id}:${form.revision}`;
    if (
      !form.pilot ||
      record.activations?.[key] ||
      form.endsAt <= now ||
      (record.ended[form.id] !== undefined && record.ended[form.id] <= now)
    )
      continue;
    const evidence = await pilotUpfrontCreditCents(storage, form);
    if (evidence.paidCents < form.pilot.upfrontCents) continue;
    (record.activations ??= {})[key] = {
      at: now,
      paymentIds: evidence.paymentIds,
      creditedCents: evidence.paidCents,
    };
    await storage.put(PRODUCT_ORDER_FORM_KEY, record);
    await recordProductEvent(storage, `orderform:${key}:activate`, {
      action: "orderform.activate",
      at: now,
      reason: "Verified upfront payment",
      operator: form.createdBy,
    });
    await appendAuditToStream(
      storage,
      "access",
      {
        actor: form.createdBy,
        action: "orderform.activate",
        target: form.id,
        after: {
          revision: form.revision,
          service: form.service,
          reason: "Verified upfront payment",
        },
      },
      now,
    );
    changed = true;
  }
  return changed;
}
function formPriceSource(form: ProductOrderForm): ProductPriceSource {
  return { kind: "order-form", id: form.id, revision: form.revision };
}
function formPriceTarget(record: ProductOrderForms, now: number) {
  const form = activeOrderForm(record, now);
  if (form && !form.usage)
    return {
      source: formPriceSource(form),
      table: form.table,
      earliestAt: form.startsAt,
    };
  const last = [...record.history]
    .reverse()
    .find((candidate) => candidate.startsAt <= now);
  return {
    source: {
      kind: "public",
      version: PRODUCT_PRICE_VERSION,
    } as ProductPriceSource,
    table: resolutionPriceTable(),
    earliestAt: last
      ? Math.min(last.endsAt, record.ended[last.id] ?? Infinity)
      : now,
  };
}
function orderFormNoticeId(
  source: ProductPriceSource,
  record: ProductOrderForms,
) {
  return source.kind === "order-form"
    ? priceSourceVersion(source)
    : `public:${source.version}:${record.history.at(-1)?.id ?? "none"}:${record.history.at(-1)?.revision ?? 0}`;
}
function samePriceTable(
  left: ResolutionPriceTable,
  right: ResolutionPriceTable,
) {
  return (
    left.usdCents === right.usdCents &&
    left.aiOnlyUsdCents === right.aiOnlyUsdCents &&
    left.stepOneAfterCases === right.stepOneAfterCases &&
    left.stepOneUsdCents === right.stepOneUsdCents
  );
}
function isOrderFormNotice(value: unknown): value is OrderFormNotice {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !isProductPriceSource(value.source) ||
    !isPriceTable(value.table, "order-form") ||
    !natural(value.earliestAt) ||
    !Array.isArray(value.recipients) ||
    !value.recipients.every(
      (id) =>
        normalizeChatPrincipal(id) !== null &&
        normalizeChatPrincipal(id) === id,
    ) ||
    new Set(value.recipients).size !== value.recipients.length ||
    !object(value.delivered)
  )
    return false;
  const { recipients, delivered, earliestAt } = value;
  if (
    !Object.entries(delivered).every(
      ([id, at]) => recipients.includes(id) && natural(at) && at >= earliestAt,
    )
  )
    return false;
  const complete =
    recipients.length > 0 && recipients.every((id) => natural(delivered[id]));
  return complete
    ? natural(value.noticeAt) &&
        value.noticeAt ===
          Math.max(...recipients.map((id) => Number(delivered[id])))
    : value.noticeAt === null;
}

export async function orderFormPriceTable(
  storage: Pick<ProductStorage, "get">,
  priceVersion: string,
  savedTable: ResolutionPriceTable,
) {
  const source = productPriceSource(priceVersion);
  const record = await readProductOrderForms(storage);
  const form =
    source?.kind === "order-form"
      ? record.history.find(
          (item) => item.id === source.id && item.revision === source.revision,
        )
      : null;
  if (!form || !samePriceTable(form.table, savedTable))
    throw new HttpError(503, "The order form could not be checked.");
  return form.table;
}
type NoticeStorage = Pick<ProductStorage, "get"> &
  Partial<Pick<Storage, "list">>;
async function currentNoticeRecipients(
  storage: NoticeStorage,
  env: TemplStaffEnv = {},
) {
  if (!storage.list)
    throw new HttpError(503, "Billing managers could not be checked.");
  const holders = await roomPermissionHolders(
    storage as Pick<Storage, "get" | "list">,
    "manageBilling",
    env,
    Date.now(),
    true,
  );
  return [
    ...new Set([
      ...(holders.manager ? [holders.manager] : []),
      ...holders.handlers,
    ]),
  ].sort();
}
function reconcileNotice(
  notice: OrderFormNotice,
  recipients: ChatPrincipalId[],
) {
  if (notice.recipients.slice().sort().join() === recipients.join())
    return false;
  notice.recipients = recipients;
  notice.delivered = Object.fromEntries(
    Object.entries(notice.delivered).filter(([id]) =>
      recipients.includes(id as ChatPrincipalId),
    ),
  );
  const complete =
    recipients.length > 0 &&
    recipients.every((id) => natural(notice.delivered[id]));
  notice.noticeAt = complete
    ? Math.max(...recipients.map((id) => notice.delivered[id]))
    : null;
  return true;
}
/** Billing authority changes reset incomplete notice delivery inside their transaction. */
export async function reconcileOrderFormNoticeRecipients(
  storage: Storage,
  now: number,
  env: TemplStaffEnv = {},
) {
  const record = await readProductOrderForms(storage);
  if (!record.notices.length) return;
  const recipients = await currentNoticeRecipients(storage, env);
  let changed = false;
  for (const notice of record.notices)
    changed = reconcileNotice(notice, recipients) || changed;
  if (changed) {
    await storage.put(PRODUCT_ORDER_FORM_KEY, record);
    await wakeRoomAt(storage, now + 1);
  }
}
export async function scheduledOrderFormPrices(
  storage: NoticeStorage,
  state: ProductState,
  env: TemplStaffEnv = {},
) {
  const record = await readProductOrderForms(storage);
  if (!record.history.length) return null;
  const target = formPriceTarget(record, state.asOf);
  if (
    priceSourceVersion(target.source) === state.priceVersion ||
    !priceTableRaises(state.prices.table, target.table)
  )
    return null;
  const notice = record.notices.find(
    (item) => item.id === orderFormNoticeId(target.source, record),
  );
  if (
    notice &&
    (notice.earliestAt !== target.earliestAt ||
      priceSourceVersion(notice.source) !== priceSourceVersion(target.source) ||
      !samePriceTable(notice.table, target.table))
  )
    throw new HttpError(503, "The price notice could not be checked.");
  const recipients = notice ? await currentNoticeRecipients(storage, env) : [];
  const noticeAt =
    notice && notice.recipients.slice().sort().join() === recipients.join()
      ? notice.noticeAt
      : null;
  return {
    priceVersion: priceSourceVersion(target.source),
    priceSource: target.source,
    table: target.table,
    noticeAt,
    appliesAt:
      noticeAt === null
        ? null
        : Math.max(target.earliestAt, priceChangeAppliesAt(noticeAt)),
  };
}
/** Applies only to new pending charges. Existing charges retain their version. */
export async function applyOrderFormPrices(
  storage: NoticeStorage,
  state: ProductState,
  env: TemplStaffEnv = {},
) {
  const source = productPriceSource(state.priceVersion);
  if (source?.kind === "order-form")
    state.prices = {
      table: await orderFormPriceTable(
        storage,
        state.priceVersion,
        state.prices.table,
      ),
    };
  const record = await readProductOrderForms(storage);
  if (!record.history.length) return false;
  const target = formPriceTarget(record, state.asOf);
  if (priceSourceVersion(target.source) === state.priceVersion) {
    if (!samePriceTable(state.prices.table, target.table))
      throw new HttpError(503, "The order form could not be checked.");
    return true;
  }
  const pending = await scheduledOrderFormPrices(storage, state, env);
  if (pending && (pending.appliesAt === null || pending.appliesAt > state.asOf))
    return true;
  state.priceVersion = priceSourceVersion(target.source);
  state.prices = { table: target.table };
  return true;
}

export async function acknowledgeOrderFormNotice(
  storage: Pick<ProductStorage, "get" | "put">,
  input: {
    id: string;
    recipient: ChatPrincipalId;
    now: number;
  },
) {
  const record = await readProductOrderForms(storage);
  const notice = record.notices.find((item) => item.id === input.id);
  if (
    !notice ||
    !notice.recipients.includes(input.recipient) ||
    notice.noticeAt !== null
  )
    return;
  notice.delivered[input.recipient] ??= input.now;
  if (
    notice.recipients.length &&
    notice.recipients.every((id) => natural(notice.delivered[id]))
  )
    notice.noticeAt = Math.max(
      ...notice.recipients.map((id) => notice.delivered[id]),
    );
  await storage.put(PRODUCT_ORDER_FORM_KEY, record);
}
export function orderFormNoticeEmail(
  notice: Pick<OrderFormNotice, "table" | "source">,
  href: string,
) {
  const table = notice.table;
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const source =
    notice.source.kind === "order-form"
      ? `Order form ${notice.source.id}`
      : "Public prices";
  return {
    subject: "Your Templ case price will change",
    text:
      `${source}: ${usd(table.usdCents)} per team-handled case for the first ${table.stepOneAfterCases} each month.\n` +
      `${usd(table.stepOneUsdCents)} per team-handled case after that.\n` +
      `${usd(table.aiOnlyUsdCents)} per case the AI solves alone.\n\n` +
      "The price starts at least 30 days after every billing manager gets this email.\n" +
      "Cases already pending keep their price. Check the Plan tab for the date.\n\n" +
      href,
  };
}
function orderFormAppOrigin(env: { APP_ORIGIN?: string }) {
  try {
    if (!env.APP_ORIGIN) throw new Error();
    const url = new URL(env.APP_ORIGIN);
    if (
      url.protocol !== "https:" ||
      url.origin !== env.APP_ORIGIN ||
      url.username ||
      url.password
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(503, "The app origin could not be checked.");
  }
}
/** Queues billing emails and records each recipient. Delivery starts the notice clock. */
export async function processProductOrderForms(
  storage: Storage,
  env: { APP_ORIGIN?: string } & TemplStaffEnv,
  now: number,
): Promise<number | null> {
  await reconcilePilotOrderFormActivations(storage, now, env);
  const record = await readProductOrderForms(storage);
  if (!record.history.length) return null;
  if (!(await storage.get(PRODUCT_STATE_KEY))) return null;
  const appOrigin = orderFormAppOrigin(env);
  const target = formPriceTarget(record, now);
  const holders = await roomPermissionHolders(
    storage,
    "manageBilling",
    env,
    now,
  );
  const recipients = await currentNoticeRecipients(storage, env);
  const id = orderFormNoticeId(target.source, record);
  const existingNotice = record.notices.find((item) => item.id === id);
  if (existingNotice && reconcileNotice(existingNotice, recipients))
    await storage.put(PRODUCT_ORDER_FORM_KEY, record);
  const state = await readProductState(storage, now, env);
  const native = await storage.get<{ room?: { id?: string } }>("native-room");
  const href = `${appOrigin}/rooms/${native?.room?.id ?? state.room.slice(5)}?tab=plan`;
  let notice = record.notices.find((item) => item.id === id);
  if (
    priceSourceVersion(target.source) !== state.priceVersion &&
    priceTableRaises(state.prices.table, target.table)
  ) {
    if (!notice) {
      notice = { id, ...target, recipients, delivered: {}, noticeAt: null };
      record.notices.push(notice);
      await storage.put(PRODUCT_ORDER_FORM_KEY, record);
      await queueFinanceEmail(storage, now, {
        id: `orderform:${id}`,
        ...orderFormNoticeEmail(notice, href),
      });
    }
    if (notice.noticeAt === null)
      for (const [offset, recipient] of notice.recipients.entries()) {
        if (notice.delivered[recipient] !== undefined) continue;
        await queueNotificationJob(storage, {
          now: now + offset,
          room: state.room,
          appOrigin,
          recipient,
          kind: "workspace",
          conversation: null,
          bucketMs: 86_400_000,
          facts: {
            orderFormNotice: {
              id: notice.id,
              source: notice.source,
              table: notice.table,
            },
          },
        }, env);
      }
  }
  await applyOrderFormPrices(storage, state, env);
  await storage.put(PRODUCT_STATE_KEY, state);
  const active = activeOrderForm(record, now);
  if (active?.service !== "done-for-you") {
    const marker = `product-order-form-staff-alert-v1:${record.history.at(-1)?.id}:${record.history.at(-1)?.revision}`;
    const grants = await storage.list<{ roleIds?: string[] }>({
      prefix: "templ-staff-v1:",
      limit: 1_000,
    });
    if (
      [...grants.values()].some((grant) => grant.roleIds?.length) &&
      !(await storage.get(marker))
    ) {
      await storage.put(marker, now);
      const text =
        "Templ people can no longer open or answer your cases. Remove their roles on the Team page.";
      await queueFinanceEmail(storage, now, {
        id: marker,
        subject: "Remove Templ team roles",
        text,
      });
      if (holders.manager)
        await queueNotificationJob(storage, {
          now: now + 100,
          room: state.room,
          appOrigin,
          recipient: holders.manager,
          kind: "workspace",
          conversation: null,
          bucketMs: 1,
          facts: { orderFormStaffRemoval: true },
        }, env);
    }
  }
  const due = record.history
    .flatMap((form) => [form.startsAt, form.endsAt])
    .filter((at) => at > now);
  if (notice?.noticeAt !== null && notice?.noticeAt !== undefined)
    due.push(
      Math.max(target.earliestAt, priceChangeAppliesAt(notice.noticeAt)),
    );
  else if (notice && notice.noticeAt === null) due.push(now + 86_400_000);
  const next = due.filter((at) => at > now).sort((a, b) => a - b)[0] ?? null;
  if (next !== null) await wakeRoomAt(storage, next);
  return next;
}
