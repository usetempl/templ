import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";
import {
  INCIDENT_KINDS,
  type Incident,
  type IncidentKind,
} from "./status-client";

export type OperatorIncident = Incident & {
  revision: number;
  log: {
    at: number;
    actor: string;
    authenticatedAt: number;
    action: "open" | "note" | "resolve";
    noteLength: number;
  }[];
};

/** A time-ordered id the worker checks as UUIDv7, so a repeated post of the
 * same notice is recognized as the same one. */
export function incidentId(now = Date.now()) {
  const time = now.toString(16).padStart(12, "0");
  const random = crypto.randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}

const valid = (value: unknown): value is { incidents: OperatorIncident[] } =>
  !!value &&
  typeof value === "object" &&
  Array.isArray((value as { incidents?: unknown }).incidents) &&
  (value as { incidents: Record<string, unknown>[] }).incidents.every(
    (row) =>
      typeof row.id === "string" &&
      (INCIDENT_KINDS as readonly unknown[]).includes(row.kind) &&
      Number.isSafeInteger(row.revision) &&
      Array.isArray(row.log),
  );

/** Incident notices for a Templ operator's session. Writes send the
 * operator's own principal and `confirmed: true`; the worker still asks for
 * a valid wallet session. */
export function incidentsAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async list(signal?: AbortSignal) {
      current();
      const result = await communityFetch<unknown>(
        "/operator/incidents",
        undefined,
        signal,
      );
      current();
      if (!valid(result)) throw new Error("Notices could not be loaded.");
      return result.incidents;
    },
    async post(input: { id: string; kind: IncidentKind; note: string }) {
      current();
      return communityFetch<{ incident: Incident }>("/operator/incidents", {
        id: input.id,
        kind: input.kind,
        ...(input.note.trim() ? { note: input.note } : {}),
        confirmed: true,
        expectedPrincipalId: principal,
      });
    },
    async update(
      id: string,
      change: { expectedRevision: number; note?: string; resolve?: boolean },
    ) {
      current();
      return communityFetch<{ incident: Incident }>(
        `/operator/incidents/${id}`,
        {
          expectedRevision: change.expectedRevision,
          ...(change.note === undefined ? {} : { note: change.note }),
          ...(change.resolve ? { state: "resolved" } : {}),
          confirmed: true,
          expectedPrincipalId: principal,
        },
      );
    },
  };
}
