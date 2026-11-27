/** Per-request AI mode for support threads: which writes the workspace's
 * registered AI agent may make in one member request ("case").
 *
 * The mode limits registered bots only. It grants nothing, people on the
 * team are never blocked by it, and members never see it. The enforced value
 * is `conversation-v1:<tc>.ai` (`StoredAiControl`), bound to the case it was
 * set in; the case ledger only mirrors changes as metadata.
 *
 * Pure helpers: no storage access. Callers read the conversation record, the
 * support record and the settings, pass what they read, and own the
 * transaction, the writes and every authorization check. */
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  SUPPORT_AI_MODE_CAUSES,
  SUPPORT_AI_MODES,
  SUPPORT_LIMITS,
  type SupportAiMode,
  type SupportAiModeCause,
  type SupportAiView,
} from "@templ/chat/support";
import { HttpError } from "./common";

/** The AI mode a person or a rule chose for one request. Absent or null on
 * the conversation record: the request follows the workspace default. Only
 * `restricted` and `chosen` build it. */
export type StoredAiControl = {
  mode: SupportAiMode;
  /** The case it belongs to: `support-workflow-v1.caseSeq` when it was set,
   * 0 before the thread's first member request. */
  caseSeq: number;
  at: number;
  by: "person" | "rule";
  cause: SupportAiModeCause;
  /** The person, when `by` is "person"; null for a rule. */
  actor: ChatPrincipalId | null;
  /** Changes in this case. Starts again at 1 in a new case. */
  changes: number;
};
/** The mode that applies now. `set` is false while the request follows the
 * workspace default; `control` is the stored value that decided it. */
export type EffectiveAiMode = {
  mode: SupportAiMode;
  set: boolean;
  control: StoredAiControl | null;
};
/** Everything a registered bot can try in a request. */
export type BotAct =
  | "reply"
  | "edit"
  | "reaction"
  | "delete"
  | "typing"
  | "attachment"
  | "status"
  | "claim"
  | "assign"
  | "verify"
  | "handoff"
  | "note"
  | "tags"
  | "presence"
  | "draft";
/** A person's action that restricts the AI, or the new-request rule. */
export type AiRestrictionCause = Exclude<
  SupportAiModeCause,
  "person-set" | "take-over"
>;

/** The `TEMPL_SUPPORT_FAILURE` label for an unreadable workspace default. */
export const AI_DEFAULT_UNREADABLE = "ai-default-unreadable";
const RANK = { answers: 0, drafts: 1, off: 2 } as const;
/** Kept alphabetically; a stored control has exactly these keys. */
const CONTROL_KEYS = [
  "actor",
  "at",
  "by",
  "caseSeq",
  "cause",
  "changes",
  "mode",
];
const AI_MODE_BODY_KEYS = new Set([
  "action",
  "mode",
  "takeOver",
  "expectedPrincipalId",
]);
/** What a bot may still do in "drafts": nothing the member reads, apart
 * from retracting its own message and handing the request to a person. */
const DRAFTS_ALLOWED: ReadonlySet<BotAct> = new Set<BotAct>([
  "delete",
  "handoff",
  "note",
  "tags",
  "presence",
  "draft",
]);

const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAiMode = (value: unknown): value is SupportAiMode =>
  (SUPPORT_AI_MODES as readonly unknown[]).includes(value);
const isAiModeCause = (value: unknown): value is SupportAiModeCause =>
  (SUPPORT_AI_MODE_CAUSES as readonly unknown[]).includes(value);
const iso = (value: number) => new Date(value).toISOString();

/* Errors                                                                  */

/** A registered bot tried a member-facing write in a drafts-only request. */
export function aiDraftsOnlyError(): HttpError {
  return new HttpError(
    409,
    "A person is handling this case. The AI agent can add notes for the team or ask a person to answer. It can't reply to the user.",
    undefined,
    "ai-drafts-only",
  );
}
/** A registered bot tried any write in a request with the AI off. */
export function aiOffError(): HttpError {
  return new HttpError(
    409,
    "AI is off for this case. The AI agent can't reply, write drafts or add notes here.",
    undefined,
    "ai-off",
  );
}
/** A registered bot tried to change the mode. */
export function personOnlyError(): HttpError {
  return new HttpError(
    403,
    "Only a person on the team can change the AI for a case.",
    undefined,
    "person-only",
  );
}
export function invalidAiModeError(): HttpError {
  return new HttpError(
    400,
    "Choose an AI mode: answers, drafts or off.",
    undefined,
    "invalid-ai-mode",
  );
}
export function aiModeLimitError(): HttpError {
  return new HttpError(
    409,
    `The AI setting on this case changed ${SUPPORT_LIMITS.aiModeChangesPerCase} times. It stays as it is until a new case starts.`,
    undefined,
    "ai-mode-limit",
  );
}

/* Stored values and inputs                                                */

/** The stricter of two modes: answers < drafts < off. */
export function stricterAiMode(
  a: SupportAiMode,
  b: SupportAiMode,
): SupportAiMode {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Stored control check for `checkedRecord`: absent, null, or exactly the
 * seven keys with valid codes, naturals, and an actor exactly when a person
 * set it. Anything else makes the conversation record unreadable, the same
 * as a malformed handoff. */
export function checkedAiControl(
  value: unknown,
): value is StoredAiControl | null | undefined {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === CONTROL_KEYS.length &&
    keys.every((key, index) => key === CONTROL_KEYS[index]) &&
    isAiMode(value.mode) &&
    natural(value.caseSeq) &&
    natural(value.at) &&
    natural(value.changes) &&
    isAiModeCause(value.cause) &&
    (value.by === "person"
      ? typeof value.actor === "string" &&
        normalizeChatPrincipal(value.actor) === value.actor
      : value.by === "rule" && value.actor === null)
  );
}

let defaultWarned = false;
/** The workspace default for new requests. Absent: "answers". A stored
 * value that is not a mode reads as "drafts", the safe side for bots, and
 * is logged once per isolate with a fixed label and nothing else. */
export function readAiDefault(
  settings: { aiDefault?: unknown } | null | undefined,
): SupportAiMode {
  const value = isPlainObject(settings) ? settings.aiDefault : undefined;
  if (value === undefined) return "answers";
  if (isAiMode(value)) return value;
  if (!defaultWarned) {
    defaultWarned = true;
    console.error(
      "TEMPL_SUPPORT_FAILURE",
      JSON.stringify({ schemaVersion: 1, label: AI_DEFAULT_UNREADABLE }),
    );
  }
  return "drafts";
}

/** `aiDefault` in a settings save. Absent (undefined) keeps the stored
 * value; a mode is itself; anything else is refused. */
export function parseAiDefault(value: unknown): SupportAiMode | undefined {
  if (value === undefined) return undefined;
  if (isAiMode(value)) return value;
  throw new HttpError(
    400,
    "Choose an AI mode for new cases: answers, drafts or off.",
    undefined,
    "invalid-ai-mode",
  );
}

/** `{action:"ai-mode", mode, takeOver?, expectedPrincipalId?}`. `takeOver`
 * is absent or true, and only with "drafts". Any other key is refused. */
export function parseAiModeBody(body: unknown): {
  mode: SupportAiMode;
  takeOver: boolean;
} {
  if (
    !isPlainObject(body) ||
    body.action !== "ai-mode" ||
    Object.keys(body).some((key) => !AI_MODE_BODY_KEYS.has(key)) ||
    !isAiMode(body.mode) ||
    (body.takeOver !== undefined && body.takeOver !== true) ||
    (body.takeOver === true && body.mode !== "drafts")
  )
    throw invalidAiModeError();
  return { mode: body.mode, takeOver: body.takeOver === true };
}

/* Rules                                                                   */

/** The mode for the thread's current case. A control set in an earlier case
 * no longer applies. When the ledger can't say which case is current (not
 * migrated, or the control names a later case after a rollback), the
 * stricter of the stored mode and the default applies. */
export function effectiveAiMode(
  control: StoredAiControl | null | undefined,
  data: { ledgerVersion?: 1; caseSeq?: number },
  aiDefault: SupportAiMode,
): EffectiveAiMode {
  if (!control) return { mode: aiDefault, set: false, control: null };
  const current =
    data.ledgerVersion === 1 && natural(data.caseSeq) ? data.caseSeq : null;
  if (current === null || control.caseSeq > current)
    return {
      mode: stricterAiMode(control.mode, aiDefault),
      set: true,
      control,
    };
  if (control.caseSeq === current)
    return { mode: control.mode, set: true, control };
  return { mode: aiDefault, set: false, control: null };
}

/** Null when a registered bot may do this in this mode; otherwise the
 * refusal to throw before any write. An unknown mode or act is refused. */
export function botRefusal(mode: SupportAiMode, act: BotAct): HttpError | null {
  if (mode === "answers") return null;
  if (mode === "drafts")
    return DRAFTS_ALLOWED.has(act) ? null : aiDraftsOnlyError();
  return aiOffError();
}

function built(
  e: EffectiveAiMode,
  input: {
    mode: SupportAiMode;
    by: "person" | "rule";
    cause: SupportAiModeCause;
    actor: ChatPrincipalId | null;
    caseSeq: number;
    now: number;
  },
): StoredAiControl {
  const sameCase = e.control !== null && e.control.caseSeq === input.caseSeq;
  const next: StoredAiControl = {
    mode: input.mode,
    caseSeq: input.caseSeq,
    at: input.now,
    by: input.by,
    cause: input.cause,
    actor: input.actor,
    changes: sameCase ? e.control!.changes + 1 : 1,
  };
  // Never hand back a value that would make the conversation unreadable.
  if (!checkedAiControl(next)) throw new Error("Invalid AI mode change.");
  return next;
}

/** A restriction by a person's action or by the new-request rule.
 * - A person's reply, claim, assignment to a person or typing moves
 *   "answers" to "drafts" and changes nothing else (null).
 * - "person-thread" (a new request on a thread a person owns or answered
 *   last) pins the stricter of the default and "drafts" for the new case,
 *   so a later change of the default does not reopen it.
 * Restrictions are never refused: they only keep the bot out. */
export function restricted(
  e: EffectiveAiMode,
  input: {
    cause: AiRestrictionCause;
    by: "person" | "rule";
    actor: ChatPrincipalId | null;
    caseSeq: number;
    now: number;
    aiDefault: SupportAiMode;
  },
): StoredAiControl | null {
  let mode: SupportAiMode;
  if (input.cause === "person-thread") {
    mode = stricterAiMode(stricterAiMode(input.aiDefault, "drafts"), e.mode);
    if (
      e.set &&
      e.control !== null &&
      e.control.caseSeq === input.caseSeq &&
      e.control.mode === mode
    )
      return null;
  } else {
    if (e.mode !== "answers") return null;
    mode = "drafts";
  }
  return built(e, { ...input, mode });
}

/** An explicit choice by a person: a mode picked in the chat header
 * ("person-set") or "Take over from AI" ("take-over", drafts only). Null
 * when the mode would not change; the caller may still clear a handoff for
 * a take over. The 51st change in one case is refused. */
export function chosen(
  e: EffectiveAiMode,
  input: {
    mode: SupportAiMode;
    cause: "person-set" | "take-over";
    actor: ChatPrincipalId;
    caseSeq: number;
    now: number;
  },
): StoredAiControl | null {
  if (
    !isAiMode(input.mode) ||
    (input.cause !== "person-set" && input.cause !== "take-over") ||
    (input.cause === "take-over" && input.mode !== "drafts")
  )
    throw invalidAiModeError();
  if (e.mode === input.mode) return null;
  const changes =
    e.control !== null && e.control.caseSeq === input.caseSeq
      ? e.control.changes
      : 0;
  if (changes >= SUPPORT_LIMITS.aiModeChangesPerCase) throw aiModeLimitError();
  return built(e, { ...input, by: "person" });
}

/** The team's view of the mode. Members never get it. */
export function aiView(
  e: EffectiveAiMode,
  aiDefault: SupportAiMode,
  agentRegistered: boolean,
): SupportAiView {
  const control = e.control;
  return {
    mode: e.mode,
    set: e.set,
    default: aiDefault,
    ...(control
      ? {
          cause: control.cause,
          by: control.by,
          changedAt: iso(control.at),
          ...(control.actor ? { changedBy: control.actor } : {}),
        }
      : {}),
    agentRegistered,
  };
}
