import { READ_LOG_COALESCE_MS } from "@templ/chat/audit";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { PendingAudit } from "./room-audit";

/** R3-STAFF-READ-LOG. When a team principal (the manager, staff with the
 * inbox, a registered AI agent) opens a chat or a screenshot, searches the
 * inbox or keeps the inbox feed open, the room's `reads` audit stream gets
 * an entry with ids, counts and a search kind; never message or search
 * text. A member reading their own thread is never logged.
 *
 * Entries go through the request's pending audit list, so they commit only
 * with a successful answer in the same transaction. One entry per principal
 * and chat (or feed) per 30 minutes: the last logged time lives in memory
 * only, keyed by room, principal and chat, and is set only after the
 * request commits. No storage is read for it. After an isolate restarts the
 * next read logs again; duplicates are possible, gaps are not. */
export type ReadRole = "manager" | "staff" | "agent" | "specialist";
export type ReadVia = "thread" | "workflow" | "attachment" | "case";
export type SearchKind = "text" | "address" | "transaction" | "thread-id";

const MARKS_MAX = 5_000;
const marks = new Map<string, number>();
/** Keys a request noted, set in `marks` once it commits. */
const noted = new WeakMap<PendingAudit[], string[]>();

function recent(key: string, now: number) {
  const last = marks.get(key);
  return last !== undefined && last <= now && now - last < READ_LOG_COALESCE_MS;
}
function note(pending: PendingAudit[], key: string) {
  const keys = noted.get(pending) ?? [];
  keys.push(key);
  noted.set(pending, keys);
}
/** After the room transaction: a committed request sets its marks. */
export function settleReadMarks(
  pending: PendingAudit[],
  committed: boolean,
  now = Date.now(),
) {
  const keys = noted.get(pending);
  noted.delete(pending);
  if (!committed || !keys) return;
  for (const key of keys) {
    marks.delete(key);
    marks.set(key, now);
    while (marks.size > MARKS_MAX) {
      const oldest = marks.keys().next().value;
      if (oldest === undefined) break;
      marks.delete(oldest);
    }
  }
}
/** @public Test-only reset of the memory marks. */
export function clearReadMarks() {
  marks.clear();
}

export function readRole(input: {
  isManager: boolean;
  isBot?: boolean;
  specialist?: boolean;
}): ReadRole {
  if (input.isManager) return "manager";
  if (input.isBot) return "agent";
  if (input.specialist) return "specialist";
  return "staff";
}

/** A thread read by the team: `GET /conversations/:tc`, its messages, its
 * workflow (notes included) or one screenshot. */
export function noteRead(
  pending: PendingAudit[],
  input: {
    room: string;
    actor: ChatPrincipalId;
    thread: string;
    member: string;
    role: ReadRole;
    via: ReadVia;
    attachment?: string;
    now: number;
  },
) {
  const key = `${input.room}|${input.actor}|${input.thread}${
    input.via === "attachment" ? `|${input.attachment}` : ""
  }`;
  if (recent(key, input.now)) return false;
  // A second read in the same request (thread then messages) writes once.
  if (noted.get(pending)?.includes(key)) return false;
  pending.push({
    actor: input.actor,
    action: "support.read",
    channelId: input.thread,
    target: input.member,
    after: {
      via: input.via,
      role: input.role,
      ...(input.via === "attachment" ? { attachment: input.attachment } : {}),
    },
  });
  note(pending, key);
  return true;
}

const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
/** What a search looked for, from its trimmed text. The text itself is
 * never stored. */
export function searchKind(query: string): SearchKind {
  const text = query.trim();
  if (/^tc-[0-9a-f]{32}$/i.test(text)) return "thread-id";
  if (
    /^0x[0-9a-f]{64}$/i.test(text) ||
    new RegExp(`^${BASE58}{86,88}$`).test(text)
  )
    return "transaction";
  if (
    /^0x[0-9a-f]{40}$/i.test(text) ||
    new RegExp(`^${BASE58}{32,44}$`).test(text)
  )
    return "address";
  return "text";
}

/** The first page of a team search: its kind, length, hit count and at
 * most 20 thread ids. A cursor page writes nothing. */
export function noteSearch(
  pending: PendingAudit[],
  input: {
    actor: ChatPrincipalId;
    role: ReadRole;
    scope: "inbox" | "thread";
    query: string;
    hits: { channelId: string }[];
  },
) {
  const threads = [...new Set(input.hits.map((hit) => hit.channelId))].slice(
    0,
    20,
  );
  pending.push({
    actor: input.actor,
    action: "support.search",
    target: null,
    after: {
      role: input.role,
      scope: input.scope,
      kind: searchKind(input.query),
      length: [...input.query.trim()].length,
      hits: input.hits.length,
      threads,
    },
  });
}

/** The team's inbox feed was open: events or a realtime ticket. */
export function noteFeed(
  pending: PendingAudit[],
  input: {
    room: string;
    actor: ChatPrincipalId;
    role: ReadRole;
    via: "events" | "realtime";
    now: number;
  },
) {
  const key = `${input.room}|${input.actor}|feed`;
  if (recent(key, input.now) || noted.get(pending)?.includes(key)) return false;
  pending.push({
    actor: input.actor,
    action: "support.feed",
    target: null,
    after: { role: input.role, via: input.via },
  });
  note(pending, key);
  return true;
}
