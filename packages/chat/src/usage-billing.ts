import type { ResolutionPriceTable } from "./resolution-pricing";
import { normalizeChatPrincipal, type ChatPrincipalId } from "./principal";
import { PRODUCT_PLANNED_USAGE_PRICES, PRODUCT_USAGE_LIMITS } from "./plans";

export type ProductUsageFeature =
  | "walletVerification"
  | "transactionCheck"
  | "aiDraft";
export type ProductUsageTerms = {
  version: string;
  walletVerificationUsdCents: number;
  transactionCheckUsdCents: number;
  aiDraftUsdCents: number;
  templAiResolutionUsdCents: number;
  debtLimitCents: number;
  templAiPrincipal: ChatPrincipalId | null;
  /** The signed agreement must explicitly authorize AI-resolution fees. */
  templAiResolutionEnabled?: boolean;
};
export function productUsageTerms(
  templAiPrincipal: ChatPrincipalId | null = null,
): ProductUsageTerms {
  const prices = PRODUCT_PLANNED_USAGE_PRICES;
  return {
    version: prices.publishedOn,
    walletVerificationUsdCents: prices.walletVerificationUsdCents,
    transactionCheckUsdCents: prices.transactionCheckUsdCents,
    aiDraftUsdCents: prices.aiDraftUsdCents,
    templAiResolutionUsdCents: prices.templAiResolutionUsdCents,
    debtLimitCents: PRODUCT_USAGE_LIMITS.debtLimitCents,
    templAiPrincipal,
  };
}
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export function isProductUsageTerms(
  value: unknown,
): value is ProductUsageTerms {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const terms = value as Record<string, unknown>;
  return (
    Object.keys(terms)
      .filter((key) => key !== "templAiResolutionEnabled")
      .sort()
      .join() ===
      "aiDraftUsdCents,debtLimitCents,templAiPrincipal,templAiResolutionUsdCents,transactionCheckUsdCents,version,walletVerificationUsdCents" &&
    typeof terms.version === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(terms.version) &&
    Number.isFinite(Date.parse(terms.version)) &&
    new Date(terms.version).toISOString().slice(0, 10) === terms.version &&
    [
      terms.walletVerificationUsdCents,
      terms.transactionCheckUsdCents,
      terms.aiDraftUsdCents,
      terms.templAiResolutionUsdCents,
    ].every((value) => natural(value) && value <= 10_000) &&
    natural(terms.debtLimitCents) &&
    terms.debtLimitCents > 0 &&
    terms.debtLimitCents <= PRODUCT_USAGE_LIMITS.debtLimitCents &&
    Number(terms.templAiResolutionUsdCents) >=
      Number(terms.walletVerificationUsdCents) +
        Number(terms.transactionCheckUsdCents) +
        Number(terms.aiDraftUsdCents) &&
    (terms.templAiPrincipal === null ||
      (normalizeChatPrincipal(terms.templAiPrincipal) !== null &&
        normalizeChatPrincipal(terms.templAiPrincipal) ===
          terms.templAiPrincipal)) &&
    (terms.templAiResolutionEnabled === undefined ||
      typeof terms.templAiResolutionEnabled === "boolean") &&
    (terms.templAiResolutionEnabled !== true || terms.templAiPrincipal !== null)
  );
}
export function usageFeatureCents(
  terms: ProductUsageTerms,
  feature: ProductUsageFeature,
) {
  return terms[`${feature}UsdCents`];
}
export type ProductUsageTotals = {
  chargedCents: number;
  disputedCents: number;
  paidCents: number;
  forgivenCents: number;
  reservedCents: number;
  dueCents: number;
  creditCents: number;
};
export type ProductUsageView = ProductUsageTotals & {
  status:
    | "demo"
    | "agreement-needed"
    | "approval-needed"
    | "active"
    | "credit-limit"
    | "off";
  debtLimitCents: number;
  availableCreditCents: number;
  agreement: { id: string; revision: number; endsAt: string } | null;
  terms: ProductUsageTerms | null;
};
export type ProductUsageRow = {
  id: string;
  kind:
    | "feature"
    | "ai-resolution"
    | "dispute-credit"
    | "payment"
    | "forgiveness";
  at: number;
  cents: number;
  ref?: string;
  feature?: ProductUsageFeature;
  formId?: string;
  formRevision?: number;
  documentSha256?: string;
  priceVersion?: string;
  referenceSha256?: string;
  paymentId?: string;
  operator?: ChatPrincipalId;
  reason?: string;
};

export function usageResolutionTable(
  terms: ProductUsageTerms,
): ResolutionPriceTable {
  return {
    usdCents: 0,
    stepOneUsdCents: 0,
    stepOneAfterCases: 1,
    aiOnlyUsdCents: terms.templAiResolutionUsdCents,
  };
}
export function usageCaseReserveCents(terms: ProductUsageTerms) {
  return terms.templAiResolutionEnabled === true && terms.templAiPrincipal
    ? terms.templAiResolutionUsdCents
    : terms.walletVerificationUsdCents +
        terms.transactionCheckUsdCents +
        terms.aiDraftUsdCents;
}

export type ProductUsageStatement = {
  openingCents: number;
  closingCents: number;
  chargedCents: number;
  disputedCents: number;
  paidCents: number;
  forgivenCents: number;
  rows: ProductUsageRow[];
  truncated: boolean;
};
export function usageEntryLabel(row: ProductUsageRow) {
  if (row.kind === "feature")
    return row.feature === "walletVerification"
      ? "Wallet check"
      : row.feature === "transactionCheck"
        ? "Transaction check"
        : "Templ AI draft";
  return row.kind === "ai-resolution"
    ? "Templ AI resolution"
    : row.kind === "dispute-credit"
      ? "Dispute credit"
      : row.kind === "payment"
        ? "Payment"
        : "Debt credit";
}

export type ProductUsagePage = {
  rows: ProductUsageRow[];
  next: string | null;
  cases: {
    ref: string;
    finalAt: number | null;
    disputeUntil: number | null;
    dispute: "open" | "credited" | "denied" | null;
  }[];
};
