import { SITE } from "./site-environment";

/** Notices about Templ's own service. The worker serves
 * fixed fields only; the widget and the inbox show a fixed line per kind. */
export const INCIDENT_KINDS = [
  "slow-replies",
  "sign-in",
  "alerts",
  "agents",
  "maintenance",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type Incident = {
  id: string;
  kind: IncidentKind;
  state: "open" | "resolved";
  startedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  note: string | null;
};

/** Titles on the status page. */
export const INCIDENT_TITLES: Record<IncidentKind, string> = {
  "slow-replies": "Messages are delayed",
  "sign-in": "Wallet sign-in is failing for some people",
  alerts: "Team alerts are delayed",
  agents: "AI agents are slow to connect",
  maintenance: "Maintenance",
};
/** The staff banner line for each kind. */
export const INCIDENT_STAFF_LINES: Record<IncidentKind, string> = {
  "slow-replies": "Some messages are reaching the inbox late.",
  "sign-in":
    "Wallet sign-in is failing for some people. If you're signed in, keep working.",
  alerts: "Team alerts are delayed. Check the inbox directly.",
  agents: "AI agents may take longer to answer cases.",
  maintenance:
    "Maintenance is under way. The inbox may pause for a few minutes.",
};

/** Widgets and the inbox banner hide an open notice with no update for
 * this long; the status page says "No update since". */
export const INCIDENT_STALE_MS = 6 * 3_600_000;

const iso = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
function validIncident(value: unknown): value is Incident {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    (INCIDENT_KINDS as readonly unknown[]).includes(row.kind) &&
    (row.state === "open" || row.state === "resolved") &&
    iso(row.startedAt) &&
    iso(row.updatedAt) &&
    (row.resolvedAt === null || iso(row.resolvedAt)) &&
    (row.note === null || typeof row.note === "string")
  );
}

/** Reads the public list without credentials. Throws when the service or
 * the shape is wrong, so each surface decides what a failure shows. */
export async function readIncidents(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Incident[]> {
  const response = await fetcher(`${SITE.community}/status/incidents`, {
    credentials: "omit",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(3_000)])
      : AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("Status can't load right now.");
  const body = (await response.json()) as { incidents?: unknown };
  if (!Array.isArray(body.incidents) || !body.incidents.every(validIncident))
    throw new Error("Status can't load right now.");
  return body.incidents;
}

/** Open notices updated within the last 6 hours, newest first. */
export function freshOpenIncidents(incidents: Incident[], now = Date.now()) {
  return incidents
    .filter(
      (incident) =>
        incident.state === "open" &&
        now - Date.parse(incident.updatedAt) < INCIDENT_STALE_MS,
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** "2026-09-28 14:05 UTC". */
export const utcTime = (value: string) =>
  `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
