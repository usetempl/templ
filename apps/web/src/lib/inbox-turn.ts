import { PRODUCT_ASK_AFTER_MS } from "@templ/chat/product-catalog";
import type {
  TeamConversation,
  TeamConversationTyping,
} from "@templ/chat/index";
import {
  SUPPORT_HANDOFF_REASONS,
  type SupportHandoffReason,
  type SupportSummary,
  type SupportTurnReason,
} from "@templ/chat/support";
import { copy as t, type MessageKey } from "@/lib/copy";
import { aiDraftModeLabel } from "@/lib/copy/room";
import { escalationChipText } from "@/lib/copy/alerts";

/** Who acts next on a request, in words for people on the team. The worker
 * works out the turn and its reason each time a list or thread is read;
 * these helpers only label them for rows and the thread header. Nothing
 * here grants, blocks or changes anything. */

/** Short handoff reasons for chips. Exhaustive, so a new code fails the
 * type check until it has a label. Reason "person" always reads as the
 * member asking for a person. */
const SHORT_REASON_KEYS: Record<SupportHandoffReason, MessageKey> = {
  quote: "room.turn.reason.quote",
  privacy: "room.turn.reason.privacy",
  account: "room.turn.reason.account",
  billing: "room.turn.reason.billing",
  legal: "room.turn.reason.legal",
  safety: "room.turn.reason.safety",
  transaction: "room.turn.reason.transaction",
  bug: "room.turn.reason.bug",
  person: "room.turn.asked",
  unsure: "room.turn.reason.unsure",
  other: "room.turn.reason.other",
  strategy: "room.turn.reason.strategy",
  access: "room.turn.reason.access",
  recovery: "room.turn.reason.recovery",
  decision: "room.turn.reason.decision",
  internal: "room.turn.reason.internal",
};
export function handoffShortLabel(reason: SupportHandoffReason): string {
  return t(SHORT_REASON_KEYS[reason]);
}
const isReason = (value: unknown): value is SupportHandoffReason =>
  SUPPORT_HANDOFF_REASONS.includes(value as SupportHandoffReason);

const MINUTE = 60_000;
/** Milliseconds since an ISO time; an unreadable or future time reads as 0. */
function elapsed(since: string, now: number) {
  const ms = now - Date.parse(since);
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
/** How long a request has waited, for rows: "<1 min", "14 min", "3 h",
 * "2 d". */
export function waitAge(since: string, now = Date.now()): string {
  const minutes = Math.floor(elapsed(since, now) / MINUTE);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
/** The same for the thread header, which counts seconds in the first
 * minute: "40 s", "14 min", "3 h", "2 d". */
export function headerAge(since: string, now = Date.now()): string {
  const seconds = Math.floor(elapsed(since, now) / 1000);
  return seconds < 60 ? `${seconds} s` : waitAge(since, now);
}
export type WaitTone = "fresh" | "slow" | "late";
/** fresh under 15 minutes, slow up to an hour, late from an hour. */
export function waitTone(since: string, now = Date.now()): WaitTone {
  const ms = elapsed(since, now);
  return ms < 15 * MINUTE ? "fresh" : ms < 60 * MINUTE ? "slow" : "late";
}

type RowFacts = Pick<
  TeamConversation,
  "state" | "support" | "handoff" | "ai" | "confirmation"
>;
/** The team's next step on an open request, from case facts and whose turn
 * it is. A follow-up or provider wait shows on any turn. Replying and
 * checking a transaction are steps only when the request waits on a person;
 * while the team waits on the member, the step is to confirm once the reply
 * has waited the ask window. An AI-handled request has no other step. */
export function nextStep(row: RowFacts, now = Date.now()): string | null {
  if (
    row.state !== "open" ||
    row.support?.state === "resolved" ||
    row.support?.state === "spam"
  )
    return null;
  const support = row.support;
  if (support?.journey?.followUpDue) return t("room.nextStep.followUp");
  const diagnosis = support?.journey?.diagnosisStatus;
  if (diagnosis === "pending" || diagnosis === "disagree")
    return t("room.nextStep.provider");
  const turn = support?.turn;
  if (turn === "ai") return null;
  const repliedAt = support?.lastStaffReplyAt;
  const memberAt = support?.lastMemberMessageAt;
  const teamLast = Boolean(
    repliedAt && (!memberAt || Date.parse(repliedAt) >= Date.parse(memberAt)),
  );
  if (turn === "member" || (turn === undefined && teamLast))
    return teamLast && elapsed(repliedAt!, now) >= PRODUCT_ASK_AFTER_MS
      ? t("room.nextStep.confirm")
      : null;
  if (
    support?.journey?.uncheckedTransaction ||
    (support?.journey?.sharedTransaction && !diagnosis)
  )
    return t("room.nextStep.transaction");
  return t("room.nextStep.reply");
}

/** The words for an open handoff, in rows, the thread header and the
 * handoff banner: "Human requested", "AI handed off: Quote" or "Handed
 * off: Quote". */
export function handoffChip(
  handoff: NonNullable<TeamConversation["handoff"]>,
): string {
  if (handoff.reason === "person" || handoff.by === "member")
    return t("room.turn.asked");
  const reason = handoffShortLabel(
    isReason(handoff.reason) ? handoff.reason : "other",
  );
  return handoff.by === "agent"
    ? t("room.turn.handoffAgent", { reason })
    : t("room.turn.handoffPerson", { reason });
}
/** "AI drafts only" and "AI off" show only when the request differs from
 * the workspace default; a workspace that starts every request in drafts
 * only would otherwise carry the chip on every row. */
const aiDiffers = (row: RowFacts) => !row.ai || row.ai.mode !== row.ai.default;

/** The chip's tone: a request someone asked for or handed over, one the AI
 * should have answered, or a quieter mode note. Text always says it. */
export type ChipTone = "handoff" | "late" | "draft" | "mode";
export type TurnChip = { text: string; tone: ChipTone };
const REASON_TONES: Record<SupportTurnReason, ChipTone> = {
  asked: "handoff",
  "not-solved": "handoff",
  handoff: "handoff",
  "ai-draft": "draft",
  "ai-drafts": "mode",
  "ai-off": "mode",
  "agent-offline": "late",
  "ai-late": "late",
  "no-agent": "mode",
};

function reasonText(
  reason: SupportTurnReason,
  row: RowFacts,
  draftsEnabled: boolean,
): string | null {
  switch (reason) {
    case "not-solved":
      return t("room.turn.notSolved");
    case "asked":
      return t("room.turn.asked");
    case "handoff":
      return handoffChip(row.handoff ?? { at: "", reason: "other" });
    case "ai-draft":
      return t("room.turn.aiDraft");
    case "ai-drafts":
      return aiDiffers(row) ? aiDraftModeLabel(draftsEnabled) : null;
    case "ai-off":
      return aiDiffers(row) ? t("room.turn.aiOff") : null;
    case "agent-offline":
      return t("room.turn.agentOffline");
    case "ai-late":
      return t("room.turn.aiLate");
    default:
      // "no-agent" would be on every row, and a newer code has no label yet.
      return null;
  }
}

/** The workspace's escalation target in minutes, or null when off or not
 * known yet. The inbox loads it once per workspace (inbox-alerts.tsx);
 * it only labels rows and grants nothing. */
let escalationMinutes: number | null = null;
export function setEscalationTarget(minutes: number | null) {
  escalationMinutes =
    typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0
      ? minutes
      : null;
}
/** A request in Needs you that has waited past the escalation target. */
export function pastTarget(
  support: Pick<SupportSummary, "turn" | "waitingSince"> | undefined,
  now = Date.now(),
  minutes = escalationMinutes,
): boolean {
  return (
    minutes !== null &&
    support?.turn === "person" &&
    !!support.waitingSince &&
    elapsed(support.waitingSince, now) >= minutes * MINUTE
  );
}

/** The one reason chip a row shows: why a person must write next, or null.
 * Past the escalation target, "Past your 30 min target" replaces a mode or
 * lateness chip; a handoff keeps its own words. An open row from a service
 * that doesn't say whose turn it is yet reads its handoff and AI mode
 * instead. */
export function turnChip(
  row: RowFacts,
  now = Date.now(),
  draftsEnabled = false,
): TurnChip | null {
  const support = row.support;
  const reason = support?.turnReason;
  if (support?.turn === "person" && reason) {
    const text = reasonText(reason, row, draftsEnabled);
    const chip = text ? { text, tone: REASON_TONES[reason] } : null;
    if (pastTarget(support, now) && chip?.tone !== "handoff")
      return { text: escalationChipText(escalationMinutes!), tone: "late" };
    return chip;
  }
  if (support?.turn || row.state !== "open" || support?.state === "spam")
    return null;
  if (row.handoff) return { text: handoffChip(row.handoff), tone: "handoff" };
  if (row.ai && row.ai.mode !== "answers" && aiDiffers(row))
    return {
      text:
        row.ai.mode === "off"
          ? t("room.turn.aiOff")
          : aiDraftModeLabel(draftsEnabled),
      tone: "mode",
    };
  return null;
}
/** The member's answer to "Did this solve it?", when it tells the team
 * something: "Not solved" on an open request, "Member said solved" on a
 * resolved one. */
export function answerChip(row: RowFacts): string | null {
  const answer = row.confirmation?.answer;
  if (answer === "not-solved" && row.state === "open")
    return t("room.turn.notSolved");
  if (answer === "solved" && row.state === "resolved")
    return t("room.turn.solved");
  return null;
}
/** Who replied last on a request that waits on its member. */
export function repliedChip(
  support: SupportSummary | undefined,
): string | null {
  return support?.lastBy === "agent"
    ? t("room.turn.agentReplied")
    : support?.lastBy === "person"
      ? t("room.turn.teamReplied")
      : null;
}

const resolvedDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export type StateLineValue = { state: string; detail: string };

/** The thread header's state and details: who acts next and since when. */
export function turnLine({
  conversation,
  summary,
  viewer,
  name,
  lastReply,
  typing,
  bannerShown,
  draftsEnabled = false,
  now = Date.now(),
}: {
  conversation: Pick<
    TeamConversation,
    | "state"
    | "handoff"
    | "ai"
    | "confirmation"
    | "assignment"
    | "resolvedBy"
    | "staffMessagesStopped"
  >;
  /** From the thread read, else the details panel's read. */
  summary: SupportSummary | null | undefined;
  viewer: string | undefined;
  name: (principalId: string) => string;
  /** The newest team message on screen; null before any shows. */
  lastReply: { author: string; at: string; agent: boolean } | null;
  typing: TeamConversationTyping;
  /** The handoff banner already says why, so the line leaves it out. */
  bannerShown: boolean;
  draftsEnabled?: boolean;
  now?: number;
}): StateLineValue | null {
  const parts = (...values: (string | null | false | undefined)[]) =>
    values.filter(Boolean).join(", ");
  const line = (state: string, detail = ""): StateLineValue => ({
    state,
    detail: detail ? detail[0].toUpperCase() + detail.slice(1) : "",
  });
  if (conversation.state === "resolved" || summary?.state === "resolved") {
    const at = conversation.resolvedBy?.at;
    const day =
      at && Number.isFinite(Date.parse(at))
        ? t("room.turn.line.resolved", {
            date: resolvedDay.format(new Date(at)),
          })
        : t("room.inbox.resolved");
    return line(
      day,
      parts(
        conversation.confirmation?.answer === "solved" && t("room.turn.solved"),
      ),
    );
  }
  if (summary?.state === "spam") return line(t("room.inbox.spam"));
  const turn = summary?.turn;
  if (!summary || !turn) return null;
  const waiting =
    summary.waitingSince &&
    t("room.turn.line.waiting", {
      age: headerAge(summary.waitingSince, now),
    });
  if (turn === "ai")
    return line(
      t("room.inbox.aiHandling"),
      parts(typing === "agent" ? t("room.turn.line.typing") : waiting),
    );
  if (turn === "person") {
    const owner = conversation.assignment?.principalId;
    const reason = summary.turnReason;
    const chip =
      reason === "no-agent" ||
      (bannerShown && (reason === "asked" || reason === "handoff"))
        ? null
        : turnChip({ ...conversation, support: summary }, now, draftsEnabled)
            ?.text;
    return line(
      owner && owner !== viewer
        ? t("room.turn.line.personOther", { name: name(owner) })
        : t("room.turn.line.person"),
      parts(chip, waiting),
    );
  }
  if (conversation.staffMessagesStopped)
    return line(t("room.inbox.waitingOnMember"), t("room.turn.line.stopped"));
  const who = lastReply
    ? lastReply.author === viewer
      ? t("room.turn.who.you")
      : lastReply.agent
        ? t("room.turn.who.agent")
        : name(lastReply.author)
    : summary.lastBy === "agent"
      ? t("room.turn.who.agent")
      : summary.lastBy === "person"
        ? t("room.turn.who.team")
        : null;
  const at = lastReply ? lastReply.at : summary.lastAt;
  return line(
    t("room.inbox.waitingOnMember"),
    parts(
      who &&
        at &&
        (elapsed(at, now) < MINUTE
          ? t("room.turn.line.repliedNow", { who })
          : t("room.turn.line.replied", { who, age: waitAge(at, now) })),
    ),
  );
}
