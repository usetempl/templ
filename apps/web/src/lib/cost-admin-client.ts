import type { CostDashboard } from "@templ/chat/web2-costs";
import type {
  WorkspaceCostDetail,
  WorkspaceCostOverview,
} from "@templ/chat/workspace-costs";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";

export function costAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async read(month: string, signal?: AbortSignal): Promise<CostDashboard> {
      current();
      const result = await communityFetch<CostDashboard>(
        `/operator/costs?month=${encodeURIComponent(month)}`,
        undefined,
        signal,
      );
      current();
      if (
        !result ||
        result.month !== month ||
        !Array.isArray(result.days) ||
        !result.values
      )
        throw new Error("Cost information could not be loaded. Try again.");
      return result;
    },
    async workspaces(
      month: string,
      after: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceCostOverview> {
      current();
      const result = await communityFetch<CostDashboard>(
        `/operator/costs?month=${encodeURIComponent(month)}&after=${encodeURIComponent(after)}`,
        undefined,
        signal,
      );
      current();
      const overview = result?.workspaceCosts;
      if (
        !overview ||
        overview.month !== month ||
        !Array.isArray(overview.rows)
      )
        throw new Error("Workspace costs could not be loaded. Try again.");
      return overview;
    },
    async workspace(
      month: string,
      workspace: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceCostDetail> {
      current();
      const result = await communityFetch<WorkspaceCostDetail>(
        `/operator/costs/workspaces/${encodeURIComponent(workspace)}?month=${encodeURIComponent(month)}`,
        undefined,
        signal,
      );
      current();
      if (
        !result ||
        result.row?.workspace !== workspace ||
        result.row.month !== month ||
        !Array.isArray(result.days) ||
        !Array.isArray(result.invoices)
      )
        throw new Error("Workspace costs could not be loaded. Try again.");
      return result;
    },
  };
}
