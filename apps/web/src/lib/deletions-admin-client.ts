import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";

/** `GET /operator/deletions`: ids, states, times and counts only. */
export type OperatorDeletions = {
  schemaVersion: 1;
  open: {
    id: string;
    state: "scheduled" | "deleting" | "held" | "holds-unavailable" | "unknown";
    requestedAt?: number;
    dueAt?: number;
    threadsLeft?: number | null;
  }[];
  deleted: {
    id: string;
    requestedAt: number;
    deletedAt: number | null;
    counts: { threads: number; keptUnderHold: number };
  }[];
};

const valid = (value: unknown): value is OperatorDeletions =>
  !!value &&
  typeof value === "object" &&
  (value as OperatorDeletions).schemaVersion === 1 &&
  Array.isArray((value as OperatorDeletions).open) &&
  Array.isArray((value as OperatorDeletions).deleted);

/** Workspace deletions for a Templ operator's session. */
export function deletionsAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async read(signal?: AbortSignal) {
      current();
      const result = await communityFetch<unknown>(
        "/operator/deletions",
        undefined,
        signal,
      );
      current();
      if (!valid(result)) throw new Error("Deletions could not be loaded.");
      return result;
    },
    /** Moves a waiting deletion's due time to now, when the manager asked
     * for it sooner. */
    async expedite(id: string) {
      current();
      return communityFetch(`/operator/deletions/${id}/expedite`, {
        confirmed: true,
        expectedPrincipalId: principal,
      });
    },
  };
}
