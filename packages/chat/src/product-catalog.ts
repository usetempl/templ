import type { ProductUsageView } from "./usage-billing";
import type { SupportCaseContributions } from "./support";
import { PRODUCT_OFFER_VERSION, PRODUCT_RESOLUTION_RULES } from "./plans";
import {
  productTopUp,
  type ProductBalanceLevel,
  type ResolutionPriceStep,
} from "./resolution-pricing";

export type ProductKind = "support";
export type ProductOfferVersion = typeof PRODUCT_OFFER_VERSION;

/** Reviewed grants Templ gives one named workspace. `operator` makes Templ's
 * own workspace exempt; every other kind holds resolved cases until its end
 * date: `founding` (the founding credit), `pilot`, `capacity-test` (hosted
 * trials on staging) and `managed-agent`. */
export const PRODUCT_GRANT_KINDS = [
  "operator",
  "founding",
  "pilot",
  "capacity-test",
  "managed-agent",
] as const;
export type ProductGrantKind = (typeof PRODUCT_GRANT_KINDS)[number];
export function isProductGrantKind(value: unknown): value is ProductGrantKind {
  return PRODUCT_GRANT_KINDS.includes(value as ProductGrantKind);
}

/** How Support runs for a workspace now.
 * - free: no verified top-up or grant yet; resolved cases use the free start,
 *   then the balance, which may go negative down to the free limit.
 * - funded: at least one verified top-up or grant; the balance may go
 *   negative without limit.
 * - exempt: Templ's own workspace under its operator grant; nothing debits.
 * - paused: never funded and the balance reached the free negative limit;
 *   new requests and team replies wait for a top-up.
 * - suspended: an audited Templ operator suspended the workspace; new
 *   requests are refused, open threads stay answerable. */
export const PRODUCT_MODES = [
  "free",
  "funded",
  "exempt",
  "paused",
  "suspended",
] as const;
export type ProductMode = (typeof PRODUCT_MODES)[number];

/** One payment a billing manager can make: a top-up of whole dollars. */
export type ProductPurchase = { kind: "top-up"; usdCents: number };
/** The top-up a request body asks for (`{usdCents}`), or null for anything
 * checkout can't take. */
export function productPurchase(body: unknown): ProductPurchase | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  return productTopUp((body as { usdCents?: unknown }).usdCents);
}

/** The charge lifecycle of one resolved case. */
export const PRODUCT_CHARGE_STATES = [
  "pending",
  "confirmed",
  "final",
  "not-billable",
  "voided",
  "excluded",
  "no-reply",
  "duplicate",
  "exempt",
  "credited",
] as const;
export type ProductChargeState = (typeof PRODUCT_CHARGE_STATES)[number];
/** Why a charge does not bill. */
export type ProductChargeReason =
  | "canary"
  | "staff-preview"
  | "install-preview"
  | "test-account"
  | "spam"
  | "monthly cap"
  | "pilot cap"
  | "no Templ contribution";
/** Where a charge's price comes from, or will at final. `off` while resolved
 * case billing is switched off: nothing is reserved or debited. */
export type ProductChargeSource =
  | "free"
  | "grant"
  | "balance"
  | "manual"
  | "card"
  | "exempt"
  | "off";
/** Who marked the case resolved: the member (Yes or Solved) or the team. */
export type ProductChargeResolvedBy = "member" | "team";
/** Recorded human staff replies decide the class when the charge starts.
 * Reopening keeps that class. */
export type ProductChargeHandlingClass = "team-handled" | "ai-only";
/** The team side of a resolve: a person, the workspace's own AI agent, or
 * Templ's managed agent ("Templ AI"). */
export const PRODUCT_CHARGE_CLOSERS = [
  "person",
  "bot",
  "managed",
  "member",
] as const;
export type ProductChargeCloser = (typeof PRODUCT_CHARGE_CLOSERS)[number];
export const PRODUCT_DISPUTE_REASONS = [
  "spam",
  "test",
  "duplicate",
  "not-resolved",
  "other",
] as const;
export type ProductDisputeReason = (typeof PRODUCT_DISPUTE_REASONS)[number];
/** Characters of dispute text a billing manager may add for the operator. */
export const PRODUCT_DISPUTE_TEXT_MAX = 280;
export type ProductChargeEvent = {
  at: string;
  kind:
    | "resolved"
    | "confirmed"
    | "reopened"
    | "voided"
    | "excluded"
    | "final"
    | "disputed"
    | "credited"
    | "dispute-rejected";
  actor: {
    kind: "member" | "team" | "operator" | "system";
    principal?: string;
  };
};

/** What Templ added to one case, from recorded facts only. */
export type ProductCaseAdded = {
  /** The member proved the wallet with a signed sign-in. */
  walletVerified: boolean;
  /** At least one transaction check ran on the case. */
  transactionCheck: boolean;
  /** The team sent an AI draft, edited or not. */
  aiDraftUsed: boolean;
  aiAnswered?: boolean;
  /** From the member's first message to the team's first reply. */
  firstReplyMs: number | null;
};

/** A UTC month of cases, opened in that month, from the case ledger:
 * counts and times only. `complete` is false when the month held more
 * cases than one read covers. */
export type ProductMonthActivity = {
  /** `yyyymm`. */
  month: string;
  opened: number;
  answered: number;
  resolved: number;
  /** Cases where the member answered "No" to "Did this solve it?". */
  notSolved: number;
  /** Cases reopened at least once. */
  reopened: number;
  medianFirstReplyMs: number | null;
  medianResolveMs: number | null;
  walletVerified: number;
  transactionChecks: number;
  aiDraftsUsed: number;
  aiAnswers?: number;
  complete: boolean;
};

/** One charge as a billing manager sees it. `ref` is the charge's only
 * name outside the workspace's room. `thread` appears only while the viewer
 * has current access to that thread. */
export type ProductChargeView = {
  ref: string;
  state: ProductChargeState;
  reason: ProductChargeReason | null;
  contributions?: SupportCaseContributions;
  resolvedBy: ProductChargeResolvedBy;
  closer: ProductChargeCloser;
  handlingClass: ProductChargeHandlingClass;
  openedAt: string;
  resolvedAt: string;
  /** When a pending or confirmed charge goes final. */
  finalDueAt: string | null;
  finalAt: string | null;
  source: ProductChargeSource | null;
  priceCents: number;
  priceSource: ProductPriceSource;
  pilot?: ProductPilotCharge;
  /** A final charge can be disputed until this time. */
  disputeUntil: string | null;
  dispute: {
    reason: ProductDisputeReason;
    status: "open" | "credited" | "rejected";
    at: string;
    /** Disputes past the month's automatic share get a reply within this
     * many business days. */
    replyWithinBusinessDays: number | null;
  } | null;
  /** A later case by the same member within 14 days of this one's final. */
  possibleRepeat: boolean;
  events: ProductChargeEvent[];
  /** Null once the case's ledger row is gone. */
  added: ProductCaseAdded | null;
  thread?: string;
};

/** Resolved cases a reviewed grant holds, used at final while in date. */
export type ProductGrantView = {
  kind: Exclude<ProductGrantKind, "operator">;
  cases: number;
  used: number;
  pending: number;
  endsAt: string;
};
export type ProductMonthView = {
  /** UTC calendar month, `yyyymm`. */
  id: string;
  /** Final charges debited from the balance, at their step prices. */
  cases: number;
  teamHandledCases: number;
  aiOnlyCases: number;
  cents: number;
  free: number;
  grant: number;
  exempt: number;
  voided: number;
  excluded: number;
  noReply: number;
  noContribution?: number;
  duplicate: number;
  /** Resolved cases the member confirmed, of those that went final. */
  memberConfirmed: number;
  /** Final and pending cases by who resolved them. */
  byCloser: Record<ProductChargeCloser, number>;
};

/** A billing manager's view of card billing. Amounts are USD cents. */
export type ProductCardBillingView = {
  status: "none" | "setup-pending" | "active" | "past-due" | "canceling";
  card: { brand: string; last4: string } | null;
  monthCases: number;
  monthEstimateCents: number;
  latestInvoice: { id: string; status: string } | null;
  cancelAtPeriodEnd: boolean;
};

export type ProductPriceSource =
  | { kind: "public"; version: string }
  | { kind: "order-form"; id: string; revision: number };
/** Derives the price source from the version saved with a workspace or charge. */
export function productPriceSource(
  priceVersion: unknown,
): ProductPriceSource | null {
  if (typeof priceVersion !== "string") return null;
  const form = /^(OF-\d{4}-\d{3}):([1-9]\d*)$/.exec(priceVersion);
  if (form) {
    const revision = Number(form[2]);
    return Number.isSafeInteger(revision)
      ? { kind: "order-form", id: form[1], revision }
      : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(priceVersion)) return null;
  const date = new Date(`${priceVersion}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === priceVersion
    ? { kind: "public", version: priceVersion }
    : null;
}
export type ProductOrderFormView = {
  id: string;
  revision: number;
  service: "software" | "managed-ai" | "done-for-you";
  startsAt: string;
  endsAt: string;
};

/** A signed pilot's use, visible only with current billing permission. */
export type ProductPilotView = {
  id: string;
  title: string;
  revision: number;
  startsAt: string;
  endsAt: string;
  state: "awaiting-payment" | "scheduled" | "active" | "ended";
  /** UTC calendar month, `yyyymm`. */
  month: string;
  monthlyCapCents: number;
  monthUsedCents: number;
  totalCapCents: number;
  totalUsedCents: number;
  upfrontCents: number;
  upfrontPaidCents: number;
  upfrontCreditLeftCents: number;
};

/** The pilot and revision recorded when a case went final. */
export type ProductPilotCharge = {
  id: string;
  title: string;
  revision: number;
  upfrontCreditCents: number;
};

/** A billing manager's view of the plan. Amounts are USD cents. */
export type ProductAccessView = {
  billingManagedByTempl?: true;
  standardPlan?: import("./standard-plan").StandardPlanView;
  standardPlanDebtCents?: number;
  billingMethod?: "usdc" | "card";
  cardBilling?: ProductCardBillingView;
  offerVersion: ProductOfferVersion;
  mode: ProductMode;
  /** Whether the team can reply now and whether new requests are taken. */
  support: { enabled: boolean; canAdmit: boolean };
  /** "off" while resolved-case billing is switched off: charges are
   * recorded, nothing is reserved or debited. */
  billing: "on" | "off";
  usageBilling?: ProductUsageView;
  manualBilling?: {
    status: "ready" | "setup-needed" | "off";
    month: {
      id: string;
      cases: number;
      chargedCents: number;
      creditedCents: number;
    };
    pendingCents: number;
    dueCents: number;
    chargedCents: number;
    creditedCents: number;
  };
  free: {
    total: number;
    used: number;
    pending: number;
    status: "unreserved" | "reserved" | "denied";
  };
  grants: ProductGrantView[];
  balance: {
    balanceCents: number;
    /** Pending and confirmed charges on the balance, at the first step. */
    pendingCents: number;
    availableCents: number;
    /** The available amount right after the latest credit. */
    creditBaseCents: number;
    everFunded: boolean;
    level: ProductBalanceLevel | null;
    /** A never-funded workspace pauses at this signed balance. */
    pauseAtCents: number | null;
    /** Days the balance lasts at the last 7 days' pace; null without a
     * pace or without a positive balance. */
    runwayDays: number | null;
  };
  month: ProductMonthView;
  /** The price table this workspace pays now. */
  steps: ResolutionPriceStep[];
  aiOnlyPriceCents: number;
  /** A published table that makes some case cost more, and the moment
   * charges that go pending start to use it; null when none waits. */
  priceSource: ProductPriceSource;
  orderForm: ProductOrderFormView | null;
  pilot?: ProductPilotView | null;
  pendingPilot?: ProductPilotView | null;
  pilotEnabled?: boolean;
  priceChange: {
    appliesAt: string | null;
    noticeAt?: string | null;
    priceSource?: ProductPriceSource;
    steps: ResolutionPriceStep[];
    aiOnlyPriceCents: number;
  } | null;
  /** The step price the next billable case in this month goes final at. */
  nextPriceCents: number;
  /** The month's billable cases passed the custom threshold. */
  customVolume: boolean;
  suspended: boolean;
  /** Pending and confirmed charges waiting to go final. */
  billingSoon: number;
};

/** A billing manager's monthly statement: opening and closing balance,
 * top-ups with chain, hash, payer and bonus, charges by price step, credits
 * with their dispute reason and Templ's incident credits. Each row is a
 * balance change in the month, so opening plus top-ups and bonus, less
 * charges, plus credits and incident credits, is closing. Amounts and
 * hashes only. */
export type ProductStatement = {
  standard?: Omit<
    import("./standard-plan").StandardPlanRecords,
    "partial" | "cursor"
  > & { truncated: boolean };
  usage?: import("./usage-billing").ProductUsageStatement;
  manual?: {
    openingCents: number;
    closingCents: number;
    truncated: boolean;
    rows: {
      kind: "charge" | "credit";
      ref: string;
      at: number;
      cents: number;
      priceVersion: string;
      agreement: { id: string; revision: number; effectiveRevision: number };
      reason?: ProductDisputeReason;
    }[];
  };
  month: string;
  issuer: string;
  openingCents: number;
  closingCents: number;
  topUps: {
    paidAt: string;
    chain: string;
    txHash: string;
    payer: string;
    usdCents: number;
    bonusCents: number;
    rail?: string;
    network?: string | number;
    token?: string;
    recipient?: string;
    logIndex?: number;
    instructionIndex?: number;
    creditedAt?: string;
    requestId?: string;
    orderFormId?: string;
    orderFormTitle?: string;
    orderFormRevision?: number;
  }[];
  steps: { priceCents: number; cases: number; cents: number }[];
  charges: {
    ref: string;
    priceCents: number;
    priceSource: ProductPriceSource;
    pilot?: ProductPilotCharge;
    capReason?: "monthly cap" | "pilot cap";
    contributions?: SupportCaseContributions;
    billingReason?: "no Templ contribution";
  }[];
  /** Applied upfront credit is already part of the charge's balance debit.
   * These rows explain its use and add no balance change. */
  pilotCredits: {
    ref: string;
    cents: number;
    pilot: Pick<ProductPilotCharge, "id" | "title" | "revision">;
  }[];
  free: number;
  grant: number;
  credits: { ref: string; reason: ProductDisputeReason; cents: number }[];
  /** Credits a Templ operator added for an incident. */
  incidents: { at: string; cents: number }[];
  /** More balance changes in the month than one statement reads. */
  truncated: boolean;
};

/** The workspace's finance address as billing managers see it: masked,
 * and whether its owner proved it with the emailed code. */
export type ProductFinanceEmailView = {
  email: string;
  status: "pending" | "verified";
} | null;

/** Members and staff without billing see whether Support is open, never an
 * amount, a count or a grant. */
export type MemberProductView = {
  billingManagedByTempl?: true;
  offerVersion: ProductOfferVersion;
  mode: "open" | "closed";
  support: { enabled: boolean; canAdmit: boolean };
};
export function memberProductView(view: ProductAccessView): MemberProductView {
  return {
    ...(view.billingManagedByTempl ? { billingManagedByTempl: true } : {}),
    offerVersion: view.offerVersion,
    mode: view.support.canAdmit ? "open" : "closed",
    support: { ...view.support },
  };
}

/** What the team sees on a case: whether it bills, never an amount.
 * `templAi` marks a resolve by Templ's managed agent. */
export type ProductCaseBilling = (
  | { status: "billed" }
  | { status: "free" }
  | { status: "pending" }
  | {
      status: "not-billed";
      reason:
        | ProductChargeReason
        | "no-reply"
        | "duplicate"
        | "voided"
        | "exempt"
        | "credited";
    }
) & {
  templAi?: true;
  awaitingMemberYes?: true;
  contributions?: SupportCaseContributions;
};

/** Billing alerts a workspace's billing managers get by email, and its
 * team channels as a `capacity` event without amounts. */
export const PRODUCT_BILLING_ALERTS = [
  "used-80",
  "used-100",
  "negative",
  "pause-soon",
  "paused",
  "free-start-used",
  "burst",
  "runway",
  "grant-80",
  "grant-14d",
  "grant-3d",
  "budget-50",
  "budget-80",
  "budget-100",
  "suspended",
  "price-change",
  "invoice-failed",
] as const;
export type ProductBillingAlert = (typeof PRODUCT_BILLING_ALERTS)[number];

/** The version of the resolution rules stamped on each charge. */
export const PRODUCT_RULES_VERSION = "2026-10-01";
/** How long after its team reply the widget asks "Did this solve it?" on a
 * case nobody resolved. */
export const PRODUCT_ASK_AFTER_MS =
  PRODUCT_RESOLUTION_RULES.askAfterHours * 3_600_000;

export { PRODUCT_OFFER_VERSION };
