import { appAiEnabled, enqueueAppAnswer, appAnswerStatus, assertAppAnswerWrite, finishAppAnswer } from "./app-ai-replies";
import { featureOn } from "./workspace-flags";
import { SUPPORT_DIAGNOSTIC_FIELDS } from "@templ/chat/support-app-context";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { captureHandoffLearning } from "./support-handoff-learning";
import { threadIdentityLabel } from "@templ/chat/support-identity-label";
import { rememberPrioritySession } from "./support-priority";
// Measure human composing time.
// Presence records count time and never message text.
import { recordComposeTime } from "./support-journey-ops";
import { recordTeamJoin } from "./support-team-presence";
import { threadIdentity } from "@templ/chat/support-identity";
import { currentCaseChecks, readThreadDiagnoses } from "./support-diagnosis";
import { threadFollowUps } from "./support-follow-ups";
import { reserveSupportMessage } from "./support-retention";
import { setOpenIndex } from "./support-open-index";
import { readOwnAiControl, checkpointOwnAiControl } from "./support-own-ai-control";
import {
  AUTH_METHOD_HEADER,
  requireWorkspaceAdminHeaders,
} from "./privileged-auth";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { markSharedMessageDetails } from "./support-message-details";
import {
  assertMessageBudgetAvailable,
  MESSAGE_BUDGET_AVAILABLE_HEADER,
} from "./message-budget";
import {
  readProductSupport,
  staffRefusal,
  SUPPORT_REFUSAL,
} from "./product-entitlements";
import { memberSolve } from "./product-case-view";
import { managedPrincipal } from "./managed-agent/principal";
import { templAiPrincipal } from "./templ-ai-principal";
import { standardMonthlySyntheticProducer } from "./standard-monthly-trial-access";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { TeamConversation } from "@templ/chat/index";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import {
  SUPPORT_ACCESS_LEVELS,
  SUPPORT_LIMITS,
  SUPPORT_TIME_SPENT,
  type SupportAccessLevel,
  type SupportActivity,
  type SupportAiMode,
  type SupportAttachment,
  type SupportContext,
  type SupportContextLegacy,
  type SupportNote,
  type SupportPresence,
  type SupportReportWindow,
  type SupportSavedReply,
  type SupportSettings,
  type SupportState,
  type SupportSummary,
  type SupportTimeSpent,
  type SupportWorkflow,
} from "@templ/chat/support";
import {
  parseCaip10,
  readStoredWidgetWallet,
  isLoopbackOrigin,
  type WidgetWallet,
} from "@templ/chat/widget-wallet";
import { isSolanaAddress } from "@templ/chat/solana";
import {
  appContextTexts,
  mergeSupportContext,
  parseSupportContextInput,
  readStoredSupportContext,
  SupportContextError,
  type ParsedSupportContext,
  type StoredSupportContext,
} from "@templ/chat/support-context";
import { HttpError, json, readBytes } from "./common";
import { normalizePng } from "./image-normalize";
import { assertMemberScreenshotRoom } from "./support-member-screenshots";
import {
  SUPPORT_MEDIA_COMMIT_BYTES_HEADER,
  SUPPORT_MEDIA_COMMIT_ID_HEADER,
  mediaHash,
  readSupportAttachment,
  stageSupportAttachment,
  type SupportMediaReference,
} from "./media";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { actsAs } from "./service-principals";
import { refusePhrase, refuseSecretRequest } from "./secret-guard";
import {
  applyCaseEvent,
  supportCaseReport,
  synthesizeThreadLedger,
  type CaseEvent,
} from "./support-cases";
import {
  askPersonError,
  askPersonHandoff,
  assertAiAnswersAllowed,
  assertLatest,
  clearsHandoff,
  handedOffError,
  handoffView,
  parseAskPersonBody,
  parseHandoffBody,
  type StoredHandoff,
} from "./support-handoff";
import {
  queueNotificationJob,
  readNotificationStatus,
  type SupportNotificationFacts,
} from "./support-notifications";
import { SUPPORT_ALERT_LIMITS } from "@templ/chat/support-alerts";
import {
  applyCaseEventWithAlerts,
  emitCaseAlerts,
  emitReplyAlerts,
} from "./support-alert-emit";
import { readSupportRefusals, refusalWindowDays } from "./support-refusals";
import type { AgentState } from "./support-agent-presence";
import { lastSpeaker, supportTurn } from "./support-turn";
import {
  aiView,
  botRefusal,
  chosen,
  effectiveAiMode,
  parseAiDefault,
  parseAiModeBody,
  personOnlyError,
  readAiDefault,
  restricted,
  type AiRestrictionCause,
  type BotAct,
  type EffectiveAiMode,
  type StoredAiControl,
} from "./support-ai-mode";
import { caseWorkflowAction } from "./support-case-routes";
import { followUpWorkflowHook } from "./support-follow-up-routes";
import { currentGuestFollowUp } from "./guest-follow-up";
import { widgetMemberThreadRoute } from "./support-widget-member";
import {
  clearEarlierFollowUpLine,
  type FollowUpRecord,
} from "./support-follow-ups";
import {
  cancelPendingForAiOff,
  parseCaseSettings,
  type CaseActivityAction,
  type DraftFields,
} from "./support-drafts";
import type {
  SupportCaseSettings,
  SupportSummaryCases,
} from "@templ/chat/support-drafts";
import { queueStaffPush } from "./staff-push";
import { staffPushHold } from "./staff-push-hold";
import { personRequest } from "@templ/chat/person-intent";
import { readSupportProfiles } from "./support-contact-profiles";
import { CRYPTO_SUPPORT_WORKSPACE } from "./crypto-support";

type Storage = DurableObjectTransaction;
const SETTINGS = "support-settings-v1";
const REPLIES = "support-saved-reply-v1:";
const SUPPORT_ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const savedReplies = async (storage: Storage) => [
  ...(
    await storage.list<SupportSavedReply>({
      prefix: REPLIES,
      limit: SUPPORT_LIMITS.savedReplies,
    })
  ).values(),
];
const key = (id: string) => `support-workflow-v1:${id}`;
const DEFAULT_SETTINGS: SupportSettings = {
  timezone: "UTC",
  businessHours: "",
  acknowledgment: "",
  categories: [
    "Access issue",
    "Transaction question",
    "Bug",
    "Account problem",
  ],
  testAccounts: [],
};
export type SupportRecord = {
  lead?: import("@templ/chat/support-lead").SupportLead;
  /** Binds the most recent lead submission to its message retry. */
  leadSubmission?: { clientId: string; input: string };
  /** Own encrypted contact retries are separate from message delivery. */
  ownContactSubmission?: {clientId: string; input: string; revision: number};
  state: SupportState;
  tags: string[];
  category: string | null;
  lastMemberMessageAt: number | null;
  lastStaffReplyAt: number | null;
  firstResponseMs: number | null;
  firstRequestedAt?: number;
  requestedAt: number | null;
  reopened: number;
  /** When the thread last went from resolved back to open. Absent on
   * records written before it, and on threads never reopened. */
  reopenedAt?: number;
  /** Read through `readContext`, which maps the free-text shape written
   * before structured context and never writes back. */
  context: StoredSupportContext | SupportContextLegacy | null;
  /** Stored as `{network, address, chainId?, authenticatedAt, origin}`;
   * records written before Solana sign-in have no network and read as EVM
   * through `supportRecord`. */
  wallet?: SupportWorkflow["wallet"];
  /** Set when the thread was opened from the hosted support page. */
  entry?: "hosted";
  /** Level of the member's latest widget request, recorded from the first
   * one; a claimed wallet is never proof. Absent on a thread written only
   * from the Templ app. */
  access?: {
    level: SupportAccessLevel;
    walletUnavailable?: true;
    claimedWallet?: WidgetWallet;
    at: number;
  };
  /** The Solana wallet of the app session the member last wrote from, when
   * that session signed in with Solana. Shown to the team only. */
  appWallet?: { network: "solana"; address: string; authenticatedAt: number };
  /** When staff asked a widget member to prove their wallet; null once done. */
  verificationRequestedAt?: number | null;
  notes: SupportNote[];
  noteCount?: number;
  activity: SupportActivity[];
  presence: SupportPresence[];
  attachments: SupportAttachment[];
  attachmentMedia: Record<string, SupportMediaReference>;
  /** Case ledger. Absent on records written before the ledger (not yet
   * migrated); `applyCaseEvent` fills them on the thread's next change. */
  ledgerVersion?: 1;
  /** Latest case; 0 when the thread never had a member request. */
  caseSeq?: number;
  /** Mirrors the latest case's wait; the awaiting index key uses it. */
  awaitingSince?: number | null;
  notSolved?: boolean;
  /** The registered AI agent's latest reply and latest internal note: times
   * only, for who acts next. */
  lastAgentReplyAt?: number | null;
  lastAgentNoteAt?: number | null;
  /** Handling time a person chose at the latest resolve. Team only. */
  timeSpent?: { bucket: SupportTimeSpent; at: number; by: ChatPrincipalId };
  /** Ask AI state of the current case. Team only. */
  aiDrafts?: DraftFields["aiDrafts"];
  /** Held AI agent replies not yet used or dismissed. Team only. */
  draftsHeld?: number;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The wallets a stored support record names, in the shape this release
 * writes. A wallet stored before Solana sign-in has no network and reads as
 * EVM. One that fits no shape is left out, so an unreadable record never
 * shows a wallet as proven or claimed; a fixed label is logged, with no
 * address. The record's next write stores what was read. */
function readRecordWallets(data: SupportRecord, conversation: string) {
  let unreadable = false;
  if (data.wallet !== undefined) {
    const stored: unknown = data.wallet;
    const wallet = readStoredWidgetWallet(stored);
    if (
      wallet &&
      isRecord(stored) &&
      typeof stored.authenticatedAt === "string" &&
      !Number.isNaN(Date.parse(stored.authenticatedAt)) &&
      typeof stored.origin === "string" &&
      (stored.origin.startsWith("https://") || isLoopbackOrigin(stored.origin))
    )
      data.wallet = {
        ...wallet,
        authenticatedAt: stored.authenticatedAt,
        origin: stored.origin,
      };
    else {
      delete data.wallet;
      unreadable = true;
    }
  }
  if (data.access?.claimedWallet !== undefined) {
    const { claimedWallet: stored, ...access } = data.access;
    const claimed = readStoredWidgetWallet(stored);
    data.access = claimed ? { ...access, claimedWallet: claimed } : access;
    if (!claimed) unreadable = true;
  }
  if (data.appWallet !== undefined) {
    const stored: unknown = data.appWallet;
    if (
      !isRecord(stored) ||
      stored.network !== "solana" ||
      !isSolanaAddress(stored.address) ||
      !Number.isSafeInteger(stored.authenticatedAt)
    ) {
      delete data.appWallet;
      unreadable = true;
    }
  }
  if (unreadable)
    console.warn(
      JSON.stringify({
        event: "TEMPL_SUPPORT_WALLET_UNREADABLE",
        conversation,
      }),
    );
  return data;
}
export async function supportRecord(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
): Promise<SupportRecord> {
  const stored = await storage.get<SupportRecord>(key(record.id));
  if (stored) return readRecordWallets(stored, record.id);
  return {
    state: record.state,
    tags: [],
    category: null,
    lastMemberMessageAt: null,
    lastStaffReplyAt: null,
    firstResponseMs: null,
    requestedAt: null,
    reopened: 0,
    context: null,
    notes: [],
    activity: [],
    presence: [],
    attachments: [],
    attachmentMedia: {},
  };
}
export const SUPPORT_MEDIA_BYTES_KEY = "support-media-bytes-v1";

/** Internal reconciliation answer for the media-budget alarm. The caller has
 * already selected this room through its private Durable Object binding. */
export async function supportMediaReferenced(
  storage: Pick<Storage, "get">,
  input: {
    room: string;
    conversation: string;
    attachment: string;
    objectId: string;
    contentHash: string;
    bytes: number;
  },
) {
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${input.conversation}`,
  );
  if (
    !record ||
    record.deleting ||
    record.id !== input.conversation ||
    record.room !== input.room
  )
    return false;
  const data = await supportRecord(storage, record);
  const attachment = data.attachments.find(
    (item) => item.id === input.attachment,
  );
  const media = data.attachmentMedia[input.attachment];
  return Boolean(
    attachment &&
    attachment.bytes === input.bytes &&
    media?.objectId === input.objectId &&
    media.contentHash === input.contentHash,
  );
}
export async function supportSettings(
  storage: Pick<Storage, "get">,
): Promise<SupportSettings> {
  const stored = await storage.get<SupportSettings & { fallbackUrl?: unknown }>(
    SETTINGS,
  );
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  // Stored contact data grants no access and is excluded from settings.
  const { fallbackUrl: _contact, ...settings } = stored;
  return settings;
}
/** Why a thread's member request is the team's own test rather than a real
 * one: the member is a listed test account, current support staff trying
 * their own widget, or a manager's checked install preview. Usage and the
 * report leave them out, within the caps billing applies. */
export async function staffPreviewReason(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "isSupportStaff"> &
    Partial<Pick<ConversationContext, "headers">>,
  member: ChatPrincipalId,
): Promise<"test-account" | "staff-preview" | "install-preview" | null> {
  if (context.headers?.get("X-Support-Install-Preview") === "1")
    return "install-preview";
  const settings = await supportSettings(storage);
  if (settings.testAccounts.includes(member)) return "test-account";
  if (await context.isSupportStaff?.(member)) return "staff-preview";
  return null;
}
/** What a team summary adds: when the current wait started, whether a
 * handoff is open, who acts next and who wrote last. Members never get
 * these keys. */
export type TeamSummaryInput = {
  record: TeamConversationRecord;
  aiDefault: SupportAiMode;
  assistantPaused?: boolean;
  agent: AgentState;
  now: number;
  /** Listed test accounts: their requests carry the test flag. */
  testAccounts: readonly ChatPrincipalId[];
  /** Templ's hourly check in this workspace, when one is configured. */
  canary: ChatPrincipalId | null;
};
/** What every team summary in one request reads: settings and the agent's
 * state, once. */
export async function teamSummaryInput(
  storage: Pick<Storage, "get">,
  context: ConversationContext,
): Promise<Omit<TeamSummaryInput, "record">> {
  const [settings, profiles] = await Promise.all([
    supportSettings(storage), readSupportProfiles(storage),
  ]);
  const assistantPaused = profiles?.assistantEnabled === false;
  return {
    aiDefault: readAiDefault(settings),
    assistantPaused,
    agent: assistantPaused
      ? { registered: false, active: false, seenAt: null }
      : await agentState(context),
    now: context.now,
    testAccounts: settings.testAccounts,
    canary: context.canary ?? null,
  };
}
/** The test flag of a thread's member: Templ's hourly check or a listed
 * test account. Team views only. */
export function memberTestFlag(
  member: ChatPrincipalId,
  input: Pick<TeamSummaryInput, "testAccounts" | "canary">,
): "canary" | "account" | null {
  if (input.canary && member === input.canary) return "canary";
  return input.testAccounts.includes(member) ? "account" : null;
}
/** When the request has waited for a reply since, or null. A thread the
 * ledger has not reached yet is read from the older fields, which may count
 * an AI-answered thread as waiting but never hide a waiting one. */
export function waitingSince(data: SupportRecord): number | null {
  if (data.ledgerVersion === 1)
    return Number.isSafeInteger(data.awaitingSince)
      ? (data.awaitingSince as number)
      : null;
  return data.state === "open" &&
    data.lastMemberMessageAt !== null &&
    data.lastMemberMessageAt > (data.lastStaffReplyAt ?? 0)
    ? data.lastMemberMessageAt
    : null;
}
export function supportSummary(
  record: SupportRecord,
  seenAt = 0,
  team: TeamSummaryInput | null = null,
): SupportSummary {
  const since = team ? waitingSince(record) : null;
  return {
    state: record.state,
    ...(team?.record.archivedAt !== undefined
      ? { archivedAt: iso(team.record.archivedAt) }
      : {}),
    tags: record.tags,
    category: record.category,
    lastMemberMessageAt: record.lastMemberMessageAt
      ? new Date(record.lastMemberMessageAt).toISOString()
      : null,
    lastStaffReplyAt: record.lastStaffReplyAt
      ? new Date(record.lastStaffReplyAt).toISOString()
      : null,
    unread: (record.lastMemberMessageAt ?? 0) > seenAt,
    identity: threadIdentity(record),
    identityLabel: threadIdentityLabel(record),
    ...(record.access?.walletUnavailable
      ? { walletUnavailable: true as const }
      : {}),
    reopened: record.reopened,
    ...(record.access
      ? { access: record.access.level }
      : record.wallet
        ? { access: "signed" as const }
        : {}),
    ...(since !== null ? { waitingSince: iso(since) } : {}),
    ...(team?.record.handoff ? { handedOff: true as const } : {}),
    ...(team && memberTestFlag(team.record.member, team)
      ? { test: memberTestFlag(team.record.member, team)! }
      : {}),
    ...(team ? teamTurn(record, team, since) : {}),
    ...(team ? caseSummary(record) : {}),
  };
}
/** Team views only: the current case number and held AI replies, from the
 * support record alone (no extra read). */
function caseSummary(record: SupportRecord): SupportSummaryCases {
  return {
    ...(record.ledgerVersion === 1 && (record.caseSeq ?? 0) > 0
      ? { caseSeq: record.caseSeq }
      : {}),
    ...((record.draftsHeld ?? 0) > 0 ? { draftsHeld: record.draftsHeld } : {}),
  };
}
/** Who acts next on the request, and who wrote last. Worked out when read;
 * it grants and blocks nothing. */
function teamTurn(
  data: SupportRecord,
  team: TeamSummaryInput,
  since: number | null,
): Pick<SupportSummary, "turn" | "turnReason" | "lastBy" | "lastAt"> {
  const turn = supportTurn({
    state: data.state,
    awaitingSince: since,
    handoffReason: team.record.handoff?.reason ?? null,
    notSolved: data.notSolved === true,
    aiMode: team.assistantPaused ? "off" : effectiveAiMode(team.record.ai, data, team.aiDefault).mode,
    agentDraftAt: data.lastAgentNoteAt ?? null,
    agent: team.agent,
    now: team.now,
  });
  const last = lastSpeaker(data, team.record.lastMessageAt);
  return {
    ...(turn
      ? { turn: turn.turn, ...(turn.reason ? { turnReason: turn.reason } : {}) }
      : {}),
    ...(last ? { lastBy: last.by, lastAt: iso(last.at) } : {}),
  };
}
export async function readSupportSummary(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
  actor: ChatPrincipalId,
  team: Omit<TeamSummaryInput, "record"> | null = null,
) {
  const [data, seen] = await Promise.all([
    supportRecord(storage, record),
    storage.get<number>(`support-seen-v1:${record.id}:${actor}`),
  ]);
  return supportSummary(data, seen ?? 0, team ? { ...team, record } : null);
}
/** The case facts behind an open request's next step: shared
 * transactions, the newest check of each and a due follow-up. Lists read
 * them only for the rows they return. */
export async function supportJourney(
  storage: Storage,
  record: TeamConversationRecord,
  now: number,
): Promise<NonNullable<SupportSummary["journey"]>> {
  const data = await supportRecord(storage, record);
  const context = readStoredSupportContext(data.context);
  const transactions =
    context && context !== "unreadable" ? (context.transactions ?? []) : [];
  const [reads, followUps] = await Promise.all([
    readThreadDiagnoses(storage, record.id as `tc-${string}`),
    threadFollowUps(storage, record.id, data.caseSeq),
  ]);
  const latestBySubject = new Map(
    currentCaseChecks(reads, data.caseSeq).map((row) => [
      row.diagnosis.subject,
      row,
    ]),
  );
  const sharedChecks = transactions
    .map((transaction) => latestBySubject.get(transaction.hash)?.diagnosis)
    .filter((row) => row !== undefined);
  const waiting = sharedChecks.find(
    (row) => row.status === "pending" || row.status === "disagree",
  );
  return {
    sharedTransaction: transactions.length > 0,
    uncheckedTransaction: transactions.some(
      (transaction) => !latestBySubject.has(transaction.hash),
    ),
    ...((waiting ?? sharedChecks[0])
      ? { diagnosisStatus: (waiting ?? sharedChecks[0]).status }
      : {}),
    followUpDue: followUps.list.some(
      (followUp) =>
        !followUp.closedAt && followUp.dueAt !== null && followUp.dueAt <= now,
    ),
  };
}
function text(value: unknown, limit: number, blank = false): string {
  if (
    typeof value !== "string" ||
    (!blank && !value.trim()) ||
    new TextEncoder().encode(value).length > limit ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new HttpError(400, "Use plain text within the stated limit.");
  return value.trim();
}
function strings(value: unknown, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count)
    throw new HttpError(400, "Too many entries.");
  return [...new Set(value.map((entry) => text(entry, length)))];
}
const iso = (now: number) => new Date(now).toISOString();
async function activity(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: SupportRecord,
  action: SupportActivity["action"],
  detail?: string,
) {
  await recordSupportActivity(storage, record.id, data, {
    actor: context.viewer.principalId!,
    action,
    at: context.now,
    detail,
  });
}
/** Appends one activity entry and saves the thread's support record. */
export async function recordSupportActivity(
  storage: Storage,
  conversation: string,
  data: SupportRecord,
  input: {
    actor: ChatPrincipalId;
    action: CaseActivityAction;
    at: number;
    detail?: string;
  },
) {
  const entry: SupportActivity = {
    id: crypto.randomUUID(),
    actor: input.actor,
    // Case activity codes ride in the same list; readers show a code they
    // don't know as a plain entry.
    action: input.action as SupportActivity["action"],
    at: iso(input.at),
    ...(input.detail ? { detail: input.detail } : {}),
  };
  const sequenceKey = `support-activity-sequence-v1:${conversation}`;
  let previousSequence = await storage.get<number>(sequenceKey);
  if (previousSequence === undefined) {
    const previous = await storage.list({
      prefix: `support-activity-v1:${conversation}:`,
      reverse: true,
      limit: 1,
    });
    previousSequence = Number([...previous.keys()][0]?.split(":")[2] ?? 0);
  }
  const sequence = previousSequence + 1;
  await storage.put(sequenceKey, sequence);
  await storage.put(
    `support-activity-v1:${conversation}:${String(sequence).padStart(16, "0")}:${entry.id}`,
    entry,
  );
  await storage.put(key(conversation), data);
}
/** What the team and the member read. A stored value that fails its checks
 * shows no context and logs a fixed label with no content. */
function readContext(
  value: unknown,
  conversation: string,
): SupportContext | null {
  const view = readStoredSupportContext(value);
  if (view !== "unreadable") return view;
  console.warn(
    JSON.stringify({ event: "TEMPL_SUPPORT_CONTEXT_UNREADABLE", conversation }),
  );
  return null;
}
/** The wallet this request's session proved, from headers the worker
 * rebuilds on every request: a widget session's signed wallet, or the Templ
 * app session's EVM or Solana sign-in. Null for guests and claimed wallets. */
function provenWallet(
  headers: Headers,
): { network: "evm" | "solana"; address: string } | null {
  if (headers.get("X-Support-Widget") === "member") {
    if (headers.get("X-Support-Access-Level") !== "signed") return null;
    const wallet = parseCaip10(headers.get("X-Support-Wallet"));
    return wallet ? { network: wallet.network, address: wallet.address } : null;
  }
  if (!headers.get("X-Verified-Principal")) return null;
  const method = headers.get(AUTH_METHOD_HEADER);
  const solana = headers.get("X-Verified-Solana-Wallet");
  if (method === "solana" && isSolanaAddress(solana))
    return { network: "solana", address: solana };
  const evm = headers.get("X-Verified-Wallet");
  if (method === "wallet" && evm && /^0x[0-9a-fA-F]{40}$/.test(evm))
    return { network: "evm", address: evm };
  return null;
}
/** A snapshot's wallet level is set here, never taken from the client: it
 * reads "verified" only when its address is the wallet this session proved.
 * A snapshot the thread already holds keeps the level it was stored with. */
function bindSnapshotWallets(
  parsed: ParsedSupportContext,
  previous: SupportContext | null,
  headers: Headers,
): ParsedSupportContext {
  if (!parsed.snapshots?.length) return parsed;
  const proven = provenWallet(headers);
  const snapshots = parsed.snapshots.map((snapshot) => {
    const held = previous?.snapshots?.find((row) => row.id === snapshot.id);
    const address = snapshot.wallet.address;
    const matches =
      proven !== null &&
      address !== undefined &&
      (proven.network === "solana"
        ? address === proven.address
        : address.toLowerCase() === proven.address.toLowerCase());
    const level = held
      ? held.wallet.level
      : matches
        ? "verified"
        : address !== undefined
          ? "attached"
          : "guest";
    return { ...snapshot, wallet: { ...snapshot.wallet, level } };
  });
  return { ...parsed, snapshots };
}
/** A member's shared context, checked and merged with what the thread
 * holds: description and network replace, transactions accumulate (newest
 * five). A value the thread holds that no longer reads is replaced. Fields
 * the service doesn't read are ignored. Snapshot wallet levels are bound to
 * the session named by `headers`. Throws 400 with the context reason. */
export async function writeSupportContext(
  previousStored: unknown,
  input: unknown,
  headers: Headers,
  diagnosticsAllowed = false,
): Promise<StoredSupportContext> {
  let parsed: ParsedSupportContext;
  try {
    parsed = parseSupportContextInput(input);
  } catch (error) {
    if (error instanceof SupportContextError)
      throw new HttpError(400, error.message, undefined, error.reason);
    throw error;
  }
  if (
    !diagnosticsAllowed &&
    [parsed.app, ...(parsed.snapshots ?? []).map((snapshot) => snapshot.app)].some(
      (app) => app && SUPPORT_DIAGNOSTIC_FIELDS.some((field) => app[field] !== undefined),
    )
  )
    throw new HttpError(
      403,
      "Browser troubleshooting details are not enabled for this workspace.",
      undefined,
      "diagnostics-unavailable",
    );
  await refusePhrase(parsed.description, "sent");
  // Every typed detail from the app is screened the same way.
  for (const text of appContextTexts(parsed.app))
    await refusePhrase(text, "sent");
  for (const snapshot of parsed.snapshots ?? [])
    for (const text of appContextTexts({
      ...snapshot.app,
      failure: snapshot.failure,
      sdk: snapshot.sdk,
    }))
      await refusePhrase(text, "sent");
  const stored = readStoredSupportContext(previousStored);
  const previous = stored === "unreadable" ? null : stored;
  parsed = bindSnapshotWallets(parsed, previous, headers);
  try {
    return mergeSupportContext(previous, parsed);
  } catch (error) {
    if (error instanceof SupportContextError)
      throw new HttpError(400, error.message, undefined, error.reason);
    throw error;
  }
}
/** Records the access level of a widget request from the headers the
 * worker rebuilt for its session, on the thread's first request and on every
 * member message. The Templ app wallet shows only while the app was the
 * member's latest place to write. Throws 401 when the session headers are
 * incomplete. */
export function recordWidgetAccess(
  data: SupportRecord,
  headers: Headers,
  now: number,
): void {
  delete data.appWallet;
  if (headers.get("X-Support-Entry") === "hosted") data.entry ??= "hosted";
  const level = headers.get(
    "X-Support-Access-Level",
  ) as SupportAccessLevel | null;
  const origin = headers.get("X-Support-Widget-Origin");
  if (!origin || !level || !SUPPORT_ACCESS_LEVELS.includes(level))
    throw new HttpError(401, "Sign in with your wallet again.");
  if (level === "signed") {
    // The worker names the session's proven wallet in CAIP-10: an EVM
    // account on the chain it signed on, or a Solana account.
    const wallet = parseCaip10(headers.get("X-Support-Wallet"));
    const authenticatedAt = Number(headers.get("X-Session-Authenticated-At"));
    if (
      !wallet ||
      !Number.isSafeInteger(authenticatedAt) ||
      authenticatedAt <= 0 ||
      authenticatedAt > now
    )
      throw new HttpError(401, "Sign in with your wallet again.");
    data.wallet = { ...wallet, authenticatedAt: iso(authenticatedAt), origin };
    data.access = { level, at: now };
    data.verificationRequestedAt = null;
  } else {
    // A guest request never touches the proven wallet on record.
    const claimed = parseCaip10(headers.get("X-Support-Claimed-Wallet"));
    if (level === "connected" && !claimed)
      throw new HttpError(401, "Connect your wallet again.");
    data.access = {
      level,
      ...(level === "anonymous" &&
      headers.get("X-Support-Wallet-Unavailable") === "1"
        ? { walletUnavailable: true as const }
        : {}),
      ...(level === "connected" && claimed ? { claimedWallet: claimed } : {}),
      at: now,
    };
  }
}
/** The public crypto desk keeps its people for problems its AI agent tried
 * and could not solve. There a member's own request for a person, from any
 * client, reuses the handoff the AI agent or a person saved and opens none.
 * The member's message still reaches the AI agent. */
export const cryptoAgentFirst = (room: string) =>
  room === "room:" + CRYPTO_SUPPORT_WORKSPACE;
export const agentFirstError = () =>
  new HttpError(
    409,
    "Describe the problem in a message. If the AI agent can't solve it, a person from the team will answer.",
    undefined,
    "agent-first",
  );
/** Records a message on the thread's support record and its case, and
 * queues the notifications. Returns the conversation record, which a new
 * request on a thread a person owns changes (AI drafts only). */
export async function recordSupportMessage(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  aiAnswer = false,
): Promise<TeamConversationRecord> {
  const data = await supportRecord(storage, record);
  if (role === "member") {
    const hosted =
      context.headers.get("X-Support-Widget") === "member" &&
      context.headers.get("X-Support-Entry") === "hosted";
    if (context.headers.get("X-Support-Widget") === "member") {
      recordWidgetAccess(data, context.headers, context.now);
    } else {
      // Written from the Templ app: the team sees the Solana wallet that
      // session signed in with, and nothing once the member writes another
      // way. The worker sends this header only for an app Solana session.
      const solana = context.headers.get("X-Verified-Solana-Wallet");
      const authenticatedAt = Number(
        context.headers.get("X-Session-Authenticated-At"),
      );
      if (
        context.headers.get("X-Session-Auth-Method") === "solana" &&
        isSolanaAddress(solana) &&
        Number.isSafeInteger(authenticatedAt) &&
        authenticatedAt > 0 &&
        authenticatedAt <= context.now
      )
        data.appWallet = {
          network: "solana",
          address: solana,
          authenticatedAt,
        };
      else delete data.appWallet;
    }
    const reopened = data.state === "resolved" || data.state === "abandoned";
    const spam = data.state === "spam";
    const previousMemberAt = data.lastMemberMessageAt;
    const previousPersonAt = data.lastStaffReplyAt;
    const caseBefore = data.caseSeq ?? 0;
    data.lastMemberMessageAt = context.now;
    data.requestedAt = context.now;
    data.firstRequestedAt ??= context.now;
    if (data.state !== "spam") data.state = "open";
    if (reopened) {
      data.reopened++;
      data.reopenedAt = context.now;
    }
    const memberEvent: CaseEvent = {
      kind: "member-message",
      ...(hosted ? { entry: "hosted" as const } : {}),
      at: context.now,
      access: data.access?.level ?? "app",
      walletVerified: provenWallet(context.headers) !== null,
      // Templ's hourly check is never a request: it waits for no one.
      exclusion:
        context.canary && record.member === context.canary
          ? "canary"
          : await staffPreviewReason(storage, context, record.member),
      spam,
      wasResolved: reopened,
      stopped: record.stopped,
    };
    const transition = await applyCaseEvent(
      storage,
      record,
      data,
      memberEvent,
      context.mediaEnv,
    );
    // A new request never shows an earlier request's
    // follow-up line (the member resolved that one with a step still open).
    if (
      transition.opened &&
      clearEarlierFollowUpLine(record as FollowUpRecord, data.caseSeq ?? 0)
    )
      await storage.put(`conversation-v1:${record.id}`, record);
    // Team alerts for a new or reopened request.
    await emitCaseAlerts(storage, context, record, memberEvent, transition);
    if (
      !context.isBot &&
      data.state !== "spam" &&
      !record.stopped &&
      record.state === "open" &&
      context.headers.get("X-Support-Ask-Person") !== "false" &&
      personRequest(context.body.text)
    ) {
      const asked = askPersonHandoff({
        stopped: record.stopped,
        conversationState: record.state,
        supportState: data.state,
        requestedAt: data.requestedAt,
        current: record.handoff,
        now: context.now,
      });
      if (asked.opened) {
        // On the crypto desk the AI agent reads this request first.
        if (!cryptoAgentFirst(context.room))
          await writeHandoff(storage, context, record, data, asked.handoff);
      } else if (asked.changed) {
        record.handoff = asked.handoff;
        record.revision++;
        await storage.put(`conversation-v1:${record.id}`, record);
        context.pending.push({
          type: "conversation.updated",
          channelId: record.id,
          conversationRevision: record.revision,
        });
      }
    }
    // A new request on a thread a person owns, or where a person wrote last
    // within a week, starts in AI drafts only: the member is answering that
    // person.
    const assignee = record.assignment?.principalId;
    const personOwns =
      (assignee !== undefined && !(context.bots ?? []).includes(assignee)) ||
      (previousPersonAt !== null &&
        previousPersonAt >= (previousMemberAt ?? 0) &&
        context.now - previousPersonAt <= 7 * 86_400_000);
    if ((data.caseSeq ?? 0) > caseBefore && personOwns) {
      const { aiDefault, effective } = await readAiState(storage, record, data);
      const next = restricted(effective, {
        cause: "person-thread",
        by: "rule",
        actor: null,
        caseSeq: data.caseSeq ?? 0,
        now: context.now,
        aiDefault,
      });
      if (next)
        record = await applyAiControl(storage, context, record, data, next, {
          bump: false,
          previous: effective.mode,
        });
    }
  } else {
    if (context.isBot && data.state !== "spam")
      data.lastAgentReplyAt = context.now;
    if (!context.isBot && data.state !== "spam") {
      data.lastStaffReplyAt = context.now;
      if (data.firstResponseMs === null && data.lastMemberMessageAt !== null)
        data.firstResponseMs = Math.max(
          0,
          context.now - (data.firstRequestedAt ?? data.lastMemberMessageAt),
        );
    }
    await applyCaseEvent(
      storage,
      record,
      data,
      {
        kind: "team-reply",
        at: context.now,
        bot: Boolean(context.isBot),
        actor: context.viewer.principalId ?? undefined,
        aiAnswer: Boolean(context.isBot) && aiAnswer,
        scriptedProducer: context.isBot && aiAnswer ? await standardMonthlySyntheticProducer(record.room, context.aliases,
          { env: context.mediaEnv, storage, principalId: context.viewer.principalId, permissions: context.viewer.permissions, isBot: true, now: context.now }) : null,
        templ:
          Boolean(context.isBot) &&
          context.aliases.some((id) => (context.registeredBots ?? []).includes(id)) &&
          (await templAiPrincipal(record.room, context.aliases, { env: context.mediaEnv, storage, principalId: context.viewer.principalId, permissions: context.viewer.permissions, isBot: Boolean(context.isBot), now: context.now })) !== null,
        managed:
          Boolean(context.isBot) &&
          context.viewer.principalId === (await managedPrincipal(record.room)),
      },
      context.mediaEnv,
    );
    // The unseen-reply check and capacity alerts.
    await emitReplyAlerts(storage, context, record, data);
  }
  await storage.put(key(record.id), data);
  if (role === "member")
    await rememberPrioritySession(storage, context, record, data);
  const recipients =
    role === "team"
      ? [record.member]
      : record.assignment
        ? [record.assignment.principalId]
        : ((await context.supportStaff?.()) ?? []);
  // Nothing is queued for spam or for Templ's hourly check.
  const canary = Boolean(context.canary) && record.member === context.canary;
  if (data.state !== "spam" && !canary)
    for (const recipient of recipients)
      if (!actsAs(context.aliases, recipient))
        await queueSupportNotification(
          storage,
          context,
          record,
          recipient,
          // An unassigned request reaches the team as one digest per ten
          // minutes; the assignee hears of each request.
          role === "team" ? "reply" : record.assignment ? "request" : "digest",
        );
  return record;
}
/** A queued email: routing metadata and fixed codes only. The sender
 * (support-notifications.ts) reauthorizes the recipient, resolves the
 * verified address and builds the text at send time. Room-level jobs
 * (`digest`, `workspace`) have no conversation. */
export type SupportNotification = {
  id: string;
  recipient: ChatPrincipalId;
  conversation: string | null;
  kind:
    | "request"
    | "guest-confirmation"
    | "reply"
    | "assignment"
    | "mention"
    | "handoff"
    | "digest"
    | "escalation"
    | "workspace"
    // A follow-up was assigned, is due, overdue,
    // escalated, needs its promised update, or its watch failed. The email
    // is the generic one; delivery rechecks the recipient's access.
    | "follow-up";
  createdAt: number;
  status: "pending" | "disabled";
  href: string;
  /** Not sent before this time. */
  nextAt?: number;
  /** A member reply: cancelled when the member has seen a reply this new. */
  replyAt?: number;
  /** Fixed codes the text is built from; never message text. */
  facts?: SupportNotificationFacts;
};
/** A room alarm consumer passes only the room's origin and time. Without
 * the room's bots no AI agent is answering, so no push waits for one. */
function hasBots(
  context: Pick<ConversationContext, "now" | "room"> & { appOrigin: string },
): context is ConversationContext {
  return "bots" in context;
}
/** An outbox contains routing metadata only. Delivery must reauthorize the
 * recipient and resolve their verified email immediately before sending.
 * A member reply waits two minutes and one goes per thread per half hour;
 * a full queue is counted, never dropped silently. */
export async function queueSupportNotification(
  storage: Storage,
  context: Pick<ConversationContext, "now" | "room" | "mediaEnv"> & { appOrigin: string },
  record: TeamConversationRecord,
  recipient: ChatPrincipalId,
  kind: SupportNotification["kind"],
  facts?: SupportNotificationFacts,
  /** A room alarm consumer reports its own next run instead. */
  options: { wake?: boolean } = {},
) {
  // A text-free push to staff who installed the inbox.
  // A request the AI agent is answering alerts staff only if it still waits
  // when the AI reply window ends. An unassigned request reaches staff as
  // kind "digest", so it takes the same hold.
  if (kind !== "reply")
    await queueStaffPush(
      storage,
      recipient,
      context.now,
      (kind === "request" || kind === "digest") && hasBots(context)
        ? () => staffPushHold(storage, context, record)
        : undefined,
    );
  const member = kind === "reply" && recipient === record.member;
  await queueNotificationJob(storage, {
    now: context.now,
    room: context.room,
    appOrigin: context.appOrigin,
    recipient,
    kind,
    conversation: record.id,
    ...(member
      ? {
          notBefore: context.now + SUPPORT_ALERT_LIMITS.memberReplyDelayMs,
          bucketMs: SUPPORT_ALERT_LIMITS.memberReplyBucketMs,
          replyAt: context.now,
          memberLink: true,
        }
      : {}),
    ...(facts ? { facts } : {}),
    ...(options.wake === false ? { wake: false } : {}),
  }, context.mediaEnv);
}
/** `timeSpent` in a resolve: optional, one of the five buckets, and only
 * from the team when resolving. */
export function parseTimeSpent(
  value: unknown,
  resolvingByTeam: boolean,
): SupportTimeSpent | null {
  if (value === undefined || value === null) return null;
  if (!resolvingByTeam)
    throw new HttpError(
      400,
      "Only the team can record time spent, when resolving.",
    );
  if (!(SUPPORT_TIME_SPENT as readonly unknown[]).includes(value))
    throw new HttpError(400, "Choose a time spent from the list.");
  return value as SupportTimeSpent;
}
/** Stores the handling time for the current request (a later resolve
 * replaces it) and records it on the case. The caller saves `data`. */
export async function recordTimeSpent(
  storage: Storage,
  record: TeamConversationRecord,
  data: SupportRecord,
  bucket: SupportTimeSpent,
  by: ChatPrincipalId,
  now: number,
) {
  data.timeSpent = { bucket, at: now, by };
  await applyCaseEvent(storage, record, data, {
    kind: "time-spent",
    at: now,
    bucket,
  });
}
/** The member resolves their own request: the thread closes as the
 * member's, the case records a member resolution (the charge ledger holds
 * it confirmed for `memberFinalHours`), and nothing asks "Did this solve
 * it?". */
async function memberResolve(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: SupportRecord,
  actor: ChatPrincipalId,
): Promise<TeamConversationRecord> {
  const counts = await storage.get<{
    schemaVersion: 1;
    records: number;
    open: number;
  }>("conversation-state-v1");
  if (counts && record.state === "open")
    await storage.put("conversation-state-v1", {
      ...counts,
      open: Math.max(0, counts.open - 1),
    });
  const previous = data.state;
  data.state = "resolved";
  record.state = "resolved";
  record.resolvedBy = { principalId: actor, kind: "member", at: context.now };
  record.handoff = null;
  record.confirmation = null;
  record.revision++;
  await storage.put(`conversation-v1:${record.id}`, record);
  await setOpenIndex(storage, record);
  await applyCaseEvent(
    storage,
    record,
    data,
    {
      kind: "status",
      at: context.now,
      previous,
      state: "resolved",
      by: "member",
      actor,
      stopped: record.stopped,
    },
    context.mediaEnv,
  );
  context.pendingAudit.push({
    actor,
    action: "conversation.resolve",
    channelId: record.id,
    target: record.member,
  });
  context.pending.push({
    type: "conversation.updated",
    channelId: record.id,
    conversationRevision: record.revision,
  });
  return record;
}
/** "Did this solve it?" asked when the team resolves a request. */
export const askConfirmation = (now: number) => ({
  askedAt: now,
  answer: null,
  answeredAt: null,
});
const STOPPED_TEXT =
  "This user has stopped team messages. They can reopen the case themselves.";
/** Hands the request to a person: stores the handoff on the conversation,
 * records it as activity and in the case, clears the AI agent's typing marks
 * so the member sees the handoff at once, and queues the handoff alert for
 * the assignee or the current support staff. Posts no message and counts
 * nothing. Mutates and saves `record`. */
export async function writeHandoff(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: SupportRecord,
  handoff: StoredHandoff,
) {
  record.handoff = handoff;
  record.revision++;
  await storage.put(`conversation-v1:${record.id}`, record);
  const handoffEvent: CaseEvent = {
    kind: "handoff",
    at: handoff.at,
    reason: handoff.reason,
    by: handoff.by,
  };
  const transition = await applyCaseEvent(
    storage,
    record,
    data,
    handoffEvent,
    context.mediaEnv,
  );
  await captureHandoffLearning(storage, context, record, data, handoff);
  await activity(storage, context, record, data, "handoff", handoff.reason);
  context.typing?.clear(record.id, context.bots ?? []);
  // Templ's hourly check alerts no one.
  const bots = context.bots ?? [];
  const skip = (id: ChatPrincipalId) =>
    actsAs(context.aliases, id) || bots.includes(id);
  if (!(context.canary && record.member === context.canary)) {
    // The assignee, unless the request sits with the AI agent or with
    // whoever handed it off: then the team hears of it instead.
    const recipients =
      record.assignment && !skip(record.assignment.principalId)
        ? [record.assignment.principalId]
        : ((await context.supportStaff?.()) ?? []);
    for (const recipient of new Set(recipients))
      if (!skip(recipient))
        await queueSupportNotification(
          storage,
          context,
          record,
          recipient,
          "handoff",
          {
            reason: handoff.reason,
            by: handoff.by,
          },
        );
    // Team channels and webhooks.
    await emitCaseAlerts(storage, context, record, handoffEvent, transition);
  }
  context.pending.push({
    type: "conversation.updated",
    channelId: record.id,
    conversationRevision: record.revision,
  });
}
/** Whether the workspace's AI agent is checking in: the registered bots
 * that pass the current staff check, read against the room object's memory.
 * A few gets, once per request. */
export async function agentState(
  context: ConversationContext,
): Promise<AgentState> {
  const bots: ChatPrincipalId[] = [];
  for (const bot of context.registeredBots ?? [])
    if (await context.isSupportStaff?.(bot)) bots.push(bot);
  return (
    context.typing?.presence.state(bots, context.now) ?? {
      registered: bots.length > 0,
      active: false,
      seenAt: null,
    }
  );
}
/** What the effective AI mode of a thread's current request needs: its
 * support record, the workspace default and the mode itself. Two gets. */
export async function readAiState(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
  data?: SupportRecord,
): Promise<{
  data: SupportRecord;
  aiDefault: SupportAiMode;
  effective: EffectiveAiMode;
}> {
  const current = data ?? (await supportRecord(storage, record));
  const [settings, profiles] = await Promise.all([
    supportSettings(storage), readSupportProfiles(storage),
  ]);
  const aiDefault = readAiDefault(settings);
  const control = await readOwnAiControl(storage, record, current.caseSeq ?? 0);
  return {
    data: current,
    aiDefault,
    effective: profiles?.assistantEnabled === false
      ? { mode: "off", set: true, control: null }
      : effectiveAiMode(control ?? record.ai, current, aiDefault),
  };
}
/** Refuses a registered bot's act the request's AI mode forbids, before
 * anything is written. People are never limited by the mode. */
export async function assertBotAct(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "isBot">,
  record: TeamConversationRecord,
  act: BotAct,
  data?: SupportRecord,
) {
  if (!context.isBot) return;
  const refusal = botRefusal(
    (await readAiState(storage, record, data)).effective.mode,
    act,
  );
  if (refusal) throw refusal;
}
/** Stores a new AI mode for the request, in the caller's transaction: the
 * record (a revision bump when `bump`), an activity entry, the case, and the
 * bots' typing marks cleared when the AI may no longer reply, so the member
 * stops seeing "AI agent is typing" at once. Mutates and returns `record`. */
export async function applyAiControl(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: SupportRecord,
  next: StoredAiControl,
  options: { bump: boolean; previous: SupportAiMode },
): Promise<TeamConversationRecord> {
  record.ai = next;
  await checkpointOwnAiControl(storage, record, next);
  if (options.bump) record.revision++;
  await storage.put(`conversation-v1:${record.id}`, record);
  // Before the case event, which saves `data`.
  if (next.mode === "off")
    await cancelPendingForAiOff(storage, {
      thread: record.id,
      data,
      now: context.now,
      by: next.actor,
    });
  await applyCaseEvent(
    storage,
    record,
    data,
    {
      kind: "ai-mode",
      at: next.at,
      mode: next.mode,
      previous: options.previous,
      by: next.by,
      cause: next.cause,
    },
    context.mediaEnv,
  );
  await activity(
    storage,
    context,
    record,
    data,
    "ai-mode",
    `${next.mode}:${next.cause}`,
  );
  if (next.mode !== "answers")
    context.typing?.clear(record.id, context.bots ?? []);
  if (options.bump)
    context.pending.push({
      type: "conversation.updated",
      channelId: record.id,
      conversationRevision: record.revision,
      // An AI mode change is the team's; no member
      // socket, member event page or catch-up delivers it.
      audience: "team",
    });
  return record;
}
/** A person's reply, claim, assignment or typing moves a request in AI
 * answers to AI drafts only. Bots never change the mode. Call it after the
 * action's own case event, so the change binds to the current request. */
export async function restrictForPerson(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  cause: Extract<
    AiRestrictionCause,
    "person-reply" | "person-claim" | "person-assign" | "person-typing"
  >,
  options: { bump: boolean; data?: SupportRecord },
): Promise<TeamConversationRecord> {
  if (context.isBot || !context.viewer.principalId) return record;
  const { data, aiDefault, effective } = await readAiState(
    storage,
    record,
    options.data,
  );
  const next = restricted(effective, {
    cause,
    by: "person",
    actor: context.viewer.principalId,
    caseSeq: data.caseSeq ?? 0,
    now: context.now,
    aiDefault,
  });
  if (!next) return record;
  return applyAiControl(storage, context, record, data, next, {
    bump: options.bump,
    previous: effective.mode,
  });
}
export async function supportRoomRoute(
  storage: Storage,
  context: ConversationContext,
  action: string,
  team: boolean,
  enabled: boolean,
): Promise<Response | null> {
  if (
    ![
      "settings",
      "saved-replies",
      "report",
      "preferences",
      "refusals",
    ].includes(action)
  )
    return null;
  const actor = context.viewer.principalId;
  if (!actor) throw new HttpError(401, "Sign in to continue.");
  const settings = await supportSettings(storage);
  const canManage =
    context.viewer.isManager ||
    (team && context.viewer.permissions.includes("manageSupport"));
  if (action === "preferences") {
    if (context.query.get("diagnostics") === "email") {
      if (context.method !== "GET" || !canManage)
        throw new HttpError(404, "Support tools not found.");
      return json(
        await readNotificationStatus(storage, context.mediaEnv, context.now),
      );
    }
    const prefKey = `support-alert-preference-v1:${actor}`;
    if (context.method === "POST") {
      if (typeof context.body.enabled !== "boolean")
        throw new HttpError(400, "Choose whether to receive support alerts.");
      await storage.put(prefKey, { enabled: context.body.enabled });
    }
    return json({
      ...((await storage.get(prefKey)) ?? { enabled: false }),
      emailDeliveryVerified: false,
    });
  }
  if (action === "refusals") {
    // Counts by day and reason, with no identities: the manager, billing
    // staff and support leads may read them.
    const permissions = context.viewer.permissions.map(String);
    if (
      context.method !== "GET" ||
      !(
        context.viewer.isManager ||
        permissions.includes("manageBilling") ||
        (team && permissions.includes("manageSupport"))
      )
    )
      throw new HttpError(404, "Support tools not found.");
    return json(
      await readSupportRefusals(storage, {
        days: refusalWindowDays(context.query.get("days")),
        nowMs: context.now,
      }),
    );
  }
  if (!team) throw new HttpError(404, "Support tools not found.");
  if (action === "settings") {
    if (context.method === "POST") {
      if (!canManageWorkspace(context.viewer, context.isBot))
        throw new HttpError(403, "Only workspace admins can change support settings.");
      requireWorkspaceAdminHeaders(
        context.headers,
        context.viewer.isManager,
        context.body.confirmed,
        context.now,
      );
      // A save merges: a field left out keeps its stored value, so an older
      // app can't reset a setting it doesn't know about.
      const body = context.body;
      if (body.testAccounts !== undefined && !context.viewer.isManager)
        throw new HttpError(403, "Only the owner can change billing test accounts.");
      const timezone =
        body.timezone === undefined
          ? settings.timezone
          : text(body.timezone, 80);
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        throw new HttpError(400, "Choose a valid timezone.");
      }
      const ids = async (value: unknown): Promise<ChatPrincipalId[]> => {
        const list = strings(value ?? [], SUPPORT_LIMITS.staffAccounts, 150);
        const output: ChatPrincipalId[] = [];
        for (const id of list) {
          const principal = normalizeChatPrincipal(id);
          if (!principal || !(await context.isRoomMember(principal)))
            throw new HttpError(400, "Choose accounts in this workspace.");
          output.push(principal);
        }
        return output;
      };
      const businessHours =
        body.businessHours === undefined
          ? settings.businessHours
          : text(body.businessHours ?? "", 500, true);
      const acknowledgment =
        body.acknowledgment === undefined
          ? settings.acknowledgment
          : text(body.acknowledgment ?? "", 1000, true);
      // The acknowledgment is sent to members as the team's words.
      await refusePhrase(businessHours, "saved");
      await refusePhrase(acknowledgment, "saved");
      refuseSecretRequest(acknowledgment);
      const aiDefault = parseAiDefault(body.aiDefault) ?? settings.aiDefault;
      const next: SupportSettings & SupportCaseSettings = {
        timezone,
        businessHours,
        acknowledgment,
        categories:
          body.categories === undefined
            ? settings.categories
            : strings(body.categories ?? [], SUPPORT_LIMITS.categories, 60),
        testAccounts:
          body.testAccounts === undefined
            ? settings.testAccounts
            : await ids(body.testAccounts),
        ...(aiDefault === undefined ? {} : { aiDefault }),
        // AI assist settings merge the same way.
        ...parseCaseSettings(
          body,
          settings as SupportSettings & SupportCaseSettings,
        ),
      };
      await storage.put(SETTINGS, next);
      // Field names and codes only: business hours and the acknowledgment
      // appear as changed names, never as text.
      const changed = (
        [
          "timezone",
          "businessHours",
          "acknowledgment",
          "categories",
          "testAccounts",
          "aiDefault",
          "agentChecks",
          "aiSourceHosts",
        ] as const
      ).filter((field) => {
        const read = (value: SupportSettings & SupportCaseSettings) =>
          field === "aiDefault" ? readAiDefault(value) : value[field];
        return JSON.stringify(read(settings)) !== JSON.stringify(read(next));
      });
      const shown = (value: SupportSettings) => ({
        timezone: value.timezone,
        testAccounts: value.testAccounts,
        categories: value.categories,
        aiDefault: readAiDefault(value),
      });
      context.pendingAudit.push({
        actor,
        action: "support.settings",
        before: shown(settings),
        after: { ...shown(next), changed },
      });
      return json({
        settings: { ...next, aiDefault: readAiDefault(next) },
        canManage: true,
        canEditSettings: true,
      });
    }
    return json({
      settings: { ...settings, aiDefault: readAiDefault(settings) },
      supportProfiles: await readSupportProfiles(storage),
      responderConfigured: (context.registeredBots?.length ?? 0) > 0,
      canManage,
      canEditSettings: canManageWorkspace(context.viewer, context.isBot),
    });
  }
  if (action === "saved-replies") {
    let replies = await savedReplies(storage);
    if (context.method === "POST") {
      if (!enabled) throw new HttpError(503, "Support tools are being tested.");
      if (!canManage)
        throw new HttpError(
          403,
          "Only the manager or a support lead can change saved replies.",
        );
      const id =
        typeof context.body.id === "string"
          ? text(context.body.id, 80)
          : crypto.randomUUID();
      if (context.body.remove === true)
        replies = replies.filter((reply) => reply.id !== id);
      else {
        const reply = {
          id,
          title: text(context.body.title, 100),
          text: text(context.body.text, 4000),
          updatedAt: iso(context.now),
        };
        await refusePhrase(reply.title, "saved");
        await refusePhrase(reply.text, "saved");
        refuseSecretRequest(reply.text);
        if (
          !replies.some((item) => item.id === id) &&
          replies.length >= SUPPORT_LIMITS.savedReplies
        )
          throw new HttpError(
            409,
            "Remove a saved reply before adding another.",
          );
        replies = [...replies.filter((item) => item.id !== id), reply];
      }
      const existed = (await storage.get(`${REPLIES}${id}`)) !== undefined;
      if (context.body.remove === true) await storage.delete(`${REPLIES}${id}`);
      else
        await storage.put(
          `${REPLIES}${id}`,
          replies.find((reply) => reply.id === id)!,
        );
      // Which saved reply changed and how; never its text.
      context.pendingAudit.push({
        actor,
        action: "support.replies",
        target: id,
        after: {
          op:
            context.body.remove === true
              ? "remove"
              : existed
                ? "update"
                : "create",
        },
      });
    }
    return json({ replies, canManage });
  }
  if (action === "report") {
    if (!canManage)
      throw new HttpError(
        403,
        "Only the manager or a support lead can read support reporting.",
      );
    // Requests opened in the window, from the case ledger; what waits now
    // is not windowed.
    const report = await supportCaseReport(
      storage,
      settings,
      (context.query.get("window") ?? "30d") as SupportReportWindow,
      context.now,
    );
    return json({ report });
  }
  return null;
}
/** What the thread route needs from the conversation module. */
export type WorkflowHooks = {
  /** The member's own reopen of their resolved request, with the open
   * limits and quotas of any reopen. False, with nothing written, when the
   * workspace can't take it now. */
  reopen(record: TeamConversationRecord, data: SupportRecord): Promise<boolean>;
  /** The viewer's view of the conversation. */
  view(record: TeamConversationRecord): Promise<TeamConversation>;
};
export async function supportThreadRoute(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  gate: {
    /** The support workflow's rollout gate is open. */
    available: boolean;
    /** The workspace is not paused, so the team can act. */
    writable: boolean;
  },
  hooks: WorkflowHooks,
): Promise<Response> {
  // Workflow actions for drafts, evidence and AI off.
  {
    const handled = await caseWorkflowAction(
      storage,
      context,
      record,
      role,
      gate,
    );
    if (handled) return handled;
  }
  // Follow-up actions on the thread.
  // Resolve refused while follow-ups are open, spam cancels them, a
  // specialist mention grants read access, and a routed handoff adds one.
  await followUpWorkflowHook(storage, context, record, role, gate);
  // Typed context and member context removal.
  // The member's widget views of the thread (the wait line, the details
  // they shared, the sources of the managed AI agent's replies) and a
  // member removing one shared detail (support-widget-member.ts).
  {
    const handled = await widgetMemberThreadRoute(
      storage,
      context,
      record,
      role,
      gate,
    );
    if (handled) return handled;
  }
  const data = await supportRecord(storage, record);
  const settings = await supportSettings(storage);
  const team = role === "team";
  const actor = context.viewer.principalId!;
  const canManage =
    context.viewer.isManager ||
    (team && context.viewer.permissions.includes("manageSupport"));
  let noteCommitted = false;
  /** Fields a member action returns next to the workflow. */
  const extra: Record<string, unknown> = {};
  let attachmentCommit: { id: string; bytes: number } | null = null;
  if (context.method === "GET" && context.query.get("attachment")) {
    const id = context.query.get("attachment")!;
    const attachment = data.attachments.find((item) => item.id === id);
    const media = data.attachmentMedia[id];
    if (!attachment || !media)
      throw new HttpError(404, "Screenshot not found.");
    const object = await readSupportAttachment(
      context.mediaEnv,
      { room: record.room, conversation: record.id, attachment: id },
      attachment,
      media,
    );
    return new Response(object.body, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(object.size),
        "Cache-Control": "no-store",
        "Content-Disposition": 'inline; filename="support-screenshot.png"',
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }
  if (context.method === "POST") {
    if (!gate.available)
      throw new HttpError(503, "Support tools are being tested.");
    if (context.viewer.banned || context.viewer.mutedUntil)
      throw new HttpError(403, "You cannot change this case right now.");
    const action = context.body.action;
    // While the workspace is paused, the member may still answer "Did this
    // solve it?", mark the request solved and ask for a person, and the team
    // may still keep the AI out; everything else waits for a top-up.
    if (
      !gate.writable &&
      action !== "confirm" &&
      action !== "solved" &&
      action !== "ask-person" &&
      !(action === "ai-mode" && context.body.mode !== "answers")
    )
      throw team
        ? staffRefusal()
        : new HttpError(403, SUPPORT_REFUSAL, undefined, "support-paused");
    if (action === "context") {
      if (role !== "member" || context.body.consent !== true)
        throw new HttpError(
          403,
          "Only the user can choose the context shared with the team.",
        );
      const shared = await writeSupportContext(
        data.context,
        context.body.context,
        context.headers,
        await featureOn(context.mediaEnv, storage, "supportDiagnostics"),
      );
      data.context = shared;
      await markSharedMessageDetails(
        storage,
        record.id,
        data.lastMemberMessageAt,
        context.aliases,
        context.body.context,
      );
      await applyCaseEvent(
        storage,
        record,
        data,
        {
          kind: "context",
          at: context.now,
          network: shared.network !== undefined,
          transaction: (shared.transactions?.length ?? 0) > 0,
        },
        context.mediaEnv,
      );
      await activity(storage, context, record, data, "context");
    } else if (action === "confirm") {
      // "Did this solve it?" is the member's to answer, once per team
      // resolution. No counts, seats or message ledger rows.
      if (team)
        throw new HttpError(
          403,
          "Only the user can answer this.",
          undefined,
          "member-only",
        );
      if (typeof context.body.solved !== "boolean")
        throw new HttpError(400, "Choose yes or no.");
      const asked = record.confirmation;
      // On an open request whose team reply has waited
      // `askAfterHours`, the widget asks too. Yes resolves it as the
      // member's own; No keeps it open and stops asking until the team
      // replies again.
      const askedOpen =
        (record.state === "open" || data.state === "abandoned") &&
        data.state !== "spam" &&
        (await memberSolve(storage, record, context.now)) === "ask";
      // Spam asks nothing, whatever an earlier resolution asked.
      if (
        !askedOpen &&
        (record.state !== "resolved" || !asked || data.state === "spam")
      )
        throw new HttpError(
          409,
          "There's nothing to answer yet.",
          undefined,
          "confirm-not-asked",
        );
      if (askedOpen) {
        if (context.body.solved)
          record = await memberResolve(storage, context, record, data, actor);
        else {
          data.state = "open";
          record.confirmation = {
            askedAt: context.now,
            answer: "not-solved",
            answeredAt: context.now,
          };
          record.revision++;
          await storage.put(`conversation-v1:${record.id}`, record);
          await applyCaseEvent(
            storage,
            record,
            data,
            {
              kind: "confirm",
              at: context.now,
              answer: "not-solved",
              reopened: false,
            },
            context.mediaEnv,
          );
          context.pending.push({
            type: "conversation.updated",
            channelId: record.id,
            conversationRevision: record.revision,
          });
        }
        await activity(
          storage,
          context,
          record,
          data,
          "confirmed",
          context.body.solved ? "solved" : "not-solved",
        );
      }
      const answer = context.body.solved ? "solved" : "not-solved";
      if (!askedOpen && asked?.answer != null) {
        if (asked.answer !== answer)
          throw new HttpError(
            409,
            "You already answered.",
            undefined,
            "confirm-answered",
          );
      } else if (!askedOpen && asked) {
        record.confirmation = { ...asked, answer, answeredAt: context.now };
        record.revision++;
        await storage.put(`conversation-v1:${record.id}`, record);
        await activity(storage, context, record, data, "confirmed", answer);
        // "No" reopens the request through the member's own reopen, when
        // the workspace can take it; the answer stays either way.
        const reopened =
          answer === "not-solved" && (await hooks.reopen(record, data));
        await applyCaseEvent(
          storage,
          record,
          data,
          {
            kind: "confirm",
            at: context.now,
            answer,
            reopened,
          },
          context.mediaEnv,
        );
        context.pending.push({
          type: "conversation.updated",
          channelId: record.id,
          conversationRevision: record.revision,
        });
        if (answer === "not-solved") extra.reopened = reopened;
      }
      extra.conversation = await hooks.view(record);
      // The member marks their own request solved.
    } else if (action === "solved") {
      if (team)
        throw new HttpError(
          403,
          "Only the user can mark this solved.",
          undefined,
          "member-only",
        );
      if (record.stopped || data.state === "spam")
        throw new HttpError(409, "This case can't be marked solved.");
      if (record.state === "open") {
        if (!(await memberSolve(storage, record, context.now)))
          throw new HttpError(
            409,
            "The team hasn't answered yet.",
            undefined,
            "solved-not-ready",
          );
        record = await memberResolve(storage, context, record, data, actor);
        await activity(storage, context, record, data, "status", "resolved");
      }
      extra.conversation = await hooks.view(record);
    } else if (action === "ask-person") {
      // "Talk to a person": the member's own request, on their own thread.
      if (team) throw askPersonError("member-only");
      parseAskPersonBody(context.body);
      const asked = askPersonHandoff({
        stopped: record.stopped,
        conversationState: record.state,
        supportState: data.state,
        requestedAt: data.requestedAt,
        current: record.handoff,
        now: context.now,
      });
      if (asked.opened) {
        if (cryptoAgentFirst(context.room)) throw agentFirstError();
        await writeHandoff(storage, context, record, data, asked.handoff);
      } else if (asked.changed) {
        // A handoff the AI agent or a person opened just before the tap
        // becomes the member's own: only a person's reply or a resolution
        // clears it. It was already alerted and recorded once.
        record.handoff = asked.handoff;
        record.revision++;
        await storage.put(`conversation-v1:${record.id}`, record);
        context.pending.push({
          type: "conversation.updated",
          channelId: record.id,
          conversationRevision: record.revision,
        });
      }
      return json({ handoff: handoffView(record.handoff, "member") });
    } else if (action === "attachment") {
      if (role === "team" && record.stopped)
        throw new HttpError(409, "This user has stopped team messages.");
      if (role === "team" && context.isBot && record.handoff)
        throw handedOffError(record.handoff);
      if (team)
        await assertBotAct(storage, context, record, "attachment", data);
      const id =
        typeof context.body.clientId === "string" &&
        SUPPORT_ATTACHMENT_ID.test(context.body.clientId)
          ? context.body.clientId
          : null;
      if (!id) throw new HttpError(400, "Send a valid screenshot request id.");
      const encoded = text(
        context.body.data,
        Math.ceil((SUPPORT_LIMITS.screenshotBytes * 4) / 3) + 4,
      );
      if (
        context.body.contentType !== "image/png" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        throw new HttpError(415, "Choose a PNG screenshot.");
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      } catch {
        throw new HttpError(415, "Choose a valid PNG screenshot.");
      }
      const normalized = await normalizePng(
        bytes,
        SUPPORT_LIMITS.screenshotBytes,
        SUPPORT_LIMITS.screenshotPixels,
        SUPPORT_LIMITS.screenshotDimension,
      );
      const existing = data.attachments.find((item) => item.id === id);
      if (existing) {
        const media = data.attachmentMedia[id];
        if (
          existing.author !== actor ||
          existing.bytes !== normalized.length ||
          !media ||
          media.contentHash !== (await mediaHash(normalized))
        )
          throw new HttpError(
            409,
            "This screenshot retry does not match the original.",
          );
        const staged = await stageSupportAttachment(
          context.mediaEnv,
          { room: record.room, conversation: record.id, attachment: id },
          normalized,
        );
        if (
          staged.objectId !== media.objectId ||
          staged.contentHash !== media.contentHash
        )
          throw new HttpError(409, "This screenshot id is already in use.");
        attachmentCommit = { id: media.objectId, bytes: existing.bytes };
      } else {
        // A member's screenshots count per request
        // (support-member-screenshots.ts).
        if (role === "member")
          await assertMemberScreenshotRoom(
            storage,
            record.id,
            data,
            context.aliases,
          );
        if (
          data.attachments.length >= SUPPORT_LIMITS.screenshotsPerConversation
        )
          throw new HttpError(
            409,
            "This case has reached its screenshot limit.",
          );
        const { funded } = await readProductSupport(storage, context.now);
        const usedBytes =
          (await storage.get<number>(SUPPORT_MEDIA_BYTES_KEY)) ?? 0;
        if (
          usedBytes + normalized.length >
          (funded
            ? SUPPORT_LIMITS.fundedScreenshotStorageBytes
            : SUPPORT_LIMITS.freeScreenshotStorageBytes)
        )
          throw new HttpError(
            409,
            "This workspace has reached its private screenshot storage allowance.",
          );
        const media = await stageSupportAttachment(
          context.mediaEnv,
          { room: record.room, conversation: record.id, attachment: id },
          normalized,
        );
        await storage.put(
          SUPPORT_MEDIA_BYTES_KEY,
          usedBytes + normalized.length,
        );
        data.attachments.push({
          id,
          author: actor,
          at: iso(context.now),
          bytes: normalized.length,
          contentType: "image/png",
        });
        data.attachmentMedia[id] = media;
        await activity(storage, context, record, data, "attachment");
        attachmentCommit = { id: media.objectId, bytes: normalized.length };
      }
    } else {
      if (!team) throw new HttpError(404, "Support tools not found.");
      if (action === "read") {
        await storage.put(`support-seen-v1:${record.id}:${actor}`, context.now);
      } else if (action === "presence") {
        await assertBotAct(storage, context, record, "presence", data);
        if (typeof context.body.composing !== "boolean")
          throw new HttpError(400, "Choose a valid reply state.");
        // Observe human composer intervals.
        // The server clock sets every duration.
        await recordComposeTime(
          storage,
          record,
          context,
          context.body.composing,
        );
        data.presence = data.presence.filter(
          (item) =>
            item.expiresAt > context.now &&
            !actsAs(context.aliases, item.principalId),
        );
        if (data.presence.length < SUPPORT_LIMITS.staffAccounts)
          data.presence.push({
            principalId: actor,
            composing: context.body.composing,
            expiresAt: context.now + 45_000,
          });
        await storage.put(key(record.id), data);
        // A person writing a reply steps in. Only an app that sends typed
        // (after a real input event) counts, so a draft restored on open
        // never switches the AI.
        if (context.body.composing === true && context.body.typed === true)
          record = await restrictForPerson(
            storage,
            context,
            record,
            "person-typing",
            { bump: true, data },
          );
      } else if (action === "note") {
        await assertBotAct(storage, context, record, "note", data);
        const mentions: ChatPrincipalId[] = [];
        for (const value of strings(context.body.mentions ?? [], 10, 150)) {
          const principal = normalizeChatPrincipal(value);
          if (!principal || !(await context.isSupportStaff?.(principal)))
            throw new HttpError(400, "Mention current support staff only.");
          mentions.push(principal);
        }
        const clientId = text(context.body.clientId, 80);
        const retryKey = `support-note-client-v1:${record.id}:${clientId}`;
        const previousKey = await storage.get<string>(retryKey);
        const existing = previousKey
          ? await storage.get<SupportNote>(previousKey)
          : undefined;
        const body = text(context.body.text, 4000);
        // Notes may quote what a member was told, so only phrases are refused.
        await refusePhrase(body, "saved");
        if (
          existing &&
          (existing.author !== actor ||
            existing.text !== body ||
            existing.mentions.join() !== mentions.join())
        )
          throw new HttpError(
            409,
            "This note retry does not match the original.",
          );
        if (context.body.interactionPolicy !== undefined) {
          if (context.body.interactionPolicy !== "bounded-v1" || !context.isBot || mentions.length || body.length > 600)
            throw new HttpError(400, "Use a short private AI handoff summary without mentions.");
          if (!existing && !await featureOn(context.mediaEnv, storage, "aiInteractionImprovements"))
            throw new HttpError(409, "The AI summary feature is off. A person can review the case.", undefined, "ai-interaction-changed");
        }
        if (!existing) {
          assertMessageBudgetAvailable(
            context.headers.get(MESSAGE_BUDGET_AVAILABLE_HEADER) !== "false",
          );
          if ((data.noteCount ?? 0) >= SUPPORT_LIMITS.notesPerConversation)
            throw new HttpError(
              409,
              "This case has reached its internal-note limit.",
            );
          await reserveSupportMessage(storage, context.now, "team");
          data.noteCount = (data.noteCount ?? 0) + 1;
          const noteKey = `support-note-v1:${record.id}:${String(data.noteCount).padStart(8, "0")}`;
          await storage.put(noteKey, {
            id: clientId,
            author: actor,
            text: body,
            mentions,
            at: iso(context.now),
          } satisfies SupportNote);
          await storage.put(retryKey, noteKey);
          noteCommitted = true;
          // The note's id and how many people it mentions; never its text.
          context.pendingAudit.push({
            actor,
            action: "support.note",
            channelId: record.id,
            target: clientId,
            after: { mentions: mentions.length },
          });
          if (context.isBot) data.lastAgentNoteAt = context.now;
          await applyCaseEvent(
            storage,
            record,
            data,
            {
              kind: "note",
              at: context.now,
            },
            context.mediaEnv,
          );
          await activity(storage, context, record, data, "note");
          for (const mentioned of mentions)
            await queueSupportNotification(
              storage,
              context,
              record,
              mentioned,
              "mention",
            );
        }
      } else if (action === "status") {
        if (context.isBot && record.handoff)
          throw handedOffError(record.handoff);
        await assertBotAct(storage, context, record, "status", data);
        if (
          !["open", "waiting", "resolved", "spam"].includes(
            String(context.body.state),
          )
        )
          throw new HttpError(
            400,
            "Choose open, waiting on user, resolved or spam.",
          );
        const nextState = ["resolved", "spam"].includes(String(context.body.state))
          ? "resolved"
          : "open";
        if (record.stopped && nextState === "open")
          throw new HttpError(
            409,
            "This user has stopped team messages.",
            undefined,
            "stopped",
          );
        const previous = data.state;
        const timeSpent = parseTimeSpent(
          context.body.timeSpent,
          context.body.state === "resolved",
        );
        data.state = context.body.state as SupportState;
        if (record.state !== nextState) {
          const counts = await storage.get<{
            schemaVersion: 1;
            records: number;
            open: number;
          }>("conversation-state-v1");
          const { funded } = await readProductSupport(storage, context.now);
          const openLimit = funded
            ? PRODUCT_LIMITS.supportOpenRecords
            : PRODUCT_LIMITS.freeSupportOpenRecords;
          if (nextState === "open" && counts && counts.open >= openLimit)
            throw new HttpError(
              409,
              "The support inbox has reached its open case limit.",
            );
          if (counts)
            await storage.put("conversation-state-v1", {
              ...counts,
              open: Math.max(0, counts.open + (nextState === "open" ? 1 : -1)),
            });
          record.state = nextState;
          if (nextState === "open") data.reopenedAt = context.now;
          record.resolvedBy =
            nextState === "resolved"
              ? { principalId: actor, kind: "team", at: context.now }
              : null;
          // A resolution, or marking spam, ends any handoff.
          if (nextState === "resolved") record.handoff = null;
          // The team's resolution asks "Did this solve it?"; spam and every
          // reopen ask nothing.
          record.confirmation =
            data.state === "resolved" ? askConfirmation(context.now) : null;
          record.revision++;
          await storage.put(`conversation-v1:${record.id}`, record);
          await setOpenIndex(storage, record);
          context.pending.push({
            type: "conversation.updated",
            channelId: record.id,
            conversationRevision: record.revision,
          });
        } else if (previous === "abandoned" && data.state === "resolved") {
          record.resolvedBy = {
            principalId: actor,
            kind: "team",
            at: context.now,
          };
          record.confirmation = askConfirmation(context.now);
          record.revision++;
          await storage.put(`conversation-v1:${record.id}`, record);
          context.pending.push({
            type: "conversation.updated",
            channelId: record.id,
            conversationRevision: record.revision,
          });
        } else if (data.state === "spam" && record.confirmation) {
          // A resolved request marked spam withdraws its "Did this solve
          // it?": a "No" would otherwise reopen it.
          record.confirmation = null;
          record.revision++;
          await storage.put(`conversation-v1:${record.id}`, record);
          context.pending.push({
            type: "conversation.updated",
            channelId: record.id,
            conversationRevision: record.revision,
          });
        }
        // A team reopen alerts the team and starts the escalation wait.
        await applyCaseEventWithAlerts(storage, context, record, data, {
          kind: "status",
          at: context.now,
          previous,
          state: data.state,
          by: context.isBot ? "bot" : "person",
          stopped: record.stopped,
          actor,
        });
        // Team views built after this read the charge again.
        if (data.state === "resolved" || data.state === "spam")
          context.viewReads = undefined;
        await activity(storage, context, record, data, "status", data.state);
        if (timeSpent) {
          await recordTimeSpent(
            storage,
            record,
            data,
            timeSpent,
            actor,
            context.now,
          );
          await activity(
            storage,
            context,
            record,
            data,
            "time-spent",
            timeSpent,
          );
        }
      } else if (action === "tags") {
        await assertBotAct(storage, context, record, "tags", data);
        if (context.body.tags !== undefined) {
          const seen = new Set<string>();
          data.tags = strings(context.body.tags ?? [], SUPPORT_LIMITS.tagsPerConversation, 40)
            .filter(tag => {
              const key = tag.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        }
        if (Object.hasOwn(context.body, "category")) {
          const category = context.body.category ? text(context.body.category, 60) : null;
          if (category && category !== data.category && !settings.categories.includes(category))
            throw new HttpError(400, "Choose a configured case category.");
          data.category = category;
        }
        await activity(storage, context, record, data, "tags");
      } else if (action === "assign") {
        if (!canManage)
          throw new HttpError(
            403,
            "Only the manager or a support lead can assign another person on the team.",
          );
        if (context.isBot && record.handoff)
          throw handedOffError(record.handoff);
        await assertBotAct(storage, context, record, "assign", data);
        const assigned =
          context.body.principalId === null
            ? null
            : normalizeChatPrincipal(context.body.principalId);
        if (
          context.body.principalId !== null &&
          (!assigned || !(await context.isSupportStaff?.(assigned)))
        )
          throw new HttpError(400, "Choose a current support staff account.");
        // A person request waits for a reply; assignment clears other handoffs.
        const cleared =
          assigned !== null && clearsHandoff(record.handoff, "assign");
        record.assignment = assigned
          ? { principalId: assigned, claimedAt: context.now }
          : null;
        if (cleared) record.handoff = null;
        if (assigned)
          await recordTeamJoin(record, context, assigned, data.caseSeq ?? 0);
        record.revision++;
        await storage.put(`conversation-v1:${record.id}`, record);
        await applyCaseEvent(
          storage,
          record,
          data,
          {
            kind: "assign",
            at: context.now,
            assigned: Boolean(assigned),
          },
          context.mediaEnv,
        );
        if (cleared)
          await applyCaseEvent(
            storage,
            record,
            data,
            {
              kind: "handoff-cleared",
              at: context.now,
              by: "assign",
            },
            context.mediaEnv,
          );
        await activity(
          storage,
          context,
          record,
          data,
          "assignment",
          assigned ?? "unassigned",
        );
        if (assigned)
          await queueSupportNotification(
            storage,
            context,
            record,
            assigned,
            "assignment",
          );
        context.pendingAudit.push({
          actor,
          action: "support.assign",
          channelId: record.id,
          target: assigned,
        });
        // Giving the request to a person, not to the AI agent, keeps the
        // agent to drafts.
        if (assigned && !(context.bots ?? []).includes(assigned))
          record = await restrictForPerson(
            storage,
            context,
            record,
            "person-assign",
            { bump: false, data },
          );
      } else if (action === "handoff") {
        // A fixed reason code only; details go in an internal note.
        const { reason, ifLatest } = parseHandoffBody(context.body);
        await assertAppAnswerWrite(storage, context, record, context.body);
        await assertBotAct(storage, context, record, "handoff", data);
        if (record.stopped)
          throw new HttpError(409, STOPPED_TEXT, undefined, "stopped");
        if (record.state === "resolved")
          throw new HttpError(
            409,
            "This case is resolved. Reopen it before handing it off.",
            undefined,
            "handoff-resolved",
          );
        if (data.requestedAt === null)
          throw new HttpError(
            409,
            "There's no user case to hand off yet.",
            undefined,
            "handoff-no-request",
          );
        await assertLatest(storage, record.id, ifLatest);
        // One handoff per request: a repeat changes nothing and alerts no
        // one again, whatever reason it names.
        if (!record.handoff)
          await writeHandoff(storage, context, record, data, {
            at: context.now,
            reason,
            by: context.isBot ? "agent" : "person",
            requestAt: data.requestedAt,
          });
        await finishAppAnswer(storage, record.id, context.body.appAnswer, "handed-off");
      } else if (action === "ai-answer") {
        if (context.isBot) throw personOnlyError();
        if (Object.keys(context.body).some((key) => !["action", "expectedPrincipalId"].includes(key))) throw new HttpError(400, "Choose a support action.");
        await enqueueAppAnswer(storage, context, record);
      } else if (action === "ai-mode") {
        // People on the team only: the AI agent never changes its own mode.
        if (context.isBot) throw personOnlyError();
        const { mode, takeOver } = parseAiModeBody(context.body);
        // The member asked for a person: only a person's reply (or a
        // resolution) lets the AI back in.
        assertAiAnswersAllowed(mode, record.handoff);
        // The mode binds to the current request, so a thread the ledger
        // hasn't reached is brought up to date first.
        if (data.ledgerVersion !== 1)
          await synthesizeThreadLedger(storage, record, data, context.now);
        const { effective } = await readAiState(storage, record, data);
        const next = chosen(effective, {
          mode,
          cause: takeOver ? "take-over" : "person-set",
          actor,
          caseSeq: data.caseSeq ?? 0,
          now: context.now,
        });
        // A person request waits for a reply; AI control clears other handoffs.
        const cleared =
          (takeOver || mode === "answers") &&
          clearsHandoff(record.handoff, takeOver ? "take-over" : "ai-answers");
        if (cleared) record.handoff = null;
        if (next)
          record = await applyAiControl(storage, context, record, data, next, {
            bump: true,
            previous: effective.mode,
          });
        else if (cleared) {
          record.revision++;
          await storage.put(`conversation-v1:${record.id}`, record);
          context.pending.push({
            type: "conversation.updated",
            channelId: record.id,
            conversationRevision: record.revision,
          });
        }
        if (cleared)
          await applyCaseEvent(
            storage,
            record,
            data,
            {
              kind: "handoff-cleared",
              at: context.now,
              by: "ai-mode",
            },
            context.mediaEnv,
          );
        if (mode === "answers" && (next || cleared) && await appAiEnabled(storage, context.mediaEnv, context.room))
          await enqueueAppAnswer(storage, context, record, false);
      } else if (action === "request-verification") {
        // A flag the widget renders as its own sign-in card. It carries no
        // text and no signing request; only the member can start the sign-in.
        if (!team)
          throw new HttpError(
            403,
            "Only the team can ask a user to verify their wallet.",
          );
        // A request handed to a person waits for that person, not for a
        // sign-in card from the AI agent.
        if (context.isBot && record.handoff)
          throw handedOffError(record.handoff);
        await assertBotAct(storage, context, record, "verify", data);
        if (record.stopped)
          throw new HttpError(409, "This user has stopped team messages.");
        if (!data.access)
          throw new HttpError(
            409,
            "This user wrote from the Templ app, not your widget.",
          );
        if (data.access.level === "signed")
          throw new HttpError(409, "This user already verified their wallet.");
        if (!data.verificationRequestedAt) {
          data.verificationRequestedAt = context.now;
          record.revision++;
          await storage.put(`conversation-v1:${record.id}`, record);
          await applyCaseEvent(
            storage,
            record,
            data,
            {
              kind: "verification-requested",
              at: context.now,
            },
            context.mediaEnv,
          );
          await activity(
            storage,
            context,
            record,
            data,
            "verification-requested",
          );
          context.pendingAudit.push({
            actor,
            action: "support.verification",
            channelId: record.id,
            target: record.member,
          });
          context.pending.push({
            type: "conversation.updated",
            channelId: record.id,
            conversationRevision: record.revision,
          });
        }
      } else throw new HttpError(400, "Choose a supported case action.");
    }
  }
  const notesPage = team
    ? await storage.list<SupportNote>({
        prefix: `support-note-v1:${record.id}:`,
        reverse: true,
        limit: 51,
        ...(context.query.get("notesBefore")
          ? {
              end: `support-note-v1:${record.id}:${text(context.query.get("notesBefore"), 80)}`,
            }
          : {}),
      })
    : new Map<string, SupportNote>();
  const notes = [...notesPage.values()];
  const activityPage = team
    ? await storage.list<SupportActivity>({
        prefix: `support-activity-v1:${record.id}:`,
        reverse: true,
        limit: 50,
      })
    : new Map<string, SupportActivity>();
  const workflow: SupportWorkflow = {
    ...(team && !context.isBot && data.lead ? { lead: data.lead } : {}),
    summary: supportSummary(
      data,
      (await storage.get<number>(`support-seen-v1:${record.id}:${actor}`)) ?? 0,
      team ? { record, ...(await teamSummaryInput(storage, context)) } : null,
    ),
    context: readContext(data.context, record.id),
    ...(data.wallet ? { wallet: data.wallet } : {}),
    ...(data.entry ? { entry: data.entry } : {}),
    ...((await currentGuestFollowUp(storage, record.id))?.confirmedAt
      ? { emailNotices: true }
      : {}),
    ...(data.access
      ? {
          access: {
            level: data.access.level,
            ...(data.access.walletUnavailable
              ? { walletUnavailable: true as const }
              : {}),
            ...(team && data.access.claimedWallet
              ? { claimedWallet: data.access.claimedWallet }
              : {}),
            at: iso(data.access.at),
          },
        }
      : {}),
    // Read on every team view, after this request's access checks.
    ...(team && data.appWallet
      ? {
          appWallet: {
            network: data.appWallet.network,
            address: data.appWallet.address,
            authenticatedAt: iso(data.appWallet.authenticatedAt),
          },
        }
      : {}),
    ...(data.verificationRequestedAt && data.access?.level !== "signed"
      ? { verificationRequested: true }
      : {}),
    attachments: team
      ? data.attachments
      : data.attachments.map((attachment) => {
          if (
            attachment.author === record.member ||
            (attachment.author &&
              record.formerMembers?.includes(attachment.author))
          )
            return attachment;
          const { author: _author, ...shown } = attachment;
          return shown;
        }),
    settings: {
      timezone: settings.timezone,
      businessHours: settings.businessHours,
      acknowledgment: settings.acknowledgment,
      ...(team ? { categories: settings.categories } : {}),
    },
    ...(team
      ? {
          notes: notes.slice(0, 50).map((note) =>
            // Worked out when read: the author is a registered AI agent now.
            (context.bots ?? []).includes(note.author)
              ? { ...note, byAgent: true as const }
              : note,
          ),
          notesNextCursor:
            notes.length > 50
              ? [...notesPage.keys()][49].split(":").at(-1)!
              : null,
          activity: [...activityPage.values()],
          presence: data.presence.filter(
            (item) => item.expiresAt > context.now,
          ),
          savedReplies: await savedReplies(storage),
          staff: (await context.supportStaff?.()) ?? [],
          canManage,
          timeSpent: data.timeSpent?.bucket ?? null,
          ai: await (async () => {
            const { aiDefault, effective } = await readAiState(
              storage,
              record,
              data,
            );
            return { ...aiView(
              effective,
              aiDefault,
              (context.registeredBots ?? []).length > 0,
            ), ...(await appAiEnabled(storage, context.mediaEnv, context.room) ? await appAnswerStatus(storage, record.id, context.registeredBots?.length ?? 0) : {}) };
          })(),
        }
      : {}),
  };
  const response = json(
    { workflow, ...extra },
    200,
    noteCommitted ? { "X-Message-Budget-Used": "true" } : undefined,
  );
  if (attachmentCommit) {
    response.headers.set(SUPPORT_MEDIA_COMMIT_ID_HEADER, attachmentCommit.id);
    response.headers.set(
      SUPPORT_MEDIA_COMMIT_BYTES_HEADER,
      String(attachmentCommit.bytes),
    );
  }
  return response;
}

/** The one workflow fact a member's widget reads with each messages page:
 * whether the team asked this member to verify a wallet. It is the member
 * workflow view's own flag, after the same authorization; nothing else of
 * the workflow comes with it. */
export async function memberVerificationRequested(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
) {
  const data = await supportRecord(storage, record);
  return Boolean(
    data.verificationRequestedAt && data.access?.level !== "signed",
  );
}

/** Public edge accepts binary PNG; the authenticated room object receives a
 * bounded internal envelope and writes only a private support object. */
export async function readSupportUpload(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("Content-Type") !== "image/png" ||
    request.headers.has("Content-Encoding")
  )
    throw new HttpError(415, "Choose a PNG screenshot.");
  const bytes = await readBytes(request, SUPPORT_LIMITS.screenshotBytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const query = new URL(request.url).searchParams;
  const requestedId = query.get("clientId")?.toLowerCase();
  if (requestedId && !SUPPORT_ATTACHMENT_ID.test(requestedId))
    throw new HttpError(400, "Send a valid screenshot request id.");
  return {
    action: "attachment",
    contentType: "image/png",
    data: btoa(binary),
    expectedPrincipalId: query.get("expectedPrincipalId"),
    clientId: requestedId ?? crypto.randomUUID(),
  };
}
export const isSupportUpload = (path: string, request: Request) =>
  /^\/conversations\/tc-[0-9a-f]{32}\/workflow$/.test(path) &&
  request.headers.get("Content-Type") === "image/png";
export const SUPPORT_UPLOAD_ENVELOPE_BYTES = 2_900_000;
