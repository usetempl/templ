import { appAiEnabled, appAnswerStatus, assertAppAnswerWrite, finishAppAnswer } from "./app-ai-replies";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { featureOn } from "./workspace-flags";
import { templStaffCount } from "./templ-staff";
import { activeOrderForm, readProductOrderForms } from "./product-order-forms";
import { requireLegacyCase, requireLegacyOpening, supportEncryptionRoute, encryptedCaseExists, encryptedCaseView, newCaseEncryptionView, type EncryptionNativeHooks } from "./support-encryption";
import { EncryptionProtocolError, OWN_SUPPORT_ENDPOINT, OWN_SUPPORT_AI_PRINCIPAL, type EncryptedRecord, type ValidationReceipt } from "@templ/e2ee/protocol";
import { SUPPORT_LIMITS } from "@templ/chat/support";
import { ACCOUNT_METHOD_LIMITS } from "@templ/chat/wallets";
import { HANDOFF_LEARNING_PATH, handoffLearningRoute, queueHandoffLearningReply, linkHandoffLearningMembers } from "./support-handoff-learning";
import { releaseActivationReadUnknown } from "./release-activation";
import type { TemplStaffEnv } from "./templ-staff";
import { priorityRoute, rememberPriorityProof } from "./support-priority";
import { priorityWorkerOpen } from "./support-priority-read";
import type { KnowledgeEnv } from "./support-knowledge-client";
import { managedPrincipal } from "./managed-agent/principal"; // Screen free text leaving a conversation.
import { templAiPrincipal } from "./templ-ai-principal";
import { acceptOwnAiProof } from "./support-own-ai";
import { ownEncryptedNotice } from "./support-own-notice";
import { chosen } from "./support-ai-mode";
import { askPersonHandoff } from "./support-handoff";
import {
  TELEGRAM_AI_PATH,
  telegramAiRoute,
  type TelegramAiHelp,
} from "./support-telegram-ai";
// Inbox reads retain their current access check.
// Transaction hashes come only from the member's accepted typed context.
import { linkBillingMembers } from "./product-charges";
import {
  checkedSupportLead,
  recordSupportLead,
  assertSupportLeadRetry,
} from "./support-leads";
import type { FreeStartReservation } from "./product-free-start";
import {
  hideAmbiguousPayload,
  sharedTransactionHashes,
} from "./support-secret-sinks";
import { redactHexRoute } from "./support-redact-hex";
import { teamRefusalRoute } from "./support-team-refusal";
// File imports with current team access.
// The surrounding routes keep their own access checks and behavior.
import { supportImportRoute } from "./support-imports";
// Archive and member outcome routes.
// Every route rechecks current thread access.
import { journeyOpsRoute } from "./support-journey-ops";
import {
  MAX_TEAM_JOINS,
  recordTeamJoin,
  teamJoins,
} from "./support-team-presence";
import { corpusRoute } from "./support-corpus";
import { noteRead, readRole } from "./read-audit";
import {
  sharedMessageDetails,
  type SharedMessageDetails,
} from "./support-message-details";
import { workspaceExportRoute } from "./support-export";
import {
  conversationMessageNames,
  readTeamName,
  staffDisplayNameRoute,
} from "./staff-display-name";
import {
  PRODUCT_STATE_KEY,
  readProductSupport,
  readProductState,
  standardPlanForState,
  productMode,
  reserveFreeStart,
  admitMemberRequest,
  assertTeamReply,
  SUPPORT_REFUSAL,
  AdmissionRefusal,
} from "./product-entitlements";
import { recordSupportRefusal } from "./support-refusals";
import { assertFreeTeamReply } from "./support-free-replies";
import { recordPrepaidAnsweredCase } from "./product-standard-plan";
import {
  LIST_SCAN_RECORDS,
  PRE_INDEX_RETAINED_RECORDS,
  openIndexReady,
  openIndexRecords,
  ensureOpenIndexMarker,
  fundedRetainedRecords,
  setOpenIndex,
} from "./support-open-index";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { latestCaseBilling, memberSolve } from "./product-case-view";
import {
  assertSupportMessageAvailable,
  reserveSupportMessage,
} from "./support-retention";
import {
  supportRoomRoute,
  supportThreadRoute,
  readSupportSummary,
  recordSupportActivity,
  recordSupportMessage,
  supportRecord,
  supportSettings,
  recordWidgetAccess,
  supportJourney,
  writeSupportContext,
  writeHandoff,
  memberVerificationRequested,
  staffPreviewReason,
  agentState,
  assertBotAct,
  readAiState,
  applyAiControl,
  restrictForPerson,
  askConfirmation,
  parseTimeSpent,
  recordTimeSpent,
  type SupportRecord,
  teamSummaryInput,
  type TeamSummaryInput,
} from "./support-workflow";
import {
  applyCaseEvent,
  memberMessageAdmission,
  ensureLedgerMarker,
  readCaseRef,
  awaitingTurn,
  needsReplyPage,
  supportPulse,
  type LedgerFields,
} from "./support-cases";
import {
  aiView,
  checkedAiControl,
  type StoredAiControl,
} from "./support-ai-mode";
import {
  assertLatest,
  checkedConfirmation,
  checkedHandoff,
  clearsHandoff,
  confirmationView,
  handedOffError,
  handoffView,
  parseIfLatest,
  type StoredConfirmation,
  type StoredHandoff,
} from "./support-handoff";
import { agentPickup } from "./support-agent-presence";
import {
  afterAgentEdit,
  afterReplyWritten,
  agentEditCheck,
  agentReplyCheck,
  assertReplyExtras,
  hiddenFromAgent,
  holdReply,
} from "./support-ai-assist";
import { caseFeatureRoute } from "./support-case-routes";
import {
  deleteMessageProvenance,
  heldReplyResponse,
  provenancePage,
  type HeldReply,
} from "./support-drafts";
import { isSupportSiweChainId } from "@templ/chat/chains";
import {
  diagnosisRoomRoute,
  queueSharedMessageDiagnosis,
  threadFacts as diagnosisThreadFacts,
} from "./support-diagnosis-route";
import {
  diagnosisPending,
  enabledFromHeader,
  DIAGNOSIS_NETWORKS_HEADER,
} from "./support-diagnosis";
import { diagnosisWorkerRoute } from "./tx-diagnosis/job";
import type { DiagnosisEnv } from "./tx-diagnosis/chains";
import {
  isLoopbackOrigin,
  parseWidgetWallet,
  type WidgetWallet,
} from "@templ/chat/widget-wallet";
import { NONCE_TTL, WALLET_SHARE_RECEIPT_TTL, sha256Hex, type AppOrigin, type Env } from "./common";
import {
  withMessageBudget,
  MESSAGE_BUDGET_AVAILABLE_HEADER,
  assertMessageBudgetAvailable,
  releasePacing,
  reservePacing,
  settlePacing,
  type PacingReservation,
} from "./message-budget";
import { defer, timed } from "./request-context";
import {
  messageClientId,
  messageClientPrefix,
  messageTextHash,
  pruneMessageClients,
  type MessageClientRecord,
} from "./message-retries";
/** Member-to-team conversations.
 *
 * A conversation is a private thread between one fixed member account and
 * the community's current team: the manager plus staff whose manual role
 * carries `handleConversations`. It lives in the community's storage object
 * and reuses the message rows, rendering, reactions, rate limits, retention
 * pool, event log and export pacing of ordinary chat, but it is never an
 * ordinary channel: its id (`tc-` + 32 hex) never appears in
 * `chat-settings.channels`, no section, role, visibility toggle or public
 * card can reach it, and every read or write below passes ONE predicate,
 * `authorize()`: current authenticated room access AND (fixed member OR
 * current authorized team). Anyone else gets the same 404 whether or not the
 * thread exists.
 *
 * The member owns the "stop team messages" preference. While it is set no
 * staff write, reopen or initiation lands, including from the manager, a bot
 * or the API; only the member's explicit "Ask the team again" clears it.
 *
 * No account-level inbox, no member-to-member conversation, no arbitrary
 * recipient field: staff start a thread with a member principal read from the
 * room's own membership records, never from a name, wallet or email.
 *
 * The room object cannot see other rooms, so the per-account rolling quotas
 * (opens across rooms) live in the account-scoped object the worker calls
 * before forwarding an open (`accountQuotaRequest`); the room enforces its
 * own caps and the per-room rolling quota atomically here. */
import type {
  SupportAiMode,
  SupportAiView,
  SupportRefusalReason,
  SupportSummary,
  SupportTurn,
} from "@templ/chat/support";
import type {
  ChatAuthorFacts,
  ChatMessage,
  ChatViewer,
  TeamConversation,
  TeamConversationFilter,
  TeamConversationList,
  TeamConversationMessages,
  TeamConversationStatus,
  TeamConversationTyping,
} from "@templ/chat/index";
import { effectivePermissions } from "@templ/chat/index";
import { TEAM_CONVERSATION_LIMITS } from "@templ/chat/plans";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { ChatEvent } from "@templ/chat/events";
import { HttpError, json } from "./common";
import { messageText } from "./room";
import {
  editMessage,
  MAX_REPLY_JOINS,
  messageKey,
  recordDeleteEvidence,
  renderMessages,
  replyReference,
  replyTarget,
} from "./message-store";
import { publicReactions, reactRoute } from "./message-reactions";
import { admitExport, messagePagination } from "./export";
import type { PendingAudit } from "./room-audit";
import type { PendingEvent } from "./room-events";
import { recordPooledMessageDeletion } from "./room-retention";
import { actsAs } from "./service-principals";
import { uuidv7 } from "./uuidv7";
import { knowledgeQualityRoute } from "./support-knowledge-routes";
import { applyTransactionRule } from "./support-pilot-preset";
import { managedRoomRoute, queueManagedJob } from "./managed-agent/room";
import { alertsFeatureRoute } from "./support-alerts";
import { nativeTelegramRoute } from "./native-telegram";
import { applyCaseEventWithAlerts } from "./support-alert-emit";
import { markWorkspaceStep } from "./funnel-metrics";
import { pilotRoute } from "./pilot-metrics";
import { typingView, type SupportTyping } from "./support-typing";
import {
  refusePhrase,
  refuseSecretRequest,
  screenConversationWrite,
} from "./secret-guard";
import { staffPushRoute, type StaffPushEnv } from "./staff-push";
import { followUpFeatureRoute } from "./support-follow-up-routes";
import { followUpLineView } from "./support-follow-ups";

type Storage = DurableObjectTransaction;
export const CONVERSATION_ID = /^tc-[0-9a-f]{32}$/;
export const CONVERSATION_ROUTE =
  /^\/conversations(?:\/(status|ask|start|join|settings|saved-replies|report|preferences|pulse|refusals)|\/(tc-[0-9a-f]{32})(?:\/(messages|resolve|stop|export|claim|release|workflow|typing)(?:\/([1-9][0-9]{0,14})\/(edit|delete|reactions))?)?)?$/;
export const CONVERSATIONS_HEADER = "X-Conversations";
/** Routes outside CONVERSATION_ROUTE that read the
 * conversation gate headers. */
const FOLLOW_UP_EDGE_PATH =
  /^\/conversations\/(?:follow-ups|follow-up-settings|tc-[0-9a-f]{32}\/(?:follow-ups|positions)(?:\/[1-9][0-9]{0,7}-[1-9][0-9]?)?)$/;
/** Inbox views of the list route. */
const LIST_FILTERS: readonly string[] = [
  "open",
  "resolved",
  "abandoned",
  "archived",
  "all",
  "unassigned",
  "mine",
  "waiting",
  "spam",
  "needs-reply",
  "needs-person",
  "needs-you",
  "ai-handling",
  "waiting-on-member",
];
/** Views the open-thread index serves: every row is an open record. */
const OPEN_INDEX_FILTERS: readonly string[] = [
  "open",
  "unassigned",
  "mine",
  "waiting",
  "needs-person",
  "waiting-on-member",
];
/** Views read from the awaiting index, oldest wait first. */
const INDEX_FILTERS: readonly string[] = [
  "needs-reply",
  "needs-you",
  "ai-handling",
];
/** The turn each index view shows; Needs reply shows both. */
const INDEX_TURN: Record<string, SupportTurn | undefined> = {
  "needs-you": "person",
  "ai-handling": "ai",
};
const AWAITING_PREFIX = "support-awaiting-v1:";
const AWAITING_CURSOR = /^[0-9]{16}-tc-[0-9a-f]{32}$/;
const SUPPORT_WORKFLOW_HEADER = "X-Support-Workflow";
const MEMBER_OPEN_AVAILABLE_HEADER = "X-Conversation-Member-Open-Available";
const STAFF_OPEN_AVAILABLE_HEADER = "X-Conversation-Staff-Open-Available";
const MEMBER_OPEN_USED_HEADER = "X-Conversation-Member-Open-Used";
const STAFF_OPEN_USED_HEADER = "X-Conversation-Staff-Open-Used";
const OPEN_USED_HEADER = "X-Conversation-Open-Used";
type OpenKind = "member" | "staff";
const RECORD_PREFIX = "conversation-v1:";
const MEMBER_INDEX_PREFIX = "conversation-member-v1:";
const STATE_KEY = "conversation-state-v1";
const ROOM_OPENS_KEY = "conversation-opens-v1";
const DAY_MS = 24 * 60 * 60_000;
export const CONVERSATIONS_UNAVAILABLE_ERROR =
  "Team cases aren't available yet.";
export const CONVERSATION_NOT_FOUND_ERROR = "Case not found.";
export const STOPPED_ERROR =
  "This user has stopped team messages. They can reopen the case themselves.";
export const MEMBER_NOT_FOUND_ERROR =
  "Choose a current user of this workspace.";
/** What the team hears at the open request limit. Members read only
 * SUPPORT_REFUSAL. */
export const OPEN_CAP_ERROR =
  "The inbox has reached its open case limit. Resolve some cases, then try again.";
/** What the team hears at the stored request limit. */
export const RECORD_CAP_ERROR =
  "This workspace has reached its limit of stored cases.";
export const QUOTA_ERROR =
  "Too many cases were opened recently. Try again later.";
export const SELF_ERROR = "You cannot start a case with yourself.";

export type TeamConversationRecord = {
  /** Guest consent applies only to this Standard conversation. */
  sharedVerifiedWallet?: WidgetWallet;
  schemaVersion: 1;
  encryptedCases?: true;
  deleting?: boolean;
  archivedAt?: number;
  id: string;
  room: string;
  member: ChatPrincipalId;
  sharedVerifiedWallets?: WidgetWallet[];
  /** A proof issued before an unlink cannot put the removed wallet back on a retry. */
  walletUnlinks?: Record<string, number>;
  initiator: { kind: "member" | "staff"; principalId: ChatPrincipalId };
  createdAt: number;
  state: "open" | "resolved";
  resolvedBy: {
    principalId: ChatPrincipalId;
    kind: "member" | "team";
    at: number;
  } | null;
  stopped: boolean;
  stoppedAt: number | null;
  revision: number;
  lastMessageAt: number | null;
  messageCount: number;
  /** Staff workflow only; never an access grant. */
  assignment?: { principalId: ChatPrincipalId; claimedAt: number } | null;
  /** The first person from the team in each case, by case number. It
   * grants no access. */
  teamJoins?: { principalId: ChatPrincipalId; at: number; caseSeq: number }[];
  /** Widget guests who held this thread before proving a wallet in the same
   * widget session. They lost access at that moment; their messages are the
   * current member's, and usage counted for them still counts once. */
  formerMembers?: ChatPrincipalId[];
  /** Other threads here held by the same proven wallet. Staff context only. */
  linkedConversations?: string[];
  /** The member can return to the case preceding this one. */
  previousConversation?: string;
  /** A person must answer this request: set by a handoff, cleared by a
   * person's reply or a resolution (and, for a handoff the AI agent or a
   * person started, by taking or assigning the request). */
  handoff?: StoredHandoff | null;
  /** "Did this solve it?" for the latest team resolution. */
  confirmation?: StoredConfirmation | null;
  /** The AI mode a person or a rule chose for the current request. Absent:
   * the workspace default. Written only by the AI mode helpers. */
  ai?: StoredAiControl | null;
  /** Private Telegram-assisted AI work, retained and deleted with its case. */
  telegramAi?: TelegramAiHelp;
};
const MAX_FORMER_MEMBERS = 4;
const MAX_LINKED_CONVERSATIONS = 4;
const GUEST_OPENS_KEY = "conversation-guest-opens-v1";
/** New guest threads per client per room per rolling day. Signed members keep
 * their account quotas; guests share one per-IP allowance instead. */
export const GUEST_OPENS_PER_IP_PER_DAY =
  TEAM_CONVERSATION_LIMITS.guestOpensPerIpPerDay;
type RoomConversationState = {
  schemaVersion: 1;
  records: number;
  open: number;
};
export type ConversationAuthority = {
  /** Manager or current `handleConversations` grant. */
  team: boolean;
  /** Effective `messageMembers`: needs `handleConversations` in the same grant. */
  canStart: boolean;
};
type Authorized = {
  record: TeamConversationRecord;
  role: "member" | "team";
  authority: ConversationAuthority;
};
export type ConversationContext = {
  /** Canonical app origin selected from the Worker's deployment environment. */
  appOrigin: AppOrigin;
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  headers: Headers;
  viewer: ChatViewer;
  aliases: readonly ChatPrincipalId[];
  manager: ChatPrincipalId | null;
  room: string;
  /** Private object storage and its service budget. Only support routes use
   * this after the shared conversation authorization predicate succeeds. */
  mediaEnv: Env;
  visibility: "public" | "private";
  /** Members known to the room (`room-member:` records); resolved lazily. */
  isRoomMember: (principal: ChatPrincipalId) => Promise<boolean>;
  isSupportStaff?: (principal: ChatPrincipalId) => Promise<boolean>;
  supportStaff?: () => Promise<ChatPrincipalId[]>;
  /** The Specialist role now (never a registered bot). */
  isSpecialist?: (principal: ChatPrincipalId) => Promise<boolean>;
  /** Current specialists, at most 100. */
  specialists?: () => Promise<ChatPrincipalId[]>;
  isBot?: boolean;
  /** The room object's memory-only typing marks. Without it nothing is
   * marked and every thread reads as nobody typing. */
  typing?: SupportTyping;
  /** Retained AI identities, including removed registrations. */
  bots?: readonly ChatPrincipalId[];
  /** Current registration, for agent presence and availability only. */
  registeredBots?: readonly ChatPrincipalId[];
  /** Reserves owner and app-domain eligibility separately.
   * A request without a widget origin leaves domain eligibility incomplete. */
  reserveFreeStart?: (
    creator: ChatPrincipalId,
    room: string,
    origin: string | null,
  ) => Promise<FreeStartReservation>;
  admitMember: (principal: ChatPrincipalId) => Promise<void>;
  pending: PendingEvent[];
  pendingAudit: PendingAudit[];
  searchIndex: {
    upsert(channel: string, row: ChatMessage): Promise<void>;
    remove(channel: string, id: string | number): Promise<void>;
  };
  authors: (
    messages: readonly { author: string }[],
  ) => Promise<{ authors?: Record<string, ChatAuthorFacts> }>;
  now: number;
  /** Internal result consumed by the worker after the room transaction commits. */
  openQuotaUsed?: OpenKind;
  /** The support canary's principal in this room, when one is configured.
   * Read by the conversation wiring in a later stage. */
  canary?: ChatPrincipalId | null;
  /** A member's write and its retry id, for the refusal ledger. Read by the
   * conversation wiring in a later stage. */
  memberWrite?: { clientId: string | null };
  /** Why a member request was turned away, set where it is refused. Read by
   * the conversation wiring in a later stage. */
  refusalCause?: SupportRefusalReason;
  /** Reads the team views of this request share (`viewReader`). Internal:
   * filled only while views are built, dropped by every write in this
   * request that changes admission. */
  viewReads?: Map<string, Promise<unknown>>;
};
const notFound = () => new HttpError(404, CONVERSATION_NOT_FOUND_ERROR);
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/* Authority                                                               */

/** Who is on the team right now, from server-verified authority only. A
 * display name, a bot registration, a token role or unrelated moderation
 * powers confer nothing here. */
export function conversationAuthority(
  viewer: Pick<ChatViewer, "isManager" | "permissions" | "principalId">,
): ConversationAuthority {
  if (!viewer.principalId) return { team: false, canStart: false };
  if (viewer.isManager) return { team: true, canStart: true };
  const effective = effectivePermissions(viewer.permissions);
  const team = effective.includes("handleConversations");
  return { team, canStart: team && effective.includes("messageMembers") };
}
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}
export const recordKey = (id: string) => `${RECORD_PREFIX}${id}`;
export const memberIndexKey = (member: ChatPrincipalId) =>
  `${MEMBER_INDEX_PREFIX}${member}`;
function checkedRecord(raw: unknown): TeamConversationRecord | null {
  const record = raw as TeamConversationRecord | undefined;
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== 1 ||
    record.deleting === true ||
    !isConversationId(record.id) ||
    (record.sharedVerifiedWallet !== undefined && (record.encryptedCases || !parseWidgetWallet(record.sharedVerifiedWallet))) ||
    typeof record.room !== "string" ||
    (record.sharedVerifiedWallets !== undefined && (record.encryptedCases || !Array.isArray(record.sharedVerifiedWallets) ||
      record.sharedVerifiedWallets.some(wallet => !parseWidgetWallet(wallet)))) ||
    (record.walletUnlinks !== undefined && (!record.walletUnlinks || typeof record.walletUnlinks !== "object" ||
      Array.isArray(record.walletUnlinks) || Object.entries(record.walletUnlinks).some(([key, at]) => !/^[0-9a-f]{64}$/.test(key) || !natural(at)))) ||
    normalizeChatPrincipal(record.member) !== record.member ||
    !record.initiator ||
    (record.initiator.kind !== "member" && record.initiator.kind !== "staff") ||
    normalizeChatPrincipal(record.initiator.principalId) !==
      record.initiator.principalId ||
    !natural(record.createdAt) ||
    (record.state !== "open" && record.state !== "resolved") ||
    typeof record.stopped !== "boolean" ||
    !natural(record.revision) ||
    !natural(record.messageCount) ||
    (record.assignment != null &&
      (normalizeChatPrincipal(record.assignment.principalId) !==
        record.assignment.principalId ||
        !natural(record.assignment.claimedAt))) ||
    (record.teamJoins !== undefined &&
      (!Array.isArray(record.teamJoins) ||
        record.teamJoins.length > MAX_TEAM_JOINS ||
        record.teamJoins.some(
          (join) =>
            !join ||
            typeof join !== "object" ||
            normalizeChatPrincipal(join.principalId) !== join.principalId ||
            !natural(join.at) ||
            !Number.isSafeInteger(join.caseSeq) ||
            join.caseSeq < 0,
        ))) ||
    (record.formerMembers !== undefined &&
      (!Array.isArray(record.formerMembers) ||
        record.formerMembers.length > MAX_FORMER_MEMBERS ||
        record.formerMembers.some(
          (id) =>
            normalizeChatPrincipal(id) !== id ||
            id === record.member ||
            !id.startsWith("account:"),
        ))) ||
    (record.linkedConversations !== undefined &&
      (!Array.isArray(record.linkedConversations) ||
        record.linkedConversations.length > MAX_LINKED_CONVERSATIONS ||
        record.linkedConversations.some(
          (id) => !isConversationId(id) || id === record.id,
        ))) ||
    (record.previousConversation !== undefined &&
      (!isConversationId(record.previousConversation) ||
        record.previousConversation === record.id)) ||
    // A malformed handoff or confirmation makes the record unreadable
    // rather than letting a bot past a handoff.
    !checkedHandoff(record.handoff) ||
    !checkedConfirmation(record.confirmation) ||
    !checkedAiControl(record.ai)
  )
    return null;
  return record;
}
export async function readConversation(
  storage: Pick<Storage, "get">,
  id: string,
): Promise<TeamConversationRecord | null> {
  if (!isConversationId(id)) return null;
  return checkedRecord(await storage.get(recordKey(id)));
}
async function readState(storage: Pick<Storage, "get">) {
  const raw = await storage.get<RoomConversationState>(STATE_KEY);
  return raw &&
    raw.schemaVersion === 1 &&
    natural(raw.records) &&
    natural(raw.open)
    ? raw
    : { schemaVersion: 1 as const, records: 0, open: 0 };
}
/** Open requests for the pulse. Templ's hourly check keeps its own thread
 * open in Templ's workspace, and it never counts. */
async function pulseOpen(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "canary" | "room">,
) {
  const { open } = await readState(storage);
  if (!context.canary) return open;
  const id = await storage.get<string>(memberIndexKey(context.canary));
  const check = id ? await readConversation(storage, id) : null;
  return check?.room === context.room && check.state === "open"
    ? Math.max(0, open - 1)
    : open;
}
/** The one predicate. `member` fixes the participant; `team` is current
 * authority; both need current authenticated room access, which the room
 * already proved before any conversation route runs. Every failure is the
 * same 404 so an outsider learns nothing about the thread. */
async function authorize(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "viewer" | "aliases" | "room"> &
    Partial<Pick<ConversationContext, "isBot">>,
  id: string,
): Promise<Authorized> {
  const viewer = context.viewer;
  if (!viewer.principalId) throw notFound();
  const record = await readConversation(storage, id);
  if (!record || record.room !== context.room) throw notFound();
  const authority = conversationAuthority(viewer);
  if (actsAs(context.aliases, record.member))
    return { record, role: "member", authority };
  // AI off hides the request from the workspace's AI agent on every path
  // that uses this predicate.
  if (authority.team && !(await hiddenFromAgent(storage, context, record)))
    return { record, role: "team", authority };
  throw notFound();
}
/** Whether a viewer may read events, search hits and exports of a
 * conversation id: the same predicate, for the delivery paths. */
export async function canReadConversation(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "viewer" | "aliases" | "room"> &
    Partial<Pick<ConversationContext, "isBot">>,
  id: string,
): Promise<boolean> {
  try {
    await authorize(storage, context, id);
    return true;
  } catch {
    return false;
  }
}
/** The conversations among `ids` whose current request has AI off: an AI
 * agent's realtime socket leaves their events out, as its reads do. One
 * record and one AI state read per id, from committed state. */
export async function agentHiddenConversations(
  storage: Pick<Storage, "get">,
  ids: string[],
): Promise<Set<string>> {
  const hidden = new Set<string>();
  for (const id of ids) {
    if (!isConversationId(id)) continue;
    const record = await readConversation(storage, id);
    if (record && ((await readAiState(storage, record)).effective.mode === "off" ||
      record.encryptedCases && await encryptedCaseExists(storage, record.id, (await supportRecord(storage, record)).caseSeq ?? 0)))
      hidden.add(id);
  }
  return hidden;
}
/** Conversation ids a viewer may receive in realtime: "team" covers every
 * thread while the grant lasts; a member gets their own id only. */
export async function conversationScope(
  storage: Pick<Storage, "get">,
  viewer: ChatViewer,
  aliases: readonly ChatPrincipalId[],
): Promise<"team" | string[]> {
  if (!viewer.principalId) return [];
  if (conversationAuthority(viewer).team) return "team";
  const ids: string[] = [];
  for (const alias of aliases) {
    const id = await storage.get<string>(memberIndexKey(alias));
    if (isConversationId(id)) ids.push(id);
  }
  return ids;
}

/* Views                                                                   */

function postBlockedReason(
  record: TeamConversationRecord,
  role: "member" | "team",
  viewer: ChatViewer,
  enabled: boolean,
): TeamConversation["postBlockedReason"] {
  if (!enabled) return "unavailable";
  if (viewer.banned) return "banned";
  if (viewer.mutedUntil) return "muted";
  if (role === "team" && record.stopped) return "stopped";
  return null;
}
/** The cached member line, when there is one to show. */
function lineOf(record: TeamConversationRecord) {
  const line = followUpLineView(record, Date.now());
  return line ? { followUp: line } : {};
}
export function conversationView(
  record: TeamConversationRecord,
  role: "member" | "team",
  viewer: ChatViewer,
  enabled: boolean,
  workflow?: { aliases: readonly ChatPrincipalId[]; canClaim: boolean },
  extras?: {
    replyBlocked?: TeamConversation["replyBlocked"];
    canInstructWalletActions?: boolean;
    answerIntentRequired?: boolean;
    ai?: SupportAiView;
    /** Team views: whether the latest request bills. */
    billing?: TeamConversation["billing"] | null;
    /** Member views: whether the member may mark the request solved. */
    solve?: TeamConversation["solve"] | null;
    // Member closed-state labels.
    // The label comes from the current case state.
    closed?: TeamConversation["closed"];
    assignmentTeamName?: string | null;
  },
): TeamConversation {
  const blocked = postBlockedReason(record, role, viewer, enabled);
  const replyBlocked = role === "team" ? (extras?.replyBlocked ?? null) : null;
  const assignment = record.assignment ?? null;
  const wallets = conversationWallets(record);
  const mine = Boolean(
    assignment &&
    actsAs(workflow?.aliases ?? [viewer.principalId!], assignment.principalId),
  );
  return {
    id: record.id,
    room: record.room as TeamConversation["room"],
    member: record.member,
    ...(wallets.length ? { verifiedWalletAddress: wallets[0]!.address,
      verifiedWalletAddresses: wallets.map(wallet => wallet.address) } : {}),
    ...(record.formerMembers?.length
      ? { formerMembers: [...record.formerMembers] }
      : {}),
    ...(role === "team" && record.linkedConversations?.length
      ? { linkedConversations: [...record.linkedConversations] }
      : {}),
    ...(role === "member" && record.previousConversation
      ? { previousConversation: record.previousConversation }
      : {}),
    initiator:
      role === "member" && record.initiator.kind === "staff"
        ? { kind: "staff" }
        : { ...record.initiator },
    createdAt: new Date(record.createdAt).toISOString(),
    // Member closed-state labels.
    // This label grants no access and leaves the composer available.
    ...(role === "member" && extras?.closed ? { closed: extras.closed } : {}),
    state: record.state,
    resolvedBy: record.resolvedBy
      ? {
          ...(role === "team" || record.resolvedBy.kind === "member"
            ? { principalId: record.resolvedBy.principalId }
            : {}),
          kind: record.resolvedBy.kind,
          at: new Date(record.resolvedBy.at).toISOString(),
        }
      : null,
    staffMessagesStopped: record.stopped,
    revision: record.revision,
    lastMessageAt: record.lastMessageAt
      ? new Date(record.lastMessageAt).toISOString()
      : null,
    viewer: role,
    canPost: blocked === null && !replyBlocked,
    handoff: handoffView(record.handoff, role),
    confirmation: confirmationView(record.confirmation),
    // The member line (a label and a date, nothing else).
    ...lineOf(record),
    ...(role === "team"
      ? {
          replyBlocked,
          ...(extras?.canInstructWalletActions ? { canInstructWalletActions: true } : {}),
          ...(extras?.answerIntentRequired
            ? { answerIntentRequired: true }
            : {}),
          ...(extras?.ai ? { ai: extras.ai } : {}),
          assignment: assignment
            ? {
                principalId: assignment.principalId,
                claimedAt: new Date(assignment.claimedAt).toISOString(),
                teamName: extras?.assignmentTeamName ?? null,
              }
            : null,
          canClaim: Boolean(workflow?.canClaim && (!assignment || mine)),
          canRelease: Boolean(assignment && (mine || viewer.isManager)),
          canTakeover: Boolean(
            workflow?.canClaim && assignment && !mine && viewer.isManager,
          ),
        }
      : {}),
    ...(blocked ? { postBlockedReason: blocked } : {}),
    ...(role === "team" && extras?.billing ? { billing: extras.billing } : {}),
    ...(role === "member" && extras?.solve ? { solve: extras.solve } : {}),
  };
}
export function conversationStatus(
  viewer: ChatViewer,
  enabled: boolean,
  mine: string | null,
  eligible: boolean,
  workflow?: { available: boolean; canClaim: boolean },
  product: RoomProduct = null,
): TeamConversationStatus {
  const authority = conversationAuthority(viewer);
  return {
    available: enabled,
    supportWorkflowAvailable: workflow?.available ?? false,
    canClaim: authority.team && (workflow?.canClaim ?? false),
    canAsk:
      enabled &&
      Boolean(viewer.principalId) &&
      eligible &&
      !viewer.banned &&
      !viewer.mutedUntil,
    ...(viewer.banned
      ? { postBlockedReason: "banned" as const }
      : viewer.mutedUntil
        ? { postBlockedReason: "muted" as const }
        : {}),
    team: authority.team,
    canStart: enabled && authority.canStart,
    mine,
    limits: {
      ...conversationRoomLimits(product),
      memberOpensPerAccountPerDay: accountOpenLimit(product, "member"),
      staffOpensPerAccountPerDay: accountOpenLimit(product, "staff"),
    },
  };
}

/** Whether the workspace runs Support, and on which bounds: the full ones
 * once funded (or exempt), else the free ones. Null in a room without the
 * offer. */
type RoomProduct = { enabled: boolean; funded: boolean } | null;
async function roomProduct(
  storage: Pick<Storage, "get">,
  now: number,
  env: Env,
) {
  return (await storage.get(PRODUCT_STATE_KEY))
    ? await readProductSupport(storage, now, env)
    : null;
}
function activeSupport(product: RoomProduct) {
  return product !== null;
}
function accountOpenLimit(product: RoomProduct, kind: OpenKind) {
  return activeSupport(product)
    ? kind === "member"
      ? PRODUCT_LIMITS.memberSupportOpensPerAccountPerDay
      : PRODUCT_LIMITS.staffSupportOpensPerAccountPerDay
    : kind === "member"
      ? TEAM_CONVERSATION_LIMITS.memberOpensPerAccountPerDay
      : TEAM_CONVERSATION_LIMITS.staffOpensPerAccountPerDay;
}
function conversationRoomLimits(product: RoomProduct) {
  const supported = activeSupport(product);
  const paidSupport = supported && product?.funded === true;
  return {
    openPerRoom: supported
      ? paidSupport
        ? PRODUCT_LIMITS.supportOpenRecords
        : PRODUCT_LIMITS.freeSupportOpenRecords
      : TEAM_CONVERSATION_LIMITS.openPerRoom,
    retainedRecordsPerRoom: supported
      ? paidSupport
        ? PRE_INDEX_RETAINED_RECORDS
        : PRODUCT_LIMITS.freeSupportRetainedRecords
      : TEAM_CONVERSATION_LIMITS.retainedRecordsPerRoom,
    opensPerRoomPerDay: supported
      ? paidSupport
        ? PRODUCT_LIMITS.fundedSupportOpensPerRoomPerDay
        : PRODUCT_LIMITS.freeSupportOpensPerRoomPerDay
      : TEAM_CONVERSATION_LIMITS.opensPerRoomPerDay,
  };
}

/* Quotas and caps                                                         */

/** Rolling 24-hour counter kept as bounded timestamps. */
async function consumeRolling(
  storage: Storage,
  key: string,
  limit: number,
  now: number,
): Promise<boolean> {
  const recent = ((await storage.get<number[]>(key)) ?? []).filter(
    (at) => natural(at) && at > now - DAY_MS,
  );
  if (recent.length >= limit) return false;
  await storage.put(key, [...recent, now].slice(-limit));
  return true;
}
/** Each request reserves its own seat across rooms. The room decides whether
 * it opened anything; only that request's unused reservation can be released.
 * A transport failure keeps its seat because the write may have committed. */
export async function accountQuotaRequest(
  storage: Storage,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<Response> {
  const key =
    typeof body.key === "string" && /^[a-z-]{1,40}$/.test(body.key)
      ? body.key
      : null;
  const opId =
    typeof body.opId === "string" && /^[0-9a-f-]{36}$/.test(body.opId)
      ? body.opId
      : null;
  const limit = natural(body.limit) && body.limit > 0 ? body.limit : null;
  // A shared quota object names the account in the body.
  const principal = normalizeChatPrincipal(body.principal);
  if (!key || !opId || limit === null || !principal)
    throw new HttpError(400, "Invalid quota request.");
  const stored = `account-quota-v2:${principal}:${key}`;
  const record = (await storage.get<{ ops: Record<string, number> }>(
    stored,
  )) ?? { ops: {} };
  const live = Object.fromEntries(
    Object.entries(record.ops).filter(([, at]) => at > now - DAY_MS),
  );
  if (body.op === "release") {
    delete live[opId];
    await storage.put(stored, { ops: live });
    return json({ ok: true, used: Object.keys(live).length, limit });
  }
  if (body.op !== "reserve") throw new HttpError(400, "Invalid quota op.");
  if (live[opId] === undefined) {
    if (Object.keys(live).length >= limit)
      throw new HttpError(429, QUOTA_ERROR, 3600, "quota");
    live[opId] = now;
  }
  await storage.put(stored, { ops: live });
  return json({ ok: true, used: Object.keys(live).length, limit });
}

/* Opening and reopening                                                   */

async function emit(
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  context.pending.push({
    type: "conversation.updated",
    channelId: record.id,
    conversationRevision: record.revision,
  });
}
async function save(storage: Storage, record: TeamConversationRecord) {
  // The open index kept with each record write.
  await ensureOpenIndexMarker(storage);
  await setOpenIndex(storage, record);
  await storage.put(recordKey(record.id), record);
}
/** All creation and resolved-to-open paths use the same account reservation
 * and room limits, inside the room transaction. Failed message writes roll
 * back the room counter together with their conversation changes. */
async function reserveRoomOpen(
  storage: Storage,
  context: ConversationContext,
  kind: OpenKind,
  creating = false,
) {
  const state = await readState(storage);
  const product = await roomProduct(storage, context.now, context.mediaEnv);
  const limits = conversationRoomLimits(product);
  const member = kind === "member";
  /** A member's refusal names its cause for the refusal counts. */
  const refused = (cause: SupportRefusalReason, error: HttpError) => {
    if (member) context.refusalCause = cause;
    return error;
  };
  if (state.open >= limits.openPerRoom)
    throw refused(
      "open-limit",
      new HttpError(
        409,
        member ? SUPPORT_REFUSAL : OPEN_CAP_ERROR,
        undefined,
        "cap",
      ),
    );
  // A funded room keeps its full records once its open index is ready,
  // and the pre-index cap until then.
  if (
    creating &&
    state.records >=
      (limits.retainedRecordsPerRoom === PRE_INDEX_RETAINED_RECORDS
        ? await fundedRetainedRecords(storage)
        : limits.retainedRecordsPerRoom)
  )
    throw refused(
      "record-limit",
      new HttpError(
        409,
        member ? SUPPORT_REFUSAL : RECORD_CAP_ERROR,
        undefined,
        "cap",
      ),
    );
  const available = member
    ? MEMBER_OPEN_AVAILABLE_HEADER
    : STAFF_OPEN_AVAILABLE_HEADER;
  const used = Number(
    context.headers.get(
      member ? MEMBER_OPEN_USED_HEADER : STAFF_OPEN_USED_HEADER,
    ),
  );
  if (context.headers.get(available) !== "true")
    throw refused(
      "member-limit",
      new HttpError(429, QUOTA_ERROR, 3600, "quota"),
    );
  // The account object serializes reservations across rooms. A room without
  // the offer cannot spend one of the higher Support seats.
  if (!natural(used) || used < 1 || used > accountOpenLimit(product, kind))
    throw refused(
      "member-limit",
      new HttpError(429, QUOTA_ERROR, 3600, "quota"),
    );
  if (
    !(await consumeRolling(
      storage,
      ROOM_OPENS_KEY,
      limits.opensPerRoomPerDay,
      context.now,
    ))
  )
    throw refused(
      "daily-limit",
      new HttpError(429, QUOTA_ERROR, 3600, "quota"),
    );
  context.openQuotaUsed = kind;
  return state;
}
/** Opens the thread for (room, member) or reuses the existing record. A
 * Resolved to Open transition counts as an open for every quota; fetching an
 * already open thread consumes nothing. */
async function openFor(
  storage: Storage,
  context: ConversationContext,
  member: ChatPrincipalId,
  initiator: { kind: "member" | "staff"; principalId: ChatPrincipalId },
  previousConversation?: string,
  reservedId?: string,
): Promise<{
  record: TeamConversationRecord;
  opened: boolean;
  created: boolean;
}> {
  const existingId = await storage.get<string>(memberIndexKey(member));
  const existing = existingId
    ? await readConversation(storage, existingId)
    : null;
  const state = await readState(storage);
  const now = context.now;
  if (existing && !previousConversation) {
    if (existing.state === "open")
      return { record: existing, opened: false, created: false };
    if (initiator.kind === "member") {
      const admission = await memberMessageAdmission(
        storage, existing, await supportRecord(storage, existing), now,
      );
      if (admission.newCase && !reservedId) await requireLegacyOpening(storage);
      await admitMemberRequest(storage, {
        nowMs: now,
        newRequest: true,
        newCase: admission.newCase,
        env: context.mediaEnv,
      });
    }
    if (initiator.kind === "staff" && existing.stopped)
      throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
    await reserveRoomOpen(storage, context, initiator.kind);
    const reopened: TeamConversationRecord = {
      ...existing,
      state: "open",
      resolvedBy: null,
      confirmation: null,
      revision: existing.revision + 1,
    };
    await save(storage, reopened);
    await storage.put(STATE_KEY, { ...state, open: state.open + 1 });
    return { record: reopened, opened: true, created: false };
  }
  // An empty room's ledger starts ready; a room with older threads starts
  // its backfill.
  if (!reservedId) await requireLegacyOpening(storage);
  await ensureLedgerMarker(storage, now);
  await reserveRoomOpen(storage, context, initiator.kind, true);
  const id = reservedId ?? `tc-${uuidv7(now).replace(/-/g, "")}`;
  const record: TeamConversationRecord = {
    schemaVersion: 1,
    id,
    room: context.room,
    member,
    initiator,
    createdAt: now,
    state: "open",
    resolvedBy: null,
    stopped: false,
    stoppedAt: null,
    revision: 1,
    lastMessageAt: null,
    messageCount: 0,
    ...(previousConversation ? { previousConversation } : {}),
  };
  await save(storage, record);
  await storage.put(memberIndexKey(member), id);
  await storage.put(STATE_KEY, {
    ...state,
    records: state.records + 1,
    open: state.open + 1,
  });
  return { record, opened: true, created: true };
}

/* Widget guests                                                           */

/** A widget member without a wallet proof. Set only by the worker. */
function widgetGuest(headers: Headers) {
  return (
    headers.get("X-Support-Widget") === "member" &&
    ["anonymous", "connected"].includes(
      headers.get("X-Support-Access-Level") ?? "",
    )
  );
}
/** Guests can mint accounts freely, so their new threads share one rolling
 * allowance per client digest. One bounded map, pruned on every write. */
async function reserveGuestOpen(
  storage: Storage,
  context: ConversationContext,
) {
  const digest = context.headers.get("X-Client-IP-Digest");
  if (!digest || !/^[0-9a-f]{64}$/.test(digest))
    throw new HttpError(429, QUOTA_ERROR, 3600, "quota");
  const cutoff = context.now - DAY_MS;
  const recent: Record<string, number[]> = {};
  for (const [key, times] of Object.entries(
    (await storage.get<Record<string, number[]>>(GUEST_OPENS_KEY)) ?? {},
  )) {
    const live = Array.isArray(times)
      ? times.filter((at) => natural(at) && at > cutoff)
      : [];
    if (live.length) recent[key] = live;
  }
  const mine = recent[digest] ?? [];
  if (mine.length >= GUEST_OPENS_PER_IP_PER_DAY) {
    context.refusalCause = "guest-limit";
    throw new HttpError(429, QUOTA_ERROR, 3600, "quota");
  }
  recent[digest] = [...mine, context.now];
  await storage.put(GUEST_OPENS_KEY, recent);
}

export type WidgetVerification = {
  guest: ChatPrincipalId;
  wallet: ChatPrincipalId;
  aliases: ChatPrincipalId[];
  /** The wallet the worker checked the sign-in proof for. */
  proof: WidgetWallet;
  origin: string;
  authenticatedAt: number;
};
/** Built by the worker after it checked the sign-in proof (SIWE on a
 * sign-in network, or Sign In With Solana) and the guest bearer:
 * `{guest, wallet, aliases, network, address, chainId?, origin,
 * authenticatedAt}`. */
export function widgetVerification(
  body: Record<string, unknown>,
  options: { loopback?: boolean } = {},
): WidgetVerification {
  const guest = normalizeChatPrincipal(body.guest);
  const wallet = normalizeChatPrincipal(body.wallet);
  const aliases = Array.isArray(body.aliases)
    ? body.aliases.map(normalizeChatPrincipal)
    : [];
  const proof = parseWidgetWallet({
    network: body.network,
    address: body.address,
    chainId: body.chainId,
  });
  const validOrigin = (() => {
    if (options.loopback === true && isLoopbackOrigin(body.origin)) return true;
    if (typeof body.origin !== "string") return false;
    try {
      const url = new URL(body.origin);
      return url.protocol === "https:" && url.origin === body.origin;
    } catch {
      return false;
    }
  })();
  if (
    !guest ||
    !guest.startsWith("account:") ||
    !wallet ||
    wallet === guest ||
    !aliases.length ||
    aliases.length > 2 ||
    aliases.some((id) => !id) ||
    !aliases.includes(wallet) ||
    aliases.includes(guest) ||
    !proof ||
    // An EVM proof is a SIWE text on a network sign-in accepts.
    (proof.network === "evm" && !isSupportSiweChainId(proof.chainId)) ||
    !validOrigin ||
    !natural(body.authenticatedAt)
  )
    throw new HttpError(400, "Invalid widget verification.");
  return {
    guest,
    wallet,
    aliases: aliases as ChatPrincipalId[],
    proof,
    origin: body.origin as string,
    authenticatedAt: body.authenticatedAt,
  };
}
function conversationWallets(record: TeamConversationRecord): WidgetWallet[] {
  if (record.encryptedCases) return [];
  const wallets = new Map<string, WidgetWallet>();
  for (const wallet of [record.sharedVerifiedWallet,
    ...(record.sharedVerifiedWallets ?? [])]) {
    if (wallet && !wallets.has(wallet.address)) wallets.set(wallet.address, wallet);
  }
  return [...wallets.values()];
}

/** A wallet identifies a visitor only in their own Standard conversation. */
export async function shareGuestWalletProof(
  storage: Storage,
  body: Record<string, unknown>,
  pending: PendingEvent[],
  unlink = false,
) {
  const guest = normalizeChatPrincipal(body.guest);
  if (!guest?.startsWith("account:") || !isConversationId(body.conversation))
    throw new HttpError(403, "Invalid wallet proof for this conversation.");
  const thread = await readConversation(storage, body.conversation);
  if (
    !thread ||
    thread.member !== guest || thread.encryptedCases ||
    await storage.get(`ban:${guest}`)
  )
    throw new HttpError(403, "Choose your Standard conversation to share a wallet.");
  const wallets = conversationWallets(thread);
  const now = Date.now();
  // A removed address stays out of the visible record. Keep only the scoped hash
  // through the last possible expiry of a proof issued before the unlink.
  const unlinks = Object.fromEntries(Object.entries(thread.walletUnlinks ?? {})
    .filter(([, at]) => now - at <= NONCE_TTL + WALLET_SHARE_RECEIPT_TTL));
  if (unlink) {
    const index = wallets.findIndex(wallet => wallet.address === body.address);
    if (index < 0) return;
    const [removed] = wallets.splice(index, 1);
    unlinks[await sha256Hex(thread.id + "/" + removed.address)] = now;
  } else {
    const wallet = parseWidgetWallet(body);
    if (!wallet) throw new HttpError(403, "Invalid wallet proof for this conversation.");
    if (wallets.some(item => item.address === wallet.address)) return;
    const removedAt = unlinks[await sha256Hex(thread.id + "/" + wallet.address)];
    if (removedAt !== undefined &&
      (typeof body.proofIssuedAt !== "number" || body.proofIssuedAt <= removedAt))
      throw new HttpError(403, "Verify again to add this wallet.");
    // A workspace that has never enabled wallet lists keeps its existing
    // single-address behavior. A rollback must preserve lists already saved.
    if (body.multiple !== true) {
      if (wallets.length > 1) throw new HttpError(409, "This workspace does not accept more wallets.");
      wallets.length = 0;
    }
    const limit = wallet.network === "evm" ? ACCOUNT_METHOD_LIMITS.wallets : ACCOUNT_METHOD_LIMITS.solanaWallets;
    if (wallets.filter(item => item.network === wallet.network).length >= limit)
      throw new HttpError(400, "Remove a verified wallet from this network before adding another.");
    wallets.push(wallet);
  }
  const next: TeamConversationRecord = { ...thread, sharedVerifiedWallets: wallets, revision: thread.revision + 1 };
  delete next.sharedVerifiedWallet;
  if (wallets[0]) next.sharedVerifiedWallet = wallets[0];
  if (Object.keys(unlinks).length) next.walletUnlinks = unlinks;
  else delete next.walletUnlinks;
  await save(storage, next);
  pending.push({
    type: "conversation.updated",
    channelId: next.id,
    conversationRevision: next.revision,
  });
}
/** A guest proved a wallet in the same widget session. Their thread moves to
 * that wallet's account; when the wallet already holds a thread here, both
 * stay and each links the other. Accounts are never merged, and a banned
 * guest cannot sign its thread over to a wallet that is not banned. */
export async function verifyWidgetMember(
  storage: Storage,
  input: WidgetVerification,
  context: {
    room: string;
    now: number;
    pending: PendingEvent[];
    pendingAudit: PendingAudit[];
    admitMember: (principal: ChatPrincipalId) => Promise<void>;
    mediaEnv: TemplStaffEnv;
  },
): Promise<{ moved: boolean; conversation: string | null; linked?: string }> {
  if (await storage.get(`ban:${input.guest}`))
    throw new HttpError(403, "You are banned from posting in this chat.");
  const threadId = await storage.get<string>(memberIndexKey(input.guest));
  const thread = threadId ? await readConversation(storage, threadId) : null;
  if (!thread || thread.member !== input.guest || thread.room !== context.room)
    return { moved: false, conversation: null };
  let other: TeamConversationRecord | null = null;
  for (const alias of input.aliases) {
    const id = await storage.get<string>(memberIndexKey(alias));
    const found =
      id && id !== thread.id ? await readConversation(storage, id) : null;
    if (found) {
      other = found;
      break;
    }
  }
  // An Own encrypted chat must keep its exact member/device binding. The
  // ordinary linked-thread path spends the guest session without moving
  // ownership, so refuse this collision before changing either thread.
  if (other && thread.encryptedCases && context.room === `room:${OWN_SUPPORT_ENDPOINT.workspace}`)
    throw new HttpError(403, "This wallet already has a support chat. Keep this chat anonymous, or open the wallet's existing chat separately.");
  await linkBillingMembers(storage, [
    input.guest,
    ...input.aliases,
    ...(other ? [other.member] : []),
  ]);
  await linkHandoffLearningMembers(storage, [input.guest, ...input.aliases, ...(other ? [other.member] : [])]);
  const support = await supportRecord(storage, thread);
  support.wallet = {
    ...input.proof,
    authenticatedAt: new Date(input.authenticatedAt).toISOString(),
    origin: input.origin,
  };
  support.access = { level: "signed", at: context.now };
  support.verificationRequestedAt = null;
  await rememberPriorityProof(storage, thread, {
    network: input.proof.network,
    address: input.proof.address,
  });
  const verified = {
    actor: input.wallet,
    action: "wallet-verified" as const,
    at: context.now,
    detail: input.proof.address,
  };
  if (!other) {
    const next: TeamConversationRecord = {
      ...thread,
      member: input.wallet,
      formerMembers: [...(thread.formerMembers ?? []), input.guest]
        .filter((id) => id !== input.wallet)
        .slice(-MAX_FORMER_MEMBERS),
      revision: thread.revision + 1,
    };
    await storage.delete(memberIndexKey(input.guest));
    await storage.put(memberIndexKey(input.wallet), thread.id);
    await save(storage, next);
    await context.admitMember(input.wallet);
    await applyCaseEvent(
      storage,
      next,
      support,
      {
        kind: "wallet-verified",
        at: context.now,
      },
      context.mediaEnv,
    );
    await recordSupportActivity(storage, thread.id, support, verified);
    context.pendingAudit.push({
      actor: input.wallet,
      action: "conversation.transfer",
      channelId: thread.id,
      target: input.guest,
    });
    context.pending.push({
      type: "conversation.updated",
      channelId: thread.id,
      conversationRevision: next.revision,
    });
    return { moved: true, conversation: thread.id };
  }
  const linked = (record: TeamConversationRecord, id: string) =>
    [
      ...(record.linkedConversations ?? []).filter((item) => item !== id),
      id,
    ].slice(-MAX_LINKED_CONVERSATIONS);
  const nextThread: TeamConversationRecord = {
    ...thread,
    linkedConversations: linked(thread, other.id),
    revision: thread.revision + 1,
  };
  const nextOther: TeamConversationRecord = {
    ...other,
    linkedConversations: linked(other, thread.id),
    revision: other.revision + 1,
  };
  await save(storage, nextThread);
  await save(storage, nextOther);
  await applyCaseEvent(
    storage,
    nextThread,
    support,
    {
      kind: "wallet-verified",
      at: context.now,
    },
    context.mediaEnv,
  );
  await recordSupportActivity(storage, thread.id, support, verified);
  context.pendingAudit.push({
    actor: input.wallet,
    action: "conversation.link",
    channelId: thread.id,
    target: input.guest,
  });
  for (const record of [nextThread, nextOther])
    context.pending.push({
      type: "conversation.updated",
      channelId: record.id,
      conversationRevision: record.revision,
    });
  return { moved: false, conversation: thread.id, linked: other.id };
}

/* Messages                                                                */

function replyTextHash(text: string, replyIntent: unknown) {
  if (replyIntent === undefined) return messageTextHash(text);
  if (replyIntent !== "answer" && replyIntent !== "update")
    throw new HttpError(400, "Choose an answer or update.");
  return messageTextHash(JSON.stringify({ text, replyIntent }));
}

async function previousMessage(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  body: Record<string, unknown>,
): Promise<ChatMessage | null> {
  if (typeof body.text !== "string" || !body.text.trim() || !body.clientId)
    return null;
  const text = messageText(body.text);
  const replyTo = replyReference(body.replyTo);
  const retry = messageClientId(body.clientId, context.now);
  const textHash = retry
    ? await replyTextHash(text, body.replyIntent)
    : undefined;
  const aliases = context.aliases;
  if (retry) {
    const previous = await Promise.all(
      aliases.map((id) =>
        storage.get<MessageClientRecord>(
          `${messageClientPrefix}${retry.timestampHex}:${record.id}:${id}:${retry.clientId}`,
        ),
      ),
    );
    const found = previous.filter((entry): entry is MessageClientRecord =>
      Boolean(entry),
    );
    if (new Set(found.map((entry) => entry.messageId)).size > 1)
      throw new HttpError(503, "Chat is temporarily unavailable.");
    const prior = found[0];
    if (prior) {
      if (prior.newConversationId !== undefined)
        throw new HttpError(
          409,
          "This message ID was already used for another case.",
        );
      if (prior.textHash !== textHash || prior.replyTo !== replyTo)
        throw new HttpError(
          409,
          "This message ID was already used for different text.",
        );
      const message = await storage.get<ChatMessage>(
        messageKey(record.id, prior.messageId),
      );
      if (!message) throw new HttpError(410, "This message was removed.");
      if (
        !actsAs(aliases, message.author) ||
        message.clientId !== retry.clientId ||
        message.text !== text
      )
        throw new HttpError(503, "Chat is temporarily unavailable.");
      return (
        await renderMessages(storage, record.id, [message], {
          aliases: [...aliases],
        })
      )[0];
    }
  }
  return null;
}

/** The reader team views use. Every thread's reply check reads the same
 * plan, usage, places, settings and message ledger, so in one request each
 * key is read once and every later read gets its own copy of that value.
 * Views are built after a request's writes, and each write here that
 * changes admission drops the reads (`dropViewReads`). */
function viewReader(
  storage: Pick<Storage, "get"> & Partial<Pick<Storage, "list">>,
  context: ConversationContext,
): Pick<Storage, "get"> & Partial<Pick<Storage, "list">> {
  const reads = (context.viewReads ??= new Map());
  const get = async (
    key: string | string[],
    options?: DurableObjectGetOptions,
  ) => {
    if (typeof key !== "string") return storage.get(key, options);
    let read = reads.get(key);
    if (!read) {
      read = storage.get(key, options);
      reads.set(key, read);
      // A failed read is tried again by the next view.
      read.catch(() => reads.delete(key));
    }
    return structuredClone(await read);
  };
  return {
    get: get as Storage["get"],
    ...(storage.list ? { list: storage.list.bind(storage) } : {}),
  };
}
/** Forgets the reads team views shared, after a write that changes what a
 * team reply may do. */
function dropViewReads(context: ConversationContext) {
  context.viewReads = undefined;
}

/* The plan checks a message meets before it writes anything. Each reads
 * only; postMessage and the typing route share them. */
async function assertPlanVerified(storage: Pick<Storage, "get">) {
  if (!(await storage.get(PRODUCT_STATE_KEY)))
    throw new HttpError(
      503,
      "The support plan could not be verified. Try again.",
    );
}
/** A staff preview: the thread's member is a test account or on the team. */
async function isStaffPreview(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  return (await staffPreviewReason(storage, context, record.member)) !== null;
}
/** Every refusal a team reply in this thread would meet now, from reads
 * alone: an unverified plan, a paused workspace or a full message ledger.
 * Message pacing only delays a reply, so it is not checked here. */
async function assertTeamReplyAdmitted(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
) {
  await assertPlanVerified(storage);
  await assertTeamReply(storage, context.now, context.mediaEnv);
  await assertSupportMessageAvailable(storage, context.now, "team");
}
/** Team view only: why a reply from this viewer would be refused now.
 * Reads only. */
async function teamReplyBlock(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
  record: TeamConversationRecord,
  mode: SupportAiMode,
): Promise<TeamConversation["replyBlocked"]> {
  if (context.isBot) {
    if (record.handoff) return "handed-off";
    if (mode === "off") return "ai-off";
    if (mode === "drafts") return "ai-drafts-only";
  }
  try {
    await assertTeamReplyAdmitted(storage, context);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    switch (error.reason) {
      case "support-paused":
        return "paused";
      case "support-message-capacity":
        return "message-limit";
    }
  }
  return null;
}
/** What a team view adds: the request's AI mode and why a reply from this
 * viewer would be refused now. */
async function teamExtras(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  const reader = viewReader(storage, context);
  const { aiDefault, effective } = await readAiState(reader, record);
  const plan = standardPlanForState(
    await readProductState(reader, context.now, context.mediaEnv),
  );
  return {
    answerIntentRequired:
      plan?.status === "paid" && plan.period?.source === "verified-payment",
    canInstructWalletActions: canManageWorkspace(context.viewer, context.isBot),
    ai: {
      ...aiView(effective, aiDefault, (context.registeredBots ?? []).length > 0),
      ...(await appAiEnabled(reader, context.mediaEnv, context.room)
        ? await appAnswerStatus(reader, record.id, context.registeredBots?.length ?? 0)
        : {}),
    },
    replyBlocked: await teamReplyBlock(reader, context, record, effective.mode),
  };
}
/** What a thread's reader learns about a reply being written. A mark shows
 * only while a team reply here could land now: the inbox is on, the member
 * has not stopped team messages, and the plan still admits the reply.
 * typingView rechecks each typer's staff access. */
async function threadTyping(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
  record: TeamConversationRecord,
  enabled: boolean,
  read: {
    role: "member" | "team";
    /** The thread's newest message, when this read is the newest page. */
    newest: ChatMessage | null;
  },
): Promise<{ typing: TeamConversationTyping; aiQueued?: true }> {
  if (!enabled || record.stopped) return { typing: null };
  const reader = viewReader(storage, context);
  const marked = await typingView(context.typing, {
    thread: record.id,
    now: context.now,
    reader: context.aliases,
    bots: context.bots ?? [],
    registeredBots: context.registeredBots ?? [],
    isStaff: async (id) => Boolean(await context.isSupportStaff?.(id)),
  });
  const queued = marked === null && read.role === "member" &&
    await agentPickingUp(reader, context, record, read.newest);
  const typing: TeamConversationTyping = marked ?? (queued ? "agent" : null);
  if (typing === null) return { typing };
  try {
    await assertTeamReplyAdmitted(reader, context);
  } catch (error) {
    if (error instanceof HttpError) return { typing: null };
    throw error;
  }
  return { typing, ...(queued ? { aiQueued: true } : {}) };
}
/** "AI agent is typing" right after the member's message, before the agent
 * marks it: the workspace's AI agent is running and would answer this
 * request now. Cheapest checks first; the caller still checks that the plan
 * admits the agent's reply. Members only. */
async function agentPickingUp(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
  record: TeamConversationRecord,
  newest: ChatMessage | null,
) {
  const memberSide = [record.member, ...(record.formerMembers ?? [])];
  const now = context.now;
  const input = {
    now,
    newest: newest
      ? { author: newest.author, createdAt: Date.parse(newest.createdAt) }
      : null,
    memberSide,
    handoff: Boolean(record.handoff),
    mode: "answers" as SupportAiMode,
    assigned: Boolean(record.assignment),
    stopped: record.stopped,
    closed: record.state === "resolved",
    canary: Boolean(context.canary) && record.member === context.canary,
    present: true,
  };
  // Everything but presence and the mode, read from what is already here.
  if (!agentPickup(input)) return false;
  if (!(await agentState(context)).active) return false;
  const { data, effective } = await readAiState(storage, record);
  return agentPickup({
    ...input,
    mode: effective.mode,
    closed: input.closed || data.state === "resolved" || data.state === "spam",
  });
}

async function postMessage(
  storage: Storage,
  context: ConversationContext,
  authorized: Authorized,
  body: Record<string, unknown>,
  sharedDetails?: SharedMessageDetails,
): Promise<
  | {
      message: ChatMessage;
      record: TeamConversationRecord;
      draftLinked?: boolean;
    }
  | { held: HeldReply }
> {
  const { viewer, aliases, now } = context;
  const author = viewer.principalId!;
  const { record, role } = authorized;
  if (viewer.banned)
    throw new HttpError(403, "You are banned from posting in this chat.");
  if (viewer.mutedUntil)
    throw new HttpError(403, "You are muted in this chat.");
  if (role === "team" && record.stopped)
    throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
  const text = messageText(body.text);
  await refusePhrase(text, "sent");
  if (role === "team")
    refuseSecretRequest(text, {
      allowWalletInstructions: canManageWorkspace(viewer, context.isBot),
    });
  assertReplyExtras(body, role, Boolean(context.isBot));
  if (
    body.replyIntent !== undefined &&
    (role !== "team" ||
      context.isBot ||
      (body.replyIntent !== "answer" && body.replyIntent !== "update"))
  )
    throw new HttpError(
      400,
      "Only a person on the team can choose an answer or update.",
    );
  const replyTo = replyReference(body.replyTo);
  const retry = messageClientId(body.clientId, now);
  const clientKey = retry
    ? `${messageClientPrefix}${retry.timestampHex}:${record.id}:${author}:${retry.clientId}`
    : undefined;
  const textHash = retry
    ? await replyTextHash(text, body.replyIntent)
    : undefined;
  const prior = await previousMessage(storage, context, record, body);
  if (prior) return { message: prior, record };
  // A request handed to a person waits for that person: the registered bot
  // is refused before anything is written or checked against the plan.
  if (role === "team" && context.isBot && record.handoff)
    throw handedOffError(record.handoff);
  // Then the request's AI mode: drafts only or off keeps the bot's reply out,
  // before its ifLatest read is spent.
  if (role === "team") await assertBotAct(storage, context, record, "reply");
  // A conditional write: refused when a newer or edited message arrived
  // after the one the writer read.
  await assertAppAnswerWrite(storage, context, record, body);
  await assertLatest(storage, record.id, parseIfLatest(body.ifLatest));
  // An AI agent's provenance and citation markers are checked before
  // admission; a held retry answers again with its hold.
  const agent = await agentReplyCheck(
    storage,
    context,
    record,
    role,
    text,
    body,
  );
  if (agent && "held" in agent) return { held: agent.held };
  await assertPlanVerified(storage);
  {
    const staffTest = await isStaffPreview(storage, context, record);
    const canary = Boolean(context.canary) && record.member === context.canary;
    // A member's own write that the workspace may turn away: counted by
    // cause when it is. Never a staff preview, a test account or a bot.
    if (role === "member" && !staffTest && !context.isBot)
      context.memberWrite = {
        clientId: typeof body.clientId === "string" ? body.clientId : null,
      };
    if (role === "member") {
      // An empty ask can reopen the thread before its case. Check the
      // ledger again when the member sends the request.
      try {
        const admission = await memberMessageAdmission(
          storage,
          record,
          await supportRecord(storage, record),
          now,
        );
        if (admission.newCase) await requireLegacyOpening(storage);
        await admitMemberRequest(storage, {
          nowMs: now,
          newRequest:
            record.state !== "open" ||
            record.messageCount === 0 ||
            admission.newRequest,
          newCase: admission.newCase,
          env: context.mediaEnv,
        });
      } catch (error) {
        if (error instanceof AdmissionRefusal)
          context.refusalCause = error.refusal;
        throw error;
      }
      // The first real member request reserves the free start. Setup never
      // uses it: staff previews, test accounts, bots and Templ's check don't.
      if (!staffTest && !canary && !context.isBot)
        await reserveFreeStart(storage, {
          nowMs: now,
          env: context.mediaEnv,
          reserve: context.reserveFreeStart
            ? (creator, room) =>
                context.reserveFreeStart!(
                  creator,
                  room,
                  context.headers.get("X-Support-Widget-Origin"),
                )
            : undefined,
        });
    }
    if (role === "team") await assertTeamReply(storage, now, context.mediaEnv);
    // With the number check on hold, a failing agent reply becomes a draft
    // for the team here: admitted, but nothing sent or written.
    if (agent?.reply.hold)
      return { held: await holdReply(storage, context, record, agent, body) };
    if (role === "team") await assertFreeTeamReply(storage, context, record);
    if (
      role === "team" &&
      !staffTest &&
      !canary &&
      (context.isBot
        ? agent?.reply.provenance?.reason === "answer"
        : body.replyIntent === "answer")
    ) {
      const data = await supportRecord(storage, record);
      if (data.caseSeq)
        await recordPrepaidAnsweredCase(storage, {
          case: await readCaseRef(storage, record, data, data.caseSeq),
          at: now,
        });
    }
    // The workspace's first member request. Staff previews and registered
    // bots are not member requests.
    if (role === "member" && !staffTest && !canary && !context.isBot)
      await markWorkspaceStep(storage, "first_request", now);
    // The workspace's first team reply to a member, from a person or a
    // registered bot. A reply in a staff preview or the canary's thread is
    // not one.
    if (role === "team" && !staffTest && !canary &&
      (!context.isBot || agent?.reply.provenance?.reason === "answer"))
      await markWorkspaceStep(storage, "first_reply", now);
  }
  if (role === "member" && record.state === "resolved")
    await reserveRoomOpen(storage, context, "member");
  assertMessageBudgetAvailable(
    context.headers.get(MESSAGE_BUDGET_AVAILABLE_HEADER) !== "false",
  );
  const clientCount = clientKey ? await pruneMessageClients(storage, now) : 0;
  await replyTarget(storage, record.id, replyTo);
  const sequence =
    ((await storage.get<number>(`channel-sequence:${record.id}`)) ?? 0) + 1;
  try {
    await reserveSupportMessage(storage, now, role);
  } catch (error) {
    if (
      role === "member" &&
      error instanceof HttpError &&
      error.reason === "support-message-capacity"
    )
      context.refusalCause = "message-limit";
    throw error;
  }
  const message: ChatMessage = {
    id: String(sequence),
    ...(retry ? { clientId: retry.clientId } : {}),
    author,
    // An agent's citation markers never reach the member.
    text: agent ? agent.reply.text : text,
    createdAt: new Date(now).toISOString(),
    revision: 1,
    ...(sharedDetails?.sharedDetails ? sharedDetails : {}),
    ...(replyTo ? { replyTo } : {}),
  };
  await finishAppAnswer(storage, record.id, body.appAnswer, "answered");
  let next: TeamConversationRecord = {
    ...record,
    // A member reply reopens their own resolved thread; staff cannot reopen
    // through a reply (they are refused above while stopped, and a resolved
    // thread needs an explicit resolve toggle from them).
    state:
      role === "member" && record.state === "resolved" ? "open" : record.state,
    resolvedBy:
      role === "member" && record.state === "resolved"
        ? null
        : record.resolvedBy,
    ...(role === "member" && record.state === "resolved"
      ? { confirmation: null }
      : {}),
    ...(role === "member" ? { archivedAt: undefined } : {}),
    revision: record.revision + 1,
    lastMessageAt: now,
    messageCount: record.messageCount + 1,
    // A person's reply answers the request the handoff was waiting on.
    ...(role === "team" && !context.isBot && record.handoff
      ? { handoff: null }
      : {}),
  };
  if (role === "member" && record.state === "resolved") {
    const state = await readState(storage);
    await storage.put(STATE_KEY, { ...state, open: state.open + 1 });
  }
  await storage.put({
    [messageKey(record.id, sequence)]: message,
    [`channel-sequence:${record.id}`]: sequence,
  });
  if (clientKey) {
    await storage.put(clientKey, {
      messageId: sequence,
      textHash: textHash!,
      ...(replyTo ? { replyTo } : {}),
    } satisfies MessageClientRecord);
    await storage.put("message-client-count", clientCount + 1);
  }
  if (role === "team")
    await recordTeamJoin(
      next,
      context,
      author,
      (await supportRecord(storage, next)).caseSeq ?? 0,
    );
  await save(storage, next);
  next = await recordSupportMessage(
    storage,
    context,
    next,
    role,
    agent?.reply.provenance?.reason === "answer" &&
      agent.reply.text.trim().length > 0,
  );
  if (role === "team" && !context.isBot)
    await queueHandoffLearningReply(storage, context, next, message, record.handoff);
  // A person's reply keeps the AI to drafts for the rest of this request.
  if (role === "team")
    next = await restrictForPerson(storage, context, next, "person-reply", {
      bump: false,
    });
  const assisted =
    role === "team"
      ? await afterReplyWritten(storage, context, next, message, {
          agent,
          fromDraft: body.fromDraft,
        })
      : {};
  await context.searchIndex.upsert(record.id, message);
  // The reply the member was waiting for has landed.
  if (role === "team") context.typing?.clear(record.id, aliases);
  const [rendered] = await renderMessages(storage, record.id, [message]);
  context.pending.push({
    type: "message.created",
    channelId: record.id,
    message: rendered,
  });
  if (next.state !== record.state) await emit(context, next);
  // The message may have taken or used a place and a ledger row.
  dropViewReads(context);
  return { message: rendered, record: next, ...assisted };
}

/* Routes                                                                  */

/** The encrypted relay shares native access, admission, case counts and
 * retention. No ChatMessage with pretend/empty text is ever constructed. */
function encryptionHooks(
  storage: Storage,
  context: ConversationContext,
): EncryptionNativeHooks {
  const mine = async () => {
    for (const alias of context.aliases) {
      const id = await storage.get<string>(memberIndexKey(alias));
      const record = id ? await readConversation(storage, id) : null;
      if (record && actsAs(context.aliases, record.member)) return record;
    }
    return null;
  };
  const targetCase = async (record: TeamConversationRecord | null) => {
    if (!record) return { seq: 1, newCase: true };
    const data: SupportRecord & LedgerFields = await supportRecord(
      storage,
      record,
    );
    const admission = await memberMessageAdmission(
      storage,
      record,
      data,
      context.now,
    );
    return {
      seq: admission.newCase
        ? Math.max(data.caseSeq ?? 0, data.caseSeqFloor ?? 0) + 1
        : data.caseSeq!,
      newCase: admission.newCase,
      currentSeq: data.caseSeq,
    };
  };
  return {
    mine,
    targetCase,
    authorize: (id) => authorize(storage, context, id),
    compatible: async profile => profile.custody === "templ-own-support"
      ? context.appOrigin === "https://usetempl.com" && profile.workspace === OWN_SUPPORT_ENDPOINT.workspace &&
        profile.rootKey === context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT &&
        !(context.registeredBots ?? []).some(principal => principal !== OWN_SUPPORT_AI_PRINCIPAL)
      :
      !context.registeredBots?.length &&
      (await templStaffCount(storage)) === 0 &&
      activeOrderForm(await readProductOrderForms(storage), context.now)?.service !== "done-for-you" &&
      !(await featureOn(context.mediaEnv, storage, "nativeTelegram")) &&
      !(await featureOn(context.mediaEnv, storage, "handoffLearning")) &&
      !(await featureOn(context.mediaEnv, storage, "appTelegramDrafts")),
    accept: async (reservation, encrypted, receipt) => {
      if (receipt.diagnostics && !await featureOn(context.mediaEnv, storage, "supportDiagnostics"))
        throw new HttpError(403, "Browser troubleshooting details are not available for this workspace.", undefined, "diagnostics-unavailable");
      const author = context.viewer.principalId!;
      let record = await readConversation(
        storage,
        encrypted.scope.conversation,
      );
      const opening = context.pathname === "/conversations/ask";
      if (opening) {
        if (
          encrypted.purpose !== "member-message" ||
          !reservation ||
          !actsAs(context.aliases, reservation.principal as ChatPrincipalId)
        )
          throw new EncryptionProtocolError("encryption-integrity");
        const current = await mine();
        if (current && current.id !== encrypted.scope.conversation)
          throw new EncryptionProtocolError("encryption-scope-changed");
      } else if (!record) throw notFound();
      if (context.headers.get(CONVERSATIONS_HEADER) !== "true")
        throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
      if ((context.isBot && encrypted.certificate.kind !== "ai") || context.viewer.banned || context.viewer.mutedUntil)
        throw new HttpError(403, "You cannot send to this case now.");
      const role = encrypted.certificate.kind === "member" ? "member" : "team";
      if (
        record &&
        (await authorize(storage, context, record.id)).role !== role
      )
        throw notFound();
      if (record && record.stopped && role === "team")
        throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
      if (
        (role === "member") !==
        (encrypted.purpose === "member-message" ||
          encrypted.purpose === "context")
      )
        throw new EncryptionProtocolError("encryption-integrity");
      if (
        !["member-message", "team-message", "note", "context", ...(context.isBot ? ["draft"] : [])].includes(
          encrypted.purpose,
        )
      )
        throw new HttpError(
          409,
          "This content type is not available for encrypted cases.",
        );
      const target = await targetCase(record);
      if (
        target.seq !== encrypted.scope.caseSeq ||
        (!opening && target.newCase)
      )
        throw new EncryptionProtocolError("encryption-scope-changed");
      if (context.isBot) {
        if (!record || opening) throw notFound();
        await assertBotAct(storage, context, record, encrypted.purpose === "draft" ? "draft" : "reply");
        await acceptOwnAiProof(storage, context, record, encrypted, receipt);
      } else if (receipt.ai) throw new EncryptionProtocolError("encryption-integrity");
      await assertPlanVerified(storage);
      if (opening) {
        if (!(await context.isRoomMember(author)))
          await context.admitMember(author);
        if (!record && widgetGuest(context.headers))
          await reserveGuestOpen(storage, context);
        const opened = await openFor(
          storage,
          context,
          record?.member ?? author,
          { kind: "member", principalId: author },
          undefined,
          encrypted.scope.conversation,
        );
        record = opened.record;
      }
      if (!record) throw notFound();
      await acceptEncryptedContent(
        storage,
        context,
        record,
        role,
        encrypted,
        receipt,
      );
      if (opening && reservation?.initialAiMode === "off") {
        const saved = (await readConversation(storage, record.id))!;
        const {data, effective} = await readAiState(storage, saved);
        const next = chosen(effective, {mode: "off", cause: "person-set", actor: author,
          caseSeq: encrypted.scope.caseSeq, now: context.now});
        if (next) await applyAiControl(storage, context, saved, data, next, {bump: true, previous: effective.mode});
        const asked = askPersonHandoff({stopped: false, conversationState: saved.state, supportState: data.state,
          requestedAt: data.requestedAt, current: saved.handoff, now: context.now});
        if (asked.opened) await writeHandoff(storage, context, saved, data, asked.handoff);
      }
    },
  };
}

async function acceptEncryptedContent(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  encrypted: EncryptedRecord,
  receipt: ValidationReceipt,
) {
  const now = context.now;
  const message =
    encrypted.purpose === "member-message" ||
    encrypted.purpose === "team-message";
  const data = await supportRecord(storage, record);
  const staffTest = await isStaffPreview(storage, context, record);
  const canary = Boolean(context.canary) && record.member === context.canary;
  if (message && receipt.textBytes < 1) throw new EncryptionProtocolError();
  if (role === "member" && message) {
    const admission = await memberMessageAdmission(storage, record, data, now);
    await admitMemberRequest(storage, {
      nowMs: now,
      newRequest:
        record.state !== "open" ||
        record.messageCount === 0 ||
        admission.newRequest,
      newCase: admission.newCase,
      env: context.mediaEnv,
    });
    if (!staffTest && !canary)
      await reserveFreeStart(storage, {
        nowMs: now,
        env: context.mediaEnv,
        reserve: context.reserveFreeStart
          ? (creator, room) =>
              context.reserveFreeStart!(
                creator,
                room,
                context.headers.get("X-Support-Widget-Origin"),
              )
          : undefined,
      });
  }
  if (role === "team") {
    await assertTeamReply(storage, now, context.mediaEnv);
    if (message) {
      await assertFreeTeamReply(storage, context, record);
      if (
        (context.isBot ? receipt.ai?.disposition === "answer" && receipt.ai.handoff !== "quote" : encrypted.replyIntent === "answer") &&
        !staffTest &&
        !canary &&
        data.caseSeq
      )
        await recordPrepaidAnsweredCase(storage, {
          case: await readCaseRef(storage, record, data, data.caseSeq),
          at: now,
        });
    }
    if (encrypted.purpose === "note") {
      if ((data.noteCount ?? 0) >= SUPPORT_LIMITS.notesPerConversation)
        throw new HttpError(
          409,
          "This case has reached its internal-note limit.",
        );
      data.noteCount = (data.noteCount ?? 0) + 1;
      await storage.put(`support-workflow-v1:${record.id}`, data);
    }
  }
  assertMessageBudgetAvailable(
    context.headers.get(MESSAGE_BUDGET_AVAILABLE_HEADER) !== "false",
  );
  await reserveSupportMessage(storage, now, role);
  let next: TeamConversationRecord = {
    ...record,
    encryptedCases: true,
    revision:
      encrypted.scope.audience === "conversation"
        ? record.revision + 1
        : record.revision,
    ...(message
      ? { lastMessageAt: now, messageCount: record.messageCount + 1 }
      : {}),
    ...(role === "member" && message
      ? {
          state: "open" as const,
          stopped: false,
          stoppedAt: null,
          resolvedBy: null,
          confirmation: null,
          archivedAt: undefined,
        }
      : {}),
    ...(role === "team" && message ? { handoff: null } : {}),
  };
  if (role === "member" && message && record.state === "resolved") {
    await reserveRoomOpen(storage, context, "member");
    const state = await readState(storage);
    await storage.put(STATE_KEY, { ...state, open: state.open + 1 });
  }
  await save(storage, next);
  if (message) {
    next = await recordSupportMessage(storage, context, next, role, context.isBot === true && receipt.ai?.disposition === "answer" && receipt.ai.handoff !== "quote");
    if (role === "team" && !context.isBot)
      next = await restrictForPerson(storage, context, next, "person-reply", {
        bump: false,
      });
    if (!staffTest && !canary)
      await markWorkspaceStep(
        storage,
        role === "member" ? "first_request" : "first_reply",
        now,
      );
  }
  if (context.isBot && receipt.ai) {
    const handoff = receipt.ai.handoff ?? (["hold", "handoff"].includes(receipt.ai.disposition) ? "unsure" : undefined);
    if (handoff && (message || !["answer", "clarify", "greeting"].includes(receipt.ai.disposition))) {
      const currentData = await supportRecord(storage, next);
      if (!next.handoff && currentData.requestedAt !== null) await writeHandoff(storage, context, next, currentData,
        {at: now, reason: handoff, by: "agent", requestAt: currentData.requestedAt});
    }
  }
  context.pending.push({
    type: "conversation.updated",
    channelId: record.id,
    conversationRevision: next.revision,
    ...(encrypted.scope.audience !== "conversation"
      ? { audience: "team" as const }
      : {}),
  });
  dropViewReads(context);
}

/** Whether a member's own reopen of this thread is a member request the
 * refusal counts may record: never a bot's, Templ's hourly check, a listed
 * test account's or a person on the team testing their own widget. */
async function countsRefusals(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  if (context.isBot) return false;
  if (context.canary && record.member === context.canary) return false;
  return (await staffPreviewReason(storage, context, record.member)) === null;
}
/** The member's own reopen of their resolved request from "Did this solve
 * it?": the open limits and quotas of any reopen, then the same writes as a
 * member's reopen through /resolve. False, with nothing written, when the
 * workspace can't take it now. Mutates `record` and `support`; the caller
 * bumped the revision. */
async function memberReopen(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  support: SupportRecord,
): Promise<boolean> {
  try {
    await reserveRoomOpen(storage, context, "member");
  } catch (error) {
    // The checks run before its only write, so a refusal wrote nothing. The
    // answer stays, so this refusal is counted here rather than after a
    // rollback.
    if (!(error instanceof HttpError)) throw error;
    const cause = context.refusalCause;
    context.refusalCause = undefined;
    if (cause && (await countsRefusals(storage, context, record)))
      await recordSupportRefusal(storage, {
        reason: cause,
        clientId: null,
        nowMs: context.now,
      });
    return false;
  }
  const state = await readState(storage);
  record.state = "open";
  record.resolvedBy = null;
  record.confirmation = null;
  await save(storage, record);
  await storage.put(STATE_KEY, { ...state, open: state.open + 1 });
  const previous = support.state;
  support.state = "open";
  support.reopened++;
  support.reopenedAt = context.now;
  // "Did this solve it? No": the reopen alert and the escalation wait.
  await applyCaseEventWithAlerts(storage, context, record, support, {
    kind: "status",
    at: context.now,
    previous,
    state: "open",
    by: "member",
    stopped: record.stopped,
  });
  context.pendingAudit.push({
    actor: context.viewer.principalId!,
    action: "conversation.reopen",
    channelId: record.id,
    target: record.member,
  });
  return true;
}
/** Room object handler for `/conversations*`. Runs after the room proved the
 * viewer's room access. Writes need the runtime gate; authorized reads and
 * exports stay available after a rollback so history is recoverable. */
export async function conversationRoute(
  storage: Storage,
  context: ConversationContext,
): Promise<Response | null> {
  if (
    context.isBot &&
    context.viewer.principalId !== (await managedPrincipal(context.room)) &&
    !featureOn(context.mediaEnv, undefined, "agentApi")
  ) {
    if (
      context.mediaEnv.AGENT_API_ENABLED === "true" &&
      conversationAuthority(context.viewer).team &&
      releaseActivationReadUnknown(context.mediaEnv)
    )
      throw new HttpError(503, "Chat is temporarily unavailable.");
    throw notFound();
  }
  const aiWrite =
    /^\/conversations\/(tc-[0-9a-f]{32})\/(messages|workflow)$/.exec(
      context.pathname,
    );
  const aiWork =
    (Boolean(context.isBot) && (TELEGRAM_AI_PATH.test(context.pathname) || HANDOFF_LEARNING_PATH.test(context.pathname))) ||
    (context.method === "GET" &&
      /^\/conversations(?:\/draft-requests)?$/.test(context.pathname)) ||
    (context.method === "POST" &&
      aiWrite &&
      (aiWrite[2] === "messages" ||
        ["draft", "evidence"].includes(String(context.body.action))));
  if (
    aiWork &&
    (await templAiPrincipal(context.room, context.aliases, {
      env: context.mediaEnv,
      storage,
      principalId: context.viewer.principalId,
      permissions: context.viewer.permissions,
      isBot: Boolean(context.isBot),
      now: context.now,
    }))
  ) {
    if (!conversationAuthority(context.viewer).team) throw notFound();
    if (
      aiWrite &&
      (await authorize(storage, context, aiWrite[1])).role !== "team"
    )
      throw notFound();
    const product = await readProductState(
      storage,
      context.now,
      context.mediaEnv,
    );
    if (
      standardPlanForState(product)?.status === "demo" &&
      productMode(product) !== "exempt"
    )
      throw new HttpError(
        403,
        "Templ AI needs paid workspace access.",
        undefined,
        "standard-plan-required",
      );
  }
  if (context.viewer.principalId && context.aliases.length > 1)
    await linkBillingMembers(storage, context.aliases);
  if (context.headers.get("X-Support-Widget") === "member") {
    context.viewer = { ...context.viewer, isManager: false, permissions: [] };
  }
  const response = await conversationRoomRoute(storage, context);
  if (response && context.openQuotaUsed)
    response.headers.set(OPEN_USED_HEADER, context.openQuotaUsed);
  // Bot reads and exports hide ambiguous hex.
  // Authorization ran in the route above.
  // People see the thread as written: the member their own chat, staff the inbox.
  if (
    response?.ok &&
    response.headers.get("Content-Type")?.includes("application/json")
  ) {
    const thread = /tc-[0-9a-f]{32}/.exec(context.pathname)?.[0];
    const record = thread ? await readConversation(storage, thread) : null;
    const memberView =
      record &&
      (actsAs(context.aliases, record.member) ||
        record.formerMembers?.some((member) =>
          actsAs(context.aliases, member),
        ));
    const person =
      !context.isBot &&
      !context.pathname.endsWith("/export") &&
      (memberView || conversationAuthority(context.viewer).team);
    if (!person) {
      const shared = thread
        ? await sharedTransactionHashes(storage, thread)
        : [];
      return new Response(
        JSON.stringify(hideAmbiguousPayload(await response.json(), shared)),
        {
          status: response.status,
          headers: response.headers,
        },
      );
    }
  }
  return response;
}
async function conversationRoomRoute(
  storage: Storage,
  context: ConversationContext,
): Promise<Response | null> {
  const encryption = encryptionHooks(storage, context);
  const notice = await ownEncryptedNotice(storage, context, async id => (await authorize(storage, context, id)).record);
  if (notice) return notice;
  await requireLegacyCase(storage, context, encryption);
  const encrypted = await supportEncryptionRoute(storage, context, encryption).catch((error: unknown) => {
    if (error instanceof EncryptionProtocolError) throw new HttpError(409, error.message, undefined, error.code);
    throw error;
  });
  if (encrypted) return encrypted;
  const learning = await handoffLearningRoute(storage, context, {
    team: conversationAuthority(context.viewer).team,
    authorize: (id) => authorize(storage, context, id),
  });
  if (learning) return learning;
  const telegramAi = await telegramAiRoute(storage, context, {
    team: conversationAuthority(context.viewer).team,
    authorize: (id) => authorize(storage, context, id),
    send: (id, body, headers) =>
      conversationRoute(storage, {
        ...context,
        pathname: `/conversations/${id}/messages`,
        method: "POST",
        query: new URLSearchParams(),
        body,
        headers,
      }),
  });
  if (telegramAi) return telegramAi;
  const priority = await priorityRoute(storage, context);
  if (priority) return priority;
  // Case archive and consented action outcomes.
  // Thread authority comes from the same current-access predicate.
  const journey = await journeyOpsRoute(storage, context, (id) =>
    authorize(storage, context, id),
  );
  if (journey) return journey;
  // A lead can redact a stored ambiguous value.
  // The route checks current thread access.
  // Every revision is redacted in the same room transaction.
  await teamRefusalRoute(storage, context);
  const redacted = await redactHexRoute(storage, context);
  if (redacted) return redacted;
  const nameResponse = await staffDisplayNameRoute(
    storage,
    context,
    conversationAuthority(context.viewer).team,
  );
  if (nameResponse) return nameResponse;
  // Feature routes. A feature route module checks
  // the viewer's current access to the workspace and the thread on every
  // read and write, and returns null for a path it does not own.
  // Case ledger, drafts, evidence and AI-off routes.
  {
    const cases = await caseFeatureRoute(storage, context, {
      authorize: (id) => authorize(storage, context, id),
      canRead: (id) => canReadConversation(storage, context, id),
      team: conversationAuthority(context.viewer).team,
    });
    if (cases) return cases;
  }
  // Read-audit, export and deletion hooks.
  {
    // The staff read log: a team read of a thread, its messages, its
    // workflow (notes included) or one screenshot, before the route answers.
    const read =
      context.method === "GET"
        ? /^\/conversations\/(tc-[0-9a-f]{32})(?:\/(messages|workflow))?$/.exec(
            context.pathname,
          )
        : null;
    if (read) {
      const authorized = await authorize(storage, context, read[1]).catch(
        () => null,
      );
      const attachment =
        read[2] === "workflow" ? context.query.get("attachment") : null;
      if (authorized?.role === "team" && context.viewer.principalId)
        noteRead(context.pendingAudit, {
          room: context.room,
          actor: context.viewer.principalId,
          thread: read[1],
          member: authorized.record.member,
          role: readRole({
            isManager: context.viewer.isManager,
            isBot: context.isBot,
          }),
          via: attachment
            ? "attachment"
            : read[2] === "workflow"
              ? "workflow"
              : "thread",
          ...(attachment ? { attachment } : {}),
          now: context.now,
        });
    }
    // The manager's workspace export.
    const exported = await workspaceExportRoute(storage, context, {
      canRead: (id) => canReadConversation(storage, context, id),
    });
    if (exported) return exported;
  }
  // The diagnosis route, auto-run and the headroom guard.
  {
    // Transaction checks (team only) and the automatic runs a member's
    // shared transaction or an Ask AI request queues.
    const diagnosis = await diagnosisRoomRoute(storage, context, {
      authorize: (id) => authorize(storage, context, id),
    });
    if (diagnosis) return diagnosis;
  }
  // Label and review queue routes.
  {
    const quality = await knowledgeQualityRoute(storage, context, {
      authorize: (id) => authorize(storage, context, id),
    });
    if (quality) return quality;
  }
  // Follow-up and specialist routes.
  {
    // Follow-ups, routing settings, the specialist allowlist, position
    // reads, and the resolve guard while follow-ups are open.
    const followUps = await followUpFeatureRoute(storage, context, {
      authorize: (id) => authorize(storage, context, id),
    });
    if (followUps) return followUps;
  }
  // Ask AI dispatch to the managed runner, without polling.
  {
    // Managed AI: its settings, golden set and runner routes, the checks on
    // the managed account's own replies and drafts, then the job a member's
    // message or an Ask AI question queues in this write's transaction.
    const managedDeps = {
      authorize: (id: string) => authorize(storage, context, id),
      team: conversationAuthority(context.viewer).team,
    };
    const managed = await managedRoomRoute(storage, context, managedDeps);
    if (managed) return managed;
    await queueManagedJob(storage, context, managedDeps);
  }
  // Text-free push alert subscriptions (team only).
  {
    const push = await staffPushRoute(storage, {
      method: context.method,
      pathname: context.pathname,
      body: context.body,
      viewer: context.viewer,
      aliases: context.aliases,
      team: conversationAuthority(context.viewer).team,
      env: context.mediaEnv as StaffPushEnv,
      now: context.now,
    });
    if (push) return push;
  }
  // Team alert routes: alert channels, the escalation target, the member's reply-email ticket and seen marker.
  {
    const telegram = await nativeTelegramRoute(storage, context);
    if (telegram) return telegram;
    const alerts = await alertsFeatureRoute(storage, context, {
      canRead: (id) => canReadConversation(storage, context, id),
    });
    if (alerts) return alerts;
  }
  // Pilot settings and the identity-free metrics export: team views for the
  // manager and support leads.
  {
    const pilot = await pilotRoute(storage, context);
    if (pilot) return pilot;
  }
  // The widget's notice mark, the copy's counts for the
  // manager and support leads, and a member's privacy request or objection.
  {
    const corpus = await corpusRoute(storage, context, {
      authorize: (id) => authorize(storage, context, id),
    });
    if (corpus) return corpus;
  }
  // Knowledge and saved-reply file imports.
  // Every call checks the current team role before it parses or stores an entry.
  const imported = await supportImportRoute(storage, context);
  if (imported) return imported;
  const match = CONVERSATION_ROUTE.exec(context.pathname);
  if (!match) return null;
  const [, action, id, sub, messageId, messageAction] = match;
  const { viewer, aliases, method, now } = context;
  // The workspace's AI agent is running when a registered bot on the team
  // makes a request an answering agent makes. Memory only.
  context.typing?.presence.note({
    principal: viewer.principalId ?? null,
    aliases,
    registeredBot:
      Boolean(context.isBot) &&
      aliases.some((id) => (context.registeredBots ?? []).includes(id)),
    team: conversationAuthority(viewer).team,
    request: {
      ...(action ? { action } : {}),
      ...(id ? { thread: id } : {}),
      ...(sub ? { sub } : {}),
      filter: context.query.get("filter"),
    },
    now,
  });
  const enabled = context.headers.get(CONVERSATIONS_HEADER) === "true";
  const supportWorkflowAvailable =
    enabled && context.headers.get(SUPPORT_WORKFLOW_HEADER) === "true";
  const product = await roomProduct(storage, now, context.mediaEnv);
  // A paused workspace waits for a top-up: the team reads and exports, and
  // claims and workflow writes wait.
  const supportEnabled = product?.enabled === true;
  const canClaim = supportWorkflowAvailable && supportEnabled;
  const workflowWritable = supportWorkflowAvailable && supportEnabled;
  /** The viewer's view. Team views also say why a reply from this viewer
   * would be refused now. */
  const view = async (
    record: TeamConversationRecord,
    role: "member" | "team",
  ) => ({
    ...conversationView(
      record,
      role,
      viewer,
      enabled,
      { aliases, canClaim },
      role === "team"
        ? {
            ...(await teamExtras(storage, context, record)),
            billing: await latestCaseBilling(storage, record),
            assignmentTeamName: record.assignment
              ? await readTeamName(storage, record.assignment.principalId)
              : null,
          }
        : // Member closed-state labels.
          // An absent resolver alone does not identify abandonment.
          {
            solve: await memberSolve(storage, record, now),
            closed:
              (await supportRecord(storage, record)).state === "abandoned"
                ? "abandoned"
                : record.archivedAt !== undefined
                  ? "archived"
                  : undefined,
          },
    ),
    ...(record.encryptedCases ? { encryption: await encryptedCaseView(storage, record.id, (await supportRecord(storage, record)).caseSeq ?? 0) } : {}),
  });
  const actor = viewer.principalId;
  const messageView = async (
    record: TeamConversationRecord,
    role: "member" | "team",
    message: ChatMessage,
  ) =>
    (
      await conversationMessageNames(
        storage,
        record,
        [message],
        role,
        context.bots ?? [],
        {},
        context.mediaEnv,
      )
    ).messages[0];
  /** A thread read: team views also carry the support summary with who
   * acts next. */
  /** An open request's summary with the facts behind its next step; only
   * the rows a view returns read them. */
  const withJourney = async (
    record: TeamConversationRecord,
    support: SupportSummary,
  ): Promise<SupportSummary> =>
    record.state === "open" &&
    (support.state === "open" || support.state === "waiting")
      ? { ...support, journey: await supportJourney(storage, record, now) }
      : support;
  const threadView = async (
    record: TeamConversationRecord,
    role: "member" | "team",
  ) => {
    const shown = await view(record, role);
    if (role === "member")
      return {
        ...shown,
        diagnosisRunning: await diagnosisPending(
          storage,
          diagnosisThreadFacts(record, await supportRecord(storage, record)),
          enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
          now,
        ),
      };
    if (role !== "team" || !actor) return shown;
    return {
      ...shown,
      support: await withJourney(
        record,
        await readSupportSummary(
          storage,
          record,
          actor,
          await teamSummaryInput(storage, context),
        ),
      ),
    };
  };
  if (action === "pulse") {
    // Counts and times only, for the team.
    if (method !== "GET" || !actor || !conversationAuthority(viewer).team)
      throw new HttpError(404, "Support tools not found.");
    const pulse = await supportPulse(
      storage,
      await pulseOpen(storage, context),
      now,
      await teamSummaryInput(storage, context),
    );
    return json(pulse);
  }
  if (action) {
    const support = await supportRoomRoute(
      storage,
      context,
      action,
      conversationAuthority(viewer).team,
      supportWorkflowAvailable,
    );
    if (support) return support;
  }
  const isMember = actor ? await context.isRoomMember(actor) : false;
  if (action === "status" && method === "GET") {
    let mine: string | null = null;
    if (actor)
      for (const alias of aliases) {
        const found = await storage.get<string>(memberIndexKey(alias));
        if (isConversationId(found)) {
          mine = found;
          break;
        }
      }
    const status = conversationStatus(
      viewer,
      enabled,
      mine,
      isMember || context.visibility === "public",
      {
        available: supportWorkflowAvailable,
        canClaim,
      },
      product,
    );
    status.encryption = await newCaseEncryptionView(storage);
    return json(
      status.team
        ? {
            ...status,
            needsReplyReady:
              (await ensureLedgerMarker(storage, now)) === "ready",
          }
        : status,
    );
  }
  if (action === "join" && method === "POST") {
    if (!actor) throw new HttpError(401, "Sign in to contact the team.");
    if (context.visibility !== "public") throw notFound();
    if (!isMember) await context.admitMember(actor);
    return json({ ok: true, member: true });
  }
  if (!action && !id && method === "GET") {
    if (!actor)
      return json({ filter: "open", conversations: [], nextCursor: null });
    const filter = (context.query.get("filter") ??
      "open") as TeamConversationFilter;
    if (!LIST_FILTERS.includes(filter))
      throw new HttpError(400, "Choose a valid inbox view.");
    const authority = conversationAuthority(viewer);
    const indexed = INDEX_FILTERS.includes(filter);
    const cursor = context.query.get("cursor");
    if (
      cursor !== null &&
      !(indexed ? AWAITING_CURSOR.test(cursor) : isConversationId(cursor))
    )
      throw new HttpError(400, "Invalid cursor.");
    const conversations: TeamConversation[] = [];
    if (context.query.get("view") === "member") {
      if (filter !== "all" && filter !== "open") throw new HttpError(400, "Choose a valid conversation view.");
      // Start from this viewer's indexes, even when the viewer also has a
      // team role. Links and a supplied cursor never grant member access.
      const queue = await Promise.all(aliases.map(alias => storage.get<string>(memberIndexKey(alias))));
      const visited = new Set<string>();
      let afterCursor = cursor === null;
      for (const id of queue) {
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const record = await readConversation(storage, id);
        if (!record || record.room !== context.room || !actsAs(aliases, record.member)) continue;
        queue.push(record.previousConversation, ...(record.linkedConversations ?? []));
        if (!afterCursor) {
          afterCursor = id === cursor;
          continue;
        }
        if (record.archivedAt !== undefined || (filter === "open" && record.state !== "open")) continue;
        const data = await supportRecord(storage, record);
        const last = record.lastMessageAt ?? 0;
        const staff = data.lastStaffReplyAt ?? 0;
        const agent = data.lastAgentReplyAt === undefined
          ? last > Math.max(staff, data.lastMemberMessageAt ?? 0) ? last : 0
          : data.lastAgentReplyAt ?? 0;
        const reply = Math.max(staff, agent);
        conversations.push({
          ...await view(record, "member"),
          ...(reply ? { lastReplyAt: new Date(reply).toISOString() } : {}),
        });
        if (conversations.length === 51) break;
      }
      return json({
        filter,
        conversations: conversations.slice(0, 50),
        nextCursor: conversations.length > 50 ? conversations[49].id : null,
      } satisfies TeamConversationList);
    }
    if (authority.team) {
      // Read once per list: who acts next on each row depends on them.
      const team: Omit<TeamSummaryInput, "record"> = await teamSummaryInput(
        storage,
        context,
      );
      const memberFilter = context.query.get("member");
      /** Templ's hourly check shows only in All, or when asked for by
       * member. */
      const hidden = (record: TeamConversationRecord) =>
        Boolean(team.canary) &&
        record.member === team.canary &&
        filter !== "all" &&
        memberFilter !== record.member;
      const tagFilter = context.query.get("tag");
      const categoryFilter = context.query.get("category");
      if ((tagFilter && tagFilter.length > 40) || (categoryFilter && categoryFilter.length > 60))
        throw new HttpError(400, "Choose valid case filters.");
      const assigneeFilter = context.query.get("assignee");
      const afterFilter = context.query.get("after");
      const beforeFilter = context.query.get("before");
      if (
        (afterFilter && !Number.isFinite(Date.parse(afterFilter))) ||
        (beforeFilter && !Number.isFinite(Date.parse(beforeFilter)))
      )
        throw new HttpError(400, "Choose valid dates for the case filter.");
      /** The query filters every view shares. */
      const matches = (
        record: TeamConversationRecord,
        support: SupportSummary,
      ) =>
        (filter === "archived"
          ? record.archivedAt !== undefined
          : record.archivedAt === undefined) &&
        !(memberFilter && record.member !== memberFilter) &&
        !(tagFilter && !support.tags.some(tag => tag.toLowerCase() === tagFilter.trim().toLowerCase())) &&
        !(categoryFilter && support.category !== categoryFilter) &&
        !(
          assigneeFilter && record.assignment?.principalId !== assigneeFilter
        ) &&
        !(afterFilter && record.createdAt < Date.parse(afterFilter)) &&
        !(beforeFilter && record.createdAt > Date.parse(beforeFilter));
      /** A registered bot's queue excludes requests awaiting a person or with AI off. */
      const row = async (
        record: TeamConversationRecord,
        support: SupportSummary,
      ): Promise<TeamConversation | null> => {
        const role = actsAs(aliases, record.member) ? "member" : "team";
        const shown = await view(record, role);
        if (context.isBot && (record.handoff || shown.ai?.mode === "off"))
          return null;
        if (role !== "team") return shown;
        return { ...shown, support: await withJourney(record, support) };
      };
      if (indexed || filter === "waiting-on-member") {
        // Views of who acts next read the case ledger. Until its backfill is
        // done they are refused rather than shown incomplete.
        if ((await ensureLedgerMarker(storage, now)) !== "ready")
          throw new HttpError(
            409,
            "Needs reply is still being set up. Try again in a minute.",
            30,
            "needs-reply-preparing",
          );
      }
      if (indexed) {
        // Requests waiting for a reply now, oldest wait first.
        const keys: string[] = [];
        const entries = await needsReplyPage(
          storage,
          cursor ? `${AWAITING_PREFIX}${cursor.replace("-", ":")}` : null,
          1_001,
        );
        const turn = INDEX_TURN[filter];
        for (const entry of entries) {
          // Rows for the other view are skipped before any read.
          if (turn && awaitingTurn(entry, team).turn !== turn) continue;
          const record = await readConversation(storage, entry.thread);
          if (!record || record.room !== context.room || hidden(record))
            continue;
          const support = await readSupportSummary(
            storage,
            record,
            actor,
            team,
          );
          // The record decides the row's turn; the index only skipped rows.
          if (turn && support.turn !== turn) continue;
          if (!matches(record, support)) continue;
          const shown = await row(record, support);
          if (!shown) continue;
          conversations.push(shown);
          keys.push(entry.key);
          if (conversations.length === 51) break;
        }
        const result: TeamConversationList = {
          filter,
          conversations: conversations.slice(0, 50),
          nextCursor:
            conversations.length > 50
              ? keys[49].slice(AWAITING_PREFIX.length).replace(":", "-")
              : null,
        };
        return json(result);
      }
      // Open views read the open-thread index once it is ready; the other
      // views, and every view before then, scan at most LIST_SCAN_RECORDS
      // records per call and hand back a cursor when more remain.
      // All without filters needs one page, even when old records live in
      // cold partitions. Continue from the last checked key on later pages.
      const browseAll = filter === "all" && !memberFilter && !assigneeFilter &&
        !tagFilter && !categoryFilter && !afterFilter && !beforeFilter;
      const scanLimit = product && browseAll
        ? 128
        : product ? LIST_SCAN_RECORDS : TEAM_CONVERSATION_LIMITS.retainedRecordsPerRoom;
      const page =
        OPEN_INDEX_FILTERS.includes(filter) && (await openIndexReady(storage))
          ? await openIndexRecords(storage, cursor)
          : await storage.list<unknown>({
              prefix: RECORD_PREFIX,
              limit: scanLimit,
              ...(cursor ? { startAfter: recordKey(cursor) } : {}),
            });
      const scanned = page.size >= scanLimit ? [...page.keys()].at(-1) : null;
      const reader = viewReader(storage, context);
      const visibleRow = async (record: TeamConversationRecord) => {
        const support = await readSupportSummary(reader, record, actor, team);
        const active = ["open", "waiting"].includes(support.state);
        if (filter === "waiting-on-member" && (!active || support.turn !== "member")) return null;
        if (filter === "unassigned" && (record.assignment || !active)) return null;
        if (filter === "mine" && (!record.assignment ||
          !actsAs(aliases, record.assignment.principalId) || !active)) return null;
        if (filter === "open" && !active) return null;
        if (filter === "needs-person" && (!active || !record.handoff)) return null;
        if (["waiting", "resolved", "abandoned", "spam"].includes(filter) &&
          support.state !== filter) return null;
        return matches(record, support) ? row(record, support) : null;
      };
      // Run a bounded set of row reads at once. Keep storage order and
      // the 51st-row lookahead even when a row does not match.
      let batch: TeamConversationRecord[] = [];
      const collect = async () => {
        for (const shown of await Promise.all(batch.map(visibleRow))) {
          if (shown) conversations.push(shown);
          if (conversations.length === 51) break;
        }
        batch = [];
      };
      for (const raw of page.values()) {
        const record = checkedRecord(raw);
        if (!record || record.room !== context.room || hidden(record) ||
            (filter === "archived") !== (record.archivedAt !== undefined) ||
            (memberFilter && record.member !== memberFilter)) continue;
        batch.push(record);
        if (batch.length === 8) await collect();
        if (conversations.length === 51) break;
      }
      if (batch.length) await collect();
      const result: TeamConversationList = {
        filter,
        conversations: conversations.slice(0, 50),
        // The lookahead belongs to the next page, not to its exclusive cursor.
        // A scan that stopped at its limit hands back where it stopped.
        nextCursor:
          conversations.length > 50
            ? conversations[49].id
            : scanned
              ? scanned.slice(RECORD_PREFIX.length)
              : null,
      };
      return json(result);
    }
    for (const alias of aliases) {
      const found = await storage.get<string>(memberIndexKey(alias));
      const record = found ? await readConversation(storage, found) : null;
      if (record && (filter === "all" || record.state === filter))
        conversations.push(await view(record, "member"));
    }
    const result: TeamConversationList = {
      filter,
      conversations,
      nextCursor: null,
    };
    return json(result);
  }
  if (action === "ask" && method === "POST") {
    if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
    if (!actor) throw new HttpError(401, "Sign in to ask the team.");
    if (!isMember && context.visibility !== "public") throw notFound();
    if (viewer.banned)
      throw new HttpError(403, "You are banned from posting in this chat.");
    if (viewer.mutedUntil)
      throw new HttpError(403, "You are muted in this chat.");
    const lead = await checkedSupportLead(context);
    // A member's own ask that the workspace may turn away: counted by cause
    // when it is. Never a test account, support staff or a bot.
    if (
      !context.isBot &&
      !(await supportSettings(storage)).testAccounts.includes(actor) &&
      !(await context.isSupportStaff?.(actor))
    )
      context.memberWrite = {
        clientId:
          typeof context.body.clientId === "string"
            ? context.body.clientId
            : null,
      };
    const askRetry =
      typeof context.body.text === "string" && context.body.text.trim()
        ? messageClientId(context.body.clientId, now)
        : undefined;
    if (askRetry) {
      const retries = await Promise.all(
        aliases.map((id) =>
          storage.get<{ conversationId: string; newCaseFrom?: string }>(
            `${messageClientPrefix}${askRetry.timestampHex}:ask:${id}:${askRetry.clientId}`,
          ),
        ),
      );
      const found = retries.filter((entry) => entry !== undefined);
      if (
        new Set(
          found.map((entry) => `${entry.conversationId}:${entry.newCaseFrom}`),
        ).size > 1
      )
        throw new HttpError(503, "Chat is temporarily unavailable.");
      const saved = found[0];
      if (saved) {
        if (saved.newCaseFrom !== context.body.newCaseFrom)
          throw new HttpError(
            409,
            "This message ID was already used for another case.",
          );
        if (saved.newCaseFrom) {
          const parent = await authorize(storage, context, saved.newCaseFrom);
          if (parent.role !== "member") throw notFound();
        }
        const previous = await authorize(
          storage,
          context,
          saved.conversationId,
        );
        if (previous.role !== "member") throw notFound();
        const message = await previousMessage(
          storage,
          context,
          previous.record,
          context.body,
        );
        if (!message)
          throw new HttpError(503, "Chat is temporarily unavailable.");
        if (lead)
          assertSupportLeadRetry(
            await supportRecord(storage, previous.record),
            context,
            lead,
          );
        return json({
          conversation: await view(previous.record, "member"),
          message: await messageView(previous.record, "member", message),
          opened: false,
        });
      }
    }
    // Asking is an intentional public join. The room transaction rolls this
    // back if opening or posting fails; status and other reads never admit.
    if (!isMember) await context.admitMember(actor);
    let member = actor;
    let newCase:
      | {
          previous: TeamConversationRecord;
          retry: NonNullable<ReturnType<typeof messageClientId>>;
          textHash: string;
        }
      | undefined;
    if (context.body.newCaseFrom !== undefined) {
      if (!isConversationId(context.body.newCaseFrom))
        throw new HttpError(400, "Choose the previous case.");
      const previous = await authorize(
        storage,
        context,
        context.body.newCaseFrom,
      );
      if (previous.role !== "member") throw notFound();
      const text = messageText(context.body.text);
      const retry = messageClientId(context.body.clientId, now);
      if (!retry) throw new HttpError(400, "Include a new message ID.");
      const textHash = await messageTextHash(text);
      const retries = await Promise.all(
        aliases.map((id) =>
          storage.get<MessageClientRecord>(
            `${messageClientPrefix}${retry.timestampHex}:${previous.record.id}:${id}:${retry.clientId}`,
          ),
        ),
      );
      const found = retries.filter((entry): entry is MessageClientRecord =>
        Boolean(entry),
      );
      if (
        new Set(
          found.map((entry) => `${entry.newConversationId}:${entry.messageId}`),
        ).size > 1
      )
        throw new HttpError(503, "Chat is temporarily unavailable.");
      const saved = found[0];
      if (saved) {
        if (
          saved.textHash !== textHash ||
          saved.replyTo !== replyReference(context.body.replyTo)
        )
          throw new HttpError(
            409,
            "This message ID was already used for different text.",
          );
        if (!saved.newConversationId)
          throw new HttpError(409, "Include a new message ID.");
        const child = await authorize(
          storage,
          context,
          saved.newConversationId,
        );
        if (
          child.role !== "member" ||
          child.record.previousConversation !== previous.record.id
        )
          throw new HttpError(503, "Chat is temporarily unavailable.");
        const message = await previousMessage(
          storage,
          context,
          child.record,
          context.body,
        );
        if (!message || message.id !== String(saved.messageId))
          throw new HttpError(503, "Chat is temporarily unavailable.");
        if (lead)
          assertSupportLeadRetry(
            await supportRecord(storage, child.record),
            context,
            lead,
          );
        return json({
          conversation: await view(child.record, "member"),
          message: await messageView(child.record, "member", message),
          opened: false,
        });
      }
      const parallel =
        previous.record.state !== "resolved" &&
        previous.record.encryptedCases !== true &&
        context.headers.get("X-Support-Widget") === "member" &&
        await featureOn(context.mediaEnv, storage, "supportParallelConversations");
      if (
        (previous.record.state !== "resolved" && !parallel) ||
        (await storage.get<string>(memberIndexKey(previous.record.member))) !==
          previous.record.id
      )
        throw new HttpError(
          409,
          "Open your latest case before starting another.",
          undefined,
          "new-case-stale",
        );
      if (
        Number.parseInt(retry.timestampHex, 16) + 60_000 <
        (previous.record.resolvedBy?.at ??
          previous.record.lastMessageAt ??
          previous.record.createdAt)
      )
        throw new HttpError(400, "Include a new message ID.");
      if (context.headers.get("X-Support-Install-Preview") === "1")
        throw new HttpError(
          409,
          "Start a new install check.",
          undefined,
          "install-preview-existing",
        );
      member = previous.record.member;
      newCase = { previous: previous.record, retry, textHash };
    }
    if (!newCase)
      for (const alias of aliases) {
        const id = await storage.get<string>(memberIndexKey(alias));
        const current = id ? await readConversation(storage, id) : null;
        if (current?.room === context.room && actsAs(aliases, current.member)) {
          member = current.member;
          break;
        }
      }
    const existingId = await storage.get<string>(memberIndexKey(member));
    const existing =
      !newCase && existingId
        ? await readConversation(storage, existingId)
        : null;
    const prior = existing
      ? await previousMessage(storage, context, existing, context.body)
      : null;
    if (existing && prior) {
      if (lead)
        assertSupportLeadRetry(
          await supportRecord(storage, existing),
          context,
          lead,
        );
      return json({
        conversation: await view(existing, "member"),
        message: await messageView(existing, "member", prior),
        opened: false,
      });
    }
    // Install previews require a new member thread.
    // A matching message retry returned above.
    // A checked preview cannot change an existing case's billing exclusion.
    if (!existing) await requireLegacyOpening(storage);
    if (existing && context.headers.get("X-Support-Install-Preview") === "1")
      throw new HttpError(
        409,
        "Start a new install check.",
        undefined,
        "install-preview-existing",
      );
    // An empty ask still creates a record. It cannot manufacture a new case
    // after support expires; real messages also enforce admission below.
    if (
      !existing &&
      !(typeof context.body.text === "string" && context.body.text.trim()) &&
      (await storage.get(PRODUCT_STATE_KEY))
    )
      await admitMemberRequest(storage, {
        nowMs: now,
        newRequest: true,
        env: context.mediaEnv,
      });
    // Shared context is checked before anything opens, so an invalid one
    // refuses the ask with no record, guest allowance or count used.
    let shared: Awaited<ReturnType<typeof writeSupportContext>> | undefined;
    if (context.body.context !== undefined) {
      if (context.body.contextConsent !== true)
        throw new HttpError(
          400,
          "Review and approve the context shared with the team.",
        );
      shared = await writeSupportContext(
        existing ? (await supportRecord(storage, existing)).context : null,
        context.body.context,
        context.headers,
        await featureOn(context.mediaEnv, storage, "supportDiagnostics"),
      );
    }
    const memberHandoff = context.body.handoff;
    if (
      memberHandoff !== undefined &&
      (!memberHandoff ||
        typeof memberHandoff !== "object" ||
        Array.isArray(memberHandoff) ||
        Object.keys(memberHandoff).join() !== "by" ||
        (memberHandoff as { by?: unknown }).by !== "member" ||
        context.isBot)
    )
      throw new HttpError(400, "Ask for a person from your own case.");
    if (!existing && widgetGuest(context.headers))
      await reserveGuestOpen(storage, context);
    const opened = await openFor(
      storage,
      context,
      member,
      { kind: "member", principalId: actor },
      newCase?.previous.id,
    );
    let record = opened.record;
    if (
      shared ||
      lead ||
      (opened.created && context.headers.get("X-Support-Widget") === "member")
    ) {
      const support = await supportRecord(storage, record);
      if (shared) support.context = shared;
      if (lead) recordSupportLead(support, context, lead);
      // A widget thread carries its access level from the first request,
      // before any message, so staff never see it as written from the app.
      if (context.headers.get("X-Support-Widget") === "member")
        recordWidgetAccess(support, context.headers, now);
      await storage.put(`support-workflow-v1:${record.id}`, support);
    }
    if (memberHandoff !== undefined && !record.handoff) {
      const support = await supportRecord(storage, record);
      await writeHandoff(storage, context, record, support, {
        at: now,
        reason: "person",
        by: "member",
        requestAt: support.requestedAt ?? now,
      });
    }
    if (record.stopped) {
      // "Ask the team again": the member's own explicit action clears it.
      record = {
        ...record,
        stopped: false,
        stoppedAt: null,
        revision: record.revision + 1,
      };
      await save(storage, record);
      // A new wait starts when the request is still unanswered.
      await applyCaseEventWithAlerts(
        storage,
        context,
        record,
        await supportRecord(storage, record),
        { kind: "stop", at: now, stopped: false },
      );
      context.pendingAudit.push({
        actor,
        action: "conversation.resume",
        channelId: record.id,
        target: record.member,
      });
    }
    if (opened.opened) {
      context.pendingAudit.push({
        actor,
        action: opened.created ? "conversation.open" : "conversation.reopen",
        channelId: record.id,
        target: record.member,
      });
      await emit(context, record);
    }
    const authorized: Authorized = {
      record,
      role: "member",
      authority: conversationAuthority(viewer),
    };
    let message: ChatMessage | undefined;
    if (typeof context.body.text === "string" && context.body.text.trim()) {
      const posted = await postMessage(
        storage,
        context,
        authorized,
        context.body,
        shared ? sharedMessageDetails(context.body.context) : undefined,
      );
      // Only an AI agent's reply is ever held; a member's ask never is.
      if ("held" in posted) throw new Error("A user case was held.");
      message = posted.message;
      record = posted.record;
    }
    if (newCase && message) {
      await storage.put(
        `${messageClientPrefix}${newCase.retry.timestampHex}:${newCase.previous.id}:${actor}:${newCase.retry.clientId}`,
        {
          messageId: Number(message.id),
          textHash: newCase.textHash,
          newConversationId: record.id,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        } satisfies MessageClientRecord,
      );
      await storage.put(
        "message-client-count",
        ((await storage.get<number>("message-client-count")) ?? 0) + 1,
      );
    }
    if (askRetry && message) {
      await storage.put(
        `${messageClientPrefix}${askRetry.timestampHex}:ask:${actor}:${askRetry.clientId}`,
        {
          conversationId: record.id,
          ...(newCase ? { newCaseFrom: newCase.previous.id } : {}),
        },
      );
      await storage.put(
        "message-client-count",
        ((await storage.get<number>("message-client-count")) ?? 0) + 1,
      );
    }
    if (shared?.transactions?.length)
      await applyTransactionRule(storage, context, record, true);
    return json(
      {
        conversation: await view(record, "member"),
        ...(message
          ? { message: await messageView(record, "member", message) }
          : {}),
        opened: opened.opened,
      },
      opened.created ? 201 : 200,
    );
  }
  if (action === "start" && method === "POST") {
    if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
    if (!actor) throw new HttpError(401, "Sign in to chat.");
    const authority = conversationAuthority(viewer);
    if (!authority.canStart)
      throw new HttpError(403, "You do not have permission to do that.");
    if (viewer.banned)
      throw new HttpError(403, "You are banned from posting in this chat.");
    if (viewer.mutedUntil)
      throw new HttpError(403, "You are muted in this chat.");
    // A known member principal from the room's own records, never a name,
    // wallet or email; having an id proves nothing without membership.
    const member = normalizeChatPrincipal(context.body.member);
    if (!member) throw new HttpError(400, MEMBER_NOT_FOUND_ERROR);
    if (actsAs(aliases, member)) throw new HttpError(400, SELF_ERROR);
    if (!(await context.isRoomMember(member)))
      throw new HttpError(404, MEMBER_NOT_FOUND_ERROR);
    if (typeof context.body.text !== "string" || !context.body.text.trim())
      throw new HttpError(400, "Write a first message.");
    const existingId = await storage.get<string>(memberIndexKey(member));
    const existing = existingId
      ? await readConversation(storage, existingId)
      : null;
    if (existing?.stopped)
      throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
    const prior = existing
      ? await previousMessage(storage, context, existing, context.body)
      : null;
    if (existing && prior)
      return json({
        conversation: await view(existing, "team"),
        message: await messageView(existing, "team", prior),
        opened: false,
      });
    const opened = await openFor(storage, context, member, {
      kind: "staff",
      principalId: actor,
    });
    if (opened.record.stopped)
      throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
    if (opened.opened) {
      context.pendingAudit.push({
        actor,
        action: opened.created ? "conversation.start" : "conversation.reopen",
        channelId: opened.record.id,
        target: member,
      });
      await emit(context, opened.record);
    }
    const posted = await postMessage(
      storage,
      context,
      { record: opened.record, role: "team", authority },
      context.body,
    );
    if ("held" in posted) return heldReplyResponse(posted.held);
    return json(
      {
        conversation: await view(posted.record, "team"),
        message: await messageView(posted.record, "team", posted.message),
        opened: opened.opened,
      },
      opened.created ? 201 : 200,
    );
  }
  if (!id) return null;
  const authorized = await authorize(storage, context, id);
  const { record, role } = authorized;
  if (sub === "workflow")
    return supportThreadRoute(
      storage,
      context,
      record,
      role,
      { available: supportWorkflowAvailable, writable: workflowWritable },
      {
        reopen: (target, support) =>
          memberReopen(storage, context, target, support),
        view: (target) => view(target, role),
      },
    );
  if (!sub && method === "GET")
    return json({
      conversation: await threadView(record, role),
    });
  if (sub === "messages" && !messageId && method === "GET") {
    const { before, limit } = messagePagination(
      new URL(`https://internal${context.pathname}?${context.query}`),
      50,
    );
    const page = await readPage(storage, record.id, before, limit);
    const messages = await renderMessages(storage, record.id, page.rows, {
      joinLimit: Math.min(limit, MAX_REPLY_JOINS),
      aliases,
    });
    const { typing, aiQueued } = await threadTyping(storage, context, record, enabled, {
      role,
      newest: before === null ? (page.rows.at(-1) ?? null) : null,
    });
    const shown = await threadView(record, role);
    // Readiness for the next send is separate from a bot's short-lived typing mark.
    const visitorReplyPolicy = role === "member" && before === null &&
      record.room === `room:${OWN_SUPPORT_ENDPOINT.workspace}`;
    let aiReplyExpected = false;
    if (visitorReplyPolicy && enabled && !record.handoff && !record.assignment && !record.stopped &&
        !record.deleting && !shown.encryption && record.state === "open" && record.member !== context.canary &&
        (await agentState(context)).registered) {
      const reader = viewReader(storage, context);
      const {data, effective} = await readAiState(reader, record);
      aiReplyExpected = data.state !== "resolved" && data.state !== "spam" && effective.mode === "answers" &&
        await teamReplyBlock(reader, context, record, effective.mode) === null;
    }
    const result: TeamConversationMessages = {
      conversation: {
        ...shown,
        ...(visitorReplyPolicy ? { aiReplyExpected } : {}),
        ...(aiQueued ? { aiQueued } : {}),
      },
      deletionRevision:
        (await storage.get<number>(`channel-deletions:${record.id}`)) ?? 0,
      nextBefore: page.nextBefore,
      ...(await conversationMessageNames(
        storage,
        record,
        messages,
        role,
        context.bots ?? [],
        await context.authors(messages),
        context.mediaEnv,
      )),
      ...(role === "member"
        ? {
            joined: await teamJoins(
              storage,
              record,
              messages,
              page.nextBefore !== null,
              context.mediaEnv,
            ),
          }
        : {}),
      typing,
      // Team only: why the AI agent wrote each of its replies on this page.
      ...(role === "team"
        ? {
            provenance: await provenancePage(
              storage,
              record.id,
              messages.map((message) => message.id),
              () => supportSettings(storage),
              context.isBot ? "agent" : "team",
            ),
          }
        : {}),
      // The member's widget learns here, in the same read, whether the team
      // asked it to verify a wallet.
      ...(role === "member" &&
      context.headers.get("X-Support-Widget") === "member"
        ? {
            workflow: {
              verificationRequested: await memberVerificationRequested(
                storage,
                record,
              ),
            },
          }
        : {}),
    };
    return json(result);
  }
  if (sub === "export" && method === "GET") {
    const policy = await admitExport(storage, actor!, now, aliases);
    const { before, limit } = messagePagination(
      new URL(`https://internal${context.pathname}?${context.query}`),
      policy.pageSize,
    );
    const page = await readPage(storage, record.id, before, limit);
    const messages = await renderMessages(storage, record.id, page.rows, {
      joinLimit: MAX_REPLY_JOINS,
      aliases,
    });
    // A download starts with its first page: one entry per download.
    if (before === null)
      context.pendingAudit.push({
        actor: actor!,
        action: "conversation.export",
        channelId: record.id,
        target: record.member,
      });
    return json({
      conversation: await view(record, role),
      ...(await conversationMessageNames(
        storage,
        record,
        messages,
        role,
        context.bots ?? [],
        {},
        context.mediaEnv,
      )),
      nextBefore: page.nextBefore,
      export: {
        schemaVersion: 1,
        pageSize: policy.pageSize,
        nextRequestAfterMs: policy.nextRequestAfterMs,
        scope: "conversation",
      },
    });
  }
  if (method !== "POST") return null;
  if (sub === "typing" && !messageId) {
    // A team reply's access, stop and plan refusals, on every call. The
    // mark holds no text and stays in this object's memory; it spends no
    // message or usage allowance and opens nothing.
    if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
    if (role !== "team")
      throw new HttpError(
        403,
        "Only the team can show that a reply is being written.",
        undefined,
        "team-only",
      );
    if (viewer.banned)
      throw new HttpError(403, "You are banned from posting in this chat.");
    if (viewer.mutedUntil)
      throw new HttpError(403, "You are muted in this chat.");
    if (record.stopped)
      throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
    if (context.isBot && record.handoff) throw handedOffError(record.handoff);
    await assertBotAct(storage, context, record, "typing");
    await assertTeamReplyAdmitted(storage, context);
    context.typing?.mark(record.id, actor!, aliases, now);
    // A person writing a reply steps in: the AI keeps to drafts.
    await restrictForPerson(storage, context, record, "person-typing", {
      bump: true,
    });
    return new Response(null, { status: 204 });
  }
  if (sub === "claim" || sub === "release") {
    if (role !== "team")
      throw new HttpError(
        403,
        "Only the team can manage claims.",
        undefined,
        "team-only",
      );
    await assertBotAct(storage, context, record, "claim");
    const assignment = record.assignment ?? null;
    const mine = Boolean(assignment && actsAs(aliases, assignment.principalId));
    if (sub === "release") {
      if (assignment && !mine && !viewer.isManager)
        throw new HttpError(
          403,
          "Only the assignee or manager can release this claim.",
          undefined,
          "claim-owner-required",
        );
      if (!assignment) return json({ conversation: await view(record, role) });
    } else {
      if (!supportWorkflowAvailable)
        throw new HttpError(
          503,
          "Case claims are in testing.",
          undefined,
          "not-verified",
        );
      if (context.isBot && record.handoff) throw handedOffError(record.handoff);
      if (!supportEnabled)
        throw new HttpError(
          403,
          "Support is paused until the workspace's balance is topped up.",
          undefined,
          "support-paused",
        );
      if (
        context.body.takeover !== undefined &&
        typeof context.body.takeover !== "boolean"
      )
        throw new HttpError(400, "Choose whether to take over this claim.");
      if (context.body.takeover === true && !viewer.isManager)
        throw new HttpError(
          403,
          "Only the manager can take over a claim.",
          undefined,
          "manager-only",
        );
      if (mine) return json({ conversation: await view(record, role) });
      if (assignment && context.body.takeover !== true)
        throw new HttpError(
          409,
          "Another person on the team has claimed this case.",
          undefined,
          "claimed",
        );
    }
    // A person request waits for a reply; claiming clears other handoffs.
    const cleared =
      sub === "claim" &&
      !context.isBot &&
      clearsHandoff(record.handoff, "claim");
    let next: TeamConversationRecord = {
      ...record,
      assignment:
        sub === "release" ? null : { principalId: actor!, claimedAt: now },
      revision: record.revision + 1,
      ...(cleared ? { handoff: null } : {}),
    };
    if (sub === "claim")
      await recordTeamJoin(
        next,
        context,
        actor!,
        (await supportRecord(storage, record)).caseSeq ?? 0,
      );
    await save(storage, next);
    const support = await supportRecord(storage, next);
    await applyCaseEvent(storage, next, support, {
      kind: "assign",
      at: now,
      assigned: sub !== "release",
    });
    if (cleared)
      await applyCaseEvent(storage, next, support, {
        kind: "handoff-cleared",
        at: now,
        by: "assign",
      });
    // A person taking the request keeps the AI to drafts.
    if (sub === "claim")
      next = await restrictForPerson(storage, context, next, "person-claim", {
        bump: false,
        data: support,
      });
    context.pendingAudit.push({
      actor: actor!,
      action:
        sub === "release"
          ? "conversation.release"
          : assignment
            ? "conversation.takeover"
            : "conversation.claim",
      channelId: record.id,
      target: record.member,
    });
    await emit(context, next);
    return json({ conversation: await view(next, role) });
  }
  if (sub === "messages" && !messageId) {
    if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
    let shared: Awaited<ReturnType<typeof writeSupportContext>> | undefined;
    if (context.body.context !== undefined) {
      if (!supportWorkflowAvailable)
        throw new HttpError(503, "Support tools are being tested.");
      if (!workflowWritable)
        throw new HttpError(403, SUPPORT_REFUSAL, undefined, "support-paused");
      if (role !== "member" || context.body.contextConsent !== true)
        throw new HttpError(
          403,
          "Only the user can choose the context shared with the team.",
        );
      const prior = await previousMessage(
        storage,
        context,
        record,
        context.body,
      );
      if (!prior) {
        const support = await supportRecord(storage, record);
        shared = await writeSupportContext(
          support.context,
          context.body.context,
          context.headers,
          await featureOn(context.mediaEnv, storage, "supportDiagnostics"),
        );
        support.context = shared;
        await storage.put(`support-workflow-v1:${record.id}`, support);
      }
    }
    const posted = await postMessage(
      storage,
      context,
      authorized,
      context.body,
      shared ? sharedMessageDetails(context.body.context) : undefined,
    );
    if ("held" in posted) return heldReplyResponse(posted.held);
    if (shared) {
      if (shared.transactions?.length)
        await applyTransactionRule(storage, context, posted.record, true);
      await queueSharedMessageDiagnosis(storage, context, posted.record.id);
    }
    return json(
      {
        message: await messageView(posted.record, role, posted.message),
        conversation: await view(posted.record, role),
        ...(posted.draftLinked === undefined
          ? {}
          : { draftLinked: posted.draftLinked }),
      },
      201,
    );
  }
  if (sub === "messages" && messageId && messageAction) {
    const numeric = Number(messageId);
    if (role === "team" && record.stopped)
      throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
    // A request handed to a person waits for that person: the registered
    // bot can't change or react to what the member reads. Deleting its own
    // message only takes content away, so that stays open to it.
    if (
      role === "team" &&
      context.isBot &&
      record.handoff &&
      messageAction !== "delete"
    )
      throw handedOffError(record.handoff);
    if (role === "team")
      await assertBotAct(
        storage,
        context,
        record,
        messageAction === "reactions"
          ? "reaction"
          : messageAction === "edit"
            ? "edit"
            : "delete",
      );
    if (messageAction === "reactions") {
      const reacted = await reactRoute(storage, {
        channel: record.id,
        id: numeric,
        body: context.body,
        viewer,
        aliases,
        pending: context.pending,
        now,
      });
      return reacted;
    }
    if (messageAction === "edit") {
      if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
      assertReplyExtras(
        { provenance: context.body.provenance },
        role,
        Boolean(context.isBot),
      );
      // An AI agent's edit runs the same markers and check as its reply.
      const agentEdit = await agentEditCheck(
        storage,
        context,
        record,
        role,
        context.body,
        messageId,
      );
      // Finish secret screening before the synchronous edit callback.
      // Edits keep their current ownership check.
      // The room independently verifies key candidates with WebCrypto.
      await refusePhrase(context.body.text, "sent");
      const edit = await editMessage(storage, {
        channel: { id: record.id },
        id: numeric,
        viewer,
        aliases: [...aliases],
        held: context.headers.get("X-Message-Held") === "true",
        budgetAvailable:
          context.headers.get(MESSAGE_BUDGET_AVAILABLE_HEADER) !== "false",
        text: () => {
          const text = messageText(context.body.text);
          // The room awaited the secret screen before this callback.
          if (role === "team")
            refuseSecretRequest(text, {
              allowWalletInstructions: canManageWorkspace(viewer, context.isBot),
            });
          return agentEdit ? agentEdit.reply.text : text;
        },
        now,
      });
      if (edit.changed && agentEdit)
        await afterAgentEdit(
          storage,
          context,
          record,
          edit.message.id,
          agentEdit,
        );
      if (edit.changed) {
        context.pending.push({
          type: "message.edited",
          channelId: record.id,
          message: publicReactions(edit.message),
        });
        await context.searchIndex.upsert(record.id, edit.message);
      }
      return json({ message: await messageView(record, role, edit.message) });
    }
    if (messageAction === "delete") {
      const key = messageKey(record.id, numeric);
      const message = await storage.get<ChatMessage>(key);
      if (!message) throw new HttpError(404, "Message not found.");
      const byModerator = !actsAs(aliases, message.author);
      // Handling grants reading and replying, never deletion of another
      // person's message: that still needs the existing power.
      if (
        byModerator &&
        !viewer.isManager &&
        !viewer.permissions.includes("deleteMessages")
      )
        throw new HttpError(403, "You do not have permission to do that.");
      // An operator hold on this exact message keeps it, and its evidence,
      // unchanged until the hold is released.
      if (context.headers.get("X-Message-Held") === "true")
        throw new HttpError(
          403,
          "This message is under review and can't be deleted.",
          undefined,
          "message-held",
        );
      await recordDeleteEvidence(
        storage,
        record.id,
        numeric,
        message,
        actor!,
        now,
      );
      await recordPooledMessageDeletion(
        storage,
        record.id,
        key,
        (channelId, id) => context.searchIndex.remove(channelId, id),
      );
      await deleteMessageProvenance(storage, record.id, numeric);
      if (byModerator)
        context.pendingAudit.push({
          actor: actor!,
          action: "message.delete",
          channelId: record.id,
          messageId: message.id,
          target: message.author,
        });
      context.pending.push({
        type: "message.deleted",
        channelId: record.id,
        messageId: message.id,
      });
      return json({ ok: true });
    }
  }
  if (sub === "resolve") {
    if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
    if (role === "team" && context.isBot && record.handoff)
      throw handedOffError(record.handoff);
    if (role === "team") await assertBotAct(storage, context, record, "status");
    if (typeof context.body.resolved !== "boolean")
      throw new HttpError(400, "Choose whether to resolve this case.");
    const resolved = context.body.resolved;
    const ifRevision = context.body.ifRevision;
    if (
      ifRevision !== undefined &&
      (!Number.isSafeInteger(ifRevision) || (ifRevision as number) < 0)
    )
      throw new HttpError(400, "Include the case revision.");
    const timeSpent = parseTimeSpent(
      context.body.timeSpent,
      resolved && role === "team",
    );
    if (role === "team" && !resolved && record.stopped)
      throw new HttpError(409, STOPPED_ERROR, undefined, "stopped");
    if (
      (record.state === "resolved") === resolved &&
      !(
        resolved && (await supportRecord(storage, record)).state === "abandoned"
      )
    )
      return json({
        conversation: await view(record, role),
      });
    if (ifRevision !== undefined && ifRevision !== record.revision)
      throw new HttpError(
        409,
        "This case changed. Read it again.",
        undefined,
        "case-changed",
      );
    const state = await readState(storage);
    // The member's own reopen may be turned away; it is counted by cause.
    if (
      !resolved &&
      role === "member" &&
      (await countsRefusals(storage, context, record))
    )
      context.memberWrite = { clientId: null };
    if (!resolved)
      await reserveRoomOpen(
        storage,
        context,
        role === "member" ? "member" : "staff",
      );
    const next: TeamConversationRecord = {
      ...record,
      state: resolved ? "resolved" : "open",
      resolvedBy: resolved
        ? { principalId: actor!, kind: role, at: now }
        : null,
      revision: record.revision + 1,
      // A resolution ends any handoff.
      ...(resolved ? { handoff: null } : {}),
      // The team's resolution asks "Did this solve it?"; the member's own
      // resolution and every reopen ask nothing.
      confirmation: resolved && role === "team" ? askConfirmation(now) : null,
    };
    await save(storage, next);
    const support = await supportRecord(storage, next);
    const previous = support.state;
    support.state = resolved ? "resolved" : "open";
    if (resolved && !(await isStaffPreview(storage, context, next)) && record.member !== context.canary)
      await markWorkspaceStep(storage, "first_resolution", now);
    // A reopen alerts the team and starts the escalation wait.
    await applyCaseEventWithAlerts(storage, context, next, support, {
      kind: "status",
      at: now,
      previous,
      state: support.state,
      by: role === "member" ? "member" : context.isBot ? "bot" : "person",
      stopped: next.stopped,
      actor: actor!,
    });
    if (resolved) dropViewReads(context);
    if (timeSpent) {
      await recordTimeSpent(storage, next, support, timeSpent, actor!, now);
      await recordSupportActivity(storage, record.id, support, {
        actor: actor!,
        action: "time-spent",
        at: now,
        detail: timeSpent,
      });
    }
    await storage.put(`support-workflow-v1:${record.id}`, support);
    await storage.put(STATE_KEY, {
      ...state,
      open: Math.max(
        0,
        state.open + (resolved ? (record.state === "open" ? -1 : 0) : 1),
      ),
    });
    context.pendingAudit.push({
      actor: actor!,
      action: resolved ? "conversation.resolve" : "conversation.reopen",
      channelId: record.id,
      target: record.member,
    });
    await emit(context, next);
    return json({
      conversation: await view(next, role),
    });
  }
  if (sub === "stop") {
    if (!enabled) throw new HttpError(503, CONVERSATIONS_UNAVAILABLE_ERROR);
    if (role !== "member")
      throw new HttpError(403, "Only the user can change this preference.");
    if (typeof context.body.stopped !== "boolean")
      throw new HttpError(400, "Choose whether to stop team messages.");
    if (record.stopped === context.body.stopped)
      return json({
        conversation: await view(record, role),
      });
    const next: TeamConversationRecord = {
      ...record,
      stopped: context.body.stopped,
      stoppedAt: context.body.stopped ? now : null,
      revision: record.revision + 1,
    };
    await save(storage, next);
    // Taking back a stop starts a new wait when the request is unanswered.
    await applyCaseEventWithAlerts(
      storage,
      context,
      next,
      await supportRecord(storage, next),
      {
        kind: "stop",
        at: now,
        stopped: next.stopped,
      },
    );
    if (next.stopped) dropViewReads(context);
    context.pendingAudit.push({
      actor: actor!,
      action: context.body.stopped
        ? "conversation.stop"
        : "conversation.resume",
      channelId: record.id,
      target: record.member,
    });
    await emit(context, next);
    return json({
      conversation: await view(next, role),
    });
  }
  return null;
}
async function readPage(
  storage: Storage,
  channel: string,
  before: string | null,
  limit: number,
) {
  const entries = await storage.list<ChatMessage>({
    prefix: `channel-message:${channel}:`,
    reverse: true,
    limit: limit + 1,
    ...(before ? { end: messageKey(channel, Number(before)) } : {}),
  });
  const newest = [...entries.values()];
  const rows = newest.slice(0, limit).reverse();
  return {
    rows,
    nextBefore: newest.length > limit ? (rows[0]?.id ?? null) : null,
  };
}
export type { ChatEvent };

/* Worker side                                                             */

export type ConversationEnv = {
  ROOMS: DurableObjectNamespace;
  /** "true" opens creation and write routes; reads stay authorized either way. */
  CONVERSATIONS_ENABLED?: string;
  SUPPORT_WORKFLOW_ENABLED?: string;
};
export function conversationsEnabled(env: ConversationEnv) {
  return env.CONVERSATIONS_ENABLED === "true";
}
const internal = (path: string, body: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
/** The shared object that keeps an account's rolling open quota across
 * every room: one of 16 long-lived shards chosen by the first hex digit of
 * the principal's SHA-256, with keys named by the principal. A new asker
 * never pays for a new object. */
export async function accountQuotaObject(
  env: ConversationEnv,
  principalId: string,
) {
  const id = normalizeChatPrincipal(principalId);
  if (!id) throw new HttpError(400, "Invalid user ID.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
  );
  const shard = (digest[0] >> 4).toString(16);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(`account-quota:v2:${shard}`));
  return {
    principal: id,
    call: (body: Record<string, unknown>) =>
      timed(
        env,
        body.op === "release" ? "settle" : "quota",
        stub.fetch(
          internal("/private/account-quota", { ...body, principal: id }),
        ),
      ),
  };
}
/** Reserve account seats before possible opens. The room still checks ACLs
 * and can answer an already-open thread or message retry at the quota limit.
 * Its committed transition selects which reservation, if any, was spent. */
export async function conversationWorkerRoute(
  env: ConversationEnv,
  room: DurableObjectStub,
  headers: Headers,
  input: {
    path: string;
    search?: string;
    method: string;
    body?: Record<string, unknown>;
    session: { principalId: string } | null;
  },
): Promise<Response | null> {
  headers.delete("X-Support-Priority-Phase");
  const priorityOpen = await priorityWorkerOpen(
    env as ConversationEnv & DiagnosisEnv & KnowledgeEnv,
    room,
    headers,
    input,
  );
  if (priorityOpen) return priorityOpen;
  if (/^\/conversations\/(?:priorities|priority-settings)$/.test(input.path)) {
    headers.set(CONVERSATIONS_HEADER, String(conversationsEnabled(env)));
    headers.set(
      SUPPORT_WORKFLOW_HEADER,
      String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
    );
    return null;
  }
  // Transaction checks run at the edge, which reads the chain between two
  // room calls: this sets the enabled networks on every call and runs the
  // diagnosis path.
  {
    const diagnosis = await diagnosisWorkerRoute(
      env as ConversationEnv & DiagnosisEnv,
      room,
      headers,
      input,
    );
    if (diagnosis) return diagnosis;
  }
  // Follow-ups, routing settings and position reads: the room reads the same two gate
  // headers it reads for the conversation routes. The request then goes to
  // the room unchanged.
  if (
    FOLLOW_UP_EDGE_PATH.test(input.path) ||
    TELEGRAM_AI_PATH.test(input.path) ||
    /^\/conversations\/(?:encryption(?:\/(?:prepare|settle-ai))?|tc-[a-f0-9]{32}\/encryption\/[1-9][0-9]{0,7}(?:\/(?:enroll|directory|history|outcome|fence|revoke|control|contact|ai-context|ai-handoff))?)$/.test(input.path)
  ) {
    headers.set(CONVERSATIONS_HEADER, String(conversationsEnabled(env)));
    headers.set(
      SUPPORT_WORKFLOW_HEADER,
      String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
    );
    return null;
  }
  // Redaction, archive, outcome and import routes reach
  // the room with the two gate headers and reserve no message.
  // The room checks the role and thread.
  if (
    /^\/conversations\/(?:tc-[0-9a-f]{32}\/(?:messages\/[1-9][0-9]{0,14}\/redact|archive|outcome)|(?:knowledge|saved-replies)\/import)$/.test(
      input.path,
    )
  ) {
    headers.set(CONVERSATIONS_HEADER, String(conversationsEnabled(env)));
    headers.set(
      SUPPORT_WORKFLOW_HEADER,
      String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
    );
    return null;
  }
  const match = CONVERSATION_ROUTE.exec(input.path);
  if (!match) return null;
  // A recovery phrase is refused here, before pacing, open reservations and
  // the room: nothing is reserved, stored or counted for it.
  await screenConversationWrite(input.path, input.method, input.body ?? {});
  const enabled = conversationsEnabled(env);
  headers.set(CONVERSATIONS_HEADER, String(enabled));
  headers.set(
    SUPPORT_WORKFLOW_HEADER,
    String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
  );
  const body = input.body ?? {};
  let committedOpen: OpenKind | null = null;
  const send = async () => {
    const response = await timed(
      env,
      "room",
      room.fetch(
        new Request(`https://internal${input.path}${input.search ?? ""}`, {
          method: input.method,
          headers,
          ...(input.method === "POST" ? { body: JSON.stringify(body) } : {}),
        }),
      ),
    );
    // Message accounting can replace this response with 503 after the
    // room commits. Capture its opening before that response is replaced.
    const used = response.headers.get(OPEN_USED_HEADER);
    if (response.ok && (used === "member" || used === "staff"))
      committedOpen = used;
    return response;
  };
  const forward = () =>
    withMessageBudget(
      env as Env,
      {
        scope: headers.get("X-Native-Room-Id") ?? String(room.id),
        path: input.path,
        method: input.method,
        body,
        principal: input.session?.principalId ?? null,
        aliases: JSON.parse(headers.get("X-Service-Principals") ?? "[]"),
      },
      (available) => {
        if (available !== undefined)
          headers.set(MESSAGE_BUDGET_AVAILABLE_HEADER, String(available));
        return send();
      },
    );
  // Never accept quota decisions from client-supplied headers.
  headers.set(MEMBER_OPEN_AVAILABLE_HEADER, "false");
  headers.set(STAFF_OPEN_AVAILABLE_HEADER, "false");
  headers.delete(MEMBER_OPEN_USED_HEADER);
  headers.delete(STAFF_OPEN_USED_HEADER);
  const [, action, , sub, messageId] = match;
  const kinds: OpenKind[] =
    action === "ask"
      ? ["member"]
      : action === "start"
        ? ["staff"]
        : sub === "messages" && !messageId
          ? ["member"]
          : sub === "resolve" && body.resolved === false
            ? ["member", "staff"]
            : // "No" to "Did this solve it?" may reopen the request.
              sub === "workflow" &&
                body.action === "confirm" &&
                body.solved === false
              ? ["member"]
              : [];
  if (input.method !== "POST" || !input.session || !enabled || !kinds.length)
    return forward();
  const account = await accountQuotaObject(env, input.session.principalId);
  const budget = {
    scope: headers.get("X-Native-Room-Id") ?? String(room.id),
    path: input.path,
    method: input.method,
    body,
    principal: input.session.principalId,
    aliases: JSON.parse(headers.get("X-Service-Principals") ?? "[]"),
  };
  // Client opIds cannot buy additional opens or release a prior accepted open.
  // Concurrent retries reserve independently; the room commits at most one
  // transition and releases the others after observing the current state.
  const reservations = kinds.map((kind) => ({
    kind,
    opId: crypto.randomUUID(),
    key: `conversation-opens-${kind}`,
    limit:
      kind === "member"
        ? PRODUCT_LIMITS.memberSupportOpensPerAccountPerDay
        : PRODUCT_LIMITS.staffSupportOpensPerAccountPerDay,
  }));
  // The account's open seats and its message pace are reserved together,
  // after authorization and before the room write, with the same keys and
  // limits as one after the other.
  const [quotas, pacing] = await Promise.all([
    Promise.allSettled(
      reservations.map((reservation) =>
        account.call({ op: "reserve", ...reservation }),
      ),
    ),
    Promise.allSettled([reservePacing(env as Env, budget)]).then(
      ([result]) => result,
    ),
  ]);
  const held = reservations.filter(
    (_, index) =>
      quotas[index].status === "fulfilled" &&
      (quotas[index] as PromiseFulfilledResult<Response>).value.ok,
  );
  const releaseSeats = (seats: typeof reservations) =>
    Promise.all(
      seats.map((reservation) =>
        account.call({ op: "release", ...reservation }),
      ),
    );
  // A refusal other than the account's own limit ends the request with no
  // room request sent: every seat and the pace reserved beside it go back.
  const quotaFailure = quotas.find(
    (result) =>
      result.status === "rejected" ||
      (!result.value.ok && result.value.status !== 429),
  );
  const pacingReserved = pacing.status === "fulfilled" && pacing.value.reserved;
  const pacingFailure =
    pacing.status === "rejected"
      ? pacing.reason
      : (pacing.value.failure ?? null);
  if (quotaFailure || pacingFailure) {
    await Promise.all([
      releaseSeats(held),
      pacingReserved ? releasePacing(pacing.value) : null,
    ]);
    if (quotaFailure) {
      if (quotaFailure.status === "rejected") throw quotaFailure.reason;
      return quotaFailure.value;
    }
    if (pacingFailure instanceof Response) return pacingFailure;
    throw pacingFailure;
  }
  for (const [index, reservation] of reservations.entries()) {
    const result = (quotas[index] as PromiseFulfilledResult<Response>).value;
    if (result.ok) {
      const quota = (await result.json()) as { used?: unknown };
      headers.set(
        reservation.kind === "member"
          ? MEMBER_OPEN_AVAILABLE_HEADER
          : STAFF_OPEN_AVAILABLE_HEADER,
        "true",
      );
      headers.set(
        reservation.kind === "member"
          ? MEMBER_OPEN_USED_HEADER
          : STAFF_OPEN_USED_HEADER,
        String(quota.used),
      );
    }
    // The status already decided admission. Disposing an unused body must
    // not replace that decision with a transport cleanup error.
    else await result.body?.cancel().catch(() => {});
  }
  const pace = (pacing as PromiseFulfilledResult<PacingReservation>).value;
  if (pace.applies && pace.reserved !== undefined)
    headers.set(MESSAGE_BUDGET_AVAILABLE_HEADER, String(pace.reserved));
  // A lost room response has an unknown outcome. Keep its reservation rather
  // than allowing extra opens after a write that may have committed.
  const response = await settlePacing(pace, await send());
  // Unused seats go back after the response; a failed release keeps the
  // seat, which only ever makes the limit stricter.
  const unused = held.filter(
    (reservation) => committedOpen !== reservation.kind,
  );
  if (unused.length) defer(env, () => releaseSeats(unused));
  const clean = new Response(response.body, response);
  clean.headers.delete(OPEN_USED_HEADER);
  return clean;
}
