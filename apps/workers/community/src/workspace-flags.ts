import {
  storageTrialOperatorScope,
  assertStorageTrialWorkspace,
  currentStorageTrialFlags,
} from "./brain-storage-trial-access";
import { MANAGED_QUALIFICATION_TRIAL, managedQualificationTrial, assertManagedQualificationWorkspace, revokeManagedQualification, currentManagedQualificationFlags } from "./managed-agent-trial-access";
import {
  GLOBAL_ONLY,
  WORKSPACE_FEATURES,
  WORKSPACE_FLAG_KEYS,
  WORKSPACE_FLAG_MAX_DAYS,
  isMoneyFlag,
  isWorkspaceFlagKey,
  hasSupportKnowledge,
  type WorkspaceFlag,
  type WorkspaceFlagKey,
  type WorkspaceFlagRow,
  type WorkspaceFeatures,
} from "@templ/chat/workspace-flags";
import {
  approvedManualBillingTrial,
  approvedUsageAiResolutionTrial,
  APPROVED_USAGE_AI_TRIAL,
  assertManualBillingTrialWorkspace,
  assertManualBillingTrialForm,
} from "./manual-billing-trial-access";
import type { AuthMethod } from "@templ/chat/principal";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError, json, siteOrigins, type Env } from "./common";
import {
  isOperatorAdmin,
  isTrialOperatorAdmin,
  trialOperatorPrincipal,
  type OperatorAdminEnv,
} from "./operator-admin";
import {
  requireWalletAuth,
} from "./privileged-auth";
import { appendAuditToStream, readAuditStream } from "./room-audit";
import { ACCESS_AUDIT_RETENTION, MAX_AUDIT_PAGE } from "@templ/chat/audit";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import { NATIVE_UUID, type NativeRoomRecord } from "./native-rooms";
import { PRODUCT_STATE_KEY, type ProductState } from "./product-entitlements";
import { wakeRoomAt } from "./room-alarm";
import { activeProductOrderForm } from "./product-order-forms";
import type { ProductUsageTerms } from "@templ/chat/usage-billing";
import { workspaceFeatureSnapshot } from "./workspace-feature-values";
import {
  activatedReleasedFeatures,
  activatedReleaseFlag,
  releaseActivationEnv,
} from "./release-activation";

import {
  configuredDemoFlagScopes,
  currentDemoFlags,
  DEMO_FLAG_ISSUERS_KEY,
  DEMO_FLAG_REVOCATIONS_KEY,
  isDemoFlagOperator,
  requireDemoFlagScope,
  sameDemoFlag,
  type DemoFlagIssuers,
  type DemoWorkspaceFlagEnv,
} from "./demo-workspace-flags";

import {
  configuredScopedFlagGrants,
  currentScopedFlags,
  isScopedFlagOperator,
  requireScopedFlagGrant,
  sameScopedFlag,
  scopedFlagGrant,
  SCOPED_FLAG_ISSUERS_KEY,
  SCOPED_FLAG_REVOCATIONS_KEY,
  type ScopedFlagEnv,
  type ScopedFlagIssuers,
} from "./scoped-flag-grants";

export type WorkspaceFlagEnv = DemoWorkspaceFlagEnv &
  ScopedFlagEnv & {
    APP_ORIGIN?: string;
    AUTH_RECORDS?: DurableObjectNamespace;
    RELEASE_IDENTITY?: string;
    CF_VERSION_METADATA?: Env["CF_VERSION_METADATA"];
    RELEASE_ACTIVATION_ENABLED?: string;
    RELEASE_ACTIVATION_KEY?: string;
    TRIAL_OPERATOR_PRINCIPALS?: string;
    RELEASED_FEATURES?: string;
    AGENT_API_ENABLED?: string;
    CARD_BILLING_ENABLED?: string;
    GUEST_TURNSTILE_ENABLED?: string;
    MANAGED_AGENT_ENABLED?: string;
    PRODUCT_PAYMENTS_ENABLED?: string;
    PRODUCT_MANUAL_BILLING_ENABLED?: string;
    PRODUCT_USAGE_AI_RESOLUTION_ENABLED?: string;
    PRODUCT_STANDARD_MONTHLY_BILLING_ENABLED?: string;
    PRODUCT_MANUAL_BILLING_TRIAL_SCOPE?: string;
    PRODUCT_RESOLUTION_BILLING_ENABLED?: string;
    PRODUCT_RESOLUTION_TRIAL_SCOPE?: string;
    PRODUCT_PILOT_ORDER_FORMS_ENABLED?: string;
    SUPPORT_AI_DRAFTS_ENABLED?: string;
    SUPPORT_APP_AI_REPLIES_ENABLED?: string;
    SUPPORT_HANDOFF_LEARNING_ENABLED?: string;
    SUPPORT_AI_INTERACTIONS_ENABLED?: string;
    SUPPORT_BRAIN_STORAGE_ENABLED?: string;
    BRAIN_STORAGE_COLLECTION_ENABLED?: string;
    BRAIN_STORAGE_COLLECTION_TRIAL_SCOPE?: string;
    SUPPORT_ALERTS_ENABLED?: string;
    SUPPORT_DIAGNOSIS_ENABLED?: string;
    SUPPORT_DOMAIN_VERIFY_ENABLED?: string;
    SUPPORT_FOLLOW_UPS_ENABLED?: string;
    SUPPORT_HOSTED_PAGE_ENABLED?: string;
    SUPPORT_CONNECT_ENABLED?: string;
    SUPPORT_INSTALL_CHECK_ENABLED?: string;
    SUPPORT_NOTIFICATIONS_ENABLED?: string;
    SUPPORT_PROTOCOL_PROFILE_ENABLED?: string;
    SUPPORT_PRIORITY_FEED_ENABLED?: string;
    SUPPORT_PUSH_ENABLED?: string;
    SUPPORT_QUALITY_ENABLED?: string;
    SUPPORT_TEAM_INVITES_ENABLED?: string;
    NATIVE_TELEGRAM_BRIDGE_ENABLED?: string;
    SUPPORT_WORKFLOW_ENABLED?: string;
    SUPPORT_WIDGET_FRAME_ENABLED?: string;
    SUPPORT_WIDGET_INTRO_ENABLED?: string;
    SUPPORT_WIDGET_CHAT_FIRST_ENABLED?: string;
    SUPPORT_DIAGNOSTICS_ENABLED?: string;
    SUPPORT_ENCRYPTION_ENABLED?: string;
    SUPPORT_WIDGET_LOOPBACK?: string;
    SUPPORT_WIDGET_REMEMBER?: string;
    SUPPORT_WIDGET_SMART_WALLETS?: string;
    SUPPORT_WIDGET_SOLANA_ENABLED?: string;
    SUPPORT_WORKSPACE_EXPORT_ENABLED?: string;
  };
type Reader = { get<T = unknown>(key: string): Promise<T | undefined> };
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
type IndexStorage = Pick<Storage, "get" | "put" | "delete" | "list">;
type IndexEnv = Partial<Pick<Env, "ROOMS" | "AUTH_RECORDS" | "APP_ORIGIN">>;
type FlagEnv = WorkspaceFlagEnv &
  OperatorAdminEnv &
  Partial<Pick<Env, "ROOMS">>;
type StoredFlags = Partial<Record<WorkspaceFlagKey, WorkspaceFlag>>;
const SCOPED_FLAGS = Symbol("workspace-flags");
const SCOPED_FEATURES = Symbol("workspace-features");
const SCOPED_WORKSPACE = Symbol("workspace-feature-id");
type ScopedEnv = WorkspaceFlagEnv & {
  [SCOPED_FLAGS]?: StoredFlags;
  [SCOPED_FEATURES]?: WorkspaceFeatures;
  [SCOPED_WORKSPACE]?: string;
};
export const WORKSPACE_FLAGS_KEY = "workspace-flags-v1";
export const WORKSPACE_FLAGS_INDEX_OBJECT = "workspace-flags-index";
export const WORKSPACE_FLAGS_INDEX_PATH = "/private/workspace-flags-index";
export const WORKSPACE_FLAGS_ROOM_PATH = "/private/workspace-flags";
export const WORKSPACE_FEATURES_ROOM_PATH = "/private/workspace-features";
const INDEX_PREFIX = "workspace-flags-index-v1:";
const INDEX_TOMBSTONE_PREFIX = "workspace-flags-index-tombstone-v1:";
const INDEX_OUTBOX = "workspace-flags-index-outbox-v1";
const INDEX_REVISION = "workspace-flags-index-revision-v1";
const DAY = 86_400_000;
const PAGE = 50;
const TRIAL_HOUR = 60 * 60_000;
const TRIAL_FEATURES = new Set<WorkspaceFlagKey>([
  "supportDiagnostics",
  "agentApi",
  "aiDrafts",
  "handoffLearning",
  "aiInteractionImprovements",
  "quality",
  "installConnect",
  "protocolProfile",
  "priorityFeed",
  "diagnosis.evm",
  "diagnosis.solana",
  "solanaSignIn",
  "installCheck",
]);
export const OWN_TRIAL_FEATURES = new Set<WorkspaceFlagKey>([
  "hostedSupportPage",
  "verifiedDomain",
  "frameMode",
  "smartWalletSignIn",
  "guestCheck",
  "workspaceExport",
  "followUps",
]);
const OWN_TRIAL_MS = 59 * 60_000;
export const OWN_TRIAL_ISSUERS_KEY = "workspace-own-trial-issuers-v1";
export const OWN_TRIAL_USED_KEY = "workspace-own-trial-used-v1";
type OwnTrialIssuer = {
  workspace: string;
  creator: ChatPrincipalId;
  trialOperator: ChatPrincipalId;
  createdAt: string;
  flag: WorkspaceFlag;
};
type OwnTrialIssuers = Partial<Record<WorkspaceFlagKey, OwnTrialIssuer>>;
type OwnTrialUses = Partial<
  Record<WorkspaceFlagKey, "active" | "closed" | "replaced">
>;

function ownTrialScope(
  env: WorkspaceFlagEnv,
  native: NativeRoomRecord | undefined,
  issuer: OwnTrialIssuer,
  product: ProductState | undefined,
  deleting: unknown,
  now: number,
): boolean {
  const createdAt = Date.parse(issuer.createdAt);
  const authenticatedAt = Date.parse(issuer.flag.authenticatedAt);
  return Boolean(
    env.APP_ORIGIN === "https://usetempl.com" &&
    native &&
    NATIVE_UUID.test(issuer.workspace) &&
    native.room.id === issuer.workspace &&
    native.room.creator === issuer.creator &&
    native.room.manager === issuer.creator &&
    native.room.pendingManager == null &&
    native.room.createdAt === issuer.createdAt &&
    (!product || product.creator === issuer.creator) &&
    deleting === undefined &&
    issuer.creator === issuer.flag.operator &&
    native.trialOperator === issuer.trialOperator &&
    trialOperatorPrincipal(env, issuer.trialOperator) ===
      issuer.trialOperator &&
    OWN_TRIAL_FEATURES.has(issuer.flag.key) &&
    issuer.flag.on === true &&
    Number.isFinite(createdAt) &&
    createdAt <= now &&
    now < createdAt + OWN_TRIAL_MS &&
    issuer.flag.until === new Date(createdAt + OWN_TRIAL_MS).toISOString() &&
    Number.isSafeInteger(authenticatedAt) &&
    authenticatedAt <= now,
  );
}

/** Closed trial grants remain used; full operator replacements keep their own authority. */
async function currentOwnTrialFlags(
  storage: Reader,
  env: WorkspaceFlagEnv,
  flags: StoredFlags,
  native: NativeRoomRecord | undefined,
  now: number,
): Promise<StoredFlags> {
  if (![...OWN_TRIAL_FEATURES].some((key) => flags[key] !== undefined))
    return flags;
  const issuers = await storage.get<OwnTrialIssuers>(OWN_TRIAL_ISSUERS_KEY);
  const used = await storage.get<OwnTrialUses>(OWN_TRIAL_USED_KEY);
  if (!issuers && !used) return flags;
  const result = { ...flags };
  const product = await storage.get<ProductState>(PRODUCT_STATE_KEY);
  const deleting = await storage.get("workspace-deletion-v1");
  for (const key of OWN_TRIAL_FEATURES) {
    const issuer = issuers?.[key];
    const state = used?.[key];
    if (!issuer && state === undefined) continue;
    if (state === "replaced") continue;
    if (
      state !== "active" ||
      !issuer ||
      !sameScopedFlag(issuer.flag, result[key]) ||
      issuer.flag.key !== key ||
      !ownTrialScope(env, native, issuer, product, deleting, now)
    )
      delete result[key];
  }
  return result;
}

function released(env: WorkspaceFlagEnv, key: WorkspaceFlagKey): boolean {
  if (key === "teamInvites" && env.APP_ORIGIN === "https://usetempl.com")
    return (
      env.SUPPORT_WORKFLOW_ENABLED === "true" &&
      activatedReleaseFlag(env, "supportWorkflowVerified")
    );
  const feature = WORKSPACE_FEATURES[key];
  if ("workspaceOnly" in feature && feature.workspaceOnly) return false;
  if (env.APP_ORIGIN === "https://usetempl.com")
    return activatedReleasedFeatures(env).includes(key);
  try {
    const value: unknown = JSON.parse(env.RELEASED_FEATURES ?? "[]");
    return (
      Array.isArray(value) &&
      value.every(isWorkspaceFlagKey) &&
      value.includes(key)
    );
  } catch {
    return false;
  }
}
function effective(
  env: WorkspaceFlagEnv,
  flags: StoredFlags,
  key: WorkspaceFlagKey,
): boolean {
  if (key === "teamInvites" && env.APP_ORIGIN === "https://usetempl.com")
    return env.SUPPORT_TEAM_INVITES_ENABLED === "true" && released(env, key);
  if (isMoneyFlag(key) && (env as ScopedEnv)[SCOPED_WORKSPACE] === MANAGED_QUALIFICATION_TRIAL.workspace) return false;
  if (
    env[WORKSPACE_FEATURES[key].killSwitch as keyof WorkspaceFlagEnv] !== "true"
  )
    return false;
  const flag = flags[key];
  if (key === "standardMonthlyBilling") return released(env, key);
  if (key === "managedAgent" && (env as ScopedEnv)[SCOPED_WORKSPACE] === MANAGED_QUALIFICATION_TRIAL.workspace)
    return Boolean(flag?.on && Date.parse(flag.until) > Date.now() && managedQualificationTrial(env, flag.operator, MANAGED_QUALIFICATION_TRIAL.workspace));
  if (
    key === "usageAiResolution" &&
    !released(env, key) &&
    (env.APP_ORIGIN === "https://usetempl.com" ||
      env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE !== undefined) &&
    !approvedUsageAiResolutionTrial(
      env,
      flag?.operator,
      (env as ScopedEnv)[SCOPED_WORKSPACE],
      Date.now(),
    )
  )
    return false;
  if (
    key === "manualBilling" &&
    !released(env, key) &&
    (env.APP_ORIGIN === "https://usetempl.com" ||
      env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE !== undefined) &&
    !manualBillingTrialScope(
      env,
      (env as ScopedEnv)[SCOPED_WORKSPACE],
      flag?.operator,
      Date.now(),
    )
  )
    return false;
  if (
    key === "resolutionBilling" &&
    !released(env, key) &&
    (env.PRODUCT_RESOLUTION_TRIAL_SCOPE !== undefined ||
      env.APP_ORIGIN === "https://usetempl.com") &&
    !resolutionMoneyTrialScope(
      env,
      (env as ScopedEnv)[SCOPED_WORKSPACE],
      flag?.operator,
      Date.now(),
    )
  )
    return false;
  return (
    released(env, key) ||
    Boolean(flag?.on && Date.parse(flag.until) > Date.now())
  );
}
/** A missing workspace uses only its kill switch and release record. */
export function featureOn(
  env: WorkspaceFlagEnv,
  storage: undefined,
  key: WorkspaceFlagKey,
): boolean;
export function featureOn(
  env: WorkspaceFlagEnv,
  storage: Reader,
  key: WorkspaceFlagKey,
): Promise<boolean>;
export function featureOn(
  env: WorkspaceFlagEnv,
  storage: Reader | undefined,
  key: WorkspaceFlagKey,
): boolean | Promise<boolean> {
  if (!isWorkspaceFlagKey(key)) return false;
  if (storage)
    return workspaceFeatureEnv(env, storage).then((scoped) =>
      effective(scoped, (scoped as ScopedEnv)[SCOPED_FLAGS] ?? {}, key),
    );
  const values = (env as ScopedEnv)[SCOPED_FEATURES];
  if (key === "standardMonthlyBilling")
    return env.PRODUCT_STANDARD_MONTHLY_BILLING_ENABLED === "true" && released(env, key);
  if (
    values &&
    key === "teamInvites" &&
    env.APP_ORIGIN === "https://usetempl.com" &&
    !released(env, key)
  )
    return false;
  if (
    values &&
    key === "usageAiResolution" &&
    !released(env, key) &&
    (env.APP_ORIGIN === "https://usetempl.com" ||
      env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE !== undefined) &&
    !approvedUsageAiResolutionTrial(
      env,
      APPROVED_USAGE_AI_TRIAL.operator,
      (env as ScopedEnv)[SCOPED_WORKSPACE],
      Date.now(),
    )
  )
    return false;
  if (
    values &&
    key === "manualBilling" &&
    !released(env, key) &&
    (env.APP_ORIGIN === "https://usetempl.com" ||
      env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE !== undefined) &&
    !manualBillingTrialScope(
      env,
      (env as ScopedEnv)[SCOPED_WORKSPACE],
      undefined,
      Date.now(),
    )
  )
    return false;
  if (
    values &&
    key === "resolutionBilling" &&
    !released(env, key) &&
    (env.PRODUCT_RESOLUTION_TRIAL_SCOPE !== undefined ||
      env.APP_ORIGIN === "https://usetempl.com") &&
    !resolutionMoneyTrialScope(
      env,
      (env as ScopedEnv)[SCOPED_WORKSPACE],
      undefined,
      Date.now(),
    )
  )
    return false;
  if (values && isMoneyFlag(key) && (env as ScopedEnv)[SCOPED_WORKSPACE] === MANAGED_QUALIFICATION_TRIAL.workspace) return false;
  if (values)
    return (
      env[WORKSPACE_FEATURES[key].killSwitch as keyof WorkspaceFlagEnv] ===
        "true" && values[key] === true
    );
  return effective(env, (env as ScopedEnv)[SCOPED_FLAGS] ?? {}, key);
}
async function currentIssuedFlags(
  storage: Reader,
  env: WorkspaceFlagEnv,
  flags: StoredFlags,
  native: NativeRoomRecord | undefined,
  now = Date.now(),
): Promise<StoredFlags> {
  flags = await currentStorageTrialFlags(storage, env, flags, native, now);
  flags = await currentManagedQualificationFlags(storage, env, flags as Record<string, WorkspaceFlag>, native, now);
  return currentDemoFlags(
    storage,
    env,
    await currentScopedFlags(
      storage,
      env,
      await currentOwnTrialFlags(storage, env, flags, native, now),
      native,
      now,
    ),
    native,
    now,
  );
}
/** Scope a request without changing its worker environment or shared state. */
export async function workspaceFeatureEnv<T extends WorkspaceFlagEnv>(
  env: T,
  storage: Reader,
): Promise<T> {
  env = await releaseActivationEnv(env);
  const flags = await storage.get<StoredFlags>(WORKSPACE_FLAGS_KEY);
  const native = await storage.get<NativeRoomRecord>("native-room");
  return Object.assign({}, env, {
    [SCOPED_FLAGS]: await currentIssuedFlags(storage, env, flags ?? {}, native),
    [SCOPED_FEATURES]: undefined,
    [SCOPED_WORKSPACE]: native?.room.id,
  });
}
export function workspaceFeatureEnvFromFlags<T extends WorkspaceFlagEnv>(
  env: T,
  flags: WorkspaceFlag[],
  workspace?: string,
): T {
  return Object.assign({}, env, {
    [SCOPED_FLAGS]: Object.fromEntries(flags.map((flag) => [flag.key, flag])),
    [SCOPED_FEATURES]: undefined,
    [SCOPED_WORKSPACE]: workspace,
  });
}
export function workspaceFeatureEnvFromValues<T extends WorkspaceFlagEnv>(
  env: T,
  values: WorkspaceFeatures,
  workspace?: string,
): T {
  return Object.assign({}, env, {
    [SCOPED_FEATURES]: values,
    [SCOPED_FLAGS]: undefined,
    [SCOPED_WORKSPACE]: workspace,
  });
}
export function workspaceFeatureValues(
  env: WorkspaceFlagEnv,
): WorkspaceFeatures {
  return Object.fromEntries(
    WORKSPACE_FLAG_KEYS.map((key) => [key, featureOn(env, undefined, key)]),
  ) as WorkspaceFeatures;
}
/** The private room binding supplies values for this workspace alone. */
export async function workspaceFeatureEnvFor<
  T extends WorkspaceFlagEnv & Pick<Env, "ROOMS">,
>(env: T, workspace: string): Promise<T> {
  if (!NATIVE_UUID.test(workspace))
    throw new HttpError(400, "Invalid workspace.");
  if ((env as ScopedEnv)[SCOPED_WORKSPACE] === workspace) return env;
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${workspace}`),
  ).fetch(
    new Request(`https://internal${WORKSPACE_FEATURES_ROOM_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  if (!response.ok)
    throw new HttpError(response.status, "The workspace could not answer.");
  const body = (await response.json()) as { features?: unknown };
  const values = workspaceFeatureSnapshot(body.features);
  return Object.assign({}, env, {
    [SCOPED_FEATURES]: values,
    [SCOPED_WORKSPACE]: workspace,
  });
}
export async function workspaceFeatures(
  env: WorkspaceFlagEnv,
  storage: Reader,
): Promise<WorkspaceFeatures> {
  const scoped = await workspaceFeatureEnv(env, storage);
  return Object.fromEntries(
    WORKSPACE_FLAG_KEYS.map((key) => [key, featureOn(scoped, undefined, key)]),
  ) as WorkspaceFeatures;
}
/** Use current scoped availability without enabling review or storage features. */
export function supportKnowledgeOn(env: WorkspaceFlagEnv): boolean {
  return hasSupportKnowledge({
    quality: featureOn(env, undefined, "quality"),
    managedAgent: featureOn(env, undefined, "managedAgent"),
  });
}
export async function activeWorkspaceFlags(
  storage: Reader,
  now = Date.now(),
  env?: WorkspaceFlagEnv,
): Promise<WorkspaceFlag[]> {
  const flags = await storage.get<StoredFlags>(WORKSPACE_FLAGS_KEY);
  const current = env
    ? await currentIssuedFlags(
        storage,
        env,
        flags ?? {},
        await storage.get<NativeRoomRecord>("native-room"),
        now,
      )
    : (flags ?? {});
  return Object.values(current)
    .filter((flag): flag is WorkspaceFlag =>
      Boolean(flag?.on && Date.parse(flag.until) > now),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}
function flagInput(body: Record<string, unknown>, now: number) {
  if ((GLOBAL_ONLY as readonly unknown[]).includes(body.key))
    throw new HttpError(400, "This feature applies to every workspace.");
  if (!isWorkspaceFlagKey(body.key))
    throw new HttpError(400, "Choose a known feature.");
  if (typeof body.on !== "boolean")
    throw new HttpError(400, "Choose on or off.");
  if (
    typeof body.reason !== "string" ||
    body.reason.trim().length < 3 ||
    body.reason.length > 280
  )
    throw new HttpError(400, "Use a reason of 3 to 280 characters.");
  const until = typeof body.until === "string" ? Date.parse(body.until) : NaN;
  if (
    !Number.isFinite(until) ||
    until <= now ||
    until > now + WORKSPACE_FLAG_MAX_DAYS * DAY
  )
    throw new HttpError(400, "Choose an end date within 90 days.");
  const operator = normalizeChatPrincipal(body.operator);
  if (!operator) throw new HttpError(400, "Invalid operator account.");
  const authenticatedAt = Number(body.authenticatedAt);
  if (!Number.isSafeInteger(authenticatedAt))
    throw new HttpError(401, "Sign in with your wallet again.");
  return {
    key: body.key,
    on: body.on,
    reason: body.reason.trim(),
    until: new Date(until).toISOString(),
    operator,
    authenticatedAt: new Date(authenticatedAt).toISOString(),
  };
}
/** The flag and its access audit commit together in the room transaction. */
export async function setWorkspaceFlag(
  storage: Storage,
  env: FlagEnv,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<WorkspaceFlag[]> {
  const input = flagInput(body, now);
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) throw new HttpError(404, "Workspace not found.");
  if ((await storage.get("workspace-deletion-v1")) !== undefined)
    throw new HttpError(410, "This workspace is being deleted.");
  const trial = isTrialOperatorAdmin(
    env,
    input.operator,
    body.servicePrincipals ?? [input.operator],
  );
  const flags = (await storage.get<StoredFlags>(WORKSPACE_FLAGS_KEY)) ?? {};
  if (
    !(trial && OWN_TRIAL_FEATURES.has(input.key)) &&
    body.expectedFlag !== undefined &&
    body.expectedFlag !== null
  ) {
    const expected = body.expectedFlag as WorkspaceFlag;
    const current = flags[input.key];
    if (
      !current ||
      !expected ||
      ["key", "on", "operator", "until", "reason", "authenticatedAt"].some(
        (key) =>
          current[key as keyof WorkspaceFlag] !==
          expected[key as keyof WorkspaceFlag],
      )
    )
      throw new HttpError(409, "The workspace flag changed.");
  }
  const demo = body.demoScopeId !== undefined || body.planSha256 !== undefined;
  const storedDemoIssuers = await storage.get<DemoFlagIssuers>(
    DEMO_FLAG_ISSUERS_KEY,
  );
  const demoIssuers = storedDemoIssuers ?? {};
  const scoped = body.scopeGrantId !== undefined;
  const storedIssuers = await storage.get<ScopedFlagIssuers>(
    SCOPED_FLAG_ISSUERS_KEY,
  );
  const issuers = storedIssuers ?? {};
  const storedOwnIssuers = await storage.get<OwnTrialIssuers>(
    OWN_TRIAL_ISSUERS_KEY,
  );
  const ownIssuers = storedOwnIssuers ?? {};
  const storedOwnUses = await storage.get<OwnTrialUses>(OWN_TRIAL_USED_KEY);
  const ownUses = storedOwnUses ?? {};
  const ownTrial =
    trial && !demo && !scoped && OWN_TRIAL_FEATURES.has(input.key);
  if (demo && scoped) throw new HttpError(404, "Not found.");
  if (demo) {
    requireWalletAuth(
      {
        authenticatedAt: Number(body.authenticatedAt),
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    const { scope, row } = await requireDemoFlagScope(
      storage,
      env,
      {
        id: body.demoScopeId,
        planSha256: body.planSha256,
        operator: input.operator,
        workspace: native.room.id,
      },
      now,
    );
    if (
      !row.keys.includes(input.key as "rememberSignIn" | "emailNotices") ||
      Date.parse(input.until) > Date.parse(scope.until) ||
      env[
        WORKSPACE_FEATURES[input.key].killSwitch as keyof WorkspaceFlagEnv
      ] !== "true"
    )
      throw new HttpError(403, "Use the approved Demo feature scope.");
    const current = flags[input.key];
    const issuer = demoIssuers[input.key];
    if (
      input.on
        ? Boolean(current)
        : !current ||
          !sameDemoFlag(current, body.expectedFlag as WorkspaceFlag) ||
          !issuer ||
          issuer.scopeId !== scope.id ||
          issuer.planSha256 !== scope.planSha256 ||
          !sameDemoFlag(issuer.flag, current)
    )
      throw new HttpError(
        409,
        "The scope can change only its own unchanged flag.",
      );
    if (input.on)
      demoIssuers[input.key] = {
        scopeId: scope.id,
        planSha256: scope.planSha256,
        creator: row.creator,
        manager: row.manager,
        flag: { ...input, on: true },
      };
    else delete demoIssuers[input.key];
  } else if (scoped) {
    if (typeof body.scopeGrantId !== "string")
      throw new HttpError(404, "Not found.");
    requireWalletAuth(
      {
        authenticatedAt: Number(body.authenticatedAt),
        authMethod: body.authMethod as AuthMethod,
      },
      true,
      now,
    );
    const grant = await requireScopedFlagGrant(
      storage,
      env,
      {
        workspace: native.room.id,
        operator: input.operator,
        id: body.scopeGrantId,
        manager: native.room.manager,
      },
      now,
    );
    if (
      !grant.keys.includes(input.key as "protocolProfile" | "priorityFeed") ||
      Date.parse(input.until) > Date.parse(grant.until) ||
      env[
        WORKSPACE_FEATURES[input.key].killSwitch as keyof WorkspaceFlagEnv
      ] !== "true"
    )
      throw new HttpError(404, "Not found.");
    const current = flags[input.key];
    const issuer = issuers[input.key];
    if (
      current &&
      (!issuer ||
        issuer.grantId !== grant.id ||
        issuer.manager !== grant.manager ||
        !sameScopedFlag(issuer.flag, current) ||
        !sameScopedFlag(body.expectedFlag as WorkspaceFlag, current))
    )
      throw new HttpError(409, "The scoped flag changed.");
    if (!input.on && !current)
      throw new HttpError(409, "The scoped flag changed.");
    if (input.on)
      issuers[input.key] = {
        grantId: grant.id,
        manager: grant.manager,
        flag: { ...input, on: true },
      };
    else delete issuers[input.key];
  } else if (
    trial &&
    ["quality", "brainStorage"].includes(input.key) &&
    storageTrialOperatorScope(env, input.operator, native.room.id, now)
  ) {
    requireWalletAuth(
      {
        authenticatedAt: Number(body.authenticatedAt),
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    const storageScope = await assertStorageTrialWorkspace(
      storage,
      env,
      input.operator,
      native.room.id,
      now,
    );
    if (
      Date.parse(input.until) !== storageScope.endsAt ||
      input.reason !== "Synthetic hosted storage verification"
    )
      throw new HttpError(404, "Not found.");
    const current = flags[input.key];
    if (
      input.on
        ? Boolean(current)
        : !current ||
          current.operator !== input.operator ||
          !sameScopedFlag(current, body.expectedFlag as WorkspaceFlag)
    )
      throw new HttpError(
        409,
        "The trial can change only its own unchanged flag.",
      );
  } else if (trial && input.key === "managedAgent" && managedQualificationTrial(env, input.operator, native.room.id, now)) {
    requireWalletAuth({ authenticatedAt: Number(body.authenticatedAt), authMethod: body.authMethod as AuthMethod }, body.confirmed, now);
    await assertManagedQualificationWorkspace(storage, env, input.operator, now, !input.on);
    if (Date.parse(input.until) > Date.parse(MANAGED_QUALIFICATION_TRIAL.until)) throw new HttpError(404, "Not found.");
    const current = flags.managedAgent;
    if (input.on ? Boolean(current) : !current || current.operator !== input.operator || !sameScopedFlag(current, body.expectedFlag as WorkspaceFlag)) throw new HttpError(409, "The trial can change only its own unchanged flag.");
    if (!input.on) await revokeManagedQualification(storage, now);
  } else if (
    trial &&
    (input.key === "manualBilling" ||
      (input.key === "usageAiResolution" &&
        (!input.on ||
          approvedUsageAiResolutionTrial(
            env,
            input.operator,
            native.room.id,
            now,
          )))) &&
    approvedManualBillingTrial(env, input.operator, native.room.id, now)
  ) {
    requireWalletAuth(
      {
        authenticatedAt: Number(body.authenticatedAt),
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    await assertManualBillingTrialWorkspace(storage, env, input.operator, now);
    const current = flags[input.key];
    if (
      input.on
        ? Boolean(current)
        : !current ||
          current.operator !== input.operator ||
          !sameScopedFlag(current, body.expectedFlag as WorkspaceFlag)
    )
      throw new HttpError(
        409,
        "The trial can change only its own unchanged flag.",
      );
  } else if (trial) {
    const operator = trialOperatorPrincipal(env, native.trialOperator);
    const principals = sessionPrincipals({
      principalId: input.operator,
      servicePrincipals: (body.servicePrincipals ?? [input.operator]) as never,
    });
    const createdAt = Date.parse(native.room.createdAt);
    const product = await storage.get<ProductState>(PRODUCT_STATE_KEY);
    if (
      !operator ||
      !principals.includes(operator) ||
      native.room.creator !== native.room.manager ||
      (["handoffLearning", "aiInteractionImprovements"].includes(input.key) && !principals.includes(native.room.creator)) ||
      (product && product.creator !== native.room.creator) ||
      !Number.isFinite(createdAt) ||
      createdAt > now ||
      now >= createdAt + TRIAL_HOUR ||
      Date.parse(input.until) > createdAt + TRIAL_HOUR ||
      (!TRIAL_FEATURES.has(input.key) && !ownTrial) ||
      env[
        WORKSPACE_FEATURES[input.key].killSwitch as keyof WorkspaceFlagEnv
      ] !== "true"
    )
      throw new HttpError(
        403,
        "Use a fresh trial workspace and its listed operator.",
      );
    const current = flags[input.key];
    if (ownTrial) {
      requireWalletAuth(
        {
          authenticatedAt: Number(body.authenticatedAt),
          authMethod: body.authMethod as AuthMethod,
        },
        true,
        now,
      );
      const issuer: OwnTrialIssuer = {
        workspace: native.room.id,
        creator: input.operator,
        trialOperator: operator,
        createdAt: native.room.createdAt,
        flag: { ...input, on: true },
      };
      if (
        body.expectedPrincipalId !== input.operator ||
        !ownTrialScope(env, native, issuer, product, undefined, now) ||
        (input.on && now - createdAt >= 60_000)
      )
        throw new HttpError(403, "Use your own new trial workspace.");
      if (input.on) {
        if (
          body.expectedFlag !== null ||
          current ||
          ownIssuers[input.key] !== undefined ||
          ownUses[input.key] !== undefined
        )
          throw new HttpError(409, "This trial feature cannot be enabled.");
        ownIssuers[input.key] = issuer;
        ownUses[input.key] = "active";
      } else {
        const original = ownIssuers[input.key];
        if (
          ownUses[input.key] !== "active" ||
          !original ||
          !ownTrialScope(env, native, original, product, undefined, now) ||
          !sameScopedFlag(original.flag, current) ||
          !sameScopedFlag(current, body.expectedFlag as WorkspaceFlag)
        )
          throw new HttpError(
            409,
            "The trial can clear only its unchanged flag.",
          );
        ownUses[input.key] = "closed";
      }
    }
    if (input.on) {
      if (current)
        throw new HttpError(409, "The trial cannot replace an existing flag.");
    } else {
      const expected = body.expectedFlag as WorkspaceFlag | undefined;
      if (
        !current ||
        !expected ||
        current.operator !== input.operator ||
        ["key", "on", "operator", "until", "reason", "authenticatedAt"].some(
          (key) =>
            current[key as keyof WorkspaceFlag] !==
            expected[key as keyof WorkspaceFlag],
        )
      )
        throw new HttpError(
          409,
          "The trial can clear only its own unchanged flag.",
        );
    }
  }
  if (isMoneyFlag(input.key)) {
    if (
      (input.key === "manualBilling" || input.key === "usageAiResolution") &&
      input.on
    ) {
      const form = await activeProductOrderForm(storage, now);
      if (!form || form.service !== "software" || form.pilot)
        throw new HttpError(
          400,
          "Manual billing needs an active software agreement.",
        );
      if (input.key === "usageAiResolution") {
        if (form.usage?.templAiResolutionEnabled !== true)
          throw new HttpError(
            403,
            "The signed agreement does not enable AI resolution fees.",
          );
        if (
          !released(env, input.key) &&
          (env.APP_ORIGIN === "https://usetempl.com" ||
            env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE !== undefined) &&
          !approvedUsageAiResolutionTrial(
            env,
            input.operator,
            native.room.id,
            now,
          )
        )
          throw new HttpError(
            403,
            "AI resolution fees need their own production proof.",
          );
      }
      if (trial) assertManualBillingTrialForm(form);
      if (
        input.key === "manualBilling" &&
        !released(env, input.key) &&
        (env.APP_ORIGIN === "https://usetempl.com" ||
          env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE !== undefined)
      ) {
        const scope = manualBillingTrialScope(
          env,
          native.room.id,
          input.operator,
          now,
        );
        if (!scope || Date.parse(input.until) > Date.parse(scope.until))
          throw new HttpError(
            403,
            "Use the approved manual billing trial scope.",
          );
      }
    }
    if (
      input.key === "resolutionBilling" &&
      input.on &&
      !released(env, input.key) &&
      (env.PRODUCT_RESOLUTION_TRIAL_SCOPE !== undefined ||
        env.APP_ORIGIN === "https://usetempl.com")
    ) {
      const scope = resolutionMoneyTrialScope(
        env,
        native.room.id,
        input.operator,
        now,
      );
      if (!scope || Date.parse(input.until) > Date.parse(scope.until))
        throw new HttpError(403, "Use the approved money trial scope.");
    }
    const product = await storage.get<ProductState>(PRODUCT_STATE_KEY);
    const owner = product?.creator ?? native.room.creator;
    if (
      !isOperatorAdmin(env, owner, [owner]) &&
      !(await activeProductOrderForm(storage, now))
    )
      throw new HttpError(
        400,
        "Money features need an operator billing owner or an active order form.",
      );
  }
  if (body.expectedFlag === null && (!input.on || flags[input.key]))
    throw new HttpError(409, "The workspace flag changed.");
  if (
    !ownTrial &&
    (ownIssuers[input.key] !== undefined || ownUses[input.key] !== undefined)
  ) {
    if (
      !isOperatorAdmin(
        env,
        input.operator,
        body.servicePrincipals ?? [input.operator],
      )
    )
      throw new HttpError(403, "Only a Templ operator can replace this flag.");
    ownUses[input.key] = input.on ? "replaced" : "closed";
  }
  if (!scoped) delete issuers[input.key];
  if (input.on) flags[input.key] = { ...input, on: true };
  else delete flags[input.key];
  if (!demo) delete demoIssuers[input.key];
  if (demo || storedDemoIssuers !== undefined)
    await storage.put(DEMO_FLAG_ISSUERS_KEY, demoIssuers);
  await storage.put(WORKSPACE_FLAGS_KEY, flags);
  if (scoped || storedIssuers !== undefined)
    await storage.put(SCOPED_FLAG_ISSUERS_KEY, issuers);
  if (ownTrial || storedOwnIssuers !== undefined)
    await storage.put(OWN_TRIAL_ISSUERS_KEY, ownIssuers);
  if (ownTrial || storedOwnUses !== undefined)
    await storage.put(OWN_TRIAL_USED_KEY, ownUses);
  await appendAuditToStream(
    storage,
    "access",
    {
      actor: input.operator,
      authenticatedAt: input.authenticatedAt,
      action: "workspace.flag",
      target: input.key,
      after: {
        key: input.key,
        on: input.on,
        until: input.until,
        operator: input.operator,
        authenticatedAt: input.authenticatedAt,
        reason: input.reason,
        ...(demo
          ? { demoScopeId: body.demoScopeId, planSha256: body.planSha256 }
          : {}),
        ...(scoped ? { scopeGrantId: body.scopeGrantId } : {}),
      },
    },
    now,
  );
  await queueIndex(storage, native.room.id, now);
  await wakeRoomAt(storage, now + 1_000);
  return activeWorkspaceFlags(storage, now, env);
}

/** A production trial needs the current approved workspace, operator and end. */
export function resolutionMoneyTrialScope(
  env: WorkspaceFlagEnv,
  workspace: unknown,
  operator: unknown,
  now: number,
) {
  try {
    const entries: unknown = JSON.parse(
      env.PRODUCT_RESOLUTION_TRIAL_SCOPE ?? "[]",
    );
    if (
      !Array.isArray(entries) ||
      entries.length > 8 ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          Object.keys(entry).sort().join() !==
            "approvalSha256,operator,until,workspace" ||
          !NATIVE_UUID.test(entry.workspace) ||
          !normalizeChatPrincipal(entry.operator) ||
          !/^[0-9a-f]{64}$/.test(entry.approvalSha256) ||
          !Number.isFinite(Date.parse(entry.until)) ||
          new Date(entry.until).toISOString() !== entry.until,
      ) ||
      new Set(entries.map((entry) => entry.workspace)).size !== entries.length
    )
      return null;
    return (
      entries.find(
        (entry) =>
          entry.workspace === workspace &&
          (operator === undefined || entry.operator === operator) &&
          Date.parse(entry.until) > now,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Manual trials use a separate recorded scope and never enable payment rails. */
export function manualBillingTrialScope(
  env: WorkspaceFlagEnv,
  workspace: unknown,
  operator: unknown,
  now: number,
) {
  return resolutionMoneyTrialScope(
    {
      ...env,
      PRODUCT_RESOLUTION_TRIAL_SCOPE: env.PRODUCT_MANUAL_BILLING_TRIAL_SCOPE,
    },
    workspace,
    operator,
    now,
  );
}

/** The captured agreement and separate release proof must both permit this fee. */
export async function usageAiResolutionBillingOn(
  env: WorkspaceFlagEnv,
  storage: Reader,
  terms: ProductUsageTerms,
): Promise<boolean> {
  return (
    terms.templAiResolutionEnabled === true &&
    (await featureOn(env, storage, "manualBilling")) &&
    (await featureOn(env, storage, "usageAiResolution"))
  );
}

/** Production managed charges need their own proof or the approved money trial. */
export async function managedResolutionBillingOn(
  env: WorkspaceFlagEnv,
  storage: Reader,
): Promise<boolean> {
  const scoped = await workspaceFeatureEnv(env, storage);
  if (!featureOn(scoped, undefined, "managedAgent")) return false;
  if (
    scoped.APP_ORIGIN !== "https://usetempl.com" ||
    released(scoped, "managedAgent")
  )
    return true;
  const flags = (scoped as ScopedEnv)[SCOPED_FLAGS] ?? {};
  const money = flags.resolutionBilling;
  const managed = flags.managedAgent;
  const now = Date.now();
  if (
    !money?.on ||
    !managed?.on ||
    money.operator !== managed.operator ||
    !normalizeChatPrincipal(money.operator) ||
    Date.parse(money.until) <= now ||
    Date.parse(managed.until) <= now
  )
    return false;
  const scope = resolutionMoneyTrialScope(
    scoped,
    (scoped as ScopedEnv)[SCOPED_WORKSPACE],
    money.operator,
    now,
  );
  return Boolean(
    scope &&
    Date.parse(money.until) <= Date.parse(scope.until) &&
    Date.parse(managed.until) <= Date.parse(scope.until),
  );
}
type IndexUpdate = WorkspaceFlagRow & { revision: number; deleted?: true };
async function queueIndex(
  storage: IndexStorage,
  workspace: string,
  now: number,
  deleted = false,
) {
  const revision = ((await storage.get<number>(INDEX_REVISION)) ?? 0) + 1;
  await storage.put({
    [INDEX_REVISION]: revision,
    [INDEX_OUTBOX]: {
      workspace,
      revision,
      flags: deleted ? [] : await activeWorkspaceFlags(storage, now),
      ...(deleted ? { deleted: true as const } : {}),
    } satisfies IndexUpdate,
  });
}
/** A restore clears early access and queues its index removal together. */
export async function clearWorkspaceFlagsByRestore(
  storage: IndexStorage,
  actor: string,
  authenticatedAt: number,
  now: number,
): Promise<void> {
  const operator = normalizeChatPrincipal(actor);
  if (!operator || !Number.isSafeInteger(authenticatedAt))
    throw new HttpError(400, "Invalid restore operator.");
  const native = await storage.get<NativeRoomRecord>("native-room");
  const flags = await storage.get<StoredFlags>(WORKSPACE_FLAGS_KEY);
  const ownUses = await storage.get<OwnTrialUses>(OWN_TRIAL_USED_KEY);
  if (ownUses) {
    for (const key of OWN_TRIAL_FEATURES)
      if (ownUses[key] !== undefined) ownUses[key] = "closed";
    await storage.put(OWN_TRIAL_USED_KEY, ownUses);
  }
  await storage.delete([
    WORKSPACE_FLAGS_KEY,
    INDEX_OUTBOX,
    DEMO_FLAG_ISSUERS_KEY,
    SCOPED_FLAG_ISSUERS_KEY,
  ]);
  await appendAuditToStream(
    storage,
    "access",
    {
      actor: operator,
      authenticatedAt: new Date(authenticatedAt).toISOString(),
      action: "workspace.flag",
      target: WORKSPACE_FLAGS_KEY,
      after: {
        on: false,
        keys: Object.keys(flags ?? {}).sort(),
        reason: "cleared by restore",
      },
    },
    now,
  );
  if (native && NATIVE_UUID.test(native.room.id))
    await queueIndex(storage, native.room.id, now);
}
/** Deletion waits for this revision's removal before purging room storage. */
export async function removeDeletedWorkspaceFlags(
  storage: DurableObjectStorage,
  env: IndexEnv,
  workspace: string,
  now: number,
): Promise<boolean> {
  await storage.transaction(async (tx) => {
    const pending = await tx.get<IndexUpdate>(INDEX_OUTBOX);
    if (pending?.deleted) return;
    if (
      (await tx.get(INDEX_REVISION)) === undefined &&
      (await tx.get(WORKSPACE_FLAGS_KEY)) === undefined &&
      !pending
    )
      return;
    await tx.delete(WORKSPACE_FLAGS_KEY);
    await queueIndex(tx, workspace, now, true);
  });
  return flushWorkspaceFlagsIndex(storage, env);
}
export async function workspaceFlagsIndexRequest(
  storage: Storage,
  request: {
    method: string;
    body: Record<string, unknown>;
    query: URLSearchParams;
  },
): Promise<Response> {
  if (request.method === "POST") {
    const { workspace, revision, flags } = request.body;
    if (
      typeof workspace !== "string" ||
      !NATIVE_UUID.test(workspace) ||
      !Number.isSafeInteger(revision) ||
      !Array.isArray(flags)
    )
      throw new HttpError(400, "Invalid feature list.");
    const key = `${INDEX_PREFIX}${workspace}`;
    const tombstoneKey = `${INDEX_TOMBSTONE_PREFIX}${workspace}`;
    const current = await storage.get<IndexUpdate>(key);
    const tombstone = await storage.get<{ revision: number; deleted?: true }>(
      tombstoneKey,
    );
    const previous = Math.max(current?.revision ?? 0, tombstone?.revision ?? 0);
    if (Number(revision) > previous && !tombstone?.deleted) {
      if (flags.length && request.body.deleted !== true) {
        await storage.put(key, request.body);
        await storage.delete(tombstoneKey);
      } else {
        await storage.delete(key);
        await storage.put(tombstoneKey, {
          revision,
          ...(request.body.deleted === true ? { deleted: true } : {}),
        });
      }
    }
    return json({
      ok: true,
      revision: tombstone?.deleted
        ? previous
        : Math.max(previous, Number(revision)),
    });
  }
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  const after = request.query.get("after");
  if (after !== null && !NATIVE_UUID.test(after))
    throw new HttpError(400, "Invalid cursor.");
  const rows = await storage.list<IndexUpdate>({
    prefix: INDEX_PREFIX,
    limit: PAGE,
    ...(after ? { startAfter: `${INDEX_PREFIX}${after}` } : {}),
  });
  return json({
    workspaces: [...rows.values()]
      .filter((row) =>
        row.flags.some((flag) => Date.parse(flag.until) > Date.now()),
      )
      .map((row) => row.workspace),
    next: rows.size === PAGE ? [...rows.values()].at(-1)?.workspace : null,
  });
}
/** A durable outbox keeps the global index aligned after a room commit. */
export async function flushWorkspaceFlagsIndex(
  storage: DurableObjectStorage,
  env: IndexEnv,
): Promise<boolean> {
  const update = await storage.get<IndexUpdate>(INDEX_OUTBOX);
  if (!update) return true;
  if (!env.ROOMS) return false;
  try {
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(WORKSPACE_FLAGS_INDEX_OBJECT),
    ).fetch(
      new Request(`https://internal${WORKSPACE_FLAGS_INDEX_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const acknowledgement = (await response.json()) as {
      ok?: boolean;
      revision?: number;
    };
    if (
      acknowledgement.ok !== true ||
      !Number.isSafeInteger(acknowledgement.revision) ||
      acknowledgement.revision! < update.revision
    )
      return false;
    if (env.AUTH_RECORDS) {
      const namespace = siteOrigins(env as Pick<Env, "APP_ORIGIN">).origin
        .hostname;
      const config = await env.AUTH_RECORDS.get(
        env.AUTH_RECORDS.idFromName(
          `${namespace}:widget-config:${update.workspace}`,
        ),
      ).fetch(
        new Request("https://internal/widget-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "workspace-flags",
            revision: update.revision,
            flags: update.flags,
          }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!config.ok) {
        await config.body?.cancel();
        return false;
      }
      const saved = (await config.json()) as {
        ok?: boolean;
        revision?: number;
      };
      if (
        saved.ok !== true ||
        !Number.isSafeInteger(saved.revision) ||
        saved.revision! < update.revision
      )
        return false;
    }
    return storage.transaction(async (tx) => {
      const pending = await tx.get<IndexUpdate>(INDEX_OUTBOX);
      if (pending?.revision === update.revision) {
        await tx.delete(INDEX_OUTBOX);
        return true;
      }
      return pending === undefined;
    });
  } catch {
    return false;
  }
}
export async function expireWorkspaceFlags(
  storage: Storage,
  now: number,
): Promise<number | null> {
  const flags = (await storage.get<StoredFlags>(WORKSPACE_FLAGS_KEY)) ?? {};
  let changed = false;
  let next = Infinity;
  for (const [key, flag] of Object.entries(flags)) {
    if (!flag) continue;
    const until = Date.parse(flag.until);
    if (until > now) {
      next = Math.min(next, until);
      continue;
    }
    delete flags[key as WorkspaceFlagKey];
    changed = true;
    await appendAuditToStream(
      storage,
      "access",
      {
        actor: flag.operator,
        authenticatedAt: flag.authenticatedAt,
        action: "workspace.flag",
        target: key,
        after: {
          key,
          on: false,
          until: flag.until,
          operator: flag.operator,
          authenticatedAt: flag.authenticatedAt,
          reason: "expired",
        },
      },
      now,
    );
  }
  if (changed) {
    await storage.put(WORKSPACE_FLAGS_KEY, flags);
    const native = await storage.get<NativeRoomRecord>("native-room");
    if (native) await queueIndex(storage, native.room.id, now);
  }
  return Number.isFinite(next) ? next : null;
}
export async function workspaceFlagsAlarm(
  state: DurableObjectState,
  env: IndexEnv,
  now: number,
): Promise<number | null> {
  const next = await state.storage.transaction((tx) =>
    expireWorkspaceFlags(tx, now),
  );
  return (await flushWorkspaceFlagsIndex(state.storage, env))
    ? next
    : Math.min(next ?? Infinity, now + 60_000);
}
export type ConnectTrialContext = {
  trialOperator: `0x${string}`;
  createdAt: string;
  until: string;
  manager: ChatPrincipalId;
};

/** A fresh trial anchor delegates only its validated native marker. */
async function connectTrialMarker(
  storage: Storage,
  env: FlagEnv,
  body: Record<string, unknown>,
  now: number,
): Promise<ConnectTrialContext> {
  const refuse = () => {
    throw new HttpError(
      403,
      "Use a fresh trial workspace and its listed operator.",
    );
  };
  const actor = normalizeChatPrincipal(body.principalId);
  if (!actor) return refuse();
  const principals = sessionPrincipals({
    principalId: actor,
    servicePrincipals: body.servicePrincipals as never,
  });
  const native = await storage.get<NativeRoomRecord>("native-room");
  const marker = trialOperatorPrincipal(env, native?.trialOperator);
  const createdAt = Date.parse(native?.room.createdAt ?? "");
  const product = await storage.get<ProductState>(PRODUCT_STATE_KEY);
  const flag = (await storage.get<StoredFlags>(WORKSPACE_FLAGS_KEY))
    ?.installConnect;
  const until = Date.parse(flag?.until ?? "");
  const authenticatedAt = Date.parse(flag?.authenticatedAt ?? "");
  if (
    !native ||
    !marker ||
    !principals.includes(marker) ||
    !isTrialOperatorAdmin(env, actor, principals) ||
    native.room.creator !== native.room.manager ||
    !principals.includes(native.room.creator) ||
    native.room.visibility !== "public" ||
    (product && product.creator !== native.room.creator) ||
    (await storage.get("workspace-deletion-v1")) !== undefined ||
    !Number.isFinite(createdAt) ||
    createdAt > now ||
    now >= createdAt + TRIAL_HOUR ||
    env.SUPPORT_CONNECT_ENABLED !== "true" ||
    flag?.key !== "installConnect" ||
    flag.on !== true ||
    flag.operator !== actor ||
    !Number.isFinite(until) ||
    until <= now ||
    until > createdAt + TRIAL_HOUR ||
    !Number.isFinite(authenticatedAt) ||
    authenticatedAt > now ||
    typeof flag.reason !== "string" ||
    flag.reason.trim().length < 3 ||
    flag.reason.length > 280
  )
    return refuse();

  // The latest audit for this flag must describe the current stored write.
  let before: number | null = null;
  for (
    let scanned = 0;
    scanned < ACCESS_AUDIT_RETENTION.count;
    scanned += MAX_AUDIT_PAGE
  ) {
    const page = await readAuditStream(storage, "access", {
      before,
      limit: MAX_AUDIT_PAGE,
    });
    const entry = page.entries.find(
      (value) =>
        value.action === "workspace.flag" && value.target === "installConnect",
    );
    if (entry) {
      const at = Date.parse(entry.at);
      const after = entry.after as Record<string, unknown> | undefined;
      if (
        entry.actor !== actor ||
        entry.authenticatedAt !== flag.authenticatedAt ||
        !Number.isFinite(at) ||
        at < createdAt ||
        at > now ||
        authenticatedAt > at ||
        !after ||
        ["key", "on", "operator", "until", "reason", "authenticatedAt"].some(
          (key) => after[key] !== flag[key as keyof WorkspaceFlag],
        )
      )
        return refuse();
      return {
        trialOperator: marker as `0x${string}`,
        createdAt: native.room.createdAt,
        until: flag.until,
        manager: native.room.manager,
      };
    }
    if (page.nextBefore === null) break;
    before = Number(page.nextBefore);
  }
  return refuse();
}

/** The private room transaction checks the anchor and its current audited flag. */
export async function connectTrialContext(
  env: Pick<Env, "ROOMS">,
  workspace: string,
  session: ServiceSession,
): Promise<ConnectTrialContext> {
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${workspace}`),
  ).fetch(
    new Request(`https://internal${WORKSPACE_FLAGS_ROOM_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "connect-trial",
        principalId: session.principalId,
        servicePrincipals: sessionPrincipals(session),
      }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const result = await response.json<{
    trialOperator?: unknown;
    createdAt?: unknown;
    until?: unknown;
    manager?: unknown;
    error?: string;
  }>();
  if (!response.ok)
    throw new HttpError(
      response.status,
      result.error ?? "The workspace could not answer.",
    );
  const createdAt =
    typeof result?.createdAt === "string" ? Date.parse(result.createdAt) : NaN;
  const until =
    typeof result?.until === "string" ? Date.parse(result.until) : NaN;
  const now = Date.now();
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.trialOperator !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(result.trialOperator) ||
    Object.keys(result).sort().join(",") !==
      "createdAt,manager,trialOperator,until" ||
    typeof result.createdAt !== "string" ||
    !Number.isFinite(createdAt) ||
    createdAt > now ||
    now >= createdAt + TRIAL_HOUR ||
    new Date(createdAt).toISOString() !== result.createdAt ||
    typeof result.until !== "string" ||
    !Number.isFinite(until) ||
    until <= now ||
    until > createdAt + TRIAL_HOUR ||
    new Date(until).toISOString() !== result.until ||
    normalizeChatPrincipal(result.manager) !== result.manager ||
    !sessionPrincipals(session).includes(result.manager as ChatPrincipalId) ||
    !sessionPrincipals(session).includes(
      result.trialOperator as ChatPrincipalId,
    )
  )
    throw new HttpError(503, "Workspace metadata is unavailable.");
  return result as ConnectTrialContext;
}

/** Ordinary creation copies only the validated trial marker. */
export async function connectTrialOperator(
  env: Pick<Env, "ROOMS">,
  workspace: string,
  session: ServiceSession,
): Promise<`0x${string}`> {
  return (await connectTrialContext(env, workspace, session)).trialOperator;
}

export async function roomWorkspaceFlagsRequest(
  storage: Storage,
  env: FlagEnv,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<Response> {
  if (body.op === "demo-revoke") {
    requireWalletAuth(
      {
        authenticatedAt: Number(body.authenticatedAt),
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    const operator = normalizeChatPrincipal(body.operator);
    if (
      !operator ||
      !isOperatorAdmin(
        env,
        operator,
        (body.servicePrincipals as string[]) ?? [operator],
      ) ||
      typeof body.scopeId !== "string" ||
      typeof body.reason !== "string" ||
      body.reason.trim().length < 3 ||
      body.reason.length > 280
    )
      throw new HttpError(404, "Not found.");
    const native = await storage.get<NativeRoomRecord>("native-room");
    if (!native) throw new HttpError(404, "Workspace not found.");
    const scope = (await configuredDemoFlagScopes(env)).find(
      (row) => row.id === body.scopeId,
    );
    if (
      !scope ||
      ![scope.demoWorkspace, ...scope.fixtures.map((row) => row.id)].includes(
        native.room.id,
      )
    )
      throw new HttpError(404, "Not found.");
    const revoked =
      (await storage.get<Record<string, unknown>>(DEMO_FLAG_REVOCATIONS_KEY)) ??
      {};
    if (revoked[scope.id] !== undefined)
      throw new HttpError(409, "The Demo scope was revoked.");
    const entry = {
      actor: operator,
      authenticatedAt: new Date(Number(body.authenticatedAt)).toISOString(),
      at: new Date(now).toISOString(),
      reason: body.reason.trim(),
      planSha256: scope.planSha256,
    };
    revoked[scope.id] = entry;
    await storage.put(DEMO_FLAG_REVOCATIONS_KEY, revoked);
    await appendAuditToStream(
      storage,
      "access",
      {
        actor: operator,
        authenticatedAt: entry.authenticatedAt,
        action: "workspace.flag",
        target: `demo-scope:${scope.id}`,
        after: { ...entry, revoked: true },
      },
      now,
    );
    await queueIndex(storage, native.room.id, now);
    await wakeRoomAt(storage, now + 1000);
    return json({ revoked: true });
  }
  if (body.op === "connect-trial")
    return json(await connectTrialMarker(storage, env, body, now));
  if (body.op === "set")
    return json({ flags: await setWorkspaceFlag(storage, env, body, now) });
  if (body.op === "revoke-scope") {
    if (env.APP_ORIGIN !== "https://usetempl.com")
      throw new HttpError(404, "Not found.");
    const operator = normalizeChatPrincipal(body.operator);
    if (
      !operator ||
      !isOperatorAdmin(env, operator, body.servicePrincipals ?? [operator])
    )
      throw new HttpError(404, "Not found.");
    requireWalletAuth(
      {
        authenticatedAt: Number(body.authenticatedAt),
        authMethod: body.authMethod as AuthMethod,
      },
      true,
      now,
    );
    const native = await storage.get<NativeRoomRecord>("native-room");
    if (!native || (await storage.get("workspace-deletion-v1")) !== undefined)
      throw new HttpError(404, "Not found.");
    const grant = configuredScopedFlagGrants(env).find(
      (row) => row.workspace === native.room.id && row.id === body.scopeGrantId,
    );
    if (
      !grant ||
      typeof body.reason !== "string" ||
      body.reason.trim().length < 3 ||
      body.reason.length > 280
    )
      throw new HttpError(
        400,
        "Choose a scope and a reason of 3 to 280 characters.",
      );
    const revoked =
      (await storage.get<Record<string, unknown>>(
        SCOPED_FLAG_REVOCATIONS_KEY,
      )) ?? {};
    if (revoked[grant.id] !== undefined)
      throw new HttpError(409, "The scope is already revoked.");
    revoked[grant.id] = {
      operator,
      authenticatedAt: new Date(Number(body.authenticatedAt)).toISOString(),
      at: new Date(now).toISOString(),
      reason: body.reason.trim(),
    };
    await storage.put(SCOPED_FLAG_REVOCATIONS_KEY, revoked);
    await appendAuditToStream(
      storage,
      "access",
      {
        actor: operator,
        authenticatedAt: new Date(Number(body.authenticatedAt)).toISOString(),
        action: "workspace.flag",
        target: grant.id,
        after: { op: "revoke-scope", reason: body.reason.trim() },
      },
      now,
    );
    await queueIndex(storage, native.room.id, now);
    await wakeRoomAt(storage, now + 1_000);
    return json({ flags: await activeWorkspaceFlags(storage, now, env) });
  }
  if (body.op === "read-scoped") {
    const native = await storage.get<NativeRoomRecord>("native-room");
    if (
      !native ||
      (await storage.get("workspace-deletion-v1")) !== undefined ||
      typeof body.operator !== "string" ||
      typeof body.scopeGrantId !== "string"
    )
      throw new HttpError(404, "Not found.");
    await requireScopedFlagGrant(
      storage,
      env,
      {
        workspace: native.room.id,
        operator: body.operator,
        id: body.scopeGrantId,
        manager: native.room.manager,
      },
      now,
    );
    return json({ flags: await activeWorkspaceFlags(storage, now, env) });
  }
  if (body.op === "read-manual-trial") {
    await assertManualBillingTrialWorkspace(storage, env, body.operator, now);
    return json({ flags: await activeWorkspaceFlags(storage, now, env) });
  }
  if (body.op === "read") {
    if (!(await storage.get("native-room")))
      throw new HttpError(404, "Workspace not found.");
    return json({
      flags: await activeWorkspaceFlags(storage, now, env),
      indexPending: (await storage.get(INDEX_OUTBOX)) !== undefined,
    });
  }
  throw new HttpError(404, "Not found.");
}
export async function managerWorkspaceFlags(
  storage: Reader,
  isManager: boolean,
  env?: WorkspaceFlagEnv,
): Promise<Response> {
  if (!isManager)
    throw new HttpError(403, "Only the manager can see early features.");
  return json({ flags: await activeWorkspaceFlags(storage, Date.now(), env) });
}
export async function roomFlags(
  env: Pick<Env, "ROOMS">,
  workspace: string,
  body: Record<string, unknown>,
): Promise<{ flags: WorkspaceFlag[]; indexPending?: boolean }> {
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${workspace}`),
  ).fetch(
    new Request(`https://internal${WORKSPACE_FLAGS_ROOM_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const result = (await response.json()) as {
    flags: WorkspaceFlag[];
    indexPending?: boolean;
    error?: string;
  };
  if (!response.ok)
    throw new HttpError(
      response.status,
      result.error ?? "The workspace could not answer.",
    );
  return result;
}
export async function operatorFlagsRoute<
  S extends ServiceSession & {
    authenticatedAt?: number;
    authMethod?: AuthMethod;
  },
>(
  request: Request,
  env: FlagEnv & Pick<Env, "ROOMS">,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  const revoke = url.pathname === "/operator/flag-scopes/revoke";
  const revokingDemo = url.pathname === "/operator/demo-flag-scopes/revoke";
  if (url.pathname !== "/operator/flags" && !revoke && !revokingDemo)
    return null;
  if (revoke && env.APP_ORIGIN !== "https://usetempl.com")
    throw new HttpError(404, "Not found.");
  const session = await auth.session();
  const principals = sessionPrincipals(session);
  const trial = isTrialOperatorAdmin(env, session.principalId, principals);
  const full = isOperatorAdmin(env, session.principalId, principals);
  const scoped = isScopedFlagOperator(env, session.principalId);
  const demoOperator = await isDemoFlagOperator(env, session.principalId);
  if (revokingDemo && (!full || request.method !== "POST"))
    throw new HttpError(404, "Not found.");
  if ((!trial && !full && !scoped && !demoOperator) || (revoke && !full))
    throw new HttpError(404, "Not found.");
  const manualTrialRead =
    request.method === "GET" &&
    !revoke &&
    !revokingDemo &&
    [...url.searchParams.keys()].join() === "workspace" &&
    approvedManualBillingTrial(
      env,
      session.principalId,
      url.searchParams.get("workspace"),
    );
  if (
    ((trial && !scoped && !manualTrialRead) ||
      (!full && !scoped && demoOperator)) &&
    request.method !== "POST"
  )
    throw new HttpError(404, "Not found.");
  try {
    requireWalletAuth(session, true);
  } catch (error) {
    if (error instanceof HttpError && error.reason === "strong-auth-required")
      throw new HttpError(401, "Sign in with your wallet again.");
    throw error;
  }
  if (manualTrialRead) {
    const workspace = url.searchParams.get("workspace")!;
    const row = await roomFlags(env, workspace, {
      op: "read-manual-trial",
      operator: session.principalId,
    });
    return json({ workspaces: [{ workspace, flags: row.flags }], next: null });
  }
  if (request.method === "GET" && !revoke && !revokingDemo) {
    if (!full) {
      const workspace = url.searchParams.get("workspace");
      if (
        !workspace ||
        !NATIVE_UUID.test(workspace) ||
        [...url.searchParams.keys()].join() !== "workspace"
      )
        throw new HttpError(404, "Not found.");
      const grant = scopedFlagGrant(env, {
        workspace,
        operator: session.principalId,
      });
      if (!grant) throw new HttpError(404, "Not found.");
      const row = await roomFlags(env, workspace, {
        op: "read-scoped",
        operator: session.principalId,
        scopeGrantId: grant.id,
      });
      return json({
        workspaces: [{ workspace, flags: row.flags }],
        next: null,
        scopeGrantId: grant.id,
      });
    }
    const after = url.searchParams.get("after");
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(WORKSPACE_FLAGS_INDEX_OBJECT),
    ).fetch(
      new Request(
        `https://internal${WORKSPACE_FLAGS_INDEX_PATH}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      ),
    );
    if (!response.ok)
      throw new HttpError(503, "The workspace list could not be read.");
    const page = (await response.json()) as {
      workspaces: string[];
      next: string | null;
    };
    const workspaces: WorkspaceFlagRow[] = [];
    let indexPending = false;
    for (const workspace of page.workspaces) {
      try {
        const row = await roomFlags(env, workspace, { op: "read" });
        indexPending ||= row.indexPending === true;
        if (row.flags.length) workspaces.push({ workspace, flags: row.flags });
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
    }
    return json({
      workspaces,
      next: page.next,
      ...(indexPending ? { indexPending: true } : {}),
    });
  }
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !body ||
    typeof body.workspace !== "string" ||
    !NATIVE_UUID.test(body.workspace)
  )
    throw new HttpError(400, "Choose a workspace.");
  if (
    body.expectedPrincipalId !== undefined &&
    body.expectedPrincipalId !== session.principalId
  )
    throw new HttpError(409, "The operator account changed. Sign in again.");
  const demo = body.demoScopeId !== undefined || body.planSha256 !== undefined;
  const scopedWrite = body.scopeGrantId !== undefined;
  if (demo && scopedWrite) throw new HttpError(404, "Not found.");
  if (!revoke && !revokingDemo && !full && !trial) {
    if (demo) {
      if (
        !demoOperator ||
        body.demoScopeId === undefined ||
        body.planSha256 === undefined
      )
        throw new HttpError(404, "Not found.");
    } else if (!scopedWrite || !scoped) throw new HttpError(404, "Not found.");
  }
  if (
    !revoke &&
    !revokingDemo &&
    body.scopeGrantId !== undefined &&
    (typeof body.scopeGrantId !== "string" ||
      !scopedFlagGrant(env, {
        workspace: body.workspace,
        operator: session.principalId,
        id: body.scopeGrantId,
      }))
  )
    throw new HttpError(404, "Not found.");
  const operation = {
    ...body,
    operator: session.principalId,
    servicePrincipals: principals,
    authenticatedAt: session.authenticatedAt,
    authMethod: session.authMethod,
    op: revokingDemo ? "demo-revoke" : revoke ? "revoke-scope" : "set",
  };
  if (!revoke && !revokingDemo) flagInput(operation, Date.now());
  return json(await roomFlags(env, body.workspace, operation));
}
/** Commit paths call this after the room transaction succeeds. */
export async function scheduleWorkspaceFlags(
  storage: DurableObjectStorage,
  env: IndexEnv,
): Promise<void> {
  const flags = await activeWorkspaceFlags(storage);
  const due = flags.length
    ? Math.min(...flags.map((flag) => Date.parse(flag.until)))
    : null;
  if (due !== null) await wakeRoomAt(storage, due);
  if (!(await flushWorkspaceFlagsIndex(storage, env)))
    await wakeRoomAt(storage, Date.now() + 60_000);
}
