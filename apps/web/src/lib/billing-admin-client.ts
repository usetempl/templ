import type {
  ProductUsageView,
  ProductUsagePage,
} from "@templ/chat/usage-billing";
import type { ServingReleaseIdentity } from "@templ/chat/support-install-fixture";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  ProductChargeCloser,
  ProductChargeResolvedBy,
  ProductDisputeReason,
  ProductMode,
  ProductAccessView,
  ProductCardBillingView,
  ProductOrderFormView,
  ProductPilotView,
} from "@templ/chat/product-catalog";
import type { ProductRailId } from "@templ/chat/product-payment";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";

/** One workspace in `GET /operator/billing`: totals, flags and monitors,
 * never thread text, a thread or a case number. */
export type BillingWorkspace = {
  standardPlan?: import("@templ/chat/standard-plan").StandardPlanView;
  workspace: string;
  name?: string;
  trackingStartedAt?: number | null;
  templStaffCount?: number;
  orderForm?: ProductOrderFormView | null;
  pilot?: ProductPilotView | null;
  pendingPilot?: ProductPilotView | null;
  pilotEnabled?: boolean;
  unavailable?: true;
  mode?: ProductMode;
  freeStart?: "unreserved" | "reserved" | "denied";
  everFunded?: boolean;
  balanceCents?: number;
  pendingCents?: number;
  suspended?: boolean;
  month?: { id: string; cases: number; cents: number };
  cashCents?: number;
  disputes?: number;
  unmatched?: number;
  monitors?: {
    answered: number;
    spamPercent: number;
    spamFlag: boolean;
    neverResolvedPercent: number;
    spamOnConfirmed: number;
    teamReopenedBeforeFinal: number;
  };
  reviewSuggested?: boolean;
  manualBilling?: ProductAccessView["manualBilling"];
  usageBilling?: ProductUsageView;
  billingMethod?: "usdc" | "card";
  cardBilling?: ProductCardBillingView;
  cardOutreach?: boolean;
  /** When a top-up credited it while suspended, since the last lift. */
  topUpWhileSuspended?: number | null;
  refundableCents?: number;
};
export type BillingDispute = {
  ref: string;
  reason: ProductDisputeReason;
  text: string | null;
  at: string;
  priceCents: number;
  closer?: ProductChargeCloser;
  resolvedBy?: ProductChargeResolvedBy;
  /** The case's de-identified row, or null when it has none. */
  corpus: { workspace: string; ref: string } | null;
};
export type BillingUnmatched = {
  paymentId: string;
  chainId: number | "solana";
  txHash: string;
  usdCents: number;
  reason: string;
  at: number;
  status: "open" | "credited" | "returned";
  creditedCents?: number;
};
export type BillingDetail = Omit<BillingWorkspace, "disputes" | "unmatched"> & {
  nativeSource?: Omit<ServingReleaseIdentity, "service" | "versionId"> | null;
  standardDebtPeriods?: import("@templ/chat/standard-plan").StandardPlanPeriod[];
  standardRecords?: import("@templ/chat/standard-plan").StandardPlanRecords;
  usageRows?: ProductUsagePage;
  disputes: BillingDispute[];
  unmatched: BillingUnmatched[];
};
/** An operator action on one workspace. Every one needs a reason and a
 * valid signed-in session, and the worker audits it. */
export type BillingAction =
  | { action: "tracking-reset" }
  | {
      action: "standard-payment-mode";
      mode: "prepaid" | "debt" | "custom" | "sponsored";
      expectedRevision: number;
    }
  | {
      action: "standard-access";
      source: "manual-payment" | "founder-approved";
      referenceSha256: string;
      approvedBy: string | null;
      expectedPeriod: string | null;
    }
  | {
      action: "standard-debt-paid";
      period: string;
      cents: number;
      referenceSha256: string;
    }
  | { action: "standard-access-revoke"; period: string }
  | {
      action: "standard-usage-review";
      period: string;
      referenceSha256: string;
      expectedReviewedThrough: number | null;
      reviewedThrough: number;
      answeredCases: number;
      providerAiUsageUsdNanos: string;
      aiUsageMissing: number;
    }
  | {
      action: "usage-approve";
      formId: string;
      revision: number;
      approvedBy: string;
      enabled: boolean;
    }
  | {
      action: "usage-payment" | "usage-forgive";
      cents: number;
      referenceSha256: string;
    }
  | { action: "suspend" | "unsuspend" | "resume" }
  | { action: "incident-credit"; cents: number }
  | {
      action: "unmatched";
      paymentId: string;
      answer: "credit" | "return";
      usdCents?: number;
    }
  | { action: "dispute"; ref: string; accept: boolean }
  | {
      action: "payment-request";
      orderFormId: string;
      orderFormRevision: number;
      rail: ProductRailId;
      payer: string;
      usdCents: number;
    };

const WORKSPACE = /^[0-9a-f-]{36}$/;

/** Resolved-case billing for a Templ operator's session. */
export function billingAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async list(after: string | null, signal?: AbortSignal) {
      current();
      const page = await communityFetch<{
        workspaces: BillingWorkspace[];
        next: string | null;
        inputTokenProbeAvailable?: boolean;
      }>(
        `/operator/billing${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        undefined,
        signal,
      );
      current();
      if (!page || !Array.isArray(page.workspaces))
        throw new Error("Billing could not be loaded.");
      return page;
    },
    async probeAiConnection(signal?: AbortSignal) {
      current();
      const result = await communityFetch<{
        connected: boolean;
        reason: string;
        model: "gpt-6.1-sol" | "unknown";
        tier: "default" | "unreported" | "other";
        usageComplete: boolean;
      }>(
        "/operator/billing",
        {
          action: "ai-provider-probe",
          expectedPrincipalId: principal,
          confirmed: true,
        },
        signal,
      );
      current();
      return result;
    },
    async probeInputTokens(signal?: AbortSignal) {
      current();
      const result = await communityFetch<{
        supported: boolean;
        inputTokens: number | null;
        reason:
          | "supported"
          | "binding-unavailable"
          | "http-error"
          | "invalid-response"
          | "timeout"
          | "transport-error";
        status: number | null;
        errorName: string | null;
      }>("/operator/billing?input-token-probe=1", undefined, signal);
      current();
      return result;
    },
    async detail(workspace: string, signal?: AbortSignal) {
      if (!WORKSPACE.test(workspace)) throw new Error("Choose a workspace.");
      current();
      const detail = await communityFetch<BillingDetail>(
        `/operator/billing/${workspace}`,
        undefined,
        signal,
      );
      current();
      if (
        !detail ||
        !Array.isArray(detail.disputes) ||
        !Array.isArray(detail.unmatched)
      )
        throw new Error("The workspace could not be loaded.");
      return detail;
    },
    async ledgerDownload(workspace: string, signal?: AbortSignal) {
      const detail = await this.detail(workspace, signal);
      const clientReceivedAt = Date.now();
      current();
      const usage = detail.usageBilling;
      return {
        schemaVersion: 1,
        workspace,
        clientReceivedAt,
        nativeSource: detail.nativeSource ?? null,
        usageRows: detail.usageRows ?? null,
        usageTotals: usage
          ? {
              chargedCents: usage.chargedCents,
              disputedCents: usage.disputedCents,
              paidCents: usage.paidCents,
              forgivenCents: usage.forgivenCents,
              reservedCents: usage.reservedCents,
              dueCents: usage.dueCents,
              creditCents: usage.creditCents,
            }
          : null,
      };
    },
    async act(workspace: string, input: BillingAction & { reason: string }) {
      if (!WORKSPACE.test(workspace)) throw new Error("Choose a workspace.");
      current();
      const result = await communityFetch<Record<string, unknown>>(
        `/operator/billing/${workspace}`,
        {
          ...input,
          confirmed: true,
          expectedPrincipalId: principal,
        },
      );
      current();
      return result;
    },
  };
}
