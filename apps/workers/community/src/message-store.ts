import { assertMessageBudgetAvailable } from "./message-budget";
import type {
  ChatMessage,
  ChatPrincipalId,
  ChatReply,
  ChatViewer,
} from "@templ/chat/index";
import { HttpError } from "./common";
import { actsAs } from "./service-principals";
import { readStorageBatch } from "./storage-batch";
import type { RetiredGroupAttachment } from "./group-attachment-cleanup";
import {
  pastReactionJoinBudget,
  readReactionRecords,
  renderReactions,
} from "./message-reactions";

/** Message rows stay the truth in `channel-message:*`. This module keeps the
 * evidence around them: bounded revision history, delete evidence that
 * survives the row, and the read-time reply join. Every helper takes the
 * request's transaction so nothing here commits on its own. */
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
/** A stored row. A stored group row can name group files; no conversation
 * message carries them and no route serves them. */
export type StoredMessage = Omit<ChatMessage, "reply" | "reactions"> & {
  attachments?: RetiredGroupAttachment[];
};
export type MessageRevision = { revision: number; text: string; at: string };
export type MessageHistory = {
  revisions: MessageRevision[];
  deletedAt?: string;
  deletedBy?: ChatPrincipalId;
};
export const MAX_MESSAGE_REVISIONS = 10;
export const MESSAGE_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const MESSAGE_EDIT_WINDOW_MS = 24 * 60 * 60_000;
export const REPLY_PREVIEW_CODE_POINTS = 120;
/** Reply rows fetched per rendered page; later rows keep `reply: null`. */
export const MAX_REPLY_JOINS = 50;
const HISTORY_PREFIX = "message-history-v1:";
const HISTORY_PRUNE_CURSOR = "message-history-prune-cursor";
const HISTORY_PRUNE_PAGE = 20;
const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;
const pad = (id: number) => String(id).padStart(16, "0");
export const messageKey = (channel: string, id: number) =>
  `channel-message:${channel}:${pad(id)}`;
export const historyKey = (channel: string, id: number) =>
  `${HISTORY_PREFIX}${channel}:${pad(id)}`;

export function readMessage(storage: Storage, channel: string, id: number) {
  return storage.get<StoredMessage>(messageKey(channel, id));
}
/** Shape check only, safe before a retry lookup: a retry must return the
 * stored message even when its reply target has since been deleted. */
export function replyReference(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !MESSAGE_ID.test(value))
    throw new HttpError(400, "Choose a message in this channel to reply to.");
  return value;
}
/** Validates an optional `replyTo` and proves the target lives in the same
 * channel. A missing target is reported as unavailable, never located. */
export async function replyTarget(
  storage: Storage,
  channel: string,
  value: unknown,
): Promise<string | undefined> {
  const reference = replyReference(value);
  if (reference === undefined) return undefined;
  if (!(await readMessage(storage, channel, Number(reference))))
    throw new HttpError(404, "That message is no longer available.");
  return reference;
}
async function readHistory(storage: Storage, channel: string, id: number) {
  return (
    (await storage.get<MessageHistory>(historyKey(channel, id))) ?? {
      revisions: [],
    }
  );
}
function appendRevision(
  history: MessageHistory,
  revision: MessageRevision,
): MessageHistory {
  const revisions = [...history.revisions, revision];
  return {
    ...history,
    revisions: revisions.slice(-MAX_MESSAGE_REVISIONS),
  };
}
/** Keeps the text being replaced, keyed by the revision it belonged to. */
export async function writeRevision(
  storage: Storage,
  channel: string,
  row: StoredMessage,
  previousText: string,
  now: number,
) {
  const id = Number(row.id);
  const history = appendRevision(await readHistory(storage, channel, id), {
    revision: row.revision ?? 1,
    text: previousText,
    at: row.editedAt ?? row.createdAt,
  });
  await storage.put(historyKey(channel, id), history);
  await pruneHistory(storage, now);
  return history;
}
/** Called before the row is removed: the current text becomes the last
 * revision and the remover is recorded. Works for any deleter, so a later
 * report or appeal can still see what was removed and by whom. */
export async function recordDeleteEvidence(
  storage: Storage,
  channel: string,
  id: number,
  row: StoredMessage,
  deletedBy: ChatPrincipalId,
  now: number,
) {
  const at = new Date(now).toISOString();
  const history: MessageHistory = {
    ...appendRevision(await readHistory(storage, channel, id), {
      revision: row.revision ?? 1,
      text: row.text,
      at: row.editedAt ?? row.createdAt,
    }),
    deletedAt: at,
    deletedBy,
  };
  await storage.put(historyKey(channel, id), history);
  await pruneHistory(storage, now);
  return history;
}
const historyTouchedAt = (history: MessageHistory) =>
  Math.max(
    Date.parse(history.deletedAt ?? "") || 0,
    ...history.revisions.map((entry) => Date.parse(entry.at) || 0),
  );
/** Removes at most one small page of history rows older than the retention
 * window per call, resuming from a stored cursor so no write pays for a sweep. */
export async function pruneHistory(storage: Storage, now: number) {
  const cursor = await storage.get<string>(HISTORY_PRUNE_CURSOR);
  const page = await storage.list<MessageHistory>({
    prefix: HISTORY_PREFIX,
    ...(cursor ? { startAfter: cursor } : {}),
    limit: HISTORY_PRUNE_PAGE,
  });
  let removed = 0;
  for (const [key, history] of page) {
    if (historyTouchedAt(history) <= now - MESSAGE_HISTORY_RETENTION_MS) {
      await storage.delete(key);
      removed++;
    }
  }
  const last = [...page.keys()].at(-1);
  if (page.size < HISTORY_PRUNE_PAGE || !last)
    await storage.delete(HISTORY_PRUNE_CURSOR);
  else await storage.put(HISTORY_PRUNE_CURSOR, last);
  return removed;
}
export function replyPreview(text: string) {
  return [...text.replace(/\s+/g, " ").trim()]
    .slice(0, REPLY_PREVIEW_CODE_POINTS)
    .join("");
}
export function messageReplyPreview(
  row: Pick<StoredMessage, "text" | "attachments">,
) {
  return row.text
    ? replyPreview(row.text)
    : row.attachments?.[0]
      ? replyPreview(`File: ${row.attachments[0].name}`)
      : "";
}
/** What a safety report keeps: the message as the reporter read it, minus
 * everything joined or viewer-relative at read time (reply preview and
 * reactions) and the author's client id. `revision` is always present so evidence
 * compares exactly with the rendered message. Deleted rows return null. */
export type ReportSnapshot = Pick<
  StoredMessage,
  "id" | "author" | "text" | "attachments" | "createdAt" | "editedAt" | "replyTo"
> & { revision: number };
export async function reportSnapshot(
  storage: Storage,
  channel: string,
  id: number,
): Promise<ReportSnapshot | null> {
  const row = await readMessage(storage, channel, id);
  if (!row || "deletedAt" in row) return null;
  return {
    id: row.id,
    author: row.author,
    text: row.text,
    ...(row.attachments ? { attachments: row.attachments } : {}),
    createdAt: row.createdAt,
    revision: row.revision ?? 1,
    ...(row.editedAt ? { editedAt: row.editedAt } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
  };
}
export type RenderOptions = {
  /** Distinct reply targets resolved for the page. */
  joinLimit?: number;
  /** The reader's proven aliases; decides `reactions[].mine`. */
  aliases?: readonly ChatPrincipalId[];
};
/** Joins replies and reactions for a page with a bounded number
 * of reads. Rows past the reply budget keep `reply: null`, which clients
 * treat as unresolved, not deleted. Reactions are joined for the first
 * `MAX_REACTION_JOINS` rows and omitted when a row has none; rows past that
 * budget carry `reactions: []` (not joined). */
export async function renderMessages(
  storage: Storage,
  channel: string,
  rows: StoredMessage[],
  options: number | RenderOptions = {},
): Promise<ChatMessage[]> {
  const settings =
    typeof options === "number" ? { joinLimit: options } : options;
  const joinLimit = Math.min(
    settings.joinLimit ?? MAX_REPLY_JOINS,
    MAX_REPLY_JOINS,
  );
  const aliases = settings.aliases ?? [];
  const replyIds: string[] = [];
  const seenReplies = new Set<string>();
  for (const row of rows) {
    if (!row.replyTo || seenReplies.has(row.replyTo)) continue;
    if (replyIds.length >= joinLimit) break;
    seenReplies.add(row.replyTo);
    replyIds.push(row.replyTo);
  }
  const replyKeys = replyIds
    .filter((id) => MESSAGE_ID.test(id))
    .map((id) => messageKey(channel, Number(id)));
  const reactionIds = rows.flatMap((row) =>
    MESSAGE_ID.test(row.id) ? [Number(row.id)] : [],
  );
  // Every target is in this already-authorized channel. Batch the bounded
  // joins so a page quoting cold messages does not pay one partition hop per
  // reply; the independent reaction join runs alongside that read.
  const [reactionRecords, replyRows] = await Promise.all([
    readReactionRecords(storage, channel, reactionIds),
    replyKeys.length
      ? readStorageBatch<StoredMessage>(storage, replyKeys)
      : Promise.resolve(new Map<string, StoredMessage>()),
  ]);
  const joined = new Map<string, ChatReply>();
  for (const id of replyIds) {
    const row = MESSAGE_ID.test(id)
      ? replyRows.get(messageKey(channel, Number(id)))
      : undefined;
    joined.set(
      id,
      row
        ? {
            id,
            state: "available",
            author: row.author,
            preview: messageReplyPreview(row),
            createdAt: row.createdAt,
          }
        : { id, state: "deleted" },
    );
  }
  // Rows past the join budget carry an empty list, not nothing.
  const unjoined = pastReactionJoinBudget(reactionIds);
  const rendered: ChatMessage[] = [];
  for (const row of rows) {
    const message: ChatMessage = { ...row, revision: row.revision ?? 1 };
    if (row.replyTo) message.reply = joined.get(row.replyTo) ?? null;
    const record = reactionRecords.get(Number(row.id));
    if (record) {
      const reactions = renderReactions(record, aliases);
      if (reactions.length) message.reactions = reactions;
    } else if (unjoined.has(Number(row.id))) message.reactions = [];
    rendered.push(message);
  }
  return rendered;
}
export type EditInput = {
  channel: { id: string; archived?: boolean };
  id: number;
  viewer: ChatViewer;
  aliases: ChatPrincipalId[];
  /** True when the worker found a safety hold on this exact message. */
  held: boolean;
  budgetAvailable?: boolean;
  /** Validated lazily so ownership and window checks come first. */
  text: () => string;
  /** Only called when an edit would add a revision. */
  reserveGrowth?: () => Promise<void>;
  now: number;
};
/** Author-only edit inside the window. Returns the rendered current row and
 * whether a new revision was written; an unchanged text writes nothing. */
export async function editMessage(
  storage: Storage,
  input: EditInput,
): Promise<{ message: ChatMessage; changed: boolean }> {
  const { channel, viewer, aliases, now } = input;
  const author = viewer.principalId;
  if (!author) throw new HttpError(401, "Sign in to chat.");
  const row = await readMessage(storage, channel.id, input.id);
  if (!row) throw new HttpError(404, "Message not found.");
  if (!actsAs(aliases, row.author))
    throw new HttpError(403, "You can only edit your own messages.");
  const createdAt = Date.parse(row.createdAt);
  if (!Number.isFinite(createdAt) || now - createdAt > MESSAGE_EDIT_WINDOW_MS)
    throw new HttpError(403, "Messages can be edited for 24 hours.");
  if (channel.archived)
    throw new HttpError(
      403,
      "This channel is archived. Its history is still readable.",
    );
  if (viewer.banned)
    throw new HttpError(403, "You are banned from posting in this chat.");
  if (viewer.mutedUntil)
    throw new HttpError(403, "You are muted in this chat.");
  if (input.held)
    throw new HttpError(
      403,
      "This message is under review and can’t be changed.",
    );
  const text = input.text();
  const render = async (current: StoredMessage) =>
    (await renderMessages(storage, channel.id, [current], { aliases }))[0];
  if (text === row.text) return { message: await render(row), changed: false };
  assertMessageBudgetAvailable(input.budgetAvailable !== false);
  await input.reserveGrowth?.();
  await writeRevision(storage, channel.id, row, row.text, now);
  const updated: StoredMessage = {
    ...row,
    text,
    revision: (row.revision ?? 1) + 1,
    editedAt: new Date(now).toISOString(),
  };
  const deletionsKey = `channel-deletions:${channel.id}`;
  await storage.put({
    [messageKey(channel.id, input.id)]: updated,
    [deletionsKey]: ((await storage.get<number>(deletionsKey)) ?? 0) + 1,
  });
  return { message: await render(updated), changed: true };
}
