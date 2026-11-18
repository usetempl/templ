/** Content-free "a reply is being written" marks on support threads.
 *
 * A mark says only that one team principal (a person or the workspace's
 * registered bot) is writing in one thread. It carries no text and lives in
 * the room object's memory: never in storage, the transcript, events,
 * exports or search. An eviction or restart drops every mark, and each mark
 * expires on its own, so a stale one can never outlive TYPING_TTL_MS.
 *
 * Callers authorize before marking; this module only keeps time. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { TeamConversationTyping } from "@templ/chat/index";
import { SupportAgentPresence } from "./support-agent-presence";

/** A mark lasts this long after its last accepted update. */
export const TYPING_TTL_MS = 12_000;
/** One accepted update per principal per thread in this window; extra calls
 * are coalesced and leave the current expiry unchanged. */
export const TYPING_PACE_MS = 2_000;
/** Bounded memory per room object. The oldest mark goes first. */
export const TYPING_MAX_MARKS = 512;

type Mark = {
  thread: string;
  principal: ChatPrincipalId;
  aliases: readonly ChatPrincipalId[];
  markedAt: number;
  until: number;
};
const key = (thread: string, principal: string) => `${thread}\n${principal}`;

export class SupportTyping {
  #marks = new Map<string, Mark>();
  /** When the workspace's AI agents last made an answering request, in the
   * same memory-only room state, so it reaches every conversation route
   * with the typing marks. */
  readonly presence = new SupportAgentPresence();
  #prune(now: number) {
    for (const [id, mark] of this.#marks)
      if (mark.until <= now) this.#marks.delete(id);
  }
  /** Returns false when the call was coalesced into a recent update. */
  mark(
    thread: string,
    principal: ChatPrincipalId,
    aliases: readonly ChatPrincipalId[],
    now: number,
  ): boolean {
    this.#prune(now);
    const id = key(thread, principal);
    const current = this.#marks.get(id);
    if (current && now - current.markedAt < TYPING_PACE_MS) return false;
    this.#marks.delete(id);
    this.#marks.set(id, {
      thread,
      principal,
      aliases: [...new Set([principal, ...aliases])],
      markedAt: now,
      until: now + TYPING_TTL_MS,
    });
    while (this.#marks.size > TYPING_MAX_MARKS)
      this.#marks.delete(this.#marks.keys().next().value!);
    return true;
  }
  /** A posted reply ends its author's mark, under any of their aliases. */
  clear(thread: string, aliases: readonly ChatPrincipalId[]) {
    for (const alias of aliases) this.#marks.delete(key(thread, alias));
  }
  /** Unexpired marks on a thread, newest last. */
  live(thread: string, now: number) {
    this.#prune(now);
    return [...this.#marks.values()]
      .filter((mark) => mark.thread === thread)
      .map((mark) => ({ principal: mark.principal, aliases: mark.aliases }));
  }
  get size() {
    return this.#marks.size;
  }
}

/** What a thread reader may learn: "agent" while the workspace's registered
 * bot is writing, "team" while another current staff member is writing,
 * otherwise null. A person outranks the bot. Never an identity or a count.
 * Each typer's access is checked again here, so a revoked grant or an
 * unregistered bot stops showing at once instead of at expiry. */
export async function typingView(
  marks: SupportTyping | undefined,
  input: {
    thread: string;
    now: number;
    /** The reader's own aliases; their marks are not shown to them. */
    reader: readonly ChatPrincipalId[];
    /** Retained AI identities, for the agent label. */
    bots: readonly ChatPrincipalId[];
    /** Current registration, for typing availability. */
    registeredBots: readonly ChatPrincipalId[];
    isStaff: (principal: ChatPrincipalId) => Promise<boolean>;
  },
): Promise<TeamConversationTyping> {
  if (!marks) return null;
  let agent = false;
  for (const mark of marks.live(input.thread, input.now)) {
    if (mark.aliases.some((alias) => input.reader.includes(alias))) continue;
    let staff = false;
    for (const alias of mark.aliases)
      if (await input.isStaff(alias)) {
        staff = true;
        break;
      }
    if (!staff) {
      marks.clear(input.thread, [mark.principal]);
      continue;
    }
    const bot = mark.aliases.some((alias) => input.bots.includes(alias));
    if (
      bot &&
      !mark.aliases.some((alias) => input.registeredBots.includes(alias))
    ) {
      marks.clear(input.thread, [mark.principal]);
      continue;
    }
    if (!bot) return "team";
    agent = true;
  }
  return agent ? "agent" : null;
}
