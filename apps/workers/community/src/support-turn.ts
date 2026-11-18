/** Who acts next on a support request: a person, the AI agent or the
 * member. Worked out when read, for team views only. The turn grants
 * nothing, blocks nothing and changes no AI mode, handoff, assignment or
 * usage; the handoff and AI mode rules decide what a bot may do.
 *
 * Pure helpers: callers pass what they read. */
import {
  SUPPORT_LIMITS,
  type SupportAiMode,
  type SupportHandoffReason,
  type SupportState,
  type SupportTurn,
  type SupportTurnReason,
} from "@templ/chat/support";
import type { AgentState } from "./support-agent-presence";

export type TurnView = { turn: SupportTurn; reason?: SupportTurnReason };
export type Speaker = { by: "member" | "person" | "agent"; at: number };

/** The turn of one request, or null when it is resolved or spam.
 * - member: nobody waits on the team (the team or the AI agent replied
 *   last, the request is waiting on the member, the member stopped team
 *   messages, or it is outreach with no member request);
 * - person: the member asked for a person, the member said not solved,
 *   another handoff is open, the AI is in drafts only or off, no AI agent is
 *   active, or the wait is older than SUPPORT_LIMITS.aiReplyGraceMs;
 * - ai: otherwise.
 * A "person" turn carries the reason for the next person's reply. */
export function supportTurn(input: {
  state: SupportState;
  /** When the current wait for a reply started, or null. */
  awaitingSince: number | null;
  /** The open handoff's reason, or null when none is open. */
  handoffReason: SupportHandoffReason | null;
  /** The member declined the latest team answer. */
  notSolved?: boolean;
  /** The effective AI mode of the current request. */
  aiMode: SupportAiMode;
  /** The newest note a registered AI agent added, or null. */
  agentDraftAt: number | null;
  agent: AgentState;
  now: number;
}): TurnView | null {
  if (input.state === "resolved" || input.state === "spam" || input.state === "abandoned") return null;
  const since = input.awaitingSince;
  if (since === null) return { turn: "member" };
  // The member's own request for a person is their newest word and keeps
  // the AI from answering, so it names the wait even after a "No".
  if (input.handoffReason === "person") return { turn: "person", reason: "asked" };
  if (input.notSolved) return { turn: "person", reason: "not-solved" };
  if (input.handoffReason !== null) return { turn: "person", reason: "handoff" };
  if (input.aiMode === "drafts")
    return {
      turn: "person",
      reason:
        input.agentDraftAt !== null && input.agentDraftAt >= since
          ? "ai-draft"
          : "ai-drafts",
    };
  if (input.aiMode !== "answers") return { turn: "person", reason: "ai-off" };
  const { agent } = input;
  if (!agent.registered || !agent.active)
    return {
      turn: "person",
      // Offline only for an agent this room has seen: a relay-only or
      // unregistered bot, or a room that just started, is never nagged.
      reason:
        agent.registered && agent.seenAt !== null
          ? "agent-offline"
          : "no-agent",
    };
  if (input.now - since > SUPPORT_LIMITS.aiReplyGraceMs)
    return { turn: "person", reason: "ai-late" };
  return { turn: "ai" };
}

/** Who wrote the latest message, from the support record's times and the
 * conversation's `lastMessageAt`. Bots never set `lastStaffReplyAt`, so on
 * a record written before `lastAgentReplyAt` existed, a `lastMessageAt`
 * newer than the member's and the person's times is the AI agent's. Ties go
 * to the member, then the person. */
export function lastSpeaker(
  data: {
    lastMemberMessageAt: number | null;
    lastStaffReplyAt: number | null;
    lastAgentReplyAt?: number | null;
  },
  lastMessageAt: number | null,
): Speaker | null {
  const member = data.lastMemberMessageAt;
  const person = data.lastStaffReplyAt;
  const agent =
    data.lastAgentReplyAt !== undefined
      ? data.lastAgentReplyAt
      : lastMessageAt !== null &&
          lastMessageAt > Math.max(member ?? -1, person ?? -1)
        ? lastMessageAt
        : null;
  let latest: Speaker | null = null;
  for (const [by, at] of [
    ["member", member],
    ["person", person],
    ["agent", agent],
  ] as const)
    if (at !== null && (latest === null || at > latest.at)) latest = { by, at };
  return latest;
}
