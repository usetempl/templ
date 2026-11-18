import type {
  AuditStream,
  ChatAuditEntry,
  ChatAuditPage,
} from "@templ/chat/audit";
import { AUDIT_RETENTION, MAX_AUDIT_PAGE } from "@templ/chat/audit";
import {
  ACCESS_AUDIT_RETENTION,
  READ_AUDIT_RETENTION,
} from "@templ/chat/audit";
import { auditStream } from "@templ/chat/audit";
import { HttpError } from "./common";
import { normalizeChatPrincipal } from "@templ/chat/principal";

/** Append-only, manager-readable audit log kept inside the room object.
 * Entries hold actor, target and metadata only: never message text, never
 * chain amounts. Written in the same transaction as the mutation.
 *
 * Two streams, each with its own ids, cursors and retention: "chats"
 * (conversation, message and other activity) and "access" (who holds which
 * powers and how the workspace is set up), so chat volume never pushes an
 * access change out. Every key is room-local. */
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
export type PendingAudit = Omit<ChatAuditEntry, "id" | "at">;
type StreamKeys = {
  prefix: string;
  sequence: string;
  floor: string;
  retention: { count: number; ms: number };
};
const STREAMS: Record<AuditStream, StreamKeys> = {
  chats: {
    prefix: "room-audit-v1:",
    sequence: "room-audit-sequence",
    floor: "room-audit-floor",
    retention: AUDIT_RETENTION,
  },
  access: {
    prefix: "room-audit-access-v1:",
    sequence: "room-audit-access-sequence",
    floor: "room-audit-access-floor",
    retention: ACCESS_AUDIT_RETENTION,
  },
  // Who on the team opened which chat, ids only.
  reads: {
    prefix: "room-audit-reads-v1:",
    sequence: "room-audit-reads-sequence",
    floor: "room-audit-reads-floor",
    retention: READ_AUDIT_RETENTION,
  },
};
const PRUNE_PAGE = 50;
const CURSOR = /^[1-9][0-9]{0,15}$/;
export const auditStreamKey = (stream: AuditStream, sequence: number) =>
  `${STREAMS[stream].prefix}${String(sequence).padStart(16, "0")}`;
export function auditCursor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CURSOR.test(value))
    throw new HttpError(400, "Invalid audit cursor.");
  return Number(value);
}
export function auditLimit(value: unknown): number {
  if (value === undefined || value === null || value === "")
    return MAX_AUDIT_PAGE;
  if (typeof value !== "string" || !/^[1-9][0-9]?$/.test(value))
    throw new HttpError(400, "Invalid audit page size.");
  return Math.min(Number(value), MAX_AUDIT_PAGE);
}
/** `?stream=` for `GET /audit`: "chats" (the default), "access" or
 * "reads". */
export function auditStreamParam(value: unknown): AuditStream {
  if (value === undefined || value === null || value === "") return "chats";
  if (value !== "chats" && value !== "access" && value !== "reads")
    throw new HttpError(400, "Choose the access, chats or reads stream.");
  return value;
}
async function writeAuditEntry(
  storage: Storage,
  stream: AuditStream,
  entry: PendingAudit,
  now: number,
) {
  const keys = STREAMS[stream];
  const sequence = ((await storage.get<number>(keys.sequence)) ?? 0) + 1;
  const stored: ChatAuditEntry = {
    ...entry,
    id: String(sequence),
    at: new Date(now).toISOString(),
  };
  await storage.put({
    [auditStreamKey(stream, sequence)]: stored,
    [keys.sequence]: sequence,
  });
  return { stored, sequence };
}
/** Writes an entry to the stream its action belongs to (`auditStream`):
 * access changes to the access stream, everything else to chats. Entries
 * written before streams existed stay in the chats stream and age out
 * there. */
export async function appendAudit(
  storage: Storage,
  entry: PendingAudit,
  now: number,
): Promise<ChatAuditEntry> {
  return appendAuditToStream(storage, auditStream(entry.action), entry, now);
}
/** Appends to one stream and prunes that stream in the same transaction. */
export async function appendAuditToStream(
  storage: Storage,
  stream: AuditStream,
  entry: PendingAudit,
  now: number,
): Promise<ChatAuditEntry> {
  const { stored, sequence } = await writeAuditEntry(
    storage,
    stream,
    entry,
    now,
  );
  await pruneAuditStream(storage, stream, sequence, now);
  return stored;
}
/** Removes, one bounded page at a time, a stream's entries past its count or
 * age. Runs only when an entry is written to that stream. */
export async function pruneAuditStream(
  storage: Storage,
  stream: AuditStream,
  sequence: number,
  now: number,
) {
  const { prefix, floor: floorKey, retention } = STREAMS[stream];
  const floor = (await storage.get<number>(floorKey)) ?? 1;
  const countFloor = Math.max(floor, sequence - retention.count + 1);
  const oldest = await storage.get<ChatAuditEntry>(
    auditStreamKey(stream, floor),
  );
  if (
    oldest &&
    countFloor === floor &&
    Date.parse(oldest.at) > now - retention.ms
  )
    return;
  const page = await storage.list<ChatAuditEntry>({
    prefix,
    startAfter: auditStreamKey(stream, floor - 1),
    limit: PRUNE_PAGE,
  });
  let nextFloor = floor;
  for (const [key, entry] of page) {
    const id = Number(entry.id);
    if (id < countFloor || Date.parse(entry.at) <= now - retention.ms) {
      await storage.delete(key);
      nextFloor = id + 1;
      continue;
    }
    nextFloor = id;
    break;
  }
  if (page.size === 0) nextFloor = sequence + 1;
  if (nextFloor !== floor) await storage.put(floorKey, nextFloor);
}
/** Filters for the reads stream: `actor` (a principal) and `thread` (a
 * chat id). Anything else is 400. */
export function auditFilters(query: URLSearchParams): {
  actor?: string;
  thread?: string;
} {
  const actor = query.get("actor");
  const thread = query.get("thread");
  if (actor !== null && !normalizeChatPrincipal(actor))
    throw new HttpError(400, "Choose a person from the team.");
  if (thread !== null && !/^tc-[0-9a-f]{32}$/.test(thread))
    throw new HttpError(400, "Choose a chat.");
  if ((actor !== null || thread !== null) && query.get("stream") !== "reads")
    throw new HttpError(400, "Only the reads log can be filtered.");
  return {
    ...(actor !== null ? { actor: normalizeChatPrincipal(actor)! } : {}),
    ...(thread !== null ? { thread } : {}),
  };
}
/** Entries a filtered page scans before it answers. */
export const AUDIT_FILTER_SCAN = 500;
/** One stream, newest first, with that stream's own ids as cursors.
 * `before` is an entry id; the page holds entries older than it. With a
 * filter, at most 500 entries are scanned; `nextBefore` is where the scan
 * stopped, so an empty page with a cursor means keep going. */
export async function readAuditStream(
  storage: Storage,
  stream: AuditStream,
  options: {
    before: number | null;
    limit: number;
    actor?: string;
    thread?: string;
  },
): Promise<ChatAuditPage> {
  const limit = Math.max(1, Math.min(options.limit, MAX_AUDIT_PAGE));
  if (options.actor !== undefined || options.thread !== undefined) {
    const scanned = await storage.list<ChatAuditEntry>({
      prefix: STREAMS[stream].prefix,
      reverse: true,
      limit: AUDIT_FILTER_SCAN,
      ...(options.before === null
        ? {}
        : { end: auditStreamKey(stream, options.before) }),
    });
    const entries: ChatAuditEntry[] = [];
    let last: ChatAuditEntry | null = null;
    for (const entry of scanned.values()) {
      last = entry;
      if (
        (options.actor === undefined || entry.actor === options.actor) &&
        (options.thread === undefined || entry.channelId === options.thread)
      ) {
        entries.push(entry);
        if (entries.length === limit) break;
      }
    }
    const more =
      entries.length === limit ? true : scanned.size === AUDIT_FILTER_SCAN;
    return { entries, nextBefore: more && last ? last.id : null };
  }
  const page = await storage.list<ChatAuditEntry>({
    prefix: STREAMS[stream].prefix,
    reverse: true,
    limit: limit + 1,
    ...(options.before === null
      ? {}
      : { end: auditStreamKey(stream, options.before) }),
  });
  const newest = [...page.values()];
  const entries = newest.slice(0, limit);
  return {
    entries,
    nextBefore: newest.length > limit ? entries[entries.length - 1].id : null,
  };
}
