import { PRODUCT_STANDARD_AI_RATES, PRODUCT_STANDARD_PRICES } from "./plans";

/** Counts from one completed Standard-tier API request, before aggregation. */
export type StandardAiTokenUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens?: number | null;
};

const TOKEN_LIMIT = 1_000_000_000_000;
const MAX_NANOS = 10n ** 30n - 1n;
const PER_MILLION = 1_000_000n;
const NANOS_PER_CENT = BigInt(PRODUCT_STANDARD_AI_RATES.usdNanosPerCent);
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const tokenCount = (value: unknown): value is number =>
  nonnegativeInteger(value) && value <= TOKEN_LIMIT;

/** A recorded integer multiplier remains unchanged. New terms capture exact basis points. */
export type StandardAiRate =
  | { aiRateMultiplier: number; aiRateBasisPoints?: never }
  | { aiRateBasisPoints: number; aiRateMultiplier?: never };

export function checkedStandardAiRate<T>(
  value: T,
): value is T & StandardAiRate {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const multiplier = Object.prototype.hasOwnProperty.call(
    row,
    "aiRateMultiplier",
  );
  const basisPoints = Object.prototype.hasOwnProperty.call(
    row,
    "aiRateBasisPoints",
  );
  return (
    multiplier !== basisPoints &&
    (multiplier
      ? nonnegativeInteger(row.aiRateMultiplier) && row.aiRateMultiplier > 0
      : nonnegativeInteger(row.aiRateBasisPoints) && row.aiRateBasisPoints > 0)
  );
}

/** Copy only the captured rate, preserving the original record's representation. */
export function captureStandardAiRate(value: StandardAiRate): StandardAiRate {
  if (!checkedStandardAiRate(value))
    throw new RangeError("Invalid captured AI rate");
  return Object.prototype.hasOwnProperty.call(value, "aiRateBasisPoints")
    ? { aiRateBasisPoints: value.aiRateBasisPoints! }
    : { aiRateMultiplier: value.aiRateMultiplier! };
}

export function formatStandardAiRate(value: StandardAiRate): string {
  if (!checkedStandardAiRate(value))
    throw new RangeError("Invalid captured AI rate");
  if (value.aiRateBasisPoints === undefined)
    return String(value.aiRateMultiplier);
  const rate = BigInt(value.aiRateBasisPoints);
  const fraction = String(rate % 10_000n)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return String(rate / 10_000n) + (fraction ? "." + fraction : "");
}

function rateFraction(value: number | StandardAiRate) {
  const rate = typeof value === "number" ? { aiRateMultiplier: value } : value;
  if (!checkedStandardAiRate(rate)) return null;
  return rate.aiRateBasisPoints === undefined
    ? { numerator: BigInt(rate.aiRateMultiplier), denominator: 1n }
    : { numerator: BigInt(rate.aiRateBasisPoints), denominator: 10_000n };
}

/** Price a provider total exactly. Fractional nanodollars require corrected source totals. */
export function applyStandardAiRateUsdNanos(
  providerUsdNanos: string,
  rate: StandardAiRate,
): string | null {
  if (!/^(?:0|[1-9][0-9]{0,29})$/.test(providerUsdNanos)) return null;
  const fraction = rateFraction(rate);
  if (!fraction) return null;
  const numerator = BigInt(providerUsdNanos) * fraction.numerator;
  if (numerator % fraction.denominator !== 0n) return null;
  const total = numerator / fraction.denominator;
  return total <= MAX_NANOS ? total.toString() : null;
}

/** Missing or incompatible usage has no price. Reasoning is already in output. */
export function standardAiUsageUsdNanos(
  model: string,
  usage: StandardAiTokenUsage,
  rate: number | StandardAiRate = PRODUCT_STANDARD_PRICES,
): string | null {
  const fraction = rateFraction(rate);
  if (
    model !== PRODUCT_STANDARD_AI_RATES.model ||
    !usage ||
    !tokenCount(usage.inputTokens) ||
    !tokenCount(usage.cachedInputTokens) ||
    !tokenCount(usage.cacheWriteInputTokens) ||
    !tokenCount(usage.outputTokens) ||
    !fraction ||
    (usage.reasoningTokens != null &&
      (!tokenCount(usage.reasoningTokens) ||
        usage.reasoningTokens > usage.outputTokens))
  )
    return null;

  const input = BigInt(usage.inputTokens);
  const cached = BigInt(usage.cachedInputTokens);
  const written = BigInt(usage.cacheWriteInputTokens);
  if (cached + written > input) return null;

  const long =
    usage.inputTokens > PRODUCT_STANDARD_AI_RATES.longContextAboveInputTokens;
  const inputMultiplier = long
    ? BigInt(PRODUCT_STANDARD_AI_RATES.longInputMultiplier)
    : 1n;
  const outputNumerator = long
    ? BigInt(PRODUCT_STANDARD_AI_RATES.longOutputMultiplierNumerator)
    : 1n;
  const outputDenominator = long
    ? BigInt(PRODUCT_STANDARD_AI_RATES.longOutputMultiplierDenominator)
    : 1n;
  const inputCost =
    ((input - cached - written) *
      BigInt(PRODUCT_STANDARD_AI_RATES.inputUsdNanosPerMillion) +
      cached * BigInt(PRODUCT_STANDARD_AI_RATES.cachedInputUsdNanosPerMillion) +
      written *
        BigInt(PRODUCT_STANDARD_AI_RATES.cacheWriteInputUsdNanosPerMillion)) *
    inputMultiplier;
  const numerator =
    (inputCost * outputDenominator +
      BigInt(usage.outputTokens) *
        BigInt(PRODUCT_STANDARD_AI_RATES.outputUsdNanosPerMillion) *
        outputNumerator) *
    fraction.numerator;
  const denominator = PER_MILLION * outputDenominator * fraction.denominator;
  // This rate card yields whole nanodollars. Do not silently truncate a future card.
  if (numerator % denominator !== 0n) return null;
  const nanos = numerator / denominator;
  return nanos <= MAX_NANOS ? nanos.toString() : null;
}

export type StandardUsageChargeInput = {
  answeredCases: number;
  includedAnsweredCases: number;
  additionalAnsweredCaseCents: number;
  /** Sum of priced requests, already including the retail multiplier. */
  aiUsageUsdNanos: string;
  includedAiCreditCents: number;
};

function safeCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Standard usage charge exceeds safe integer cents");
  return Number(value);
}

/** Round the period's AI overage once, to the nearest cent; half a cent rounds up. */
export function standardUsageCharges(usage: StandardUsageChargeInput): {
  answeredCaseChargedCents: number;
  aiUsageChargedCents: number;
  totalChargedCents: number;
} {
  if (
    !usage ||
    !nonnegativeInteger(usage.answeredCases) ||
    !nonnegativeInteger(usage.includedAnsweredCases) ||
    !nonnegativeInteger(usage.additionalAnsweredCaseCents) ||
    !nonnegativeInteger(usage.includedAiCreditCents) ||
    typeof usage.aiUsageUsdNanos !== "string" ||
    !/^(?:0|[1-9][0-9]{0,29})$/.test(usage.aiUsageUsdNanos)
  )
    throw new RangeError("Invalid Standard usage totals");

  const extraCases = BigInt(
    Math.max(0, usage.answeredCases - usage.includedAnsweredCases),
  );
  const answeredCaseCharge =
    extraCases * BigInt(usage.additionalAnsweredCaseCents);
  const aiUsage = BigInt(usage.aiUsageUsdNanos);
  const credit = BigInt(usage.includedAiCreditCents) * NANOS_PER_CENT;
  const aiOverage = aiUsage > credit ? aiUsage - credit : 0n;
  const aiCharge = (aiOverage + NANOS_PER_CENT / 2n) / NANOS_PER_CENT;
  return {
    answeredCaseChargedCents: safeCents(answeredCaseCharge),
    aiUsageChargedCents: safeCents(aiCharge),
    totalChargedCents: safeCents(answeredCaseCharge + aiCharge),
  };
}
