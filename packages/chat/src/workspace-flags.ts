import gates from "./workspace-flags.json" with { type: "json" };
import type { ChatPrincipalId } from "./principal";

export const WORKSPACE_FEATURES = gates;
export type WorkspaceFlagKey = keyof typeof gates;
export const WORKSPACE_FLAG_KEYS = Object.keys(gates) as WorkspaceFlagKey[];
export const WORKSPACE_FLAG_MAX_DAYS = 90;
/** These services and protections have no workspace override. */
export const GLOBAL_ONLY = [
  "conversations",
  "supportWorkflow",
  "supportWidget",
  "realtime",
  "mediaStorage",
  "safetyService",
  "feedback",
  "supportCorpus",
  "grants",
  "accountSignIn",
  "siwe",
  "siws",
  "nonces",
  "replay",
  "rateLimits",
  "retention",
  "secretGuard",
  "guestCaps",
  "turnstile",
  "accessChecks",
  "standardMonthlyBilling",
] as const;
export function isWorkspaceFlagKey(value: unknown): value is WorkspaceFlagKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(gates, value)
  );
}
export function isMoneyFlag(key: WorkspaceFlagKey): boolean {
  return (
    key === "brainStorageCollection" ||
    key === "manualBilling" ||
    key === "usageAiResolution" ||
    key === "standardMonthlyBilling" ||
    key === "resolutionBilling" ||
    key === "pilotOrderForms" ||
    key.startsWith("pay.") ||
    key === "cardBilling"
  );
}
export type WorkspaceFlag = {
  key: WorkspaceFlagKey;
  on: true;
  until: string;
  operator: ChatPrincipalId;
  authenticatedAt: string;
  reason: string;
};
export type WorkspaceFeatures = Record<WorkspaceFlagKey, boolean>;
/** Source management serves Templ AI independently of optional answer reviews. */
export function hasSupportKnowledge(
  features: Partial<Pick<WorkspaceFeatures, "quality" | "managedAgent">> | undefined,
): boolean {
  return features?.quality === true || features?.managedAgent === true;
}
export type WorkspaceFlagRow = { workspace: string; flags: WorkspaceFlag[] };
