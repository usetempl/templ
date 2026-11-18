import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ProductUsageTerms } from "@templ/chat/usage-billing";
import type { PilotOrderFormTerms } from "@templ/chat/pilot-pricing";
import type { ResolutionPriceTable } from "@templ/chat/resolution-pricing";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";

export type OperatorOrderForm = {
  id: string;
  revision: number;
  workspace: string;
  table: ResolutionPriceTable;
  service: "software" | "managed-ai" | "done-for-you";
  startsAt: number;
  endsAt: number;
  documentSha256: string;
  approvedBy: ChatPrincipalId;
  createdBy: ChatPrincipalId;
  pilot?: PilotOrderFormTerms;
  usage?: ProductUsageTerms;
};
export type OperatorOrderFormsRecord = {
  orderForm: OperatorOrderForm | null;
  history: OperatorOrderForm[];
  ended: Record<string, number>;
};
export type OperatorOrderForms = OperatorOrderFormsRecord & {
  workspace: string;
  pilotEnabled: boolean;
};
export type OperatorOrderFormAction =
  | {
      action: "create" | "amend";
      id?: string;
      expectedRevision?: number;
      table: ResolutionPriceTable;
      service: "software";
      startsAt: number;
      endsAt: number;
      documentSha256: string;
      approvedBy: string;
      pilot?: PilotOrderFormTerms;
      usage?: ProductUsageTerms;
    }
  | {
      action: "end";
      id: string;
      expectedRevision: number;
      approvedBy: string;
    };

const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The worker checks operator access and recorded agreement provenance on every action. */
export function orderFormsAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  const workspaceId = (workspace: string) => {
    if (!WORKSPACE.test(workspace)) throw new Error("Choose a workspace.");
  };
  return {
    async read(workspace: string, signal?: AbortSignal) {
      workspaceId(workspace);
      current();
      const result = await communityFetch<OperatorOrderForms>(
        `/operator/order-forms?workspace=${encodeURIComponent(workspace)}`,
        undefined,
        signal,
      );
      current();
      if (
        !result ||
        result.workspace !== workspace ||
        !Array.isArray(result.history) ||
        typeof result.ended !== "object" ||
        result.ended === null
      )
        throw new Error("The order form could not load.");
      return result;
    },
    async act(
      workspace: string,
      input: OperatorOrderFormAction & { reason: string },
    ) {
      workspaceId(workspace);
      current();
      const result = await communityFetch<OperatorOrderFormsRecord>(
        "/operator/order-forms",
        {
          ...input,
          workspace,
          confirmed: true,
          expectedPrincipalId: principal,
        },
      );
      current();
      return result;
    },
  };
}
