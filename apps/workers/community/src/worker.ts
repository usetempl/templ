export { WorkspaceCostWriter, WorkspaceCostWriterOwn, WorkspaceCostWriterFlex, WorkspaceCostWriterColosseum } from "./workspace-cost-writer";
export { OwnEncryptionCheckpoint } from "./own-encryption-checkpoint";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import {
  connectTrialOperator,
  featureOn,
  workspaceFeatureEnvFromValues,
} from "./workspace-flags";
import { workspaceFeatureSnapshot } from "./workspace-feature-values";
import {
  connectCode,
  connectUrl,
  connectLimit,
  connectRequest,
  pollConnect,
  requireConnectEnabled,
  startConnect,
} from "./connect";
import type { ConnectLimitDecision } from "./connect";
import {
  connectTrialCaptureRoute,
  observeConnectTrialStart,
} from "./connect-trial-capture";
import {
  CONNECT_DEADLINE,
  requireConnectDeadline,
  type ConnectDeadlineEnv,
} from "./connect-deadline";
import { uuidv7 } from "./uuidv7";
import { supportEntryRoute } from "./hosted-support";
import { corpusOperatorRoute } from "./corpus-operator";
import {
  sessionLevel,
  supportWidgetRoute,
  widgetConfig,
  widgetMinimumLevel,
  widgetOrigins,
  matchesWidgetScope,
  WIDGET_SCOPE,
  type WidgetEnv,
} from "./support-widget";
import {
  requireWalletAuth,
  requireWorkspaceAdminAuth,
  requireTeamInvitationAuth,
  AUTHENTICATED_AT_HEADER,
  AUTH_METHOD_HEADER,
} from "./privileged-auth";
import { readSupportUpload, isSupportUpload } from "./support-workflow";
import { domainVerifyRoute } from "./domain-verify";
import { passThrough } from "./turnstile";
import {
  namesWidgetSessionSetting,
  loopbackOffered,
  widgetSessionSettings,
  withWidgetSessionOptions,
  type WidgetSessionEnv,
} from "./widget-session-config";
import {
  withMessageBudget,
  MESSAGE_BUDGET_AVAILABLE_HEADER,
} from "./message-budget";
import { classifyRpcFailure, reportRpcFailure } from "./rpc-diagnostics";
import { CHAT_CHAIN_IDS, chatNetworkAvailability } from "@templ/chat/chains";
import { walletAuthChain } from "./chain-config";
import { sessionCacheKey } from "./session-key";
import {
  createRpcBudget,
  rpcCapacityError,
  RPC_BUDGET,
  type RpcBudgetEnv,
} from "./rpc-budget";
import {
  NATIVE_CATALOG,
  NATIVE_UUID,
  nativeRoomId,
  hostedName,
  nativeSlug,
  nativeCreation,
  requireTrialWorkspaceCreation,
  publicNativeRoom,
  type NativeCreation,
  type NativeRoomRecord,
} from "./native-rooms";
import { nativeRecord, nativeRoomStub } from "./native-rooms";
import type { ChatState } from "@templ/chat/index";
import {
  workspaceIdentitiesVisible,
  workspaceMetadataView,
  workspaceStateView,
} from "./workspace-public-view";
import { createSiweMessage } from "viem/siwe";
import {
  createSolanaSignInMessage,
  decodeSolanaSignature,
  isSolanaAddress,
  solanaAddress,
  verifySolanaSignature,
} from "./solana";
import {
  decodeWidgetSolanaSignature,
  formatCaip10,
  readStoredWidgetWallet,
  type WidgetWallet,
} from "@templ/chat/widget-wallet";
import { isHex, type Address, type Hex } from "viem";
import type { SupportSiweChainId } from "@templ/chat/chains";
import {
  isOperatorAdmin,
  isTrialOperatorAdmin,
  type OperatorAdminEnv,
} from "./operator-admin";
import { verifyWallet, verifySessionAuthority, verifiedChain } from "./chain";
import { releaseIdentity } from "./release-identity";
import {
  releaseActivationEnv,
  releaseActivationRoute,
} from "./release-activation";
import {
  RELEASE_ACTIVATION_PATH,
  RELEASE_AVAILABILITY_PATH,
} from "@templ/chat/release-activation";
import { publicEmailSignInEnv } from "./email-sign-in-release";
import { operatorCostsRoute } from "./cost-metrics";
import {
  createIncidentsMemo,
  operatorIncidentsRoute,
  statusIncidentsRoute,
  type IncidentsEnv,
} from "./support-incidents";
import {
  refuseClosedWorkspace,
  workspaceDeletionRoute,
} from "./workspace-deletion";
import { handleRecoveryRoute, type RecoveryEnv } from "./storage-recovery";
import type { FunnelEnv } from "./funnel-metrics";
import {
  browserOnboardingRoute,
  operatorOnboardingRoute,
  onboardingTraffic,
  onboardingOptOut,
} from "./onboarding-metrics";
import {
  ONBOARDING_HEADER,
  JOURNEY_ID,
  browserOnboardingEvent,
} from "@templ/chat/onboarding";
import {
  admitFunnelRequest,
  finishFunnelObservation,
  operatorFunnelRoute,
  siteFunnelRoute,
  withFunnelObservation,
} from "./funnel-routes";
import {
  drainDeferred,
  defer,
  PRINCIPAL_HINT_HEADER,
  principalHint,
  requestPrefetch,
  started,
  timed,
  withRequestContext,
  withServerTiming,
} from "./request-context";
import {
  withCostObservation,
  finishCostObservation,
  type CostMetricsEnv,
} from "./cost-observability";
export { CostMetrics } from "./cost-metrics";
import {
  createHealthMemo,
  inspectChainHealth,
  operatorHealthRoute,
  supportHealthRoute,
  type OpsHealthEnv,
} from "./ops-health";
import { runSupportCanary } from "./ops-canary";
// Install preview authority is carried inside the worker.
// Public request headers never set this mark.
import { readSupportJson } from "./support-body";
import { installFixtureWorkspace } from "@templ/chat/support-install-fixture";
import {
  INSTALL_PREVIEW,
  requireInstallCheck,
  widgetInstallCheck,
  prepareInstallFixture,
} from "./support-install-check";
import { finishSupportFailureObservation } from "./support-failures";
import { operatorInventoryRoute } from "./operator-inventory";
import { operatorGrantsRoute } from "./operator-grants";
import { operatorFlagsRoute } from "./workspace-flags";
// The operator billing view and its audited actions (operator-billing.ts),
// wired beside the grants route.
import { stripeWebhookRoute } from "./stripe-store";
import { operatorBillingRoute } from "./operator-billing";
import { storageOperatorRoute } from "./brain-storage-operator";
import { operatorOrderFormsRoute } from "./operator-order-forms";
import {
  checkedWidgetRefusalDays,
  mergeOriginRefusals,
  refusalWindowDays,
  type WidgetRefusalDay,
} from "./support-refusals";
import type { SupportRefusals } from "@templ/chat/support";
import {
  conversationWorkerRoute,
  type ConversationEnv,
} from "./team-conversations";
import {
  getMedia,
  mediaOwnedBy,
  releaseMediaReference,
  restoreMediaReference,
  setMediaReference,
  uploadMedia,
} from "./media";
import { profileMediaHash } from "@templ/chat/profiles";
import { isSupportContactRole } from "./support-contact-profiles";
import {
  address,
  config,
  cookie,
  errorBody,
  HttpError,
  HEALTH_CHAIN_ID,
  json,
  NONCE_COOKIE,
  NONCE_TTL,
  randomToken,
  readCookie,
  readJson,
  record,
  SESSION_COOKIE,
  SESSION_TTL,
  SESSION_RENEW_AFTER,
  siteOrigins,
  SMART_WALLET_AUTH_CHAIN_ID,
  type Env,
} from "./common";
import {
  safetyAvailable,
  safetyAdmin,
  safetyIsAdmin,
  safetyRequest,
  safetyDigest,
  requireSafetyAccess,
  prefetchSafety,
  safetyPrefetched,
  attachMessageHold,
  type SafetyEnv,
} from "./safety";
export { SafetyStore } from "./safety";
import type { AuthData } from "./auth-record";
import { principal } from "./principal";
import {
  servicePrincipalHeaders,
  principalsFromHeaders,
  sessionPrincipals,
} from "./service-principals";
import { linkedSubscriptions } from "./linked-subscriptions";
import {
  identityRequest,
  pendingEmailInvitationRequest,
  type AccountIdentity,
} from "./account-identity";
import { TEAM_INVITE_EMAIL_KEY_HEADER } from "./team-invites";
import { memberProfileRoute } from "./member-profiles";
import { clientIpDigest, realtimeRoute } from "./realtime";
import {
  enforceSessionMethod,
  linkedWalletsRoute,
  measuredSessionIdentity,
  prefetchSessionIdentity,
  provenWalletFacts,
  sessionIdentity,
} from "./linked-wallets";
import { accountMethodsView } from "./account-methods";
import type { ProvenWallet } from "@templ/chat/wallets";
import { servicePrincipals } from "./service-principals";
import {
  feedbackAvailable,
  feedbackIsAdmin,
  feedbackRequest,
  type FeedbackEnv,
} from "./feedback";
export { FeedbackStore } from "./feedback-store";
import {
  isAuthMethod,
  normalizeChatPrincipal,
  normalizeServicePrincipals,
  type AuthMethod,
  type ChatPrincipalId,
  type ChatSession,
} from "@templ/chat/principal";
import {
  emailAlertsAvailable,
  emailChallengeCookieClear,
  emailRemoveRoute,
  maskEmail,
  startEmailLink,
  verifyEmailLink,
} from "./email-alerts";
import {
  keyed,
  normalizeEmail,
  resendConfig,
  type EmailEnv,
} from "./email-delivery";
import {
  emailSignInAvailable,
  emailSignInChallengeCookieClear,
  startEmailSignIn,
  verifyEmailSignIn,
} from "./email-alerts";
import { solanaBotRoute } from "./bot-register-solana";
import { memberAlertRoute, memberUnsubscribeRoute } from "./member-alerts"; // alerts-notify
// Current Durable Object exports.
export { AuthRecord } from "./auth-record";
export { CommunityRoom } from "./room";
export { SupportPartition } from "./support-partition";
export { SupportKnowledge } from "./support-knowledge";
export { MediaQuota } from "./media";
export { SubscriptionList } from "./subscriptions";
export { ProductPaymentLedger } from "./product-payment-ledger";
export { ProductPaymentScanner } from "./product-payment-scanner";

type Dependencies = {
  verifySessionAuthority?: typeof verifySessionAuthority;
  verifyWallet: typeof verifyWallet;
  verifiedChain: typeof verifiedChain;
};
const internalPost = (path: string, body?: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const NATIVE_CONTEXT = Symbol("native-room-context");
/** Followed rooms read together per step. */
const SUBSCRIPTION_READS = 30;
/** Room routes that go through the shared session, access and budget
 * pipeline, unless `unsupportedRoomRoute` names them. */
const ORDINARY_ROUTE =
  /^\/(?:workspace-flags|priority-trial-capture|channels|roles|moderation|mutes|bans|product|appearance|report|audit|bots|search|events|realtime|conversations)(?:\/[^?#]*)?$/;
/** These routes under current prefixes answer like any unknown route,
 * before sign-in. Only the workspace state read uses the /channels path; no
 * channel, message, pin or file route exists, and neither do role purchases,
 * bot commands. */
const unsupportedRoomRoute = (path: string, method: string) =>
  (path.startsWith("/channels") &&
    !(path === "/channels" && method === "GET")) ||
  path === "/setup" ||
  path === "/bots/self/commands" ||
  path === "/product/card/checkout" ||
  /^\/roles\/[^/]+\/(?:quote|receipt)$/.test(path);
type NativeEnv = RpcBudgetEnv & {
  [NATIVE_CONTEXT]?: { record: NativeRoomRecord; room: DurableObjectStub };
};
const nativeStub = nativeRoomStub;
const nativeCatalog = (env: Env, body: Record<string, unknown>) =>
  env.ROOMS.get(env.ROOMS.idFromName(NATIVE_CATALOG)).fetch(
    internalPost("/private/native-catalog", body),
  );
async function indexNative(env: Env, record: NativeRoomRecord) {
  const response = await nativeCatalog(env, {
    op: "index",
    id: record.room.id,
    room: record.room,
    revision: record.revision,
  });
  if (!response.ok)
    throw new HttpError(
      503,
      "Chat listing is temporarily unavailable. Retry the same request.",
    );
}
const safetyRoomKey = (env: Env) => {
  const native = (env as NativeEnv)[NATIVE_CONTEXT]?.record.room;
  if (!native) throw new HttpError(503, "Chat identity is unavailable.");
  return `room:${native.id}`;
};
async function submitSafetyReport(
  request: Request,
  env: Env,
  session: Session | null,
  body: Record<string, unknown>,
  target?: {
    roomKey: string;
    targetUrl: string;
    message?: unknown;
    messageRef?: { id: string; channelId: string };
  },
  operation: "report" | "report-receipt" = "report",
) {
  const operatorEnv = env as SafetyEnv;
  return safetyRequest(operatorEnv, {
    op: operation,
    requestId: body.requestId,
    reason: body.reason,
    details: body.details,
    notice: body.notice,
    relatedReportId: body.relatedReportId,
    principalId: session?.principalId ?? null,
    servicePrincipals: sessionPrincipals(session),
    ipDigest: await safetyDigest(
      `${operatorEnv.SAFETY_ADMIN_TOKEN ?? ""}:${Math.floor(Date.now() / 86400000)}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    ),
    targetUrl: target?.targetUrl ?? body.targetUrl,
    roomKey: target?.roomKey ?? null,
    message: target?.message ?? null,
    messageRef: target?.messageRef ?? null,
  });
}
type PrivacyStatus = {
  visibility: "public" | "private";
  initialized: boolean;
  isMember: boolean;
  canRead: boolean;
};
function privacyHeaders(
  env: Env,
  session: Session | null,
  manager?: ChatPrincipalId,
) {
  const native = (env as NativeEnv)[NATIVE_CONTEXT]?.record.room;
  return new Headers({
    "Content-Type": "application/json",
    ...servicePrincipalHeaders(session),
    "X-Verified-Manager": native?.manager ?? manager ?? "",
    ...(!manager ? { "X-Authority-Fresh": "false" } : {}),
    ...(native ? { "X-Native-Room-Id": native.id } : {}),
    ...(session
      ? {
          "X-Verified-Principal": session.principalId,
          "X-Session-Expires-At": String(session.expiresAt),
          [AUTHENTICATED_AT_HEADER]: String(session.authenticatedAt ?? 0),
          [AUTH_METHOD_HEADER]: session.authMethod,
          "X-Access-Expires-At": String(session.expiresAt),
        }
      : {}),
    ...(session?.address ? { "X-Verified-Wallet": session.address } : {}),
  });
}
async function privacyCall(
  room: DurableObjectStub,
  headers: Headers,
  body: Record<string, unknown>,
) {
  return room.fetch(
    new Request("https://internal/private/privacy", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}
async function readPrivacy(room: DurableObjectStub, headers: Headers) {
  const response = await privacyCall(room, headers, { op: "status" });
  if (!response.ok)
    throw new HttpError(
      response.status === 404 ? 404 : 503,
      "Chat is temporarily unavailable.",
    );
  return response.json<PrivacyStatus>();
}
async function requirePrivateMembership(
  room: DurableObjectStub,
  headers: Headers,
) {
  const status = await readPrivacy(room, headers);
  if (!status.canRead) throw new HttpError(404, "Chat not found.");
  return status;
}

/** Read current room authority through the existing internal binding. This
 * also works while the incumbent Room code serves a zero-traffic candidate. */
async function nativeWorkspaceState(room: DurableObjectStub, headers: Headers) {
  const response = await room.fetch(
    new Request("https://internal/channels", { headers }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      [401, 403, 404].includes(response.status) ? response.status : 503,
      response.status === 404
        ? "Chat not found."
        : "Chat is temporarily unavailable.",
    );
  }
  return response.json<ChatState>();
}

async function nativeWorkspaceMetadata(
  env: Env,
  context: { room: DurableObjectStub; record: NativeRoomRecord },
  session: Session,
) {
  const headers = privacyHeaders(
    { ...env, [NATIVE_CONTEXT]: context } as NativeEnv,
    session,
    context.record.room.manager,
  );
  const state = await nativeWorkspaceState(context.room, headers);
  return workspaceMetadataView(
    context.record.room,
    state,
    sessionPrincipals(session),
  );
}
async function optionalSession(request: Request, env: Env, deps: Dependencies) {
  try {
    return await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
  } catch (error) {
    if (error instanceof HttpError && [401, 503].includes(error.status))
      return null;
    throw error;
  }
}
async function inviteRoute(
  request: Request,
  env: Env,
  deps: Dependencies,
  room: DurableObjectStub,
  path: string,
  manager?: ChatPrincipalId,
) {
  const preview = path === "/invites/preview" && request.method === "POST";
  const session = preview
    ? null
    : await currentSession(request, env, false, deps.verifySessionAuthority);
  await requireSafetyAccess(
    env as SafetyEnv,
    safetyRoomKey(env),
    session?.principalId,
    sessionPrincipals(session),
  );
  const headers = privacyHeaders(env, session, manager);
  const body = request.method === "POST" ? await readJson(request) : {};
  if (session && request.method === "POST")
    requireExpectedPrincipal(body, session);
  const op =
    path === "/invites"
      ? request.method === "GET"
        ? "invite-list"
        : "invite-create"
      : path === "/invites/preview"
        ? "invite-preview"
        : path === "/invites/accept"
          ? "invite-redeem"
          : path === "/invites/revoke"
            ? "invite-revoke"
            : null;
  if (!op || (path !== "/invites" && request.method !== "POST"))
    throw new HttpError(404, "Not found.");
  const result = await privacyCall(room, headers, {
    op,
    secret: body.secret,
    inviteId: body.inviteId,
  });
  if (result.ok && op === "invite-redeem" && session) {
    const native = (env as NativeEnv)[NATIVE_CONTEXT];
    if (native)
      followAddedWorkspace(env, native.record.room, sessionPrincipals(session));
  }
  return result;
}

async function teamInviteRoute(
  request: Request,
  env: Env,
  deps: Dependencies,
  room: DurableObjectStub,
  path: string,
  manager: ChatPrincipalId,
) {
  if (
    !featureOn(env, undefined, "teamInvites") ||
    env.SUPPORT_WORKFLOW_ENABLED !== "true"
  )
    throw new HttpError(
      503,
      "Team invitation links are not available in this workspace.",
    );
  const op =
    path === "/team-invites"
      ? request.method === "GET"
        ? "list"
        : request.method === "POST"
          ? "create"
          : null
      : request.method === "POST" &&
          [
            "/team-invites/check",
            "/team-invites/accept",
            "/team-invites/revoke",
          ].includes(path)
        ? path.split("/")[2]
        : null;
  if (!op) throw new HttpError(404, "Not found.");
  const session = await currentSession(
    request,
    env,
    false,
    deps.verifySessionAuthority,
  );
  const body = request.method === "POST" ? await readJson(request) : {};
  if (request.method === "POST") {
    requireExpectedPrincipal(body, session);
    if (op === "check" || op === "accept")
      requireTeamInvitationAuth(session, body.confirmed);
    else requireWorkspaceAdminAuth(session, sessionPrincipals(session).includes(manager), body.confirmed);
    const allowed = new Set([
      "expectedPrincipalId",
      "confirmed",
      ...(op === "create"
        ? [
            "roleId",
            "expiresInHours",
            ...(body.email !== undefined ? ["email", "requestId"] : []),
          ]
        : op === "revoke"
          ? ["inviteId"]
          : ["token"]),
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key)))
      throw new HttpError(
        400,
        "Choose only the team link settings for this action.",
      );
  }
  await requireSafetyAccess(
    env as SafetyEnv,
    safetyRoomKey(env),
    session.principalId,
    sessionPrincipals(session),
  );
  // Links cease to grant access when their current manager is suspended.
  await requireSafetyAccess(env as SafetyEnv, safetyRoomKey(env), manager, [
    manager,
  ]);
  const forwarded: Record<string, unknown> = { ...body, op };
  let emailKey: string | undefined;
  const native = (env as NativeEnv)[NATIVE_CONTEXT];
  if (op === "create" && body.email !== undefined) {
    if (!native || !emailSignInAvailable(await publicEmailSignInEnv(env)))
      throw new HttpError(503, "Email sign-in is unavailable right now.");
    const email = normalizeEmail(body.email);
    emailKey = await keyed(
      resendConfig(env as EmailEnv).secret,
      `email:${email}`,
    );
    delete forwarded.email;
    forwarded.emailKey = emailKey;
    forwarded.recipient = maskEmail(email);
  }
  const result = await room.fetch(
    new Request("https://internal/team-invites", {
      method: "POST",
      headers: privacyHeaders(env, session, manager),
      body: JSON.stringify(forwarded),
    }),
  );
  if (result.ok && emailKey && native) {
    const { invitation } = await result.clone().json<{
      invitation: { id: string; expiresAt: number };
    }>();
    await pendingEmailInvitationRequest(env, {
      op: "team-email-register",
      emailKey,
      invitation: {
        workspace: native.record.room.id,
        inviteId: invitation.id,
        expiresAt: invitation.expiresAt,
      },
    });
  }
  if (result.ok && op === "revoke" && native)
    await pendingEmailInvitationRequest(env, {
      op: "team-email-remove",
      workspace: native.record.room.id,
      inviteId: body.inviteId,
    });
  if (result.ok && op === "accept") {
    const native = (env as NativeEnv)[NATIVE_CONTEXT];
    if (native)
      followAddedWorkspace(env, native.record.room, sessionPrincipals(session));
  }
  return result;
}

/** Following lists a workspace; current room checks still decide access. */
async function addFollowedWorkspace(
  env: Env,
  room: NativeRoomRecord["room"],
  principals: ChatPrincipalId[],
  signal?: AbortSignal,
) {
  if (!env.ROOM_SUBSCRIPTIONS || !principals.length) return false;
  const list = linkedSubscriptions(env, {
    principalId: principals[0],
    servicePrincipals: principals,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const request = internalPost("/subscriptions", {
        roomId: room.id,
        room,
        subscribed: true,
        automatic: true,
      });
      const result = await list.fetch(
        signal ? new Request(request, { signal }) : request,
      );
      if (result.ok || result.status < 500) return result.ok;
    } catch {
      /* An idempotent follow can retry without changing access. */
    }
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, attempt ? 1000 : 250));
  }
  return false;
}
function followAddedWorkspace(
  env: Env,
  room: NativeRoomRecord["room"],
  principals: ChatPrincipalId[],
) {
  defer(env, async () => {
    await addFollowedWorkspace(env, room, principals);
  });
}

/** Current Room authority controls delegated workspace configuration. */
async function nativeWorkspaceAdmin(
  env: Env,
  context: Awaited<ReturnType<typeof nativeRecord>>,
  session: Session,
): Promise<boolean> {
  if (sessionPrincipals(session).includes(context.record.room.manager)) return true;
  const scoped = context.features
    ? workspaceFeatureEnvFromValues(env, context.features, context.record.room.id) : env;
  const result = await context.room.fetch(new Request("https://internal/channels", {
    headers: privacyHeaders({ ...scoped, [NATIVE_CONTEXT]: context } as NativeEnv, session, context.record.room.manager),
  }));
  if (!result.ok) { await result.body?.cancel(); return false; }
  const state = await result.json<{ viewer: { isManager: boolean; permissions: string[] } }>();
  return canManageWorkspace(state.viewer);
}

async function redeemPendingEmailInvitations(
  env: Env,
  session: Session,
  emailKey?: string,
) {
  if (
    session.authMethod !== "email" ||
    !session.principalId.startsWith("account:")
  )
    return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const within = <T>(work: Promise<T>) => Promise.race([work, deadline]);
  try {
    requireTeamInvitationAuth(session, true);
    if (!emailSignInAvailable(await within(publicEmailSignInEnv(env)))) return;
    env = await within(releaseActivationEnv(env));
    if (!emailKey) {
      const account = await within(
        identityRequest(env, {
          op: "read",
          principalId: session.principalId,
        }),
      );
      emailKey = account.emailLogin?.emailKey;
    }
    if (!emailKey) return;
    const { invitations = [] } = await within(
      pendingEmailInvitationRequest(
        env,
        {
          op: "team-email-pending",
          principalId: session.principalId,
          emailKey,
        },
        controller.signal,
      ),
    );
    for (const invitation of invitations) {
      try {
        controller.signal.throwIfAborted();
        const context = await within(
          nativeRecord(env, nativeRoomId(invitation.workspace)),
        );
        const scopedEnv = context.features
          ? workspaceFeatureEnvFromValues(
              env,
              context.features,
              context.record.room.id,
            )
          : env;
        const scopedNative = {
          ...scopedEnv,
          [NATIVE_CONTEXT]: context,
        } as NativeEnv;
        refuseClosedWorkspace(
          context.record,
          "/team-invites/accept",
          scopedNative as never,
        );
        if (
          !featureOn(scopedNative, undefined, "teamInvites") ||
          scopedNative.SUPPORT_WORKFLOW_ENABLED !== "true"
        )
          continue;
        await within(
          requireSafetyAccess(
            scopedNative as SafetyEnv,
            `room:${invitation.workspace}`,
            session.principalId,
            sessionPrincipals(session),
          ),
        );
        const manager = context.record.room.manager;
        await within(
          requireSafetyAccess(
            scopedNative as SafetyEnv,
            `room:${invitation.workspace}`,
            manager,
            [manager],
          ),
        );
        await scopeNativeBudget(env, context);
        const headers = privacyHeaders(scopedNative, session, manager);
        headers.set(TEAM_INVITE_EMAIL_KEY_HEADER, emailKey);
        const result = await within(
          context.room.fetch(
            new Request("https://internal/team-invites", {
              method: "POST",
              headers,
              body: JSON.stringify({
                op: "accept-email",
                inviteId: invitation.inviteId,
                confirmed: true,
              }),
              signal: controller.signal,
            }),
          ),
        );
        const finished = result.ok
          ? await within(
              addFollowedWorkspace(
                env,
                context.record.room,
                sessionPrincipals(session),
                controller.signal,
              ),
            )
          : result.status === 404 || result.status === 410;
        await result.body?.cancel();
        if (finished)
          await within(
            pendingEmailInvitationRequest(
              env,
              {
                op: "team-email-remove",
                workspace: invitation.workspace,
                inviteId: invitation.inviteId,
              },
              controller.signal,
            ),
          );
      } catch {
        /* A pending locator can retry. It never grants access itself. */
      }
    }
  } catch {
    /* Keep the verified session when an invitation or its index needs a retry. */
  } finally {
    clearTimeout(timer);
  }
}

async function targetIdentityHeaders(
  env: Env,
  headers: Headers,
  path: string,
  body: Record<string, unknown> | undefined,
  url: URL,
) {
  const target =
    body &&
    (/^\/(mutes|bans|bots)$/.test(path) ||
      /^\/roles\/[^/]+\/assign$/.test(path))
      ? body.principalId
      : /^\/roles\/[^/]+\/grant$/.test(path)
        ? url.searchParams.get("principalId")
        : null;
  if (target === null || target === undefined) return;
  const identity = await identityRequest(env, {
    op: "read",
    principalId: principal(target),
  });
  headers.set(
    "X-Target-Service-Principals",
    JSON.stringify(sessionPrincipals(identity)),
  );
}

/** A Solana wallet a manager names to give a teammate a role. Only a grant
 * (`granted: true`) is resolved; removals and reads use the account ID. */
function solanaGrantee(
  path: string,
  method: string,
  body: Record<string, unknown> | undefined,
) {
  return method === "POST" &&
    body &&
    /^\/roles\/[^/]+\/assign$/.test(path) &&
    body.granted === true &&
    !normalizeChatPrincipal(body.principalId) &&
    isSolanaAddress(body.principalId)
    ? body.principalId
    : null;
}
/** One answer for a Solana wallet no account proved, however it came to be
 * unknown. */
const SOLANA_GRANTEE_UNKNOWN =
  "No Templ account has signed in with this Solana wallet. Ask them to sign in to Templ with it first, or use their account ID.";
/** A Solana wallet is looked up only for a grant the workspace would make,
 * so the grant can't serve as a search from wallet to account. The manager
 * confirmed a privileged change after a valid signed-in session, the room has
 * checked that they may assign roles and that the role exists, and each
 * manager account has its own lookup limit beside the per-IP one. A wallet
 * that is found always ends in a real role grant, which the room logs.
 * Returns the room's refusal, if it gave one. */
async function authorizeSolanaGrant(
  env: Env,
  room: { fetch(request: Request): Promise<Response> },
  headers: Headers,
  path: string,
  session: Session,
  confirmed: unknown,
): Promise<Response | null> {
  requireWorkspaceAdminAuth(session, sessionPrincipals(session).includes(headers.get("X-Verified-Manager") as ChatPrincipalId), confirmed);
  // The room's own grant read, about the manager, runs its assignRoles and
  // role checks.
  const own = new Headers(headers);
  own.set(
    "X-Target-Service-Principals",
    JSON.stringify(sessionPrincipals(session)),
  );
  const check = await room.fetch(
    new Request(
      `https://internal${path.replace(/\/assign$/, "/grant")}?principalId=${encodeURIComponent(session.principalId)}`,
      { headers: own },
    ),
  );
  if (!check.ok) return check;
  await check.body?.cancel().catch(() => undefined);
  if (
    !env.AUTH_RATE_LIMITER ||
    !(
      await env.AUTH_RATE_LIMITER.limit({
        key: `solana-grant:${session.principalId}`,
      })
    ).success
  )
    throw new HttpError(429, "Too many requests. Please try again shortly.");
  return null;
}
/** The account a proven Solana wallet signs in to, looked up inside the
 * manager's grant through the `identity-solana:` index. Lookup only: the
 * wallet never becomes an alias, and two accounts are never merged. */
async function solanaGranteeAccount(env: Env, wallet: string) {
  const found = (await identityRequest(env, {
    op: "solana-owner",
    address: wallet,
  })) as unknown as { principalId?: unknown };
  const account = normalizeChatPrincipal(found.principalId);
  if (!account || !account.startsWith("account:"))
    throw new HttpError(
      404,
      SOLANA_GRANTEE_UNKNOWN,
      undefined,
      "unknown-solana-wallet",
    );
  return account;
}
/** The wallet a signed widget session proved, for the room: an EVM wallet on
 * the chain its SIWE text names, or the Solana wallet it signed in with. A
 * guest has none. */
function widgetWallet(session: Session): WidgetWallet | null {
  if (session.authMethod === "wallet" && session.walletIdentity)
    return {
      network: "evm",
      address: session.walletIdentity.address.toLowerCase() as `0x${string}`,
      chainId: session.walletIdentity.chainId,
    };
  if (session.authMethod === "solana" && isSolanaAddress(session.solanaAddress))
    return { network: "solana", address: session.solanaAddress };
  return null;
}

async function reportRoomRequest(
  request: Request,
  env: Env,
  room: DurableObjectStub,
  headers: Headers,
  path: string,
  body: Record<string, unknown> | undefined,
  session: Session | null,
  targetUrl: string,
) {
  if (request.method !== "POST" || !body || !session) return null;
  // A conversation message the reporter can read, captured from the stored row.
  const reference =
    /^\/conversations\/(tc-[0-9a-f]{32})\/messages\/([1-9][0-9]{0,14})\/report$/.exec(
      path,
    );
  if (!reference && path !== "/report") return null;
  const native = (env as NativeEnv)[NATIVE_CONTEXT]?.record.room;
  if (!native) throw new HttpError(503, "Chat identity is unavailable.");
  const reportTarget = {
    roomKey: `room:${native.id}`,
    targetUrl,
    ...(reference
      ? { messageRef: { channelId: reference[1], id: reference[2] } }
      : {}),
  };
  let captured: unknown;
  if (reference) {
    // An accepted report keeps its first snapshot. Recover only the caller's
    // receipt before trying to read a message that may since have changed.
    const receipt = await submitSafetyReport(
      request,
      env,
      session,
      body,
      reportTarget,
      "report-receipt",
    );
    if (receipt.status !== 404) return receipt;
    await receipt.body?.cancel();
    const target = await room.fetch(
      new Request(
        `https://internal/private/report-target?conversationId=${reference[1]}&messageId=${reference[2]}`,
        { headers },
      ),
    );
    if (!target.ok) return target;
    const data = await target.json<{
      channelId: string;
      message: Record<string, unknown>;
    }>();
    captured = { ...data.message, channelId: data.channelId };
  } else await requirePrivateMembership(room, headers);
  return submitSafetyReport(request, env, session, body, {
    ...reportTarget,
    message: captured,
  });
}

async function scopeNativeBudget(
  env: Env,
  context: NonNullable<NativeEnv[typeof NATIVE_CONTEXT]>,
) {
  (env as RpcBudgetEnv)[RPC_BUDGET]!.setRoom(context.room, context.record.room.id);
}
function requireExpectedPrincipal(
  body: Record<string, unknown>,
  session: Session,
) {
  if (
    "expectedWallet" in body ||
    body.expectedPrincipalId !== session.principalId
  )
    throw new HttpError(401, "Your sign-in changed. Try again.");
}
type Session = ChatSession & {
  token: string;
  connectCode?: string;
  walletRevision: number;
  servicePrincipals?: ChatPrincipalId[];
  walletIdentity?: {
    address: Address;
    kind: "eoa" | "contract";
    chainId: SupportSiweChainId;
  };
  /** The account's linked set, loaded once per session read.
   * Counted on the account page; never wallet authority. */
  wallets?: ProvenWallet[];
  /** A guest widget session's reported wallet: a claim, never authority. */
  guestClaim?: WidgetWallet;
  walletConsent?: true;
  walletUnavailable?: true;
  guestCredentialHash?: string;
};
function sessionView(session: Session): ChatSession {
  const {
    token: _token,
    connectCode: _connectCode,
    walletIdentity: _walletIdentity,
    wallets: _wallets,
    guestClaim: _guestClaim,
    walletConsent: _walletConsent,
    walletUnavailable: _walletUnavailable,
    guestCredentialHash: _guestCredentialHash,
    ...view
  } = session;
  return view;
}
function sessionData(data: AuthData, token: string): Session {
  if (!validCurrentSessionRecord(data))
    throw new HttpError(401, "Your chat session has expired. Sign in again.");
  const authMethod = data.authMethod;
  const wallet = data.address ? address(data.address) : null;
  if (
    !isAuthMethod(authMethod) ||
    !normalizeChatPrincipal(data.principalId) ||
    (authMethod === "wallet" && !wallet)
  )
    throw new HttpError(401, "Your chat session has expired. Sign in again.");
  const principalId = principal(data.principalId);
  return {
    principalId,
    servicePrincipals: servicePrincipals(principalId, data.servicePrincipals),
    authMethod,
    ...(authMethod === "email" ? { emailSignIn: true as const } : {}),
    authenticatedAt: data.authenticatedAt,
    ...(data.connectCode ? { connectCode: data.connectCode } : {}),
    address: wallet,
    // Only a Solana session names a Solana wallet; other sessions keep the
    // shape agents and tests have relied on.
    ...(data.solanaAddress ? { solanaAddress: data.solanaAddress } : {}),
    ...(authMethod === "guest" &&
    data.walletConsent === true &&
    readStoredWidgetWallet(data.guestClaim)
      ? {
          guestClaim: readStoredWidgetWallet(data.guestClaim)!,
          walletConsent: true as const,
        }
      : {}),
    ...(authMethod === "guest" && data.guestCredentialHash
      ? { guestCredentialHash: data.guestCredentialHash }
      : {}),
    ...(authMethod === "guest" && data.walletUnavailable === true
      ? { walletUnavailable: true }
      : {}),
    expiresAt: Math.min(data.expiresAt, data.authorizationExpiresAt!),
    walletAuthorizationExpiresAt:
      authMethod !== "wallet"
        ? (data.walletAuthorizationExpiresAt ?? null)
        : data.authorizationExpiresAt!,
    walletRevision: data.walletRevision!,
    token,
  };
}

function responseHeaders(response: Response, request: Request, env: Env) {
  // Durable Object fetch responses have immutable headers in Workers.
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, nosnippet, noimageindex");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  if (!headers.has("Content-Security-Policy"))
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  if (request.headers.get("Origin") === env.APP_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.APP_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Expose-Headers", "Retry-After, Server-Timing");
    headers.set("Timing-Allow-Origin", env.APP_ORIGIN);
    headers.set("Vary", "Origin");
  }
  if (response.status === 429 && !headers.has("Retry-After"))
    headers.set("Retry-After", "60");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type CurrentAuthData = AuthData & {
  principalId: ChatPrincipalId;
  authMethod: AuthMethod;
  authenticatedAt: number;
  authorizationExpiresAt: number;
  walletRevision: number;
};
function validCurrentSessionRecord(data: AuthData): data is CurrentAuthData {
  const now = Date.now();
  const principalId = normalizeChatPrincipal(data?.principalId);
  return Boolean(
    data &&
    isAuthMethod(data.authMethod) &&
    principalId &&
    normalizeServicePrincipals(principalId, data.servicePrincipals) &&
    Number.isSafeInteger(data.expiresAt) &&
    data.expiresAt > now &&
    Number.isSafeInteger(data.authorizationExpiresAt) &&
    data.authorizationExpiresAt! >= data.expiresAt &&
    Number.isSafeInteger(data.authenticatedAt) &&
    data.authenticatedAt! > 0 &&
    data.authenticatedAt! <= now &&
    Number.isSafeInteger(data.walletRevision) &&
    data.walletRevision! >= 0 &&
    !data.nonce &&
    !data.message &&
    (data.address === null ||
      (typeof data.address === "string" &&
        /^0x[0-9a-f]{40}$/.test(data.address))) &&
    (data.authMethod !== "wallet" || data.address !== null) &&
    (data.authMethod !== "email" ||
      (data.purpose === "email-session" &&
        data.address === null &&
        !data.authorization &&
        !data.walletAuthorizationExpiresAt &&
        principalId?.startsWith("account:") &&
        !data.widgetScope &&
        !data.solanaAddress &&
        !data.solanaAuthorization &&
        typeof data.emailSignInKey === "string" &&
        /^[a-f0-9]{64}$/.test(data.emailSignInKey) &&
        Number.isSafeInteger(data.emailSignInRevision) &&
        data.emailSignInRevision! >= 0)) &&
    // A widget session is a widget-session record: an EVM one carries its
    // SIWE proof, a Solana one its Sign In With Solana proof.
    (!data.widgetScope ||
      (data.purpose === "widget-session" &&
        (data.authMethod === "guest" ||
          (data.authMethod === "wallet" && !!data.authorization) ||
          (data.authMethod === "solana" && widgetSolanaRecord(data))))) &&
    // A guest proves nothing: it lives only in the widget scope that made it
    // and never carries a wallet or its authorization. The wallet its app
    // reported, EVM or Solana, is a claim; a record written before Solana
    // sign-in names an EVM claim without a network.
    (data.authMethod !== "guest" ||
      (data.purpose === "widget-session" &&
        !!data.widgetScope &&
        data.address === null &&
        !data.authorization &&
        !data.walletAuthorizationExpiresAt &&
        (data.guestClaim === undefined ||
          readStoredWidgetWallet(data.guestClaim) !== null))),
  );
}
/** A Solana widget session names its wallet and that wallet's strict
 * base64 proof, and nothing else: no EVM wallet, no claim. */
function widgetSolanaRecord(data: AuthData) {
  return (
    data.address === null &&
    !data.authorization &&
    !data.walletAuthorizationExpiresAt &&
    data.guestClaim === undefined &&
    isSolanaAddress(data.solanaAddress) &&
    typeof data.solanaAuthorization?.message === "string" &&
    decodeWidgetSolanaSignature(data.solanaAuthorization.signature) !== null
  );
}

/** The session record for this token, read from its shard. Errors are the
 * ones `currentSession` has always thrown. */
async function loadSessionRecord(env: Env, token: string) {
  const response = await (
    await record(env, "session", token)
  ).fetch(internalPost("/read"));
  if (response.status === 401)
    throw new HttpError(401, "Your chat session has expired. Sign in again.");
  if (!response.ok)
    throw new HttpError(
      503,
      "Sign-in is temporarily unavailable. Please try again.",
    );
  return response.json<AuthData>();
}
/** The read this request already started for this token, used once, or a
 * new read. */
function readSessionRecord(env: Env, token: string): Promise<AuthData> {
  const prefetch = requestPrefetch(env);
  const early = prefetch.session;
  if (early && early.token === token) {
    delete prefetch.session;
    return early.record as Promise<AuthData>;
  }
  return loadSessionRecord(env, token);
}
/** The identity read for exactly this principal: one this request started
 * from its hint when the principal matches, otherwise a new read. */
function identityRead(env: Env, principalId: ChatPrincipalId) {
  const prefetch = requestPrefetch(env);
  const early = prefetch.identity;
  if (early) delete prefetch.identity;
  return started(
    early && early.principalId === principalId
      ? (early.read as ReturnType<typeof sessionIdentity>)
      : measuredSessionIdentity(env, principalId),
  );
}
/** Starts this request's session read, plus the hinted identity and the
 * room's safety status. A POST calls it only once its body has arrived.
 * Only reads start here; every decision stays where `currentSession` and the
 * route make it. */
function prefetchSession(
  request: Request,
  env: Env,
  roomKey: string | null,
  hint?: ChatPrincipalId[],
) {
  const prefetch = requestPrefetch(env);
  if (roomKey !== null) prefetch.safetyTarget = roomKey;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  // The widget has already read, checked and handed over this record.
  if (prefetch.session?.token === token) return;
  prefetch.session = {
    token,
    record: started(loadSessionRecord(env, token)),
  };
  if (!hint?.length) return;
  prefetchSessionIdentity(env, hint[0]);
  if (roomKey !== null)
    prefetchSafety(env as SafetyEnv, roomKey, hint[0], hint);
}
/** The principals a request says it acts as: a valid
 * `X-Templ-Principal-Hint`, else the `expectedPrincipalId` of a JSON body the
 * route has already read. Untrusted either way: it only picks which reads
 * start early. */
async function requestHint(
  request: Request,
  body: Promise<Record<string, unknown>> | null,
) {
  const header = principalHint(
    request.headers.get(PRINCIPAL_HINT_HEADER),
    normalizeChatPrincipal,
  );
  if (header) return header;
  if (!body || !readCookie(request, SESSION_COOKIE)) return undefined;
  try {
    const expected = normalizeChatPrincipal((await body).expectedPrincipalId);
    return expected ? [expected] : undefined;
  } catch {
    return undefined;
  }
}
/** With the record read, the room's safety status can start for its
 * principal set; the route decides on the final set. */
function prefetchSessionSafety(env: Env, data: CurrentAuthData) {
  const target = requestPrefetch(env).safetyTarget;
  if (
    target === undefined ||
    (env as SafetyEnv).SAFETY_ENABLED !== "true" ||
    safetyPrefetched(
      env as SafetyEnv,
      target,
      principal(data.principalId),
      data.servicePrincipals,
    )
  )
    return;
  prefetchSafety(
    env as SafetyEnv,
    target,
    principal(data.principalId),
    data.servicePrincipals,
  );
}

async function currentSession(
  request: Request,
  env: Env,
  renew = false,
  verifyAuthority = verifySessionAuthority,
) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "Sign in to chat.");
  const sessionRecord = await record(env, "session", token);
  let data = await readSessionRecord(env, token);
  if (!matchesWidgetScope(data, (env as WidgetEnv)[WIDGET_SCOPE]))
    throw new HttpError(
      401,
      "This sign-in is only valid in its support widget.",
    );
  if (
    !validCurrentSessionRecord(data) ||
    (data.authMethod === "email" && env.EMAIL_SIGN_IN_ENABLED !== "true") ||
    data.authorizationExpiresAt! <= Date.now()
  ) {
    await sessionRecord.fetch(internalPost("/revoke"));
    throw new HttpError(401, "Your chat session has expired. Sign in again.");
  }
  // The identity read and the room's safety status start now, alongside
  // renewal and wallet authority; each result is used below, in order.
  const identity = identityRead(env, principal(data.principalId));
  prefetchSessionSafety(env, data);
  if (
    renew &&
    data.expiresAt < data.authorizationExpiresAt! &&
    data.expiresAt - Date.now() <= SESSION_TTL - SESSION_RENEW_AFTER
  ) {
    const renewal = await sessionRecord.fetch(
      internalPost("/renew", { expiresAt: Date.now() + SESSION_TTL }),
    );
    if (renewal.status === 401)
      throw new HttpError(401, "Your chat session has expired. Sign in again.");
    if (!renewal.ok)
      throw new HttpError(
        503,
        "Sign-in is temporarily unavailable. Please try again.",
      );
    data = await renewal.json<AuthData>();
    if (!validCurrentSessionRecord(data)) {
      await sessionRecord.fetch(internalPost("/revoke"));
      throw new HttpError(401, "Your chat session has expired. Sign in again.");
    }
  }
  // Only an EVM wallet session carries EVM wallet authority of its own. A
  // Solana session may attach a proven EVM wallet, verified the same way on
  // every read; a widget guest never holds one.
  const evmSession = data.authMethod === "wallet";
  if (data.authMethod === "solana") {
    // The Sign In With Solana proof is deterministic: the stored signature
    // must still verify for the wallet that opened the session.
    const proof = data.solanaAuthorization;
    const signature = !proof ? null : decodeSolanaSignature(proof.signature);
    if (
      !data.solanaAddress ||
      !proof ||
      !signature ||
      !(await verifySolanaSignature(
        proof.message,
        signature,
        data.solanaAddress,
      ))
    ) {
      await sessionRecord.fetch(internalPost("/revoke"));
      throw new HttpError(
        401,
        "Your wallet sign-in has expired. Sign in again.",
      );
    }
  }
  if (evmSession) {
    if (
      !(await verifyAuthority(env, address(data.address), data.authorization))
    ) {
      await sessionRecord.fetch(internalPost("/revoke"));
      throw new HttpError(
        401,
        "Your wallet sign-in has expired. Sign in again.",
      );
    }
  } else if (data.address) {
    let valid = false;
    let uncertain = false;
    try {
      valid = Boolean(
        data.authorization &&
        (data.walletAuthorizationExpiresAt ?? 0) > Date.now() &&
        (await verifyAuthority(env, address(data.address), data.authorization)),
      );
    } catch {
      uncertain = true;
    }
    if (!valid && !uncertain) {
      const detached = await sessionRecord.fetch(
        internalPost("/wallet/detach", {
          expectedPrincipalId: data.principalId,
          expectedRevision: data.walletRevision,
        }),
      );
      if (!detached.ok)
        throw new HttpError(
          detached.status === 409 ? 409 : 503,
          "Wallet authorization changed. Try again.",
        );
      data = await detached.json<AuthData>();
    } else if (uncertain) {
      // A provider outage never ends the Solana session or grants unverified wallet rights.
      data = {
        ...data,
        address: null,
        authorization: undefined,
        walletAuthorizationExpiresAt: undefined,
      };
    }
  }
  // The identity and its linked wallets in one round trip.
  const read = await identity;
  const { identity: account, linked } = read;
  // A Solana session ends once its wallet leaves the account.
  if (
    data.authMethod === "solana" &&
    !account.solana?.some((entry) => entry.address === data.solanaAddress)
  ) {
    await sessionRecord.fetch(internalPost("/revoke"));
    throw new HttpError(
      401,
      "That Solana wallet was removed from the account. Sign in again.",
    );
  }
  if (
    data.authMethod === "email" &&
    (!account.emailLogin ||
      account.emailLogin.emailKey !== data.emailSignInKey ||
      account.emailLogin.revision !== data.emailSignInRevision)
  ) {
    await sessionRecord.fetch(internalPost("/revoke"));
    throw new HttpError(401, "Your email sign-in has expired. Sign in again.");
  }
  data = await enforceSessionMethod(env, token, data, read);
  const result = sessionData(
    {
      ...data,
      principalId: account.principalId,
      servicePrincipals: account.servicePrincipals,
    },
    token,
  );
  result.servicePrincipals = servicePrincipals(
    account.principalId,
    account.servicePrincipals,
  );
  result.wallets = linked.wallets;
  if (result.address) {
    try {
      if (!data.authorization) throw new Error("Missing wallet proof");
      result.walletIdentity = {
        address: result.address as Address,
        ...(await provenWalletFacts(
          data.authorization.message,
          data.authorization.signature,
          result.address as Address,
        )),
      };
    } catch {
      await sessionRecord.fetch(internalPost("/revoke"));
      throw new HttpError(
        401,
        "Your wallet sign-in has expired. Sign in again.",
      );
    }
  }
  return result;
}

const samePrincipalSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  [...left].sort().join(",") === [...right].sort().join(",");
/** Starts the subscription list read for the principals the session record
 * names. Only a read; the route uses it after verifying the session. */
function prefetchSubscriptionList(env: Env, request: Request, url: URL) {
  const token = readCookie(request, SESSION_COOKIE);
  const recordRead = requestPrefetch(env).session;
  if (!env.ROOM_SUBSCRIPTIONS || !token || recordRead?.token !== token)
    return null;
  return started(
    (async () => {
      const data = (await recordRead.record) as AuthData;
      const principalId = normalizeChatPrincipal(data.principalId);
      if (!principalId) return null;
      const principals = servicePrincipals(principalId, data.servicePrincipals);
      const response = await timed(
        env,
        "subs",
        linkedSubscriptions(env, {
          principalId,
          servicePrincipals: principals,
        }).fetch(new Request(`https://internal${url.pathname}${url.search}`)),
      );
      return { principalId, principals, response };
    })().catch(() => null),
  );
}
/** The followed rooms this session may still see, in list order. Every
 * room's record is read at once, one safety status covers all of them, and
 * the membership checks then run together; a room that is missing,
 * suspended or private to others is left out exactly as before. */
async function visibleSubscriptions<
  T extends { kind: "native"; room: { id: string } },
>(env: Env, session: Session, items: T[]) {
  const native = items.filter(
    (item) => "kind" in item && item.kind === "native",
  );
  const dropped = (error: unknown) => {
    if (!(error instanceof HttpError) || ![403, 404].includes(error.status))
      throw error;
    return null;
  };
  const records: ({
    room: DurableObjectStub;
    record: NativeRoomRecord;
  } | null)[] = [];
  let blocked: { rooms: string[]; principal: boolean } = {
    rooms: [],
    principal: false,
  };
  for (let start = 0; start < native.length; start += SUBSCRIPTION_READS) {
    const batch = native.slice(start, start + SUBSCRIPTION_READS);
    const [reads, status] = await Promise.all([
      Promise.allSettled(batch.map((item) => nativeRecord(env, item.room.id))),
      Promise.allSettled([
        (env as SafetyEnv).SAFETY_ENABLED === "true"
          ? safetyRequest(env as SafetyEnv, {
              op: "status",
              roomKeys: batch.map((item) => `room:${item.room.id}`),
              principalId: session.principalId,
              servicePrincipals: servicePrincipals(
                session.principalId,
                sessionPrincipals(session),
              ),
            })
          : null,
      ]).then(([result]) => result),
    ]);
    // Judged in list order: a room's read, then its safety status.
    let judged = false;
    for (const read of reads) {
      if (read.status === "rejected") {
        records.push(dropped(read.reason));
        continue;
      }
      if (!judged) {
        judged = true;
        if (status.status === "rejected") throw status.reason;
        if (status.value) {
          if (!status.value.ok)
            throw new HttpError(503, "Chat is temporarily unavailable.");
          const result = await status.value.json<{
            blockedRooms: string[];
            principalBlocked: boolean;
          }>();
          blocked = {
            rooms: [...blocked.rooms, ...result.blockedRooms],
            principal: blocked.principal || result.principalBlocked,
          };
        }
      }
      records.push(read.value);
    }
  }
  const allowed = records.map((context) =>
    context &&
    !blocked.principal &&
    !blocked.rooms.includes(`room:${context.record.room.id}`)
      ? context
      : null,
  );
  const memberships = await Promise.allSettled(
    allowed.map((context) =>
      context ? nativeWorkspaceMetadata(env, context, session) : null,
    ),
  );
  const visible: (T & { room: import("@templ/chat/index").NativeRoom })[] = [];
  for (const [index, item] of native.entries()) {
    const context = allowed[index];
    if (!context) continue;
    const membership = memberships[index];
    if (membership.status === "rejected") {
      dropped(membership.reason);
      continue;
    }
    if (!membership.value) continue;
    visible.push({ ...item, room: membership.value });
  }
  return visible;
}

async function revokeSession(env: Env, token: string) {
  const result = await (
    await record(env, "session", token)
  ).fetch(internalPost("/revoke"));
  if (!result.ok)
    throw new HttpError(503, "Could not sign out. Please try again.");
}

/** A sign-in's new session, written together with the revocation of the
 * session its cookie replaces. Both finish before the response, and a failed
 * revocation is still reported first. */
async function replaceSession(
  request: Request,
  env: Env,
  token: string,
  data: AuthData,
) {
  const oldToken = readCookie(request, SESSION_COOKIE);
  const [revoked, saved] = await Promise.allSettled([
    oldToken ? revokeSession(env, oldToken) : null,
    saveRecord(env, "session", token, data),
  ]);
  if (revoked.status === "rejected") throw revoked.reason;
  if (saved.status === "rejected") throw saved.reason;
}
async function saveRecord(
  env: Env,
  kind: "nonce" | "session",
  token: string,
  value: AuthData,
) {
  const result = await (
    await record(env, kind, token)
  ).fetch(internalPost("/create", value));
  if (!result.ok)
    throw new HttpError(503, "Could not create a secure chat session.");
}

export function createCommunityWorker(
  deps: Dependencies = {
    verifyWallet,
    verifiedChain,
  },
) {
  // One memo per isolate bounds the ops object reads monitors cause.
  const healthMemo = createHealthMemo();
  // One memo per isolate for the public incident list.
  const incidentsMemo = createIncidentsMemo();
  const worker = {
    async fetch(request: Request, env: Env): Promise<Response> {
      // One request owns its budget capability. Never mutate shared Env bindings.
      env = { ...env, [RPC_BUDGET]: createRpcBudget(env) } as RpcBudgetEnv;
      let response: Response;
      try {
        siteOrigins(env);
        const url = new URL(request.url);
        const stripeWebhook = await stripeWebhookRoute(request, env as never);
        if (stripeWebhook) return responseHeaders(stripeWebhook, request, env);
        if (url.pathname === "/release" && request.method === "GET")
          return responseHeaders(releaseIdentity(env), request, env);
        if (
          [RELEASE_ACTIVATION_PATH, RELEASE_AVAILABILITY_PATH].includes(
            url.pathname,
          )
        ) {
          const limiter =
            request.method === "POST" &&
            url.pathname === RELEASE_ACTIVATION_PATH
              ? env.CHAT_RATE_LIMITER
              : env.CHAT_READ_RATE_LIMITER;
          if (
            !limiter ||
            !(
              await limiter.limit({
                key: `release:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
              })
            ).success
          )
            throw new HttpError(429, "Too many requests.");
        }
        const activation = await releaseActivationRoute(request, env);
        if (activation) return responseHeaders(activation, request, env);
        if (url.pathname === "/robots.txt" && request.method === "GET")
          return responseHeaders(
            new Response(
              "# Allow crawlers to read the noindex header on every response.\nUser-agent: *\nAllow: /\n",
              { headers: { "Content-Type": "text/plain; charset=utf-8" } },
            ),
            request,
            env,
          );
        // Token images must remain fetchable by the public directory without
        // browser cookies or an Origin header.
        if (url.pathname.startsWith("/media/") && request.method === "GET") {
          if (
            !env.CHAT_READ_RATE_LIMITER ||
            !(
              await env.CHAT_READ_RATE_LIMITER.limit({
                key: `media:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
              })
            ).success
          )
            throw new HttpError(
              429,
              "Too many requests. Please try again shortly.",
            );
          if (
            (env as SafetyEnv).SAFETY_ENABLED === "true" &&
            /^[0-9a-f]{64}$/.test(url.pathname.slice(7))
          ) {
            const status = await safetyRequest(env as SafetyEnv, {
              op: "status",
              roomKeys: [],
              mediaKeys: [url.pathname.slice(7)],
            });
            if (!status.ok)
              throw new HttpError(503, "Image is temporarily unavailable.");
            const result = await status.json<{ blockedMedia: string[] }>();
            if (result.blockedMedia.length)
              throw new HttpError(404, "Image not found.");
          }
          return responseHeaders(
            await getMedia(env, url.pathname.slice("/media/".length)),
            request,
            env,
          );
        }
        if (
          ["/health", "/health/chain"].includes(url.pathname) &&
          request.method === "GET"
        ) {
          if (
            !env.CHAT_READ_RATE_LIMITER ||
            !(
              await env.CHAT_READ_RATE_LIMITER.limit({
                key: request.headers.get("CF-Connecting-IP") ?? "unknown",
              })
            ).success
          )
            throw new HttpError(
              429,
              "Too many requests. Please try again shortly.",
            );
          config(env);
          if (url.pathname === "/health/chain") {
            if (
              (await inspectChainHealth(
                env as OpsHealthEnv,
                { verifiedChain: deps.verifiedChain, memo: healthMemo },
                Date.now(),
              )) !== "ok"
            )
              throw new HttpError(503, "Chain state cannot be verified.");
            return responseHeaders(
              json({ status: "ready", chainId: HEALTH_CHAIN_ID }),
              request,
              env,
            );
          }
          // Optional chain readiness remains separate from service readiness.
          return responseHeaders(
            json({ status: "ready", service: "community" }),
            request,
            env,
          );
        }
        // Like /health, readable without an Origin; fixed labels only.
        const supportHealth = await supportHealthRoute(
          request,
          env as OpsHealthEnv,
          { verifiedChain: deps.verifiedChain, memo: healthMemo },
        );
        if (supportHealth) return responseHeaders(supportHealth, request, env);
        // Templ's incident notices, readable from any site
        // without credentials, before the widget route and the Origin gate.
        const incidents = await statusIncidentsRoute(
          request,
          env as IncidentsEnv,
          incidentsMemo,
        );
        if (incidents) return responseHeaders(incidents, request, env);
        if (url.pathname === "/connect/trial-capture/preflight") {
          if (
            !(
              await env.CHAT_RATE_LIMITER.limit({
                key: request.headers.get("CF-Connecting-IP") ?? "unknown",
              })
            ).success
          )
            throw new HttpError(429, "Too many requests.");
          return responseHeaders(
            (await connectTrialCaptureRoute(request, env))!,
            request,
            env,
          );
        }
        if (["/connect/start", "/connect/poll"].includes(url.pathname)) {
          if (request.method !== "POST")
            throw new HttpError(405, "Method not allowed.");
          if (
            request.headers.has("Cookie") ||
            request.headers.has("Authorization") ||
            (request.headers.has("Origin") &&
              request.headers.get("Origin") !== env.APP_ORIGIN)
          )
            throw new HttpError(
              403,
              "Run app connection from your coding tool.",
            );
          requireConnectEnabled(env);
          const decisions: ConnectLimitDecision[] = [];
          const starting = url.pathname.endsWith("start");
          let status = 201;
          let refusal: { error: string } | undefined;
          try {
            if (starting)
              await connectLimit(request, env, "start", (decision) =>
                decisions.push(decision),
              );
            admitFunnelRequest(env);
            let body: Record<string, unknown>;
            try {
              body = await readJson(request, 4096);
            } catch (error) {
              if (url.pathname.endsWith("poll"))
                await connectLimit(request, env, "poll-invalid");
              throw error;
            }
            const response = url.pathname.endsWith("start")
              ? await startConnect(body, env)
              : await pollConnect(body, env, request);
            status = response.status;
            return responseHeaders(response, request, env);
          } catch (error) {
            status = error instanceof HttpError ? error.status : 500;
            if (error instanceof HttpError && error.status === 429)
              refusal = { error: error.message };
            throw error;
          } finally {
            if (starting && decisions.length)
              await observeConnectTrialStart(
                request,
                env,
                decisions,
                status,
                refusal,
              );
          }
        }
        const widget = await supportWidgetRoute(
          request,
          env,
          (next, scoped) => route(next, scoped, deps, config(scoped)),
          deps,
        );
        // A member socket's 101 and the visitor check's page
        // keep their own headers (turnstile.ts passThrough).
        if (widget)
          return passThrough(widget)
            ? widget
            : responseHeaders(widget, request, env);
        // One-click unsubscribe from a member reply email:
        // mail clients send no Origin; it changes one preference only.
        const unsubscribe = await memberUnsubscribeRoute(request, env as never);
        if (unsubscribe) return responseHeaders(unsubscribe, request, env);
        // Requiring an exact Origin also protects reads made with ambient cookies.
        if (request.headers.get("Origin") !== env.APP_ORIGIN)
          throw new HttpError(403, "Origin is not allowed.");
        const cfg = config(env);
        if (request.method === "OPTIONS") {
          response = new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": `Content-Type, ${PRINCIPAL_HINT_HEADER}, ${ONBOARDING_HEADER}`,
              "Access-Control-Max-Age": "7200",
            },
          });
        } else {
          const screenshotRoom =
            /^\/rooms\/([^/]+)\/conversations\/tc-[0-9a-f]{32}\/workflow$/.exec(
              url.pathname,
            );
          const screenshotUpload =
            request.method === "POST" &&
            request.headers.get("Content-Type") === "image/png" &&
            screenshotRoom !== null &&
            NATIVE_UUID.test(screenshotRoom[1]);
          const limiter =
            url.pathname === "/media" || screenshotUpload
              ? env.MEDIA_RATE_LIMITER
              : url.pathname.startsWith("/auth/")
                ? env.AUTH_RATE_LIMITER
                : request.method === "GET"
                  ? env.CHAT_READ_RATE_LIMITER
                  : env.CHAT_RATE_LIMITER;
          // Polling readers share an IP on mobile carriers and shared Wi-Fi.
          // Their bounded read budget must not consume the mutation budget.
          // CF-Connecting-IP is supplied by Cloudflare, never by a JSON caller.
          if (
            !limiter ||
            !(
              await timed(
                env,
                "limit",
                limiter.limit({
                  key: `${url.pathname === "/funnel/journey" || /^\/rooms\/[^/]+\/onboarding$/.test(url.pathname) ? "onboarding:" : ""}${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
                }),
              )
            ).success
          )
            throw new HttpError(
              429,
              "Too many requests. Please try again shortly.",
              url.pathname.startsWith("/auth/") ? 60 : undefined,
            );
          // Past the origin check and the rate limiter: this outcome counts.
          admitFunnelRequest(env);
          response = await route(request, env, deps, cfg);
        }
      } catch (caught) {
        const error = rpcCapacityError(caught) ?? caught;
        if (!(error instanceof HttpError) || error.status >= 500)
          reportRpcFailure({
            stage: "community-request",
            category: classifyRpcFailure(error),
            env,
          });
        response = json(
          errorBody(error, "Community is temporarily unavailable."),
          error instanceof HttpError ? error.status : 503,
          error instanceof HttpError && error.retryAfterSeconds
            ? {
                "Retry-After": String(
                  Math.max(1, Math.ceil(error.retryAfterSeconds)),
                ),
              }
            : undefined,
        );
      }
      return response.status === 101
        ? response
        : responseHeaders(response, request, env); // A socket upgrade keeps its WebSocket
    },
  };
  return {
    async fetch(
      request: Request,
      env: Env,
      context?: Pick<ExecutionContext, "waitUntil">,
    ): Promise<Response> {
      const observed = withRequestContext(
        withFunnelObservation(withCostObservation(env)),
      );
      const started = Date.now();
      let response: Response | undefined;
      try {
        response = withServerTiming(
          observed,
          await worker.fetch(request, observed),
          Date.now() - started,
        );
        return response;
      } finally {
        // Deferred work starts after the response is handed back.
        const deferred = drainDeferred(observed);
        if (context) context.waitUntil(deferred);
        else await deferred;
        if (context) {
          finishCostObservation(
            observed,
            {
              path: new URL(request.url).pathname,
              status: response?.status ?? 503,
              durationMs: Date.now() - started,
            },
            context,
          );
          finishFunnelObservation(
            observed as Env & FunnelEnv,
            request,
            response,
            context,
          );
          finishSupportFailureObservation(
            observed as OpsHealthEnv,
            request,
            response,
            context,
          );
        }
      }
    },
    /** The staging canary. It calls the inner fetch, so its requests never
     * enter the onboarding funnel or the sampled cost shards. */
    async scheduled(
      controller: Pick<ScheduledController, "scheduledTime">,
      env: Env,
      context: Pick<ExecutionContext, "waitUntil">,
    ): Promise<void> {
      const run = runSupportCanary(
        { ...env, [RPC_BUDGET]: createRpcBudget(env) } as RpcBudgetEnv &
          OpsHealthEnv,
        {
          fetch: (request) => worker.fetch(request, env),
          verifiedChain: deps.verifiedChain,
          scheduledTime: controller.scheduledTime,
        },
      );
      context.waitUntil(run);
      await run;
    },
  };
}

/** Sends widget settings changes that wait in the settings object to the
 * room's access log, then acknowledges what the room recorded. The room
 * skips entries it already has, so a lost answer or a retry logs each change
 * once; a failed delivery is retried on the next open or save. The manager's
 * answer is the same either way and never carries the pending entries. */
async function relayWidgetAudit(
  env: Env,
  room: string,
  stub: { fetch(request: Request): Promise<Response> },
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  const { audit, ...settings } = await response.json<
    Record<string, unknown> & { audit?: unknown }
  >();
  const entries = Array.isArray(audit) ? audit : [];
  if (entries.length)
    try {
      const imported = await stub.fetch(
        new Request("https://internal/private/support/audit-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "widget-config", entries }),
        }),
      );
      if (!imported.ok) throw new Error("import");
      const { upTo } = await imported.json<{ upTo: number }>();
      const delivered = Math.max(
        ...entries.map((entry: { seq?: unknown }) => Number(entry.seq)),
      );
      const acked = await widgetConfig(env, room, {
        op: "audit-ack",
        upTo: Math.min(upTo, delivered),
      });
      await acked.body?.cancel();
      if (!acked.ok) throw new Error("ack");
    } catch {
      console.error("TEMPL_WIDGET_AUDIT_RELAY_FAILED");
    }
  return json(settings, response.status);
}

/** Adds the widget settings object's counts of widget opens on unapproved
 * websites to the room's refusal counts. When that second read fails, the
 * room's counts are kept and the answer says the origin counts are missing.
 * Counts only: no origin, principal or text crosses here. */
async function withOriginRefusals(
  env: Env,
  room: string,
  url: URL,
  response: Response,
): Promise<Response> {
  const counts = await response.json<SupportRefusals>();
  let widgetDays: WidgetRefusalDay[] | null = null;
  try {
    const widget = await widgetConfig(env, room, {
      op: "refusals",
      days: refusalWindowDays(url.searchParams.get("days")),
    });
    if (widget.ok) widgetDays = checkedWidgetRefusalDays(await widget.json());
    else await widget.body?.cancel();
  } catch {
    widgetDays = null;
  }
  return json(mergeOriginRefusals(counts, widgetDays));
}

async function route(
  request: Request,
  env: Env,
  deps: Dependencies,
  cfg: ReturnType<typeof config>,
) {
  const url = new URL(request.url);
  const capture = await connectTrialCaptureRoute(request, env);
  if (capture) return capture;
  const connection =
    /^\/connect\/([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})(?:\/(approve|deny|workspaces))?$/.exec(
      url.pathname,
    );
  if (connection) {
    await connectLimit(request, env, connection[2] ?? "read");
    env = await releaseActivationEnv(env);
    const code = connectCode(connection[1]);
    if (!connection[2] && request.method === "GET") {
      const row = await connectRequest(env, { op: "read", code });
      return json({
        code,
        origins: row.origins,
        ...(row.appName ? { appName: row.appName } : {}),
        expiresAt: row.expiresAt,
        status: "pending",
        createAllowed: featureOn(env, undefined, "installConnect"),
      });
    }
    if (
      !(
        (connection[2] === "workspaces" && request.method === "GET") ||
        (["approve", "deny"].includes(connection[2] ?? "") &&
          request.method === "POST")
      )
    )
      throw new HttpError(405, "Method not allowed.");
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    if (session.connectCode !== code)
      throw new HttpError(
        403,
        "Sign in from this install link before confirming it.",
      );
    const actor = {
      code,
      principalId: session.principalId,
      sessionHash: await sessionCacheKey(session.token),
    };
    const row = await connectRequest(env, { op: "bound", ...actor });
    if (connection[2] === "workspaces") {
      const response = await nativeCatalog(env, {
        op: "managed-list",
        principalId: session.principalId,
        servicePrincipals: sessionPrincipals(session),
        cursor: url.searchParams.get("cursor"),
      });
      if (!response.ok) return response;
      const listed = await response.json<{
        workspaces: { id: string; name: string }[];
        cursor: string | null;
      }>();
      const workspaces: { id: string; name: string }[] = [];
      for (const item of listed.workspaces) {
        const context = await nativeRecord(env, item.id);
        if (!sessionPrincipals(session).includes(context.record.room.manager))
          continue;
        const scoped = context.features
          ? workspaceFeatureEnvFromValues(
              env,
              context.features,
              context.record.room.id,
            )
          : env;
        if (
          !featureOn(scoped, undefined, "installConnect") ||
          context.record.room.visibility !== "public"
        )
          continue;
        try {
          refuseClosedWorkspace(context.record, "/widget", scoped as never);
        } catch (error) {
          if (error instanceof HttpError && error.status === 410) continue;
          throw error;
        }
        await requireSafetyAccess(
          scoped as SafetyEnv,
          `room:${item.id}`,
          session.principalId,
          sessionPrincipals(session),
        );
        workspaces.push({ id: item.id, name: context.record.room.name });
      }
      return json({ workspaces, cursor: listed.cursor });
    }
    const body = await readJson(request, 4096);
    requireExpectedPrincipal(body, session);
    requireWalletAuth(session, body.confirmed);
    if (connection[2] === "deny") {
      await connectRequest(env, { op: "deny", ...actor });
      return json({ ok: true });
    }
    const creating = body.workspaceId === undefined;
    const workspaceId = creating
      ? uuidv7(Date.now())
      : nativeRoomId(body.workspaceId);
    let trialOperator: `0x${string}` | undefined;
    let originEnv = env;
    if (creating) {
      if (
        body.flagWorkspaceId !== undefined ||
        !featureOn(env, undefined, "installConnect")
      ) {
        if (
          (!isOperatorAdmin(
            env as OperatorAdminEnv,
            session.principalId,
            sessionPrincipals(session),
          ) &&
            !isTrialOperatorAdmin(
              env,
              session.principalId,
              sessionPrincipals(session),
            )) ||
          body.flagWorkspaceId === undefined
        )
          throw new HttpError(
            403,
            "Workspace creation from this link is not available.",
          );
        const anchor = await nativeRecord(
          env,
          nativeRoomId(body.flagWorkspaceId),
        );
        if (!sessionPrincipals(session).includes(anchor.record.room.manager))
          throw new HttpError(
            403,
            "Only the workspace manager can test app connection.",
          );
        const scoped = anchor.features
          ? workspaceFeatureEnvFromValues(
              env,
              anchor.features,
              anchor.record.room.id,
            )
          : env;
        if (!featureOn(scoped, undefined, "installConnect"))
          throw new HttpError(
            403,
            "Turn on app connection for this test workspace.",
          );
        refuseClosedWorkspace(anchor.record, "/widget", scoped as never);
        await requireSafetyAccess(
          scoped as SafetyEnv,
          `room:${anchor.record.room.id}`,
          session.principalId,
          sessionPrincipals(session),
        );
        if (
          anchor.record.trialOperator !== undefined ||
          isTrialOperatorAdmin(
            env,
            session.principalId,
            sessionPrincipals(session),
          )
        ) {
          trialOperator = await connectTrialOperator(
            env,
            anchor.record.room.id,
            session,
          );
          const current = await currentSession(
            request,
            env,
            false,
            deps.verifySessionAuthority,
          );
          requireExpectedPrincipal(body, current);
          requireWalletAuth(current, body.confirmed);
          if (
            current.connectCode !== code ||
            !sessionPrincipals(current).includes(trialOperator)
          )
            throw new HttpError(
              403,
              "Use the trial signer from this install link.",
            );
          await requireSafetyAccess(
            scoped as SafetyEnv,
            `room:${anchor.record.room.id}`,
            current.principalId,
            sessionPrincipals(current),
          );
        }
      }
      // Validate the same native workspace input before consuming the code.
      nativeCreation(
        {
          id: workspaceId,
          name: body.name ?? row.appName ?? "Support",
          visibility: "public",
          ...(trialOperator === undefined ? {} : { trialOperator }),
        },
        session.principalId,
      );
    } else {
      const context = await nativeRecord(env, workspaceId);
      if (!sessionPrincipals(session).includes(context.record.room.manager))
        throw new HttpError(
          403,
          "Only the workspace manager can connect this app.",
        );
      const scoped = context.features
        ? workspaceFeatureEnvFromValues(
            env,
            context.features,
            context.record.room.id,
          )
        : env;
      originEnv = scoped;
      if (!featureOn(scoped, undefined, "installConnect"))
        throw new HttpError(
          403,
          "App connection is not available for this workspace.",
        );
    }
    await connectRequest(env, { op: "confirm", ...actor, workspaceId });
    const forward = (path: string, data: Record<string, unknown>) =>
      route(
        new Request(new URL(path, request.url), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({
            expectedPrincipalId: session.principalId,
            ...data,
          }),
        }),
        { ...env, [CONNECT_DEADLINE]: row.expiresAt } as Env &
          ConnectDeadlineEnv,
        deps,
        cfg,
      );
    try {
      if (creating) {
        const response = await forward("/rooms", {
          id: workspaceId,
          name: body.name ?? row.appName ?? "Support",
          visibility: "public",
          ...(trialOperator === undefined ? {} : { trialOperator }),
        });
        if (!response.ok)
          throw new HttpError(
            response.status,
            "Could not create this workspace. Start again in your coding tool.",
          );
      }
      // Widget settings and audit use their existing manager-only path.
      // Preserve sites already approved by this workspace's manager.
      const settings = await widgetConfig(env, workspaceId, { op: "open" });
      if (!settings.ok)
        throw new HttpError(
          503,
          "Could not read widget settings. Start again.",
        );
      const existing = await settings.json<{ origins: string[] }>();
      const origins = widgetOrigins(
        [...new Set([...existing.origins, ...row.origins])],
        loopbackOffered(originEnv as WidgetSessionEnv),
      );
      const response = await forward(`/rooms/${workspaceId}/widget`, {
        confirmed: true,
        origins,
      });
      if (!response.ok)
        throw new HttpError(
          response.status,
          "Could not approve these origins. Start again in your coding tool.",
        );
      await connectRequest(env, {
        op: "finish",
        ...actor,
        workspaceId,
        approved: true,
      });
      return json({ workspaceId });
    } catch (error) {
      await connectRequest(env, {
        op: "finish",
        ...actor,
        workspaceId,
        approved: false,
      }).catch(() => undefined);
      throw error;
    }
  }
  if (!url.pathname.startsWith("/auth/")) env = await releaseActivationEnv(env);
  {
    const realtime = await realtimeRoute(request, env, {
      nativeRoom: (id) => nativeRecord(env, id),
      route: (next) => route(next, env, deps, cfg),
    });
    if (realtime) return realtime;
  } // Realtime tickets and socket upgrades.
  // Account-level feature routes. A route here
  // checks the session and the reader's current access itself and grants
  // nothing by being reached; workspace routes go in team-conversations.ts.
  // Storage recovery and operator routes (operator only).
  {
    const recovery = await handleRecoveryRoute(request, env as RecoveryEnv, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (recovery) return recovery;
  }
  // The operator inventory route.
  {
    const inventory = await operatorInventoryRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (inventory) return inventory;
  }
  // The bot registration route by Solana address.
  {
    // A bot named by the Solana wallet its account proved: the manager-only
    // lookup, then the room's ordinary registration (bot-register-solana.ts).
    const solanaBot: Response | null = await solanaBotRoute(request, {
      session: (next) =>
        currentSession(next, env, false, deps.verifySessionAuthority),
      principals: (session) => sessionPrincipals(session),
      manager: async (id) => (await nativeRecord(env, id)).record.room.manager,
      owner: async (wallet) => {
        const found = (await identityRequest(env, {
          op: "solana-owner",
          address: wallet,
        })) as unknown as { principalId?: unknown };
        return normalizeChatPrincipal(found.principalId);
      },
      limit: async (key) =>
        Boolean(
          env.AUTH_RATE_LIMITER &&
          (await env.AUTH_RATE_LIMITER.limit({ key })).success,
        ),
      route: (next): Promise<Response> => route(next, env, deps, cfg),
      widget: Boolean((env as WidgetEnv)[WIDGET_SCOPE]),
    });
    if (solanaBot) return solanaBot;
  }
  // Incident notices and workspace export routes.
  {
    const incidents = await operatorIncidentsRoute(
      request,
      env as IncidentsEnv,
      {
        session: () =>
          currentSession(request, env, false, deps.verifySessionAuthority),
      },
    );
    if (incidents) return incidents;
    const deletion = await workspaceDeletionRoute(request, env as never, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
      widget: Boolean((env as WidgetEnv)[WIDGET_SCOPE]),
    });
    if (deletion) return deletion;
  }
  {
    const flags = await operatorFlagsRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (flags) return flags;
  }
  // The /operator/grants route.
  {
    const grants = await operatorGrantsRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (grants) return grants;
  }
  // /operator/billing: Templ operators only; every action needs a fresh
  // wallet sign-in, a confirmation and a written reason.
  {
    const billing = await operatorBillingRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (billing) return billing;
    const orderForms = await operatorOrderFormsRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (orderForms) return orderForms;
    const storageBilling = await storageOperatorRoute(request, env as never, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (storageBilling) return storageBilling;
  }
  // Templ's corpus readers (corpus-operator.ts).
  {
    const corpus = await corpusOperatorRoute(request, env as never, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
    });
    if (corpus) return corpus;
  }
  {
    // The hosted support page's lookup by verified domain.
    const supportEntry = await supportEntryRoute(request, env);
    if (supportEntry) return supportEntry;
  }
  // Alert destination routes.
  {
    // Member reply email: the ticket page's grant, the address check, the
    // preference and one-click unsubscribe (member-alerts.ts). Alert
    // channel routes are workspace routes in team-conversations.ts.
    const memberAlerts = await memberAlertRoute(request, env as never);
    if (memberAlerts) return memberAlerts;
  }
  // The domain verification route.
  {
    // Verified domains for the widget (domain-verify.ts): the manager's
    // list, add, check and remove.
    const domains = await domainVerifyRoute(request, env as never, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
      config: (room, body) => widgetConfig(env, room, body as never),
      relay: (room, stub, response) =>
        relayWidgetAudit(env, room, stub, response),
      widget: Boolean((env as WidgetEnv)[WIDGET_SCOPE]),
      admin: (context, session) =>
        nativeWorkspaceAdmin(env, context, session as Session),
    });
    if (domains) return domains;
  }
  // Fixed counts from Templ's own site.
  {
    const onboarding = await browserOnboardingRoute(request, env, () =>
      optionalSession(request, env, deps),
    );
    if (onboarding) return onboarding;
    const report = await operatorOnboardingRoute(request, env, () =>
      currentSession(request, env, false, deps.verifySessionAuthority),
    );
    if (report) return report;
    const workspaceEvent = /^\/rooms\/([0-9a-f-]+)\/onboarding$/.exec(
      url.pathname,
    );
    if (workspaceEvent) {
      if (request.method !== "POST") throw new HttpError(404, "Not found.");
      const actor = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      const event = browserOnboardingEvent(await readJson(request, 512));
      if (!event) throw new HttpError(400, "Invalid onboarding event.");
      if (onboardingOptOut(request))
        return json({ recorded: false });
      const id = nativeRoomId(workspaceEvent[1]);
      return nativeStub(env, id).fetch(
        internalPost("/private/onboarding", {
          name: event.name,
          principalId: actor.principalId,
          servicePrincipals: sessionPrincipals(actor),
        }),
      );
    }
    const copied = await siteFunnelRoute(request);
    if (copied) return copied;
  }
  if (url.pathname === "/safety" && request.method === "GET")
    return json({ reporting: safetyAvailable(env as SafetyEnv) });
  if (url.pathname === "/safety/reports" && request.method === "POST") {
    const body = await readJson(request, 16_000);
    return submitSafetyReport(
      request,
      env,
      await optionalSession(request, env, deps),
      body,
    );
  }
  if (url.pathname === "/safety/admin" && request.method === "POST") {
    await safetyAdmin(request, env as SafetyEnv);
    const body = await readJson(request, 8_000);
    if (!["list", "review"].includes(String(body.op)))
      throw new HttpError(400, "Invalid review operation.");
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    requireExpectedPrincipal(body, session);
    if (
      !safetyIsAdmin(
        env as SafetyEnv,
        session.principalId,
        session.servicePrincipals,
      )
    )
      throw new HttpError(403, "Operator access required.");
    const authenticatedAt = requireWalletAuth(
      session,
      body.op === "list" ? true : body.confirmed,
    );
    return safetyRequest(env as SafetyEnv, {
      ...body,
      reviewer: session.principalId,
      authenticatedAt,
      authMethod: session.authMethod,
    });
  }
  if (url.pathname === "/media" && request.method === "POST") {
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    await requireSafetyAccess(
      env as SafetyEnv,
      null,
      session.principalId,
      sessionPrincipals(session),
    );
    return uploadMedia(request, env, session.principalId);
  }
  if (url.pathname === "/auth/capabilities" && request.method === "GET")
    return json({
      wallet: true,
      emailSignIn: emailSignInAvailable(await publicEmailSignInEnv(env)),
      walletChainIds: CHAT_CHAIN_IDS,
      smartWalletChainIds: [SMART_WALLET_AUTH_CHAIN_ID],
      // Solana: sign-in needs no provider.
      solana: { signIn: true },
    });
  const emailLogin = /^\/auth\/email\/login\/(preview\/)?(start|verify)$/.exec(
    url.pathname,
  );
  if (emailLogin && request.method === "POST") {
    let emailEnv = env;
    if (emailLogin[1]) {
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      const body = await readJson(request.clone(), 4096);
      requireExpectedPrincipal(body, session);
      requireWalletAuth(session, body.confirmed);
      if (
        !isTrialOperatorAdmin(
          env,
          session.principalId,
          sessionPrincipals(session),
        )
      )
        throw new HttpError(403, "Email sign-in preview is not available.");
      const anchor = await nativeRecord(env, nativeRoomId(body.workspaceId));
      if (
        !anchor.record.trialOperator ||
        !sessionPrincipals(session).includes(anchor.record.trialOperator) ||
        !sessionPrincipals(session).includes(anchor.record.room.manager)
      )
        throw new HttpError(403, "Use your disposable test workspace.");
      refuseClosedWorkspace(anchor.record, "/widget", env as never);
      await requireSafetyAccess(
        env as SafetyEnv,
        `room:${anchor.record.room.id}`,
        session.principalId,
        sessionPrincipals(session),
      );
    } else {
      emailEnv = await publicEmailSignInEnv(env);
    }
    const context = {
      sessionKey: await sessionCacheKey(
        readCookie(request, SESSION_COOKIE) ??
          "templ-email-sign-in-without-session",
      ),
    };
    if (emailLogin[2] === "start")
      return startEmailSignIn(request, emailEnv as EmailEnv, context);
    const account = await verifyEmailSignIn(
      request,
      emailEnv as EmailEnv,
      context,
    );
    if (!account.emailLogin)
      throw new HttpError(401, "Request a new email code.");
    const token = randomToken(),
      now = Date.now(),
      emailSessionTtl = 24 * 60 * 60_000,
      expiresAt = now + emailSessionTtl;
    const data: AuthData = {
      address: null,
      principalId: account.principalId,
      servicePrincipals: account.servicePrincipals,
      authMethod: "email",
      purpose: "email-session",
      emailSignInKey: account.emailLogin.emailKey,
      emailSignInRevision: account.emailLogin.revision,
      authenticatedAt: now,
      expiresAt,
      authorizationExpiresAt: expiresAt,
      walletRevision: 0,
    };
    await replaceSession(request, env, token, data);
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      cookie(SESSION_COOKIE, token, emailSessionTtl / 1000),
    );
    headers.append("Set-Cookie", emailSignInChallengeCookieClear());
    const session = sessionData(data, token);
    await redeemPendingEmailInvitations(
      env,
      session,
      account.emailLogin.emailKey,
    );
    return json(sessionView(session), 200, headers);
  }
  if (url.pathname === "/chains" && request.method === "GET")
    return json({ networks: chatNetworkAvailability() });
  if (url.pathname === "/feedback/status" && request.method === "GET") {
    const session = await optionalSession(request, env, deps);
    if (session)
      requireExpectedPrincipal(
        { expectedPrincipalId: url.searchParams.get("expectedPrincipalId") },
        session,
      );
    const available = feedbackAvailable(env as FeedbackEnv),
      isAdmin =
        !!session &&
        feedbackIsAdmin(
          env as FeedbackEnv,
          session.principalId,
          sessionPrincipals(session),
        );
    const stats =
      isAdmin && available
        ? await feedbackRequest(env as FeedbackEnv, {
            op: "stats",
            principalId: session!.principalId,
            servicePrincipals: sessionPrincipals(session),
          })
        : null;
    if (stats && !stats.ok) return stats;
    return json({
      available,
      emailRequired: true,
      isAdmin,
      ...(stats ? await stats.json<{ failedNotifications: number }>() : {}),
    });
  }
  if (["/auth/profile", "/profiles"].includes(url.pathname))
    return (
      (await memberProfileRoute(request, env, {
        session: () =>
          currentSession(request, env, false, deps.verifySessionAuthority),
        guard: requireExpectedPrincipal,
      })) ?? json({ error: "Not found." }, 404)
    );
  {
    const linked = await linkedWalletsRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
      guard: requireExpectedPrincipal,
      verifyWallet: deps.verifyWallet,
    });
    if (linked) return linked;
  }
  {
    const removed = await emailRemoveRoute(request, env, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
      guard: requireExpectedPrincipal,
    });
    if (removed) return removed;
  } // POST /auth/email/remove drops the alert address
  {
    const costs = await operatorCostsRoute(
      request,
      env as OperatorAdminEnv & CostMetricsEnv,
      {
        session: () =>
          currentSession(request, env, false, deps.verifySessionAuthority),
      },
    );
    if (costs) return costs;
  }
  {
    const funnel = await operatorFunnelRoute(
      request,
      env as OperatorAdminEnv & FunnelEnv,
      {
        session: () =>
          currentSession(request, env, false, deps.verifySessionAuthority),
      },
    );
    if (funnel) return funnel;
  }
  {
    const health = await operatorHealthRoute(request, env as OpsHealthEnv, {
      session: () =>
        currentSession(request, env, false, deps.verifySessionAuthority),
      verifiedChain: deps.verifiedChain,
    });
    if (health) return health;
  }
  if (url.pathname === "/auth/account" && request.method === "GET") {
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    requireExpectedPrincipal(
      { expectedPrincipalId: url.searchParams.get("expectedPrincipalId") },
      session,
    );
    const account = await identityRequest(env, {
      op: "read",
      principalId: session.principalId,
    });
    const emailVerified = !!account.email && !!account.emailVerifiedAt;
    return json({
      principalId: session.principalId,
      // The alert address: support alerts go there; it never signs in.
      emailVerified,
      emailMasked: emailVerified ? maskEmail(account.email) : null,
      alertEmailAvailable: emailAlertsAvailable(env as EmailEnv),
      wallet: session.address,
      wallets: session.wallets?.length ?? 0,
      methods: await accountMethodsView(env, {
        principalId: session.principalId,
        address: session.solanaAddress ?? session.address,
      }),
    });
  }
  if (
    ["/auth/email/link/start", "/auth/email/link/verify"].includes(
      url.pathname,
    ) &&
    request.method === "POST"
  ) {
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    const body = await readJson(request.clone(), 1024);
    requireExpectedPrincipal(body, session);
    const link = {
      principalId: session.principalId,
      sessionKey: await sessionCacheKey(session.token),
      revision: session.walletRevision,
    };
    if (url.pathname.endsWith("/start"))
      return startEmailLink(request, env as EmailEnv, link);
    // The code sets the account's alert address; the session is unchanged.
    return json(await verifyEmailLink(request, env as EmailEnv, link), 200, {
      "Set-Cookie": emailChallengeCookieClear(),
    });
  }
  if (
    url.pathname.startsWith("/feedback/") &&
    ["GET", "POST"].includes(request.method)
  ) {
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    const body =
      request.method === "POST"
        ? await readJson(request, 12_000)
        : { expectedPrincipalId: url.searchParams.get("expectedPrincipalId") };
    requireExpectedPrincipal(body, session);
    const admin = feedbackIsAdmin(
      env as FeedbackEnv,
      session.principalId,
      sessionPrincipals(session),
    );
    const account = await identityRequest(env, {
      op: "read",
      principalId: session.principalId,
    });
    if (!admin && (!account.email || !account.emailVerifiedAt))
      throw new HttpError(403, "Verify your email to send and read feedback.");
    const common = {
      principalId: session.principalId,
      servicePrincipals: sessionPrincipals(session),
    };
    if (url.pathname === "/feedback/tickets" && request.method === "GET")
      return feedbackRequest(env as FeedbackEnv, {
        ...common,
        op: "list",
        cursor: url.searchParams.get("cursor"),
      });
    if (url.pathname === "/feedback/admin/tickets" && request.method === "GET")
      return feedbackRequest(env as FeedbackEnv, {
        ...common,
        op: "admin-list",
        status: url.searchParams.get("status") ?? "open",
        cursor: url.searchParams.get("cursor"),
      });
    if (url.pathname === "/feedback/tickets" && request.method === "POST") {
      if (!account.email || !account.emailVerifiedAt)
        throw new HttpError(403, "Verify your email before starting feedback.");
      return feedbackRequest(env as FeedbackEnv, {
        ...common,
        op: "create",
        id: body.id,
        subject: body.subject,
        text: body.text,
        verifiedEmail: account.email,
      });
    }
    const target =
      /^\/feedback\/tickets\/([0-9a-f-]{36})(?:\/(messages|status))?$/.exec(
        url.pathname,
      );
    if (target && request.method === "GET" && !target[2])
      return feedbackRequest(env as FeedbackEnv, {
        ...common,
        op: "read",
        ticketId: target[1],
        before: url.searchParams.get("before"),
      });
    if (target && request.method === "POST" && target[2] === "messages")
      return feedbackRequest(env as FeedbackEnv, {
        ...common,
        op: "message",
        ticketId: target[1],
        id: body.id,
        text: body.text,
      });
    if (target && request.method === "POST" && target[2] === "status")
      return feedbackRequest(env as FeedbackEnv, {
        ...common,
        op: "status",
        ticketId: target[1],
        status: body.status,
      });
    throw new HttpError(404, "Not found.");
  }
  // Sign in with a Solana wallet: the worker writes the Sign In With Solana
  // text, the wallet signs it, and the Ed25519 signature opens a session on
  // the account the public key belongs to (a new account on first use).
  if (url.pathname === "/auth/solana/nonce" && request.method === "POST") {
    const body = await readJson(request);
    const wallet = solanaAddress(body.address);
    const connect =
      body.connectCode === undefined ? null : connectCode(body.connectCode);
    if (connect) requireConnectEnabled(env);
    const connection = connect
      ? await connectRequest(env, { op: "read", code: connect })
      : null;
    const nonce = randomToken();
    const now = Date.now();
    const expiresAt = Math.min(
      now + NONCE_TTL,
      connection?.expiresAt ?? Infinity,
    );
    const message = createSolanaSignInMessage({
      domain: cfg.origin.host,
      address: wallet,
      uri: cfg.origin.origin,
      nonce,
      statement: connect
        ? "Connect this app to your Templ workspace."
        : "Sign in to your Templ chat.",
      ...(connect ? { resources: [connectUrl(env, connect)] } : {}),
      issuedAt: new Date(now),
      expirationTime: new Date(expiresAt),
    });
    await saveRecord(env, "nonce", nonce, {
      address: null,
      solanaAddress: wallet,
      purpose: "solana-login",
      ...(connect ? { connectCode: connect } : {}),
      message,
      nonce,
      expiresAt,
    });
    return json({ message, expiresAt }, 200, {
      "Set-Cookie": cookie(NONCE_COOKIE, nonce, NONCE_TTL / 1000),
    });
  }
  if (url.pathname === "/auth/solana/verify" && request.method === "POST") {
    const body = await readJson(request);
    const signature = decodeSolanaSignature(body.signature);
    if (
      typeof body.message !== "string" ||
      body.message.length > 4096 ||
      !signature
    )
      throw new HttpError(400, "Invalid signed message.");
    const nonce = readCookie(request, NONCE_COOKIE);
    if (!nonce) throw new HttpError(401, "Request a new sign-in challenge.");
    const consumed = await (
      await record(env, "nonce", nonce)
    ).fetch(internalPost("/consume"));
    if (consumed.status !== 401 && !consumed.ok)
      throw new HttpError(
        503,
        "Sign-in is temporarily unavailable. Please try again.",
      );
    if (!consumed.ok)
      throw new HttpError(401, "Sign-in challenge expired or already used.");
    const challenge = await consumed.json<AuthData>();
    if (
      challenge.purpose !== "solana-login" ||
      !challenge.solanaAddress ||
      body.message !== challenge.message ||
      challenge.nonce !== nonce ||
      !(await verifySolanaSignature(
        body.message,
        signature,
        challenge.solanaAddress,
      ))
    )
      throw new HttpError(
        401,
        "Signature does not match the sign-in challenge.",
      );
    const { identity } = (await identityRequest(env, {
      op: "solana-login",
      address: challenge.solanaAddress,
    })) as unknown as { identity: AccountIdentity; created: boolean };
    const token = randomToken();
    const expiresAt = Date.now() + SESSION_TTL;
    const data: AuthData = {
      address: null,
      solanaAddress: challenge.solanaAddress,
      principalId: identity.principalId,
      servicePrincipals: identity.servicePrincipals,
      authMethod: "solana",
      authenticatedAt: Date.now(),
      expiresAt,
      authorizationExpiresAt: expiresAt,
      walletRevision: 0,
      solanaAuthorization: {
        message: body.message,
        signature: String(body.signature),
      },
    };
    if (challenge.connectCode) {
      requireConnectEnabled(env);
      await connectRequest(env, {
        op: "claim",
        code: challenge.connectCode,
        principalId: data.principalId,
        sessionHash: await sessionCacheKey(token),
      });
      data.connectCode = challenge.connectCode;
    }
    await replaceSession(request, env, token, data);
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      cookie(SESSION_COOKIE, token, SESSION_TTL / 1000),
    );
    headers.append("Set-Cookie", cookie(NONCE_COOKIE, "", 0));
    return json(sessionView(sessionData(data, token)), 200, headers);
  }
  // Solana wallets on an existing account: add one with a fresh proof bound
  // to this account and session, or remove one (keeping a way to sign in).
  if (
    [
      "/auth/solana/attach/nonce",
      "/auth/solana/attach/verify",
      "/auth/solana/remove",
    ].includes(url.pathname) &&
    request.method === "POST"
  ) {
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    const body = await readJson(request);
    requireExpectedPrincipal(body, session);
    const sessionKey = await sessionCacheKey(session.token);
    if (url.pathname === "/auth/solana/attach/nonce") {
      const wallet = solanaAddress(body.address);
      const nonce = randomToken();
      const now = Date.now();
      const expiresAt = Math.min(now + NONCE_TTL, session.expiresAt);
      const message = createSolanaSignInMessage({
        domain: cfg.origin.host,
        address: wallet,
        uri: cfg.origin.origin,
        nonce,
        statement: "Add this Solana wallet to your Templ account.",
        resources: [
          `urn:templ:principal:${session.principalId}`,
          `urn:templ:session:${sessionKey}`,
        ],
        issuedAt: new Date(now),
        expirationTime: new Date(expiresAt),
      });
      await saveRecord(env, "nonce", nonce, {
        address: null,
        solanaAddress: wallet,
        principalId: session.principalId,
        purpose: "solana-attach",
        sessionKey,
        message,
        nonce,
        expiresAt,
      });
      return json({ message, expiresAt }, 200, {
        "Set-Cookie": cookie(
          NONCE_COOKIE,
          nonce,
          Math.floor((expiresAt - now) / 1000),
        ),
      });
    }
    if (url.pathname === "/auth/solana/attach/verify") {
      const signature = decodeSolanaSignature(body.signature);
      if (
        typeof body.message !== "string" ||
        body.message.length > 4096 ||
        !signature
      )
        throw new HttpError(400, "Invalid signed message.");
      const nonce = readCookie(request, NONCE_COOKIE);
      if (!nonce) throw new HttpError(401, "Request a new wallet challenge.");
      const consumed = await (
        await record(env, "nonce", nonce)
      ).fetch(internalPost("/consume"));
      if (consumed.status !== 401 && !consumed.ok)
        throw new HttpError(503, "Wallet linking is temporarily unavailable.");
      if (!consumed.ok)
        throw new HttpError(401, "Wallet challenge expired or already used.");
      const challenge = await consumed.json<AuthData>();
      if (
        challenge.purpose !== "solana-attach" ||
        !challenge.solanaAddress ||
        challenge.principalId !== session.principalId ||
        challenge.sessionKey !== sessionKey ||
        body.message !== challenge.message ||
        challenge.nonce !== nonce ||
        !(await verifySolanaSignature(
          body.message,
          signature,
          challenge.solanaAddress,
        ))
      )
        throw new HttpError(401, "Signature does not match the challenge.");
      await identityRequest(env, {
        op: "solana-link",
        principalId: session.principalId,
        address: challenge.solanaAddress,
      });
      return json(
        {
          ok: true,
          address: challenge.solanaAddress,
          methods: await accountMethodsView(env, {
            principalId: session.principalId,
            address: session.solanaAddress ?? session.address,
          }),
        },
        200,
        { "Set-Cookie": cookie(NONCE_COOKIE, "", 0) },
      );
    }
    await identityRequest(env, {
      op: "solana-remove",
      principalId: session.principalId,
      address: solanaAddress(body.address),
    });
    return json({
      ok: true,
      methods: await accountMethodsView(env, {
        principalId: session.principalId,
        address: session.solanaAddress ?? session.address,
      }),
    });
  }
  if (url.pathname === "/auth/nonce" && request.method === "POST") {
    const body = await readJson(request);
    const wallet = address(body.address);
    const chainId = walletAuthChain(body.chainId);
    const connect =
      body.connectCode === undefined ? null : connectCode(body.connectCode);
    if (connect) requireConnectEnabled(env);
    const connection = connect
      ? await connectRequest(env, { op: "read", code: connect })
      : null;
    const nonce = randomToken();
    const now = Date.now();
    const expiresAt = Math.min(
      now + NONCE_TTL,
      connection?.expiresAt ?? Infinity,
    );
    const message = createSiweMessage({
      address: wallet,
      chainId,
      domain: cfg.origin.host,
      scheme: "https",
      uri: cfg.origin.origin,
      version: "1",
      nonce,
      statement: connect
        ? "Connect this app to your Templ workspace."
        : "Sign in to your Templ chat.",
      ...(connect ? { resources: [connectUrl(env, connect)] } : {}),
      issuedAt: new Date(now),
      expirationTime: new Date(expiresAt),
    });
    await saveRecord(env, "nonce", nonce, {
      address: wallet,
      ...(connect ? { connectCode: connect } : {}),
      message,
      nonce,
      expiresAt,
    });
    return json({ message, expiresAt }, 200, {
      "Set-Cookie": cookie(NONCE_COOKIE, nonce, NONCE_TTL / 1000),
    });
  }
  if (url.pathname === "/auth/verify" && request.method === "POST") {
    const body = await readJson(request);
    if (
      typeof body.message !== "string" ||
      typeof body.signature !== "string" ||
      !isHex(body.signature) ||
      body.signature.length > 8_194
    )
      throw new HttpError(400, "Invalid signed message.");
    const nonce = readCookie(request, NONCE_COOKIE);
    if (!nonce) throw new HttpError(401, "Request a new sign-in challenge.");
    const consumed = await (
      await record(env, "nonce", nonce)
    ).fetch(internalPost("/consume"));
    if (consumed.status !== 401 && !consumed.ok)
      throw new HttpError(
        503,
        "Sign-in is temporarily unavailable. Please try again.",
      );
    if (!consumed.ok)
      throw new HttpError(401, "Sign-in challenge expired or already used.");
    const challenge = await consumed.json<AuthData>();
    // Exact equality enforces server-chosen chain, origin, address, URI and all times.
    if (
      challenge.purpose !== undefined ||
      body.message !== challenge.message ||
      challenge.nonce !== nonce ||
      !(await deps.verifyWallet(
        env,
        body.message,
        body.signature as Hex,
        address(challenge.address),
        nonce,
      ))
    ) {
      throw new HttpError(
        401,
        "Signature does not match the sign-in challenge.",
      );
    }
    const account = await identityRequest(env, {
      op: "wallet-login",
      wallet: challenge.address,
      ...(await provenWalletFacts(
        body.message,
        body.signature as Hex,
        address(challenge.address),
      )),
    });
    const token = randomToken();
    const expiresAt = Date.now() + SESSION_TTL;
    const data: AuthData = {
      address: challenge.address,
      principalId: account.principalId,
      servicePrincipals: account.servicePrincipals,
      authMethod: "wallet",
      authenticatedAt: Date.now(),
      expiresAt,
      authorizationExpiresAt: expiresAt,
      walletAuthorizationExpiresAt: expiresAt,
      walletRevision: 0,
      authorization: {
        message: body.message,
        signature: body.signature as Hex,
      },
    };
    if (challenge.connectCode) {
      requireConnectEnabled(env);
      await connectRequest(env, {
        op: "claim",
        code: challenge.connectCode,
        principalId: data.principalId,
        sessionHash: await sessionCacheKey(token),
      });
      data.connectCode = challenge.connectCode;
    }
    await replaceSession(request, env, token, data);
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      cookie(SESSION_COOKIE, token, SESSION_TTL / 1000),
    );
    headers.append("Set-Cookie", cookie(NONCE_COOKIE, "", 0));
    return json(sessionView(sessionData(data, token)), 200, headers);
  }
  if (url.pathname === "/auth/session" && request.method === "GET") {
    const session = await currentSession(
      request,
      env,
      true,
      deps.verifySessionAuthority,
    );
    await redeemPendingEmailInvitations(env, session);
    return json(sessionView(session), 200, {
      // Also synchronize retries after a renewal response was lost in transit.
      "Set-Cookie": cookie(
        SESSION_COOKIE,
        session.token,
        Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
      ),
    });
  }
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await revokeSession(env, token);
    return json({ ok: true }, 200, {
      "Set-Cookie": cookie(SESSION_COOKIE, "", 0),
    });
  }
  const availability = /^\/slugs\/([^/]+)\/availability$/.exec(url.pathname);
  if (availability && request.method === "GET")
    return nativeCatalog(env, { op: "name-availability", slug: decodeURIComponent(availability[1]) });
  const slugRoute = /^\/slugs\/([^/]+)$/.exec(url.pathname);
  if (slugRoute && request.method === "GET") {
    return nativeCatalog(env, {
      op: "resolve-slug",
      slug: decodeURIComponent(slugRoute[1]),
    });
  }
  if (url.pathname === "/rooms" && request.method === "POST") {
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    if (session.authMethod === "email")
      throw new HttpError(403, "Sign in with a wallet to create a workspace.");
    const body = await readJson(request, 24_000);
    requireExpectedPrincipal(body, session);
    const id = nativeRoomId(body.id);
    requireTrialWorkspaceCreation(body, env, session);
    const approvalExpiresAt = (env as ConnectDeadlineEnv)[CONNECT_DEADLINE];
    requireConnectDeadline(approvalExpiresAt);

    await requireSafetyAccess(
      env as SafetyEnv,
      `room:${id}`,
      session.principalId,
      sessionPrincipals(session),
    );
    const normalized = nativeCreation(
      body,
      session.principalId,
      siteOrigins(env).communityOrigin,
    );
    const imageId = normalized.room.image
      ? profileMediaHash(
          normalized.room.image,
          siteOrigins(env).communityOrigin,
        )
      : null;
    if (imageId && !(await mediaOwnedBy(env, session.principalId, imageId)))
      throw new HttpError(400, "Upload a chat image first.");
    const reserved = await nativeCatalog(env, {
      op: "reserve",
      approvalExpiresAt,
      id,
      input: body,
      principalId: session.principalId,
      servicePrincipals: sessionPrincipals(session),
    });
    if (!reserved.ok) return reserved;
    const creation = await reserved.json<NativeCreation>();
    const referenceChange = imageId
      ? await setMediaReference(env, session.principalId, `room:${id}`, imageId)
      : null;
    let created: Response;
    try {
      created = await nativeStub(env, id).fetch(
        internalPost("/private/native/create", {
          creation,
          approvalExpiresAt,
          ...(JOURNEY_ID.test(request.headers.get(ONBOARDING_HEADER) ?? "") &&
            !onboardingOptOut(request)
            ? {
                onboarding: {
                  journey: request.headers.get(ONBOARDING_HEADER),
                  traffic: onboardingTraffic(
                    env,
                    session,
                    !!creation.trialOperator,
                  ),
                },
              }
            : {}),
        }),
      );
    } catch (error) {
      if (imageId && referenceChange)
        await restoreMediaReference(
          env,
          session.principalId,
          `room:${id}`,
          imageId,
          referenceChange.previous,
          referenceChange.revision,
        ).catch(() => undefined);
      throw error;
    }
    if (!created.ok) {
      if (imageId && referenceChange)
        await restoreMediaReference(
          env,
          session.principalId,
          `room:${id}`,
          imageId,
          referenceChange.previous,
          referenceChange.revision,
        ).catch(() => undefined);
      return created;
    }
    const record = await created.json<NativeRoomRecord>();
    await indexNative(env, record);
    let followed = true;
    if (env.ROOM_SUBSCRIPTIONS) {
      const list = linkedSubscriptions(env, session);
      const response = await list.fetch(
        internalPost("/subscriptions", {
          roomId: id,
          room: record.room,
          subscribed: true,
        }),
      );
      // A full sidebar must not turn a successful creation into an endless retry.
      if (!response.ok && response.status !== 409)
        throw new HttpError(
          503,
          "Chat created. Retry to add it to your sidebar.",
        );
      followed = response.ok;
    }
    // The creation answer matches GET /rooms/:id.
    return json({ ...publicNativeRoom(record.room), followed }, created.status);
  }
  const nativeRoute = /^\/rooms\/([0-9a-f-]+)(\/.*)?$/.exec(url.pathname);
  if (
    nativeRoute &&
    NATIVE_UUID.test(nativeRoute[1]) &&
    ["GET", "POST"].includes(request.method)
  ) {
    const id = nativeRoomId(nativeRoute[1]);
    const path = nativeRoute[2] ?? "";
    if (
      path.startsWith("/product/card/") &&
      request.headers.has("Authorization")
    )
      return json(
        { error: "Use your wallet sign-in to manage card billing." },
        403,
      );
    // Private room handlers trust the Worker-to-DO binding, not a browser
    // session. Never forward a public room URL into that namespace.
    if (path === "/private" || path.startsWith("/private/"))
      return json({ error: "Not found." }, 404);
    // A widget session reaches the member's conversation routes and nothing
    // else here: never product, checkout, roles or settings.
    if (
      (env as WidgetEnv)[WIDGET_SCOPE] &&
      !/^\/conversations(?:\/|$)/.test(path)
    )
      return json({ error: "Not found." }, 404);
    // The room read starts with the body. A room route's JSON body is read
    // now, once, within its size cap; a parse error is kept and thrown where
    // the route reads the body, after the session check. The session read
    // and any hinted identity and safety reads start together once the body
    // has arrived, so a sign-out or suspension that completes while the body
    // is still uploading applies to this request. A POST whose route reads
    // its body later starts none of them early. Every check still runs
    // below, in order.
    // Bounded imports and scoped install forwarding.
    // Current session and room checks remain authoritative.
    const earlyBody =
      request.method === "POST" &&
      ORDINARY_ROUTE.test(path) &&
      !unsupportedRoomRoute(path, request.method) &&
      (request.headers.get("Content-Type") ?? "")
        .toLowerCase()
        .startsWith("application/json") &&
      !isSupportUpload(path, request)
        ? started(readSupportJson(request, path))
        : null;
    const room = started(nativeRecord(env, id));
    if (earlyBody) await earlyBody.catch(() => undefined);
    if (request.method === "GET" || earlyBody) {
      const hint = requestPrefetch(env).session
        ? undefined
        : await requestHint(request, earlyBody);
      prefetchSession(request, env, `room:${id}`, hint);
    }
    const context = await room;
    if (context.features)
      env = workspaceFeatureEnvFromValues(
        env,
        context.features,
        context.record.room.id,
      );
    // A workspace set to be deleted answers 410 on every route.
    refuseClosedWorkspace(context.record, path, env as never);
    const scopedNative = { ...env, [NATIVE_CONTEXT]: context } as NativeEnv;
    // Manager-owned install checks.
    // The settings transaction hashes the single-use token.
    if (
      path === "/conversations/install-check" &&
      (env as WidgetEnv)[WIDGET_SCOPE]
    ) {
      requireInstallCheck(env);
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      const body = await (earlyBody ?? readJson(request));
      requireExpectedPrincipal(body, session);
      await requireSafetyAccess(
        scopedNative as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      return widgetInstallCheck(
        env,
        {
          workspace: id,
          origin: (env as WidgetEnv)[WIDGET_SCOPE]!.origin,
          member: session.principalId,
          session: session.token,
          body,
        },
        (data) => widgetConfig(env, id, data as never),
      );
    }
    if (path === "/widget/install-check") {
      requireInstallCheck(env);
      if (!["GET", "POST"].includes(request.method))
        throw new HttpError(405, "Method not allowed.");
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      if (!(await nativeWorkspaceAdmin(scopedNative as Env, context, session)))
        throw new HttpError(
          403,
          "Only workspace admins can check the install.",
        );
      await requireSafetyAccess(
        scopedNative as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      if (request.method === "GET")
        return widgetConfig(env, id, { op: "install-check-read" } as never);
      const body = await (earlyBody ?? readJson(request));
      requireExpectedPrincipal(body, session);
      const managerSession = await sessionCacheKey(session.token);
      const fixture =
        body.fixture === undefined
          ? undefined
          : await prepareInstallFixture(
              env,
              {
                workspace: id,
                origin: typeof body.origin === "string" ? body.origin : "",
                managerSession,
                fixture: body.fixture,
              },
              (data) => widgetConfig(env, id, data as never),
            );
      if (fixture && installFixtureWorkspace(fixture) !== id)
        throw new HttpError(404, "Install check not found.");
      return widgetConfig(env, id, {
        op: "install-check-create",
        workspace: id,
        origin: body.origin,
        managerSession,
        ...(fixture ? { fixture } : {}),
      } as never);
    }
    if (path === "/widget") {
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      if (!(await nativeWorkspaceAdmin(scopedNative as Env, context, session)))
        throw new HttpError(
          403,
          "Only workspace admins can change widget settings.",
        );
      await requireSafetyAccess(
        scopedNative as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      if (request.method === "POST") {
        const body = await readJson(request);
        requireExpectedPrincipal(body, session);
        const authenticatedAt = requireWorkspaceAdminAuth(
          session,
          sessionPrincipals(session).includes(context.record.room.manager),
          body.confirmed,
        );
        if (context.record.room.visibility !== "public")
          throw new HttpError(
            400,
            "Widgets need a public workspace. Support cases remain private.",
          );
        if (
          body.origins === undefined &&
          body.minimumLevel === undefined &&
          !namesWidgetSessionSetting(body)
        )
          throw new HttpError(400, "Choose widget settings to save.");
        // Remembered sign-in, sign-out-all, the visitor check
        // and development origins, with Templ's own switches.
        const sessionSettings = widgetSessionSettings(
          body,
          env as WidgetSessionEnv,
        );
        return withWidgetSessionOptions(
          env as WidgetSessionEnv,
          await relayWidgetAudit(
            env,
            id,
            context.room,
            await widgetConfig(env, id, {
              op: "save",
              approvalExpiresAt: (env as ConnectDeadlineEnv)[CONNECT_DEADLINE],
              initializeOnly: body.initializeOnly === true && body.hostedPage === true,
              ...(body.origins === undefined
                ? {}
                : {
                    origins: widgetOrigins(
                      body.origins,
                      sessionSettings.loopback,
                    ),
                  }),
              ...(body.minimumLevel === undefined
                ? {}
                : { minimumLevel: widgetMinimumLevel(body.minimumLevel) }),
              ...sessionSettings,
              actor: session.principalId,
              authenticatedAt,
            }),
          ),
        );
      }
      return withWidgetSessionOptions(
        env as WidgetSessionEnv,
        await relayWidgetAudit(
          env,
          id,
          context.room,
          await widgetConfig(env, id, { op: "open" }),
        ),
      );
    }
    if (path === "/team-invites" || path.startsWith("/team-invites/")) {
      await scopeNativeBudget(env, context);
      return teamInviteRoute(
        request,
        scopedNative,
        deps,
        context.room,
        path,
        context.record.room.manager,
      );
    }
    if (path.startsWith("/invites"))
      return inviteRoute(
        request,
        scopedNative,
        deps,
        context.room,
        path,
        context.record.room.manager,
      );
    if ((!path || path === "/invite") && request.method === "GET") {
      const session = await optionalSession(request, scopedNative, deps);
      // Safety and membership are read together and judged in their usual
      // order; the room is returned only after both pass.
      const safety = started(
        requireSafetyAccess(
          scopedNative as SafetyEnv,
          `room:${id}`,
          session?.principalId,
          sessionPrincipals(session),
        ),
      );
      const membership = started(
        requirePrivateMembership(
          context.room,
          privacyHeaders(scopedNative, session, context.record.room.manager),
        ),
      );
      await safety;
      await membership;
      if (!path) {
        // An unsigned visitor needs only display metadata. A signed reader's
        // current room permissions, never membership or following, decide
        // whether ownership identifiers may leave the service.
        const metadata = session
          ? await nativeWorkspaceMetadata(scopedNative, context, session)
          : workspaceMetadataView(
              context.record.room,
              {
                viewer: {
                  principalId: null,
                  wallet: null,
                  isManager: false,
                  permissions: [],
                  roleIds: [],
                  mutedUntil: null,
                },
              },
              [],
            );
        return json(metadata);
      }
    }
    if (path === "/invite" && request.method === "GET") {
      if (context.record.room.visibility === "private")
        throw new HttpError(409, "Create an invitation for this private chat.");
      return json({
        inviteUrl: context.record.room.slug
          ? `${cfg.origin.origin}/${context.record.room.slug}`
          : `${cfg.origin.origin}/inbox/${id}`,
        roomId: id,
      });
    }
    if (path === "/slug" && request.method === "GET") {
      const session = await currentSession(request, env, false, deps.verifySessionAuthority);
      if (!sessionPrincipals(session).includes(context.record.room.manager))
        throw new HttpError(403, "Only the workspace owner can read a reserved name.");
      await requireSafetyAccess(scopedNative as SafetyEnv, `room:${id}`, session.principalId, sessionPrincipals(session));
      return nativeCatalog(env, { op: "read-name-hold", id });
    }
    if (path === "/slug" && request.method === "POST") {
      await scopeNativeBudget(env, context);
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      const body = await readJson(request);
      requireExpectedPrincipal(body, session);
      await requireSafetyAccess(
        scopedNative as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      if (!sessionPrincipals(session).includes(context.record.room.manager))
        throw new HttpError(403, "Only the workspace owner can change its name link.");
      const guestName = body.hostedName === true;
      if (guestName && context.record.room.visibility !== "public")
        throw new HttpError(400, "A hosted chat link needs a public workspace.");
      const nextSlug = guestName ? hostedName(body.slug) : body.slug === null ? null : nativeSlug(body.slug);
      if (guestName && body.reserveOnly === true)
        return nativeCatalog(env, { op: "hold-name", id, slug: nextSlug, manager: context.record.room.manager });
      let created = false;
      if (nextSlug) {
        const claimed = await nativeCatalog(env, {
          op: "claim-slug",
          id,
          slug: nextSlug,
          manager: context.record.room.manager,
        });
        if (!claimed.ok) return claimed;
        created = (await claimed.json<{ created?: boolean }>()).created === true;
      }
      const result = await context.room.fetch(
        internalPost("/private/native/slug", {
          principalId: session.principalId,
          servicePrincipals: sessionPrincipals(session),
          slug: nextSlug,
          hostedName: guestName,
        }),
      );
      if (!result.ok) {
        if (nextSlug && created && result.status < 500)
          await nativeCatalog(env, {
            op: "release-slug",
            id,
            slug: nextSlug,
          });
        return result;
      }
      const updated = await result.json<NativeRoomRecord>();
      await indexNative(env, updated);
      return json(publicNativeRoom(updated.room));
    }
    if (path === "/profile" && request.method === "POST") {
      // The room object checks current Admin access before changing metadata.
      // The catalog projection follows the committed revision.
      await scopeNativeBudget(env, context);
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      const body = await readJson(request);
      requireExpectedPrincipal(body, session);
      const contact = body.contactRole;
      if (contact !== undefined && !isSupportContactRole(contact))
        throw new HttpError(400, "Choose the founder or the AI assistant.");
      const currentProfiles = context.record.supportProfiles;
      if (isSupportContactRole(contact)) {
        if (!(await nativeWorkspaceAdmin(scopedNative as Env, context, session)))
          throw new HttpError(403, "Only workspace admins can edit support profiles.");
        if (body.profileRevision !== (currentProfiles?.revision ?? 0))
          throw new HttpError(409, "The support profiles changed. Reload before saving.");
      }
      if (!sessionPrincipals(session).includes(context.record.room.manager))
        requireWorkspaceAdminAuth(session, false, true);
      await requireSafetyAccess(
        scopedNative as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      const requestedImageId =
        body.image === undefined
          ? undefined
          : body.image === null
            ? null
            : profileMediaHash(body.image, siteOrigins(env).communityOrigin);
      if (body.image !== undefined && body.image !== null && !requestedImageId)
        throw new HttpError(400, "Choose a valid workspace image.");
      if (
        requestedImageId &&
        !(await mediaOwnedBy(env, session.principalId, requestedImageId))
      )
        throw new HttpError(400, "Upload a workspace image first.");
      const mediaReference = isSupportContactRole(contact) ? `room:${id}:${contact}` : `room:${id}`;
      const previousImage = isSupportContactRole(contact)
        ? currentProfiles?.[contact].image
        : context.record.room.image;
      const previousImageId = previousImage
        ? profileMediaHash(
            previousImage,
            siteOrigins(env).communityOrigin,
          )
        : null;
      const referenceChange =
        requestedImageId !== undefined
          ? await setMediaReference(
              env,
              session.principalId,
              mediaReference,
              requestedImageId,
            )
          : null;
      let releasedPrevious: Awaited<ReturnType<typeof releaseMediaReference>> =
        null;
      try {
        if (
          requestedImageId !== undefined &&
          previousImageId &&
          previousImageId !== requestedImageId
        )
          releasedPrevious = await releaseMediaReference(
            env,
            previousImageId,
            mediaReference,
          );
      } catch (error) {
        if (referenceChange)
          await restoreMediaReference(
            env,
            session.principalId,
            mediaReference,
            requestedImageId!,
            referenceChange.previous,
            referenceChange.revision,
          ).catch(() => undefined);
        throw error;
      }
      const restoreProvisionalReferences = async () => {
        const restored = await Promise.allSettled([
          ...(referenceChange
            ? [
                restoreMediaReference(
                  env,
                  session.principalId,
                  mediaReference,
                  requestedImageId!,
                  referenceChange.previous,
                  referenceChange.revision,
                ),
              ]
            : []),
          ...(releasedPrevious
            ? [
                restoreMediaReference(
                  env,
                  releasedPrevious.owner,
                  mediaReference,
                  null,
                  releasedPrevious.previous,
                  releasedPrevious.revision,
                ),
              ]
            : []),
        ]);
        if (restored.some((result) => result.status === "rejected"))
          throw new HttpError(503, "Image storage is unavailable.");
      };
      let result: Response;
      try {
        result = await context.room.fetch(
          internalPost("/private/native/profile", {
            principalId: session.principalId,
            servicePrincipals: sessionPrincipals(session),
            ...(isSupportContactRole(contact) ? {
              contactRole: contact, profileRevision: body.profileRevision,
              assistantEnabled: body.assistantEnabled,
              ...(contact === "founder" && body.teamLink !== undefined ? { teamLink: body.teamLink } : {}),
            } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.image !== undefined ? { image: body.image } : {}),
          }),
        );
      } catch (error) {
        await restoreProvisionalReferences().catch(() => undefined);
        throw error;
      }
      if (!result.ok) {
        await restoreProvisionalReferences();
        return result;
      }
      if (isSupportContactRole(contact)) return result;
      const updated = await result.json<NativeRoomRecord>();
      await indexNative(env, updated);
      return json(publicNativeRoom(updated.room));
    }
    if (
      ["/manager", "/manager/accept"].includes(path) &&
      request.method === "POST"
    ) {
      await scopeNativeBudget(env, context);
      const session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
      const body = await readJson(request);
      requireExpectedPrincipal(body, session);
      await requireSafetyAccess(
        scopedNative as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      const authenticatedAt = requireWalletAuth(session, body.confirmed);
      const nextIdentity =
        path === "/manager" && body.next !== null
          ? await identityRequest(env, {
              op: "read",
              principalId: principal(body.next),
            })
          : null;
      const result = await context.room.fetch(
        internalPost(
          path === "/manager"
            ? "/private/native/manager"
            : "/private/native/accept-manager",
          {
            principalId: session.principalId,
            servicePrincipals: sessionPrincipals(session),
            next: body.next,
            ...(nextIdentity
              ? { nextServicePrincipals: sessionPrincipals(nextIdentity) }
              : {}),
            authenticatedAt,
            authMethod: session.authMethod,
            confirmed: true,
          },
        ),
      );
      if (!result.ok) return result;
      const updated = await result.json<NativeRoomRecord>();
      await indexNative(env, updated);
      return json(publicNativeRoom(updated.room));
    }
    if (
      !ORDINARY_ROUTE.test(path) ||
      unsupportedRoomRoute(path, request.method)
    )
      return json({ error: "Not found." }, 404);
    const ordinary =
      request.method === "GET" &&
      (path === "/channels" ||
        path === "/bots" || // Public bot list reads like /channels
        path === "/events" ||
        path === "/realtime/ticket" || // Event catch-up and realtime tickets read like /channels
        path === "/search" || // Search reads with the same access headers; the room requires sign-in
        path === "/conversations/status"); // The status answers anonymous readers with canAsk false
    let session: Awaited<ReturnType<typeof currentSession>> | null = null;
    let unavailable = false;
    await scopeNativeBudget(env, context);
    try {
      session = await currentSession(
        request,
        env,
        false,
        deps.verifySessionAuthority,
      );
    } catch (error) {
      if (
        !(
          ordinary &&
          request.method === "GET" &&
          error instanceof HttpError &&
          [401, 503].includes(error.status)
        )
      )
        throw error;
      unavailable = error.status === 503;
    }
    const supportUpload =
      request.method === "POST" && isSupportUpload(path, request);
    // Bounded imports and scoped install forwarding.
    // Current session and room checks remain authoritative.
    let body =
      request.method === "POST"
        ? supportUpload
          ? undefined
          : await (earlyBody ?? readSupportJson(request, path))
        : undefined;
    if (body && session) requireExpectedPrincipal(body, session);
    // A teammate named by a Solana wallet: only the manager grants that way.
    const grantee = solanaGrantee(path, request.method, body);
    if (
      grantee &&
      !(
        session && await nativeWorkspaceAdmin(scopedNative as Env, context, session)
      )
    )
      throw new HttpError(403, "You do not have permission to do that.");
    let granted: ChatPrincipalId | null = null;
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Native-Room-Id": id,
      ...servicePrincipalHeaders(session),
      "X-Verified-Manager": context.record.room.manager,
      "X-Verified-Creator": context.record.room.creator,
      ...(session
        ? {
            "X-Verified-Principal": session.principalId,
            "X-Session-Expires-At": String(session.expiresAt),
            [AUTHENTICATED_AT_HEADER]: String(session.authenticatedAt ?? 0),
            [AUTH_METHOD_HEADER]: session.authMethod,
          }
        : {}),
      ...(session?.address ? { "X-Verified-Wallet": session.address } : {}),
      // Product checkout reads this header as the payer. A widget session
      // never sends it: its wallet goes in X-Support-Wallet below.
      ...(session?.solanaAddress && !(env as WidgetEnv)[WIDGET_SCOPE]
        ? { "X-Verified-Solana-Wallet": session.solanaAddress }
        : {}),
      ...(unavailable ? { "X-Session-Unavailable": "true" } : {}),
    });
    if ((env as WidgetEnv)[WIDGET_SCOPE]) {
      headers.set("X-Support-Widget", "member");
      headers.set("X-Support-Ask-Person", (env as WidgetEnv)[WIDGET_SCOPE]!.askPerson === false ? "false" : "true");
      if (session && path === "/conversations/live")
        headers.set(
          "X-Support-Widget-Session",
          await sessionCacheKey(session.token),
        );
      // A validated install run excludes its preview.
      // The symbol exists only after the widget permit was checked.
      if ((env as Env & { [INSTALL_PREVIEW]?: boolean })[INSTALL_PREVIEW])
        headers.set("X-Support-Install-Preview", "1");
      headers.set(
        "X-Support-Widget-Origin",
        (env as WidgetEnv)[WIDGET_SCOPE]!.origin,
      );
      // The request came through Templ's frame.
      if ((env as WidgetEnv)[WIDGET_SCOPE]!.frame)
        headers.set("X-Support-Widget-Frame", "1");
      if ((env as WidgetEnv)[WIDGET_SCOPE]!.hosted)
        headers.set("X-Support-Entry", "hosted");
      // Rebuilt here from the stored session; a widget request cannot set it.
      headers.set(
        "X-Support-Access-Level",
        session ? sessionLevel(session) : "signed",
      );
      if (session?.authMethod === "guest" && session.walletUnavailable === true)
        headers.set("X-Support-Wallet-Unavailable", "1");
      if (session?.authMethod === "guest" && session.guestCredentialHash)
        headers.set("X-Support-Guest-Credential", session.guestCredentialHash);
      // The proven wallet, and a guest's claim, in CAIP-10.
      const proven = session ? widgetWallet(session) : null;
      if (proven) headers.set("X-Support-Wallet", formatCaip10(proven));
      if (
        session &&
        sessionLevel(session) === "connected" &&
        session.guestClaim
      )
        headers.set(
          "X-Support-Claimed-Wallet",
          formatCaip10(session.guestClaim),
        );
    }
    // Anonymous socket and guest caps; never the raw address. Without the
    // digest key the header is left out, and those caps fail closed.
    const ipDigest = await clientIpDigest(request, env);
    if (ipDigest) headers.set("X-Client-IP-Digest", ipDigest);
    if (session && ordinary) {
      headers.set("X-Access-Checked-At", String(Date.now()));
      headers.set(
        "X-Access-Expires-At",
        String(Math.min(Date.now() + 60_000, session.expiresAt)),
      );
    }
    {
      // The target's identity and the room's safety status are read together
      // and judged in their usual order. A Solana wallet named in a grant is
      // looked up only once the manager passed the safety check and the
      // room agreed to the grant.
      const safety = started(
        requireSafetyAccess(
          scopedNative as SafetyEnv,
          `room:${id}`,
          session?.principalId,
          sessionPrincipals(session),
        ),
      );
      if (grantee) {
        await safety;
        const refused = await authorizeSolanaGrant(
          env,
          context.room,
          headers,
          path,
          session!,
          body!.confirmed,
        );
        if (refused) return refused;
        granted = await solanaGranteeAccount(env, grantee);
        body!.principalId = granted;
      }
      const targetIdentity = started(
        targetIdentityHeaders(env, headers, path, body, url),
      );
      await targetIdentity;
      await safety;
      await attachMessageHold(
        scopedNative as SafetyEnv,
        headers,
        `room:${id}`,
        request.method,
        path,
      );
      if (supportUpload) {
        if (!session) throw new HttpError(401, "Sign in to add a screenshot.");
        requireExpectedPrincipal(
          { expectedPrincipalId: url.searchParams.get("expectedPrincipalId") },
          session,
        );
        // The small GET follows the room's current privacy, membership and
        // conversation authorization before any binary body is consumed.
        const preflight = await conversationWorkerRoute(
          env as ConversationEnv,
          context.room,
          headers,
          { path, method: "GET", session },
        );
        if (!preflight) return json({ error: "Not found." }, 404);
        if (!preflight.ok) return preflight;
        await preflight.body?.cancel().catch(() => undefined);
        body = await readSupportUpload(request);
      }
      {
        const conversation = await conversationWorkerRoute(
          env as ConversationEnv,
          context.room,
          headers,
          { path, search: url.search, method: request.method, body, session },
        );
        // The room counts its own refusals; widget opens on unapproved
        // sites are counted in the widget settings object and added here.
        if (
          conversation?.status === 200 &&
          path === "/conversations/refusals" &&
          request.method === "GET"
        )
          return withOriginRefusals(env, id, url, conversation);
        if (conversation) return conversation;
      } // Gate header and cross-room open quotas
      const report = await reportRoomRequest(
        request,
        scopedNative,
        context.room,
        headers,
        path,
        body,
        session,
        `${cfg.origin.origin}/inbox/${id}`,
      );
      if (report) return report;
      const result = await withMessageBudget(
        env,
        {
          scope: `room:${id}`,
          path,
          method: request.method,
          body,
          principal: session?.principalId ?? null,
          aliases: sessionPrincipals(session),
        },
        (available) => {
          if (available !== undefined)
            headers.set(MESSAGE_BUDGET_AVAILABLE_HEADER, String(available));
          return timed(
            env,
            "room",
            context.room.fetch(
              new Request(`https://internal${path}${url.search}`, {
                method: request.method,
                headers,
                ...(body ? { body: JSON.stringify(body) } : {}),
              }),
            ),
          );
        },
      );
      if (
        result.ok &&
        body?.granted === true &&
        /^\/roles\/[^/]+\/assign$/.test(path)
      )
        followAddedWorkspace(
          env,
          context.record.room,
          principalsFromHeaders(headers, principal(body.principalId), true),
        );
      if (result.ok && path === "/channels" && request.method === "GET") {
        const state = await result.json<ChatState>();
        if (Object.hasOwn(state, "features"))
          state.features = workspaceFeatureSnapshot(state.features);
        if (
          session &&
          (state.viewer?.isMember ||
            state.viewer?.isManager ||
            state.viewer?.roleIds?.length)
        )
          followAddedWorkspace(
            env,
            context.record.room,
            sessionPrincipals(session),
          );
        const stateHeaders = new Headers(result.headers);
        stateHeaders.delete("Content-Length");
        return json(
          workspaceStateView(state, sessionPrincipals(session)),
          result.status,
          stateHeaders,
        );
      }
      if (result.ok && path === "/bots" && request.method === "GET") {
        const state = session
          ? await nativeWorkspaceState(context.room, headers)
          : null;
        if (!workspaceIdentitiesVisible(state?.viewer)) {
          await result.body?.cancel();
          return json({ bots: [], revision: 0 });
        }
      }
      if (result.ok && path === "/appearance" && request.method === "POST")
        await indexNative(env, (await nativeRecord(env, id)).record);
      // The grant is made: the manager's page continues with the account ID
      // it shows in the team list.
      if (granted && result.ok)
        return json(
          {
            ...(await result.json<Record<string, unknown>>()),
            principalId: granted,
          },
          result.status,
        );
      return result;
    }
  }
  if (
    (url.pathname === "/subscriptions" ||
      (url.pathname === "/subscriptions/hidden" && request.method === "GET") ||
      /^\/subscriptions\/rooms\/[0-9a-f-]+$/.test(url.pathname)) &&
    ["GET", "POST"].includes(request.method)
  ) {
    const nativeSubscription = /^\/subscriptions\/rooms\/([0-9a-f-]+)$/.exec(
      url.pathname,
    );
    const subscriptionBody =
      request.method === "POST" ? await readJson(request) : undefined;
    // The session record read starts with the room read. For the list, the
    // list read starts as soon as the record names its principals; it is
    // used only when the verified session has exactly those principals.
    prefetchSession(request, env, null);
    const earlyList =
      request.method === "GET" && url.pathname === "/subscriptions"
        ? prefetchSubscriptionList(env, request, url)
        : null;
    if (nativeSubscription || subscriptionBody?.roomId !== undefined) {
      const context = await nativeRecord(
        env,
        nativeRoomId(nativeSubscription?.[1] ?? subscriptionBody?.roomId),
      );
      await scopeNativeBudget(env, context);
    }
    const session = await currentSession(
      request,
      env,
      false,
      deps.verifySessionAuthority,
    );
    if (!env.ROOM_SUBSCRIPTIONS)
      throw new HttpError(503, "Chat subscriptions are being set up.");
    const list = linkedSubscriptions(env, session);
    if (request.method === "GET") {
      const early = await earlyList;
      const response =
        early &&
        early.principalId === session.principalId &&
        samePrincipalSet(early.principals, sessionPrincipals(session))
          ? early.response
          : await timed(
              env,
              "subs",
              list.fetch(
                new Request(`https://internal${url.pathname}${url.search}`),
              ),
            );
      if (!response.ok) return response;
      if (url.pathname === "/subscriptions/hidden") {
        const result = await response.json<{
          roomIds: string[];
          nextCursor: string | null;
        }>();
        const visible = await visibleSubscriptions(
          env,
          session,
          result.roomIds.map((id) => ({
            kind: "native" as const,
            room: { id },
          })),
        );
        return json({
          workspaces: visible.map((item) => item.room),
          nextCursor: result.nextCursor,
          viewerPrincipalId: session.principalId,
          viewerWallet: session.address,
        });
      }
      if (url.pathname !== "/subscriptions") {
        const result = await response.json<{ subscribed: boolean }>();
        return json({
          subscribed: result.subscribed,
          viewerPrincipalId: session.principalId,
          viewerWallet: session.address,
        });
      }
      const result = await response.json<{
        subscriptions: import("@templ/chat/index").ChatSubscriptions["subscriptions"];
        nextCursor: string | null;
      }>();
      const subscriptions = await visibleSubscriptions(
        env,
        session,
        result.subscriptions,
      );
      return json({
        ...result,
        viewerPrincipalId: session.principalId,
        viewerWallet: session.address,
        subscriptions,
      });
    }
    const body = subscriptionBody!;
    requireExpectedPrincipal(body, session);
    if (body.roomId === undefined)
      throw new HttpError(400, "Choose a community room.");
    {
      const id = nativeRoomId(body.roomId);
      const counted = async (response: Response) => {
        if (!response.ok) return response;
        const headers = new Headers(response.headers);
        headers.delete("X-Subscription-Changed");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      };
      if (body.subscribed === false)
        return counted(
          await list.fetch(
            internalPost("/subscriptions", { roomId: id, subscribed: false }),
          ),
        );
      const context = await nativeRecord(env, id);
      const scoped = { ...env, [NATIVE_CONTEXT]: context } as NativeEnv;
      await requireSafetyAccess(
        scoped as SafetyEnv,
        `room:${id}`,
        session.principalId,
        sessionPrincipals(session),
      );
      await requirePrivateMembership(
        context.room,
        privacyHeaders(scoped, session, context.record.room.manager),
      );
      const record = context.record;
      return counted(
        await list.fetch(
          internalPost("/subscriptions", {
            roomId: id,
            room: record.room,
            subscribed: body.subscribed,
          }),
        ),
      );
    }
  }
  return json({ error: "Not found." }, 404);
}

export default createCommunityWorker();
