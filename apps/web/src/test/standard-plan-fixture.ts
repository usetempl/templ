import type {
  StandardPlanView,
  StandardPrepaidPeriod,
} from "@templ/chat/standard-plan";

export function standardPlanFixture(
  overrides: Partial<StandardPlanView> = {},
): StandardPlanView {
  return {
    status: "paid",
    ticketsUsed: 10,
    ticketsTotal: 10,
    period: {
      id: "0001792108800000",
      startsAt: Date.parse("2026-10-16T00:00:00.000Z"),
      endsAt: Date.parse("2026-11-16T00:00:00.000Z"),
      source: "founder-approved",
      referenceSha256: "a".repeat(64),
      operator: "0x1111111111111111111111111111111111111111",
      approvedBy: "0x1111111111111111111111111111111111111111",
      reason: "Synthetic billing UI fixture.",
      revokedAt: null,
      workspaceMonthlyCents: 9900,
      includedAiResolutions: 0,
      additionalAiResolutionCents: 100,
      confirmedAiResolutions: 0,
      chargedCents: 0,
      paidCents: 0,
    },
    includedAiResolutions: 0,
    additionalAiResolutionCents: 100,
    chargedCents: 0,
    paidCents: 0,
    dueCents: 0,
    prepaid: {
      mode: "prepaid",
      revision: 1,
      cashAvailableUsdNanos: "12000000000",
      cashReservedUsdNanos: "0",
      cashSpentUsdNanos: "0",
      period: null,
    },
    ...overrides,
  };
}

export function prepaidPeriodFixture(): StandardPrepaidPeriod {
  const period = standardPlanFixture().period!;
  return {
    id: period.id,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    readinessPolicy: "grounded_v1",
    priceVersion: "2026-10-17",
    aiRateCardVersion: "2026-10-16",
    aiRateBasisPoints: 13000,
    includedAiCreditUsdNanos: "20000000000",
    includedAiAvailableUsdNanos: "20000000000",
    includedAiReservedUsdNanos: "0",
    includedAiSpentUsdNanos: "0",
    aiUsageUsdNanos: "0",
    aiReservedUsdNanos: "0",
    aiCashReservedUsdNanos: "0",
    aiCashSpentUsdNanos: "0",
    aiAbsorbedAttempts: 0,
  };
}
