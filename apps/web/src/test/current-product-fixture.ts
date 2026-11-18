import type {
  ProductAccessView,
  ProductChargeView,
} from "@templ/chat/product-catalog";
import {
  PRODUCT_AI_ONLY_RESOLUTION_PRICE,
  PRODUCT_FREE_START,
  PRODUCT_OFFER_VERSION,
  PRODUCT_PRICE_VERSION,
  PRODUCT_RESOLUTION_PRICE,
} from "@templ/chat/plans";
import { resolutionPriceSteps } from "@templ/chat/resolution-pricing";

/** A new workspace before its first resolved case: free start unreserved,
 * zero balance, billing on. */
export const currentProductFixture: ProductAccessView = {
  offerVersion: PRODUCT_OFFER_VERSION,
  mode: "free",
  support: { enabled: true, canAdmit: true },
  billing: "on",
  free: {
    total: PRODUCT_FREE_START.resolvedCases,
    used: 0,
    pending: 0,
    status: "unreserved",
  },
  grants: [],
  balance: {
    balanceCents: 0,
    pendingCents: 0,
    availableCents: 0,
    creditBaseCents: 0,
    everFunded: false,
    level: null,
    pauseAtCents: null,
    runwayDays: null,
  },
  month: {
    id: "202609",
    cases: 0,
    teamHandledCases: 0,
    aiOnlyCases: 0,
    cents: 0,
    free: 0,
    grant: 0,
    exempt: 0,
    voided: 0,
    excluded: 0,
    noReply: 0,
    duplicate: 0,
    memberConfirmed: 0,
    byCloser: { person: 0, bot: 0, managed: 0, member: 0 },
  },
  steps: resolutionPriceSteps(),
  priceSource: { kind: "public", version: PRODUCT_PRICE_VERSION },
  orderForm: null,
  priceChange: null,
  aiOnlyPriceCents: PRODUCT_AI_ONLY_RESOLUTION_PRICE.usdCents,
  nextPriceCents: PRODUCT_RESOLUTION_PRICE.usdCents,
  customVolume: false,
  suspended: false,
  billingSoon: 0,
};

/** A view with nested fields merged over the new-workspace fixture. */
export function productView(
  patch: Partial<Omit<ProductAccessView, "balance" | "free" | "month">> & {
    balance?: Partial<ProductAccessView["balance"]>;
    free?: Partial<ProductAccessView["free"]>;
    month?: Partial<ProductAccessView["month"]>;
  } = {},
): ProductAccessView {
  const base = currentProductFixture;
  return {
    ...base,
    ...patch,
    balance: { ...base.balance, ...patch.balance },
    free: { ...base.free, ...patch.free },
    month: { ...base.month, ...patch.month },
  };
}

/** One final charge debited from the balance at the first step. */
export function chargeFixture(
  patch: Partial<ProductChargeView> = {},
): ProductChargeView {
  return {
    ref: "0123456789abcdef",
    state: "final",
    reason: null,
    resolvedBy: "team",
    closer: "person",
    handlingClass: "team-handled",
    openedAt: "2026-09-10T10:00:00.000Z",
    resolvedAt: "2026-09-10T12:00:00.000Z",
    finalDueAt: null,
    finalAt: "2026-09-17T12:00:00.000Z",
    source: "balance",
    priceCents: PRODUCT_RESOLUTION_PRICE.usdCents,
    priceSource: { kind: "public", version: PRODUCT_PRICE_VERSION },
    disputeUntil: "2026-10-17T12:00:00.000Z",
    dispute: null,
    possibleRepeat: false,
    events: [
      {
        at: "2026-09-10T12:00:00.000Z",
        kind: "resolved",
        actor: { kind: "team" },
      },
      {
        at: "2026-09-17T12:00:00.000Z",
        kind: "final",
        actor: { kind: "system" },
      },
    ],
    added: {
      walletVerified: true,
      transactionCheck: false,
      aiDraftUsed: false,
      firstReplyMs: 12 * 60_000,
    },
    ...patch,
  };
}
