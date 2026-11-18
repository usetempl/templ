/** Whether the workspace's AI agent is running: for "AI agent is typing"
 * right after a member's message and for the inbox views by who acts next.
 *
 * It lives only in the room object's memory. It is never stored, exported,
 * logged or sent to members, and an eviction or restart forgets it until the
 * agent's next request. It records when each agent last made a request and
 * nothing about what it read.
 *
 * Only a registered bot that is on the team counts, and only on requests an
 * agent that answers makes: listing its queue (`needs-reply`, `open` or
 * `ai-handling`) and reading or writing a thread. Pulse, status, settings,
 * report, refusals, `needs-person`, search and exports never count, so a bot
 * that only relays alerts never looks like an agent that answers. Memory is
 * not transactional: a request the room refuses still counts, which is right
 * for "the agent is running". */
import type { ChatPrincipalId } from "@templ/chat/principal";
import { SUPPORT_LIMITS, type SupportAiMode } from "@templ/chat/support";

/** Agents remembered per room object. The one seen longest ago goes first. */
export const AGENT_PRESENCE_MAX = 16;
/** List views an answering agent reads as its queue; null is the default
 * list, `open`. */
const QUEUE_FILTERS: ReadonlySet<string | null> = new Set([
  null,
  "open",
  "needs-reply",
  "ai-handling",
]);

/** One conversation route request, as the room routes it. */
export type AgentRequest = {
  /** The named route (status, ask, pulse, report, refusals and so on).
   * Absent for the list and for thread routes. */
  action?: string;
  /** The `tc-` id of a thread route. */
  thread?: string;
  /** The thread's sub-route (messages, typing, workflow, export and so on).
   * Absent for the thread itself. */
  sub?: string;
  /** The list's `filter` query value, or null when it has none. */
  filter?: string | null;
};
/** What the pulse, the lists and the turn read. */
export type AgentState = {
  /** At least one registered AI agent is on the team. */
  registered: boolean;
  /** One of them made a counted request within SUPPORT_LIMITS.agentActiveMs. */
  active: boolean;
  /** Their latest counted request since this room object started, or null. */
  seenAt: number | null;
};

/** Whether an agent that answers members makes this request. */
export function answeringRequest(request: AgentRequest): boolean {
  if (request.thread !== undefined) return request.sub !== "export";
  if (request.action !== undefined) return false;
  return QUEUE_FILTERS.has(request.filter ?? null);
}

export class SupportAgentPresence {
  #seen = new Map<
    ChatPrincipalId,
    { at: number; aliases: readonly ChatPrincipalId[] }
  >();
  /** Counts one request and returns whether it counted: only a registered
   * bot that passed the room's team check, on an answering request. The
   * caller passes the bot's aliases so a registry entry under any of them
   * matches. */
  note(input: {
    principal: ChatPrincipalId | null;
    aliases: readonly ChatPrincipalId[];
    registeredBot: boolean;
    team: boolean;
    request: AgentRequest;
    now: number;
  }): boolean {
    const { principal } = input;
    if (
      !principal ||
      !input.registeredBot ||
      !input.team ||
      !answeringRequest(input.request)
    )
      return false;
    const previous = this.#seen.get(principal);
    this.#seen.delete(principal);
    this.#seen.set(principal, {
      at: Math.max(previous?.at ?? input.now, input.now),
      aliases: [...new Set([principal, ...input.aliases])],
    });
    while (this.#seen.size > AGENT_PRESENCE_MAX)
      this.#seen.delete(this.#seen.keys().next().value!);
    return true;
  }
  /** The state for `bots`: pass the registered bots that pass the current
   * staff check, so an unregistered bot or one that lost its grant stops
   * counting at once. */
  state(bots: readonly ChatPrincipalId[], now: number): AgentState {
    let seenAt: number | null = null;
    for (const entry of this.#seen.values())
      if (
        entry.aliases.some((alias) => bots.includes(alias)) &&
        (seenAt === null || entry.at > seenAt)
      )
        seenAt = entry.at;
    return {
      registered: bots.length > 0,
      active:
        bots.length > 0 &&
        seenAt !== null &&
        now - seenAt <= SUPPORT_LIMITS.agentActiveMs,
      seenAt,
    };
  }
  get size() {
    return this.#seen.size;
  }
}

/** Whether a member's read shows "AI agent is typing" before the agent's own
 * mark: the workspace's AI agent is running and would pick this message up.
 * Pure; the caller computes it only for the thread's member reading the
 * newest page, and only after the agent's real marks show nothing. It
 * reveals nothing the agent's own mark wouldn't show seconds later: no
 * identity, mode or count. */
export function agentPickup(input: {
  now: number;
  /** The thread's newest message. */
  newest: { author: string; createdAt: number } | null;
  /** The member and their former principals. */
  memberSide: readonly string[];
  /** A handoff is open. */
  handoff: boolean;
  /** The effective AI mode of the current request. */
  mode: SupportAiMode;
  /** A person holds the request. */
  assigned: boolean;
  /** The member stopped team messages. */
  stopped: boolean;
  /** The request is resolved or marked spam. */
  closed: boolean;
  /** The thread is Templ's hourly check. */
  canary: boolean;
  /** `SupportAgentPresence.state(...).active` for the bots that pass the
   * current staff check. */
  present: boolean;
}): boolean {
  const { newest } = input;
  return (
    input.present &&
    newest !== null &&
    input.memberSide.includes(newest.author) &&
    input.now - newest.createdAt <= SUPPORT_LIMITS.agentPickupMs &&
    !input.handoff &&
    input.mode === "answers" &&
    !input.assigned &&
    !input.stopped &&
    !input.closed &&
    !input.canary
  );
}
