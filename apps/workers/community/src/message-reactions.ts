import type { ChatMessage, ChatReaction, ChatViewer } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  CHAT_REACTIONS,
  chatReaction,
  MAX_REACTORS_PER_EMOJI,
  type ChatReactionEmoji,
} from "@templ/chat/reactions";
import { HttpError, json } from "./common";
import type { PendingEvent } from "./room-events";

/** Reactions on messages. Reactor lists stay inside the room
 * object keyed by canonical alias; readers only ever see counts and whether
 * one of their own aliases reacted. */
type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
export type ReactionRecord = Partial<
  Record<ChatReactionEmoji, ChatPrincipalId[]>
>;
export const MAX_REACTIONS_PER_MINUTE = 30;
/** Reaction join budget per rendered page. The first `MAX_REACTION_JOINS`
 * rows of a page are joined with their reaction records; rows past the
 * budget (only larger export pages exceed it) are
 * rendered with `reactions: []` so a consumer can tell "not joined" from
 * an absent property meaning "no reactions". The message list pages at
 * most 100 rows and pins at most 25, so both are always fully joined. */
export const MAX_REACTION_JOINS = 100;
const PREFIX = "message-reactions-v1:";
const MESSAGE_PREFIX = "channel-message:";
const RATE_KEY = "reaction-rate-v1";
const pad = (id: number) => String(id).padStart(16, "0");
export const reactionsKey = (channel: string, id: number) =>
  `${PREFIX}${channel}:${pad(id)}`;
/** The reactions row that belongs to a `channel-message:*` key. */
export const reactionsKeyForMessage = (messageKey: string) =>
  messageKey.startsWith(MESSAGE_PREFIX)
    ? `${PREFIX}${messageKey.slice(MESSAGE_PREFIX.length)}`
    : null;
type RateRecord = { minute: number; wallets: Record<string, number> };

export async function readReactionRecord(
  storage: Pick<Storage, "get">,
  channel: string,
  id: number,
): Promise<ReactionRecord> {
  const record = await storage.get<ReactionRecord>(reactionsKey(channel, id));
  return record && typeof record === "object" && !Array.isArray(record)
    ? record
    : {};
}
/** Widest id span read as one range list; wider ascending sets (pins with
 * far-apart ids) fall back to per-row reads. */
export const MAX_REACTION_RANGE_SPAN = 1_000;
/** Reaction records for a rendered page. An ascending page whose id span
 * fits `MAX_REACTION_RANGE_SPAN` (the message list, with or without gaps
 * from deletions) is one range list over the mirrored keys, limited by the
 * span rather than by the number of ids so a gap never hides a wanted row
 * behind rows of messages outside the set. Any other order or a wider span
 * (pins in pin order) falls back to per-row reads. At most
 * `MAX_REACTION_JOINS` rows are joined; see `pastReactionJoinBudget`. */
export async function readReactionRecords(
  storage: Pick<DurableObjectTransaction, "get" | "list">,
  channel: string,
  ids: readonly number[],
): Promise<Map<number, ReactionRecord>> {
  const wanted = ids.slice(0, MAX_REACTION_JOINS);
  const records = new Map<number, ReactionRecord>();
  if (!wanted.length) return records;
  const ascending = wanted.every(
    (id, index) => index === 0 || id > wanted[index - 1],
  );
  const first = wanted[0],
    last = wanted[wanted.length - 1];
  const span = last - first + 1;
  if (ascending && span <= MAX_REACTION_RANGE_SPAN) {
    const page = await storage.list<ReactionRecord>({
      prefix: `${PREFIX}${channel}:`,
      startAfter: reactionsKey(channel, first - 1),
      end: reactionsKey(channel, last + 1),
      limit: span,
    });
    const set = new Set(wanted);
    for (const [key, record] of page) {
      const id = Number(key.slice(key.lastIndexOf(":") + 1));
      if (
        set.has(id) &&
        record &&
        typeof record === "object" &&
        !Array.isArray(record)
      )
        records.set(id, record);
    }
    return records;
  }
  for (const id of wanted) {
    const record = await readReactionRecord(storage, channel, id);
    if (Object.keys(record).length) records.set(id, record);
  }
  return records;
}
/** True for the ids of a page that lie past the reaction join budget: the
 * renderer marks those rows with `reactions: []` instead of omitting the
 * property. `ids` is the same list handed to `readReactionRecords`. */
export function pastReactionJoinBudget(ids: readonly number[]): Set<number> {
  return new Set(ids.slice(MAX_REACTION_JOINS));
}
/** Public projection in the fixed reaction order; empty emojis are omitted. */
export function renderReactions(
  record: ReactionRecord,
  aliases: readonly ChatPrincipalId[] = [],
): ChatReaction[] {
  const rendered: ChatReaction[] = [];
  for (const emoji of CHAT_REACTIONS) {
    const reactors = record[emoji];
    if (!Array.isArray(reactors) || reactors.length === 0) continue;
    rendered.push({
      emoji,
      count: reactors.length,
      mine: reactors.some((id) => aliases.includes(id)),
    });
  }
  return rendered;
}
/** Counts only, for events every reader shares. */
export function publicReactions<T extends Pick<ChatMessage, "reactions">>(
  message: T,
): T {
  if (!message.reactions?.length) return message;
  return {
    ...message,
    reactions: message.reactions.map((reaction) => ({
      ...reaction,
      mine: false,
    })),
  };
}
async function consumeReactionRate(
  storage: Storage,
  aliases: readonly ChatPrincipalId[],
  now: number,
) {
  const minute = Math.floor(now / 60_000);
  let rate = await storage.get<RateRecord>(RATE_KEY);
  if (rate?.minute !== minute) rate = { minute, wallets: {} };
  const used = aliases.reduce((sum, id) => sum + (rate!.wallets[id] ?? 0), 0);
  if (used >= MAX_REACTIONS_PER_MINUTE)
    throw new HttpError(
      429,
      "Please wait before reacting again.",
      Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)),
    );
  rate.wallets[aliases[0]] = (rate.wallets[aliases[0]] ?? 0) + 1;
  await storage.put(RATE_KEY, rate);
}
export type ReactInput = {
  channel: string;
  id: number;
  body: Record<string, unknown>;
  viewer: ChatViewer;
  aliases: readonly ChatPrincipalId[];
  pending: PendingEvent[];
  reserveGrowth?: () => Promise<void>;
  now: number;
};
/** Adds or removes the caller's reaction. Repeating a state writes nothing
 * and emits nothing; the response always carries the current counts. */
export async function reactRoute(
  storage: Storage,
  input: ReactInput,
): Promise<Response> {
  const { channel, id, body, viewer, aliases, pending, now } = input;
  if (!viewer.principalId || !aliases.length)
    throw new HttpError(401, "Sign in to chat.");
  if (viewer.banned)
    throw new HttpError(403, "You are banned from posting in this chat.");
  if (viewer.mutedUntil)
    throw new HttpError(403, "You are muted in this chat.");
  let emoji: ChatReactionEmoji;
  try {
    emoji = chatReaction(body.emoji);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  if (typeof body.active !== "boolean")
    throw new HttpError(400, "Choose whether to add or remove the reaction.");
  if (!(await storage.get(`${MESSAGE_PREFIX}${channel}:${pad(id)}`)))
    throw new HttpError(404, "Message not found.");
  const record = await readReactionRecord(storage, channel, id);
  const reactors = record[emoji] ?? [];
  const mine = reactors.some((entry) => aliases.includes(entry));
  let changed = false;
  if (body.active && !mine) {
    if (reactors.length >= MAX_REACTORS_PER_EMOJI)
      throw new HttpError(409, "This reaction is full.");
    await input.reserveGrowth?.();
    await consumeReactionRate(storage, aliases, now);
    record[emoji] = [...reactors, aliases[0]];
    changed = true;
  } else if (!body.active && mine) {
    const remaining = reactors.filter((entry) => !aliases.includes(entry));
    if (remaining.length) record[emoji] = remaining;
    else delete record[emoji];
    changed = true;
  }
  if (changed) {
    if (Object.keys(record).length)
      await storage.put(reactionsKey(channel, id), record);
    else await storage.delete(reactionsKey(channel, id));
    pending.push({
      type: "message.reacted",
      channelId: channel,
      messageId: String(id),
      reactions: renderReactions(record),
    });
  }
  return json({ reactions: renderReactions(record, aliases) });
}
