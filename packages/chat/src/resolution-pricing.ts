/** Resolved-case pricing. Public prices, bonus credit and alert limits come
 * from plans.ts. Signed order forms can supply a workspace's price table.
 * Amounts are USD cents. */
import {
  PRODUCT_AI_ONLY_RESOLUTION_PRICE,
  PRODUCT_BALANCE_ALERTS,
  PRODUCT_FOUNDING_CREDIT,
  PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
  PRODUCT_RESOLUTION_PRICE,
  PRODUCT_RESOLUTION_RULES,
  PRODUCT_TOP_UP,
} from "./plans";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** One step of the monthly price table: the billable cases from `fromCase`
 * to `toCase` (inclusive; null for no end) in a UTC calendar month each cost
 * `usdCents`. */
export type ResolutionPriceStep = {
  fromCase: number;
  toCase: number | null;
  usdCents: number;
};

/** AI-only cases use a fixed rate. Team-handled cases use monthly price steps. */
export type ResolutionPriceTable = {
  /** Price for a resolved case without a human staff reply. */
  aiOnlyUsdCents: number;
  usdCents: number;
  stepOneAfterCases: number;
  stepOneUsdCents: number;
};

/** The price table in plans.ts. */
export function resolutionPriceTable(): ResolutionPriceTable {
  const price = PRODUCT_RESOLUTION_PRICE;
  return {
    aiOnlyUsdCents: PRODUCT_AI_ONLY_RESOLUTION_PRICE.usdCents,
    usdCents: price.usdCents,
    stepOneAfterCases: price.stepOneAfterCases,
    stepOneUsdCents: price.stepOneUsdCents,
  };
}

/** A table's steps, cheapest volume last. */
export function priceTableSteps(
  table: ResolutionPriceTable,
): ResolutionPriceStep[] {
  return [
    { fromCase: 1, toCase: table.stepOneAfterCases, usdCents: table.usdCents },
    {
      fromCase: table.stepOneAfterCases + 1,
      toCase: null,
      usdCents: table.stepOneUsdCents,
    },
  ];
}

/** The graduated price table of plans.ts, cheapest volume last. */
export function resolutionPriceSteps(): ResolutionPriceStep[] {
  return priceTableSteps(resolutionPriceTable());
}

const wholeCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Under `table`, the price of the next billable case to go final in a UTC
 * month, given the billable cases already final in that month. Earlier
 * cases keep their price. */
export function priceTableCents(
  table: ResolutionPriceTable,
  finalBefore: number,
): number {
  if (!wholeCount(finalBefore)) throw new RangeError("finalBefore");
  const next = finalBefore + 1;
  return priceTableSteps(table).find(
    ({ toCase }) => toCase === null || next <= toCase,
  )!.usdCents;
}

/** `priceTableCents` under the offer in plans.ts. */
export function resolvedCasePriceCents(finalBefore: number): number {
  return priceTableCents(resolutionPriceTable(), finalBefore);
}

/** Whether moving from table `from` to table `to` makes any case cost
 * more. A price is a step function of the month's count, so checking each
 * step start of both tables covers every count. */
export function priceTableRaises(
  from: ResolutionPriceTable,
  to: ResolutionPriceTable,
): boolean {
  const starts = [0, from.stepOneAfterCases, to.stepOneAfterCases];
  return (
    starts.some(
      (count) => priceTableCents(to, count) > priceTableCents(from, count),
    ) || to.aiOnlyUsdCents > from.aiOnlyUsdCents
  );
}

/** Whether a value is a well-formed price table. */
export function isPriceTable(
  value: unknown,
  variant: "public" | "order-form" = "public",
): value is ResolutionPriceTable {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const table = value as Record<string, unknown>;
  const keys = [
    "aiOnlyUsdCents",
    "stepOneAfterCases",
    "stepOneUsdCents",
    "usdCents",
  ];
  return (
    Object.keys(table).sort().join() === keys.join() &&
    keys.every(
      (key) => Number.isSafeInteger(table[key]) && (table[key] as number) > 0,
    ) &&
    (variant === "order-form"
      ? (table.stepOneUsdCents as number) <= (table.usdCents as number) &&
        (table.usdCents as number) <= 10_000 &&
        (table.aiOnlyUsdCents as number) <= 10_000
      : (table.stepOneUsdCents as number) < (table.usdCents as number))
  );
}

/** Reads stored tables with the current AI-only rate when that field is absent.
 * New price inputs must pass isPriceTable without normalization. */
export function normalizeStoredPriceTable(
  value: unknown,
  variant: "public" | "order-form" = "public",
): ResolutionPriceTable | null {
  if (isPriceTable(value, variant)) return { ...value };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const table = value as Record<string, unknown>;
  if (
    Object.keys(table).sort().join() !==
    "stepOneAfterCases,stepOneUsdCents,usdCents"
  )
    return null;
  const normalized = {
    ...table,
    aiOnlyUsdCents: PRODUCT_AI_ONLY_RESOLUTION_PRICE.usdCents,
  };
  return isPriceTable(normalized, variant) ? normalized : null;
}

/** The total for `cases` billable cases final in one UTC month, each at the
 * step it falls in. */
export function resolvedCasesCents(cases: number): number {
  if (!wholeCount(cases)) throw new RangeError("cases");
  let total = 0;
  for (const { fromCase, toCase, usdCents } of resolutionPriceSteps()) {
    if (cases < fromCase) break;
    const last = toCase === null ? cases : Math.min(cases, toCase);
    total += (last - fromCase + 1) * usdCents;
  }
  return total;
}

/** Whether a price falls with volume: the pricing line names the volume
 * step only while it costs less. */
export function resolutionPriceFalls(): boolean {
  const [first, ...later] = resolutionPriceSteps();
  return later.some(({ usdCents }) => usdCents < first.usdCents);
}

/** Whether a month's billable cases are past the custom threshold, where
 * the Plan tab says "Talk to us". */
export function resolutionCustomVolume(casesPerMonth: number): boolean {
  return casesPerMonth > PRODUCT_RESOLUTION_PRICE.customAboveCasesPerMonth;
}

/** A top-up the Plan tab can request: whole dollars between the minimum and
 * the maximum. Anything else is null. */
export function productTopUp(
  usdCents: unknown,
): { kind: "top-up"; usdCents: number } | null {
  const top = PRODUCT_TOP_UP;
  if (
    typeof usdCents !== "number" ||
    !Number.isSafeInteger(usdCents) ||
    usdCents < top.minUsdCents ||
    usdCents > top.maxUsdCents ||
    usdCents % top.stepUsdCents !== 0
  )
    return null;
  return { kind: "top-up", usdCents };
}

/** Bonus credit for a verified top-up of `paidCents` onto a balance of
 * `balanceBeforeCents` (negative when owed). Only the part left after the
 * balance reaches zero earns it, at the step that part reaches. */
export function topUpBonusCents(
  paidCents: number,
  balanceBeforeCents: number,
): number {
  if (!wholeCount(paidCents)) throw new RangeError("paidCents");
  if (!Number.isSafeInteger(balanceBeforeCents))
    throw new RangeError("balanceBeforeCents");
  const top = PRODUCT_TOP_UP;
  const eligible = paidCents - Math.max(0, -balanceBeforeCents);
  if (eligible <= 0) return 0;
  const percent =
    eligible >= top.bonusTwentyFromUsdCents
      ? top.bonusTwentyPercent
      : eligible >= top.bonusTenFromUsdCents
        ? top.bonusTenPercent
        : 0;
  return Math.floor((eligible * percent) / 100);
}

/** The balance levels billing managers hear about. `pause-soon` and
 * `paused` reach only a workspace that has never been funded. */
export type ProductBalanceLevel =
  | "used-80"
  | "used-100"
  | "negative"
  | "pause-soon"
  | "paused";

/** Whether a workspace is paused for its balance: it has never had a
 * verified top-up or a reviewed grant (`everFunded` false) and its signed
 * balance is at or below minus the free negative limit. A funded workspace
 * is never paused for its balance. */
export function freeWorkspacePaused(
  balanceCents: number,
  everFunded: boolean,
): boolean {
  if (!Number.isSafeInteger(balanceCents)) throw new RangeError("balanceCents");
  return !everFunded && balanceCents <= -PRODUCT_FREE_NEGATIVE_LIMIT_CENTS;
}

/** The most serious balance level reached. `creditBaseCents` is the
 * available amount right after the latest credit; `availableCents` is the
 * balance less pending and confirmed charges; `balanceCents` is the signed
 * balance; `everFunded` is true once the workspace or its billing owner has
 * a verified top-up or a reviewed grant; `paused` is the workspace's
 * recorded pause, which a later credit alone doesn't lift; `pauseWaived` is
 * an operator's lift, after which only the negative level applies. The used
 * levels count against a credit, so a workspace with no credit hears only
 * about a negative balance. Null while no level is reached. */
export function productBalanceLevel(state: {
  creditBaseCents: number;
  availableCents: number;
  balanceCents: number;
  everFunded: boolean;
  paused: boolean;
  pauseWaived: boolean;
}): ProductBalanceLevel | null {
  const pausable = !state.everFunded && !state.pauseWaived;
  if (
    pausable &&
    (state.paused || freeWorkspacePaused(state.balanceCents, state.everFunded))
  )
    return "paused";
  if (pausable && state.balanceCents <= -PRODUCT_BALANCE_ALERTS.pauseSoonCents)
    return "pause-soon";
  if (state.balanceCents < 0) return "negative";
  if (state.creditBaseCents <= 0) return null;
  if (state.availableCents <= 0) return "used-100";
  const left = 100 - PRODUCT_BALANCE_ALERTS.usedPercent;
  if (state.availableCents * 100 < state.creditBaseCents * left)
    return "used-80";
  return null;
}

/** When the next reminder for a negative balance is due, from the last one
 * sent. */
export function negativeBalanceReminderAt(lastSentAt: number): number {
  return lastSentAt + PRODUCT_BALANCE_ALERTS.negativeReminderDays * DAY_MS;
}

/** When a charge goes final: a team resolve after `finalAfterDays` with no
 * reopen, a member's "solved" after the `memberFinalHours` hold. */
export function chargeFinalDueAt(
  closer: "team" | "member",
  resolvedAt: number,
): number {
  const rules = PRODUCT_RESOLUTION_RULES;
  return closer === "member"
    ? resolvedAt + rules.memberFinalHours * HOUR_MS
    : resolvedAt + rules.finalAfterDays * DAY_MS;
}

/** The last moment a billing manager can dispute a charge that went final
 * at `finalAt`. */
export function chargeDisputeUntil(finalAt: number): number {
  return finalAt + PRODUCT_RESOLUTION_RULES.disputeDays * DAY_MS;
}

/** Disputes credited automatically in one UTC month: the larger of the
 * minimum and the percentage of the previous 30 days' final charges. */
export function autoCreditAllowance(finalChargesLast30Days: number): number {
  if (!wholeCount(finalChargesLast30Days))
    throw new RangeError("finalChargesLast30Days");
  const rules = PRODUCT_RESOLUTION_RULES;
  return Math.max(
    rules.autoCreditMinimum,
    Math.floor((finalChargesLast30Days * rules.autoCreditPercent) / 100),
  );
}

/** Whether a UTC day's new pending and confirmed charges are a burst
 * against the trailing 30-day daily average. */
export function chargeBurst(today: number, dailyAverage: number): boolean {
  const rules = PRODUCT_RESOLUTION_RULES;
  return (
    today >= rules.burstMinimum && today > rules.burstMultiple * dailyAverage
  );
}

/** When a founding grant that starts at `startsAt` ends. */
export function foundingCreditEndsAt(startsAt: number): number {
  return startsAt + PRODUCT_FOUNDING_CREDIT.days * DAY_MS;
}

/** The earliest moment a price table published at `publishedAt` can apply:
 * charges that go pending from then on use it. */
export function priceChangeAppliesAt(publishedAt: number): number {
  return publishedAt + PRODUCT_RESOLUTION_PRICE.priceNoticeDays * DAY_MS;
}

/** The UTC calendar month a charge's step is counted in, as `yyyymm`. */
export function resolutionMonth(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new RangeError("at");
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
