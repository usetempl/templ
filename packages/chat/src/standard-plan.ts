import type { ChatPrincipalId } from "./principal";
import type { StandardAiRate } from "./standard-usage";

export type StandardPaymentMode = "prepaid" | "debt" | "custom";
export type MonthlySupportPlan = "starter" | "standard";
export type StandardPrepaidPeriod = StandardAiRate & {
  readinessPolicy: "grounded_v1";
  id: string;
  startsAt: number;
  endsAt: number;
  priceVersion: string;
  aiRateCardVersion: string;
  includedAiCreditUsdNanos: string;
  includedAiAvailableUsdNanos: string;
  includedAiReservedUsdNanos: string;
  includedAiSpentUsdNanos: string;
  aiUsageUsdNanos: string;
  aiReservedUsdNanos: string;
  aiCashReservedUsdNanos: string;
  aiCashSpentUsdNanos: string;
  aiAbsorbedAttempts: number;
};
export type StandardPrepaidView = {
  mode: StandardPaymentMode;
  sponsored?: true;
  revision: number;
  cashAvailableUsdNanos: string;
  cashReservedUsdNanos: string;
  cashSpentUsdNanos: string;
  period: StandardPrepaidPeriod | null;
};

/** Prices are captured with the accepted period. Usage dollars include the AI multiplier. */
export type StandardUsagePeriod = StandardAiRate & {
  priceVersion: string;
  includedAnsweredCases: number;
  additionalAnsweredCaseCents: number;
  answeredCases: number;
  answeredCaseChargedCents: number;
  includedAiCreditCents: number;
  aiRateCardVersion: string;
  aiUsageUsdNanos: string;
  aiUsageChargedCents: number;
  aiUsageMissing: number;
  aiReviewedThrough: number | null;
};

export type StandardPlanPeriod = {
  id: string;
  startsAt: number;
  endsAt: number;
  source: "manual-payment" | "founder-approved" | "verified-payment";
  referenceSha256: string;
  operator: ChatPrincipalId | null;
  approvedBy: ChatPrincipalId | null;
  reason: string;
  revokedAt: number | null;
  workspaceMonthlyCents: number;
  includedAiResolutions: number;
  additionalAiResolutionCents: number;
  confirmedAiResolutions: number;
  chargedCents: number;
  paidCents: number;
  usage?: StandardUsagePeriod;
  paymentId?: string;
  annual?: {
    startsAt: number;
    month: number;
    priceVersion: string;
    totalCents: number;
  };
  /** Statement projection; monthly receivables have their own retained ledger. */
  monthlyDebt?: { chargedCents: number; paidCents: number };
};

/** Billing staff see counters and recorded provenance. This grants no authority. */
export type StandardPlanView = {
  status: "demo" | "paid";
  ticketsUsed: number;
  ticketsTotal: number;
  period: StandardPlanPeriod | null;
  includedAiResolutions: number;
  additionalAiResolutionCents: number;
  chargedCents: number;
  paidCents: number;
  dueCents: number;
  continuesOnDebt?: boolean;
  starterAvailable?: true;
  annualAvailable?: true;
  accessEndsAt?: number;
  starterAiLimitCents?: number;
  prepaid?: StandardPrepaidView;
};

/** Server-recorded manual bookkeeping, not an independently verified bank receipt. */
export type StandardPlanReference = {
  referenceSha256: string;
  kind: "access" | "debt-paid";
  period: string;
  cents: number;
  recordedAt: number;
  operator: ChatPrincipalId;
  reason: string;
};

export type StandardPlanCase = {
  ref: string;
  period: string;
  answeredAt: number | null;
  confirmedAt: number | null;
  humanReplied: boolean;
  managed: boolean;
  dueAt: number | null;
  finalAt: number | null;
  countedAt: number | null;
  chargedCents: number;
  status: "pending" | "void" | "counted";
};

/** Reviewed cumulative usage. This records a charge, never received money. */
export type StandardUsageReview = {
  schemaVersion: 1;
  referenceSha256: string;
  payloadSha256: string;
  period: string;
  recordedAt: number;
  operator: ChatPrincipalId;
  reason: string;
  expectedReviewedThrough: number | null;
  reviewedThrough: number;
  answeredCases: number;
  providerAiUsageUsdNanos: string;
  aiUsageUsdNanos: string;
  aiUsageMissing: 0;
  answeredCaseChargedCents: number;
  aiUsageChargedCents: number;
  chargedCents: number;
};

/** Bounded financial metadata, with no member, thread or message. */
export type StandardPlanRecords = {
  periods: StandardPlanPeriod[];
  references: StandardPlanReference[];
  cases: StandardPlanCase[];
  usageReviews?: StandardUsageReview[];
  cashPayments?: StandardCashPayment[];
  partial: boolean;
  cursor: null;
};

/** Existing prepaid cash applied to a posted charge, never another cash receipt. */
export type StandardCashPayment = {
  referenceId: string;
  period: string;
  cents: number;
  recordedAt: number;
};
