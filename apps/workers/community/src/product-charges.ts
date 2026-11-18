import { standardDeletionSummary, STANDARD_CASE_PREFIX } from "./product-standard-plan";
/** The charge ledger: at most one charge per case, stored in the room only.
 *
 * A charge is born when a case is resolved (the team marks it resolved, the
 * member answers "Did this solve it?" with Yes, or presses Solved) and bills
 * only when the case has a recorded Templ contribution, had a team reply,
 * was not excluded when it opened and is not a duplicate. A team resolve goes pending and final after
 * `finalAfterDays` with no reopen; a member's Yes or Solved goes confirmed
 * and final after `memberFinalHours`. Pending is voided by any reopen or a
 * member "No"; confirmed only by the member. Spam before final excludes it.
 *
 * Nothing outside the room sees `tc` or `seq`: a charge is named by `ref`,
 * 16 hex of HMAC-SHA256 with the room's billing key over `tc:seq`. Rows hold
 * times, states, amounts and hashes, never message text, a wallet or a
 * member id. */
import { usageDeletionSummary } from "./product-usage-billing";
import { featureOn } from "./workspace-flags";
import { storageDeletionSummary } from "./brain-storage-billing";
import {
  forgetManualCase,
  pruneManualRows,
  manualDeletionSummary,
  manualAgreement,
  checkManualAgreement,
  reserveManualEstimate,
  reconcileManualEstimates,
  recordManualRow,
  noteManualClosing,
  type ManualAgreement,
} from "./product-manual-billing";
import {
  PRODUCT_FREE_START,
  PRODUCT_PRICE_VERSION,
  PRODUCT_RESOLUTION_RULES,
  PRODUCT_LIMITS,
} from "@templ/chat/plans";
import {
  productPriceSource,
  PRODUCT_DISPUTE_REASONS,
  PRODUCT_DISPUTE_TEXT_MAX,
  PRODUCT_RULES_VERSION,
  type ProductCaseBilling,
  type ProductChargeCloser,
  type ProductChargeHandlingClass,
  type ProductChargeEvent,
  type ProductChargeReason,
  type ProductChargeResolvedBy,
  type ProductChargeSource,
  type ProductChargeState,
  type ProductChargeView,
  type ProductDisputeReason,
  type ProductMonthView,
} from "@templ/chat/product-catalog";
import {
  autoCreditAllowance,
  chargeBurst,
  chargeDisputeUntil,
  chargeFinalDueAt,
  normalizeStoredPriceTable,
  priceTableCents,
  resolutionMonth,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import type {
  SupportCase,
  SupportCaseContributions,
} from "@templ/chat/support";
import { readCase, type CaseThreadId } from "./support-case-data";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import {
  orderFormPriceTable,
  activeProductOrderForm,
  readProductOrderForms,
} from "./product-order-forms";
import {
  creditPilotCharge,
  isPilotCharge,
  pilotChargeAt,
  settlePilotCharge,
  type PilotCharge,
} from "./product-pilot";
import type { TemplStaffEnv } from "./templ-staff";
import { HttpError, type Env } from "./common";
import { identityRequest } from "./account-identity";
import { servicePrincipals } from "./service-principals";
import { markWorkspaceStep } from "./funnel-metrics";
import { managedPrincipal } from "./managed-agent/principal";
import {
  PRODUCT_STATE_KEY,
  creditBack,
  drawTopUps,
  noteMonthBalance,
  noteStatementRow,
  STATEMENT_PREFIX,
  productMode,
  productOptions,
  readProductState,
  standardPlanForState,
  recordProductEvent,
  releaseSlot,
  reserveSlot,
  settleSlot,
  type ChargeSlot,
  type ProductStorage,
  type ProductOptions,
  type ProductState,
} from "./product-entitlements";
import { emitBalanceAlerts } from "./product-alerts";
import { queueStripeUsage, stripeCoverageAt } from "./stripe-store";
import { cardBillingEnabled } from "./stripe-billing";
import { managedResolutionBillingOn } from "./workspace-flags";
import { caseAdded } from "./product-case-facts";
import { wakeRoomAt } from "./room-alarm";
import type { CaseEvent } from "./support-cases";

type Storage = DurableObjectTransaction;

export const CHARGE_PREFIX = "product-charge-v1:";
export const CHARGE_DUE_PREFIX = "product-charge-due-v1:";
const MEMBER_PREFIX = "product-charge-member-v1:";
const IDENTITY_PREFIX = "product-billing-identity-v1:";
const REF_PREFIX = "product-charge-ref-v1:";
const LIST_PREFIX = "product-charge-at-v1:";
export const CHARGE_MONTH_PREFIX = "product-charge-month-v1:";
export const CHARGE_DAY_PREFIX = "product-charge-day-v1:";
const DISPUTE_PREFIX = "product-dispute-v1:";
const KEY = "product-billing-key-v1";
const PRUNED_KEY = "product-charge-pruned-v1";
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A later case by the same member this soon after a final charge is
 * flagged as a possible repeat. */
const REPEAT_DAYS = 14;
/** Business days the founder takes to answer a dispute past the month's
 * automatic share. */
const DISPUTE_REPLY_BUSINESS_DAYS = 5;
/** Charges stay this long after they settle, then a daily pass drops them;
 * month totals stay in their own rows. */
const RETENTION_MS = (PRODUCT_LIMITS.supportHistoryDays + 35) * DAY;
const MAX_EVENTS = 20;
/** Due charges one alarm run settles at most. */
export const FINALIZE_BATCH = 50;
const REF = /^[0-9a-f]{16}$/;

const pad8 = (value: number) => String(value).padStart(8, "0");
const pad16 = (value: number) =>
  String(Math.max(0, Math.floor(value))).padStart(16, "0");
const chargeId = (thread: string, seq: number) => `${thread}:${pad8(seq)}`;
const chargeKey = (thread: string, seq: number) =>
  `${CHARGE_PREFIX}${chargeId(thread, seq)}`;
const dueKey = (at: number, thread: string, seq: number) =>
  `${CHARGE_DUE_PREFIX}${pad16(at)}:${chargeId(thread, seq)}`;
const iso = (at: number) => new Date(at).toISOString();
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const utcDay = (at: number) => iso(at).slice(0, 10).replaceAll("-", "");

export type Charge = {
  schema: 1;
  ref: string;
  thread: string;
  seq: number;
  /** HMAC naming the member's proven billing identity within the room. */
  member: string;
  state: ProductChargeState;
  reason: ProductChargeReason | null;
  contributions?: SupportCaseContributions;
  resolvedBy: ProductChargeResolvedBy;
  closer: ProductChargeCloser;
  handlingClass: ProductChargeHandlingClass;
  /** AI-only replies from Templ's managed agent need its separate billing proof. */
  managedAi: boolean;
  /** Records a fixed free decision from a table without an AI-only rate. */
  fixedFreeDecision?: { priceVersion: string; finalAt: number };
  openedAt: number;
  firstResolvedAt: number;
  resolvedAt: number;
  dueAt: number | null;
  finalAt: number | null;
  slot: ChargeSlot | null;
  source: ProductChargeSource | null;
  grantId: string | null;
  /** The original invoice subscription stays bound through method changes. */
  stripeSubscriptionId?: string;
  priceCents: number;
  pilot?: PilotCharge;
  /** UTC month (`yyyymm`) the charge went final in. */
  month: string | null;
  /** The table applies when the charge last entered pending or confirmed.
   * A final charge keeps its table on reopen. */
  priceVersion: string;
  collection?: "manual" | "off";
  manualAgreement?: ManualAgreement;
  table: ResolutionPriceTable;
  rulesVersion: typeof PRODUCT_RULES_VERSION;
  duplicateOf: string | null;
  dispute: {
    reason: ProductDisputeReason;
    /** For the operator only; never shown to members. */
    text: string | null;
    status: "open" | "credited" | "rejected";
    at: number;
    auto: boolean;
    /** The case's de-identified row, which the operator reviewing the
     * dispute reads through `/operator/corpus`; null when the case has no
     * row. Never the thread or the case number. */
    corpus: { workspace: string; ref: string } | null;
    /** The Templ operator who answered it. */
    answeredBy?: ChatPrincipalId;
  } | null;
  events: {
    at: number;
    kind: ProductChargeEvent["kind"];
    actor: ProductChargeEvent["actor"];
  }[];
};

export type ChargeMonth = {
  schema: 1;
  /** Final charges debited from the balance, and their total. */
  cases: number;
  teamHandledCases: number;
  aiOnlyCases: number;
  cents: number;
  cardCases: number;
  cardCents: number;
  cardCreditedCents: number;
  free: number;
  grant: number;
  exempt: number;
  voided: number;
  excluded: number;
  noReply: number;
  noContribution: number;
  duplicate: number;
  memberConfirmed: number;
  byCloser: Record<ProductChargeCloser, number>;
  /** Disputes credited automatically this month. */
  autoCredits: number;
  teamHandledAutoCredits: number;
  aiOnlyAutoCredits: number;
  /** Member-confirmed charges the team then marked spam. */
  spamOnConfirmed: number;
  /** Pending charges the team voided by reopening its own resolve. */
  teamReopened: number;
  /** Final charges settled while billing was switched off. */
  off: number;
};
type ChargeDay = {
  schema: 1;
  /** New pending and confirmed charges. */
  opened: number;
  /** Charges that went final, whatever paid for them. */
  final: number;
  teamHandledFinal: number;
  aiOnlyFinal: number;
  debitedCents: number;
  /** Cases excluded as test accounts at open. */
  testExcluded: number;
  /** Cases excluded as install-check previews at open. */
  installPreviews?: number;
  burst: boolean;
};
const blankMonth = (): ChargeMonth => ({
  schema: 1,
  cases: 0,
  teamHandledCases: 0,
  aiOnlyCases: 0,
  cents: 0,
  cardCases: 0,
  cardCents: 0,
  cardCreditedCents: 0,
  free: 0,
  grant: 0,
  exempt: 0,
  voided: 0,
  excluded: 0,
  noReply: 0,
  noContribution: 0,
  duplicate: 0,
  memberConfirmed: 0,
  byCloser: { person: 0, bot: 0, managed: 0, member: 0 },
  autoCredits: 0,
  teamHandledAutoCredits: 0,
  aiOnlyAutoCredits: 0,
  spamOnConfirmed: 0,
  teamReopened: 0,
  off: 0,
});
/** Only worker-recorded steps present when the case was solved qualify. */
function contributionsAt(c: SupportCase, at: number): SupportCaseContributions {
  const result: SupportCaseContributions = {};
  for (const key of [
    "transactionCheckAt",
    "walletVerifiedAt",
    "aiAnswerAt",
  ] as const) {
    const time = c.contributions?.[key];
    if (
      typeof time === "number" &&
      natural(time) &&
      time >= c.openedAt &&
      time <= at
    )
      result[key] = time;
  }
  return result;
}
const contributed = (steps: SupportCaseContributions | undefined) =>
  Object.values(steps ?? {}).some(
    (at) => typeof at === "number" && natural(at),
  );

const blankDay = (): ChargeDay => ({
  schema: 1,
  opened: 0,
  final: 0,
  teamHandledFinal: 0,
  aiOnlyFinal: 0,
  debitedCents: 0,
  testExcluded: 0,
  burst: false,
});

async function readMonth(storage: Pick<ProductStorage, "get">, month: string) {
  const value = await storage.get<ChargeMonth>(
    `${CHARGE_MONTH_PREFIX}${month}`,
  );
  if (value === undefined) return blankMonth();
  if (
    value &&
    value.teamHandledCases === undefined &&
    value.aiOnlyCases === undefined
  ) {
    value.teamHandledCases = value.cases;
    value.aiOnlyCases = 0;
  }
  if (
    value &&
    value.teamHandledAutoCredits === undefined &&
    value.aiOnlyAutoCredits === undefined
  ) {
    value.teamHandledAutoCredits = value.autoCredits ?? 0;
    value.aiOnlyAutoCredits = value.autoCredits ?? 0;
  }
  if (
    value?.schema !== 1 ||
    !natural(value.cases) ||
    !natural(value.teamHandledCases) ||
    !natural(value.aiOnlyCases) ||
    value.teamHandledCases + value.aiOnlyCases !== value.cases ||
    !natural(value.autoCredits ?? 0) ||
    !natural(value.teamHandledAutoCredits) ||
    !natural(value.aiOnlyAutoCredits) ||
    value.teamHandledAutoCredits > (value.autoCredits ?? 0) ||
    value.aiOnlyAutoCredits > (value.autoCredits ?? 0) ||
    value.teamHandledAutoCredits + value.aiOnlyAutoCredits <
      (value.autoCredits ?? 0)
  )
    throw new HttpError(503, "The case totals could not be checked.");
  return { ...blankMonth(), ...value };
}
async function readDay(storage: Pick<ProductStorage, "get">, day: string) {
  const value = await storage.get<ChargeDay>(`${CHARGE_DAY_PREFIX}${day}`);
  if (value?.schema !== 1 || !natural(value.opened)) return blankDay();
  const totals = { ...blankDay(), ...value };
  if (value.teamHandledFinal === undefined && value.aiOnlyFinal === undefined) {
    totals.teamHandledFinal = totals.final;
    totals.aiOnlyFinal = 0;
  }
  if (
    !natural(totals.final) ||
    !natural(totals.teamHandledFinal) ||
    !natural(totals.aiOnlyFinal) ||
    totals.teamHandledFinal + totals.aiOnlyFinal !== totals.final
  )
    throw new HttpError(503, "The case totals could not be checked.");
  return totals;
}
async function bumpMonth(
  storage: Storage,
  at: number,
  change: (month: ChargeMonth) => void,
) {
  const id = resolutionMonth(at);
  const month = await readMonth(storage, id);
  change(month);
  await storage.put(`${CHARGE_MONTH_PREFIX}${id}`, month);
}
async function bumpDay(
  storage: Storage,
  at: number,
  change: (day: ChargeDay) => void,
) {
  const id = utcDay(at);
  const day = await readDay(storage, id);
  change(day);
  await storage.put(`${CHARGE_DAY_PREFIX}${id}`, day);
  return day;
}

/** The room's billing key, created on first use. It names charges and
 * members in billing rows; it never leaves the room. */
async function billingKey(storage: Pick<Storage, "get" | "put">) {
  let hex = await storage.get<string>(KEY);
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await storage.put(KEY, hex);
  }
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
async function mac(key: CryptoKey, text: string, bytes: number) {
  const out = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)),
  );
  return [...out.slice(0, bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** `ref` of the charge for case `seq` of thread `tc`. */
export async function chargeRef(
  storage: Pick<Storage, "get" | "put">,
  thread: string,
  seq: number,
) {
  return mac(await billingKey(storage), `${thread}:${seq}`, 8);
}
/** Follows billing links only. These hashes grant no conversation access. */
async function billingIdentity(
  storage: Pick<Storage, "get">,
  hash: string,
  indexes?: Set<string>,
) {
  const seen = new Set<string>();
  while (!seen.has(hash)) {
    seen.add(hash);
    indexes?.add(hash);
    const parent = await storage.get<string>(`${IDENTITY_PREFIX}${hash}`);
    if (!parent) return hash;
    hash = parent;
  }
  throw new HttpError(503, "Billing could not be verified.");
}

const memberChargeKey = (
  charge: Pick<Charge, "member" | "resolvedAt" | "ref">,
) =>
  `${MEMBER_PREFIX}${charge.member}:${pad16(charge.resolvedAt)}:${charge.ref}`;

async function deleteMemberIndex(storage: Storage, charge: Charge) {
  const rows = await storage.list<string>({
    prefix: `${MEMBER_PREFIX}${charge.member}:${pad16(charge.resolvedAt)}`,
  });
  const id = chargeId(charge.thread, charge.seq);
  const keys = [...rows]
    .filter(([, value]) => value === id)
    .map(([key]) => key);
  if (keys.length) await storage.delete(keys);
}

/** Joins proven members for billing and moves their charge indexes together. */
export async function linkBillingMembers(
  storage: Storage,
  members: readonly ChatPrincipalId[],
) {
  const key = await billingKey(storage);
  const roots = new Set<string>();
  const indexes = new Set<string>();
  for (const member of members)
    roots.add(
      await billingIdentity(
        storage,
        await mac(key, `member:${member}`, 16),
        indexes,
      ),
    );
  const canonical = [...roots].sort()[0];
  for (const other of indexes) {
    if (other === canonical) continue;
    await storage.put(`${IDENTITY_PREFIX}${other}`, canonical);
    for (;;) {
      const rows = await storage.list<string>({
        prefix: `${MEMBER_PREFIX}${other}:`,
        limit: 100,
      });
      if (!rows.size) break;
      for (const [index, id] of rows) {
        const match = /^(tc-[0-9a-f]{32}):(\d{8})$/.exec(id);
        if (match) {
          const charge = await readCharge(storage, match[1], Number(match[2]));
          if (charge) {
            charge.member = canonical;
            await saveCharge(storage, charge);
            await storage.put(memberChargeKey(charge), id);
          }
        }
        await storage.delete(index);
      }
    }
  }
  return canonical;
}

/** The full component of proven conversation links supplies one billing identity. */
async function memberIdentity(
  storage: Storage,
  record: ChargeRecord,
  env?: Partial<Env>,
) {
  const members = new Set<ChatPrincipalId>();
  const visited = new Set<string>();
  const pending = [record];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    members.add(current.member);
    for (const former of current.formerMembers ?? []) members.add(former);
    for (const id of current.linkedConversations ?? []) {
      if (visited.has(id)) continue;
      const linked = await storage.get<ChargeRecord>(`conversation-v1:${id}`);
      if (linked?.member && linked.room === record.room) pending.push(linked);
    }
  }
  if (env?.AUTH_RECORDS && env.APP_ORIGIN) {
    for (const member of [...members]) {
      const identity = await identityRequest(env as Env, {
        op: "read",
        principalId: member,
      });
      const aliases = servicePrincipals(
        identity.principalId,
        identity.servicePrincipals,
      );
      if (!aliases.includes(member))
        throw new HttpError(503, "Billing could not be verified.");
      for (const alias of aliases) members.add(alias);
    }
  }
  return linkBillingMembers(storage, [...members]);
}

/** The thread fields the ledger reads. */
export type ChargeRecord = {
  id: string;
  room: string;
  member: ChatPrincipalId;
  formerMembers?: ChatPrincipalId[];
  linkedConversations?: string[];
};

async function checkedCharge(
  storage: Pick<Storage, "get">,
  value: unknown,
  thread: string,
  seq: number,
): Promise<Charge | null> {
  const saved = value as Charge | undefined;
  if (!saved || typeof saved !== "object") return null;
  const charge = { ...saved };
  const source = productPriceSource(charge?.priceVersion);
  const table = normalizeStoredPriceTable(
    charge.table,
    source?.kind === "order-form" ? "order-form" : "public",
  );
  const unclassifiedTable =
    !Object.hasOwn(saved, "handlingClass") &&
    !Object.hasOwn(saved, "managedAi") &&
    saved.table !== null &&
    typeof saved.table === "object" &&
    Object.keys(saved.table).sort().join() ===
      "stepOneAfterCases,stepOneUsdCents,usdCents";
  if (charge.handlingClass === undefined || charge.managedAi === undefined) {
    const read = await readCase(storage, {
      thread: thread as CaseThreadId,
      seq,
    });
    if (charge.handlingClass === undefined)
      charge.handlingClass = (
        read
          ? natural(read.case.firstHumanReplyAt) &&
            read.case.firstHumanReplyAt <= charge.resolvedAt
          : charge.closer === "person"
      )
        ? "team-handled"
        : "ai-only";
    if (charge.managedAi === undefined)
      charge.managedAi =
        charge.closer === "managed" ||
        (natural(read?.case.billingManagedReplyAt) &&
          read!.case.billingManagedReplyAt! <= charge.resolvedAt);
  }
  const priorTable =
    (source?.kind === "public" && source.version === "2026-09-28") ||
    source?.kind === "order-form";
  if (
    unclassifiedTable &&
    priorTable &&
    charge.handlingClass === "ai-only" &&
    charge.source === "free" &&
    charge.slot === null &&
    natural(charge.finalAt) &&
    charge.priceCents === 0 &&
    ["final", "credited"].includes(charge.state) &&
    charge.fixedFreeDecision === undefined
  )
    charge.fixedFreeDecision = {
      priceVersion: charge.priceVersion,
      finalAt: charge.finalAt,
    };
  const savedFreeDecision =
    charge.fixedFreeDecision !== null &&
    typeof charge.fixedFreeDecision === "object" &&
    Object.keys(charge.fixedFreeDecision).sort().join() ===
      "finalAt,priceVersion" &&
    priorTable &&
    charge.handlingClass === "ai-only" &&
    charge.source === "free" &&
    charge.slot === null &&
    charge.priceCents === 0 &&
    natural(charge.finalAt) &&
    ["final", "credited"].includes(charge.state) &&
    charge.fixedFreeDecision.priceVersion === charge.priceVersion &&
    charge.fixedFreeDecision.finalAt === charge.finalAt;
  const pendingFreeReservation =
    unclassifiedTable &&
    priorTable &&
    charge.finalAt === null &&
    charge.source !== "free" &&
    ["pending", "confirmed"].includes(charge.state);
  if (
    !charge ||
    typeof charge !== "object" ||
    charge.schema !== 1 ||
    charge.thread !== thread ||
    charge.seq !== seq ||
    !REF.test(charge.ref) ||
    !["team-handled", "ai-only"].includes(charge.handlingClass) ||
    (charge.handlingClass === "ai-only" &&
      ((charge.slot?.source === "free" && !pendingFreeReservation) ||
        (charge.source === "free" && !savedFreeDecision))) ||
    typeof charge.managedAi !== "boolean" ||
    (charge.fixedFreeDecision !== undefined && !savedFreeDecision) ||
    (charge.collection !== undefined &&
      !["manual", "off"].includes(charge.collection)) ||
    !source ||
    (source.kind === "public" && source.version > PRODUCT_PRICE_VERSION) ||
    !table ||
    !Array.isArray(charge.events) ||
    (charge.pilot !== undefined &&
      (!isPilotCharge(charge.pilot) ||
        charge.pilot.upfrontCreditCents > charge.priceCents))
  )
    return null;
  if (charge.collection === "manual") {
    if (!charge.manualAgreement) return null;
    await checkManualAgreement(
      storage,
      charge.manualAgreement,
      charge.priceVersion,
      table,
    );
  } else if (
    charge.manualAgreement ||
    charge.source === "manual" ||
    charge.slot?.source === "manual"
  )
    return null;
  return {
    ...charge,
    table:
      source.kind === "order-form"
        ? await orderFormPriceTable(storage, charge.priceVersion, table)
        : table,
  };
}
export async function readCharge(
  storage: Pick<Storage, "get">,
  thread: string,
  seq: number,
) {
  const key = chargeKey(thread, seq);
  const saved = await storage.get<Charge>(key);
  const charge = await checkedCharge(storage, saved, thread, seq);
  if (saved !== undefined && !charge)
    throw new HttpError(503, "The case price could not be checked.");
  if (charge?.pilot) {
    const forms = await readProductOrderForms(storage);
    const pilot = charge.pilot;
    const form = forms.history.find(
      (item) => item.id === pilot.id && item.revision === pilot.revision,
    );
    const activatedAt =
      forms.activations?.[`${pilot.id}:${pilot.revision}`]?.at;
    if (
      !form?.pilot ||
      form.pilot.title !== pilot.title ||
      charge.finalAt === null ||
      activatedAt === undefined ||
      activatedAt > charge.finalAt ||
      charge.finalAt < form.startsAt ||
      charge.finalAt >= form.endsAt
    )
      throw new HttpError(503, "The pilot charge could not be checked.");
  }
  return charge;
}
/** Completed manual decisions stay with their immutable receivables. */
export function recoveryManualCharge(
  key: string,
  value: unknown,
): value is Charge & {
  state: Exclude<ProductChargeState, "pending" | "confirmed">;
} {
  const charge = value as Charge | null;
  return (
    !!charge &&
    typeof charge === "object" &&
    charge.collection === "manual" &&
    [
      "final",
      "not-billable",
      "voided",
      "excluded",
      "no-reply",
      "duplicate",
      "exempt",
      "credited",
    ].includes(charge.state) &&
    key === chargeKey(charge.thread, charge.seq)
  );
}

/** Rebuild finance indexes and estimates after restoring support history. */
export async function reconcileManualCharges(
  storage: Storage,
  before: Map<string, Charge>,
  env: TemplStaffEnv,
) {
  const rows = await storage.list<Charge>({
    prefix: CHARGE_PREFIX,
    limit: 2001,
  });
  if (rows.size > 2000)
    throw new HttpError(
      409,
      "This workspace is too large for one recovery run.",
    );
  const pending = new Map<string, number>();
  if (![...rows.values()].some((charge) => charge?.collection === "manual")) {
    await reconcileManualEstimates(storage, pending);
    return;
  }
  const state = await readProductState(storage, Date.now(), env);
  const months = new Map<string, ChargeMonth>();
  const waiting: Charge[] = [];
  const allowance = (charge: Charge | undefined, sign: number) => {
    if (!charge) return;
    const slot = charge.slot;
    if (slot?.source === "free") state.freeStart.pending += sign;
    if (slot?.source === "grant") {
      const grant = state.grants.find((row) => row.id === slot.grantId);
      if (grant) grant.pending += sign;
    }
    if (charge.state !== "final") return;
    if (charge.source === "free") state.freeStart.used += sign;
    if (charge.source === "grant") {
      const grant = state.grants.find((row) => row.id === charge.grantId);
      if (grant) grant.used += sign;
    }
  };
  const monthAt = async (key: string) => {
    let month = months.get(key);
    if (!month) {
      month = await readMonth(storage, key);
      months.set(key, month);
    }
    return month;
  };
  const priceCount = async (charge: Charge | undefined, sign: number) => {
    if (charge?.dispute?.auto && charge.dispute.status === "credited") {
      const month = await monthAt(resolutionMonth(charge.dispute.at));
      month.autoCredits += sign;
      if (charge.handlingClass === "team-handled")
        month.teamHandledAutoCredits += sign;
      else month.aiOnlyAutoCredits += sign;
    }
    if (
      !charge?.month ||
      !["final", "credited"].includes(charge.state) ||
      !["manual", "free", "grant"].includes(charge.source ?? "")
    )
      return;
    const month = await monthAt(charge.month);
    if (charge.source === "free") month.free += sign;
    else if (charge.source === "grant") month.grant += sign;
    else {
      month.cases += sign;
      month.cents += sign * charge.priceCents;
      if (charge.handlingClass === "team-handled")
        month.teamHandledCases += sign;
      else month.aiOnlyCases += sign;
    }
  };
  for (const [key, value] of rows) {
    if (value?.collection !== "manual") continue;
    const charge = await readCharge(storage, value.thread, value.seq);
    if (!charge || key !== chargeKey(charge.thread, charge.seq))
      throw new HttpError(503, "The case price could not be checked.");
    if (recoveryManualCharge(key, charge)) {
      const previous = before.get(key);
      allowance(previous, -1);
      allowance(charge, 1);
      await priceCount(previous, -1);
      await priceCount(charge, 1);
      const workflowKey = `support-workflow-v1:${charge.thread}`;
      const workflow = await storage.get<{
        caseSeq?: number;
        caseSeqFloor?: number;
      }>(workflowKey);
      if (workflow) {
        if (
          workflow.caseSeqFloor !== undefined &&
          !natural(workflow.caseSeqFloor)
        )
          throw new HttpError(503, "The case price could not be checked.");
        if (charge.seq > (workflow.caseSeqFloor ?? 0)) {
          workflow.caseSeqFloor = charge.seq;
          await storage.put(workflowKey, workflow);
        }
      }
      await storage.put(
        `${REF_PREFIX}${charge.ref}`,
        chargeId(charge.thread, charge.seq),
      );
      await storage.put(
        `${LIST_PREFIX}${pad16(charge.firstResolvedAt)}:${charge.ref}`,
        true,
      );
      await storage.put(
        memberChargeKey(charge),
        chargeId(charge.thread, charge.seq),
      );
      if (charge.dispute?.status === "open")
        await storage.put(
          `${DISPUTE_PREFIX}${pad16(charge.dispute.at)}:${charge.ref}`,
          true,
        );
    } else if (
      await readCase(storage, {
        thread: charge.thread as CaseThreadId,
        seq: charge.seq,
      })
    ) {
      waiting.push(charge);
    }
  }
  for (const charge of waiting.sort(
    (a, b) =>
      b.resolvedAt - a.resolvedAt ||
      b.thread.localeCompare(a.thread) ||
      b.seq - a.seq,
  )) {
    const slot = charge.slot;
    const grant =
      slot?.source === "grant"
        ? state.grants.find((row) => row.id === slot.grantId)
        : null;
    if (
      slot &&
      ((slot.source === "free" &&
        state.freeStart.used + state.freeStart.pending >
          PRODUCT_FREE_START.resolvedCases) ||
        (grant && grant.used + grant.pending > grant.cases))
    ) {
      releaseSlot(state, slot);
      charge.slot = {
        source: "manual",
        reservedCents:
          charge.handlingClass === "team-handled"
            ? charge.table.usdCents
            : charge.table.aiOnlyUsdCents,
      };
    }
    pending.set(charge.ref, await saveCharge(storage, charge));
  }
  if (
    ![state.freeStart.used, state.freeStart.pending].every(natural) ||
    state.freeStart.used + state.freeStart.pending >
      PRODUCT_FREE_START.resolvedCases ||
    state.grants.some(
      (grant) =>
        ![grant.used, grant.pending].every(natural) ||
        grant.used + grant.pending > grant.cases,
    )
  )
    throw new HttpError(503, "The case price could not be checked.");
  for (const [key, month] of months) {
    if (
      ![
        month.cases,
        month.cents,
        month.teamHandledCases,
        month.aiOnlyCases,
        month.free,
        month.grant,
        month.autoCredits,
        month.teamHandledAutoCredits,
        month.aiOnlyAutoCredits,
      ].every(natural)
    )
      throw new HttpError(503, "The case price could not be checked.");
    await storage.put(`${CHARGE_MONTH_PREFIX}${key}`, month);
  }
  await storage.put(PRODUCT_STATE_KEY, state);
  await reconcileManualEstimates(storage, pending);
}

async function chargeByRef(storage: Pick<Storage, "get">, ref: string) {
  if (!REF.test(ref)) return null;
  const id = await storage.get<string>(`${REF_PREFIX}${ref}`);
  const match =
    typeof id === "string" ? /^(tc-[0-9a-f]{32}):(\d{8})$/.exec(id) : null;
  if (!match) return null;
  const charge = await readCharge(storage, match[1], Number(match[2]));
  return charge?.ref === ref ? charge : null;
}
/** Native final-case metadata found through the workspace's HMAC ref index. */
export async function finalChargeResolution(
  storage: Pick<Storage, "get">,
  ref: string,
): Promise<Pick<Charge, "closer" | "resolvedBy"> | null> {
  const charge = await chargeByRef(storage, ref);
  return charge && charge.finalAt !== null
    ? { closer: charge.closer, resolvedBy: charge.resolvedBy }
    : null;
}
function addEvent(
  charge: Charge,
  at: number,
  kind: ProductChargeEvent["kind"],
  kindOfActor: ProductChargeEvent["actor"]["kind"],
  principal?: string,
) {
  charge.events.push({
    at,
    kind,
    actor: { kind: kindOfActor, ...(principal ? { principal } : {}) },
  });
  if (charge.events.length > MAX_EVENTS)
    charge.events.splice(1, charge.events.length - MAX_EVENTS);
}
async function saveCharge(storage: Storage, charge: Charge) {
  if (charge.handlingClass === "ai-only" && charge.slot?.source === "free") {
    const current = await storage.get<ProductState>(PRODUCT_STATE_KEY);
    const state = await readProductState(
      storage,
      Math.max(current?.asOf ?? charge.resolvedAt, charge.resolvedAt),
    );
    releaseSlot(state, charge.slot);
    charge.slot = null;
    await storage.put(PRODUCT_STATE_KEY, state);
  }
  let manualEstimate = 0;
  if (
    charge.collection === "manual" &&
    ["pending", "confirmed"].includes(charge.state)
  ) {
    if (charge.slot?.source === "manual")
      manualEstimate = charge.slot.reservedCents;
    else if (charge.slot?.source === "grant" && charge.dueAt !== null) {
      const current = await storage.get<ProductState>(PRODUCT_STATE_KEY);
      const grantId = charge.slot.grantId;
      const grant = current?.grants.find((item) => item.id === grantId);
      if (!grant || grant.endsAt <= charge.dueAt)
        manualEstimate =
          charge.handlingClass === "ai-only"
            ? charge.table.aiOnlyUsdCents
            : charge.table.usdCents;
    }
  }
  await reserveManualEstimate(storage, charge.ref, manualEstimate);
  await storage.put(chargeKey(charge.thread, charge.seq), charge);
  return manualEstimate;
}
async function setDue(storage: Storage, charge: Charge, dueAt: number | null) {
  if (charge.dueAt !== null)
    await storage.delete(dueKey(charge.dueAt, charge.thread, charge.seq));
  charge.dueAt = dueAt;
  if (dueAt !== null) {
    await storage.put(dueKey(dueAt, charge.thread, charge.seq), true);
    await wakeRoomAt(storage, dueAt);
  }
}

/** Whether a test-account case opened at `at` is excluded: at most
 * `testCasesPer30Days` a rolling 30 days; later ones bill. */
async function testExclusionAllowed(storage: Storage, at: number) {
  let count = 0;
  for (let back = 0; back < 30; back++)
    count += (await readDay(storage, utcDay(at - back * DAY))).testExcluded;
  if (count >= PRODUCT_RESOLUTION_RULES.testCasesPer30Days) return false;
  await bumpDay(storage, at, (day) => {
    day.testExcluded++;
  });
  return true;
}
/** Whether an install-check preview opened at `at` is excluded: at most
 * `installPreviewsPer30Days` a rolling 30 days; later ones bill. */
async function installPreviewAllowed(storage: Storage, at: number) {
  let count = 0;
  for (let back = 0; back < 30; back++)
    count +=
      (await readDay(storage, utcDay(at - back * DAY))).installPreviews ?? 0;
  if (count >= FEATURE_LIMITS.installPreviewsPer30Days) return false;
  await bumpDay(storage, at, (day) => {
    day.installPreviews = (day.installPreviews ?? 0) + 1;
  });
  return true;
}

/** Keeps the duplicate index in step with accepted worker contributions. */
export async function syncCaseContributions(
  storage: Storage,
  c: SupportCase,
  at: number,
) {
  const charge = await readCharge(storage, c.thread, c.seq);
  if (!charge || !["pending", "confirmed"].includes(charge.state)) return;
  charge.contributions = contributionsAt(c, Math.min(at, charge.resolvedAt));
  const awaitingYes =
    needsManagedBillingProof(charge) &&
    charge.state === "pending" &&
    charge.dueAt === null;
  if (contributed(charge.contributions) && !awaitingYes)
    await storage.put(
      memberChargeKey(charge),
      chargeId(charge.thread, charge.seq),
    );
  else await deleteMemberIndex(storage, charge);
  await saveCharge(storage, charge);
}

/** Everything a case event means for billing. `applyCaseEvent` calls it
 * after it saved the case, inside the same transaction; it saves the case
 * again when it changes the case's billing fields. */
export async function chargeCaseEvent(
  storage: Storage,
  record: ChargeRecord,
  c: SupportCase | null,
  event: CaseEvent,
  flags: { opened: boolean; reopened: boolean; closed: boolean },
  saveCase: (c: SupportCase) => Promise<void>,
  env: TemplStaffEnv = {},
) {
  if (!c) return;
  if (!(await storage.get(PRODUCT_STATE_KEY))) return;
  const at = event.at;
  await syncCaseContributions(storage, c, at);
  if (event.kind === "member-message") {
    if (flags.opened) {
      // The exclusion is fixed now and never refreshed.
      let exclusion = event.exclusion;
      if (
        exclusion === "test-account" &&
        !(await testExclusionAllowed(storage, at))
      )
        exclusion = null;
      if (
        exclusion === "install-preview" &&
        !(await installPreviewAllowed(storage, at))
      ) {
        exclusion = null;
        c.excluded = c.excluded.filter((entry) => entry !== "install-preview");
      }
      c.billingExclusion = exclusion;
      c.billingReplies = 0;
      await saveCase(c);
    } else
      // Any member message on the case voids a pending or confirmed
      // charge, whether it reopened the case or the team already had.
      await voidCharge(storage, c.thread, c.seq, { at, by: "member" }, env);
    return;
  }
  if (event.kind === "team-reply") {
    if (
      c.resolvedAt !== null ||
      c.billingExclusion === undefined ||
      (event.bot && !event.aiAnswer)
    )
      return;
    c.billingReplies = (c.billingReplies ?? 0) + 1;
    if (event.bot && event.aiAnswer && event.managed)
      c.billingManagedReplyAt ??= at;
    await saveCase(c);
    return;
  }
  if (event.kind === "status") {
    if (event.state === "spam") {
      await spamCharge(storage, c.thread, c.seq, at, env);
      return;
    }
    if (event.state === "resolved" && c.resolvedAt === at) {
      const closer: ProductChargeCloser =
        event.by === "member"
          ? "member"
          : event.by === "person"
            ? "person"
            : event.actor &&
                event.actor === (await managedPrincipal(record.room))
              ? "managed"
              : "bot";
      await resolveCharge(
        storage,
        record,
        c,
        {
          at,
          closer,
          resolvedBy: event.by === "member" ? "member" : "team",
          principal:
            event.actor ?? (event.by === "member" ? record.member : undefined),
        },
        env,
      );
      return;
    }
    if (flags.reopened)
      await voidCharge(
        storage,
        c.thread,
        c.seq,
        {
          at,
          by: event.by === "member" ? "member" : "team",
        },
        env,
      );
    return;
  }
  if (event.kind === "confirm") {
    if (event.answer === "solved")
      await memberSolved(storage, record, c, at, env);
    else await voidCharge(storage, c.thread, c.seq, { at, by: "member" }, env);
  }
}
/** A resolution event on a case: creates or revives its charge. */
async function resolveCharge(
  storage: Storage,
  record: ChargeRecord,
  c: SupportCase,
  input: {
    at: number;
    closer: ProductChargeCloser;
    resolvedBy: ProductChargeResolvedBy;
    principal?: string;
  },
  env: TemplStaffEnv = {},
) {
  // A case opened before the billing snapshot existed never bills.
  if (c.billingExclusion === undefined) return;
  const member = await memberIdentity(storage, record);
  const existing = await readCharge(storage, c.thread, c.seq);
  if (
    existing &&
    [
      "pending",
      "confirmed",
      "final",
      "not-billable",
      "credited",
      "exempt",
    ].includes(existing.state)
  ) {
    // A member confirming a team resolve moves it to confirmed.
    if (existing.state === "pending" && input.resolvedBy === "member")
      await confirmCharge(storage, existing, input.at, input.principal);
    return;
  }
  const state = await readProductState(storage, input.at, env);
  if (!existing && (standardPlanForState(state) ||
      (await storage.get(STANDARD_CASE_PREFIX + await chargeRef(storage, c.thread, c.seq))) !== undefined)) return;
  const charge: Charge = existing ?? {
    schema: 1,
    ref: await chargeRef(storage, c.thread, c.seq),
    thread: c.thread,
    seq: c.seq,
    member,
    state: "pending",
    reason: null,
    resolvedBy: input.resolvedBy,
    closer: input.closer,
    handlingClass: c.counts.humanReplies > 0 ? "team-handled" : "ai-only",
    managedAi:
      input.closer === "managed" ||
      (natural(c.billingManagedReplyAt) && c.billingManagedReplyAt <= input.at),
    openedAt: c.openedAt,
    firstResolvedAt: input.at,
    resolvedAt: input.at,
    dueAt: null,
    finalAt: null,
    slot: null,
    source: null,
    grantId: null,
    priceCents: 0,
    month: null,
    priceVersion: state.priceVersion,
    table: state.prices.table,
    rulesVersion: PRODUCT_RULES_VERSION,
    duplicateOf: null,
    dispute: null,
    events: [],
  };
  charge.member = member;
  charge.resolvedAt = input.at;
  charge.resolvedBy = input.resolvedBy;
  charge.closer = input.closer;
  charge.handlingClass = c.counts.humanReplies > 0 ? "team-handled" : "ai-only";
  charge.managedAi =
    input.closer === "managed" ||
    (natural(c.billingManagedReplyAt) && c.billingManagedReplyAt <= input.at);
  charge.reason = null;
  charge.contributions = contributionsAt(c, input.at);
  charge.duplicateOf = null;
  addEvent(
    charge,
    input.at,
    input.resolvedBy === "member" ? "confirmed" : "resolved",
    input.resolvedBy === "member" ? "member" : "team",
    input.principal,
  );
  if (!existing) {
    await storage.put(`${REF_PREFIX}${charge.ref}`, chargeId(c.thread, c.seq));
    await storage.put(`${LIST_PREFIX}${pad16(input.at)}:${charge.ref}`, true);
  }
  const month = (change: (m: ChargeMonth) => void) =>
    bumpMonth(storage, input.at, change);
  if (c.billingExclusion !== null) {
    charge.state = "excluded";
    charge.reason = c.billingExclusion;
    await month((m) => m.excluded++);
  } else if ((c.billingReplies ?? 0) === 0) {
    charge.state = "no-reply";
    await month((m) => m.noReply++);
  } else if (productMode(state) === "exempt") {
    charge.state = "exempt";
    charge.source = "exempt";
    await month((m) => {
      m.exempt++;
      m.byCloser[input.closer]++;
    });
  } else {
    const duplicateOf = contributed(charge.contributions)
      ? await findDuplicate(storage, charge, input.at)
      : null;
    if (duplicateOf) {
      charge.state = "duplicate";
      charge.duplicateOf = duplicateOf;
      await month((m) => m.duplicate++);
    } else {
      charge.state = input.resolvedBy === "member" ? "confirmed" : "pending";
      charge.priceVersion = state.priceVersion;
      charge.table = { ...state.prices.table };
      const usageAgreement =
        (await activeProductOrderForm(storage, input.at))?.usage !== undefined;
      const manual =
        usageAgreement || (await featureOn(env, storage, "manualBilling"));
      const mayCapture = !existing || existing.collection === "manual";
      const agreement =
        manual && mayCapture ? await manualAgreement(storage, state) : null;
      charge.collection =
        existing?.collection === "off"
          ? "off"
          : manual
            ? agreement
              ? "manual"
              : "off"
            : productOptions(env).billing
              ? undefined
              : "off";
      charge.manualAgreement = agreement ?? undefined;
      const awaitingYes =
        needsManagedBillingProof(charge) && input.resolvedBy === "team";
      charge.slot =
        (charge.collection === "manual" ||
          (charge.collection !== "off" && productOptions(env).billing)) &&
        contributed(charge.contributions) &&
        !awaitingYes &&
        (!needsManagedBillingProof(charge) ||
          (await managedResolutionBillingOn(env, storage)))
          ? reserveChargeSlot(state, charge)
          : null;
      await storage.put(PRODUCT_STATE_KEY, state);
      await setDue(
        storage,
        charge,
        awaitingYes
          ? null
          : chargeFinalDueAt(
              input.resolvedBy === "member" ? "member" : "team",
              input.at,
            ),
      );
      if (contributed(charge.contributions) && !awaitingYes)
        await storage.put(memberChargeKey(charge), chargeId(c.thread, c.seq));
      const day = await bumpDay(storage, input.at, (d) => {
        d.opened++;
      });
      await checkBurst(storage, day, input.at, env);
      if (
        await recordProductEvent(storage, "first-resolution", {
          action: "charge.first-resolution",
          at: input.at,
        })
      )
        await markWorkspaceStep(storage, "first_resolution", input.at);
    }
  }
  await saveCharge(storage, charge);
}

function needsManagedBillingProof(charge: Charge) {
  return (
    charge.closer === "managed" ||
    (charge.handlingClass === "ai-only" && charge.managedAi)
  );
}

function reserveChargeSlot(state: ProductState, charge: Charge) {
  const teamHandled = charge.handlingClass === "team-handled";
  return reserveSlot(
    state,
    teamHandled ? charge.table.usdCents : charge.table.aiOnlyUsdCents,
    teamHandled,
    charge.collection === "manual" ? "manual" : "balance",
  );
}

function chargePriceCents(charge: Charge, totals: ChargeMonth) {
  return charge.handlingClass === "ai-only"
    ? charge.table.aiOnlyUsdCents
    : priceTableCents(charge.table, totals.teamHandledCases);
}

/** Finds another eligible charge for this member in the duplicate window.
 * A settled charge wins even when a step qualified an earlier case later. */
async function findDuplicate(
  storage: Pick<Storage, "get" | "list">,
  charge: Charge,
  at: number,
  finalizing = false,
) {
  const hash = await billingIdentity(storage, charge.member);
  const prefix = `${MEMBER_PREFIX}${hash}:`;
  let start = `${prefix}${pad16(at - PRODUCT_RESOLUTION_RULES.duplicateHours * HOUR)}`;
  for (;;) {
    const rows = await storage.list<string>({
      prefix,
      start,
      end: `${prefix}${pad16(at + (finalizing ? PRODUCT_RESOLUTION_RULES.duplicateHours * HOUR : 0) + 1)}`,
      limit: 100,
    });
    for (const id of rows.values()) {
      const match = /^(tc-[0-9a-f]{32}):(\d{8})$/.exec(id);
      if (!match) continue;
      if (match[1] === charge.thread && Number(match[2]) === charge.seq)
        continue;
      const other = await readCharge(storage, match[1], Number(match[2]));
      if (
        other &&
        contributed(other.contributions) &&
        ["pending", "confirmed", "final"].includes(other.state) &&
        (!finalizing ||
          other.state === "final" ||
          other.resolvedAt < charge.resolvedAt ||
          (other.resolvedAt === charge.resolvedAt && other.ref < charge.ref))
      )
        return other.ref;
    }
    if (rows.size < 100) return null;
    start = [...rows.keys()].at(-1)! + "\0";
  }
}

async function checkBurst(
  storage: Storage,
  day: ChargeDay,
  at: number,
  env: TemplStaffEnv = {},
) {
  if (day.burst) return;
  let total = 0;
  for (let back = 1; back <= 30; back++)
    total += (await readDay(storage, utcDay(at - back * DAY))).opened;
  if (!chargeBurst(day.opened, total / 30)) return;
  await bumpDay(storage, at, (d) => {
    d.burst = true;
  });
  await recordProductEvent(storage, `burst:${utcDay(at)}`, {
    action: "charge.burst",
    at,
    cases: day.opened,
  });
  await emitBalanceAlerts(storage, null, at, { burst: true }, env);
}

/** Pending to confirmed: the member's Yes after a team resolve. */
async function confirmCharge(
  storage: Storage,
  charge: Charge,
  at: number,
  principal?: string,
) {
  charge.state = "confirmed";
  const read = await readCase(storage, {
    thread: charge.thread as CaseThreadId,
    seq: charge.seq,
  });
  charge.contributions = read
    ? contributionsAt(read.case, charge.resolvedAt)
    : {};
  if (contributed(charge.contributions))
    await storage.put(
      memberChargeKey(charge),
      chargeId(charge.thread, charge.seq),
    );
  charge.resolvedBy = "member";
  addEvent(charge, at, "confirmed", "member", principal);
  await setDue(storage, charge, chargeFinalDueAt("member", at));
  await saveCharge(storage, charge);
}

/** The member said it's solved: a pending charge is confirmed, a charge
 * the member's own message voided comes back as confirmed (the same row),
 * and a case with no charge yet is resolved by the member. */
async function memberSolved(
  storage: Storage,
  record: ChargeRecord,
  c: SupportCase,
  at: number,
  env: TemplStaffEnv = {},
) {
  const charge = await readCharge(storage, c.thread, c.seq);
  if (charge?.state === "pending")
    return confirmCharge(storage, charge, at, record.member);
  if (!charge || charge.state === "voided")
    return resolveCharge(
      storage,
      record,
      c,
      {
        at,
        closer: charge?.closer ?? "member",
        resolvedBy: "member",
        principal: record.member,
      },
      env,
    );
}

/** Voids a charge. The team voids only a pending charge; the member voids
 * pending and confirmed. A final charge never changes here. */
export async function voidCharge(
  storage: Storage,
  thread: string,
  seq: number,
  input: { at: number; by: "member" | "team" },
  env: TemplStaffEnv = {},
) {
  const charge = await readCharge(storage, thread, seq);
  if (!charge) return;
  if (
    !(
      charge.state === "pending" ||
      (charge.state === "confirmed" && input.by === "member")
    )
  )
    return;
  await dropReservation(storage, charge, input.at, env);
  charge.state = "voided";
  addEvent(charge, input.at, "reopened", input.by);
  await saveCharge(storage, charge);
  await bumpMonth(storage, input.at, (m) => {
    m.voided++;
    if (input.by === "team") m.teamReopened++;
  });
}
/** Marked spam before final: excluded, never billed. */
export async function spamCharge(
  storage: Storage,
  thread: string,
  seq: number,
  at: number,
  env: TemplStaffEnv = {},
) {
  const charge = await readCharge(storage, thread, seq);
  if (!charge || !(charge.state === "pending" || charge.state === "confirmed"))
    return;
  const confirmed = charge.state === "confirmed";
  await dropReservation(storage, charge, at, env);
  charge.state = "excluded";
  charge.reason = "spam";
  addEvent(charge, at, "excluded", "team");
  await saveCharge(storage, charge);
  await bumpMonth(storage, at, (m) => {
    m.excluded++;
    if (confirmed) m.spamOnConfirmed++;
  });
}
async function dropReservation(
  storage: Storage,
  charge: Charge,
  at: number,
  env: TemplStaffEnv = {},
) {
  if (charge.slot) {
    const state = await readProductState(storage, at, env);
    releaseSlot(state, charge.slot);
    await storage.put(PRODUCT_STATE_KEY, state);
    charge.slot = null;
  }
  await setDue(storage, charge, null);
  await deleteMemberIndex(storage, charge);
}

/** Settles due charges: at most FINALIZE_BATCH per run. Returns when the
 * next one falls due, or null. The room alarm consumer
 * `product-charge-finalize` runs it in one transaction. */
export async function finalizeDueCharges(
  storage: Storage,
  env: Partial<Env> & { PRODUCT_RESOLUTION_BILLING_ENABLED?: string },
  now: number,
): Promise<number | null> {
  if (!(await storage.get(PRODUCT_STATE_KEY))) return null;
  const options: ProductOptions = productOptions(env);
  const due = await storage.list<boolean>({
    prefix: CHARGE_DUE_PREFIX,
    end: `${CHARGE_DUE_PREFIX}${pad16(now + 1)}`,
    limit: FINALIZE_BATCH,
  });
  for (const key of due.keys()) {
    const match = /(tc-[0-9a-f]{32}):(\d{8})$/.exec(key);
    if (!match) continue;
    const record = await storage.get<ChargeRecord>(
      `conversation-v1:${match[1]}`,
    );
    if (record?.member) await memberIdentity(storage, record, env);
  }
  let state: ProductState | null = null;
  let debited = false;
  for (const key of due.keys()) {
    const match =
      /^product-charge-due-v1:(\d{16}):(tc-[0-9a-f]{32}):(\d{8})$/.exec(key);
    await storage.delete(key);
    if (!match) continue;
    const charge = await readCharge(storage, match[2], Number(match[3]));
    if (
      !charge ||
      !(charge.state === "pending" || charge.state === "confirmed")
    )
      continue;
    if (charge.dueAt !== Number(match[1])) continue;
    state ??= await readProductState(storage, now, env);

    const read = await readCase(storage, {
      thread: charge.thread as CaseThreadId,
      seq: charge.seq,
    });
    charge.contributions = read
      ? contributionsAt(read.case, charge.resolvedAt)
      : {};
    if (!contributed(charge.contributions)) {
      if (charge.slot) releaseSlot(state, charge.slot);
      charge.slot = null;
      charge.finalAt = charge.dueAt;
      charge.month = resolutionMonth(charge.finalAt!);
      charge.dueAt = null;
      charge.state = "not-billable";
      charge.reason = "no Templ contribution";
      charge.source = null;
      charge.priceCents = 0;
      addEvent(charge, charge.finalAt!, "final", "system");
      await deleteMemberIndex(storage, charge);
      await bumpMonth(storage, charge.finalAt!, (month) => {
        month.noContribution++;
        month.byCloser[charge.closer]++;
      });
      await noteStatementRow(storage, state, `case-price:${charge.ref}`, {
        kind: "case-price",
        ref: charge.ref,
        priceCents: 0,
        priceVersion: charge.priceVersion,
        contributions: charge.contributions,
        billingReason: "no Templ contribution",
      });
      await saveCharge(storage, charge);
      continue;
    }
    const manual = charge.collection === "manual";
    const billing =
      (manual
        ? await featureOn(env, storage, "manualBilling")
        : charge.collection !== "off" && options.billing) &&
      (!needsManagedBillingProof(charge) ||
        (await managedResolutionBillingOn(env, storage)));
    if (charge.handlingClass === "ai-only" && charge.slot?.source === "free") {
      releaseSlot(state, charge.slot);
      charge.slot = null;
    }
    if (!charge.slot && billing) charge.slot = reserveChargeSlot(state, charge);
    const duplicateOf = await findDuplicate(
      storage,
      charge,
      charge.resolvedAt,
      true,
    );
    if (duplicateOf) {
      if (charge.slot) releaseSlot(state, charge.slot);
      charge.slot = null;
      charge.dueAt = null;
      charge.state = "duplicate";
      charge.duplicateOf = duplicateOf;
      await deleteMemberIndex(storage, charge);
      await bumpMonth(storage, now, (month) => month.duplicate++);
      await saveCharge(storage, charge);
      continue;
    }
    await storage.put(
      memberChargeKey(charge),
      chargeId(charge.thread, charge.seq),
    );
    const finalAt = charge.dueAt;
    const month = resolutionMonth(finalAt);
    const totals = await readMonth(storage, month);
    charge.dueAt = null;
    charge.finalAt = finalAt;
    charge.month = month;
    charge.state = "final";
    addEvent(charge, finalAt, "final", "system");
    const slot = charge.slot;
    charge.slot = null;
    if (!billing || !slot) {
      if (slot) releaseSlot(state, slot);
      charge.source = "off";
      charge.priceCents = 0;
      totals.off++;
    } else {
      const pilot = manual
        ? null
        : await pilotChargeAt(
            storage,
            finalAt,
            chargePriceCents(charge, totals),
          );
      const card =
        manual || pilot ? null : await stripeCoverageAt(storage, finalAt);
      if (card && !cardBillingEnabled(env as never))
        throw new HttpError(503, "Card billing is not available.");
      const currentCoverage = state.cardCoverage;
      state.cardCoverage = card !== null;
      const settled = settleSlot(
        state,
        slot,
        () => pilot?.priceCents ?? chargePriceCents(charge, totals),
        manual ? "manual" : "balance",
      );
      state.cardCoverage = currentCoverage;
      charge.source = settled.source;
      charge.priceCents = settled.priceCents;
      charge.grantId = settled.grantId ?? null;
      if (pilot) {
        charge.pilot = await settlePilotCharge(
          storage,
          pilot.form,
          month,
          settled.priceCents,
          pilot.activation,
        );
        if (settled.source === "balance") charge.reason = pilot.reason;
      }
      await noteStatementRow(storage, state, `case-price:${charge.ref}`, {
        kind: "case-price",
        ref: charge.ref,
        priceCents: settled.priceCents,
        priceVersion: charge.priceVersion,
        contributions: charge.contributions,
        ...(charge.pilot
          ? {
              pilot: {
                id: charge.pilot.id,
                title: charge.pilot.title,
                revision: charge.pilot.revision,
                upfrontCreditCents: charge.pilot.upfrontCreditCents,
              },
              ...(charge.reason === "monthly cap" ||
              charge.reason === "pilot cap"
                ? { capReason: charge.reason }
                : {}),
            }
          : {}),
      });
      if (charge.pilot?.upfrontCreditCents)
        await noteStatementRow(storage, state, `pilot-credit:${charge.ref}`, {
          kind: "pilot-credit",
          ref: charge.ref,
          cents: charge.pilot.upfrontCreditCents,
          pilot: {
            id: charge.pilot.id,
            title: charge.pilot.title,
            revision: charge.pilot.revision,
          },
        });
      if (settled.source === "free") totals.free++;
      else if (settled.source === "grant") totals.grant++;
      else if (settled.source === "manual") {
        totals.cases++;
        if (charge.handlingClass === "team-handled") totals.teamHandledCases++;
        else totals.aiOnlyCases++;
        totals.cents += settled.priceCents;
        await recordManualRow(storage, {
          kind: "charge",
          ref: charge.ref,
          at: now,
          cents: settled.priceCents,
          agreement: charge.manualAgreement!,
          priceVersion: charge.priceVersion,
          table: charge.table,
        });
        await noteManualClosing(storage, now);
      } else if (settled.source === "card") {
        totals.cases++;
        if (charge.handlingClass === "team-handled") totals.teamHandledCases++;
        else totals.aiOnlyCases++;
        totals.cents += settled.priceCents;
        totals.cardCases++;
        totals.cardCents += settled.priceCents;
        if (!card?.subscriptionId)
          throw new HttpError(503, "Card billing is not available.");
        charge.stripeSubscriptionId = card.subscriptionId;
        await queueStripeUsage(
          storage,
          {
            kind: "report",
            subscriptionId: card.subscriptionId,
            room: state.room,
            ref: charge.ref,
            finalAt,
            cents: settled.priceCents,
            contributions: charge.contributions,
          },
          now,
        );
      } else {
        totals.cases++;
        if (charge.handlingClass === "team-handled") totals.teamHandledCases++;
        else totals.aiOnlyCases++;
        totals.cents += settled.priceCents;
        debited = true;
        await noteStatementRow(storage, state, `charge:${charge.ref}`, {
          kind: "charge",
          ref: charge.ref,
          priceCents: settled.priceCents,
        });
        await drawTopUps(
          storage,
          settled.priceCents - (charge.pilot?.upfrontCreditCents ?? 0),
        );
        await bumpDay(storage, finalAt, (d) => {
          d.debitedCents += settled.priceCents;
        });
      }
      if (
        settled.source === "free" &&
        state.freeStart.used >= PRODUCT_FREE_START.resolvedCases &&
        (await recordProductEvent(storage, "free-start-used", {
          action: "free-start.used",
          at: finalAt,
        }))
      ) {
        await markWorkspaceStep(storage, "free_start_used", finalAt);
        await emitBalanceAlerts(storage, state, now, { freeStartUsed: true });
      }
    }
    if (charge.resolvedBy === "member") totals.memberConfirmed++;
    totals.byCloser[charge.closer]++;
    await bumpDay(storage, finalAt, (d) => {
      d.final++;
      if (charge.handlingClass === "team-handled") d.teamHandledFinal++;
      else d.aiOnlyFinal++;
    });
    await storage.put(`${CHARGE_MONTH_PREFIX}${month}`, totals);
    await saveCharge(storage, charge);
  }
  if (state) {
    await storage.put(PRODUCT_STATE_KEY, state);
    if (debited) await noteMonthBalance(storage, state);
    if (debited) {
      if (state.balanceCents <= 0)
        await recordProductEvent(storage, "balance-empty", {
          action: "balance.empty",
          at: now,
        }).then(
          (first) => first && markWorkspaceStep(storage, "balance_empty", now),
        );
      await emitBalanceAlerts(storage, state, now, {});
    }
  }
  await pruneCharges(storage, now);
  const next = await storage.list({ prefix: CHARGE_DUE_PREFIX, limit: 1 });
  const first = [...next.keys()][0];
  return first
    ? Number(
        first.slice(CHARGE_DUE_PREFIX.length, CHARGE_DUE_PREFIX.length + 16),
      )
    : null;
}

/** Once a day, drops settled charges and statement rows past the
 * retention with their index rows; month totals and month balances stay.
 * Bounded; the next day continues. */
async function pruneCharges(storage: Storage, now: number) {
  const last = await storage.get<number>(PRUNED_KEY);
  if (natural(last) && now - last < DAY) return;
  await storage.put(PRUNED_KEY, now);
  const cutoff = now - RETENTION_MS;
  await pruneManualRows(storage, resolutionMonth(cutoff));
  for (let batch = 0; batch < 4; batch++) {
    const statement = await storage.list({
      prefix: STATEMENT_PREFIX,
      end: `${STATEMENT_PREFIX}${resolutionMonth(cutoff)}`,
      limit: 128,
    });
    if (!statement.size) break;
    await storage.delete([...statement.keys()]);
  }
  const rows = await storage.list<boolean>({
    prefix: LIST_PREFIX,
    end: `${LIST_PREFIX}${pad16(cutoff)}`,
    limit: 100,
  });
  for (const key of rows.keys()) {
    const ref = key.slice(-16);
    const charge = await chargeByRef(storage, ref);
    if (charge && (charge.state === "pending" || charge.state === "confirmed"))
      continue;
    if (charge && charge.dispute?.status === "open") continue;
    if (charge) {
      await deleteMemberIndex(storage, charge);
      await storage.delete(chargeKey(charge.thread, charge.seq));
      if (charge.dispute)
        await storage.delete(
          `${DISPUTE_PREFIX}${pad16(charge.dispute.at)}:${ref}`,
        );
    }
    await forgetManualCase(storage, ref);
    await storage.delete([key, `${REF_PREFIX}${ref}`]);
  }
}

/** What staff without billing see on a case. */
export async function caseBilling(
  storage: Pick<Storage, "get">,
  thread: string,
  seq: number,
): Promise<ProductCaseBilling | null> {
  const charge = await readCharge(storage, thread, seq);
  if (!charge) return null;
  const read = await readCase(storage, { thread: thread as CaseThreadId, seq });
  const steps =
    ["pending", "confirmed"].includes(charge.state) && read
      ? contributionsAt(read.case, charge.resolvedAt)
      : charge.contributions;
  const by = {
    ...(needsManagedBillingProof(charge) ? { templAi: true as const } : {}),
    ...(needsManagedBillingProof(charge) &&
    charge.state === "pending" &&
    charge.dueAt === null
      ? { awaitingMemberYes: true as const }
      : {}),
    ...(steps ? { contributions: steps } : {}),
  };
  switch (charge.state) {
    case "pending":
    case "confirmed":
      return { status: "pending", ...by };
    case "final":
      return charge.priceCents > 0 &&
        (charge.source === "balance" ||
          charge.source === "card" ||
          charge.source === "manual")
        ? { status: "billed", ...by }
        : { status: "free", ...by };
    case "not-billable":
      return { status: "not-billed", reason: "no Templ contribution", ...by };
    case "excluded":
      return { status: "not-billed", reason: charge.reason ?? "spam", ...by };
    default:
      return { status: "not-billed", reason: charge.state, ...by };
  }
}

/** A billing manager's view of one charge; `thread` only when `canRead`
 * says the viewer can read that thread now. */
export async function chargeView(
  storage: Pick<Storage, "get" | "list">,
  charge: Charge,
  canRead: (thread: string) => Promise<boolean>,
): Promise<ProductChargeView> {
  const readable = await canRead(charge.thread);
  const disputeUntil =
    charge.state === "final" && charge.finalAt !== null
      ? chargeDisputeUntil(charge.finalAt)
      : null;
  return {
    ref: charge.ref,
    state: charge.state,
    reason: charge.reason,
    contributions: charge.contributions,
    resolvedBy: charge.resolvedBy,
    closer: charge.closer,
    handlingClass: charge.handlingClass,
    openedAt: iso(charge.openedAt),
    resolvedAt: iso(charge.resolvedAt),
    finalDueAt: charge.dueAt === null ? null : iso(charge.dueAt),
    finalAt: charge.finalAt === null ? null : iso(charge.finalAt),
    source: charge.source,
    priceCents: charge.priceCents,
    priceSource: productPriceSource(charge.priceVersion)!,
    ...(charge.pilot
      ? {
          pilot: {
            id: charge.pilot.id,
            title: charge.pilot.title,
            revision: charge.pilot.revision,
            upfrontCreditCents: charge.pilot.upfrontCreditCents,
          },
        }
      : {}),
    disputeUntil: disputeUntil === null ? null : iso(disputeUntil),
    dispute: charge.dispute
      ? {
          reason: charge.dispute.reason,
          status: charge.dispute.status,
          at: iso(charge.dispute.at),
          replyWithinBusinessDays:
            charge.dispute.status === "open"
              ? DISPUTE_REPLY_BUSINESS_DAYS
              : null,
        }
      : null,
    possibleRepeat: await possibleRepeat(storage, charge),
    events: charge.events.map((event) => ({
      at: iso(event.at),
      kind: event.kind,
      actor: readable ? event.actor : { kind: event.actor.kind },
    })),
    added: await caseAdded(storage, charge.thread, charge.seq),
    ...(readable ? { thread: charge.thread } : {}),
  };
}
/** A thread's charges, oldest case first, as the manager's workspace export
 * lists them: the charge view with its event history, never message text
 * or a note. At most 100 per thread. */
export async function threadCharges(
  storage: Pick<Storage, "get" | "list">,
  thread: string,
): Promise<ProductChargeView[]> {
  const rows = await storage.list<unknown>({
    prefix: `${CHARGE_PREFIX}${thread}:`,
    limit: 100,
  });
  const views: ProductChargeView[] = [];
  for (const [key, value] of rows) {
    const charge = await checkedCharge(
      storage,
      value,
      thread,
      Number(key.slice(-8)),
    );
    if (charge) views.push(await chargeView(storage, charge, async () => true));
  }
  return views;
}
/** A final charge is a possible repeat when the same member's next charge
 * came within 14 days of it. */
async function possibleRepeat(storage: Pick<Storage, "list">, charge: Charge) {
  if (charge.state !== "final" || charge.finalAt === null) return false;
  const rows = await storage.list<string>({
    prefix: `${MEMBER_PREFIX}${charge.member}:`,
    start: `${MEMBER_PREFIX}${charge.member}:${pad16(charge.resolvedAt + 1)}`,
    end: `${MEMBER_PREFIX}${charge.member}:${pad16(charge.finalAt + REPEAT_DAYS * DAY)}`,
    limit: 1,
  });
  return rows.size > 0;
}

/** One page of charges, newest first, 50 at most. `cursor` is the last
 * row's list key suffix from the previous page. */
export async function listCharges(
  storage: Pick<Storage, "get" | "list">,
  input: {
    cursor: string | null;
    state: ProductChargeState | "billing-soon" | null;
    limit?: number;
    canRead: (thread: string) => Promise<boolean>;
  },
) {
  const limit = Math.min(50, input.limit ?? 50);
  const out: ProductChargeView[] = [];
  let cursor = input.cursor;
  let next: string | null = null;
  for (let scanned = 0; scanned < 1_000 && out.length < limit; ) {
    const rows = await storage.list<boolean>({
      prefix: LIST_PREFIX,
      reverse: true,
      limit: 100,
      ...(cursor ? { end: `${LIST_PREFIX}${cursor}` } : {}),
    });
    if (!rows.size) {
      next = null;
      break;
    }
    for (const key of rows.keys()) {
      scanned++;
      cursor = key.slice(LIST_PREFIX.length);
      const charge = await chargeByRef(storage, key.slice(-16));
      if (!charge) continue;
      if (
        input.state === "billing-soon"
          ? !(charge.state === "pending" || charge.state === "confirmed")
          : input.state !== null && charge.state !== input.state
      )
        continue;
      out.push(await chargeView(storage, charge, input.canRead));
      if (out.length >= limit) break;
    }
    next = cursor;
    if (rows.size < 100) {
      if (out.length < limit) next = null;
      break;
    }
  }
  // Templ AI resolves the member hasn't confirmed come first in Billing soon.
  if (input.state === "billing-soon")
    out.sort(
      (a, b) =>
        Number(b.closer === "managed" && b.state === "pending") -
        Number(a.closer === "managed" && a.state === "pending"),
    );
  return { charges: out, next };
}

/** The month's totals as the Plan tab shows them. */
export async function monthView(
  storage: Pick<Storage, "get">,
  now: number,
): Promise<ProductMonthView> {
  const id = resolutionMonth(now);
  const m = await readMonth(storage, id);
  return {
    id,
    cases: m.cases,
    teamHandledCases: m.teamHandledCases,
    aiOnlyCases: m.aiOnlyCases,
    cents: m.cents,
    free: m.free,
    grant: m.grant,
    exempt: m.exempt,
    voided: m.voided,
    excluded: m.excluded,
    noReply: m.noReply,
    noContribution: m.noContribution,
    duplicate: m.duplicate,
    memberConfirmed: m.memberConfirmed,
    byCloser: { ...m.byCloser },
  };
}
export async function readChargeMonth(
  storage: Pick<Storage, "get">,
  month: string,
) {
  return readMonth(storage, month);
}
/** Debited cents in the last `days` UTC days, for the runway forecast. */
export async function recentDebits(
  storage: Pick<Storage, "get">,
  now: number,
  days: number,
) {
  let cents = 0;
  for (let back = 0; back < days; back++)
    cents += (await readDay(storage, utcDay(now - back * DAY))).debitedCents;
  return cents;
}
/** Pending and confirmed charges waiting to go final, up to 1,000. */
export async function billingSoonCount(storage: Pick<Storage, "list">) {
  return (await storage.list({ prefix: CHARGE_DUE_PREFIX, limit: 1_000 })).size;
}

/** A billing manager disputes a final charge within `disputeDays`. Credited
 * at once while the month's automatic credits are under the allowance;
 * otherwise it waits for the operator. `corpusRow` names the case's
 * de-identified row for that review. */
export async function disputeCharge(
  storage: Storage,
  input: {
    ref: string;
    reason: unknown;
    text: unknown;
    nowMs: number;
    env?: TemplStaffEnv;
    corpusRow: (at: {
      thread: string;
      seq: number;
    }) => Promise<{ workspace: string; ref: string } | null>;
  },
) {
  if (!PRODUCT_DISPUTE_REASONS.includes(input.reason as ProductDisputeReason))
    throw new HttpError(400, "Choose why this charge is wrong.");
  if (
    input.text !== undefined &&
    input.text !== null &&
    (typeof input.text !== "string" ||
      input.text.length > PRODUCT_DISPUTE_TEXT_MAX)
  )
    throw new HttpError(
      400,
      `Keep the note under ${PRODUCT_DISPUTE_TEXT_MAX + 1} characters.`,
    );
  const charge = await chargeByRef(storage, input.ref);
  if (!charge) throw new HttpError(404, "That charge isn't in this workspace.");
  if (charge.state !== "final" || charge.finalAt === null)
    throw new HttpError(
      409,
      "Only a final charge can be disputed.",
      undefined,
      "charge-not-final",
    );
  if (charge.dispute)
    throw new HttpError(
      409,
      "This charge is already disputed.",
      undefined,
      "charge-disputed",
    );
  if (input.nowMs > chargeDisputeUntil(charge.finalAt))
    throw new HttpError(
      409,
      "The time to dispute this charge has passed.",
      undefined,
      "dispute-closed",
    );
  const text =
    typeof input.text === "string" && input.text.trim()
      ? input.text.trim()
      : null;
  const corpus = await input.corpusRow({
    thread: charge.thread,
    seq: charge.seq,
  });
  const auto = await takeAutomaticDisputeCredit(
    storage,
    input.nowMs,
    charge.handlingClass,
  );
  charge.dispute = {
    reason: input.reason as ProductDisputeReason,
    text,
    status: auto ? "credited" : "open",
    at: input.nowMs,
    auto,
    corpus: corpus ? { workspace: corpus.workspace, ref: corpus.ref } : null,
  };
  addEvent(charge, input.nowMs, "disputed", "team");
  if (auto) {
    await creditCharge(storage, charge, input.nowMs, input.env);
  } else
    await storage.put(
      `${DISPUTE_PREFIX}${pad16(input.nowMs)}:${charge.ref}`,
      true,
    );
  await saveCharge(storage, charge);
  await recordProductEvent(storage, `dispute:${charge.ref}`, {
    action: auto ? "charge.credited" : "charge.disputed",
    at: input.nowMs,
    reason: charge.dispute.reason,
  });
  return charge;
}
async function creditCharge(
  storage: Storage,
  charge: Charge,
  now: number,
  env: TemplStaffEnv = {},
) {
  const state = await readProductState(storage, now, env);
  if (charge.source === "manual") {
    if (!charge.dispute || !charge.manualAgreement)
      throw new HttpError(503, "Manual billing could not be checked.");
    await recordManualRow(storage, {
      kind: "credit",
      ref: charge.ref,
      at: now,
      cents: charge.priceCents,
      agreement: charge.manualAgreement,
      priceVersion: charge.priceVersion,
      table: charge.table,
      reason: charge.dispute.reason,
    });
    await noteManualClosing(storage, now);
  }
  if (charge.pilot && charge.month)
    await creditPilotCharge(
      storage,
      charge.pilot,
      charge.month,
      charge.priceCents,
    );
  if (charge.source === "card" && charge.finalAt !== null) {
    await queueStripeUsage(
      storage,
      {
        kind: "credit",
        subscriptionId: charge.stripeSubscriptionId,
        room: state.room,
        ref: charge.ref,
        finalAt: charge.finalAt,
        cents: charge.priceCents,
      },
      now,
    );
    if (charge.month) {
      const month = await readMonth(storage, charge.month);
      month.cardCreditedCents += charge.priceCents;
      await storage.put(`${CHARGE_MONTH_PREFIX}${charge.month}`, month);
    }
  }
  if (
    charge.source === "free" ||
    charge.source === "grant" ||
    charge.source === "balance"
  )
    creditBack(state, {
      source: charge.source,
      priceCents: charge.priceCents,
      ...(charge.grantId ? { grantId: charge.grantId } : {}),
    });
  await storage.put(PRODUCT_STATE_KEY, state);
  if (charge.source !== "manual") await noteMonthBalance(storage, state);
  if (charge.dispute && charge.source !== "manual")
    await noteStatementRow(storage, state, `credit:${charge.ref}`, {
      kind: "credit",
      ref: charge.ref,
      reason: charge.dispute.reason,
      cents: charge.source === "balance" ? charge.priceCents : 0,
    });
  charge.state = "credited";
  addEvent(
    charge,
    now,
    "credited",
    charge.dispute?.auto ? "system" : "operator",
  );
}
/** The operator's answer to a dispute past the automatic share. */
export async function answerDispute(
  storage: Storage,
  input: {
    ref: string;
    accept: boolean;
    nowMs: number;
    operator: ChatPrincipalId;
    env?: TemplStaffEnv;
  },
) {
  const charge = await chargeByRef(storage, input.ref);
  if (!charge?.dispute || charge.dispute.status !== "open")
    throw new HttpError(404, "No open dispute for that charge.");
  charge.dispute.status = input.accept ? "credited" : "rejected";
  charge.dispute.answeredBy = input.operator;
  if (input.accept) await creditCharge(storage, charge, input.nowMs, input.env);
  else addEvent(charge, input.nowMs, "dispute-rejected", "operator");
  await storage.delete(
    `${DISPUTE_PREFIX}${pad16(charge.dispute.at)}:${charge.ref}`,
  );
  await saveCharge(storage, charge);
  await recordProductEvent(storage, `dispute-answer:${charge.ref}`, {
    action: input.accept ? "charge.credited" : "charge.dispute-rejected",
    at: input.nowMs,
    reason: charge.dispute.reason,
    operator: input.operator,
  });
  return charge;
}
const USAGE_AUTO_CREDIT_PREFIX = "product-usage-auto-credit-month-v1:";
/** Reserve one automatic dispute credit inside the caller's transaction.
 * Both ledgers use the same total and handling-class monthly allowance.
 * Usage counters remain with their ledger across a history restore. */
export async function takeAutomaticDisputeCredit(
  storage: ProductStorage,
  now: number,
  handlingClass: ProductChargeHandlingClass,
  ledger: "resolved-case" | "usage" = "resolved-case",
) {
  const month = resolutionMonth(now);
  const totals = await readMonth(storage, month);
  const usage = (await storage.get<{
    autoCredits: number;
    teamHandledAutoCredits: number;
    aiOnlyAutoCredits: number;
  }>(`${USAGE_AUTO_CREDIT_PREFIX}${month}`)) ?? {
    autoCredits: 0,
    teamHandledAutoCredits: 0,
    aiOnlyAutoCredits: 0,
  };
  if (
    !usage ||
    Object.keys(usage).sort().join() !==
      "aiOnlyAutoCredits,autoCredits,teamHandledAutoCredits" ||
    ![
      usage.autoCredits,
      usage.teamHandledAutoCredits,
      usage.aiOnlyAutoCredits,
    ].every(natural) ||
    usage.teamHandledAutoCredits + usage.aiOnlyAutoCredits !== usage.autoCredits
  )
    throw new HttpError(503, "The case totals could not be checked.");
  const allowance = autoCreditAllowance(
    await finalChargesLast30Days(storage, now),
  );
  const classAllowance = autoCreditAllowance(
    await finalChargesLast30Days(storage, now, handlingClass),
  );
  const classKey =
    handlingClass === "team-handled"
      ? "teamHandledAutoCredits"
      : "aiOnlyAutoCredits";
  if (
    totals.autoCredits + usage.autoCredits >= allowance ||
    totals[classKey] + usage[classKey] >= classAllowance
  )
    return false;
  const updated = ledger === "usage" ? usage : totals;
  updated.autoCredits++;
  updated[classKey]++;
  await storage.put(
    `${ledger === "usage" ? USAGE_AUTO_CREDIT_PREFIX : CHARGE_MONTH_PREFIX}${month}`,
    updated,
  );
  return true;
}

/** Charges that went final in the 30 UTC days up to `now`. */
async function finalChargesLast30Days(
  storage: Pick<ProductStorage, "get">,
  now: number,
  handlingClass?: ProductChargeHandlingClass,
) {
  let count = 0;
  for (let back = 0; back < 30; back++) {
    const day = await readDay(storage, utcDay(now - back * DAY));
    count +=
      handlingClass === "team-handled"
        ? day.teamHandledFinal
        : handlingClass === "ai-only"
          ? day.aiOnlyFinal
          : day.final;
  }
  return count;
}
/** Open disputes, oldest first, for the operator: refs, reasons and times
 * only. The dispute text is the billing manager's note to Templ. */
export async function openDisputes(storage: Pick<Storage, "get" | "list">) {
  const rows = await storage.list<boolean>({
    prefix: DISPUTE_PREFIX,
    limit: 100,
  });
  const out: {
    ref: string;
    reason: ProductDisputeReason;
    text: string | null;
    at: string;
    priceCents: number;
    closer: ProductChargeCloser;
    resolvedBy: ProductChargeResolvedBy;
    corpus: { workspace: string; ref: string } | null;
  }[] = [];
  for (const key of rows.keys()) {
    const charge = await chargeByRef(storage, key.slice(-16));
    if (!charge?.dispute) continue;
    out.push({
      ref: charge.ref,
      reason: charge.dispute.reason,
      text: charge.dispute.text,
      at: iso(charge.dispute.at),
      priceCents: charge.priceCents,
      closer: charge.closer,
      resolvedBy: charge.resolvedBy,
      corpus: charge.dispute.corpus,
    });
  }
  return out;
}

/** Workspace deletion: pending and confirmed charges are dropped (never
 * billed) and their slots given back. Final month totals stay in their own
 * rows, which the purge keeps with the product state. Bounded; returns
 * whether more remain. */
export async function dropOpenCharges(
  storage: Storage,
  now: number,
  env: TemplStaffEnv = {},
) {
  const due = await storage.list<boolean>({
    prefix: CHARGE_DUE_PREFIX,
    limit: 100,
  });
  for (const key of due.keys()) {
    const match = /(tc-[0-9a-f]{32}):(\d{8})$/.exec(key);
    await storage.delete(key);
    if (!match) continue;
    const charge = await readCharge(storage, match[1], Number(match[2]));
    if (
      !charge ||
      !(charge.state === "pending" || charge.state === "confirmed")
    )
      continue;
    charge.dueAt = null;
    await dropReservation(storage, charge, now, env);
    charge.state = "voided";
    addEvent(charge, now, "voided", "system");
    await saveCharge(storage, charge);
  }
  return due.size === 100;
}

/** What a deleted workspace's record keeps of its billing: the balance
 * (a negative one stays owed) and each UTC month's final charges. */
export type DeletedBilling = {
  standardReceivable?: Awaited<ReturnType<typeof standardDeletionSummary>>;
  storageReceivable?: Awaited<ReturnType<typeof storageDeletionSummary>>;
  balanceCents: number;
  manualReceivable?: Awaited<ReturnType<typeof manualDeletionSummary>>;
  usageReceivable?: Awaited<ReturnType<typeof usageDeletionSummary>>;
  months: { month: string; cases: number; cents: number }[];
};
/** Runs before a workspace's room is purged: drops every pending and
 * confirmed charge unbilled, then reads the balance and the month totals of
 * final charges for the deletion record. Null when the workspace never
 * started the offer. */
export async function closeBillingForDeletion(
  storage: Storage,
  now: number,
  env: TemplStaffEnv = {},
): Promise<DeletedBilling | null> {
  const stored = await storage.get(PRODUCT_STATE_KEY);
  const storageReceivable = await storageDeletionSummary(storage);
  if (!stored)
    return storageReceivable
      ? { balanceCents: 0, storageReceivable, months: [] }
      : null;
  while (await dropOpenCharges(storage, now, env));
  const state = await readProductState(storage, now, env);
  const months: DeletedBilling["months"] = [];
  for (const [key, value] of await storage.list<ChargeMonth>({
    prefix: CHARGE_MONTH_PREFIX,
  })) {
    if (value?.schema !== 1 || !natural(value.cases) || value.cases === 0)
      continue;
    months.push({
      month: key.slice(CHARGE_MONTH_PREFIX.length),
      cases: value.cases,
      cents: value.cents,
    });
  }
  return {
    ...(storageReceivable ? { storageReceivable } : {}),
    balanceCents: state.balanceCents,
    manualReceivable: await manualDeletionSummary(storage),
    usageReceivable: await usageDeletionSummary(storage, now),
    standardReceivable: await standardDeletionSummary(storage, now),
    months,
  };
}
