import {
  initializeStandardPlan,
  standardPlanView,
} from "./product-standard-plan";
import type { StandardPlanView } from "@templ/chat/standard-plan";
import { sponsoredSupport } from "./product-prepaid";
import { activeUsageAgreement, usageView } from "./product-usage-billing";
import type { ProductUsageView } from "@templ/chat/usage-billing";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
/** A workspace's resolved-case offer: the free start, reviewed grants in
 * cases, the prepaid USDC balance and the operator's suspension. The charge
 * ledger (product-charges.ts) reserves and settles slots here; nothing in
 * this module reads a thread.
 *
 * Service never stops for balance, with one exception: a workspace that has
 * never had a verified top-up or a reviewed grant pauses when its balance
 * reaches minus PRODUCT_FREE_NEGATIVE_LIMIT_CENTS. The pause holds until a
 * verified top-up or an audited Templ operator lifts it; no other credit
 * does. Only an audited Templ operator suspends a workspace. */
import {
  PRODUCT_FREE_START,
  PRODUCT_STANDARD_ACCESS_STARTED_ON,
  PRODUCT_OFFER_VERSION,
  PRODUCT_PRICE_VERSION,
  PRODUCT_TOP_UP,
} from "@templ/chat/plans";
import {
  isProductGrantKind,
  productPriceSource,
  type ProductDisputeReason,
  type ProductGrantKind,
  type ProductMode,
  type ProductPriceSource,
} from "@templ/chat/product-catalog";
import {
  freeWorkspacePaused,
  normalizeStoredPriceTable,
  priceChangeAppliesAt,
  priceTableRaises,
  productTopUp,
  resolutionMonth,
  resolutionPriceTable,
  topUpBonusCents,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError, roomKey } from "./common";
import { markWorkspaceStep } from "./funnel-metrics";
import type { FreeStartReservation } from "./product-free-start";
import type { TemplStaffEnv } from "./templ-staff";
import type { SupportCaseContributions } from "@templ/chat/support";
import { activeProductOrderForm, applyOrderFormPrices } from "./product-order-forms";
import { manualAgreement } from "./product-manual-billing";

/** These records belong to one room object. Call mutations inside its
 * storage transaction together with the request, message or case change. */
export type ProductStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
};
export const PRODUCT_STATE_KEY = "product-entitlements-v1";
export const FREE_START_RESERVATION_KEY = "product-free-start-reservation-v1";
/** Verified top-ups, oldest first, with what charges have drawn from each:
 * the refundable amount is the paid part left in top-ups younger than
 * PRODUCT_TOP_UP.refundWindowDays. */
export const PRODUCT_TOP_UPS_KEY = "product-top-ups-v1";
const DAY = 86_400_000;
const MAX_CREDITED_PAYMENTS = 512;
const MAX_GRANTS = 16;
const MAX_TOP_UPS = MAX_CREDITED_PAYMENTS;
const PAYMENT_ID = /^[a-zA-Z0-9:._-]{8,200}$/;
const GRANT_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
/** Set when a verified top-up credits a suspended workspace; the operator
 * view flags it until the suspension is lifted. */
export const TOP_UP_WHILE_SUSPENDED_KEY = "product-topup-suspended-v1";
/** Grants credit once under this prefix; they are never payments. */
export const GRANT_PAYMENT_PREFIX = "grant:";

export type ProductEvent = {
  action: string;
  at: number;
  reason?: string;
  grant?: ProductGrantKind;
  cases?: number;
  cents?: number;
  /** The Templ operator who wrote the event, and their last wallet sign-in. */
  operator?: ChatPrincipalId;
  authenticatedAt?: number;
  approvedBy?: ChatPrincipalId;
};
/** Writes one audit row per id, once. Returns whether it was new. */
export async function recordProductEvent(
  storage: ProductStorage,
  id: string,
  event: ProductEvent,
) {
  const key = `product-audit-v1:${id}`;
  if (await storage.get(key)) return false;
  await storage.put(key, {
    schema: 1,
    offerVersion: PRODUCT_OFFER_VERSION,
    ...event,
  });
  return true;
}

/** Resolved cases a reviewed grant holds. Reserved at pending, used at
 * final while `endsAt` is ahead; after it a charge falls to the balance. */
export type ProductGrantCases = {
  id: string;
  kind: Exclude<ProductGrantKind, "operator">;
  cases: number;
  used: number;
  pending: number;
  startsAt: number;
  endsAt: number;
};
/** Counts from the charge ledger, independent of current reservation proof. */
type FreeStartUsage = {
  used: number;
  pending: number;
};
export type FreeStart = FreeStartUsage & {
  /** unreserved: registry proof is incomplete.
   * reserved: this workspace holds the owner's and app domain's free start.
   * denied: another workspace holds the owner's or app domain's free start. */
  status: "unreserved" | "reserved" | "denied";
};

function withFreeStartEligibility(
  usage: FreeStartUsage,
  status: FreeStart["status"],
): FreeStart {
  return { status, used: usage.used, pending: usage.pending };
}
/** The workspace's price table. Public raises wait from PRODUCT_PRICE_VERSION.
 * Order-form raises wait from confirmed billing-manager email delivery.
 * Each raise waits priceNoticeDays. Cuts apply at once. */
export type ProductPrices = {
  table: ResolutionPriceTable;
};
const STANDARD_PLAN = Symbol("standard-workspace-plan");
const SPONSORED = Symbol("operator-sponsored-support");
const MANUAL_MODE = Symbol("manual-billing-mode");
const USAGE_MODE = Symbol("usage-billing-mode");
const USAGE_STATUS = Symbol("usage-billing-status");
export type ProductState = {
  [SPONSORED]?: true;
  [STANDARD_PLAN]?: StandardPlanView;
  [MANUAL_MODE]?: boolean;
  [USAGE_MODE]?: boolean;
  [USAGE_STATUS]?: ProductUsageView["status"];
  schema: 5;
  /** The public version date or order-form ID and revision for prices.table. */
  priceVersion: string;
  prices: ProductPrices;
  creator: ChatPrincipalId;
  room: string;
  /** Set only by the signed Stripe webhook, cleared on subscription deletion. */
  cardCoverage?: boolean;
  asOf: number;
  freeStart: FreeStart;
  grants: ProductGrantCases[];
  /** Templ's own workspace under its operator grant. */
  exemptUntil: number | null;
  /** Signed USD cents. */
  balanceCents: number;
  /** Pending and confirmed charges reserved on the balance, each at the
   * first step price. */
  pendingCents: number;
  /** Available right after the latest credit: the base of the used-80 and
   * used-100 alerts. */
  creditBaseCents: number;
  /** Credits since the workspace started; the alert markers key on it. */
  credits: number;
  /** A verified top-up or a reviewed grant ever credited. */
  everFunded: boolean;
  /** When a never-funded workspace reached the free negative limit. Set
   * once at that debit; only a verified top-up, an operator's resume or an
   * incident credit back to zero clears it. */
  pausedAt: number | null;
  /** An operator lifted the pause of a never-funded workspace. */
  pauseWaived: boolean;
  suspended: { at: number } | null;
  creditedPayments: string[];
};

const fail = () =>
  new HttpError(503, "Support plan status could not be verified.");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nullableNatural = (value: unknown) => value === null || natural(value);
const PRICE_VERSION = /^\d{4}-\d{2}-\d{2}$/;

/** When the price table in plans.ts starts to apply to a workspace on
 * `from`: at once when no case costs more, else `priceNoticeDays` after its
 * PRODUCT_PRICE_VERSION date. */
export function pricesApplyAt(from: ResolutionPriceTable): number {
  const published = Date.parse(`${PRODUCT_PRICE_VERSION}T00:00:00Z`);
  return priceTableRaises(from, resolutionPriceTable())
    ? priceChangeAppliesAt(published)
    : published;
}
/** The price change waiting for a workspace: the table in plans.ts and
 * when it applies, or null when the workspace already pays it. */
export function scheduledPrices(
  state: Pick<ProductState, "priceVersion" | "prices" | "asOf">,
): {
  priceVersion: string;
  table: ResolutionPriceTable;
  appliesAt: number | null;
  noticeAt?: number | null;
  priceSource?: ProductPriceSource;
} | null {
  if (productPriceSource(state.priceVersion)?.kind === "order-form")
    return null;
  if (state.priceVersion === PRODUCT_PRICE_VERSION) return null;
  const appliesAt = pricesApplyAt(state.prices.table);
  return appliesAt > state.asOf
    ? {
        priceVersion: PRODUCT_PRICE_VERSION,
        table: resolutionPriceTable(),
        appliesAt,
      }
    : null;
}
/** Moves a workspace to the price table in plans.ts once it applies. */
function advancePrices(state: ProductState) {
  if (productPriceSource(state.priceVersion)?.kind === "order-form") return;
  if (state.priceVersion === PRODUCT_PRICE_VERSION) return;
  if (pricesApplyAt(state.prices.table) > state.asOf) return;
  state.priceVersion = PRODUCT_PRICE_VERSION;
  state.prices = { table: resolutionPriceTable() };
}

export function newProductState(input: {
  creator: ChatPrincipalId;
  room: string;
  nowMs: number;
}): ProductState {
  return {
    schema: 5,
    priceVersion: PRODUCT_PRICE_VERSION,
    prices: { table: resolutionPriceTable() },
    creator: input.creator,
    room: roomKey(input.room),
    asOf: input.nowMs,
    freeStart: { status: "unreserved", used: 0, pending: 0 },
    grants: [],
    exemptUntil: null,
    balanceCents: 0,
    pendingCents: 0,
    creditBaseCents: 0,
    credits: 0,
    everFunded: false,
    pausedAt: null,
    pauseWaived: false,
    suspended: null,
    creditedPayments: [],
  };
}

function checkedGrant(value: unknown): value is ProductGrantCases {
  return (
    object(value) &&
    Object.keys(value).sort().join() ===
      "cases,endsAt,id,kind,pending,startsAt,used" &&
    typeof value.id === "string" &&
    GRANT_ID.test(value.id) &&
    isProductGrantKind(value.kind) &&
    value.kind !== "operator" &&
    natural(value.cases) &&
    natural(value.used) &&
    natural(value.pending) &&
    (value.used as number) + (value.pending as number) <=
      (value.cases as number) &&
    natural(value.startsAt) &&
    natural(value.endsAt) &&
    (value.endsAt as number) > (value.startsAt as number)
  );
}

/** Checks the record field by field; anything else fails closed. */
function checkedState(value: Record<string, unknown>): ProductState {
  const free = value.freeStart as Record<string, unknown> | undefined;
  const credited = value.creditedPayments as unknown[];
  const suspended = value.suspended as Record<string, unknown> | null;
  const prices = value.prices as Record<string, unknown> | undefined;
  const table = normalizeStoredPriceTable(
    prices?.table,
    productPriceSource(value.priceVersion)?.kind === "order-form"
      ? "order-form"
      : "public",
  );
  if (
    typeof value.priceVersion !== "string" ||
    !(
      PRICE_VERSION.test(value.priceVersion) ||
      /^OF-\d{4}-\d{3}:[1-9]\d*$/.test(value.priceVersion)
    ) ||
    (PRICE_VERSION.test(value.priceVersion) &&
      value.priceVersion > PRODUCT_PRICE_VERSION) ||
    !productPriceSource(value.priceVersion) ||
    !object(prices) ||
    Object.keys(prices).join() !== "table" ||
    !table ||
    !natural(value.asOf) ||
    normalizeChatPrincipal(value.creator) !== value.creator ||
    typeof value.room !== "string" ||
    !object(free) ||
    !["unreserved", "reserved", "denied"].includes(free.status as string) ||
    !natural(free.used) ||
    !natural(free.pending) ||
    (free.used as number) + (free.pending as number) >
      PRODUCT_FREE_START.resolvedCases ||
    !Array.isArray(value.grants) ||
    value.grants.length > MAX_GRANTS ||
    !value.grants.every(checkedGrant) ||
    new Set(value.grants.map((grant) => grant.id)).size !==
      value.grants.length ||
    !nullableNatural(value.exemptUntil) ||
    !integer(value.balanceCents) ||
    !natural(value.pendingCents) ||
    !natural(value.creditBaseCents) ||
    !natural(value.credits) ||
    typeof value.everFunded !== "boolean" ||
    (value.cardCoverage !== undefined &&
      typeof value.cardCoverage !== "boolean") ||
    !nullableNatural(value.pausedAt) ||
    typeof value.pauseWaived !== "boolean" ||
    (suspended !== null &&
      (!object(suspended) ||
        Object.keys(suspended).join() !== "at" ||
        !natural(suspended.at))) ||
    !Array.isArray(credited) ||
    credited.length > MAX_CREDITED_PAYMENTS ||
    credited.some((id) => typeof id !== "string" || !PAYMENT_ID.test(id)) ||
    new Set(credited).size !== credited.length
  )
    throw fail();
  try {
    if (roomKey(value.room) !== value.room) throw fail();
  } catch {
    throw fail();
  }
  return { ...value, prices: { table } } as ProductState;
}

export async function readProductState(
  storage: Pick<ProductStorage, "get">,
  nowMs: number,
  env: TemplStaffEnv = {},
): Promise<ProductState> {
  if (!natural(nowMs)) throw fail();
  const stored = await storage.get<unknown>(PRODUCT_STATE_KEY);
  if (!object(stored) || stored.schema !== 5) throw fail();
  const state = checkedState(stored);
  const current = { ...state, asOf: Math.max(nowMs, state.asOf) };
  if (await sponsoredSupport(storage)) Object.defineProperty(current, SPONSORED, { value: true });
  if (current.freeStart.status === "reserved") {
    const reservation = await storage.get<FreeStartReservation>(
      FREE_START_RESERVATION_KEY,
    );
    if (reservation?.owner !== true || reservation.domain !== true)
      current.freeStart = withFreeStartEligibility(
        current.freeStart,
        "unreserved",
      );
  }
  const formPrices = await applyOrderFormPrices(storage, current, env);
  if (!formPrices) advancePrices(current);
  Object.defineProperty(current, MANUAL_MODE, {
    value:
      (await featureOn(env, storage, "manualBilling")) &&
      (await manualAgreement(storage, current)) !== null,
  });
  const usage = await activeUsageAgreement(storage, current.asOf, env);
  Object.defineProperty(current, USAGE_MODE, { value: usage !== null });
  Object.defineProperty(current, USAGE_STATUS, {
    value: usage
      ? (await usageView(storage, current.asOf, env)).status
      : "active",
  });
  if (!current[MANUAL_MODE] && !current[USAGE_MODE] && nowMs >= Date.parse(PRODUCT_STANDARD_ACCESS_STARTED_ON) && !(await activeProductOrderForm(storage, nowMs))) {
    const standard = await standardPlanView(storage, nowMs);
    const retained = (await storage.get("product-standard-plan-v1")) === undefined;
    const legacyFunding = current.everFunded || current.cardCoverage || current.grants.length > 0 ||
      (retained && (current.balanceCents !== 0 || current.pendingCents !== 0 || current.pausedAt !== null));
    if (standard.status === "paid" || !legacyFunding) Object.defineProperty(current, STANDARD_PLAN, { value: standard });
  }
  return current;
}

export const standardPlanForState = (state: ProductState) =>
  state[STANDARD_PLAN];

/** Applies to self-serve accounts created with the hosted offers. The first
 * delivered answer still commits its debit and deduplication in one transaction. */
export function canFundNextCase(standard?: StandardPlanView) {
  if (!standard?.starterAvailable || standard.status !== "paid") return true;
  const usage = standard.period?.usage;
  if (!usage || usage.answeredCases < usage.includedAnsweredCases) return true;
  const available = BigInt(standard.prepaid?.cashAvailableUsdNanos ?? "0");
  return available >= BigInt(usage.additionalAnsweredCaseCents) * 10_000_000n;
}

/** Creates the record for a new workspace, once. */
export async function initializeProducts(
  storage: ProductStorage,
  input: {
    creator: ChatPrincipalId;
    room: string;
    nowMs: number;
    starterAvailable?: true;
  },
) {
  if (await storage.get<unknown>(PRODUCT_STATE_KEY)) return;
  await storage.put(PRODUCT_STATE_KEY, newProductState(input));
  if (input.nowMs >= Date.parse(PRODUCT_STANDARD_ACCESS_STARTED_ON))
    await initializeStandardPlan(storage, input.starterAvailable);
}

/** Whether a never-funded workspace is paused for its balance: it reached
 * the free negative limit, and neither a top-up nor an operator lifted the
 * pause since. An active authorized manual agreement bypasses this prepaid
 * pause without clearing the stored pause or conferring funding. */
export function balancePaused(
  state: Pick<
    ProductState,
    | "pausedAt"
    | "pauseWaived"
    | "everFunded"
    | "cardCoverage"
    | typeof MANUAL_MODE
    | typeof USAGE_MODE
  >,
) {
  return (
    !state[MANUAL_MODE] &&
    !state[USAGE_MODE] &&
    state.pausedAt !== null &&
    !state.pauseWaived &&
    !state.everFunded &&
    !state.cardCoverage
  );
}

/** How Support runs now (see ProductMode). */
export function productMode(state: ProductState): ProductMode {
  if (state.suspended) return "suspended";
  if (state[SPONSORED]) return "exempt";
  if (state.exemptUntil !== null && state.asOf < state.exemptUntil)
    return "exempt";
  if (state[STANDARD_PLAN])
    return state[STANDARD_PLAN].status === "paid" ? "funded" : "free";
  if (balancePaused(state)) return "paused";
  return state.everFunded || state.cardCoverage || state[USAGE_MODE]
    ? "funded"
    : "free";
}
/** Whether the team can reply now and whether new requests are taken. A
 * suspended workspace keeps its open threads answerable; a paused one
 * waits for a top-up. */
export function productSupport(mode: ProductMode) {
  return {
    enabled: mode !== "paused",
    canAdmit: mode !== "paused" && mode !== "suspended",
  };
}
/** The operating limits that apply: full once funded (or exempt), else the
 * free bounds. */
export function productFunded(state: ProductState) {
  return (
    state[STANDARD_PLAN]?.status === "paid" ||
    state.everFunded ||
    state[USAGE_MODE] === true ||
    state.cardCoverage === true ||
    productMode(state) === "exempt"
  );
}
/** Mode, support flags and funding, for the routes that only need to know
 * whether Support runs. Throws 503 on an unreadable record. */
export async function readProductSupport(
  storage: Pick<ProductStorage, "get">,
  nowMs: number,
  env: TemplStaffEnv = {},
) {
  const state = await readProductState(storage, nowMs, env);
  const mode = productMode(state);
  return {
    mode,
    ...productSupport(mode),
    canAdmit:
      productSupport(mode).canAdmit &&
      state[USAGE_STATUS] === "active" &&
      (mode === "exempt" || canFundNextCase(state[STANDARD_PLAN])) &&
      (mode === "exempt" ||
        !state[STANDARD_PLAN] ||
        state[STANDARD_PLAN].status === "paid" ||
        state[STANDARD_PLAN].ticketsUsed < state[STANDARD_PLAN].ticketsTotal),
    funded: productFunded(state),
  };
}

/** The worker's switch for resolved-case billing. Off: charges are
 * recorded, but nothing is reserved or debited. */
export type ProductOptions = { billing: boolean };
export const BILLING_OFF: ProductOptions = Object.freeze({ billing: false });
export function productOptions(env: unknown): ProductOptions {
  return featureOn(
    (env ?? {}) as WorkspaceFlagEnv,
    undefined,
    "resolutionBilling",
  )
    ? { billing: true }
    : BILLING_OFF;
}

/** Every refused support request tells the user only this. It never points
 * them to another contact. */
export const SUPPORT_REFUSAL = "This team can't take new cases right now.";
/** A paused workspace's widget says this instead. */
export const SUPPORT_PAUSED_REFUSAL =
  "Support here is paused until the team adds balance. It comes back as soon as they do.";
/** A member request turned away by the workspace's state. `refusal` tells
 * the refusal ledger why. */
export class AdmissionRefusal extends HttpError {
  readonly refusal: "paused" | "suspended" | "credit-limit" | "demo-limit";
  constructor(refusal: "paused" | "suspended" | "credit-limit" | "demo-limit") {
    super(
      403,
      refusal === "paused" ? SUPPORT_PAUSED_REFUSAL : SUPPORT_REFUSAL,
      undefined,
      `support-${refusal}`,
    );
    this.refusal = refusal;
  }
}
/** What the team hears when a paused workspace stops a reply. */
export function staffRefusal() {
  return new HttpError(
    403,
    "Support is paused until your balance is topped up. Add balance on the Plan tab to reply.",
    undefined,
    "support-paused",
  );
}
/** Checks pause and suspension for new requests, and usage credit for new
 * cases. Returns the workspace mode. */
export async function admitMemberRequest(
  storage: Pick<ProductStorage, "get">,
  input: {
    nowMs: number;
    newRequest: boolean;
    /** Whether the ledger opens a case that reserves usage credit. */
    newCase?: boolean;
    env?: TemplStaffEnv;
  },
): Promise<ProductMode> {
  const state = await readProductState(storage, input.nowMs, input.env);
  const mode = productMode(state);
  if (input.newRequest && (mode === "paused" || mode === "suspended"))
    throw new AdmissionRefusal(mode);
  const standard = state[STANDARD_PLAN];
  if ((input.newCase ?? input.newRequest) && mode !== "exempt" && !canFundNextCase(standard))
    throw new AdmissionRefusal("credit-limit");
  if (
    (input.newCase ?? input.newRequest) &&
    mode !== "exempt" &&
    standard?.status === "demo" &&
    standard.ticketsUsed >= standard.ticketsTotal
  )
    throw new AdmissionRefusal("demo-limit");
  if ((input.newCase ?? input.newRequest) && state[USAGE_STATUS] !== "active") {
    if (state[USAGE_STATUS] === "credit-limit")
      throw new AdmissionRefusal("credit-limit");
    throw fail();
  }
  return mode;
}
/** Throws the staff refusal while the workspace is paused. */
export async function assertTeamReply(
  storage: Pick<ProductStorage, "get">,
  nowMs: number,
  env: TemplStaffEnv = {},
) {
  if (productMode(await readProductState(storage, nowMs, env)) === "paused")
    throw staffRefusal();
}

/** Reserves the free start once both owner and domain checks allow it.
 * A request without an app domain leaves it unreserved. Staff previews,
 * test accounts, the canary and bots never call this. */
export async function reserveFreeStart(
  storage: ProductStorage,
  input: {
    nowMs: number;
    env?: TemplStaffEnv;
    reserve?: (
      creator: ChatPrincipalId,
      room: string,
    ) => Promise<FreeStartReservation>;
  },
) {
  const state = await readProductState(storage, input.nowMs, input.env);
  if (state.freeStart.status !== "unreserved") return state.freeStart.status;
  const reservation = input.reserve
    ? await input.reserve(state.creator, state.room)
    : { owner: false, domain: null };
  await storage.put(FREE_START_RESERVATION_KEY, reservation);
  if (reservation.owner && reservation.domain === null) {
    await storage.put(PRODUCT_STATE_KEY, state);
    return "unreserved";
  }
  const allowed = reservation.owner && reservation.domain === true;
  state.freeStart = withFreeStartEligibility(
    state.freeStart,
    allowed ? "reserved" : "denied",
  );
  await storage.put(PRODUCT_STATE_KEY, state);
  await recordProductEvent(storage, "free-start", {
    action: allowed ? "free-start.reserved" : "free-start.denied",
    at: state.asOf,
  });
  return state.freeStart.status;
}

/** Where one charge's price comes from. Reserved when the charge goes
 * pending or confirmed, given back on a void, settled at final. */
export type ChargeSlot =
  | { source: "free" }
  | { source: "grant"; grantId: string }
  | { source: "manual"; reservedCents: number }
  | { source: "balance"; reservedCents: number }
  | { source: "card" };
/** Takes the next slot in order: a free case, then grant cases (the
 * earliest end first, in date), then the balance at `firstStepCents`.
 * Mutates `state`; the caller saves it. */
export function reserveSlot(
  state: ProductState,
  firstStepCents: number,
  eligibleForFreeStart = true,
  fallback: "balance" | "manual" = "balance",
): ChargeSlot {
  const free = state.freeStart;
  if (
    eligibleForFreeStart &&
    free.status === "reserved" &&
    free.used + free.pending < PRODUCT_FREE_START.resolvedCases
  ) {
    free.pending++;
    return { source: "free" };
  }
  const grant = [...state.grants]
    .filter(
      (entry) =>
        entry.endsAt > state.asOf && entry.used + entry.pending < entry.cases,
    )
    .sort((a, b) => a.endsAt - b.endsAt || a.id.localeCompare(b.id))[0];
  if (grant) {
    grant.pending++;
    return { source: "grant", grantId: grant.id };
  }
  if (fallback === "manual")
    return { source: "manual", reservedCents: firstStepCents };
  if (state.cardCoverage && state.balanceCents <= 0) return { source: "card" };
  state.pendingCents += firstStepCents;
  return { source: "balance", reservedCents: firstStepCents };
}
/** Gives a reserved slot back: a voided or excluded charge. */
export function releaseSlot(state: ProductState, slot: ChargeSlot) {
  if (slot.source === "free")
    state.freeStart.pending = Math.max(0, state.freeStart.pending - 1);
  else if (slot.source === "grant") {
    const grant = state.grants.find((entry) => entry.id === slot.grantId);
    if (grant) grant.pending = Math.max(0, grant.pending - 1);
  } else if (slot.source === "balance")
    state.pendingCents = Math.max(0, state.pendingCents - slot.reservedCents);
}
/** Settles a slot at final. A free or in-date grant slot is used at no
 * price; a grant past its end, and the balance, debit `priceCents()`.
 * Returns where the price came from and what was debited. */
export function settleSlot(
  state: ProductState,
  slot: ChargeSlot,
  priceCents: () => number,
  fallback: "balance" | "manual" = "balance",
): {
  source: "free" | "grant" | "balance" | "card" | "manual";
  priceCents: number;
  grantId?: string;
} {
  if (slot.source === "free") {
    releaseSlot(state, slot);
    if (state.freeStart.status === "reserved") {
      state.freeStart.used++;
      return { source: "free", priceCents: 0 };
    }
    slot = reserveSlot(state, 0, true, fallback);
  }
  if (slot.source === "grant") {
    const grant = state.grants.find((entry) => entry.id === slot.grantId);
    if (grant) grant.pending = Math.max(0, grant.pending - 1);
    if (grant && grant.endsAt > state.asOf && grant.used < grant.cases) {
      grant.used++;
      return { source: "grant", priceCents: 0, grantId: grant.id };
    }
  } else releaseSlot(state, slot);
  const price = priceCents();
  if (fallback === "manual" || slot.source === "manual")
    return { source: "manual", priceCents: price };
  if (state.cardCoverage && state.balanceCents <= 0)
    return { source: "card", priceCents: price };
  state.balanceCents -= price;
  if (
    state.pausedAt === null &&
    !state.pauseWaived &&
    freeWorkspacePaused(state.balanceCents, state.everFunded)
  )
    state.pausedAt = state.asOf;
  return { source: "balance", priceCents: price };
}
/** Returns a credited charge's price, free case or grant case. */
export function creditBack(
  state: ProductState,
  input: {
    source: "free" | "grant" | "balance";
    priceCents: number;
    grantId?: string;
  },
) {
  if (input.source === "free")
    state.freeStart.used = Math.max(0, state.freeStart.used - 1);
  else if (input.source === "grant") {
    const grant = state.grants.find((entry) => entry.id === input.grantId);
    if (grant) grant.used = Math.max(0, grant.used - 1);
  } else state.balanceCents += input.priceCents;
}
function clearPause(state: ProductState) {
  if (state.pausedAt !== null && state.balanceCents >= 0) state.pausedAt = null;
}
/** The signed balance at the end of each UTC month it changed in: a
 * statement's closing balance, and the next month's opening one. */
export const BALANCE_MONTH_PREFIX = "product-balance-month-v1:";
export async function noteMonthBalance(
  storage: ProductStorage,
  state: ProductState,
) {
  await storage.put(`${BALANCE_MONTH_PREFIX}${resolutionMonth(state.asOf)}`, {
    closingCents: state.balanceCents,
    at: state.asOf,
  });
}
/** One balance change as a monthly statement lists it, filed under the UTC
 * month the balance changed in: the month `noteMonthBalance` closes. With
 * the opening balance, a month's rows add up to its closing balance. */
export const STATEMENT_PREFIX = "product-statement-v1:";
export type StatementRow =
  | {
      kind: "top-up";
      paymentId: string;
      paidAt: number;
      usdCents: number;
      bonusCents: number;
    }
  | {
      kind: "case-price";
      ref: string;
      priceCents: number;
      priceVersion: string;
      contributions?: SupportCaseContributions;
      billingReason?: "no Templ contribution";
      pilot?: {
        id: string;
        title: string;
        revision: number;
        upfrontCreditCents: number;
      };
      capReason?: "monthly cap" | "pilot cap";
    }
  | {
      kind: "pilot-credit";
      ref: string;
      cents: number;
      pilot: { id: string; title: string; revision: number };
    }
  | {
      kind: "charge";
      ref: string;
      priceCents: number;
    }
  | {
      kind: "credit";
      ref: string;
      reason: ProductDisputeReason;
      cents: number;
    }
  | { kind: "incident"; at: number; cents: number };
const pad16 = (value: number) => String(value).padStart(16, "0");
/** Files a statement row for a balance change `state` already holds. */
export async function noteStatementRow(
  storage: ProductStorage,
  state: Pick<ProductState, "asOf">,
  id: string,
  row: StatementRow,
) {
  await storage.put(
    `${STATEMENT_PREFIX}${resolutionMonth(state.asOf)}:${pad16(state.asOf)}:${id}`,
    row,
  );
}
/** Available = balance less the charges reserved on it. */
export const availableCents = (state: ProductState) =>
  state.balanceCents - state.pendingCents;

type TopUpLedger = {
  schema: 1;
  topUps: {
    id: string;
    at: number;
    paidCents: number;
    bonusCents: number;
    paidLeft: number;
    bonusLeft: number;
  }[];
};
export async function readTopUps(
  storage: Pick<ProductStorage, "get">,
): Promise<TopUpLedger> {
  const value = await storage.get<unknown>(PRODUCT_TOP_UPS_KEY);
  if (value === undefined) return { schema: 1, topUps: [] };
  if (
    !object(value) ||
    value.schema !== 1 ||
    !Array.isArray(value.topUps) ||
    value.topUps.length > MAX_TOP_UPS ||
    value.topUps.some(
      (row) =>
        !object(row) ||
        typeof row.id !== "string" ||
        ![
          row.at,
          row.paidCents,
          row.bonusCents,
          row.paidLeft,
          row.bonusLeft,
        ].every(natural),
    )
  )
    throw fail();
  return value as TopUpLedger;
}
/** Draws a debit from the top-ups, oldest first, each one's bonus before its
 * paid part, so refunds only ever return paid money left over. */
export async function drawTopUps(storage: ProductStorage, cents: number) {
  if (cents <= 0) return;
  const ledger = await readTopUps(storage);
  let left = cents;
  for (const row of ledger.topUps) {
    const bonus = Math.min(row.bonusLeft, left);
    row.bonusLeft -= bonus;
    left -= bonus;
    const paid = Math.min(row.paidLeft, left);
    row.paidLeft -= paid;
    left -= paid;
    if (!left) break;
  }
  await storage.put(PRODUCT_TOP_UPS_KEY, ledger);
}
/** The paid money a refund could return now: paid parts left in top-ups
 * younger than the refund window, less charges reserved on the balance.
 * Bonus and grant credit are never refunded. */
export async function refundableCents(
  storage: Pick<ProductStorage, "get">,
  state: ProductState,
) {
  const ledger = await readTopUps(storage);
  const since = state.asOf - PRODUCT_TOP_UP.refundWindowDays * DAY;
  const paid = ledger.topUps
    .filter((row) => row.at >= since)
    .reduce((sum, row) => sum + row.paidLeft, 0);
  return Math.max(0, Math.min(paid, state.balanceCents) - state.pendingCents);
}

/** Credits a verified top-up once: the paid amount plus bonus credit on the
 * part left after a negative balance clears. `operator` credits an
 * unmatched payment under its own payment ID, audited by the caller; its
 * amount is any whole number of cents up to the top-up maximum. */
export async function creditTopUp(
  storage: ProductStorage,
  input: {
    paymentId: string;
    usdCents: number;
    paidAt: number;
    nowMs: number;
    operator?: boolean;
    orderForm?: boolean;
    env?: TemplStaffEnv;
  },
) {
  if (
    typeof input.paymentId !== "string" ||
    !PAYMENT_ID.test(input.paymentId) ||
    input.paymentId.startsWith(GRANT_PAYMENT_PREFIX) ||
    !natural(input.paidAt) ||
    input.paidAt > input.nowMs ||
    (input.operator || input.orderForm
      ? !natural(input.usdCents) ||
        input.usdCents === 0 ||
        input.usdCents >
          (input.orderForm ? 25_000_000 : PRODUCT_TOP_UP.maxUsdCents)
      : !productTopUp(input.usdCents))
  )
    throw fail();
  const state = await readProductState(storage, input.nowMs, input.env);
  if (state.creditedPayments.includes(input.paymentId))
    return { credited: false as const, state };
  if (state.creditedPayments.length >= MAX_CREDITED_PAYMENTS)
    throw new HttpError(409, "Billing history needs an operator review.");
  const bonusCents =
    input.operator || input.orderForm
      ? 0
      : topUpBonusCents(input.usdCents, state.balanceCents);
  const wasPaused = productMode(state) === "paused";
  state.balanceCents += input.usdCents + bonusCents;
  state.everFunded = true;
  clearPause(state);
  state.credits++;
  state.creditBaseCents = Math.max(0, availableCents(state));
  state.creditedPayments.push(input.paymentId);
  await storage.put(PRODUCT_STATE_KEY, state);
  await noteMonthBalance(storage, state);
  await noteStatementRow(storage, state, `top-up:${input.paymentId}`, {
    kind: "top-up",
    paymentId: input.paymentId,
    paidAt: input.paidAt,
    usdCents: input.usdCents,
    bonusCents,
  });
  const ledger = await readTopUps(storage);
  ledger.topUps.push({
    id: input.paymentId,
    at: input.paidAt,
    paidCents: input.usdCents,
    bonusCents,
    paidLeft: input.usdCents,
    bonusLeft: bonusCents,
  });
  await storage.put(PRODUCT_TOP_UPS_KEY, ledger);
  await recordProductEvent(storage, `payment:${input.paymentId}`, {
    action: input.operator ? "topup.operator-credited" : "topup.credited",
    at: state.asOf,
    cents: input.usdCents,
  });
  if (wasPaused && productMode(state) !== "paused")
    await recordProductEvent(storage, `unpaused:${state.credits}`, {
      action: "support.unpaused",
      at: state.asOf,
    });
  if (!input.operator)
    await markWorkspaceStep(storage, "payment_credited", state.asOf);
  return {
    credited: true as const,
    bonusCents,
    balanceAfterCents: state.balanceCents,
    suspended: state.suspended !== null,
    state,
  };
}

/** Adds a reviewed grant's cases, or makes Templ's own workspace exempt
 * under its operator grant. Mutates `state`; the caller saves it. A grant
 * makes the workspace funded for good. */
export function applyGrant(
  state: ProductState,
  grant: {
    id: string;
    kind: ProductGrantKind;
    cases: number;
    days: number;
  },
) {
  const endsAt = state.asOf + grant.days * DAY;
  if (grant.kind === "operator")
    state.exemptUntil = Math.max(state.exemptUntil ?? 0, endsAt);
  else {
    if (state.grants.length >= MAX_GRANTS) {
      // Grants that ended and hold nothing make room.
      state.grants = state.grants.filter(
        (entry) => entry.endsAt > state.asOf || entry.pending > 0,
      );
      if (state.grants.length >= MAX_GRANTS)
        throw new HttpError(409, "Billing history needs an operator review.");
    }
    state.grants.push({
      id: grant.id,
      kind: grant.kind,
      cases: grant.cases,
      used: 0,
      pending: 0,
      startsAt: state.asOf,
      endsAt,
    });
  }
  state.everFunded = true;
  state.credits++;
  clearPause(state);
  state.creditedPayments.push(`${GRANT_PAYMENT_PREFIX}${grant.id}`);
}
/** Revokes a grant: its unused cases go, the reserved and used stay. An
 * operator grant ends now. Returns the cases dropped. */
export function revokeGrant(
  state: ProductState,
  input: { id: string; kind: ProductGrantKind },
) {
  if (input.kind === "operator") {
    const active = state.exemptUntil !== null && state.exemptUntil > state.asOf;
    if (active) state.exemptUntil = state.asOf;
    return active ? 1 : 0;
  }
  const grant = state.grants.find((entry) => entry.id === input.id);
  if (!grant) return 0;
  const dropped = grant.cases - grant.used - grant.pending;
  grant.cases = grant.used + grant.pending;
  return Math.max(0, dropped);
}

/** The operator's audited suspension, and lifting the pause of a
 * never-funded workspace. The caller writes the operator audit row. */
export async function setProductSuspension(
  storage: ProductStorage,
  input: {
    action: "suspend" | "unsuspend" | "resume";
    nowMs: number;
    env?: TemplStaffEnv;
  },
) {
  const state = await readProductState(storage, input.nowMs, input.env);
  if (input.action === "suspend") state.suspended ??= { at: state.asOf };
  else if (input.action === "unsuspend") state.suspended = null;
  else {
    state.pauseWaived = true;
    state.pausedAt = null;
  }
  await storage.put(PRODUCT_STATE_KEY, state);
  return state;
}
