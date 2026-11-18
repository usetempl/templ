import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { communityFetch } from "./community-client";

export const HEALTH_STATUSES = ["ok", "degraded", "down"] as const;
export const TEMPL_SUPPORT_STATES = [
  "active",
  "setup",
  "paused",
  "suspended",
  "missing",
  "unreadable",
  "not-configured",
] as const;
export const CANARY_CHECKS = [
  "ok",
  "failing",
  "stale",
  "needs-setup",
  "off",
] as const;
export const CANARY_SETUPS = [
  "ok",
  "off",
  "needs-listing",
  "misconfigured",
] as const;
export const CANARY_STAGES = [
  "config",
  "probe",
  "preflight",
  "policy",
  "nonce",
  "challenge",
  "verify",
  "room-health",
  "join",
  "status",
  "write",
  "read-back",
  "logout",
] as const;
export const ALERT_OUTCOMES = [
  "sent",
  "failed",
  "not-configured",
  "invalid",
] as const;
export const ALERT_HOOKS = ["configured", "not-configured", "invalid"] as const;

type CanaryKind = "light" | "full";
/** `GET /operator/health` from the community worker: fixed labels, times and
 * counts only. */
export type OperatorHealth = {
  schemaVersion: 1;
  checkedAt: string;
  status: (typeof HEALTH_STATUSES)[number];
  checks: {
    storage: "ok" | "failed";
    chain: "ok" | "failed";
    templSupport: (typeof TEMPL_SUPPORT_STATES)[number];
    canary: (typeof CANARY_CHECKS)[number];
  };
  schedule: string | null;
  canary: {
    setup: (typeof CANARY_SETUPS)[number];
    lastRunAt: number | null;
    lastRunKind: CanaryKind | null;
    lastOkAt: number | null;
    lastFullOkAt: number | null;
    consecutiveFailures: number;
    lastFailure: {
      at: number;
      kind: CanaryKind;
      stage: (typeof CANARY_STAGES)[number];
      status: number;
    } | null;
    alert: {
      state: "ok" | "failing";
      lastSentAt: number | null;
      lastOutcome: (typeof ALERT_OUTCOMES)[number] | null;
    };
  } | null;
  alertHook: (typeof ALERT_HOOKS)[number];
  failures: {
    lastHour: Record<string, number>;
    last24h: Record<string, number>;
  };
  widgetBuilds: { days: number; counts: Record<string, number> };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const oneOf = (list: readonly string[], value: unknown) =>
  typeof value === "string" && list.includes(value);
const time = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && (value as number) > 0);
const counts = (value: unknown) =>
  isRecord(value) &&
  Object.values(value).every(
    (count) => Number.isSafeInteger(count) && (count as number) >= 0,
  );
function validCanary(value: unknown) {
  if (value === null) return true;
  if (!isRecord(value) || !isRecord(value.alert)) return false;
  const failure = value.lastFailure;
  return (
    oneOf(CANARY_SETUPS, value.setup) &&
    time(value.lastRunAt) &&
    (value.lastRunKind === null ||
      oneOf(["light", "full"], value.lastRunKind)) &&
    time(value.lastOkAt) &&
    time(value.lastFullOkAt) &&
    Number.isSafeInteger(value.consecutiveFailures) &&
    (failure === null ||
      (isRecord(failure) &&
        time(failure.at) &&
        oneOf(["light", "full"], failure.kind) &&
        oneOf(CANARY_STAGES, failure.stage) &&
        Number.isSafeInteger(failure.status))) &&
    oneOf(["ok", "failing"], value.alert.state) &&
    time(value.alert.lastSentAt) &&
    (value.alert.lastOutcome === null ||
      oneOf(ALERT_OUTCOMES, value.alert.lastOutcome))
  );
}
export function validOperatorHealth(value: unknown): value is OperatorHealth {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.checkedAt === "string" &&
    oneOf(HEALTH_STATUSES, value.status) &&
    isRecord(value.checks) &&
    oneOf(["ok", "failed"], value.checks.storage) &&
    oneOf(["ok", "failed"], value.checks.chain) &&
    oneOf(TEMPL_SUPPORT_STATES, value.checks.templSupport) &&
    oneOf(CANARY_CHECKS, value.checks.canary) &&
    (value.schedule === null || typeof value.schedule === "string") &&
    validCanary(value.canary) &&
    oneOf(ALERT_HOOKS, value.alertHook) &&
    isRecord(value.failures) &&
    counts(value.failures.lastHour) &&
    counts(value.failures.last24h) &&
    isRecord(value.widgetBuilds) &&
    counts(value.widgetBuilds.counts)
  );
}

/** Reads support health for a Templ operator's session. */
export function healthAdmin(principal: ChatPrincipalId) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async read(signal?: AbortSignal): Promise<OperatorHealth> {
      current();
      const result = await communityFetch<unknown>(
        "/operator/health",
        undefined,
        signal,
      );
      current();
      if (!validOperatorHealth(result))
        throw new Error("Support health could not be loaded. Try again.");
      return result;
    },
  };
}
