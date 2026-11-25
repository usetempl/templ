import {
  PRODUCT_LIMITS,
  PRODUCT_ANNUAL_PRICES,
  PRODUCT_STARTER_PRICES,
  PRODUCT_STANDARD_PRICES,
  PRODUCT_STANDARD_QUALIFICATION_PRICES,
  PRODUCT_STANDARD_AI_RATES,
  PRODUCT_RESOLUTION_RULES,
} from "@templ/chat/plans";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type {
  MonthlySupportPlan,
  StandardPlanPeriod,
  StandardPlanView,
  StandardPlanReference,
  StandardPlanRecords,
  StandardUsagePeriod,
  StandardUsageReview,
  StandardCashPayment,
} from "@templ/chat/standard-plan";
import {
  standardUsageCharges,
  checkedStandardAiRate,
  captureStandardAiRate,
  applyStandardAiRateUsdNanos,
} from "@templ/chat/standard-usage";
import { accessPaymentCents, type StandardPaymentTerms } from "@templ/chat/product-payment";
import { annualPeriodIdAt, billingMonthBoundary, STANDARD_ANNUAL_START } from "./product-annual-access";
import {
  readPrepaidAccount,
  readPrepaidPeriod,
  debitPrepaid,
  openPrepaidPeriod,
  readStarterAiLimit,
  sponsoredSupport,
} from "./product-prepaid";
import type { SupportCase } from "@templ/chat/support";
import { HttpError } from "./common";
import {
  featureOn,
  managedResolutionBillingOn,
  type WorkspaceFlagEnv,
} from "./workspace-flags";
import { wakeRoomAt } from "./room-alarm";
import { activeProductOrderForm } from "./product-order-forms";
import { customerDebtApproval } from "./customer-debt-access";
import {
  checkedStandardMonthlySyntheticProducer,
  standardMonthlySyntheticLedgerOn,
  type StandardMonthlySyntheticProducer,
} from "./standard-monthly-trial-access";

type Storage = DurableObjectTransaction;
type Reader = { get<T = unknown>(key: string): Promise<T | undefined> };
type Writer = Reader & { put(key: string, value: unknown): Promise<unknown> };
const CASH_DEBT_REFERENCE = "standard-debt:";
const CASH_DEBT_DEBIT = "product-prepaid-debit-v1:" + CASH_DEBT_REFERENCE;
export const STANDARD_PLAN_KEY = "product-standard-plan-v1";
const STARTER_AVAILABLE = "product-starter-available-v1";
export const STANDARD_PERIOD_PREFIX = "product-standard-period-v1:";
export const STANDARD_CASE_PREFIX = "product-standard-case-v1:";
export const STANDARD_DUE_PREFIX = "product-standard-due-v1:";
const CASE = STANDARD_CASE_PREFIX;
const DUE = STANDARD_DUE_PREFIX;
const REFERENCE = "product-standard-reference-v1:";
export const STANDARD_USAGE_REVIEW_PREFIX = "product-standard-usage-review-v1:";
const DEBT_ACCESS = "product-standard-debt-access-v1";
const MONTHLY_DEBT = "product-standard-monthly-debt-v1";
type MonthlyDebt = {
  schemaVersion: 1;
  chargedCents: number;
  paidCents: number;
};
function checkedMonthlyDebt(value: unknown): MonthlyDebt {
  if (
    !object(value) ||
    !exact(value, ["schemaVersion", "chargedCents", "paidCents"]) ||
    value.schemaVersion !== 1 ||
    !natural(value.chargedCents) ||
    !natural(value.paidCents) ||
    value.paidCents > value.chargedCents
  )
    throw fail();
  return value as MonthlyDebt;
}
async function readMonthlyDebt(storage: Reader, id?: string) {
  const value = await storage.get(id ? `${MONTHLY_DEBT}:${id}` : MONTHLY_DEBT);
  return value === undefined
    ? { schemaVersion: 1 as const, chargedCents: 0, paidCents: 0 }
    : checkedMonthlyDebt(value);
}
async function monthlyDebtPeriodView(
  storage: Reader,
  period: StandardPlanPeriod,
) {
  const monthly = await periodMonthlyDebt(storage, period);
  if (monthly.chargedCents === 0) return period;
  const chargedCents = period.chargedCents + monthly.chargedCents;
  const paidCents = period.paidCents + monthly.paidCents;
  if (!natural(chargedCents) || !natural(paidCents)) throw fail();
  return {
    ...period,
    chargedCents,
    paidCents,
    monthlyDebt: {
      chargedCents: monthly.chargedCents,
      paidCents: monthly.paidCents,
    },
  };
}
async function periodMonthlyDebt(storage: Reader, period: StandardPlanPeriod) {
  const monthly = await readMonthlyDebt(storage, period.id);
  if (
    monthly.chargedCents !== 0 &&
    (period.source !== "founder-approved" ||
      monthly.chargedCents !== period.workspaceMonthlyCents)
  )
    throw fail();
  return monthly;
}
/** Separate receivables preserve the stored period format used by the rollback release. */
async function postMonthlyDebt(storage: Writer, period: StandardPlanPeriod) {
  const key = `${MONTHLY_DEBT}:${period.id}`;
  if ((await storage.get(key)) !== undefined) throw fail();
  const totals = await readMonthlyDebt(storage);
  totals.chargedCents += period.workspaceMonthlyCents;
  checkedMonthlyDebt(totals);
  await storage.put(key, {
    schemaVersion: 1,
    chargedCents: period.workspaceMonthlyCents,
    paidCents: 0,
  });
  await storage.put(MONTHLY_DEBT, totals);
}
async function payMonthlyDebt(storage: Writer, id: string, cents: number) {
  const monthly = await readMonthlyDebt(storage, id);
  const paid = Math.min(cents, monthly.chargedCents - monthly.paidCents);
  if (paid === 0) return 0;
  const totals = await readMonthlyDebt(storage);
  monthly.paidCents += paid;
  totals.paidCents += paid;
  checkedMonthlyDebt(monthly);
  checkedMonthlyDebt(totals);
  await storage.put(`${MONTHLY_DEBT}:${id}`, monthly);
  await storage.put(MONTHLY_DEBT, totals);
  return paid;
}
async function readDebtApproval(storage: Reader) {
  const value = await storage.get<unknown>(DEBT_ACCESS);
  if (value === undefined) return null;
  if (!object(value) || typeof value.workspace !== "string") throw fail();
  const approval = customerDebtApproval(value.workspace);
  if (!approval) throw fail();
  const expected = { ...approval, workspace: value.workspace };
  if (
    !exact(value, Object.keys(expected)) ||
    Object.entries(expected).some(
      ([key, expectedValue]) => value[key] !== expectedValue,
    )
  )
    throw fail();
  return expected;
}
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join() === keys.sort().join();
const fail = () => new HttpError(503, "Workspace plan could not be verified.");
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const pad = (value: number) => String(value).padStart(16, "0");
const periodId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{16}$/.test(value);
const nanos = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,29})$/.test(value);
const version = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
type Plan = {
  schema: 1;
  tickets: number;
  currentPeriod: string | null;
  chargedCents: number;
  paidCents: number;
};

function checkedPlan(value: unknown): Plan {
  if (
    !object(value) ||
    !exact(value, [
      "schema",
      "tickets",
      "currentPeriod",
      "chargedCents",
      "paidCents",
    ]) ||
    value.schema !== 1 ||
    !natural(value.tickets) ||
    value.tickets > PRODUCT_LIMITS.freeSupportTickets ||
    !(value.currentPeriod === null || periodId(value.currentPeriod)) ||
    !natural(value.chargedCents) ||
    !natural(value.paidCents) ||
    value.paidCents > value.chargedCents
  )
    throw fail();
  return value as Plan;
}
export function standardPeriodEnd(startsAt: number) {
  return billingMonthBoundary(startsAt, 1);
}
function checkedUsage(
  value: unknown,
  startsAt: number,
  endsAt: number,
  prepaid = false,
): StandardUsagePeriod {
  if (
    !object(value) ||
    !exact(value, [
      "priceVersion",
      "includedAnsweredCases",
      "additionalAnsweredCaseCents",
      "answeredCases",
      "answeredCaseChargedCents",
      "includedAiCreditCents",
      ...(Object.hasOwn(value, "aiRateBasisPoints")
        ? ["aiRateBasisPoints"]
        : ["aiRateMultiplier"]),
      "aiRateCardVersion",
      "aiUsageUsdNanos",
      "aiUsageChargedCents",
      "aiUsageMissing",
      "aiReviewedThrough",
    ]) ||
    !version(value.priceVersion) ||
    !version(value.aiRateCardVersion) ||
    !natural(value.includedAnsweredCases) ||
    !natural(value.additionalAnsweredCaseCents) ||
    !natural(value.answeredCases) ||
    !natural(value.answeredCaseChargedCents) ||
    !natural(value.includedAiCreditCents) ||
    !checkedStandardAiRate(value) ||
    !nanos(value.aiUsageUsdNanos) ||
    !natural(value.aiUsageChargedCents) ||
    (prepaid ? !natural(value.aiUsageMissing) : value.aiUsageMissing !== 0) ||
    !(
      value.aiReviewedThrough === null ||
      (natural(value.aiReviewedThrough) &&
        value.aiReviewedThrough >= startsAt &&
        value.aiReviewedThrough <= endsAt)
    ) ||
    (value.aiReviewedThrough === null &&
      (value.answeredCases !== 0 || value.aiUsageUsdNanos !== "0"))
  )
    throw fail();
  const usage = value as StandardUsagePeriod;
  let charges;
  try {
    charges = standardUsageCharges(usage);
  } catch {
    throw fail();
  }
  if (
    usage.answeredCaseChargedCents !== charges.answeredCaseChargedCents ||
    usage.aiUsageChargedCents !== charges.aiUsageChargedCents
  )
    throw fail();
  return usage;
}
function matchesPeriodDates(value: Record<string, unknown>, startsAt: number) {
  if (!Object.hasOwn(value, "annual")) return value.endsAt === standardPeriodEnd(startsAt);
  const annual = value.annual;
  if (!object(annual) || !exact(annual, ["startsAt", "month", "priceVersion", "totalCents"]) ||
      !natural(annual.startsAt) || !natural(annual.month) || annual.month >= PRODUCT_ANNUAL_PRICES.months ||
      annual.priceVersion !== PRODUCT_ANNUAL_PRICES.publishedOn || value.source !== "verified-payment" ||
      !object(value.usage)) return false;
  const prices = value.usage.priceVersion === PRODUCT_STARTER_PRICES.publishedOn ? PRODUCT_STARTER_PRICES :
    value.usage.priceVersion === PRODUCT_STANDARD_PRICES.publishedOn ? PRODUCT_STANDARD_PRICES : null;
  return prices !== null && value.workspaceMonthlyCents === prices.workspaceMonthlyUsdCents &&
    annual.totalCents === (prices === PRODUCT_STARTER_PRICES ? PRODUCT_ANNUAL_PRICES.starter : PRODUCT_ANNUAL_PRICES.standard) &&
    startsAt === billingMonthBoundary(annual.startsAt, annual.month) &&
    value.endsAt === billingMonthBoundary(annual.startsAt, annual.month + 1);
}
function checkedPeriod(value: unknown): StandardPlanPeriod {
  if (
    !object(value) ||
    !exact(value, [
      "id",
      "startsAt",
      "endsAt",
      "source",
      "referenceSha256",
      "operator",
      "approvedBy",
      "reason",
      "revokedAt",
      "workspaceMonthlyCents",
      "includedAiResolutions",
      "additionalAiResolutionCents",
      "confirmedAiResolutions",
      "chargedCents",
      "paidCents",
      ...(Object.hasOwn(value, "usage") ? ["usage"] : []),
      ...(Object.hasOwn(value, "paymentId") ? ["paymentId"] : []),
      ...(Object.hasOwn(value, "annual") ? ["annual"] : []),
    ]) ||
    !natural(value.startsAt) ||
    value.id !== pad(value.startsAt) ||
    !matchesPeriodDates(value, value.startsAt) ||
    !["manual-payment", "founder-approved", "verified-payment"].includes(
      String(value.source),
    ) ||
    !hash(value.referenceSha256) ||
    (value.source === "verified-payment"
      ? value.operator !== null
      : normalizeChatPrincipal(value.operator) !== value.operator) ||
    !(
      value.approvedBy === null ||
      normalizeChatPrincipal(value.approvedBy) === value.approvedBy
    ) ||
    (value.source === "founder-approved"
      ? value.approvedBy === null
      : value.approvedBy !== null) ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 3 ||
    value.reason.length > 280 ||
    !(value.revokedAt === null || natural(value.revokedAt)) ||
    !natural(value.workspaceMonthlyCents) ||
    !value.workspaceMonthlyCents ||
    !natural(value.includedAiResolutions) ||
    !natural(value.additionalAiResolutionCents) ||
    !natural(value.confirmedAiResolutions) ||
    !natural(value.chargedCents) ||
    !natural(value.paidCents) ||
    value.paidCents > value.chargedCents
  )
    throw fail();
  if (
    value.source === "verified-payment"
      ? typeof value.paymentId !== "string" ||
        !/^(?:1|8453):0x[0-9a-f]{64}:[0-9]+$|^solana:[1-9A-HJ-NP-Za-km-z]{64,88}:[0-9]+$/.test(
          value.paymentId,
        ) ||
        !value.usage
      : Object.hasOwn(value, "paymentId")
  )
    throw fail();
  if (Object.hasOwn(value, "usage")) {
    const usage = checkedUsage(
      value.usage,
      value.startsAt,
      Number(value.endsAt),
      value.source === "verified-payment",
    );
    if (
      value.includedAiResolutions !== 0 ||
      value.additionalAiResolutionCents !== 0 ||
      value.confirmedAiResolutions !== 0 ||
      value.chargedCents !==
        usage.answeredCaseChargedCents + usage.aiUsageChargedCents
    )
      throw fail();
  } else if (
    value.chargedCents !==
    Math.max(
      0,
      Number(value.confirmedAiResolutions) -
        Number(value.includedAiResolutions),
    ) *
      Number(value.additionalAiResolutionCents)
  )
    throw fail();
  return value as StandardPlanPeriod;
}
async function readPlan(storage: Reader, at?: number) {
  const stored = await storage.get<unknown>(STANDARD_PLAN_KEY);
  // Retained workspaces need paid admission; missing lifetime history grants no fresh demo allowance.
  const plan = stored === undefined
    ? {
        schema: 1 as const,
        tickets: PRODUCT_LIMITS.freeSupportTickets,
        currentPeriod: null,
        chargedCents: 0,
        paidCents: 0,
      }
    : checkedPlan(stored);
  if (at !== undefined && plan.currentPeriod)
    plan.currentPeriod = await annualPeriodIdAt(storage, plan.currentPeriod, at);
  return plan;
}
// Old readers keep an ordinary monthly period. The annual record supplies the
// anniversary and the extra days after short months to a term-aware reader.
const ANNUAL_PAYMENT_REASON = "Verified prepaid annual payment.";
const ANNUAL_MONTH = "product-standard-annual-month-v1:";
async function savePeriod(storage: Writer, period: StandardPlanPeriod) {
  if (!period.annual) {
    await storage.put(STANDARD_PERIOD_PREFIX + period.id, period);
    return;
  }
  checkedPeriod(period);
  const { annual, ...monthly } = period;
  const end = standardPeriodEnd(period.startsAt);
  const through = period.usage!.aiReviewedThrough;
  const extension = through !== null && through > end ? through : null;
  const raw = {
    ...monthly, endsAt: end,
    usage: { ...period.usage!, aiReviewedThrough: extension === null ? through : end },
  };
  await storage.put(STANDARD_PERIOD_PREFIX + period.id, checkedPeriod(raw));
  await storage.put(ANNUAL_MONTH + period.id, { terms: annual, extension });
}
async function storedPeriod(storage: Reader, value: unknown) {
  const row = checkedPeriod(value);
  if (row.annual) throw fail();
  if (row.source !== "verified-payment" || row.reason !== ANNUAL_PAYMENT_REASON) return row;
  const meta = await storage.get<{ terms: NonNullable<StandardPlanPeriod["annual"]>; extension: number | null }>(ANNUAL_MONTH + row.id);
  if (!meta || !object(meta.terms) || !(meta.extension === null ||
      (natural(meta.extension) && meta.extension > row.endsAt && row.usage?.aiReviewedThrough === row.endsAt))) throw fail();
  return checkedPeriod({
    ...row, annual: meta.terms, endsAt: billingMonthBoundary(meta.terms.startsAt, meta.terms.month + 1),
    usage: { ...row.usage!, aiReviewedThrough: meta.extension ?? row.usage!.aiReviewedThrough },
  });
}
async function readPeriod(storage: Reader, id: string) {
  const period = await storedPeriod(storage, await storage.get(STANDARD_PERIOD_PREFIX + id));
  if (period.id !== id) throw fail();
  return period;
}
/** A ticket keeps the coverage it had when it opened. Later payments grant no earlier coverage. */
export async function standardCoveredAt(
  storage: Reader & Pick<DurableObjectTransaction, "list">,
  openedAt: number,
) {
  if (!natural(openedAt) || !natural(openedAt + 1)) throw fail();
  const rows = await storage.list<unknown>({
    prefix: STANDARD_PERIOD_PREFIX,
    end: STANDARD_PERIOD_PREFIX + pad(openedAt + 1),
    reverse: true,
    limit: 1,
  });
  if (!rows.size) return false;
  const [key, value] = [...rows][0],
    period = await storedPeriod(storage, value);
  if (key !== STANDARD_PERIOD_PREFIX + period.id) throw fail();
  return (
    period.startsAt <= openedAt &&
    openedAt < period.endsAt &&
    (period.revokedAt === null || openedAt < period.revokedAt)
  );
}
export async function initializeStandardPlan(
  storage: Writer,
  starterAvailable?: true,
) {
  if ((await storage.get(STANDARD_PLAN_KEY)) !== undefined) return;
  await storage.put(STANDARD_PLAN_KEY, {
    schema: 1,
    tickets: 0,
    currentPeriod: null,
    chargedCents: 0,
    paidCents: 0,
  });
  if (starterAvailable) await storage.put(STARTER_AVAILABLE, true);
}
export async function standardPlanView(
  storage: Reader,
  now: number,
): Promise<StandardPlanView> {
  const plan = await readPlan(storage, now);
  const period =
    plan.currentPeriod === null
      ? null
      : await readPeriod(storage, plan.currentPeriod);
  const paid =
    period !== null &&
    period.revokedAt === null &&
    period.startsAt <= now &&
    now < period.endsAt;
  const account = await readPrepaidAccount(storage);
  const approval = await readDebtApproval(storage);
  const monthly = await readMonthlyDebt(storage);
  const chargedCents = plan.chargedCents + monthly.chargedCents;
  const paidCents = plan.paidCents + monthly.paidCents;
  if (!natural(chargedCents) || !natural(paidCents)) throw fail();
  const continuesOnDebt =
    approval !== null &&
    account.mode !== "prepaid" &&
    period !== null &&
    period.revokedAt === null;
  return {
    status: paid ? "paid" : "demo",
    ...(paid && period.annual ? { accessEndsAt: billingMonthBoundary(period.annual.startsAt, PRODUCT_ANNUAL_PRICES.months) } : {}),
    ticketsUsed: plan.tickets,
    ticketsTotal: PRODUCT_LIMITS.freeSupportTickets,
    period: period ? await monthlyDebtPeriodView(storage, period) : null,
    includedAiResolutions: period?.includedAiResolutions ?? 0,
    additionalAiResolutionCents: period?.additionalAiResolutionCents ?? 0,
    chargedCents,
    paidCents,
    dueCents: chargedCents - paidCents,
    ...(continuesOnDebt ? { continuesOnDebt: true } : {}),
    ...(account.mode === "prepaid" && (await storage.get(STARTER_AVAILABLE)) === true
      ? { starterAvailable: true as const, annualAvailable: true as const }
      : {}),
    ...(paid && period.usage?.priceVersion === PRODUCT_STARTER_PRICES.publishedOn
      ? { starterAiLimitCents: await readStarterAiLimit(storage) }
      : {}),
    prepaid: {
      ...account,
      ...(await sponsoredSupport(storage) ? { sponsored: true as const } : {}),
      period: period ? await readPrepaidPeriod(storage, period.id) : null,
    },
  };
}

/** Apply only the founder's two named arrangements, inside a Room transaction. */
export async function continueCustomerDebtAccess(
  storage: Storage,
  now: number,
) {
  if (!natural(now)) throw fail();
  const native = await storage.get<{ room?: { id?: string } }>("native-room");
  const workspace = native?.room?.id;
  const approval = workspace ? customerDebtApproval(workspace) : null;
  if (!approval || !workspace || now < Date.parse(approval.approvedOn) || await sponsoredSupport(storage))
    return null;
  const product = await storage.get<{ room: string; suspended: unknown }>(
    "product-entitlements-v1",
  );
  if (!product || product.room !== `room:${workspace}` || product.suspended)
    return null;
  if (
    (await readPrepaidAccount(storage)).mode === "prepaid" ||
    (await activeProductOrderForm(storage, now))
  )
    return null;
  const authorization = { ...approval, workspace };
  const previous = await readDebtApproval(storage);
  if (previous && previous.workspace !== workspace) throw fail();
  if (!previous) await storage.put(DEBT_ACCESS, authorization);
  let plan = await readPlan(storage);
  let period = plan.currentPeriod
    ? await readPeriod(storage, plan.currentPeriod)
    : null;
  if (!period) {
    await grantStandardPeriod(storage, {
      source: "founder-approved",
      referenceSha256: await debtAccessReference(
        approval.id,
        workspace,
        "first-month",
      ),
      approvedBy: approval.approvedBy,
      operator: approval.approvedBy,
      reason: approval.reason,
      expectedPeriod: null,
      now,
    });
    plan = await readPlan(storage);
    period = await readPeriod(storage, plan.currentPeriod!);
  }
  if (period.revokedAt !== null) return null;
  while (period.endsAt <= now) {
    const startsAt = period.endsAt;
    const next: StandardPlanPeriod = {
      ...period,
      id: pad(startsAt),
      startsAt,
      endsAt: standardPeriodEnd(startsAt),
      source: "founder-approved",
      referenceSha256: await debtAccessReference(
        approval.id,
        workspace,
        pad(startsAt),
      ),
      approvedBy: approval.approvedBy,
      operator: approval.approvedBy,
      reason: approval.reason,
      revokedAt: null,
      confirmedAiResolutions: 0,
      chargedCents: 0,
      paidCents: 0,
      ...(period.usage
        ? {
            usage: {
              ...period.usage,
              answeredCases: 0,
              answeredCaseChargedCents: 0,
              aiUsageUsdNanos: "0",
              aiUsageChargedCents: 0,
              aiUsageMissing: 0,
              aiReviewedThrough: null,
            },
          }
        : {}),
    };
    delete next.paymentId;
    checkedPeriod(next);
    if ((await storage.get(STANDARD_PERIOD_PREFIX + next.id)) !== undefined)
      throw fail();
    await savePeriod(storage, next);
    await postMonthlyDebt(storage, next);
    await storage.put(
      REFERENCE + next.referenceSha256,
      checkedReference({
        kind: "access",
        period: next.id,
        cents: 0,
        recordedAt: startsAt,
        operator: approval.approvedBy,
        reason: approval.reason,
      }),
    );
    plan.currentPeriod = next.id;
    checkedPlan(plan);
    await storage.put(STANDARD_PLAN_KEY, plan);
    period = next;
  }
  await payStandardDebtFromCredit(storage, now);
  return period.endsAt;
}

async function debtAccessReference(
  approval: string,
  workspace: string,
  period: string,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ approval, workspace, period }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
/** Call in the transaction that opens the accepted member case. Retries never call this. */
export async function countStandardTicket(storage: Writer) {
  if ((await storage.get(STANDARD_PLAN_KEY)) === undefined) return;
  const plan = await readPlan(storage);
  plan.tickets = Math.min(PRODUCT_LIMITS.freeSupportTickets, plan.tickets + 1);
  await storage.put(STANDARD_PLAN_KEY, plan);
}
type Reference = Omit<StandardPlanReference, "referenceSha256">;
function checkedReference(value: unknown): Reference {
  if (
    !object(value) ||
    !exact(value, [
      "kind",
      "period",
      "cents",
      "recordedAt",
      "operator",
      "reason",
    ]) ||
    !["access", "debt-paid"].includes(String(value.kind)) ||
    !periodId(value.period) ||
    !natural(value.cents) ||
    (value.kind === "debt-paid" && value.cents === 0) ||
    !natural(value.recordedAt) ||
    normalizeChatPrincipal(value.operator) !== value.operator ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 3 ||
    value.reason.length > 280
  )
    throw fail();
  return value as Reference;
}
export async function grantStandardPeriod(
  storage: Storage,
  input: {
    source: "manual-payment" | "founder-approved";
    referenceSha256: string;
    approvedBy: ChatPrincipalId | null;
    operator: ChatPrincipalId;
    reason: string;
    expectedPeriod: string | null;
    now: number;
  },
  prices:
    | typeof PRODUCT_STANDARD_PRICES
    | typeof PRODUCT_STANDARD_QUALIFICATION_PRICES = PRODUCT_STANDARD_PRICES,
) {
  if (
    !["manual-payment", "founder-approved"].includes(input.source) ||
    !hash(input.referenceSha256) ||
    !(input.source === "founder-approved"
      ? input.approvedBy !== null
      : input.approvedBy === null)
  )
    throw new HttpError(400, "Choose the access source and its reference.");
  const key = REFERENCE + input.referenceSha256;
  const previous = await storage.get<unknown>(key);
  if (previous !== undefined) {
    const row = checkedReference(previous);
    if (row.kind !== "access")
      throw new HttpError(
        409,
        "This reference already records a different action.",
      );
    const retained = await readPeriod(storage, row.period);
    if (
      row.recordedAt !== retained.startsAt ||
      row.operator !== retained.operator ||
      row.reason !== retained.reason ||
      row.cents !==
        (retained.source === "manual-payment"
          ? retained.workspaceMonthlyCents
          : 0)
    )
      throw fail();
    if (
      retained.source !== input.source ||
      retained.approvedBy !== input.approvedBy ||
      retained.operator !== input.operator ||
      retained.reason !== input.reason
    )
      throw new HttpError(
        409,
        "This reference already records different access.",
      );
    return standardPlanView(storage, input.now);
  }
  const plan = await readPlan(storage, input.now);
  if (plan.currentPeriod !== input.expectedPeriod)
    throw new HttpError(409, "Read the current plan before changing access.");
  if (
    plan.currentPeriod !== null &&
    (await readPeriod(storage, plan.currentPeriod)).endsAt > input.now
  )
    throw new HttpError(409, "This monthly period has not ended.");
  if (input.source === "founder-approved" && plan.currentPeriod !== null)
    throw new HttpError(
      409,
      "Founder-approved access covers the first month only.",
    );
  const usagePrices = "includedAnsweredCasesPerMonth" in prices ? prices : null;
  const legacyPrices =
    "includedAiResolutionsPerMonth" in prices ? prices : null;
  const period: StandardPlanPeriod = {
    id: pad(input.now),
    startsAt: input.now,
    endsAt: standardPeriodEnd(input.now),
    source: input.source,
    referenceSha256: input.referenceSha256,
    approvedBy: input.approvedBy,
    operator: input.operator,
    reason: input.reason,
    revokedAt: null,
    workspaceMonthlyCents: prices.workspaceMonthlyUsdCents,
    includedAiResolutions: legacyPrices?.includedAiResolutionsPerMonth ?? 0,
    additionalAiResolutionCents:
      legacyPrices?.additionalAiResolutionUsdCents ?? 0,
    confirmedAiResolutions: 0,
    chargedCents: 0,
    paidCents: 0,
    ...(usagePrices
      ? {
          usage: {
            priceVersion: usagePrices.publishedOn,
            includedAnsweredCases: usagePrices.includedAnsweredCasesPerMonth,
            additionalAnsweredCaseCents:
              usagePrices.additionalAnsweredCaseUsdCents,
            answeredCases: 0,
            answeredCaseChargedCents: 0,
            includedAiCreditCents: usagePrices.includedAiCreditUsdCents,
            ...captureStandardAiRate(usagePrices),
            aiRateCardVersion: PRODUCT_STANDARD_AI_RATES.version,
            aiUsageUsdNanos: "0",
            aiUsageChargedCents: 0,
            aiUsageMissing: 0,
            aiReviewedThrough: null,
          },
        }
      : {}),
  };
  checkedPeriod(period);
  await savePeriod(storage, period);
  await storage.put(
    key,
    checkedReference({
      kind: "access",
      period: period.id,
      cents:
        input.source === "manual-payment" ? period.workspaceMonthlyCents : 0,
      recordedAt: input.now,
      operator: input.operator,
      reason: input.reason,
    }),
  );
  plan.currentPeriod = period.id;
  await storage.put(STANDARD_PLAN_KEY, plan);
  return standardPlanView(storage, input.now);
}

export function standardPrepaidTerms(
  purpose: StandardPaymentTerms["purpose"],
  expectedPeriod: string | null,
  plan: MonthlySupportPlan = "standard",
): StandardPaymentTerms {
  const prices = plan === "starter" ? PRODUCT_STARTER_PRICES : PRODUCT_STANDARD_PRICES;
  return {
    purpose,
    ...(purpose === "annual" ? { annualPriceVersion: PRODUCT_ANNUAL_PRICES.publishedOn } : {}),
    expectedPeriod,
    priceVersion: prices.publishedOn,
    workspaceMonthlyCents: prices.workspaceMonthlyUsdCents,
    includedAnsweredCases: prices.includedAnsweredCasesPerMonth,
    additionalAnsweredCaseCents: prices.additionalAnsweredCaseUsdCents,
    includedAiCreditCents: prices.includedAiCreditUsdCents,
    ...captureStandardAiRate(prices),
    aiRateCardVersion: plan === "starter"
      ? PRODUCT_STARTER_PRICES.aiRateCardVersion
      : PRODUCT_STANDARD_AI_RATES.version,
  };
}
/** A verified payment funds this operation. It never impersonates a human operator. */
export async function activateVerifiedStandardPeriod(
  storage: Writer,
  input: {
    paymentId: string;
    terms: StandardPaymentTerms;
    at: number;
  },
) {
  const { terms } = input;
  if (
    !natural(input.at) ||
    !["period", "annual"].includes(terms.purpose) ||
    accessPaymentCents(terms) === null ||
    !(terms.expectedPeriod === null || periodId(terms.expectedPeriod)) ||
    !/^(?:1|8453):0x[0-9a-f]{64}:[0-9]+$|^solana:[1-9A-HJ-NP-Za-km-z]{64,88}:[0-9]+$/.test(
      input.paymentId,
    )
  )
    throw fail();
  const referenceSha256 = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input.paymentId),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const key = "product-standard-verified-access-v1:" + referenceSha256;
  const previous = await storage.get<{
    period: string;
    terms: StandardPaymentTerms;
  }>(key);
  if (previous) {
    if (JSON.stringify(previous.terms) !== JSON.stringify(terms))
      throw new HttpError(
        409,
        "This payment already started a month with different terms.",
      );
    return readPeriod(storage, previous.period);
  }
  const plan = await readPlan(storage, input.at);
  if (
    plan.currentPeriod !== terms.expectedPeriod ||
    (plan.currentPeriod !== null &&
      (await readPeriod(storage, plan.currentPeriod)).endsAt > input.at)
  )
    throw new HttpError(
      409,
      "Keep the current month. This payment remains prepaid credit.",
    );
  const totalCents = accessPaymentCents(terms)!;
  const annual = terms.purpose === "annual";
  if (annual) {
    // Annual access is offered only to eligible, self-serve prepaid workspaces.
    const selected = terms.priceVersion === PRODUCT_STARTER_PRICES.publishedOn ? "starter" : "standard";
    const offer = standardPrepaidTerms("annual", terms.expectedPeriod, selected);
    if (Object.keys(offer).length !== Object.keys(terms).length ||
        Object.entries(offer).some(([key, value]) => terms[key as keyof StandardPaymentTerms] !== value))
      throw fail();
    if (await storage.get(STARTER_AVAILABLE) !== true || (await readPrepaidAccount(storage)).mode !== "prepaid")
      throw new HttpError(409, "Keep the workspace’s current billing arrangement.");
  }
  const period: StandardPlanPeriod = {
    id: pad(input.at),
    startsAt: input.at,
    endsAt: standardPeriodEnd(input.at),
    source: "verified-payment",
    paymentId: input.paymentId,
    referenceSha256,
    operator: null,
    approvedBy: null,
    reason: annual ? ANNUAL_PAYMENT_REASON : "Verified prepaid monthly payment.",
    revokedAt: null,
    workspaceMonthlyCents: terms.workspaceMonthlyCents,
    includedAiResolutions: 0,
    additionalAiResolutionCents: 0,
    confirmedAiResolutions: 0,
    chargedCents: 0,
    paidCents: 0,
    usage: {
      priceVersion: terms.priceVersion,
      includedAnsweredCases: terms.includedAnsweredCases,
      additionalAnsweredCaseCents: terms.additionalAnsweredCaseCents,
      answeredCases: 0,
      answeredCaseChargedCents: 0,
      includedAiCreditCents: terms.includedAiCreditCents,
      ...captureStandardAiRate(terms),
      aiRateCardVersion: terms.aiRateCardVersion,
      aiUsageUsdNanos: "0",
      aiUsageChargedCents: 0,
      aiUsageMissing: 0,
      aiReviewedThrough: null,
    },
  };
  const windows = Array.from({ length: annual ? PRODUCT_ANNUAL_PRICES.months : 1 }, (_, month) => {
    const startsAt = billingMonthBoundary(input.at, month);
    return checkedPeriod({
      ...period, id: pad(startsAt), startsAt, endsAt: billingMonthBoundary(input.at, month + 1),
      ...(annual ? { annual: { startsAt: input.at, month, totalCents, priceVersion: PRODUCT_ANNUAL_PRICES.publishedOn } } : {}),
    });
  });
  for (const window of windows)
    if (await storage.get(STANDARD_PERIOD_PREFIX + window.id) !== undefined)
      throw new HttpError(409, "This payment overlaps an existing access period.");
  await debitPrepaid(storage, {
    referenceId: (annual ? "year:" : "month:") + input.paymentId,
    amountUsdNanos: (BigInt(totalCents) * 10_000_000n).toString(),
    at: input.at,
  });
  for (const window of windows) {
    await openPrepaidPeriod(storage, {
      id: window.id, startsAt: window.startsAt, endsAt: window.endsAt,
      priceVersion: terms.priceVersion, ...captureStandardAiRate(terms),
      aiRateCardVersion: terms.aiRateCardVersion,
      includedAiCreditUsdNanos: (BigInt(terms.includedAiCreditCents) * 10_000_000n).toString(),
    });
    await savePeriod(storage, window);
  }
  if (annual) await storage.put(STANDARD_ANNUAL_START, input.at);
  plan.currentPeriod = period.id;
  await storage.put(STANDARD_PLAN_KEY, plan);
  await storage.put(key, { period: period.id, terms });
  return windows[0];
}

/** Cash settles in the prepaid ledger. These cent totals are its monthly statement, not another debit. */
export async function syncPrepaidStandardUsage(
  storage: Writer,
  id: string,
  at: number,
) {
  const period = await readPeriod(storage, id);
  return syncPrepaidStandardPeriod(storage, period, at);
}
async function syncPrepaidStandardPeriod(
  storage: Writer,
  period: StandardPlanPeriod,
  at: number,
) {
  if (
    period.source !== "verified-payment" ||
    !period.usage ||
    !natural(at) ||
    at < period.startsAt
  )
    throw fail();
  const budget = await readPrepaidPeriod(storage, period.id),
    plan = await readPlan(storage, at);
  if (!budget || period.paidCents !== period.chargedCents) throw fail();
  const usage = {
    ...period.usage,
    aiUsageUsdNanos: budget.aiUsageUsdNanos,
    aiUsageMissing: budget.aiAbsorbedAttempts,
  };
  let charges;
  try {
    charges = standardUsageCharges(usage);
  } catch {
    throw fail();
  }
  const delta = charges.totalChargedCents - period.chargedCents;
  const answeredCaseCents =
    charges.answeredCaseChargedCents - period.usage.answeredCaseChargedCents;
  const aiCents =
    charges.aiUsageChargedCents - period.usage.aiUsageChargedCents;
  if (
    !natural(delta) ||
    !natural(answeredCaseCents) ||
    !natural(aiCents) ||
    answeredCaseCents + aiCents !== delta ||
    !natural(plan.chargedCents + delta) ||
    !natural(plan.paidCents + delta)
  )
    throw fail();
  period.usage = {
    ...usage,
    answeredCaseChargedCents: charges.answeredCaseChargedCents,
    aiUsageChargedCents: charges.aiUsageChargedCents,
    aiReviewedThrough: Math.max(
      usage.aiReviewedThrough ?? period.startsAt,
      Math.min(period.endsAt, at),
    ),
  };
  period.chargedCents = charges.totalChargedCents;
  period.paidCents += delta;
  plan.chargedCents += delta;
  plan.paidCents += delta;
  checkedPeriod(period);
  checkedPlan(plan);
  if (delta) {
    const key = `product-prepaid-usage-v1:${period.id}:${pad(charges.totalChargedCents)}`;
    if ((await storage.get(key)) !== undefined) throw fail();
    await storage.put(key, {
      at,
      period: period.id,
      answeredCaseCents,
      aiCents,
      cents: delta,
    });
  }
  await savePeriod(storage, period);
  await storage.put(STANDARD_PLAN_KEY, plan);
  return period;
}

/** The accepted answer and its charge must commit in this same Room transaction. */
export async function recordPrepaidAnsweredCase(
  storage: Writer & Pick<Storage, "list">,
  input: { case: SupportCase; at: number },
) {
  const c = input.case;
  if (
    !natural(input.at) ||
    !c ||
    !/^tc-[0-9a-f]{32}$/.test(c.thread) ||
    !natural(c.seq) ||
    !c.seq ||
    !natural(c.openedAt) ||
    c.openedAt > input.at ||
    !Array.isArray(c.excluded)
  )
    throw fail();
  if (await sponsoredSupport(storage)) return { counted: false, chargedCents: 0 };
  const plan = await readPlan(storage, input.at);
  if (plan.currentPeriod === null) return { counted: false, chargedCents: 0 };
  const period = await readPeriod(storage, plan.currentPeriod);
  if (
    period.source !== "verified-payment" ||
    !period.usage ||
    period.revokedAt !== null ||
    input.at < period.startsAt ||
    input.at >= period.endsAt ||
    c.source !== "live" ||
    c.billingExclusion !== null ||
    c.excluded.length
  )
    return { counted: false, chargedCents: 0 };
  if (
    c.openedAt < period.startsAt &&
    ((await storage.get(STARTER_AVAILABLE)) !== true || !(await standardCoveredAt(storage, c.openedAt)))
  )
    return { counted: false, chargedCents: 0 };
  const reference = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${c.thread}:${c.seq}`),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const key = "product-prepaid-answered-v1:" + reference;
  const previous = await storage.get<{
    period: string;
    at: number;
    chargedCents: number;
  }>(key);
  if (previous !== undefined) {
    if (
      !periodId(previous.period) ||
      !natural(previous.at) ||
      !natural(previous.chargedCents)
    )
      throw fail();
    return { counted: false, chargedCents: previous.chargedCents };
  }
  if (!natural(period.usage.answeredCases + 1)) throw fail();
  const chargedCents =
    period.usage.answeredCases >= period.usage.includedAnsweredCases
      ? period.usage.additionalAnsweredCaseCents
      : 0;
  if (chargedCents)
    await debitPrepaid(storage, {
      referenceId: "answer:" + reference,
      amountUsdNanos: (BigInt(chargedCents) * 10_000_000n).toString(),
      at: input.at,
    });
  period.usage.answeredCases++;
  await syncPrepaidStandardPeriod(storage, period, input.at);
  await storage.put(key, { period: period.id, at: input.at, chargedCents });
  return { counted: true, chargedCents };
}

type UsageReviewInput = {
  period: string;
  referenceSha256: string;
  operator: ChatPrincipalId;
  reason: string;
  expectedReviewedThrough: number | null;
  reviewedThrough: number;
  answeredCases: number;
  providerAiUsageUsdNanos: string;
  aiUsageMissing: number;
  now: number;
};
function reviewPayload(input: Omit<UsageReviewInput, "now">) {
  return {
    period: input.period,
    referenceSha256: input.referenceSha256,
    operator: input.operator,
    reason: input.reason,
    expectedReviewedThrough: input.expectedReviewedThrough,
    reviewedThrough: input.reviewedThrough,
    answeredCases: input.answeredCases,
    providerAiUsageUsdNanos: input.providerAiUsageUsdNanos,
    aiUsageMissing: input.aiUsageMissing,
  };
}
async function reviewPayloadHash(input: Omit<UsageReviewInput, "now">) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(reviewPayload(input))),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function checkedUsageReview(
  value: unknown,
  period: StandardPlanPeriod,
): Promise<StandardUsageReview> {
  if (
    !object(value) ||
    !exact(value, [
      "schemaVersion",
      "referenceSha256",
      "payloadSha256",
      "period",
      "recordedAt",
      "operator",
      "reason",
      "expectedReviewedThrough",
      "reviewedThrough",
      "answeredCases",
      "providerAiUsageUsdNanos",
      "aiUsageUsdNanos",
      "aiUsageMissing",
      "answeredCaseChargedCents",
      "aiUsageChargedCents",
      "chargedCents",
    ]) ||
    value.schemaVersion !== 1 ||
    !hash(value.referenceSha256) ||
    !hash(value.payloadSha256) ||
    !periodId(value.period) ||
    !natural(value.recordedAt) ||
    normalizeChatPrincipal(value.operator) !== value.operator ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 3 ||
    value.reason.length > 280 ||
    !(
      value.expectedReviewedThrough === null ||
      natural(value.expectedReviewedThrough)
    ) ||
    !natural(value.reviewedThrough) ||
    value.reviewedThrough > value.recordedAt ||
    !natural(value.answeredCases) ||
    !nanos(value.providerAiUsageUsdNanos) ||
    !nanos(value.aiUsageUsdNanos) ||
    value.aiUsageMissing !== 0 ||
    !natural(value.answeredCaseChargedCents) ||
    !natural(value.aiUsageChargedCents) ||
    !natural(value.chargedCents) ||
    value.chargedCents !==
      value.answeredCaseChargedCents + value.aiUsageChargedCents
  )
    throw fail();
  const row = value as StandardUsageReview;
  const usage = period.usage;
  if (
    !usage ||
    row.period !== period.id ||
    row.reviewedThrough < period.startsAt ||
    row.reviewedThrough > period.endsAt ||
    (row.expectedReviewedThrough !== null &&
      (row.expectedReviewedThrough < period.startsAt ||
        row.expectedReviewedThrough >= row.reviewedThrough)) ||
    row.aiUsageUsdNanos !==
      applyStandardAiRateUsdNanos(row.providerAiUsageUsdNanos, usage) ||
    row.payloadSha256 !== (await reviewPayloadHash(row))
  )
    throw fail();
  let charges;
  try {
    charges = standardUsageCharges({
      ...usage,
      answeredCases: row.answeredCases,
      aiUsageUsdNanos: row.aiUsageUsdNanos,
    });
  } catch {
    throw fail();
  }
  if (
    charges.answeredCaseChargedCents !== row.answeredCaseChargedCents ||
    charges.aiUsageChargedCents !== row.aiUsageChargedCents ||
    charges.totalChargedCents !== row.chargedCents
  )
    throw fail();
  return row;
}

/** Call in the authorized operator transaction. Usage review creates no payment or access. */
export async function reviewStandardUsage(
  storage: Storage,
  input: UsageReviewInput,
) {
  if (
    !periodId(input.period) ||
    !hash(input.referenceSha256) ||
    normalizeChatPrincipal(input.operator) !== input.operator ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 3 ||
    input.reason.length > 280 ||
    !(
      input.expectedReviewedThrough === null ||
      natural(input.expectedReviewedThrough)
    ) ||
    !natural(input.reviewedThrough) ||
    !natural(input.now) ||
    input.reviewedThrough > input.now ||
    !natural(input.answeredCases) ||
    !nanos(input.providerAiUsageUsdNanos) ||
    input.aiUsageMissing !== 0
  )
    throw new HttpError(
      400,
      "Review complete usage totals and their statement reference.",
    );
  const key = STANDARD_USAGE_REVIEW_PREFIX + input.referenceSha256;
  const payloadSha256 = await reviewPayloadHash(input);
  const previous = await storage.get<unknown>(key);
  if (previous !== undefined) {
    if (!object(previous) || !periodId(previous.period)) throw fail();
    const row = await checkedUsageReview(
      previous,
      await readPeriod(storage, previous.period),
    );
    if (row.payloadSha256 !== payloadSha256)
      throw new HttpError(
        409,
        "This reference already records different usage.",
      );
    return standardPlanView(storage, input.now);
  }
  const period = await readPeriod(storage, input.period),
    plan = await readPlan(storage);
  const usage = period.usage;
  if (!usage)
    throw new HttpError(409, "This period keeps its recorded billing terms.");
  if (period.source === "verified-payment")
    throw new HttpError(
      409,
      "Prepaid usage is recorded when answers and AI requests finish.",
    );
  if (usage.aiReviewedThrough !== input.expectedReviewedThrough)
    throw new HttpError(
      409,
      "Read the current usage review before recording totals.",
    );
  if (
    input.reviewedThrough < period.startsAt ||
    input.reviewedThrough > period.endsAt ||
    (usage.aiReviewedThrough !== null &&
      input.reviewedThrough <= usage.aiReviewedThrough)
  )
    throw new HttpError(
      409,
      "Choose a later review time within this monthly period.",
    );
  const pricedAiUsage = applyStandardAiRateUsdNanos(
    input.providerAiUsageUsdNanos,
    usage,
  );
  if (pricedAiUsage === null)
    throw new HttpError(
      400,
      "Measured AI usage does not match this period's rate.",
    );
  const aiUsage = BigInt(pricedAiUsage);
  if (
    input.answeredCases < usage.answeredCases ||
    aiUsage < BigInt(usage.aiUsageUsdNanos)
  )
    throw new HttpError(
      409,
      "A lower usage total needs a separate credit review.",
    );
  if (!nanos(aiUsage.toString()))
    throw new HttpError(400, "Usage total is too large.");
  let charges;
  try {
    charges = standardUsageCharges({
      ...usage,
      answeredCases: input.answeredCases,
      aiUsageUsdNanos: aiUsage.toString(),
    });
  } catch {
    throw new HttpError(400, "Usage total is too large.");
  }
  const delta = charges.totalChargedCents - period.chargedCents;
  if (!natural(delta) || !natural(plan.chargedCents + delta)) throw fail();
  period.usage = {
    ...usage,
    answeredCaseChargedCents: charges.answeredCaseChargedCents,
    aiUsageChargedCents: charges.aiUsageChargedCents,
    answeredCases: input.answeredCases,
    aiUsageUsdNanos: aiUsage.toString(),
    aiUsageMissing: 0,
    aiReviewedThrough: input.reviewedThrough,
  };
  period.chargedCents = charges.totalChargedCents;
  plan.chargedCents += delta;
  const row: StandardUsageReview = {
    schemaVersion: 1,
    ...reviewPayload(input),
    aiUsageMissing: 0,
    payloadSha256,
    recordedAt: input.now,
    aiUsageUsdNanos: aiUsage.toString(),
    answeredCaseChargedCents: charges.answeredCaseChargedCents,
    aiUsageChargedCents: charges.aiUsageChargedCents,
    chargedCents: charges.totalChargedCents,
  };
  checkedPeriod(period);
  checkedPlan(plan);
  await checkedUsageReview(row, period);
  await savePeriod(storage, period);
  await storage.put(STANDARD_PLAN_KEY, plan);
  await storage.put(key, row);
  await payStandardDebtFromCredit(storage, input.now);
  return standardPlanView(storage, input.now);
}
/** Records received money against this period's actual debt; it creates no payment receipt. */
export async function markStandardDebtPaid(
  storage: Storage,
  input: {
    period: string;
    cents: number;
    referenceSha256: string;
    operator: ChatPrincipalId;
    reason: string;
    now: number;
  },
) {
  if (
    !periodId(input.period) ||
    !natural(input.cents) ||
    !input.cents ||
    !hash(input.referenceSha256)
  )
    throw new HttpError(
      400,
      "Choose the period, received amount and reference.",
    );
  const key = REFERENCE + input.referenceSha256;
  const previous = await storage.get<unknown>(key);
  const row: Reference = {
    kind: "debt-paid",
    period: input.period,
    cents: input.cents,
    operator: input.operator,
    reason: input.reason,
    recordedAt: input.now,
  };
  checkedReference(row);
  if (previous !== undefined) {
    const retained = checkedReference(previous);
    if (
      retained.kind !== row.kind ||
      retained.period !== row.period ||
      retained.cents !== row.cents ||
      retained.operator !== row.operator ||
      retained.reason !== row.reason
    )
      throw new HttpError(
        409,
        "This reference already records a different action.",
      );
    return standardPlanView(storage, input.now);
  }
  const period = await readPeriod(storage, input.period),
    plan = await readPlan(storage);
  const monthly = await periodMonthlyDebt(storage, period);
  if (
    input.cents >
    period.chargedCents -
      period.paidCents +
      monthly.chargedCents -
      monthly.paidCents
  )
    throw new HttpError(
      409,
      "Record only this period's received debt payment.",
    );
  const monthlyPaid = await payMonthlyDebt(storage, period.id, input.cents);
  period.paidCents += input.cents - monthlyPaid;
  plan.paidCents += input.cents - monthlyPaid;
  await savePeriod(storage, period);
  await storage.put(STANDARD_PLAN_KEY, plan);
  await storage.put(key, row);
  return standardPlanView(storage, input.now);
}
/** Apply cash to posted debt inside the same Room transaction. Captured prices and debt access stay unchanged. */
export async function payStandardDebtFromCredit(
  storage: Writer & Pick<Storage, "list">,
  now: number,
) {
  if (!natural(now)) throw fail();
  const plan = await readPlan(storage);
  const monthlyTotals = await readMonthlyDebt(storage);
  if (
    plan.chargedCents === plan.paidCents &&
    monthlyTotals.chargedCents === monthlyTotals.paidCents
  )
    return 0;
  let cash =
    BigInt((await readPrepaidAccount(storage)).cashAvailableUsdNanos) /
    10_000_000n;
  if (cash === 0n) return 0;
  const rows = await storage.list({
    prefix: STANDARD_PERIOD_PREFIX,
    limit: 5_001,
  });
  if (rows.size > 5_000) throw fail();
  let applied = 0;
  for (const [key, value] of rows) {
    const period = await storedPeriod(storage, value);
    if (key !== STANDARD_PERIOD_PREFIX + period.id) throw fail();
    const monthly = await periodMonthlyDebt(storage, period);
    const due =
      period.chargedCents -
      period.paidCents +
      monthly.chargedCents -
      monthly.paidCents;
    if (due === 0) continue;
    const cents = Number(cash < BigInt(due) ? cash : BigInt(due));
    const referenceId = `${CASH_DEBT_REFERENCE}${period.id}:${period.paidCents + monthly.paidCents + cents}`;
    const debit = await debitPrepaid(storage, {
      referenceId,
      amountUsdNanos: (BigInt(cents) * 10_000_000n).toString(),
      at: now,
    });
    if (!debit.debited) throw fail();
    const monthlyPaid = await payMonthlyDebt(storage, period.id, cents);
    period.paidCents += cents - monthlyPaid;
    plan.paidCents += cents - monthlyPaid;
    applied += cents;
    cash -= BigInt(cents);
    checkedPeriod(period);
    checkedPlan(plan);
    await savePeriod(storage, period);
    await storage.put(STANDARD_PLAN_KEY, plan);
    if (cash === 0n) break;
  }
  return applied;
}

function checkedCashDebtPayment(
  key: string,
  value: unknown,
): StandardCashPayment {
  const match = /^product-prepaid-debit-v1:standard-debt:(\d{16}):(\d+)$/.exec(
    key,
  );
  if (
    !match ||
    !object(value) ||
    !exact(value, ["referenceId", "amountUsdNanos", "at"]) ||
    value.referenceId !== key.slice("product-prepaid-debit-v1:".length) ||
    !nanos(value.amountUsdNanos) ||
    !natural(value.at)
  )
    throw fail();
  const amount = BigInt(value.amountUsdNanos);
  const cents = Number(amount / 10_000_000n);
  if (
    !natural(cents) ||
    cents === 0 ||
    amount % 10_000_000n !== 0n ||
    !natural(Number(match[2])) ||
    cents > Number(match[2])
  )
    throw fail();
  return {
    referenceId: value.referenceId as string,
    period: match[1],
    cents,
    recordedAt: value.at as number,
  };
}

export async function revokeStandardPeriod(
  storage: Storage,
  id: unknown,
  now: number,
) {
  const plan = await readPlan(storage, now);
  if (!periodId(id) || plan.currentPeriod !== id)
    throw new HttpError(409, "Read the current monthly period.");
  const period = await readPeriod(storage, id);
  const firstMonth = period.annual?.month ?? 0;
  const lastMonth = period.annual ? PRODUCT_ANNUAL_PRICES.months - 1 : 0;
  for (let month = firstMonth; month <= lastMonth; month++) {
    const window = month === firstMonth ? period :
      await readPeriod(storage, pad(billingMonthBoundary(period.annual!.startsAt, month)));
    if (window.paymentId !== period.paymentId) throw fail();
    window.revokedAt ??= now;
    await savePeriod(storage, window);
  }
  return standardPlanView(storage, now);
}
type AiCase = {
  schema: 1;
  scriptedProducer: StandardMonthlySyntheticProducer | null;
  ref: string;
  period: string;
  answeredAt: number | null;
  confirmedAt: number | null;
  countedAt: number | null;
  chargedCents: number;
  humanReplied: boolean;
  managed: boolean;
  dueAt: number | null;
  finalAt: number | null;
};
function checkedCase(value: unknown): AiCase {
  if (
    !object(value) ||
    !exact(value, [
      "schema",
      "scriptedProducer",
      "ref",
      "period",
      "answeredAt",
      "confirmedAt",
      "countedAt",
      "chargedCents",
      "humanReplied",
      "managed",
      "dueAt",
      "finalAt",
    ]) ||
    value.schema !== 1 ||
    typeof value.ref !== "string" ||
    !/^[0-9a-f]{16}$/.test(value.ref) ||
    !periodId(value.period) ||
    !(value.answeredAt === null || natural(value.answeredAt)) ||
    typeof value.humanReplied !== "boolean" ||
    typeof value.managed !== "boolean" ||
    !(value.dueAt === null || natural(value.dueAt)) ||
    !(value.finalAt === null || natural(value.finalAt)) ||
    !(value.confirmedAt === null || natural(value.confirmedAt)) ||
    !(value.countedAt === null || natural(value.countedAt)) ||
    !natural(value.chargedCents) ||
    (value.countedAt === null
      ? value.chargedCents !== 0
      : value.countedAt !== value.finalAt ||
        value.dueAt !== null ||
        value.confirmedAt === null ||
        Number(value.countedAt) <
          Number(value.confirmedAt) +
            PRODUCT_RESOLUTION_RULES.memberFinalHours * 3_600_000) ||
    (value.dueAt !== null &&
      (value.confirmedAt === null ||
        Number(value.dueAt) <
          Number(value.confirmedAt) +
            PRODUCT_RESOLUTION_RULES.memberFinalHours * 3_600_000))
  )
    throw fail();
  checkedStandardMonthlySyntheticProducer(value.scriptedProducer);
  return value as AiCase;
}
/** The server identifies Templ AI; clients cannot nominate a billed principal or final timestamp. */
export async function standardCaseEvent(
  storage: Storage,
  ref: string,
  c: SupportCase,
  input: {
    at: number;
    templAnswer?: boolean;
    scriptedProducer?: StandardMonthlySyntheticProducer | null;
    managed?: boolean;
    humanReply?: boolean;
    unsupportedReply?: boolean;
    reopened?: boolean;
    memberConfirmed?: boolean;
  },
) {
  const stored = await storage.get<unknown>(CASE + ref);
  let record = stored === undefined ? null : checkedCase(stored);
  if (record?.finalAt !== null && record !== null) return;
  if (input.templAnswer && !c.excluded.length && !c.billingExclusion) {
    const view = await standardPlanView(storage, input.at);
    if (
      view.status === "paid" &&
      view.period &&
      !view.period.usage &&
      !(await activeProductOrderForm(storage, input.at))
    )
      record = {
        schema: 1,
        scriptedProducer: checkedStandardMonthlySyntheticProducer(
          input.scriptedProducer ?? null,
        ),
        ref,
        period: view.period.id,
        answeredAt: input.at,
        confirmedAt: null,
        countedAt: null,
        chargedCents: 0,
        humanReplied: record?.humanReplied ?? c.counts.humanReplies > 0,
        managed: input.managed === true || record?.managed === true,
        dueAt: null,
        finalAt: null,
      };
  }
  if (!record) return;
  if (input.humanReply) record.humanReplied = true;
  if (input.unsupportedReply) record.answeredAt = null;
  if (
    input.reopened ||
    input.humanReply ||
    input.unsupportedReply ||
    c.handoffAt !== null ||
    c.handoffOpen ||
    c.excluded.length ||
    c.billingExclusion
  ) {
    record.dueAt = null;
    record.confirmedAt = null;
  } else if (
    input.memberConfirmed &&
    !record.humanReplied &&
    record.answeredAt !== null &&
    c.resolvedAt !== null &&
    record.answeredAt <= c.resolvedAt
  ) {
    record.confirmedAt ??= input.at;
    record.dueAt ??=
      record.confirmedAt +
      PRODUCT_RESOLUTION_RULES.memberFinalHours * 3_600_000;
  }
  await storage.put(CASE + ref, record);
  if (record.dueAt !== null) {
    await storage.put(DUE + pad(record.dueAt) + ":" + ref, true);
    await wakeRoomAt(storage, record.dueAt);
  }
}
export async function finalizeStandardAiCases(
  storage: Storage,
  now: number,
  env: WorkspaceFlagEnv = {},
) {
  const due = await storage.list({
    prefix: DUE,
    end: DUE + pad(now + 1),
    limit: 100,
  });
  for (const key of due.keys()) {
    const ref = key.slice(-16),
      stored = await storage.get(CASE + ref);
    await storage.delete(key);
    if (stored === undefined) continue;
    const record = checkedCase(stored);
    if (
      record.ref !== ref ||
      record.dueAt === null ||
      record.dueAt > now ||
      record.finalAt !== null ||
      key !== DUE + pad(record.dueAt) + ":" + ref
    )
      continue;
    const period = await readPeriod(storage, record.period),
      plan = await readPlan(storage);
    if (period.usage) throw fail();
    const nextCharged =
      Math.max(
        0,
        period.confirmedAiResolutions + 1 - period.includedAiResolutions,
      ) * period.additionalAiResolutionCents;
    const qualified =
      record.scriptedProducer !== null
        ? !record.managed &&
          (await standardMonthlySyntheticLedgerOn(
            storage,
            env,
            now,
            record.scriptedProducer,
            period,
            plan.chargedCents,
            plan.paidCents,
            nextCharged - period.chargedCents,
          ))
        : (await featureOn(env, storage, "standardMonthlyBilling")) &&
          (await featureOn(env, storage, "manualBilling")) &&
          (await featureOn(env, storage, "usageAiResolution")) &&
          (!record.managed || (await managedResolutionBillingOn(env, storage)));
    if (!qualified) {
      record.dueAt = now + 60_000;
      await storage.put(CASE + ref, record);
      await storage.put(DUE + pad(record.dueAt) + ":" + ref, true);
      continue;
    }
    if (
      record.answeredAt === null ||
      record.confirmedAt === null ||
      record.answeredAt > record.confirmedAt ||
      record.humanReplied ||
      record.answeredAt < period.startsAt ||
      record.answeredAt >= period.endsAt
    )
      throw fail();
    period.confirmedAiResolutions++;
    const charged =
      Math.max(
        0,
        period.confirmedAiResolutions - period.includedAiResolutions,
      ) * period.additionalAiResolutionCents;
    record.chargedCents = charged - period.chargedCents;
    plan.chargedCents += record.chargedCents;
    period.chargedCents = charged;
    record.finalAt = now;
    record.countedAt = now;
    record.dueAt = null;
    await savePeriod(storage, period);
    await storage.put(STANDARD_PLAN_KEY, plan);
    await storage.put(CASE + ref, record);
  }
  const next = await storage.list({ prefix: DUE, limit: 1 });
  await payStandardDebtFromCredit(storage, now);
  return next.size
    ? Number([...next.keys()][0].slice(DUE.length, DUE.length + 16))
    : null;
}

/** The global claim uses the amount retained with this same manual reference. */
export async function standardReferenceCents(
  storage: Reader,
  referenceSha256: unknown,
) {
  if (!hash(referenceSha256)) throw fail();
  return checkedReference(await storage.get(REFERENCE + referenceSha256)).cents;
}

/** Financial metadata only. A partial read never certifies all retained usage. */
export async function standardPlanRecords(
  storage: Reader & Pick<Storage, "list">,
): Promise<StandardPlanRecords> {
  const limit = 5_000;
  const periods = await storage.list({
    prefix: STANDARD_PERIOD_PREFIX,
    limit: limit + 1,
  });
  const references = await storage.list({
    prefix: REFERENCE,
    limit: limit + 1,
  });
  const cases = await storage.list({ prefix: CASE, limit: limit + 1 });
  const usageReviews = await storage.list({
    prefix: STANDARD_USAGE_REVIEW_PREFIX,
    limit: limit + 1,
  });
  const periodRows = await Promise.all([...periods].slice(0, limit).map(async ([key, value]) => {
    const row = await storedPeriod(storage, value);
    if (key !== STANDARD_PERIOD_PREFIX + row.id) throw fail();
    return row;
  }));
  const periodById = new Map(periodRows.map((row) => [row.id, row]));
  const cashPayments = await storage.list({
    prefix: CASH_DEBT_DEBIT,
    limit: limit + 1,
  });
  return {
    periods: await Promise.all(
      periodRows.map((period) => monthlyDebtPeriodView(storage, period)),
    ),
    cashPayments: [...cashPayments]
      .slice(0, limit)
      .map(([key, value]) => checkedCashDebtPayment(key, value)),
    references: [...references].slice(0, limit).map(([key, value]) => {
      const referenceSha256 = key.slice(REFERENCE.length);
      if (!hash(referenceSha256)) throw fail();
      return { ...checkedReference(value), referenceSha256 };
    }),
    cases: [...cases].slice(0, limit).map(([key, value]) => {
      const { schema: _, scriptedProducer: __, ...row } = checkedCase(value);
      if (key !== CASE + row.ref) throw fail();
      return {
        ...row,
        status:
          row.countedAt !== null
            ? "counted"
            : row.finalAt !== null || row.dueAt === null
              ? "void"
              : "pending",
      };
    }),
    usageReviews: await Promise.all(
      [...usageReviews].slice(0, limit).map(async ([key, value]) => {
        if (!object(value) || typeof value.period !== "string") throw fail();
        const period = periodById.get(value.period);
        if (!period) throw fail();
        const row = await checkedUsageReview(value, period);
        if (key !== STANDARD_USAGE_REVIEW_PREFIX + row.referenceSha256)
          throw fail();
        return row;
      }),
    ),
    partial:
      periods.size > limit ||
      references.size > limit ||
      cases.size > limit ||
      usageReviews.size > limit ||
      cashPayments.size > limit,
    cursor: null,
  };
}
export async function standardCashCents(
  storage: Pick<Storage, "list">,
  from: number,
  to: number,
) {
  const rows = await storage.list({ prefix: REFERENCE, limit: 5_001 });
  if (rows.size > 5_000) throw fail();
  return [...rows].reduce((sum, [key, value]) => {
    if (!hash(key.slice(REFERENCE.length))) throw fail();
    const row = checkedReference(value);
    return (
      sum + (row.recordedAt >= from && row.recordedAt < to ? row.cents : 0)
    );
  }, 0);
}
/** Retained dated periods with outstanding AI debt. */
export async function standardDebtPeriods(
  storage: Reader & Pick<Storage, "list">,
) {
  const periods = await storage.list({ prefix: STANDARD_PERIOD_PREFIX });
  return (
    await Promise.all(
      [...periods].map(async ([key, value]) => {
        const period = await storedPeriod(storage, value);
        if (key !== STANDARD_PERIOD_PREFIX + period.id) throw fail();
        return monthlyDebtPeriodView(storage, period);
      }),
    )
  ).filter((period) => period.chargedCents > period.paidCents);
}

async function dropStandardPending(storage: Storage, now: number) {
  const due = await storage.list({ prefix: DUE, limit: 100 });
  for (const key of due.keys()) {
    const ref = key.slice(-16),
      stored = await storage.get(CASE + ref);
    if (stored === undefined) {
      await storage.delete(key);
      continue;
    }
    const record = checkedCase(stored);
    if (record.finalAt === null) {
      record.finalAt = now;
      record.dueAt = null;
      await storage.put(CASE + ref, record);
    }
    await storage.delete(key);
  }
  return due.size === 100;
}

/** The purge retains access provenance, posted counters and received-payment references. */
export async function standardDeletionSummary(storage: Storage, now: number) {
  if ((await storage.get(STANDARD_PLAN_KEY)) === undefined) return undefined;
  while (await dropStandardPending(storage, now));
  return {
    plan: checkedPlan(await storage.get(STANDARD_PLAN_KEY)),
    periods: await Promise.all([
      ...(await storage.list({ prefix: STANDARD_PERIOD_PREFIX })).values(),
    ].map(value => storedPeriod(storage, value))),
    references: Object.fromEntries(await storage.list({ prefix: REFERENCE })),
    usageReviews: Object.fromEntries(
      await storage.list({ prefix: STANDARD_USAGE_REVIEW_PREFIX }),
    ),
  };
}
