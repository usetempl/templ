import type { FunnelReport } from "@templ/chat/funnel";
import type {
  OnboardingAudience,
  OnboardingReport,
} from "@templ/chat/onboarding";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";

/** Reads the onboarding counts for a Templ operator's session. */
export function funnelAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async onboarding(
      days: number,
      traffic: OnboardingAudience,
      signal?: AbortSignal,
    ): Promise<OnboardingReport> {
      current();
      const result = await communityFetch<OnboardingReport>(
        `/operator/onboarding?days=${days}&traffic=${traffic}`,
        undefined,
        signal,
      );
      current();
      if (
        !result ||
        result.schemaVersion !== 1 ||
        !Array.isArray(result.stages) ||
        !Array.isArray(result.transitions)
      )
        throw new Error("Onboarding counts could not be loaded. Try again.");
      return result;
    },
    async read(days: number, signal?: AbortSignal): Promise<FunnelReport> {
      current();
      const result = await communityFetch<FunnelReport>(
        `/operator/funnel?days=${days}`,
        undefined,
        signal,
      );
      current();
      if (
        !result ||
        typeof result.from !== "string" ||
        !Array.isArray(result.steps) ||
        !Array.isArray(result.days)
      )
        throw new Error("Onboarding counts could not be loaded. Try again.");
      return result;
    },
  };
}
