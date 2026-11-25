import type {
  ChatMessage,
  ChatRoomId,
  TeamConversation,
  TeamConversationFilter,
  TeamConversationList,
  TeamConversationMessages,
  TeamConversationStatus,
} from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  SUPPORT_AI_MODES,
  SUPPORT_HANDOFF_REASONS,
  SUPPORT_TIME_SPENT,
  type SupportAiMode,
  type SupportContextInput,
  type SupportHandoffBy,
  type SupportHandoffReason,
  type SupportTimeSpent,
  type SupportWorkflow,
} from "@templ/chat/support";
import type {
  SupportCaseDetail,
  SupportCaseList,
  SupportDraft,
  SupportDraftRequestView,
} from "@templ/chat/support-drafts";
import type {
  SupportCaseFrame,
  SupportEvidence,
  SupportFrameField,
} from "@templ/chat/support-evidence";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "./community-client";
import { chatMutation } from "./chat-api";
import { copy, type MessageKey, type Params } from "@/lib/copy";
export const CONVERSATION_ID = /^tc-[0-9a-f]{32}$/;

export function readConversationStatus(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<TeamConversationStatus> {
  return communityFetch<TeamConversationStatus>(
    roomPath(room, "conversations/status"),
    undefined,
    signal,
  );
}
export function listConversations(
  room: ChatRoomId,
  filter: TeamConversationFilter,
  cursor?: string | null,
  signal?: AbortSignal,
  filters: Partial<
    Record<
      "member" | "assignee" | "tag" | "category" | "after" | "before",
      string
    >
  > = {},
): Promise<TeamConversationList> {
  const query = new URLSearchParams({ filter });
  if (cursor) query.set("cursor", cursor);
  for (const [key, value] of Object.entries(filters))
    if (value) query.set(key, value);
  return communityFetch<TeamConversationList>(
    roomPath(room, `conversations?${query}`),
    undefined,
    signal,
  );
}
export function readConversationMessages(
  room: ChatRoomId,
  id: string,
  options: { before?: string | null; limit?: number; seen?: boolean } = {},
  signal?: AbortSignal,
): Promise<TeamConversationMessages> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.before) query.set("before", options.before);
  // The newest page read with the thread on screen: the member has seen the
  // team's replies. The room records it for the member only.
  else if (options.seen) query.set("seen", "1");
  return communityFetch<TeamConversationMessages>(
    roomPath(room, `conversations/${conversationId(id)}/messages?${query}`),
    undefined,
    signal,
  );
}
/** Opens the caller’s thread and admits public visitors on this action.
 * Private communities still require an accepted invitation. Clears the
 * caller’s stop preference when they ask again. */
export function askTeam(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  input: {
    text?: string;
    clientId?: string;
    context?: SupportContextInput;
    contextConsent?: boolean;
  } = {},
  assertCurrent?: () => void,
): Promise<{ conversation: TeamConversation; message?: ChatMessage }> {
  return chatMutation(
    account,
    roomPath(room, "conversations/ask"),
    input,
    assertCurrent,
  );
}
/** The team resolves or reopens; a member may reopen their own. The team
 * may record how long the request took, only when resolving. */
export function resolveConversation(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  resolved: boolean,
  options: {
    timeSpent?: SupportTimeSpent;
    category?: string;
    ifRevision?: number;
    assertCurrent?: () => void;
  } = {},
): Promise<{ conversation: TeamConversation }> {
  const body: Record<string, unknown> = { resolved };
  if (resolved && options.category) body.category = options.category;
  if (options.ifRevision !== undefined) {
    if (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 0)
      throw new Error("Include the case revision.");
    body.ifRevision = options.ifRevision;
  }
  if (options.timeSpent !== undefined) {
    if (!resolved || !SUPPORT_TIME_SPENT.includes(options.timeSpent))
      throw new Error("Record time spent only when resolving.");
    body.timeSpent = options.timeSpent;
  }
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/resolve`),
    body,
    options.assertCurrent,
  );
}
/** The thread's member asks for a person. It posts no message, counts
 * nothing and, while a handoff is open, changes nothing. */
export function askPerson(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
): Promise<{ handoff?: { at: string; by?: SupportHandoffBy } | null }> {
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/workflow`),
    { action: "ask-person" },
  );
}
/** A person on the team hands the request to a person, with a fixed reason
 * code and no text. Details belong in an internal note. */
export function handOffConversation(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  reason: SupportHandoffReason,
): Promise<{ workflow: SupportWorkflow }> {
  if (!SUPPORT_HANDOFF_REASONS.includes(reason))
    throw new Error("Choose a handoff reason.");
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/workflow`),
    { action: "handoff", reason },
  );
}
/** A person on the team sets the AI mode of this request. `takeOver` is
 * "Take over from AI" and goes only with "drafts". Counts nothing. */
export function setAiMode(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  input: { mode: SupportAiMode; takeOver?: true },
): Promise<{ workflow: SupportWorkflow }> {
  if (!SUPPORT_AI_MODES.includes(input.mode))
    throw new Error("Choose an AI mode.");
  if (input.takeOver && input.mode !== "drafts")
    throw new Error("Choose AI drafts only to take over.");
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/workflow`),
    {
      action: "ai-mode",
      mode: input.mode,
      ...(input.takeOver ? { takeOver: true } : {}),
    },
  );
}
/** Generate one reply for the current unanswered member message. */
export function generateAppAnswer(account: ChatPrincipalId | undefined, room: ChatRoomId, id: string): Promise<{ workflow: SupportWorkflow }> {
  return chatMutation(account, roomPath(room, `conversations/${conversationId(id)}/workflow`), { action: "ai-answer" });
}
/** Shows the member that a person is writing. The mark holds no text and
 * lapses about 12 seconds after the service accepts it. */
export async function markTeamTyping(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
): Promise<void> {
  try {
    await chatMutation(
      account,
      roomPath(room, `conversations/${conversationId(id)}/typing`),
      {},
    );
  } catch (reason) {
    // An accepted mark answers 204 with no body to read.
    if (!(reason instanceof SyntaxError)) throw reason;
  }
}
/** Claims the conversation for the signed-in staff account, never another account. */
export function claimConversation(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  takeover = false,
  assertCurrent?: () => void,
): Promise<{ conversation: TeamConversation }> {
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/claim`),
    takeover ? { takeover: true } : {},
    assertCurrent,
  );
}
export function releaseConversationClaim(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  assertCurrent?: () => void,
): Promise<{ conversation: TeamConversation }> {
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/release`),
    {},
    assertCurrent,
  );
}
/** The fixed member only. */
export function stopTeamMessages(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  stopped: boolean,
  assertCurrent?: () => void,
): Promise<{ conversation: TeamConversation }> {
  return chatMutation(
    account,
    roomPath(room, `conversations/${conversationId(id)}/stop`),
    { stopped },
    assertCurrent,
  );
}
function conversationId(value: string) {
  if (!CONVERSATION_ID.test(value)) throw new Error("Invalid case.");
  return value;
}
/** The safe reason behind a refused write, from the worker's `reason` field. */
export function conversationErrorReason(reason: unknown): string | null {
  if (!(reason instanceof CommunityApiError)) return null;
  const details = reason.details as { reason?: unknown } | undefined;
  return typeof details?.reason === "string" ? details.reason : null;
}
/** `t` for the plain helpers here; the English text when a caller passes none. */
type CopyFormatter = (key: MessageKey, params?: Params) => string;
const MEMBER_ERRORS: Partial<Record<string, MessageKey>> = {
  stopped: "room.member.errorAskStopped",
  cap: "room.team.errorRefused",
  "support-capacity": "room.team.errorRefused",
  "support-message-capacity": "room.team.errorRefused",
  "handoff-resolved": "room.member.errorAskResolved",
  "handoff-no-request": "room.member.errorAskNoRequest",
};
const TEAM_ERRORS: Partial<Record<string, MessageKey>> = {
  stopped: "room.team.errorStopped",
  cap: "room.team.errorCap",
  "support-paused": "room.team.errorPaused",
  "support-message-capacity": "room.team.errorMessageLimit",
  "handed-off": "room.team.errorHandedOff",
  stale: "room.team.errorStale",
  "handoff-resolved": "room.team.errorHandoffResolved",
  "handoff-no-request": "room.team.errorHandoffNoRequest",
  "ai-mode-limit": "room.ai.limit",
  "member-asked": "room.ai.memberAsked",
  "no-agent": "room.askAi.noAgent",
  "ai-off": "room.askAi.off",
  "draft-pending": "room.askAi.busy",
  "draft-request-limit": "room.askAi.limit",
  "draft-queue-full": "room.askAi.queueFull",
  "frame-stale": "room.case.stale",
};
/** Plain-language messages for the states section 8A names, worded for the
 * person who reads them: a member never sees the team's plan or limits. A
 * thrown message that is none of them is shown as it came. */
export function conversationErrorMessage(
  reason: unknown,
  t: CopyFormatter = copy,
  viewer: "member" | "team" = "team",
): string {
  const code = conversationErrorReason(reason);
  const key = code
    ? (viewer === "member" ? MEMBER_ERRORS : TEAM_ERRORS)[code]
    : undefined;
  if (key) return t(key);
  if (code === "history-capacity") return t("room.team.errorHistoryFull");
  if (code === "quota") return t("room.team.errorQuota");
  if (reason instanceof CommunityApiError && reason.status === 404)
    return t("room.team.errorUnavailable");
  if (reason instanceof CommunityApiError && reason.status === 503)
    return t("room.team.errorClosed");
  return reason instanceof Error ? reason.message : t("room.team.errorGeneric");
}

export function readSupportWorkflow(
  room: ChatRoomId,
  id: string,
  signal?: AbortSignal,
  notesBefore?: string,
  priorityOpen = false,
) {
  const query = new URLSearchParams();
  if (notesBefore) query.set("notesBefore", notesBefore);
  if (priorityOpen) query.set("priorityOpen", "1");
  return communityFetch<{ workflow: SupportWorkflow }>(
    roomPath(
      room,
      `conversations/${conversationId(id)}/workflow${query.size ? `?${query}` : ""}`,
    ),
    undefined,
    signal,
  );
}
export function updateSupportWorkflow(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  body: Record<string, unknown>,
) {
  return chatMutation<{ workflow: SupportWorkflow }>(
    account,
    roomPath(room, `conversations/${conversationId(id)}/workflow`),
    body,
  );
}

/* ---------------------------------------------------------------------- */
/* Cases, evidence and Ask AI (team only)                                  */
/* ---------------------------------------------------------------------- */

/** A thread's member requests, newest first, 20 per page. */
export function readCases(
  room: ChatRoomId,
  id: string,
  before?: number | null,
  signal?: AbortSignal,
): Promise<SupportCaseList> {
  const query = before ? `?before=${before}` : "";
  return communityFetch<SupportCaseList>(
    roomPath(room, `conversations/${conversationId(id)}/cases${query}`),
    undefined,
    signal,
  );
}
/** One request's frame, evidence rows, AI drafts and Ask AI questions. */
export function readCase(
  room: ChatRoomId,
  id: string,
  seq: number,
  signal?: AbortSignal,
): Promise<SupportCaseDetail> {
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw new Error("Invalid request.");
  return communityFetch<SupportCaseDetail>(
    roomPath(room, `conversations/${conversationId(id)}/cases?seq=${seq}`),
    undefined,
    signal,
  );
}
function workflowAction<T>(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  body: Record<string, unknown>,
) {
  return chatMutation<T>(
    account,
    roomPath(room, `conversations/${conversationId(id)}/workflow`),
    body,
  );
}
/** Saves request details. `ifRevision` refuses the save (409 frame-stale)
 * when someone changed them since they were read. */
export function saveCaseFrame(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  input: {
    case: number;
    set?: Record<string, unknown>;
    clear?: SupportFrameField[];
    ifRevision?: number;
  },
): Promise<{ frame: SupportCaseFrame }> {
  return workflowAction(account, room, id, { action: "frame", ...input });
}
/** Adds evidence rows to a request. A retry with the same clientId returns
 * the rows it added. */
export function addCaseEvidence(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  input: { case: number; clientId: string; rows: Record<string, unknown>[] },
): Promise<{ evidence: SupportEvidence[] }> {
  return workflowAction(account, room, id, { action: "evidence", ...input });
}
/** Withdraws row `n`; it stays visible and marked. */
export function withdrawCaseEvidence(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  input: { case: number; n: number },
): Promise<{ evidence: SupportEvidence }> {
  return workflowAction(account, room, id, {
    action: "withdraw-evidence",
    ...input,
  });
}
/** Asks the workspace's AI agent for a draft of the current request. */
export function askAi(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  input: { clientId: string; instruction?: string },
): Promise<{ request: SupportDraftRequestView }> {
  return workflowAction(account, room, id, {
    action: "draft-request",
    clientId: input.clientId,
    ...(input.instruction?.trim()
      ? { instruction: input.instruction.trim() }
      : {}),
  });
}
export function cancelAiDraft(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  request: string,
): Promise<{ request: SupportDraftRequestView }> {
  return workflowAction(account, room, id, { action: "draft-cancel", request });
}
export function dismissAiDraft(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  draft: string,
): Promise<{ draft: SupportDraft | null }> {
  return workflowAction(account, room, id, { action: "draft-dismiss", draft });
}
