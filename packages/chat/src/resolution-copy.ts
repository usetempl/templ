/** The resolved-case offer in words, for the web, the blog, the docs and
 * Templ's own support agent. Every number comes from plans.ts; this module
 * only formats it, so the lines read the same everywhere. */
import {
  PRODUCT_AI_ONLY_RESOLUTION_PRICE,
  PRODUCT_BALANCE_ALERTS,
  PRODUCT_FOUNDING_CREDIT,
  PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
  PRODUCT_FREE_START,
  PRODUCT_RESOLUTION_PRICE,
  PRODUCT_RESOLUTION_RULES,
  PRODUCT_TOP_UP,
} from "./plans";
import {
  priceTableSteps,
  resolutionPriceFalls,
  resolutionPriceSteps,
  type ResolutionPriceStep,
  type ResolutionPriceTable,
} from "./resolution-pricing";

const count = (value: number) => value.toLocaleString("en-US");

/** 800 -> "$8"; 750 -> "$7.50"; 150000 -> "$1,500". */
export function formatUsdCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0)
    throw new RangeError("USD cents must be a non-negative number");
  const whole = Math.floor(cents / 100);
  const remainder = Math.round(cents - whole * 100);
  const dollars = whole.toLocaleString("en-US");
  return remainder === 0
    ? `$${dollars}`
    : `$${dollars}.${String(remainder).padStart(2, "0")}`;
}

/** A signed balance: -2400 -> "-$24"; 1250 -> "$12.50". */
export function formatBalanceCents(cents: number): string {
  if (!Number.isFinite(cents)) throw new RangeError("USD cents must be finite");
  return cents < 0 ? `-${formatUsdCents(-cents)}` : formatUsdCents(cents);
}

/** The free start applies only to eligible cases with a human staff reply. */
export function freeStartLine(): string {
  const cases: number = PRODUCT_FREE_START.resolvedCases;
  return cases === 1
    ? "Your first eligible team-handled case is free."
    : `Your first ${count(cases)} eligible team-handled cases are free.`;
}

/** Only team-handled cases advance the monthly price step. */
export function casePriceLine(): string {
  const [first, volume] = resolutionPriceSteps();
  const price = formatUsdCents(first.usdCents);
  return resolutionPriceFalls() && volume && first.toCase !== null
    ? `Then ${price} per team-handled case, ${formatUsdCents(volume.usdCents)} after ${count(first.toCase)} team-handled cases in a month.`
    : `Then ${price} per team-handled case.`;
}

/** The team-handled table in words, including its lower monthly price. */
export function stepsPriceWords(steps: ResolutionPriceStep[]): string {
  const [first, volume] = steps;
  const price = formatUsdCents(first.usdCents);
  return volume && first.toCase !== null && volume.usdCents < first.usdCents
    ? `${price} each, and ${formatUsdCents(volume.usdCents)} after ${count(first.toCase)} team-handled cases in a month`
    : `${price} each`;
}
/** `stepsPriceWords` for a stored table. */
export function tablePriceWords(table: ResolutionPriceTable): string {
  return stepsPriceWords(priceTableSteps(table));
}

/** The contribution required before a resolved case can bill. */
export const BILLABLE_CASE_LINE =
  "Pay only for resolved cases with a transaction check, a verified wallet, or an AI answer.";

/** The AI-only rate applies from the first eligible case. */
export function aiOnlyPriceLine(
  usdCents: number = PRODUCT_AI_ONLY_RESOLUTION_PRICE.usdCents,
): string {
  return `${formatUsdCents(usdCents)} per AI-only case.`;
}

/** The AI-only rate for components that render a fixed offer line. */
export const AI_ONLY_PRICE_LINE = aiOnlyPriceLine();

/** Recorded human staff replies determine whether a case is AI-only. */
export const AI_ONLY_DEFINITION =
  "AI-only means the case resolved without a human staff reply.";

/** The free start, both case prices and billing requirement. */
export function pricingLine(): string {
  return `${freeStartLine()} ${casePriceLine()} ${aiOnlyPriceLine()} ${BILLABLE_CASE_LINE}`;
}

/** "If you haven’t added balance yet, support pauses at -$20 and comes back
 * when you top up." */
export function pauseLine(): string {
  return `If you haven’t added balance yet, support pauses at -${formatUsdCents(PRODUCT_FREE_NEGATIVE_LIMIT_CENTS)} and comes back when you top up.`;
}

/** "A workspace that never added balance and never held a grant pauses at
 * -$20." */
export function neverFundedPauseLine(): string {
  return `A workspace that never added balance and never held a grant pauses at ${formatBalanceCents(-PRODUCT_FREE_NEGATIVE_LIMIT_CENTS)}.`;
}

/** Said beside the pricing line: nothing is charged per person on the
 * team. */
export const NO_SEATS = "No seats.";

/** What counts as resolved. */
export const RESOLUTION_DEFINITION =
  "A case is resolved when your team marks it resolved or the user says it’s solved.";

/** One row of the price table: `cases` "1–100" or "101 and up"; `price`
 * "$8". */
export type PriceStepRow = { cases: string; price: string };

/** A graduated table, one row per step: the offer's, or the one a
 * workspace pays now. */
export function priceSteps(
  steps: ResolutionPriceStep[] = resolutionPriceSteps(),
): PriceStepRow[] {
  return steps.map(({ fromCase, toCase, usdCents }) => ({
    cases:
      toCase === null
        ? `${count(fromCase)} and up`
        : `${count(fromCase)}–${count(toCase)}`,
    price: formatUsdCents(usdCents),
  }));
}

/** The custom price invitation. */
export const CUSTOM_PRICING_LINE =
  "Custom pricing for bigger teams. Talk to us.";

/** When an explicit resolution becomes a final charge. */
export function finalChargeLines(): { team: string; user: string } {
  return {
    team: `A team resolution becomes final after ${count(PRODUCT_RESOLUTION_RULES.finalAfterDays)} days without a reopen.`,
    user: `A user's “solved” answer becomes final after ${count(PRODUCT_RESOLUTION_RULES.memberFinalHours)} hours.`,
  };
}

/** A reviewed grant's case allowance and end. */
export function foundingCreditLine(): string {
  return `Reviewed founding credit covers ${count(PRODUCT_FOUNDING_CREDIT.cases)} resolved cases. It ends when used or ${count(PRODUCT_FOUNDING_CREDIT.days)} days after it starts.`;
}

/** Balance alerts use the balance available after the latest credit. */
export function balanceAlertsLine(): string {
  const allUsed = new Intl.NumberFormat("en-US", { style: "percent" }).format(
    1,
  );
  return `Billing managers get alerts at ${count(PRODUCT_BALANCE_ALERTS.usedPercent)}% used, ${allUsed} used and below zero.`;
}

/** Notice required before a higher price can apply. */
export function priceIncreaseNoticeLine(): string {
  return `A higher price applies only after ${count(PRODUCT_RESOLUTION_PRICE.priceNoticeDays)} days' notice.`;
}

/** Any billing use of copies requires advance notice. */
export function copyBillingNoticeLine(): string {
  return `Templ gives ${count(PRODUCT_RESOLUTION_PRICE.priceNoticeDays)} days' notice before copies could ever affect billing.`;
}

/** The time a billing manager has to dispute a final charge. */
export function disputeWindowLine(): string {
  return `A billing manager can dispute a final charge within ${count(PRODUCT_RESOLUTION_RULES.disputeDays)} days.`;
}

/** Only the paid part within this window can qualify for a refund. */
export function refundWindowLine(): string {
  return `Refunds cover the unused paid part of top-ups younger than ${count(PRODUCT_TOP_UP.refundWindowDays)} days.`;
}

/** "Top up $100 to $10,000, in whole dollars." */
export const TOP_UP_BOUNDS = `Top up ${formatUsdCents(PRODUCT_TOP_UP.minUsdCents)} to ${formatUsdCents(PRODUCT_TOP_UP.maxUsdCents)}, in whole dollars.`;

/** "+10% credit from $2,000, +20% at $10,000." */
export const TOP_UP_BONUS = `+${PRODUCT_TOP_UP.bonusTenPercent}% credit from ${formatUsdCents(PRODUCT_TOP_UP.bonusTenFromUsdCents)}, +${PRODUCT_TOP_UP.bonusTwentyPercent}% at ${formatUsdCents(PRODUCT_TOP_UP.bonusTwentyFromUsdCents)}.`;
