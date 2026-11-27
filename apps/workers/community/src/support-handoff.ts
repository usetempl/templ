import type { ChatMessage, TeamConversation } from "@templ/chat/index";
import {
  SUPPORT_HANDOFF_REASONS,
  type SupportAiMode,
  type SupportHandoffBy,
  type SupportHandoffReason,
  type SupportState,
} from "@templ/chat/support";
import { HttpError } from "./common";
import { messageKey } from "./message-store";

/** Handoff and "Did this solve it?" state on `conversation-v1:<tc>`, plus
 * the `ifLatest` check for conditional replies. Pure helpers: the caller
 * owns the transaction, the record write and every authorization check. */
type Storage = Pick<DurableObjectTransaction, "get">;

/** A person must answer this request. One handoff per member request.
 * `by` "member" is the member's own "Talk to a person". */
export type StoredHandoff = {
  at: number;
  reason: SupportHandoffReason;
  by: SupportHandoffBy;
  /** SupportRecord.requestedAt when it was handed off. */
  requestAt: number;
};
/** "Did this solve it?" for the latest team resolution. */
export type StoredConfirmation = {
  askedAt: number;
  answer: "solved" | "not-solved" | null;
  answeredAt: number | null;
};
/** The latest message a writer read: its decimal id and revision. */
export type IfLatest = { id: string; revision: number };
export type HandoffBody = {
  reason: SupportHandoffReason;
  ifLatest: IfLatest | null;
};

const HANDOFF_KEYS = new Set([
  "appAnswer",
  "action",
  "reason",
  "ifLatest",
  "expectedPrincipalId",
]);
const ASK_PERSON_KEYS = new Set(["action", "expectedPrincipalId"]);
const HANDOFF_BY: readonly SupportHandoffBy[] = ["agent", "person", "member"];
const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (value: number) => new Date(value).toISOString();
const isReason = (value: unknown): value is SupportHandoffReason =>
  (SUPPORT_HANDOFF_REASONS as readonly unknown[]).includes(value);
const REASON_LIST = `${SUPPORT_HANDOFF_REASONS.slice(0, -1).join(", ")} or ${SUPPORT_HANDOFF_REASONS.at(-1)}`;

const invalidHandoff = (message: string) =>
  new HttpError(400, message, undefined, "invalid-handoff");

/** `{action:"handoff", reason, ifLatest?}`. Any other key, such as a text or
 * summary, is refused: details belong in an internal note. */
export function parseHandoffBody(body: unknown): HandoffBody {
  if (
    !isPlainObject(body) ||
    body.action !== "handoff" ||
    Object.keys(body).some((key) => !HANDOFF_KEYS.has(key))
  )
    throw invalidHandoff(
      "A handoff takes a reason code only. Put details in an internal note.",
    );
  if (!isReason(body.reason))
    throw invalidHandoff(`Choose a handoff reason: ${REASON_LIST}.`);
  return { reason: body.reason, ifLatest: parseIfLatest(body.ifLatest) };
}

/** Absent means no condition. Otherwise exactly `{id, revision}` with a
 * decimal message id and a positive revision. */
export function parseIfLatest(value: unknown): IfLatest | null {
  if (value === undefined) return null;
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.id !== "string" ||
    !MESSAGE_ID.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  )
    throw new HttpError(400, "Send a valid ifLatest.");
  return { id: value.id, revision: value.revision as number };
}

/** Refuses a conditional write when the thread's latest message is not the
 * one the writer read: a newer message, an edit, or a deleted latest row.
 * Pass the support storage wrapper so partitioned rows resolve. Writes
 * nothing, so it must run before any write of the request. */
export async function assertLatest(
  storage: Storage,
  conversationId: string,
  ifLatest: IfLatest | null,
): Promise<void> {
  if (!ifLatest) return;
  const latest =
    (await storage.get<number>(`channel-sequence:${conversationId}`)) ?? 0;
  const row = natural(latest)
    ? await storage.get<ChatMessage>(messageKey(conversationId, latest))
    : undefined;
  if (
    !natural(latest) ||
    String(latest) !== ifLatest.id ||
    !row ||
    (row.revision ?? 1) !== ifLatest.revision
  )
    throw new HttpError(
      409,
      "A newer message arrived. Read the case again before replying.",
      undefined,
      "stale",
    );
}

/** Stored handoff check for `checkedRecord`: absent, null, or a complete
 * value. Anything else makes the record unreadable. */
export function checkedHandoff(
  value: unknown,
): value is StoredHandoff | null | undefined {
  if (value === undefined || value === null) return true;
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 4 &&
    natural(value.at) &&
    natural(value.requestAt) &&
    isReason(value.reason) &&
    (HANDOFF_BY as readonly unknown[]).includes(value.by)
  );
}

/** Stored confirmation check for `checkedRecord`: absent, null, asked and
 * unanswered, or answered with its time. */
export function checkedConfirmation(
  value: unknown,
): value is StoredConfirmation | null | undefined {
  if (value === undefined || value === null) return true;
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 3 ||
    !natural(value.askedAt)
  )
    return false;
  if (value.answer === null) return value.answeredAt === null;
  return (
    (value.answer === "solved" || value.answer === "not-solved") &&
    natural(value.answeredAt)
  );
}

/** A registered bot tried to act on a request waiting for a person. The
 * member's own request stays open until a person replies or resolves it
 * (see `clearsHandoff`), so its text doesn't mention taking the request. */
export function handedOffError(
  handoff?: Pick<StoredHandoff, "by" | "reason"> | null,
): HttpError {
  return new HttpError(
    409,
    handoff?.by === "member" || handoff?.reason === "person"
      ? "The user asked for a person. A person from the team needs to answer this case."
      : "A person from the team needs to answer this case. A person must reply, take the case or resolve it before the AI agent can reply again.",
    undefined,
    "handed-off",
  );
}

/** A person's action that may end an open handoff: a reply, a resolution
 * (or spam), taking the request, assigning it, "Take over from AI" or "Let
 * AI answer". */
export type HandoffClearing =
  | "reply"
  | "resolve"
  | "claim"
  | "assign"
  | "take-over"
  | "ai-answers";
/** Person requests stay open until a human reply or resolution, even when AI
 * recognized the request. Other handoffs also clear on human assignment or AI
 * control. Taking over, claiming and assigning keep AI in drafts. */
export function clearsHandoff(
  handoff: StoredHandoff | null | undefined,
  by: HandoffClearing,
): boolean {
  if (!handoff) return false;
  return (
    by === "reply" ||
    by === "resolve" ||
    (handoff.by !== "member" && handoff.reason !== "person")
  );
}

/** Members learn when it was handed off and who asked (the AI agent, a
 * person or they themselves), so the chat can say what happens next; the
 * team also sees the reason. */
export function handoffView(
  handoff: StoredHandoff | null | undefined,
  role: "member" | "team",
): TeamConversation["handoff"] {
  if (!handoff) return null;
  return role === "member"
    ? { at: iso(handoff.at), by: handoff.by }
    : { at: iso(handoff.at), reason: handoff.reason, by: handoff.by };
}

/* "Talk to a person": the member's own handoff                            */

/** `{action:"ask-person"}`, plus the widget's `expectedPrincipalId`. Any
 * other key is refused. */
export function parseAskPersonBody(body: unknown): void {
  if (
    !isPlainObject(body) ||
    body.action !== "ask-person" ||
    Object.keys(body).some((key) => !ASK_PERSON_KEYS.has(key))
  )
    throw invalidHandoff("Send only the action.");
}

type AskPersonRefusal =
  | "stopped"
  | "handoff-resolved"
  | "handoff-no-request"
  | "member-only";
const ASK_PERSON_REFUSALS: Record<
  AskPersonRefusal,
  { status: number; message: string }
> = {
  stopped: {
    status: 409,
    message:
      "You stopped team messages. Ask the team again to turn them back on.",
  },
  "handoff-resolved": {
    status: 409,
    message: "This case is closed. Send a message to open it again.",
  },
  "handoff-no-request": { status: 409, message: "Send your question first." },
  "member-only": {
    status: 403,
    message: "Only the user who asked can request a person.",
  },
};
/** The member-facing refusal for "Talk to a person". `member-only` is for
 * the team and registered bots; anyone else gets the usual 404. */
export function askPersonError(reason: AskPersonRefusal): HttpError {
  const { status, message } = ASK_PERSON_REFUSALS[reason];
  return new HttpError(status, message, undefined, reason);
}

/** What the member's "Talk to a person" does to this request. The caller
 * has already checked that the viewer is the thread's member and passed the
 * usual write gates (support workflow, ban and mute); it owns the write,
 * which clears the bots' typing marks. Checks run in this order and write
 * nothing: a stopped thread, a closed request, a thread with no member
 * request. With no open handoff the result is a new one with the reason
 * "person" (`opened`: the caller records the activity, the ledger entry and
 * the alert). A handoff the AI agent or a person opened, which may have
 * landed just before the member's tap, becomes the member's own: `by` turns
 * "member" and its time, reason and request stay, so only a person's reply
 * or a resolution clears it (`clearsHandoff`); the caller stores it and
 * sends no new alert. Repeating the action on the member's own handoff
 * changes nothing. None of it posts a message or counts anything. */
export function askPersonHandoff(input: {
  stopped: boolean;
  /** `conversation-v1` state. */
  conversationState: "open" | "resolved";
  /** `support-workflow-v1` state. */
  supportState: SupportState;
  /** `support-workflow-v1.requestedAt`. */
  requestedAt: number | null;
  current: StoredHandoff | null | undefined;
  now: number;
}): { handoff: StoredHandoff; changed: boolean; opened: boolean } {
  if (input.stopped) throw askPersonError("stopped");
  if (
    input.conversationState === "resolved" ||
    input.supportState === "resolved" ||
    input.supportState === "spam"
  )
    throw askPersonError("handoff-resolved");
  if (input.requestedAt === null) throw askPersonError("handoff-no-request");
  const { current } = input;
  if (current)
    return current.by === "member"
      ? { handoff: current, changed: false, opened: false }
      : {
          handoff: { ...current, by: "member" },
          changed: true,
          opened: false,
        };
  return {
    handoff: {
      at: input.now,
      reason: "person",
      by: "member",
      requestAt: input.requestedAt,
    },
    changed: true,
    opened: true,
  };
}

/** A person tried "Let AI answer" while the member's own request for a
 * person is open. Taking over, claiming, assigning, replying and resolving
 * stay allowed; after a person replies the AI can be let back in. */
export function memberAskedError(): HttpError {
  return new HttpError(
    409,
    "The user asked for a person. Reply to them before you let the AI answer.",
    undefined,
    "member-asked",
  );
}
/** Refuses AI answers until a person replies to the member's request for a
 * person. Other handoff reasons and AI modes pass. */
export function assertAiAnswersAllowed(
  mode: SupportAiMode,
  handoff: StoredHandoff | null | undefined,
): void {
  if (
    mode === "answers" &&
    (handoff?.by === "member" || handoff?.reason === "person")
  )
    throw memberAskedError();
}

export function confirmationView(
  confirmation: StoredConfirmation | null | undefined,
): TeamConversation["confirmation"] {
  if (!confirmation) return null;
  return {
    askedAt: iso(confirmation.askedAt),
    answer: confirmation.answer,
    answeredAt:
      confirmation.answeredAt === null ? null : iso(confirmation.answeredAt),
  };
}
