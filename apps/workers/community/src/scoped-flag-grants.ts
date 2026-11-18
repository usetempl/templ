import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type {
  WorkspaceFlag,
  WorkspaceFlagKey,
} from "@templ/chat/workspace-flags";
import { HttpError } from "./common";

export type ScopedFlagEnv = {
  APP_ORIGIN?: string;
  SUPPORT_SCOPED_FLAGS_ENABLED?: string;
  SUPPORT_SCOPED_FLAG_GRANTS?: string;
};
export type ScopedFlagGrant = {
  id: string;
  workspace: string;
  operator: ChatPrincipalId;
  manager: ChatPrincipalId;
  kind: "pilot" | "demo";
  keys: ("protocolProfile" | "priorityFeed")[];
  startsAt: string;
  until: string;
  reason: string;
  approvedAt: "2026-10-03";
  approvedBy: "founder";
  approval: "Yes, scoped and audited";
};
export const SCOPED_FLAG_ISSUERS_KEY = "workspace-scoped-flag-issuers-v1";
export const SCOPED_FLAG_REVOCATIONS_KEY =
  "workspace-scoped-flag-revocations-v1";
export type ScopedFlagIssuer = {
  grantId: string;
  manager: ChatPrincipalId;
  flag: WorkspaceFlag;
};
export type ScopedFlagIssuers = Partial<
  Record<WorkspaceFlagKey, ScopedFlagIssuer>
>;
type Reader = { get<T>(key: string): Promise<T | undefined> };
const FLAG_FIELDS = [
  "key",
  "on",
  "operator",
  "until",
  "reason",
  "authenticatedAt",
] as const;
export function sameScopedFlag(
  a: WorkspaceFlag | undefined,
  b: WorkspaceFlag | undefined,
): boolean {
  return Boolean(
    a &&
    b &&
    Object.keys(a).sort().join() === [...FLAG_FIELDS].sort().join() &&
    Object.keys(b).sort().join() === [...FLAG_FIELDS].sort().join() &&
    FLAG_FIELDS.every((key) => a[key] === b[key]),
  );
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_MS = 90 * 86_400_000;
const KEYS = ["protocolProfile", "priorityFeed"] as const;
const fields = [
  "id",
  "workspace",
  "operator",
  "manager",
  "kind",
  "keys",
  "startsAt",
  "until",
  "reason",
  "approvedAt",
  "approvedBy",
  "approval",
].sort();
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const canonical = (value: unknown): value is ChatPrincipalId =>
  typeof value === "string" && normalizeChatPrincipal(value) === value;

/** Only reviewed production grants delegate these two non-money flag writes. */
export function configuredScopedFlagGrants(
  env: ScopedFlagEnv,
): ScopedFlagGrant[] {
  try {
    const rows: unknown = JSON.parse(env.SUPPORT_SCOPED_FLAG_GRANTS ?? "[]");
    if (!Array.isArray(rows) || rows.length > 20) return [];
    const ids = new Set<string>();
    const bindings = new Set<string>();
    for (const value of rows) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const row = value as ScopedFlagGrant;
      if (
        Object.keys(row).sort().join() !== fields.join() ||
        typeof row.id !== "string" ||
        !ID.test(row.id) ||
        ids.has(row.id) ||
        !UUID.test(row.workspace) ||
        !canonical(row.operator) ||
        !canonical(row.manager) ||
        !["pilot", "demo"].includes(row.kind) ||
        !Array.isArray(row.keys) ||
        row.keys.length < 1 ||
        row.keys.length > 2 ||
        new Set(row.keys).size !== row.keys.length ||
        row.keys.some((key) => !KEYS.includes(key)) ||
        !iso(row.startsAt) ||
        !iso(row.until) ||
        Date.parse(row.startsAt) < Date.parse("2026-10-03T04:30:00.000Z") ||
        Date.parse(row.until) <= Date.parse(row.startsAt) ||
        Date.parse(row.until) - Date.parse(row.startsAt) > MAX_MS ||
        typeof row.reason !== "string" ||
        row.reason !== row.reason.trim() ||
        row.reason.length < 3 ||
        row.reason.length > 280 ||
        row.approvedAt !== "2026-10-03" ||
        row.approvedBy !== "founder" ||
        row.approval !== "Yes, scoped and audited"
      )
        return [];
      const binding = `${row.workspace}:${row.operator}`;
      if (bindings.has(binding)) return [];
      ids.add(row.id);
      bindings.add(binding);
    }
    return rows as ScopedFlagGrant[];
  } catch {
    return [];
  }
}

export function scopedFlagGrant(
  env: ScopedFlagEnv,
  input: { workspace: string; operator: string; id?: string; manager?: string },
  now = Date.now(),
): ScopedFlagGrant | undefined {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.SUPPORT_SCOPED_FLAGS_ENABLED !== "true"
  )
    return undefined;
  return configuredScopedFlagGrants(env).find(
    (row) =>
      row.workspace === input.workspace &&
      row.operator === input.operator &&
      (input.id === undefined || row.id === input.id) &&
      (input.manager === undefined || row.manager === input.manager) &&
      Date.parse(row.startsAt) <= now &&
      now < Date.parse(row.until),
  );
}
export function isScopedFlagOperator(
  env: ScopedFlagEnv,
  operator: string,
  now = Date.now(),
): boolean {
  return configuredScopedFlagGrants(env).some((row) =>
    Boolean(
      scopedFlagGrant(
        env,
        { workspace: row.workspace, operator, id: row.id },
        now,
      ),
    ),
  );
}
export async function requireScopedFlagGrant(
  storage: Reader,
  env: ScopedFlagEnv,
  input: { workspace: string; operator: string; id: string; manager: string },
  now = Date.now(),
): Promise<ScopedFlagGrant> {
  const grant = scopedFlagGrant(env, input, now);
  const revoked = await storage.get<Record<string, unknown>>(
    SCOPED_FLAG_REVOCATIONS_KEY,
  );
  if (!grant || revoked?.[grant.id] !== undefined)
    throw new HttpError(404, "Not found.");
  return grant;
}
/** Issuer markers narrow only their own flags; ordinary operator flags retain their shape. */
export async function currentScopedFlags(
  storage: Reader,
  env: ScopedFlagEnv,
  flags: Partial<Record<WorkspaceFlagKey, WorkspaceFlag>>,
  native: { room: { id: string; manager: string } } | undefined,
  now = Date.now(),
): Promise<Partial<Record<WorkspaceFlagKey, WorkspaceFlag>>> {
  const markers = await storage.get<ScopedFlagIssuers>(SCOPED_FLAG_ISSUERS_KEY);
  if (!markers) return flags;
  const result = { ...flags };
  for (const [key, marker] of Object.entries(markers)) {
    const flag = result[key as WorkspaceFlagKey];
    try {
      if (
        !native ||
        !marker ||
        Object.keys(marker).sort().join() !== "flag,grantId,manager" ||
        !flag ||
        !sameScopedFlag(marker.flag, flag) ||
        marker.manager !== native.room.manager
      )
        throw new Error();
      const grant = await requireScopedFlagGrant(
        storage,
        env,
        {
          workspace: native.room.id,
          operator: flag.operator,
          id: marker.grantId,
          manager: native.room.manager,
        },
        now,
      );
      if (
        !grant.keys.includes(key as "protocolProfile" | "priorityFeed") ||
        Date.parse(flag.until) > Date.parse(grant.until)
      )
        throw new Error();
    } catch {
      delete result[key as WorkspaceFlagKey];
    }
  }
  return result;
}
