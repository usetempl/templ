import { appAnswerAllowed, appAnswerAlarm, reportAppAnswerFailure } from "./app-ai-replies";
import { ENCRYPTION_ACCESS_REVISION, revokeEncryptionPrincipal, revokeEncryptionRole } from "./support-encryption-access";
import { ENCRYPTION_DELETION_REVISION, newCaseEncryptionView, ownNewChatMode, requireOwnWidgetWallet } from "./support-encryption";
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import { advanceOwnAuthority, revokeOwnDevice, OWN_AUTHORITY_CHECKPOINT } from "./own-encryption-control";
import { hostedPrepaidPrincipal, reservePrepaidAi, settlePrepaidAi } from "./product-prepaid-ai";
import { queueRoomResources } from "./workspace-resource-observations";
import { workspaceCostFinance } from "./workspace-cost-finance";
import { continueCustomerDebtAccess, finalizeStandardAiCases } from "./product-standard-plan";
import { storageBillingAlarm } from "./brain-storage-billing";
import { STORAGE_OPERATOR_PATH, storageOperatorRequest } from "./brain-storage-operator";
import { finalizeUsageCases } from "./product-usage-billing";
import {
  diagnosisNetworksHeader,
  type DiagnosisEnv,
} from "./tx-diagnosis/chains";
import { teamInviteRequest } from "./team-invites";
import { DIAGNOSIS_NETWORKS_HEADER } from "./support-diagnosis";
import {
  WORKSPACE_FLAGS_INDEX_PATH,
  WORKSPACE_FLAGS_ROOM_PATH,
  WORKSPACE_FEATURES_ROOM_PATH,
  workspaceFlagsIndexRequest,
  roomWorkspaceFlagsRequest,
  managerWorkspaceFlags,
  workspaceFlagsAlarm,
  scheduleWorkspaceFlags,
  workspaceFeatureEnv,
  workspaceFeatureValues,
  workspaceFeatures,
  featureOn,
  type WorkspaceFlagEnv,
} from "./workspace-flags"; // Managed authors have a separate safety audit kind.
// The principal is derived from the workspace.
// It grants no authority and every room write checks its current role.
import { managedPrincipal } from "./managed-agent/principal";
import { hexHiddenSearch } from "./support-secret-sinks";
import { runPriorityVerifications } from "./support-priority-read";
import {
  priorityCaptureAlarm,
  priorityCaptureRoute,
  appendPriorityCaptureObservation,
  finishPriorityCaptureWindow,
  PRIORITY_CAPTURE_MAX_ROW_BYTES,
  type PriorityCaptureCapability,
  type PriorityCaptureEnv,
} from "./priority-trial-capture";
import { checkedPriorityCaptureFixture } from "./priority-trial-fixture";
import type { PriorityPosition } from "@templ/chat/support-priority";
import {
  loopbackOffered,
  type WidgetSessionEnv,
} from "./widget-session-config";
// Import request envelope limits.
// The parser enforces the decoded file limit before storage.
import { supportImportBodyBytes } from "./support-import-parser";
import { readSupportJson } from "./support-body";
// The case silence alarm.
// Storage transitions run in the room transaction.
import { abandonDueCases } from "./support-abandon";
import { corpusBuildAlarm, type CorpusEnv } from "./support-corpus";
import { noteFeed, noteSearch, readRole, settleReadMarks } from "./read-audit";
import { supportSearchPresentation } from "./support-search-presentation";
import {
  CLOSING_ALARM_CONSUMERS,
  readDeletionState,
  workspaceClosing,
  workspaceDeletionAlarm,
  workspaceDeletionRoomRequest,
} from "./workspace-deletion";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import {ownQualificationAlarm} from "./support-own-qualification";
import {
  runRoomAlarm,
  wakeRoomAt,
  ROOM_ALARM_RECOVERY_MS,
  type RoomAlarmConsumer,
} from "./room-alarm";
import {
  supportStorage,
  supportStoragePending,
  archiveSupportTrialHistory,
  migrateGroupStorage,
  discoverGroupStorage,
  flushSupportStorage,
} from "./support-storage";
import { sweepSupportRetention, type SweepOutcome } from "./support-retention";
import { knowledgeRetention } from "./support-knowledge-retention";
import type { KnowledgeEnv } from "./support-knowledge-client";
import { readRetentionHolds, type SafetyEnv } from "./safety";
import { supportNotificationAlarm } from "./support-notifications";
import { ledgerState, supportCaseLedgerAlarm } from "./support-cases";
import { supportCaseDataDeleters } from "./support-case-data";
import { runDiagnosisJobs } from "./tx-diagnosis/job";
import { supportHealth } from "./support-health";
import {
  recordSupportRefusal,
  refusalCauseFromError,
} from "./support-refusals";
import { canaryPrincipal } from "./support-canary";
import {
  checkedWidgetAuditEntry,
  WIDGET_AUDIT_OUTBOX,
  type WidgetAuditEntry,
} from "./support-widget";
import type { OpsHealthEnv } from "./ops-health";
import {
  SUPPORT_UPLOAD_ENVELOPE_BYTES,
  supportMediaReferenced,
} from "./support-workflow";
import {
  SUPPORT_MEDIA_COMMIT_BYTES_HEADER,
  SUPPORT_MEDIA_COMMIT_ID_HEADER,
  commitSupportAttachment,
  deleteSupportAttachment,
} from "./media";
import {
  MESSAGE_BUDGET_AVAILABLE_HEADER,
  MESSAGE_BUDGET_USED_HEADER,
} from "./message-budget";
import {
  consistentPermissionGrant,
  MODERATOR_PERMISSIONS,
  type ModeratorPermission,
  type ChatRole,
  type ChatRoleTerms,
  type ChatViewer,
} from "@templ/chat/index";
import type { ChatBot } from "@templ/chat/bots";
import { workspaceOnboarding } from "./onboarding-metrics";
import {
  ANALYTICS_SOURCES,
  type AnalyticsEvent,
} from "@templ/chat/analytics-events";
import {
  nativeCatalogRequest,
  nativeControlRequest,
  WORKSPACE_FEATURES_HEADER,
  nativeManualRole,
  type NativeRoomRecord,
} from "./native-rooms";
import { rpcBudgetRequest } from "./rpc-budget";
import {
  FREE_START_REGISTRY_PATH,
  freeStartRegistryRequest,
  reserveFreeStartRegistry,
  reserveOwnerRegistry,
} from "./product-free-start";
import { memberProductView } from "@templ/chat/product-catalog";
import { initializeProducts, PRODUCT_STATE_KEY } from "./product-entitlements";
import { applyProductGrants, type ProductGrantsEnv } from "./product-grants";
import { readProductAccess } from "./product-view";
import { finalizeDueCharges, recentDebits } from "./product-charges";
import { deliverBalanceAlerts } from "./product-alert-delivery";
import { emitBalanceAlerts, pruneBalanceAlerts } from "./product-alerts";
import { deliverFinanceEmails } from "./product-finance-email";
import { queueMonthReport } from "./product-month-report";
import {
  BILLING_INDEX_PATH,
  ROOM_OPERATOR_BILLING_PATH,
  billingIndexRequest,
  registerBillingWorkspace,
  roomOperatorBillingRequest,
} from "./operator-billing";
import { openIndexAlarm } from "./support-open-index";
import {
  ROOM_GRANT_STATUS_PATH,
  roomGrantStatusRequest,
} from "./operator-grants";
import { productRoute, walletOwner } from "./product-routes";
import { identityRequest } from "./account-identity";
import {
  paymentLedgerCall,
  type PaymentReservation,
} from "./product-payment-ledger";
import { paymentScannerCall } from "./product-payment-scanner";
import type {
  ProductPaymentIntent,
  ProductPaymentReceipt,
} from "@templ/chat/product-payment";
import {
  ROOM_ORDER_FORMS_PATH,
  roomOrderFormsRequest,
} from "./operator-order-forms";
import {
  processProductOrderForms,
  reconcileOrderFormNoticeRecipients,
} from "./product-order-forms";
import {
  stripeOwnerRequest,
  stripeIndexRequest,
  stripeRoomStateRequest,
  deliverStripeUsage,
  deliverStripeOwnerUpdates,
  stripeOwnerAlarm,
  managerStripeAction,
  STRIPE_OWNER_PATH,
  STRIPE_INDEX_PATH,
  STRIPE_ROOM_PATH,
  STRIPE_ROOM_KEY,
  type StripeRoomState,
} from "./stripe-store";
import { deliverDeletedWorkspaceStripe } from "./stripe-deletion";
import { emitCardAlerts } from "./product-alerts";
import {
  productPaymentRequest,
  updateProductPaymentEvent,
  type ProductPaymentScannerWork,
  type ProductPaymentScannerResult,
  settleProductPayment,
  publicPaymentIntent,
  type VerifiedProductTransfer,
  registerProductPayments,
  type ProductBillingEnv,
} from "./product-billing";
import {
  flushWorkspaceSteps,
  markWorkspaceStep,
  workspaceStepMarks,
  type FunnelEnv,
} from "./funnel-metrics";
import {
  address,
  errorBody,
  HttpError,
  json,
  readJson,
  siteOrigins,
  type Env,
} from "./common";
import { pageAuthors } from "./author-facts";
import { flushGroupAttachmentOutbox } from "./group-attachment-message";
import { groupMediaReferenced } from "./group-attachment-cleanup";
import { principal } from "./principal";
import {
  currentStaffRoleIds,
  isTemplStaff,
  listedTemplStaff,
  templStaffAccount,
  updateTemplStaffGrant,
  type TemplStaffEnv,
} from "./templ-staff";
import {
  principalsFromHeaders,
  actsAs,
  aliasValues,
  servicePrincipals,
} from "./service-principals";
import { accentColor } from "./room-appearance";
import {
  roomPrivacy,
  privacyStatus,
  requireRoomAccess,
  roomPrivacyRequest,
  admitRoomMember,
} from "./room-privacy";
import { reserveGroupStorage } from "./room-retention"; // Room growth headroom
import {
  accountQuotaRequest,
  agentHiddenConversations,
  canReadConversation,
  conversationRoute,
  conversationScope,
  conversationAuthority,
  isConversationId,
  readConversation,
  shareGuestWalletProof,
  verifyWidgetMember,
  widgetVerification,
  type ConversationContext,
} from "./team-conversations"; // Member-to-team conversations
import { SupportTyping } from "./support-typing";
import type { ChatEvent } from "@templ/chat/events";
import { appendEvents, type PendingEvent } from "./room-events";
import {
  botsFromSettings,
  botsRevision,
  botsRoute,
  aiPrincipals,
  aiPrincipalsFromSettings,
  aiRole,
  requireHumanManager,
} from "./bots";
import {
  appendAudit,
  auditCursor,
  auditLimit,
  auditFilters,
  auditStreamParam,
  readAuditStream,
  type PendingAudit,
} from "./room-audit";
import { reportSnapshot } from "./message-store";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { SearchIndex, searchRoute } from "./search-index";
import {
  eventsRoute,
  realtimeAfterCommit,
  realtimeClose,
  realtimeError,
  realtimeMessage,
  realtimeTicketRoute,
  realtimeUpgrade,
  endWidgetSockets,
} from "./realtime";
import { abiCatalogRequest } from "./transaction-decoder";
// Storage recovery: the lock, the alarm hold, the redelete
// queue and the room's recovery routes, used by the alarm and the request
// path below.
import {
  recoveryAlarmHold,
  recoveryGate,
  recoveryRedeleteAlarm,
  roomRecoveryRoute,
  restoreStartupLock,
  recoveryPausedResponse,
} from "./storage-recovery-room";
import { RecoveryWork } from "./storage-recovery-barrier";
import { staffPushAlarm, type StaffPushEnv } from "./staff-push";
import { managedJobsAlarm } from "./managed-agent/room";
import { handoffLearningCleanupAlarm } from "./support-handoff-learning";
// Team alerts: the outbox and timer consumers and the
// refusal alert.
import { alertOutboxAlarm } from "./alert-outbox";
import { nativeTelegramAlarm } from "./native-telegram";
import { invalidateNativeTelegramGrant, nativeTelegramApproved } from "./native-telegram-access";
import { alertOutboxDeps, emitRefusalAlert } from "./support-alert-emit";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { currentHumanAdmin } from "./workspace-admin";
import { recoverDemoAdmin } from "./demo-admin-recovery";
import { standardTeamRole, SUPPORT_TEAM_ROLES } from "@templ/chat/team-roles";
import { supportTimersAlarm } from "./support-timers";
import { followUpAlarmConsumers } from "./support-follow-up-alarms";
import { memberAlertsPrivateRoute } from "./member-alerts";

type Settings = {
  /** Workspaces have no group channels. Stored channels (and
   * `channelGroups`) are read and ignored; new workspaces store none. */
  channels: unknown[];
  /** Every staff role. A stored role without a `native-manual-roles` record
   * belongs to a token, hold or payment rule: it is listed nowhere and grants
   * nothing. */
  roles: {
    id: string;
    name: string;
    enabled?: boolean;
    moderationPermissions?: ModeratorPermission[];
  }[];
  bots: ChatBot[];
  botsRevision: number;
};
type Storage = DurableObjectTransaction;
const initial = (): Settings => ({
  channels: [],
  roles: [],
  bots: [],
  botsRevision: 0,
});
const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
function name(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 48 ||
    // Reject control characters in user-supplied display names.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new HttpError(400, "Use a name of 1 to 48 characters.");
  return value.trim();
}
export const INCONSISTENT_CONVERSATION_GRANT_ERROR =
  "Starting cases with users needs the power to read and answer team cases in the same role.";
function permissions(value: unknown): ModeratorPermission[] {
  if (
    !Array.isArray(value) ||
    value.length > MODERATOR_PERMISSIONS.length ||
    value.some((permission) => !MODERATOR_PERMISSIONS.includes(permission))
  )
    throw new HttpError(400, "Invalid moderator permissions.");
  const selected = [...new Set(value)] as ModeratorPermission[];
  // An outbound-only grant is refused before it is stored.
  if (!consistentPermissionGrant(selected))
    throw new HttpError(400, INCONSISTENT_CONVERSATION_GRANT_ERROR);
  return selected;
}
function moderationRolePermissions(value: unknown): ModeratorPermission[] {
  if (value === undefined) return [];
  return permissions(value);
}
/** Stored powers the current list names. A stored power outside that list
 * grants nothing; the role keeps its other powers. */
function knownPermissions(value: unknown): ModeratorPermission[] {
  return Array.isArray(value)
    ? ([...new Set(value)].filter((permission) =>
        MODERATOR_PERMISSIONS.includes(permission as ModeratorPermission),
      ) as ModeratorPermission[])
    : [];
}
function rolePermissions(
  settings: Settings,
  roleIds: readonly string[],
  agent = false,
): ModeratorPermission[] {
  return [
    ...new Set(
      roleIds.flatMap((id) =>
        knownPermissions(
          settings.roles.find(
            (role) =>
              role.id === id &&
              role.enabled !== false &&
              (role.id !== "support-admin" || standardTeamRole(role)) &&
              (!agent || aiRole(role)),
          )?.moderationPermissions,
        ).filter((permission) => permission !== "manageWorkspace" || id === "support-admin"),
      ),
    ),
  ] as ModeratorPermission[];
}
async function assignedRoleIds(
  storage: Pick<DurableObjectTransaction, "get">,
  ids: readonly ChatPrincipalId[],
  env: TemplStaffEnv,
  now = Date.now(),
) {
  return currentStaffRoleIds(storage, ids, env, now);
}

async function hasModerator(
  storage: Pick<DurableObjectTransaction, "get">,
  settings: Settings,
  ids: readonly ChatPrincipalId[],
  env: TemplStaffEnv,
) {
  const agents = await aiPrincipals(storage, settings);
  return (
    rolePermissions(
      settings,
      await assignedRoleIds(storage, ids, env),
      ids.some((id) => agents.includes(id)),
    ).length > 0
  );
}
async function moderatorEntries(
  storage: Pick<DurableObjectTransaction, "get" | "list">,
  settings: Settings,
  env: TemplStaffEnv,
) {
  const agents = await aiPrincipals(storage, settings);
  const entries: {
    wallet: string;
    permissions: ModeratorPermission[];
    roleIds: string[];
    templStaff?: true;
  }[] = [];
  for (const [key, value] of await storage.list<unknown[]>({
    prefix: "roles:",
    limit: 1024,
  })) {
    const ids = Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
    const agent = agents.includes(principal(key.slice("roles:".length)));
    const permissions = rolePermissions(settings, ids, agent);
    // The manager's Team page labels people from the roles they hold,
    // without asking about each one.
    if (permissions.length)
      entries.push({
        wallet: key.slice("roles:".length),
        ...(listedTemplStaff(env, key.slice("roles:".length)) ||
        (await isTemplStaff(storage, key.slice("roles:".length)))
          ? { templStaff: true as const }
          : {}),
        permissions,
        roleIds: ids.filter((id) =>
          settings.roles.some(
            (role) => role.id === id && (!agent || aiRole(role)),
          ),
        ),
      });
  }
  return entries;
}
function signed(viewer: ChatViewer) {
  if (!viewer.principalId) throw new HttpError(401, "Sign in to chat.");
  return viewer.principalId;
}
function requirePermission(
  viewer: ChatViewer,
  permission: ModeratorPermission,
) {
  signed(viewer);
  if (!viewer.isManager && !viewer.permissions.includes(permission))
    throw new HttpError(403, "You do not have permission to do that.");
}

/** The highest widget settings change the room's log holds. */
const WIDGET_AUDIT_MARK = "room-audit-import-v1:widget-config";
/** The body of `/private/support/audit-import`: at most one outbox of
 * checked entries, in sequence order. Anything else is refused whole. */
function widgetAuditImport(body: Record<string, unknown>): WidgetAuditEntry[] {
  const raw = body.entries;
  if (
    body.source !== "widget-config" ||
    !Array.isArray(raw) ||
    !raw.length ||
    raw.length > WIDGET_AUDIT_OUTBOX
  )
    throw new HttpError(400, "Invalid widget settings changes.");
  const entries: WidgetAuditEntry[] = [];
  for (const value of raw) {
    const entry = checkedWidgetAuditEntry(value);
    if (!entry || (entries.length && entry.seq <= entries.at(-1)!.seq))
      throw new HttpError(400, "Invalid widget settings changes.");
    entries.push(entry);
  }
  return entries;
}

/** When the retention sweep runs next, by what its last call found: soon
 * while there is more, daily while a due thread is held (even once the plan
 * has ended, so a released hold is swept), hourly while the holds cannot be
 * read, and never when nothing is due. */
export function retentionNextRun(
  outcome: SweepOutcome,
  now: number,
): number | null {
  if (outcome === "more") return now + 60_000;
  if (outcome === "held") return now + 86_400_000;
  if (outcome === "holds-unavailable") return now + 3_600_000;
  return null;
}
const ROOM_ALARM_CONSUMERS: readonly RoomAlarmConsumer[] = Object.freeze([
  {
    id: "priority-trial-capture",
    run: ({ state, env }, now) =>
      state.storage.transaction((storage) =>
        priorityCaptureAlarm(storage, env as PriorityCaptureEnv, now),
      ),
  },
  {
    id: "workspace-flags",
    run: ({ state, env }, now) => workspaceFlagsAlarm(state, env, now),
  },
  {
    id: "own-encryption-qualification",
    run: ({state}, now) => state.storage.transaction(storage => ownQualificationAlarm(storage, now)),
  },
  {
    id: "support-notifications",
    run: ({ state, env }) => supportNotificationAlarm(state, env),
  },
  {
    id: "support-storage-flush",
    run: async ({ state, env }, now) =>
      (await flushSupportStorage(state, env)) ? now + 1_000 : null,
  },
  {
    id: "support-retention",
    run: async ({ state, env, searchIndex }, now) =>
      retentionNextRun(
        await state.storage.transaction(async (local) =>
          sweepSupportRetention(
            await supportStorage(local, env, state.id?.toString() ?? "", false),
            now,
            (channel, id) => searchIndex.remove(channel, id),
            (room, conversation, attachment, reference) =>
              deleteSupportAttachment(
                env,
                { room, conversation, attachment: attachment.id },
                attachment,
                reference,
              ),
            (roomKey) => readRetentionHolds(env as SafetyEnv, roomKey),
            // Eval copies' links and purge.
            knowledgeRetention(env as KnowledgeEnv),
          ),
        ),
        now,
      ),
  },
  {
    id: "support-trial-archive",
    run: async ({ state, env }, now) =>
      (await archiveSupportTrialHistory(state, env)) ? now + 1_000 : null,
  },
  {
    id: "group-attachment-outbox",
    run: ({ state, env }) => flushGroupAttachmentOutbox(state, env),
  },
  {
    id: "group-storage-discovery",
    run: async ({ state }, now) =>
      (await discoverGroupStorage(state)) ? now + 1_000 : null,
  },
  {
    id: "group-storage-migration",
    run: async ({ state, env }, now) =>
      (await migrateGroupStorage(state, env)) ? now + 1_000 : null,
  },
  {
    // Backfills threads from before the case ledger, then prunes old cases
    // once a day.
    id: "support-case-ledger",
    run: ({ state, env }, now) =>
      supportCaseLedgerAlarm(state, env, now, supportCaseDataDeleters()),
  },
  // The case silence alarm.
  // Bounded due-index reads keep alarm work re-entrant.
  {
    id: "support-abandon",
    run: async ({ state, env }, now) => {
      const events: Parameters<typeof realtimeAfterCommit>[1] = [];
      const next = await state.storage.transaction(async (local) =>
        abandonDueCases(
          await supportStorage(local, env, state.id.toString(), false),
          now,
          events,
        ),
      );
      await realtimeAfterCommit(state, events, env, agentHiddenConversations);
      return next;
    },
  },
  // Feature alarm consumers run before room-daily; each id comes from
  // ROOM_ALARM_CONSUMER_IDS in room-alarm.ts.
  {
    // Escalation on Needs you, waiting summaries and unseen replies
    // (support-timers.ts).
    id: "support-escalation",
    run: ({ state, env }, now) => supportTimersAlarm(state, env as never, now),
  },
  {
    // Slack, Discord, Telegram and signed webhooks (alert-outbox.ts).
    id: "alert-outbox",
    run: ({ state, env }, now) =>
      alertOutboxAlarm(state, env as never, now, alertOutboxDeps(env as never)),
  },
  {
    id: "app-ai-replies",
    run: ({ state, env }, now) => appAnswerAlarm(state, env as Env, now),
  },
  {
    id: "native-telegram",
    run: ({ state, env }, now) => nativeTelegramAlarm(state, env as Env, now),
  },
  {
    // Automatic transaction checks and the key guard (tx-diagnosis/job.ts):
    // chain reads run here, outside any storage transaction, charged to
    // this workspace's RPC budget.
    id: "support-diagnosis",
    run: (context, now) => runDiagnosisJobs(context, now),
  },
  // Follow-up timers, then watches and position reads (chain reads run
  // outside any storage transaction, on this workspace's RPC budget).
  ...followUpAlarmConsumers((state, env, events) =>
    realtimeAfterCommit(state, events, env, agentHiddenConversations),
  ),
  {
    // Fills the open-thread index of a room from before it, 200 records a
    // run, then reports nothing timed.
    id: "support-open-index",
    run: ({ state }, now) => openIndexAlarm(state, now),
  },
  // The charge ledger and billing alerts.
  {
    // Charges whose hold or reopen window ended go final, then billing
    // alerts go out to billing managers and team channels.
    id: "product-billing",
    run: async ({ state, env }, now) => {
      const deletion = await readDeletionState(state.storage);
      if (
        deletion &&
        (deletion === "unreadable" || deletion.state !== "scheduled")
      )
        return null;
      const debtAccess = deletion ? null : await state.storage.transaction((storage) =>
        continueCustomerDebtAccess(storage, now),
      );
      const orderForms = await state.storage.transaction((storage) =>
        processProductOrderForms(storage, env, now),
      );
      await realtimeAfterCommit(state, [], env, agentHiddenConversations);
      const finalize = await state.storage.transaction((storage) =>
        finalizeDueCharges(storage, env, now),
      );
      const usage = await state.storage.transaction((storage) =>
        finalizeUsageCases(storage, now, env),
      );
      const standard = await state.storage.transaction((storage) => finalizeStandardAiCases(storage, now, env));
      const storageAt = deletion ? null : await state.storage.transaction((storage) => storageBillingAlarm(storage, env as never, now));
      if (deletion)
        return [finalize, usage, standard]
          .filter((at): at is number => at !== null)
          .reduce<
            number | null
          >((next, at) => (next === null ? at : Math.min(next, at)), null);
      const stripe = await deliverStripeUsage(
        state.storage as never,
        env as never,
        now,
      );
      const cardReminder = await state.storage.transaction(async (storage) => {
        const card = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
        return card ? emitCardAlerts(storage, card, now, env) : null;
      });
      const deliver = await state.storage.transaction(async (storage) => {
        await pruneBalanceAlerts(storage, now);
        return deliverBalanceAlerts(storage, env as never, now);
      });
      // Last month's email once a month, then the finance address's queue.
      const report = await state.storage.transaction((storage) =>
        queueMonthReport(storage, env, now),
      );
      const native = await state.storage.get<{ room?: { id?: string } }>(
        "native-room",
      );
      // Sends happen outside a transaction: each row goes once it is sent.
      const finance = native?.room?.id
        ? await deliverFinanceEmails(state.storage, env as never, {
            room: `room:${native.room.id}`,
            now,
          })
        : null;
      const next = [
        debtAccess,
        orderForms,
        finalize,
        usage,
        standard,
        storageAt,
        deliver,
        report,
        finance,
        stripe,
        cardReminder,
      ].filter((at): at is number => at !== null);
      return next.length ? Math.min(...next) : null;
    },
  },
  {
    id: "stripe-deletion-cleanup",
    run: ({ state, env }, now) =>
      deliverDeletedWorkspaceStripe(state.storage, env as never, now),
  },
  // Text-free push alerts to staff.
  {
    id: "staff-push",
    run: ({ state, env }, now) =>
      staffPushAlarm(state.storage, env as StaffPushEnv, now),
  },
  // Queued managed AI jobs handed to the knowledge object, which runs them.
  {
    id: "managed-agent",
    run: (context, now) => managedJobsAlarm(context, now),
  },
  {
    id: "handoff-learning-cleanup",
    run: (context, now) => handoffLearningCleanupAlarm(context, now),
  },
  {
    // Threads deleted for a privacy request after a restore point, handed
    // to the retention sweep one at a time (storage recovery).
    id: "storage-recovery",
    run: ({ state }, now) => recoveryRedeleteAlarm(state.storage, now),
  },
  // Templ's de-identified copy of finished requests.
  {
    // Builds rows for finished requests inside this room, 25 a run
    // (support-corpus.ts); nothing runs while the copy is off.
    id: "support-corpus",
    run: ({ state, env }, now) =>
      corpusBuildAlarm(
        state.storage,
        env as unknown as CorpusEnv,
        now,
        undefined,
        async () => ({
          list: <T>(options?: DurableObjectListOptions) =>
            state.storage.transaction(async (local) => {
              const messages = await supportStorage(
                local,
                env,
                state.id?.toString() ?? "",
                false,
              );
              return messages.list<T>(options);
            }),
        }),
      ),
  },
  {
    // A workspace the manager deleted, purged in bounded steps
    // after its cancel window (workspace-deletion.ts).
    id: "workspace-deletion",
    run: (context, now) => workspaceDeletionAlarm(context, now),
  },
  {
    // Once a day while the workspace is on the offer: the runway, grant
    // and budget alerts read the day's balance and pace.
    id: "room-daily",
    run: async ({ state, env }, now) => {
      if (!(await state.storage.get(PRODUCT_STATE_KEY))) return null;
      await state.storage.transaction(async (storage) => {
        const view = await readProductAccess(storage, now, env);
        await emitBalanceAlerts(
          storage,
          null,
          now,
          {
            paceCentsPerDay: (await recentDebits(storage, now, 7)) / 7,
            monthCents: view.month.cents,
          },
          env,
        );
      });
      return now + 86_400_000;
    },
  },
] satisfies RoomAlarmConsumer[]);
/** The room's timed jobs in the order the alarm runs them. */
export function roomAlarmConsumers(): readonly RoomAlarmConsumer[] {
  return ROOM_ALARM_CONSUMERS;
}

/** Only worker-generated identity/provenance headers cross this private DO binding. */
export class ChannelRoom {
  protected readonly recoveryWork = new RecoveryWork();
  protected readonly recoveryHooks = {
    pause: (op: string) => this.recoveryWork.pause(op),
    resume: (op: string) => this.recoveryWork.resume(op),
  };
  private recoveryStartup: Promise<void> | undefined;
  private ensureRecoveryLock() {
    this.recoveryStartup ??= restoreStartupLock(
      this.state.storage,
      this.env as SafetyEnv,
    ).catch((error) => {
      this.recoveryStartup = undefined;
      throw error;
    });
    return this.recoveryStartup;
  }
  private funnelTask: Promise<void> | null = null;
  private funnelRequested = false;
  /** Whether this workspace may hold onboarding steps it has not sent:
   * unknown after a restart, then known from each flush and each mark. */
  private funnelUnsent = true;
  /** Support typing marks live only in this instance: an eviction or restart
   * drops them, and nothing writes them to storage. */
  private readonly typing = new SupportTyping();
  /** The case ledger reported ready once; it never goes back. Until then a
   * successful request asks the alarm to continue the backfill. */
  private ledgerReady = false;
  constructor(
    protected state: DurableObjectState,
    protected env: ProductBillingEnv = {},
  ) {
    this.searchIndex = new SearchIndex(state.storage);
  }
  /** Called once per request with the events written by its committed
   * transaction. Realtime delivery overrides this; nothing runs before commit. */
  protected afterCommit(events: ChatEvent[]): void {
    realtimeAfterCommit(this.state, events, this.env, agentHiddenConversations);
  } // Socket fan-out after commit
  /** Sends the onboarding steps this workspace marked
   * (`markWorkspaceStep`) and has not sent. A failed send keeps them for the
   * next request or the retry alarm. */
  private reportFunnel(): void {
    this.funnelRequested = true;
    if (this.funnelTask) return;
    const task = (async () => {
      while (this.funnelRequested) {
        this.funnelRequested = false;
        if (
          !(await flushWorkspaceSteps(
            this.state.storage,
            this.env as FunnelEnv,
          ))
        )
          throw new Error("Onboarding counts were not delivered.");
        this.funnelUnsent = false;
      }
    })()
      .catch(async () => {
        this.funnelUnsent = true;
        try {
          await wakeRoomAt(this.state.storage, Date.now() + 60_000);
        } catch {
          // The next committed write retries the delivery.
        }
      })
      .finally(() => {
        this.funnelTask = null;
      });
    this.funnelTask = task;
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(task);
  }
  /** Counts a turned-away member request after its transaction rolled back,
   * in a second small transaction on the room's own keys. Only member
   * writes the room marked are counted, never the canary's, and counting
   * never changes the member's answer. */
  private async countRefusal(
    error: unknown,
    context: ConversationContext | null,
  ) {
    const write = context?.memberWrite;
    if (!context || !write) return;
    if (context.canary && context.aliases.includes(context.canary)) return;
    const reason = refusalCauseFromError(error, context.refusalCause);
    if (!reason) return;
    try {
      await this.state.storage.transaction(async (local) => {
        const nowMs = Date.now();
        const counted = await recordSupportRefusal(local, {
          reason,
          clientId: write.clientId,
          nowMs,
        });
        // The first refusal of a reason in a UTC day alerts the team.
        if (counted.first)
          await emitRefusalAlert(
            local,
            this.env as never,
            {
              reason,
              day: new Date(nowMs).toISOString().slice(0, 10),
              count: 1,
            },
            nowMs,
          );
      });
    } catch {
      console.error("TEMPL_SUPPORT_REFUSAL_LEDGER_FAILED");
    }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (this.recoveryWork.paused) {
      ws.close(1013, "Workspace recovery in progress.");
      return;
    }
    return this.recoveryWork.run(async () => {
      await this.ensureRecoveryLock();
      if (await recoveryGate(this.state.storage, "/private/realtime/message")) {
        ws.close(1013, "Workspace recovery in progress.");
        return;
      }
      return realtimeMessage(
        this.state,
        ws,
        message,
        this.env as Env,
        agentHiddenConversations,
      );
    });
  }
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) {
    return realtimeClose(this.state, ws, code, reason, wasClean);
  }
  webSocketError(ws: WebSocket, error: unknown) {
    return realtimeError(this.state, ws, error);
  }
  async alarm() {
    if (this.recoveryWork.paused) {
      await wakeRoomAt(this.state.storage, Date.now() + 60_000);
      return;
    }
    return this.recoveryWork.run(() => this.runAlarm());
  }
  private async runAlarm() {
    // Recovery also holds billing jobs until access is reconciled.
    await this.ensureRecoveryLock();
    if (await recoveryAlarmHold(this.state.storage)) return;
    if (
      await stripeOwnerAlarm(
        this.state.storage,
        this.env as never,
        Date.now(),
        (work) => this.state.blockConcurrencyWhile(work),
      )
    )
      return;
    try {
      await this.assertManagerIsHuman();
    } catch (error) {
      await wakeRoomAt(this.state.storage, Date.now() + ROOM_ALARM_RECOVERY_MS);
      throw error;
    }
    // Every timed job reports its next due time; the alarm keeps the earliest.
    // A consumer that throws leaves a retry within a minute and skips the
    // funnel report below, as before.
    // Scheduled deletion keeps charge finalization running. Closing
    // workspaces also run deletion, retention, storage and recovery jobs.
    const closing = await workspaceClosing(this.state.storage);
    const paymentsPending =
      !closing && (await registerProductPayments(this.state.storage, this.env));
    await runRoomAlarm(
      {
        state: this.state,
        env: (await workspaceFeatureEnv(
          this.env as WorkspaceFlagEnv,
          this.state.storage,
        )) as never,
        searchIndex: this.searchIndex,
      },
      closing
        ? roomAlarmConsumers().filter((consumer) =>
            CLOSING_ALARM_CONSUMERS.has(consumer.id),
          )
        : roomAlarmConsumers(),
    );
    if (paymentsPending)
      await wakeRoomAt(this.state.storage, Date.now() + 10_000);
    if (this.funnelUnsent) this.reportFunnel();
  }
  /** Derived FTS5 index over current rows; unavailable without
   * SQLite storage. Kept in step with posts, edits, deletes and pruning. */
  protected searchIndex: SearchIndex;
  private async assertManagerIsHuman() {
    const native =
      await this.state.storage.get<NativeRoomRecord>("native-room");
    if (!native) return;
    const settings = await this.state.storage.get<object>("chat-settings");
    if (!settings)
      throw new HttpError(503, "AI agent settings are unavailable.");
    requireHumanManager(
      await aiPrincipals(
        this.state.storage,
        settings,
        `room:${native.room.id}`,
      ),
      native.room.manager,
    );
  }
  async fetch(request: Request) {
    if (new URL(request.url).pathname.startsWith("/private/recovery/"))
      return this.serve(request);
    if (this.recoveryWork.paused) return recoveryPausedResponse();
    return this.recoveryWork.run(() => this.serve(request));
  }
  private async serve(request: Request) {
    const marks = workspaceStepMarks();
    const response = await this.respond(request);
    if (workspaceStepMarks() !== marks) this.funnelUnsent = true;
    if (this.funnelUnsent) this.reportFunnel();
    queueRoomResources(this.state, this.env, [{
      kind: "requests", provider: "cloudflare", metric: "requests",
      quantity: "1", unit: "request",
      outcome: response.status < 400 ? "accepted" : "failed",
    }]);
    return response;
  }
  private async respond(request: Request) {
    try {
      await this.ensureRecoveryLock();
      const env = await workspaceFeatureEnv(
        this.env as ProductBillingEnv & WorkspaceFlagEnv,
        this.state.storage,
      );
      const roomHeaders = new Headers(request.headers);
      roomHeaders.set(
        DIAGNOSIS_NETWORKS_HEADER,
        diagnosisNetworksHeader(env as DiagnosisEnv),
      );
      const url = new URL(request.url);
      // Storage recovery: the restore routes, and a room restored to an
      // earlier time answers nothing else until its access is reconciled.
      const restoring = await recoveryGate(this.state.storage, url.pathname);
      if (restoring) return restoring;
      if (!await workspaceClosing(this.state.storage)) {
        const next = await this.state.storage.transaction((storage) =>
          continueCustomerDebtAccess(storage, Date.now()),
        );
        if (next !== null) await wakeRoomAt(this.state.storage, next);
      }
      if (["/private/support/encryption-checkpoint", "/private/support/encryption-advance", "/private/support/encryption-revoke-device"].includes(url.pathname)) {
        if (env.APP_ORIGIN !== "https://usetempl.com" || !env.OWN_SUPPORT_ENCRYPTION_ROOT ||
            request.headers.get("X-Native-Room-Id") !== OWN_SUPPORT_ENDPOINT.workspace ||
            (await this.state.storage.get<{room?: {id?: string}}>("native-room"))?.room?.id !== OWN_SUPPORT_ENDPOINT.workspace ||
            await workspaceClosing(this.state.storage)) return json({unavailable: true}, 503);
        if (url.pathname !== "/private/support/encryption-checkpoint") {
          if (request.method !== "POST") return json({unavailable: true}, 404);
          const body = await readJson(request);
          return this.state.storage.transaction(async storage => json(await (
            url.pathname === "/private/support/encryption-advance" ? advanceOwnAuthority : revokeOwnDevice
          )(storage, env.OWN_SUPPORT_ENCRYPTION_ROOT!, body)));
        }
        if (request.method !== "GET") return json({unavailable: true}, 404);
        return this.state.storage.transaction(async storage => json({
          permissionRevision: await storage.get<number>(ENCRYPTION_ACCESS_REVISION) ?? 0,
          deletionRevision: await storage.get<number>(ENCRYPTION_DELETION_REVISION) ?? 0,
          authority: await storage.get(OWN_AUTHORITY_CHECKPOINT) ?? null,
          at: Date.now(),
        }));
      }
      if (url.pathname === "/private/support/app-answer-failed" && request.method === "POST") {
        const body = await readJson(request);
        if (Object.keys(body).sort().join(",") !== "conversationId,jobId,workspaceId") return json({ accepted: false });
        await this.state.storage.transaction(storage => reportAppAnswerFailure(storage, body as never));
        return json({ accepted: true });
      }
      if (url.pathname === "/private/support/app-answer-authority" && request.method === "POST") {
        const body = await readJson(request);
        if (Object.keys(body).sort().join(",") !== "conversationId,jobId,workspaceId") return json({ allowed: false });
        const allowed = await this.state.storage.transaction(storage => appAnswerAllowed(storage, env as Env, body as never));
        return json({ allowed });
      }
      if (url.pathname === "/private/support/telegram-authority" && request.method === "POST") {
        const body = await readJson(request);
        if (Object.keys(body).sort().join(",") !== "approvalId,relayPrincipalId,workspaceId" ||
            typeof body.workspaceId !== "string" || typeof body.approvalId !== "string" || typeof body.relayPrincipalId !== "string")
          return json({ approved: false });
        try {
          const approved = await this.state.storage.transaction(storage => nativeTelegramApproved(storage, this.env, body as {
            workspaceId: string; approvalId: string; relayPrincipalId: string;
          }));
          return json({ approved });
        } catch { return json({ approved: false }); }
      }
      if (url.pathname.startsWith("/private/recovery/"))
        return roomRecoveryRoute(
          this.state,
          request,
          Date.now(),
          this.env,
          this.recoveryHooks,
        );
      await this.assertManagerIsHuman();
      // Member reply-email tickets, grants and unsubscribes;
      // reached only from the worker, never from a public room URL.
      if (
        url.pathname.startsWith("/private/support/alerts/") &&
        request.method === "POST"
      )
        return memberAlertsPrivateRoute(this.state, request, env as Env);
      if (request.headers.get("X-Realtime-Upgrade") === "1")
        return realtimeUpgrade(this.state, request); // Worker-forwarded socket upgrade; no other header is read
      if (
        url.pathname === "/private/realtime/end" &&
        request.method === "POST"
      ) {
        // The worker ends a widget sign-in's sockets
        // on this website (sign-out, a guest moving to a wallet).
        const body = await readJson(request);
        const principal = normalizeChatPrincipal(body.principal);
        if (!principal || typeof body.origin !== "string")
          throw new HttpError(400, "Invalid request.");
        return json({
          closed: endWidgetSockets(this.state, {
            principal,
            origin: body.origin,
          }),
        });
      }
      if (url.pathname === "/private/support/guest-opening-mode" && request.method === "POST") {
        const { workspace } = await readJson(request);
        return this.state.storage.transaction(async local => {
          const storage = await supportStorage(local, env, this.state.id?.toString() ?? "");
          const native = await storage.get<NativeRoomRecord>("native-room");
          if (!native || native.room.id !== workspace || workspace === OWN_SUPPORT_ENDPOINT.workspace ||
              workspace === (env as Env).TEMPL_SUPPORT_WORKSPACE)
            throw new HttpError(404, "Workspace not found.");
          return json({ mode: (await newCaseEncryptionView(storage)) ? "encrypted" : "standard" });
        });
      }
      if (url.pathname === "/private/support/own-new-chat-mode" && request.method === "POST") {
        return this.state.storage.transaction(async local => {
          const storage = await supportStorage(local, env, this.state.id?.toString() ?? "");
          const native = await storage.get<NativeRoomRecord>("native-room");
          if (!native || native.room.id !== OWN_SUPPORT_ENDPOINT.workspace || native.room.id !== (env as Env).TEMPL_SUPPORT_WORKSPACE)
            throw new HttpError(404, "Workspace not found.");
          return json({ mode: await ownNewChatMode(storage, (env as Env).OWN_SUPPORT_ENCRYPTION_ROOT) });
        });
      }
      if (url.pathname === "/private/support/own-encrypted-wallet-auth" && request.method === "POST") {
        const input = await readJson(request);
        if (Object.keys(input).length !== 1 || typeof input.origin !== "string")
          throw new HttpError(400, "Invalid request.");
        await this.state.storage.transaction(async (local) => {
          const storage = await supportStorage(local, env, this.state.id?.toString() ?? "");
          const native = await storage.get<NativeRoomRecord>("native-room");
          if (!native) throw new HttpError(404, "Workspace not found.");
          await requireOwnWidgetWallet(storage, env as Env, native.room.id, input.origin as string);
        });
        return json({ available: true });
      }
      if (["/private/support/share-wallet", "/private/support/unlink-wallet"].includes(url.pathname) && request.method === "POST") {
        const body = await readJson(request);
        const committed = await this.state.storage.transaction(async (local) => {
          const storage = await supportStorage(local, env, this.state.id?.toString() ?? "");
          const pending: PendingEvent[] = [];
          await shareGuestWalletProof(storage, body, pending,
            url.pathname === "/private/support/unlink-wallet");
          return pending.length ? appendEvents(storage, pending, Date.now()) : [];
        });
        this.afterCommit(committed);
        return json({ saved: true });
      }
      if (
        ["/private/support/widget-verify", "/private/support/own-encrypted-widget-verify"].includes(url.pathname) &&
        request.method === "POST"
      ) {
        // Called only by the widget worker after it checked the SIWE proof and
        // the guest's own bearer; a public room URL never reaches /private.
        const input = widgetVerification(await readJson(request), {
          loopback: loopbackOffered(env as WidgetSessionEnv),
        });
        let committed: ChatEvent[] = [];
        const outcome = await this.state.storage.transaction(async (local) => {
          const storage = await supportStorage(
            local,
            env,
            this.state.id?.toString() ?? "",
          );
          const native = await storage.get<NativeRoomRecord>("native-room");
          if (!native) throw new HttpError(404, "Workspace not found.");
          if (url.pathname === "/private/support/own-encrypted-widget-verify")
            await requireOwnWidgetWallet(storage, env as Env, native.room.id, input.origin);
          const now = Date.now();
          const pending: PendingEvent[] = [];
          const pendingAudit: PendingAudit[] = [];
          const result = await verifyWidgetMember(storage, input, {
            room: `room:${native.room.id}`,
            now,
            pending,
            pendingAudit,
            admitMember: (id) => admitRoomMember(storage, id, null),
            mediaEnv: env,
          });
          for (const entry of pendingAudit)
            await appendAudit(storage, entry, now);
          if (pending.length)
            committed = await appendEvents(storage, pending, now);
          return result;
        });
        this.afterCommit(committed);
        const priorityRead = runPriorityVerifications(
          this.state,
          this.env as Env,
        ).catch(() => undefined);
        if (typeof this.state.waitUntil === "function")
          this.state.waitUntil(priorityRead);
        return json(outcome);
      }
      if (
        url.pathname === "/private/support/audit-import" &&
        request.method === "POST"
      ) {
        // Widget settings changes from the widget settings object's outbox,
        // sent by the worker after a manager's save or open.
        const entries = widgetAuditImport(await readJson(request));
        const upTo = await this.state.storage.transaction(async (local) => {
          if (!(await local.get("native-room")))
            throw new HttpError(404, "Workspace not found.");
          const mark = await local.get<unknown>(WIDGET_AUDIT_MARK);
          if (
            mark !== undefined &&
            !(Number.isSafeInteger(mark) && (mark as number) >= 0)
          )
            throw new HttpError(503, "The activity log is unavailable.");
          // Entries at or below the mark are already in the log.
          const from = (mark as number | undefined) ?? 0;
          let high = from;
          for (const entry of entries) {
            if (entry.seq <= high) continue;
            await appendAudit(
              local,
              {
                actor: entry.actor,
                action: entry.action,
                target: null,
                ...(entry.authenticatedAt === null
                  ? {}
                  : {
                      authenticatedAt: new Date(
                        entry.authenticatedAt,
                      ).toISOString(),
                    }),
                before: entry.before,
                after: entry.after,
              },
              entry.at,
            );
            high = entry.seq;
          }
          if (high !== from) await local.put(WIDGET_AUDIT_MARK, high);
          return high;
        });
        return json({ upTo });
      }
      if (
        url.pathname === "/private/support/health" &&
        request.method === "POST"
      ) {
        // Fixed labels for /health/support and the staging canary, read in
        // one snapshot. It writes nothing; a public room URL never reaches
        // /private.
        const body = await readJson(request);
        return json(
          await this.state.storage.transaction((local) =>
            supportHealth(local, body, Date.now()),
          ),
        );
      }
      if (
        url.pathname === "/private/support-media-reference" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const native =
          await this.state.storage.get<NativeRoomRecord>("native-room");
        const room = typeof body.room === "string" ? body.room : "";
        const referenced =
          Boolean(native && room === `room:${native.room.id}`) &&
          (await supportMediaReferenced(this.state.storage, {
            room,
            conversation:
              typeof body.conversation === "string" ? body.conversation : "",
            attachment:
              typeof body.attachment === "string" ? body.attachment : "",
            objectId: typeof body.objectId === "string" ? body.objectId : "",
            contentHash:
              typeof body.contentHash === "string" ? body.contentHash : "",
            bytes: Number(body.bytes),
          }));
        return json({ referenced });
      }
      if (
        url.pathname === "/private/group-media-reference" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const native =
          await this.state.storage.get<NativeRoomRecord>("native-room");
        const referenced =
          Boolean(native && body.room === `room:${native.room.id}`) &&
          (await groupMediaReferenced(this.state.storage, {
            channel: typeof body.channel === "string" ? body.channel : "",
            id: typeof body.id === "string" ? body.id : "",
            owner: typeof body.owner === "string" ? body.owner : "",
          }));
        return json({ referenced });
      }
      // The manager's deletion request, cancel, the operator's
      // speed-up and the state reads (the worker is the only caller).
      if (
        url.pathname === "/private/workspace-deletion" &&
        request.method === "POST"
      )
        return await workspaceDeletionRoomRequest(this.state, request);
      if (
        url.pathname === "/private/native-catalog" &&
        request.method === "POST"
      ) {
        const body = await readJson(request, 24_000);
        return await this.state.storage.transaction((storage) =>
          nativeCatalogRequest(
            storage,
            body,
            siteOrigins(env as Env).communityOrigin,
          ),
        );
      }
      if (url.pathname === "/private/onboarding" && request.method === "POST") {
        const body = await readJson(request, 1024);
        if (
          typeof body.name !== "string" ||
          !Object.hasOwn(ANALYTICS_SOURCES, body.name)
        )
          throw new HttpError(400, "Invalid onboarding event.");
        return await workspaceOnboarding(this.state.storage, this.env, {
          name: body.name as AnalyticsEvent,
          principalId: principal(body.principalId),
          servicePrincipals: servicePrincipals(
            principal(body.principalId),
            body.servicePrincipals,
          ),
        });
      }
      const nativeControl =
        /^\/private\/native\/(create|read|manager|accept-manager|slug|profile)$/.exec(
          url.pathname,
        );
      if (nativeControl && request.method === "POST") {
        const body =
          nativeControl[1] === "read"
            ? { visitorReplyPolicy: request.headers.get("X-Widget-Reply-Policy") === "1" }
            : await readJson(request, 24_000);
        const op = nativeControl[1];
        let committed: ChatEvent[] = [];
        const response = await this.state.storage.transaction(
          async (storage) => {
            if (op === "manager" || op === "accept-manager") {
              const actor = principal(body.principalId);
              const actorIds = servicePrincipals(actor, body.servicePrincipals);
              const targetIds =
                op === "manager" && body.next !== null
                  ? principalsFromHeaders(
                      new Headers({
                        "X-Target-Service-Principals": JSON.stringify(
                          body.nextServicePrincipals,
                        ),
                      }),
                      principal(body.next),
                      true,
                    )
                  : [];
              if (
                await templStaffAccount(
                  storage,
                  [...actorIds, ...targetIds],
                  this.env,
                )
              )
                throw new HttpError(
                  403,
                  "Templ people cannot manage a customer workspace.",
                );
            }
            let adminProfile = false;
            if (op === "profile") {
              const actor = principal(body.principalId);
              const aliases = servicePrincipals(actor, body.servicePrincipals);
              adminProfile = await currentHumanAdmin(storage, actor, aliases, this.env);
            }
            const result = await nativeControlRequest(
              storage,
              op,
              body,
              siteOrigins(env as Env).communityOrigin,
              env,
              adminProfile,
            );
            if (result.ok && (op === "manager" || op === "accept-manager"))
              await reconcileOrderFormNoticeRecipients(
                storage,
                Date.now(),
                this.env,
              );
            if (
              result.ok &&
              (op === "manager" ||
                op === "accept-manager" ||
                op === "slug" ||
                op === "profile")
            ) {
              const now = Date.now();
              const actor = principal(body.principalId);
              await appendAudit(
                storage,
                op === "manager"
                  ? {
                      actor,
                      action: "manager.nominate",
                      authenticatedAt: new Date(
                        Number(body.authenticatedAt),
                      ).toISOString(),
                      target:
                        body.next === null
                          ? null
                          : principal(body.next as string),
                    }
                  : op === "profile"
                    ? { actor, action: "room.profile", target: null }
                    : {
                        actor,
                        action: "manager.accept",
                        target: actor,
                        ...(op === "accept-manager"
                          ? {
                              authenticatedAt: new Date(
                                Number(body.authenticatedAt),
                              ).toISOString(),
                            }
                          : {}),
                      },
                now,
              );
              committed = await appendEvents(
                storage,
                [{ type: "room.updated" }],
                now,
              );
            }
            return result;
          },
        );
        this.afterCommit(committed);
        if (op === "read" && response.ok)
          response.headers.set(
            WORKSPACE_FEATURES_HEADER,
            JSON.stringify(workspaceFeatureValues(env)),
          );
        return response;
      }
      if (url.pathname === WORKSPACE_FLAGS_INDEX_PATH) {
        const body = request.method === "POST" ? await readJson(request) : {};
        return await this.state.storage.transaction((storage) =>
          workspaceFlagsIndexRequest(storage, {
            method: request.method,
            body,
            query: url.searchParams,
          }),
        );
      }
      if (
        url.pathname === WORKSPACE_FLAGS_ROOM_PATH &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const result = await this.state.storage.transaction((storage) =>
          roomWorkspaceFlagsRequest(storage, env, body),
        );
        await scheduleWorkspaceFlags(this.state.storage, env);
        return result;
      }
      if (
        url.pathname === WORKSPACE_FEATURES_ROOM_PATH &&
        request.method === "POST"
      ) {
        if (!(await this.state.storage.get("native-room")))
          throw new HttpError(404, "Workspace not found.");
        return json({
          features: await workspaceFeatures(env, this.state.storage),
        });
      }
      if (url.pathname === ROOM_GRANT_STATUS_PATH && request.method === "POST")
        // Reviewed grants for /operator/grants: apply, then report fixed
        // fields. A public room URL never reaches /private.
        return await this.state.storage.transaction((local) =>
          roomGrantStatusRequest(
            local,
            env as ProductGrantsEnv,
            Date.now(),
            (owner, room) =>
              reserveOwnerRegistry(env, {
                kind: "founding",
                owner,
                room,
                domain: null,
              }),
          ),
        );
      if (
        url.pathname === FREE_START_REGISTRY_PATH &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        return this.state.storage.transaction((storage) =>
          freeStartRegistryRequest(storage, body),
        );
      }
      // The operator billing index, and one workspace's billing
      // for /operator/billing. A public room URL never reaches /private.
      if (url.pathname === STRIPE_OWNER_PATH && request.method === "POST") {
        const body = await readJson(request);
        const response = await this.state.blockConcurrencyWhile(async () => {
          try {
            return await stripeOwnerRequest(
              this.state.storage as never,
              env as never,
              body,
              Date.now(),
            );
          } catch (error) {
            if (error instanceof HttpError)
              return json(
                errorBody(error, "Card billing is not available."),
                error.status,
              );
            throw error;
          }
        });
        try {
          await deliverStripeOwnerUpdates(
            this.state.storage,
            env as never,
            Date.now(),
          );
        } catch {
          await wakeRoomAt(this.state.storage, Date.now() + 60_000);
        }
        return response;
      }
      if (url.pathname === STRIPE_INDEX_PATH && request.method === "POST") {
        const body = await readJson(request);
        return await this.state.storage.transaction((storage) =>
          stripeIndexRequest(storage, body),
        );
      }
      if (url.pathname === STRIPE_ROOM_PATH && request.method === "POST") {
        const body = await readJson(request);
        return await this.state.storage.transaction((storage) =>
          stripeRoomStateRequest(storage, body, Date.now(), this.env),
        );
      }
      if (url.pathname === BILLING_INDEX_PATH) {
        const body = request.method === "POST" ? await readJson(request) : {};
        return this.state.storage.transaction((storage) =>
          billingIndexRequest(storage, {
            method: request.method,
            body,
            query: url.searchParams,
          }),
        );
      }
      if (url.pathname === STORAGE_OPERATOR_PATH && request.method === "POST") {
        const body = await readJson(request, 65_536);
        return await this.state.storage.transaction((storage) => storageOperatorRequest(storage, env as never, body, Date.now()));
      }
      if (url.pathname === ROOM_ORDER_FORMS_PATH && request.method === "POST") {
        const body = await readJson(request);
        let committed: ChatEvent[] = [];
        const response = await this.state.storage.transaction(
          async (storage) => {
            const result = await roomOrderFormsRequest(
              storage,
              this.env as never,
              body,
              Date.now(),
            );
            if (body.op === "action")
              committed = await appendEvents(
                storage,
                [{ type: "room.updated" }],
                Date.now(),
              );
            return result;
          },
        );
        this.afterCommit(committed);
        return response;
      }
      if (
        url.pathname === ROOM_OPERATOR_BILLING_PATH &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        if (body.op === "cost-finance") {
          if (
            typeof body.month !== "string" ||
            !Number.isSafeInteger(body.asOf) ||
            Number(body.asOf) > Date.now()
          )
            throw new HttpError(400, "Choose a valid accounting snapshot.");
          return json(
            await workspaceCostFinance(
              this.state.storage,
              body.month,
              Number(body.asOf),
            ),
          );
        }
        let reservation:
          | {
              reservation: PaymentReservation;
              replaced: PaymentReservation | null;
            }
          | undefined;
        // Awaited, so a refused action answers with its own status.
        let response: Response;
        try {
          response = await this.state.storage.transaction(async (storage) => {
            const native = await storage.get<NativeRoomRecord>("native-room");
            if (!native) throw new HttpError(404, "Workspace not found.");
            return roomOperatorBillingRequest(storage, body, Date.now(), {
              env: this.env,
              room: `room:${native.room.id}`,
              reservationCreated: (created, replaced) => {
                reservation = { reservation: created, replaced };
              },
              deferRegistration: () => {},
              payerManager: async (network, payer) => {
                const owner = await walletOwner(this.env, network, payer);
                if (!owner) return null;
                const identity = await identityRequest(this.env as Env, {
                  op: "read",
                  principalId: owner,
                });
                const settings =
                  (await storage.get<Settings>("chat-settings")) ?? initial();
                const agents = await aiPrincipals(
                  storage,
                  settings,
                  `room:${native.room.id}`,
                );
                if (
                  identity.servicePrincipals.some((id) => agents.includes(id))
                )
                  return null;
                if (
                  identity.servicePrincipals.includes(
                    native.room.manager as ChatPrincipalId,
                  )
                )
                  return owner;
                const manual =
                  (await storage.get<Record<string, { enabled?: boolean }>>(
                    "native-manual-roles",
                  )) ?? {};
                for (const alias of identity.servicePrincipals) {
                  const assigned =
                    (await storage.get<string[]>(`roles:${alias}`)) ?? [];
                  if (
                    settings.roles.some(
                      (role) =>
                        assigned.includes(role.id) &&
                        role.enabled !== false &&
                        manual[role.id] &&
                        manual[role.id].enabled !== false &&
                        role.moderationPermissions?.includes("manageBilling"),
                    )
                  )
                    return owner;
                }
                return null;
              },
            });
          });
        } catch (error) {
          if (reservation)
            await paymentLedgerCall(
              this.env,
              "cancel-reservation",
              reservation,
            );
          throw error;
        }
        if (response.ok && body.action === "payment-request") {
          await wakeRoomAt(this.state.storage, Date.now() + 10_000);
          await registerProductPayments(this.state.storage, this.env);
          const events = await this.state.storage.transaction((storage) =>
            appendEvents(storage, [{ type: "room.updated" }], Date.now()),
          );
          this.afterCommit(events);
        }
        if (
          response.ok &&
          body.action === "unmatched" &&
          body.answer === "credit"
        ) {
          const native =
            await this.state.storage.get<NativeRoomRecord>("native-room");
          await paymentLedgerCall(this.env, "operator-complete", {
            paymentId: body.paymentId,
            workspace: `room:${native!.room.id}`,
            usdCents: body.usdCents,
          });
        }
        if (
          response.ok &&
          body.action === "unmatched" &&
          body.answer !== "credit"
        ) {
          const native =
            await this.state.storage.get<NativeRoomRecord>("native-room");
          await paymentLedgerCall(this.env, "unmatched-return", {
            paymentId: body.paymentId,
            workspace: `room:${native!.room.id}`,
          });
        }
        return response;
      }
      if (
        /^\/private\/product\/payment-(event|credit)$/.test(url.pathname) &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const nowMs = Date.now();
        const saved = await productPaymentRequest(
          this.state.storage,
          String(body.requestId),
        );
        if (!saved) throw new HttpError(404, "Payment request not found.");
        const paymentRuntime = this.env as Env;
        if (!paymentRuntime.ROOMS)
          throw new HttpError(503, "Payments are unavailable.");
        const paymentEnv = this.env;
        // Provider reads finish before the credit transaction. Their room
        // usage writes must commit even when a payment is still confirming.
        const tx =
          saved.kind === "evm"
            ? String(body.tx).toLowerCase()
            : String(body.tx);
        const credited =
          saved.receipt?.txHash === tx ||
          saved.receipts?.some((receipt) => receipt.txHash === tx);
        const proof =
          url.pathname.endsWith("payment-credit") && !credited
            ? await paymentScannerCall(this.env, saved.network, "verify", {
                requestId: saved.id,
                tx: String(body.tx),
                intent: publicPaymentIntent(saved),
              }).then(
                (result) => ({
                  transfer: result.transfer as VerifiedProductTransfer,
                }),
                (error: unknown) => ({ error }),
              )
            : undefined;
        let events: ChatEvent[] = [];
        let completion:
          | {
              paymentId: string;
              receipt: ProductPaymentReceipt;
              intent: ProductPaymentIntent;
            }
          | undefined;
        const response = await this.state.storage.transaction(
          async (storage) => {
            const intent = await productPaymentRequest(
              storage,
              String(body.requestId),
            );
            if (!intent) throw new HttpError(404, "Payment request not found.");
            const result = url.pathname.endsWith("payment-event")
              ? await updateProductPaymentEvent(storage, body as never, nowMs)
              : await settleProductPayment(storage, {
                  room: intent.room,
                  nowMs,
                  body: { requestId: intent.id, tx: body.tx },
                  principalId: intent.principalId,
                  env: paymentEnv,
                  finalize: true,
                  verifyTransfer: async () => {
                    if (!proof || "error" in proof)
                      throw (
                        proof?.error ??
                        new HttpError(503, "Payments are unavailable.")
                      );
                    return proof.transfer;
                  },
                  walletOwner: (network, address) =>
                    walletOwner(this.env, network, address),
                  deferCompletion: (paymentId, receipt, intent) => {
                    completion = { paymentId, receipt, intent };
                  },
                });
            events = await appendEvents(
              storage,
              [{ type: "room.updated" }],
              nowMs,
            );
            return json(result);
          },
        );
        this.afterCommit(events);
        if (completion) {
          const { paymentId, receipt, intent } = completion;
          await paymentLedgerCall(this.env, "complete", {
            paymentId,
            workspace: intent.workspace,
            receipt,
          });
          if (intent.status === "credited") {
            await paymentLedgerCall(this.env, "release", {
              payer: intent.payer,
              rail: intent.rail,
              requestId: intent.id,
              workspace: intent.workspace,
            });
            await paymentScannerCall(this.env, intent.network, "close", {
              requestId: intent.id,
              status: "credited",
            });
          }
        }
        return response;
      }
      if (url.pathname === "/private/rpc-budget" && request.method === "POST") {
        const body = await readJson(request);
        return await this.state.storage.transaction((storage) =>
          rpcBudgetRequest(storage, body),
        );
      }
      // The read-only decoder's ABI catalog, in the named catalog object.
      // Only `abiCatalogCache` asks it, through the Worker-to-DO binding.
      if (
        url.pathname === "/private/abi-catalog" &&
        request.method === "POST"
      ) {
        const body = await readJson(request, 256_000);
        const now = Number.isSafeInteger(body.nowMs)
          ? (body.nowMs as number)
          : Date.now();
        return await this.state.storage.transaction((storage) =>
          abiCatalogRequest(storage, body, now),
        );
      }
      if (
        url.pathname === "/private/account-quota" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        return await this.state.storage.transaction((storage) =>
          accountQuotaRequest(storage, body),
        ); // Per-account rolling quotas across rooms
      }
      let manager = principal(request.headers.get("X-Verified-Manager"));
      let pendingManager = request.headers.get("X-Verified-Pending-Manager");
      const walletHeader = request.headers.get("X-Verified-Wallet");
      const requestedWallet = walletHeader ? address(walletHeader) : null;
      const principalHeader = request.headers.get("X-Verified-Principal");
      const requestedActor = principalHeader
        ? principal(principalHeader)
        : null;
      // Bounded imports and scoped install forwarding.
      // Current session and room checks remain authoritative.
      const body =
        request.method === "POST"
          ? await readSupportJson(
              request,
              url.pathname,
              url.pathname === "/private/priority-trial-capture"
                ? PRIORITY_CAPTURE_MAX_ROW_BYTES + 2048
                : /^\/conversations\/tc-[0-9a-f]{32}\/workflow$/.test(
                      url.pathname,
                    )
                  ? SUPPORT_UPLOAD_ENVELOPE_BYTES
                  : supportImportBodyBytes(url.pathname),
            )
          : {};
      // Collected during the mutation and written only with a successful result,
      // inside the same transaction. Nothing is published before commit.
      const pending: PendingEvent[] = [];
      const pendingAudit: PendingAudit[] = [];
      let committed: ChatEvent[] = [];
      let stripeAction: Parameters<typeof managerStripeAction>[2] | undefined;
      let paymentReservation:
        | {
            reservation: PaymentReservation;
            replaced: PaymentReservation | null;
          }
        | undefined;
      let paymentRegistration = false;
      let paymentCommitted = false;
      let paymentScannerWork: ProductPaymentScannerWork | undefined;
      let submittedScannerResult:
        | { requestId: string; value: Record<string, unknown> }
        | undefined;
      // The conversation context this request built, read after a refused
      // member write rolled back so the refusal can be counted.
      const conversationRequest: { context: ConversationContext | null } = {
        context: null,
      };
      const handle = async (
        storage: Storage,
        reserveRoomGrowth: () => Promise<void>,
        cardRecheck = false,
        scannerResult?: ProductPaymentScannerResult,
      ): Promise<Response> => {
        const settings =
          (await storage.get<Settings>("chat-settings")) ?? initial();
        botsFromSettings(settings);
        botsRevision(settings);
        const nativeId = request.headers.get("X-Native-Room-Id");
        const native = await storage.get<NativeRoomRecord>("native-room");
        if (!native || native.room.id !== nativeId)
          throw new HttpError(404, "Chat not found.");
        const agents = await aiPrincipals(
          storage,
          settings,
          `room:${native.room.id}`,
        );
        requireHumanManager(agents, native.room.manager);
        const recordedAgents = aiPrincipalsFromSettings(settings);
        const registeredAgents = botsFromSettings(settings).map(
          (bot) => bot.principalId,
        );
        const localRoles =
          (await storage.get<
            Record<string, Extract<ChatRoleTerms, { mode: "manual" }>>
          >("native-manual-roles")) ?? {};
        // Ownership is read in the same transaction as the requested action.
        manager = native.room.manager;
        pendingManager = native.room.pendingManager;
        const deadline = Number(request.headers.get("X-Access-Expires-At"));
        const accessCurrent = !deadline || deadline > Date.now();
        const sessionDeadline = request.headers.get("X-Session-Expires-At");
        // A balance lease can expire while the signed session remains valid.
        // Preserve that identity so the client refreshes access without signing
        // again; older internal callers still use their combined deadline.
        const principalCurrent =
          sessionDeadline === null
            ? accessCurrent
            : Number.isSafeInteger(Number(sessionDeadline)) &&
              Number(sessionDeadline) > Date.now();
        const actor = principalCurrent ? requestedActor : null;
        const aliases = actor
          ? principalsFromHeaders(request.headers, actor)
          : [];
        const wallet = principalCurrent ? requestedWallet : null;
        const actorIsAgent = aliases.some((id) => agents.includes(id));
        const isRoomManager = Boolean(
          principalCurrent &&
          accessCurrent &&
          actor &&
          !actorIsAgent &&
          !(await templStaffAccount(storage, aliases, this.env)) &&
          actsAs(aliases, native.room.manager),
        );
        const policy = await roomPrivacy(storage, native.room);
        const appearance = accentColor(
          (await storage.get<{ accentColor: string }>("room-appearance"))
            ?.accentColor ?? native.room.accentColor,
        );
        if (url.pathname === "/private/privacy" && request.method === "POST")
          return roomPrivacyRequest(storage, body, {
            policy,
            actor: principalCurrent ? actor : null,
            isManager: isRoomManager,
            servicePrincipals: aliases,
          });
        if (url.pathname === "/team-invites" && request.method === "POST") {
          if (
            !(await featureOn(this.env, storage, "teamInvites")) ||
            env.SUPPORT_WORKFLOW_ENABLED !== "true"
          )
            throw new HttpError(
              503,
              "Team invitation links are not available in this workspace.",
            );
          if (await readDeletionState(storage))
            throw new HttpError(410, "This workspace is being deleted.");
          const result = await teamInviteRequest(storage, body, {
            actor,
            aliases,
            manager: native.room.manager,
            isManager: isRoomManager,
            admin: Boolean(actor && accessCurrent && await currentHumanAdmin(storage, actor, aliases, this.env)),
            roles: settings.roles,
            manualRoles: localRoles,
            bots: botsFromSettings(settings).map((bot) => bot.principalId),
            policy,
            headers: request.headers,
            env: this.env,
            pendingAudit,
            reserveRoomGrowth,
            onAssigned: (roleId) =>
              pending.push({ type: "role.updated", roleId }),
          });
          return result;
        }
        const membership = await privacyStatus(
          storage,
          policy,
          principalCurrent ? actor : null,
          isRoomManager,
          aliases,
        );
        // Setup is the only exception for an untouched room. Public reads
        // must never initialize its privacy.
        const settingUp =
          !policy.initialized &&
          isRoomManager &&
          url.pathname === "/setup" &&
          request.method === "POST";
        if (!settingUp) requireRoomAccess(membership);
        if (url.pathname === "/channels" && request.method === "GET" && accessCurrent) {
          const recovery = await recoverDemoAdmin(storage, {
            native, actor, aliases, roles: settings.roles, manual: localRoles,
            agents, env: this.env, reserveGrowth: reserveRoomGrowth,
          });
          if (recovery) {
            pendingAudit.push(recovery);
            pending.push({ type: "role.updated", roleId: "support-admin" });
          }
        }
        if (url.pathname === "/workspace-flags" && request.method === "GET")
          return managerWorkspaceFlags(storage, isRoomManager, this.env);
        // Staff powers come only from manual roles. A stored role without a
        // manual record (a token, hold or payment rule) is left out.
        const roles: ChatRole[] = settings.roles.flatMap((role) => {
          const terms = localRoles[role.id];
          if (!terms) return [];
          const known = knownPermissions(role.moderationPermissions);
          // Stored records can carry token and purchase fields; none is read.
          return [
            {
              id: role.id,
              name: role.name,
              mode: "manual" as const,
              revision: terms.revision,
              enabled: terms.enabled,
              ...(known.length ? { moderationPermissions: known } : {}),
            },
          ];
        });
        const mute = (await aliasValues<string>(storage, "mute:", aliases))
          .filter((value): value is string => typeof value === "string")
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
        const manualRoles = await assignedRoleIds(
          storage,
          aliases,
          this.env,
          Date.now(),
        );
        const actorPermissions = rolePermissions(
          settings,
          roles
            .filter(
              (role) =>
                role.mode === "manual" &&
                role.enabled !== false &&
                manualRoles.includes(role.id),
            )
            .map((role) => role.id),
          actorIsAgent,
        );
        const viewer: ChatViewer = {
          principalId: actor,
          isMember: membership.isMember,
          wallet,
          isManager: isRoomManager,
          permissions: isRoomManager
            ? [...MODERATOR_PERMISSIONS]
            : actor
              ? actorPermissions
              : [],
          roleIds: roles
            .filter(
              (role) =>
                Boolean(actor) &&
                role.enabled &&
                manualRoles.includes(role.id) &&
                (!actorIsAgent || aiRole(role)),
            )
            .map((role) => role.id),
          banned:
            !isRoomManager &&
            (await aliasValues<string>(storage, "ban:", aliases)).some(Boolean),
          mutedUntil:
            !isRoomManager && mute && Date.parse(mute) > Date.now()
              ? mute
              : null,
        };
        const productRoom = `room:${native.room.id}`;
        if (
          /^\/product\/card\/(setup|portal|method)$/.test(url.pathname) &&
          request.method === "POST"
        ) {
          if (await readDeletionState(storage))
            throw new HttpError(
              410,
              "This workspace is being deleted. Only the manager can open it.",
              undefined,
              "workspace-deleting",
            );
          const product = await productRoute(storage, {
            pathname: url.pathname,
            method: request.method,
            body,
            query: url.searchParams,
            viewer,
            nowMs: Date.now(),
            room: productRoom,
            headers: roomHeaders,
            env: env,
            deferStripeAction: (action) => {
              if (!cardRecheck) stripeAction = action;
            },
          });
          if (product) return product;
        }
        await initializeProducts(storage, {
          creator: native.room.creator,
          room: productRoom,
          nowMs: Date.now(),
        });
        if (await storage.get(PRODUCT_STATE_KEY)) {
          // Reviewed grants from the PRODUCT_GRANTS policy var. A founding
          // credit is one per billing owner, kept in the owner registry.
          const applied = await applyProductGrants(
            storage,
            env as ProductGrantsEnv,
            productRoom,
            Date.now(),
            (owner, room) =>
              reserveOwnerRegistry(env, {
                kind: "founding",
                owner,
                room,
                domain: null,
              }),
          );
          if (applied.credited.length)
            await registerBillingWorkspace(env, native.room.id);
        }
        if (/^\/private\/prepaid-ai\/(reserve|settle)$/.test(url.pathname)) {
          const billingPrincipal = actor && (actor === await managedPrincipal(productRoom) || actor === hostedPrepaidPrincipal(native.room.id));
          if (request.method !== "POST" || !accessCurrent || !billingPrincipal || !actorIsAgent ||
              !registeredAgents.includes(actor!) || viewer.banned || viewer.mutedUntil ||
              !viewer.permissions.includes("handleConversations"))
            throw new HttpError(404, "Not found.");
          try {
            return json(url.pathname.endsWith("/reserve")
              ? await reservePrepaidAi(storage, body, actor!, Date.now(), env)
              : await settlePrepaidAi(storage, body, actor!, Date.now(), env));
          } catch (error) {
            // Commit bounded orphan absorption even when the next admission is refused.
            // These refusal branches run before a new hold can be written.
            if (url.pathname.endsWith("/reserve") && error instanceof HttpError &&
                ["prepaid-period-required", "prepaid-model-mismatch", "prepaid-attempt-used", "prepaid-ai-held", "prepaid-ai-paced", "prepaid-credit-required"].includes(error.reason ?? ""))
              return json(errorBody(error, "AI request is unavailable."), error.status,
                error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
            throw error;
          }
        }
        // The room identity every conversation record is bound to.
        const conversationRoom = productRoom;
        const currentState = async () => {
          const productView = await readProductAccess(storage, Date.now(), env);
          const productSafeView =
            !productView.billingManagedByTempl &&
            (viewer.isManager || viewer.permissions.some(
              (permission) => String(permission) === "manageBilling",
            ))
              ? productView
              : memberProductView(productView);
          return {
            ...(Object.values(workspaceFeatureValues(env)).some(Boolean)
              ? { features: workspaceFeatureValues(env) }
              : {}),
            product: productSafeView,
            visibility: policy.visibility,
            accentColor: appearance,
            roles,
            manager,
            pendingManager: pendingManager || null,
            viewer,
            bots: botsFromSettings(settings),
          };
        };
        if (url.pathname === "/channels" && request.method === "GET")
          return json(await currentState());
        {
          const product = await productRoute(storage, {
            pathname: url.pathname,
            method: request.method,
            body,
            query: url.searchParams,
            viewer,
            nowMs: Date.now(),
            room: conversationRoom,
            headers: roomHeaders,
            env: env,
            deferStripeAction: (action) => {
              stripeAction = action;
            },
            reservationCreated: (created, replaced) => {
              paymentReservation = { reservation: created, replaced };
            },
            deferRegistration: () => {
              paymentRegistration = true;
            },
            deferScanner: (work) => {
              paymentScannerWork = work;
              if (
                work.action === "submit" &&
                work.intent.settlement === "standard-prepaid"
              )
                paymentRegistration = true;
            },
            scannerResult,
          });
          if (product) {
            if (
              (product.ok ||
                (product.status === 409 &&
                  url.pathname === "/product/crypto/receipt")) &&
              request.method === "POST" &&
              url.pathname.startsWith("/product/crypto/")
            )
              pending.push({ type: "room.updated" });
            return product;
          }
        }
        // Bot registry routes
        {
          if (request.method === "POST" && url.pathname.startsWith("/bots") &&
              !viewer.isManager && canManageWorkspace(viewer, actorIsAgent))
            requireWorkspaceAdminHeaders(request.headers, false, body.confirmed);
          const bots = await botsRoute(storage, {
            operatorEnv: this.env,
            method: request.method,
            pathname: url.pathname,
            body,
            viewer,
            targetPrincipals:
              url.pathname === "/bots" && request.method === "POST"
                ? principalsFromHeaders(
                    request.headers,
                    principal(body.principalId),
                    true,
                  )
                : undefined,
            pending,
            pendingAudit,
          });
          if (bots) return bots;
        }
        {
          const context: ConversationContext = {
            appOrigin: siteOrigins(env as Env).appOrigin,
            method: request.method,
            pathname: url.pathname,
            query: url.searchParams,
            body,
            headers: roomHeaders,
            viewer,
            aliases,
            manager: manager as ChatPrincipalId,
            room: conversationRoom,
            mediaEnv: env as Env,
            visibility: policy.visibility === "private" ? "private" : "public",
            reserveFreeStart: async (creator, room, origin) => {
              const allowed = await reserveFreeStartRegistry(env, {
                owner: creator,
                room,
                origins: origin ? [origin] : [],
              });
              await registerBillingWorkspace(env, room.slice(5));
              return allowed;
            },
            isRoomMember: async (id) =>
              actsAs(aliases, id)
                ? membership.isMember
                : Boolean(
                    (await storage.get(`room-member:${id}`)) ||
                    (native && actsAs([id], native.room.manager)),
                  ),
            isSupportStaff: async (id) => {
              if (
                id === manager &&
                !agents.includes(id) &&
                !(await templStaffAccount(storage, [id], this.env))
              )
                return true;
              const assigned = await assignedRoleIds(
                storage,
                [id],
                this.env,
                Date.now(),
              );
              return rolePermissions(
                settings,
                assigned.filter((roleId) => Boolean(localRoles[roleId])),
                agents.includes(id),
              ).includes("handleConversations");
            },
            supportStaff: async () => {
              const staff = new Set<ChatPrincipalId>();
              if (
                manager &&
                !agents.includes(manager as ChatPrincipalId) &&
                !(await templStaffAccount(
                  storage,
                  [manager as ChatPrincipalId],
                  this.env,
                ))
              )
                staff.add(manager as ChatPrincipalId);
              const assignments = await storage.list<string[]>({
                prefix: "roles:",
                limit: 10_000,
              });
              for (const [key] of assignments) {
                const id = normalizeChatPrincipal(key.slice("roles:".length));
                if (!id) continue;
                if (
                  rolePermissions(
                    settings,
                    (
                      await assignedRoleIds(storage, [id], this.env, Date.now())
                    ).filter((roleId) => Boolean(localRoles[roleId])),
                    agents.includes(id),
                  ).includes("handleConversations")
                ) {
                  staff.add(id);
                }
                if (staff.size >= 100) break;
              }
              return [...staff];
            },
            // The Specialist role, read like the staff
            // grant above. A registered bot never counts as a specialist.
            isSpecialist: async (id) => {
              if (agents.includes(id)) return false;
              const assigned = await assignedRoleIds(
                storage,
                [id],
                this.env,
                Date.now(),
              );
              return rolePermissions(
                settings,
                assigned.filter((roleId) => Boolean(localRoles[roleId])),
              ).includes("handleFollowUps");
            },
            specialists: async () => {
              const found = new Set<ChatPrincipalId>();
              const bots = new Set(agents);
              const assignments = await storage.list<string[]>({
                prefix: "roles:",
                limit: 10_000,
              });
              for (const [key] of assignments) {
                const id = normalizeChatPrincipal(key.slice("roles:".length));
                if (!id) continue;
                if (
                  rolePermissions(
                    settings,
                    (
                      await assignedRoleIds(storage, [id], this.env, Date.now())
                    ).filter((roleId) => Boolean(localRoles[roleId])),
                  ).includes("handleFollowUps")
                ) {
                  if (!bots.has(id)) found.add(id);
                }
                if (found.size >= 100) break;
              }
              return [...found];
            },
            isBot: actorIsAgent,
            typing: this.typing,
            bots: recordedAgents,
            registeredBots: registeredAgents,
            admitMember: (id) => admitRoomMember(storage, id, null),
            pending,
            pendingAudit,
            searchIndex: this.searchIndex,
            authors: (list) =>
              pageAuthors(storage, settings, manager, list, aliases),
            now: Date.now(),
            // The staging canary's account in Templ's own workspace only.
            canary: canaryPrincipal(env as OpsHealthEnv, conversationRoom),
          };
          conversationRequest.context = context;
          let captureBody = body;
          if (
            url.pathname === "/priority-trial-capture" &&
            request.method === "POST"
          ) {
            if (body.expectedPrincipalId !== viewer.principalId)
              throw new HttpError(404, "Not found.");
            const { expectedPrincipalId: _expectedPrincipalId, ...payload } =
              body;
            captureBody = payload;
          }
          const capture = await priorityCaptureRoute(
            storage,
            env as PriorityCaptureEnv,
            {
              path: url.pathname,
              method: request.method,
              actor: viewer.principalId ?? null,
              isManager: viewer.isManager && !context.isBot,
              headers: roomHeaders,
              body: captureBody,
              checkedFixture: (input) =>
                checkedPriorityCaptureFixture(
                  storage,
                  env as KnowledgeEnv,
                  input,
                ),
            },
          );
          if (capture) return capture;
          if (
            url.pathname === "/private/priority-trial-capture" &&
            request.method === "POST"
          ) {
            const capability = body.capability as PriorityCaptureCapability;
            if (
              Object.keys(body).sort().join() !== "capability,op,value" ||
              !capability ||
              context.isBot ||
              roomHeaders.get("X-Support-Widget") === "member" ||
              !conversationAuthority(viewer).team ||
              !(await canReadConversation(storage, context, capability.thread))
            )
              throw new HttpError(404, "Not found.");
            const accepted =
              body.op === "observe"
                ? await appendPriorityCaptureObservation(
                    storage,
                    env as PriorityCaptureEnv,
                    capability,
                    body.value,
                  )
                : body.op === "finish"
                  ? await finishPriorityCaptureWindow(
                      storage,
                      env as PriorityCaptureEnv,
                      capability,
                      body.value as PriorityPosition | null,
                    )
                  : false;
            return json({ accepted });
          }
          // A widget member's socket ticket, for that
          // member's own threads only and bound to the website the worker
          // stamped. Manager and permissions are stripped as for every
          // widget request, so the team scope can never be granted here.
          if (
            url.pathname === "/conversations/live" &&
            request.method === "POST"
          ) {
            const origin = request.headers.get("X-Support-Widget-Origin");
            if (request.headers.get("X-Support-Widget") !== "member" || !origin)
              throw new HttpError(404, "Support action not found.");
            const member = {
              ...viewer,
              isManager: false,
              permissions: [],
              roleIds: [],
            };
            const own = await conversationScope(storage, member, aliases);
            if (own === "team")
              throw new HttpError(404, "Support action not found.");
            return realtimeTicketRoute(storage, {
              viewer: member,
              aliases,
              channelIds: [],
              conversations: own,
              headers: roomHeaders,
              sessionUnavailable:
                request.headers.get("X-Session-Unavailable") === "true",
              now: Date.now(),
              // A ticket minted in Templ's frame.
              widget: {
                origin,
                frame: request.headers.get("X-Support-Widget-Frame") === "1",
              },
            });
          }
          const conversation = await conversationRoute(storage, context);
          if (conversation) return conversation;
        } // One ACL for every conversation read and write
        {
          const supportSearch =
            url.pathname === "/search" &&
            url.searchParams.get("scope") === "support";
          if (supportSearch && !conversationAuthority(viewer).team)
            throw new HttpError(404, "Support search not found.");
          // Search covers the support inbox for the team, or one
          // conversation its member or the team can read.
          if (
            url.pathname === "/search" &&
            request.method === "GET" &&
            !supportSearch &&
            !isConversationId(url.searchParams.get("channel"))
          )
            throw new HttpError(404, "Search not found.");
          const supportSearchIds = supportSearch
            ? [
                ...(
                  await storage.list({
                    prefix: "conversation-v1:",
                    limit: 10_000,
                  })
                ).keys(),
              ].map((key) => key.slice("conversation-v1:".length))
            : [];
          // The list above catches up the oldest threads' index; a thread
          // the team asks for by id is searched whatever its place, after
          // the same access check as every hit.
          const askedThread = url.searchParams.get("channel");
          if (
            supportSearch &&
            isConversationId(askedThread) &&
            !supportSearchIds.includes(askedThread)
          )
            supportSearchIds.push(askedThread);
          const search = await searchRoute(storage, this.searchIndex, {
            method: request.method,
            pathname: url.pathname,
            query: url.searchParams,
            sessionUnavailable:
              request.headers.get("X-Session-Unavailable") === "true",
            viewer,
            aliases,
            channels: [],
            // A conversation is searched only by its fixed
            // member or the current team; it is never an ordinary channel.
            accessible: () => false,
            supportScope: supportSearch,
            extraChannels: supportSearch
              ? supportSearchIds
              : isConversationId(url.searchParams.get("channel"))
                ? [url.searchParams.get("channel")!]
                : [],
            extraAccessible: (id) =>
              canReadConversation(
                storage,
                { viewer, aliases, room: conversationRoom },
                id,
              ),
            // Search results hide ambiguous hex.
            // Each result retains its ACL check.
            // The inbox message read is the view that can reveal the value.
            ...hexHiddenSearch(
              storage,
              supportSearchPresentation(storage, {
                viewer,
                aliases,
                room: conversationRoom,
                bots: recordedAgents,
                isBot: actorIsAgent,
                authors: (list) =>
                  pageAuthors(storage, settings, manager, list, aliases),
              }),
            ),
            now: Date.now(),
          });
          // The read log records a team search's first page by
          // kind and counts, never its text.
          if (
            search?.ok &&
            !url.searchParams.get("cursor") &&
            viewer.principalId
          ) {
            const channel = url.searchParams.get("channel");
            const own =
              !supportSearch &&
              isConversationId(channel) &&
              actsAs(
                aliases,
                (await readConversation(storage, channel!))?.member,
              );
            if (conversationAuthority(viewer).team && !own)
              noteSearch(pendingAudit, {
                actor: viewer.principalId,
                role: readRole({
                  isManager: viewer.isManager,
                  isBot: actorIsAgent,
                }),
                scope: supportSearch ? "inbox" : "thread",
                query: url.searchParams.get("q") ?? "",
                hits:
                  (
                    await search
                      .clone()
                      .json<{ hits?: { channelId: string }[] }>()
                  ).hits ?? [],
              });
          }
          if (search) return search;
        }
        // The read log notes that the team's inbox feed was open.
        if (
          (url.pathname === "/realtime/ticket" || url.pathname === "/events") &&
          request.method === "GET" &&
          viewer.principalId &&
          conversationAuthority(viewer).team
        )
          noteFeed(pendingAudit, {
            room: conversationRoom,
            actor: viewer.principalId,
            role: readRole({
              isManager: viewer.isManager,
              isBot: actorIsAgent,
            }),
            via: url.pathname === "/events" ? "events" : "realtime",
            now: Date.now(),
          });
        if (url.pathname === "/realtime/ticket" && request.method === "GET")
          return realtimeTicketRoute(storage, {
            viewer,
            aliases,
            channelIds: [],
            conversations: await conversationScope(storage, viewer, aliases),
            agent: actorIsAgent,
            headers: roomHeaders,
            sessionUnavailable:
              request.headers.get("X-Session-Unavailable") === "true",
            now: Date.now(),
          });
        if (url.pathname === "/events" && request.method === "GET") {
          // Conversation events pass the conversation predicate
          // against the latest committed record, never the channel list.
          const conversationAccess = new Map<string, boolean>();
          for (const [key, event] of await storage.list<ChatEvent>({
            prefix: "room-event-v1:",
            startAfter: `room-event-v1:${String(
              Math.max(0, Number(url.searchParams.get("after") ?? 0)),
            ).padStart(16, "0")}`,
            limit: 200,
          })) {
            void key;
            if (
              event.channelId &&
              isConversationId(event.channelId) &&
              !conversationAccess.has(event.channelId)
            )
              conversationAccess.set(
                event.channelId,
                await canReadConversation(
                  storage,
                  { viewer, aliases, room: conversationRoom },
                  event.channelId,
                ),
              );
          }
          return eventsRoute(storage, {
            url,
            aliases,
            sessionUnavailable:
              request.headers.get("X-Session-Unavailable") === "true",
            allowChannel: (id) =>
              isConversationId(id) && conversationAccess.get(id) === true,
            now: Date.now(),
            team: conversationAuthority(viewer).team,
          });
        }
        if (url.pathname === "/audit" && request.method === "GET") {
          signed(viewer);
          if (!viewer.isManager)
            throw new HttpError(
              403,
              "Only the manager can read the audit log.",
            );
          // Three logs with their own ids: access changes, chat activity
          // (the default) and reads. Cursors belong to the stream they came
          // from. The reads stream can be filtered by person or chat.
          return json(
            await readAuditStream(
              storage,
              auditStreamParam(url.searchParams.get("stream")),
              {
                before: auditCursor(url.searchParams.get("before")),
                limit: auditLimit(url.searchParams.get("limit")),
                ...auditFilters(url.searchParams),
              },
            ),
          );
        }
        if (url.pathname === "/appearance") {
          if (request.method === "GET")
            return json({ accentColor: appearance });
          if (request.method === "POST") {
            if (!viewer.isManager)
              throw new HttpError(
                403,
                "Only the manager can change this chat's color.",
              );
            if (!Object.hasOwn(body, "accentColor"))
              throw new HttpError(400, "Choose a chat color.");
            const selected = accentColor(body.accentColor);
            await storage.put("room-appearance", { accentColor: selected });
            if (native && native.room.accentColor !== selected) {
              native.room.accentColor = selected;
              native.revision++;
              await storage.put("native-room", native);
            }
            pendingAudit.push({
              actor: signed(viewer),
              action: "appearance",
              before: { accentColor: appearance },
              after: { accentColor: selected },
            });
            pending.push({ type: "room.updated" });
            return json({ accentColor: selected });
          }
        }
        if (
          url.pathname === "/private/report-target" &&
          request.method === "GET"
        ) {
          // A conversation message the reporter can read now, from its stored
          // row. Internal notes live under their own keys and never match.
          // Group channel and file targets are refused.
          const conversationId = url.searchParams.get("conversationId"),
            messageId = url.searchParams.get("messageId");
          if (
            url.searchParams.has("channelId") ||
            url.searchParams.has("attachmentId") ||
            !isConversationId(conversationId) ||
            !messageId ||
            !/^[1-9][0-9]{0,14}$/.test(messageId) ||
            !(await canReadConversation(
              storage,
              { viewer, aliases, room: conversationRoom },
              conversationId,
            ))
          )
            throw new HttpError(404, "Message not found.");
          const message = await reportSnapshot(
            storage,
            conversationId,
            Number(messageId),
          );
          if (!message) throw new HttpError(404, "Message not found.");
          return json({ channelId: conversationId, message });
        }
        const deleteRole = /^\/roles\/([a-z0-9-]+)\/delete$/.exec(url.pathname);
        if (deleteRole && request.method === "POST") {
          requirePermission(viewer, "manageRoles");
          throw new HttpError(
            409,
            "Archive this role instead. You can restore it later.",
          );
        }
        if (url.pathname === "/roles" && request.method === "POST") {
          if (typeof body.id !== "string" || !idPattern.test(body.id))
            throw new HttpError(400, "Choose a role ID.");
          const existing = settings.roles.find((role) => role.id === body.id);
          const admin = canManageWorkspace(viewer, actorIsAgent);
          if (!admin) requirePermission(viewer, "manageRoles");
          // Every saved role is a staff role kept in `native-manual-roles`;
          // token, hold, payment and membership modes are refused.
          if (
            (body.mode !== undefined && body.mode !== "manual") ||
            [
              "token",
              "amountRaw",
              "priceRaw",
              "minBalanceRaw",
              "chainId",
              "rule",
            ].some((field) => body[field] != null)
          )
            throw new HttpError(400, "Only staff roles can be saved.");
          if (existing && !localRoles[body.id])
            throw new HttpError(409, "Create a staff role to grant access.");
          if (body.enabled !== undefined && typeof body.enabled !== "boolean")
            throw new HttpError(400, "Choose whether to enable this role.");
          if (
            body.channelIds !== undefined ||
            body.publicChannelIds !== undefined
          )
            throw new HttpError(400, "Staff roles have no channels.");
          const selectedModerationPermissions =
            body.moderationPermissions === undefined
              ? knownPermissions(existing?.moderationPermissions)
              : moderationRolePermissions(body.moderationPermissions);
          if (!viewer.isManager && admin) {
            if (existing || body.name !== SUPPORT_TEAM_ROLES[body.id as keyof typeof SUPPORT_TEAM_ROLES]?.name || !standardTeamRole({ id: body.id, name: String(body.name),
              enabled: body.enabled as boolean | undefined, moderationPermissions: selectedModerationPermissions }))
              throw new HttpError(403, "Only the owner can change role definitions.");
          } else if (body.moderationPermissions !== undefined && !viewer.isManager)
            throw new HttpError(403, "Only the owner can change role definitions.");
          if (selectedModerationPermissions.includes("manageWorkspace") &&
              (body.id !== "support-admin" || !standardTeamRole({
                id: body.id, name: String(body.name ?? existing?.name),
                moderationPermissions: selectedModerationPermissions,
              })))
            throw new HttpError(400, "Use the standard Admin role for workspace settings.");
          if (
            selectedModerationPermissions.length ||
            existing?.moderationPermissions?.length
          ) {
            if (!admin) throw new HttpError(403, "Only workspace admins can change staff access.");
            requireWorkspaceAdminHeaders(request.headers, viewer.isManager, body.confirmed);
          }
          if (
            existing &&
            body.name === undefined &&
            body.moderationPermissions === undefined &&
            body.enabled === undefined
          )
            throw new HttpError(400, "Choose a role change.");
          if (!existing && settings.roles.length >= 64)
            throw new HttpError(409, "This chat has reached its role limit.");
          localRoles[body.id] = nativeManualRole(
            body.id,
            body.enabled === undefined
              ? (localRoles[body.id]?.enabled ?? true)
              : (body.enabled as boolean),
            (localRoles[body.id]?.revision ?? 0) + 1,
          );
          const role: ChatRole = {
            ...localRoles[body.id],
            id: body.id,
            name:
              body.name === undefined && existing
                ? existing.name
                : name(body.name),
            ...(selectedModerationPermissions.length
              ? { moderationPermissions: selectedModerationPermissions }
              : {}),
          };
          if (existing && (
            role.enabled === false ||
            (existing.moderationPermissions ?? []).some(permission =>
              !selectedModerationPermissions.includes(permission))
          )) await revokeEncryptionRole(storage, role.id);
          await storage.put("native-manual-roles", localRoles);
          const metadata = {
            id: role.id,
            name: role.name,
            ...(role.enabled === false ? { enabled: false } : {}),
            ...(selectedModerationPermissions.length
              ? { moderationPermissions: selectedModerationPermissions }
              : {}),
          };
          settings.roles = existing
            ? settings.roles.map((item) =>
                item.id === role.id ? metadata : item,
              )
            : [...settings.roles, metadata];
          await storage.put("chat-settings", settings);
          const templGrants = await storage.list<{
            templStaff?: boolean;
            roleIds?: string[];
          }>({ prefix: "templ-staff-v1:", limit: 1024 });
          const templStaffRole = [...templGrants.values()].some(
            (grant) =>
              grant.templStaff === true && grant.roleIds?.includes(role.id),
          );
          // Metadata only: names, ids and powers.
          pendingAudit.push({
            actor: signed(viewer),
            action: "role.save",
            target: role.id,
            before: existing ?? null,
            after: {
              ...metadata,
              ...(templStaffRole ? { templStaff: true } : {}),
              mode: role.mode,
              enabled: role.enabled,
              ...(selectedModerationPermissions.length
                ? { moderationPermissions: selectedModerationPermissions }
                : { moderationPermissions: [] }),
            },
          });
          pending.push({ type: "role.updated", roleId: role.id });
          return json({ role }, existing ? 200 : 201);
        }
        if (url.pathname === "/moderation" && request.method === "GET") {
          if (!canManageWorkspace(viewer, actorIsAgent) && !viewer.permissions.includes("ban"))
            requirePermission(viewer, "mute");
          const entries = await storage.list<string>({
            prefix: "mute:",
            limit: 256,
          });
          const bans = await storage.list<string>({
            prefix: "ban:",
            limit: 1024,
          });
          return json({
            bans: [...bans].map(([key, createdAt]) => ({
              wallet: key.slice(4),
              createdAt,
            })),
            moderators: canManageWorkspace(viewer, actorIsAgent)
              ? await moderatorEntries(storage, settings, this.env)
              : [],
            mutes: [...entries]
              .filter(([, until]) => Date.parse(until) > Date.now())
              .map(([key, until]) => ({ wallet: key.slice(5), until })),
          });
        }
        if (url.pathname === "/mutes" && request.method === "POST") {
          requirePermission(viewer, "mute");
          const target = principal(body.principalId);
          const targets = principalsFromHeaders(request.headers, target, true);
          if (
            actsAs(targets, manager) ||
            (await hasModerator(storage, settings, targets, this.env))
          )
            throw new HttpError(
              403,
              "Managers and moderators cannot be muted.",
            );
          if (body.until === null) {
            for (const id of targets) await storage.delete(`mute:${id}`);
          } else {
            if (
              typeof body.until !== "string" ||
              !Number.isFinite(Date.parse(body.until)) ||
              Date.parse(body.until) <= Date.now() ||
              Date.parse(body.until) > Date.now() + 30 * 86400_000
            )
              throw new HttpError(
                400,
                "Choose a mute duration of up to 30 days.",
              );
            const mutes = await storage.list<string>({
              prefix: "mute:",
              limit: 257,
            });
            for (const [key, until] of mutes)
              if (Date.parse(until) <= Date.now()) {
                await storage.delete(key);
                mutes.delete(key);
              }
            if (
              !targets.some((id) => mutes.has(`mute:${id}`)) &&
              mutes.size >= 256
            )
              throw new HttpError(
                409,
                "This chat has reached its active mute limit.",
              );
            for (const id of targets) await storage.delete(`mute:${id}`);
            await storage.put(
              `mute:${targets[0]}`,
              new Date(body.until).toISOString(),
            );
          }
          pendingAudit.push({
            actor: signed(viewer),
            action: "mute",
            target: targets[0],
            after: {
              until:
                body.until === null
                  ? null
                  : new Date(body.until as string).toISOString(),
            },
          });
          pending.push({ type: "room.updated" });
          return json({ ok: true });
        }
        if (url.pathname === "/bans" && request.method === "POST") {
          requirePermission(viewer, "ban");
          const target = principal(body.principalId);
          const targets = principalsFromHeaders(request.headers, target, true);
          if (
            actsAs(targets, manager) ||
            (await hasModerator(storage, settings, targets, this.env))
          )
            throw new HttpError(
              403,
              "Managers and moderators cannot be banned.",
            );
          if (typeof body.banned !== "boolean")
            throw new HttpError(
              400,
              "Choose whether to ban this user from posting.",
            );
          if (!body.banned) {
            for (const id of targets) await storage.delete(`ban:${id}`);
          } else {
            const bans = await storage.list<string>({
              prefix: "ban:",
              limit: 1024,
            });
            if (
              !targets.some((id) => bans.has(`ban:${id}`)) &&
              bans.size >= 1024
            )
              throw new HttpError(
                409,
                "This chat has reached its posting ban limit.",
              );
            for (const id of targets) await storage.delete(`ban:${id}`);
            await storage.put(`ban:${targets[0]}`, new Date().toISOString());
          }
          pendingAudit.push({
            actor: signed(viewer),
            action: "ban",
            target: targets[0],
            after: { banned: body.banned },
          });
          pending.push({ type: "room.updated" });
          return json({ ok: true });
        }
        const grant = /^\/roles\/([a-z0-9-]+)\/grant$/.exec(url.pathname);
        if (grant && request.method === "GET") {
          if (!canManageWorkspace(viewer, actorIsAgent)) requirePermission(viewer, "assignRoles");
          if (
            !settings.roles.some((role) => role.id === grant[1]) &&
            !["support-member", "support-lead", "support-admin"].includes(grant[1])
          )
            throw new HttpError(404, "Role not found.");
          const target = principal(url.searchParams.get("principalId"));
          const targets = principalsFromHeaders(request.headers, target, true);
          const templStaff =
            targets.some((id) => listedTemplStaff(this.env, id)) ||
            (
              await Promise.all(targets.map((id) => isTemplStaff(storage, id)))
            ).some(Boolean);
          return json({
            ...(templStaff ? { templStaff: true } : {}),
            manual:
              roles.find((role) => role.id === grant[1])?.mode === "manual" &&
              (await aliasValues<string[]>(storage, "roles:", targets)).some(
                (held) => held?.includes(grant[1]),
              ),
          });
        }
        const assign = /^\/roles\/([a-z0-9-]+)\/assign$/.exec(url.pathname);
        if (assign && request.method === "POST") {
          const admin = canManageWorkspace(viewer, actorIsAgent);
          if (!admin) requirePermission(viewer, "assignRoles");
          if (!settings.roles.some((role) => role.id === assign[1]))
            throw new HttpError(404, "Role not found.");
          const assignedRole = settings.roles.find(
            (role) => role.id === assign[1],
          );
          if (assignedRole?.moderationPermissions?.length && !viewer.isManager &&
              (!admin || !standardTeamRole(assignedRole)))
            throw new HttpError(403, "Only the owner can assign custom roles.");
          if (assignedRole?.moderationPermissions?.length) {
            requireWorkspaceAdminHeaders(request.headers, viewer.isManager, body.confirmed);
          }
          // A stored role without a manual record grants nothing.
          if (!localRoles[assign[1]])
            throw new HttpError(404, "Role not found.");
          if (typeof body.granted !== "boolean")
            throw new HttpError(
              400,
              "Choose whether to assign or remove the role.",
            );
          const target = principal(body.principalId);
          const targets = principalsFromHeaders(request.headers, target, true);
          if (!viewer.isManager && targets.includes(manager as ChatPrincipalId))
            throw new HttpError(403, "Admins cannot change the owner's access.");
          if (admin && !viewer.isManager && (await aliasValues<string[]>(storage, "roles:", targets))
              .flatMap(held => held ?? []).some(id => !settings.roles.some(role => role.id === id && standardTeamRole(role))))
            throw new HttpError(403, "Ask the owner to change this person's custom roles.");
          if (
            body.granted &&
            targets.some((id) => agents.includes(id)) &&
            assignedRole &&
            !aiRole(assignedRole)
          )
            throw new HttpError(403, "An AI agent cannot hold a human role.");
          await invalidateNativeTelegramGrant(storage, targets);
          let templStaff = false;
          if (
            body.granted &&
            targets.some((id) => listedTemplStaff(this.env, id)) &&
            !listedTemplStaff(this.env, targets[0])
          )
            throw new HttpError(403, "Use the listed Templ account.");
          for (const id of body.granted ? [targets[0]] : targets) {
            templStaff =
              (await updateTemplStaffGrant(
                storage,
                {
                  principal: id,
                  roleId: assign[1],
                  granted: body.granted,
                  manager: viewer.isManager,
                  templStaffConfirmed: body.templStaffConfirmed,
                  now: Date.now(),
                },
                this.env,
              )) || templStaff;
            const held = (await storage.get<string[]>(`roles:${id}`)) ?? [];
            if (!body.granted && held.includes(assign[1]))
              await revokeEncryptionPrincipal(storage, id);
            await storage.put(
              `roles:${id}`,
              body.granted
                ? [...new Set([...held, assign[1]])]
                : held.filter((id) => id !== assign[1]),
            );
          }
          pendingAudit.push({
            actor: signed(viewer),
            action: "role.assign",
            target: targets[0],
            after: {
              roleId: assign[1],
              granted: body.granted,
              ...(templStaff ? { templStaff: true } : {}),
            },
          });
          pending.push({ type: "role.updated", roleId: assign[1] });
          return json({ ok: true });
        }
        return json({ error: "Not found." }, 404);
      };
      let response: Response;
      try {
        response = await this.state.storage.transaction(async (local) => {
          let reservedRoomGrowth = false;
          const reserveRoomGrowth = async () => {
            await reserveGroupStorage(
              this.state.storage.sql.databaseSize,
              env.DO_STORAGE_PLAN,
            );
            reservedRoomGrowth = true;
          };
          const storage = await supportStorage(
            local,
            env,
            this.state.id?.toString() ?? "",
          );
          const result = await handle(storage, reserveRoomGrowth);
          if (
            result.ok &&
            pending.some((event) => event.type === "role.updated")
          )
            await reconcileOrderFormNoticeRecipients(
              storage,
              Date.now(),
              this.env,
            );
          if (result.ok && request.headers.has(MESSAGE_BUDGET_AVAILABLE_HEADER))
            result.headers.set(
              MESSAGE_BUDGET_USED_HEADER,
              String(
                result.headers.get(MESSAGE_BUDGET_USED_HEADER) === "true" ||
                  pending.some(
                    (event) =>
                      event.type === "message.created" ||
                      event.type === "message.edited",
                  ),
              ),
            );
          if (
            (result.ok ||
              (result.status === 409 &&
                url.pathname === "/product/crypto/receipt")) &&
            (pending.length || pendingAudit.length)
          ) {
            const now = Date.now();
            for (const entry of pendingAudit)
              await appendAudit(
                storage,
                {
                  ...entry,
                  ...([
                    "role.save",
                    "role.assign",
                    "team-invite.create",
                    "team-invite.revoke",
                    "team-invite.redeem",
                    "moderator.set",
                    "support.settings",
                  ].includes(entry.action) &&
                  request.headers.get("X-Session-Authenticated-At")
                    ? {
                        authenticatedAt: new Date(
                          Number(
                            request.headers.get("X-Session-Authenticated-At"),
                          ),
                        ).toISOString(),
                      }
                    : {}),
                },
                now,
              );
            committed = await appendEvents(storage, pending, now);
          }
          if (reservedRoomGrowth)
            await reserveGroupStorage(
              this.state.storage.sql.databaseSize,
              env.DO_STORAGE_PLAN,
            );
          return result;
        });
        paymentCommitted = true;
        if (paymentScannerWork) {
          // The submitted hash is durable before any remote scanner work.
          this.afterCommit(committed);
          committed = [];
        }
        if (paymentRegistration) {
          await wakeRoomAt(this.state.storage, Date.now() + 10_000);
          await registerProductPayments(
            this.state.storage,
            this.env,
            (requestId, value) => {
              if (requestId === paymentScannerWork?.intent.id)
                submittedScannerResult = { requestId, value };
            },
          );
        }
        if (paymentScannerWork) {
          const work = paymentScannerWork;
          paymentScannerWork = undefined;
          if (
            work.action === "blockhash" &&
            work.intent.settlement === "standard-prepaid"
          )
            await paymentScannerCall(
              this.env,
              work.intent.network,
              "register",
              { intent: work.intent },
            );
          // Scanner feature and RPC-budget reads may call this same Room.
          // No Room storage transaction remains held across this request.
          const value =
            work.action === "submit" &&
            submittedScannerResult?.requestId === work.intent.id
              ? submittedScannerResult.value
              : await paymentScannerCall(
                  this.env,
                  work.intent.network,
                  work.action,
                  {
                    requestId: work.intent.id,
                    ...(work.tx ? { tx: work.tx } : {}),
                  },
                );
          pending.length = 0;
          pendingAudit.length = 0;
          response = await this.state.storage.transaction(async (local) => {
            const storage = await supportStorage(
              local,
              env,
              this.state.id?.toString() ?? "",
            );
            // Re-read current manager, roles, payer, intent and rail before
            // applying a remote result. No caller can supply this result.
            const result = await handle(storage, async () => {}, false, {
              action: work.action,
              requestId: work.intent.id,
              tx: work.tx,
              value,
            });
            if (
              result.ok ||
              (result.status === 409 &&
                url.pathname === "/product/crypto/receipt")
            )
              committed = await appendEvents(storage, pending, Date.now());
            return result;
          });
        }
        if (stripeAction) {
          const recheck = (storage: Storage) =>
            handle(storage, async () => {}, true);
          await this.state.storage.transaction(recheck);
          const action = stripeAction;
          response = await managerStripeAction(
            this.state.storage as never,
            env as never,
            {
              ...action,
              complete: async (result) => {
                await this.state.storage.transaction(async (storage) => {
                  await recheck(storage);
                  if (
                    action.action === "setup" &&
                    result.state &&
                    typeof result.state === "object"
                  ) {
                    const current =
                      await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
                    if (!current?.coverage)
                      await storage.put(STRIPE_ROOM_KEY, result.state);
                    await markWorkspaceStep(
                      storage,
                      "checkout_started",
                      action.nowMs,
                    );
                  }
                });
              },
            },
          );
        }
      } catch (error) {
        if (paymentReservation && !paymentCommitted)
          await paymentLedgerCall(
            this.env,
            "cancel-reservation",
            paymentReservation,
          );
        // Refused team writes retain only safety metadata.
        // The content transaction has rolled back.
        // The audit records the author kind and refusal kind without the text.
        if (
          error instanceof HttpError &&
          (error.reason === "unsafe-ask" ||
            error.reason === "secret-request-refused")
        ) {
          const context = conversationRequest.context;
          if (context?.viewer.principalId)
            await appendAudit(
              this.state.storage,
              {
                actor: context.viewer.principalId,
                action: "support.text.refused",
                after: {
                  kind:
                    (error as HttpError & { refusalKind?: string })
                      .refusalKind ?? "unsafe-ask",
                  authorKind:
                    context.viewer.principalId ===
                    (await managedPrincipal(context.room))
                      ? "managed"
                      : context.isBot
                        ? "bot"
                        : "staff",
                },
              },
              Date.now(),
            );
        }
        await this.countRefusal(error, conversationRequest.context);
        settleReadMarks(pendingAudit, false);
        throw error;
      }
      // A committed read sets its read log marks.
      settleReadMarks(pendingAudit, response.ok);
      const supportMediaId = response.headers.get(
        SUPPORT_MEDIA_COMMIT_ID_HEADER,
      );
      const supportMediaBytes = Number(
        response.headers.get(SUPPORT_MEDIA_COMMIT_BYTES_HEADER),
      );
      if (supportMediaId !== null) {
        await commitSupportAttachment(
          env as Env,
          supportMediaId,
          supportMediaBytes,
        );
        response.headers.delete(SUPPORT_MEDIA_COMMIT_ID_HEADER);
        response.headers.delete(SUPPORT_MEDIA_COMMIT_BYTES_HEADER);
      }
      this.afterCommit(committed);
      if (
        response.ok &&
        request.method === "POST" &&
        url.pathname.startsWith("/conversations")
      )
        this.state.waitUntil?.(
          runPriorityVerifications(this.state, this.env as Env).catch(
            () => undefined,
          ),
        );
      if (
        response.ok &&
        typeof this.state.storage.getAlarm === "function" &&
        (await this.state.storage.get(PRODUCT_STATE_KEY))
      )
        await wakeRoomAt(this.state.storage, Date.now() + 86_400_000);
      const storagePending = response.ok
        ? await supportStoragePending(this.state.storage)
        : false;
      if (
        response.ok &&
        ((request.method === "POST" &&
          url.pathname.startsWith("/conversations")) ||
          storagePending)
      )
        await wakeRoomAt(
          this.state.storage,
          Date.now() + (storagePending ? 1_000 : 60_000),
        );
      if (
        response.ok &&
        !this.ledgerReady &&
        typeof this.state.storage.getAlarm === "function" &&
        (await this.state.storage.get("native-room"))
      ) {
        if ((await ledgerState(this.state.storage)) === "ready")
          this.ledgerReady = true;
        else await wakeRoomAt(this.state.storage, Date.now() + 1_000);
      }
      return response;
    } catch (error) {
      return json(
        errorBody(error, "Chat is temporarily unavailable."),
        error instanceof HttpError ? error.status : 503,
        error instanceof HttpError && error.retryAfterSeconds
          ? { "Retry-After": String(error.retryAfterSeconds) }
          : undefined,
      );
    }
  }
}
