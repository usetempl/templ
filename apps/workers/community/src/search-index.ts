import type {
  ChatAuthorFacts,
  ChatMessage,
  ChatViewer,
} from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  SEARCH_PAGE,
  searchQuery,
  type ChatSearchPage,
} from "@templ/chat/search";
import { HttpError, json } from "./common";
import { messageKey, readMessage, type StoredMessage } from "./message-store";
import { GROUP_SEARCH_MANIFEST, supportStoreFor } from "./support-storage";
import { supportSearchCandidates } from "./support-search";

/** Room search over the messages a room still keeps.
 *
 * The KV rows under `channel-message:*` stay the truth. This module keeps a
 * derived FTS5 index in the room's SQLite storage: `message_index` holds one
 * row per current message revision, `message_fts` tokenizes its text and
 * `search_state` remembers how far the lazy backfill of each channel got.
 * Index writes happen in the same request as the KV write. Every hit is
 * re-read from KV and re-authorized before it is returned, so a stale index
 * entry can hide a message but never expose text, a deleted row or an old
 * revision. Storage without `sql` (the in-memory test harness) reports the
 * index as unavailable and search answers 503. */
type KvStorage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
type SqlRunner = Pick<SqlStorage, "exec">;
type IndexRow = {
  rowid: number;
  channel_id: string;
  id: number;
  created_at: number;
  revision: number;
  text: string;
};
type StateRow = {
  channel_id: string;
  indexed_through: number | null;
  complete: number;
};
export const SEARCH_SCHEMA_MARKER = "search-schema-v1";
export const SEARCH_BACKFILL_BUDGET = 200;
export const SEARCH_MAX_TOKENS = 8;
export const SNIPPET_CONTEXT_CODE_POINTS = 60;
export const SEARCH_UNAVAILABLE_ERROR = "Search is unavailable right now.";
const BACKFILL_PAGE = 100;
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;
const CURSOR =
  /^(0|[1-9][0-9]{0,14}):([a-z0-9][a-z0-9-]{0,47}):([1-9][0-9]{0,14})$/;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS message_index (
    rowid INTEGER PRIMARY KEY,
    channel_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    UNIQUE(channel_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS message_index_order
    ON message_index(created_at DESC, channel_id DESC, id DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    text,
    content='message_index',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TABLE IF NOT EXISTS search_state (
    channel_id TEXT PRIMARY KEY,
    indexed_through INTEGER,
    complete INTEGER NOT NULL DEFAULT 0
  )`,
];

function messageTimestamp(row: StoredMessage) {
  const at = Date.parse(row.createdAt);
  return Number.isFinite(at) ? at : 0;
}
function rowId(row: StoredMessage) {
  return MESSAGE_ID.test(row.id) ? Number(row.id) : null;
}
const base64url = {
  encode(value: string) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  },
  decode(value: string) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(
        atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
        (char) => char.charCodeAt(0),
      ),
    );
  },
};
export type SearchCursor = { createdAt: number; channelId: string; id: number };
export function encodeCursor(cursor: SearchCursor) {
  return base64url.encode(
    `${cursor.createdAt}:${cursor.channelId}:${cursor.id}`,
  );
}
/** Accepts only a cursor this module produced; anything else is a 400. */
export function decodeCursor(value: unknown): SearchCursor | null {
  if (value === undefined || value === null || value === "") return null;
  const invalid = () => new HttpError(400, "Start the search again.");
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value))
    throw invalid();
  let decoded: string;
  try {
    decoded = base64url.decode(value);
  } catch {
    throw invalid();
  }
  const match = CURSOR.exec(decoded);
  if (!match) throw invalid();
  const cursor = {
    createdAt: Number(match[1]),
    channelId: match[2],
    id: Number(match[3]),
  };
  if (
    !Number.isSafeInteger(cursor.createdAt) ||
    !Number.isSafeInteger(cursor.id) ||
    encodeCursor(cursor) !== value
  )
    throw invalid();
  return cursor;
}
/** Words the person typed, at most `SEARCH_MAX_TOKENS`, each of which
 * carries at least one letter or digit. Punctuation-only tokens would match
 * nothing after tokenization, so they are dropped here. */
export function searchTokens(query: string) {
  return query
    .split(/\s+/u)
    .filter((token) => token && /[\p{L}\p{N}]/u.test(token))
    .slice(0, SEARCH_MAX_TOKENS);
}
/** Builds the FTS5 MATCH string. Every token becomes a quoted phrase with a
 * prefix operator, joined by implicit AND. Raw text never reaches MATCH, so
 * FTS5 operators typed by the person (OR, NOT, NEAR, parentheses, columns)
 * are searched for as words instead of being parsed. Returns null when no
 * token survives, which means an empty result page. */
export function matchExpression(query: string): string | null {
  const tokens = searchTokens(query);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" ");
}
/** Lowercases one code point only when the result is still one code point,
 * so folded offsets map back to the original text one to one (U+0130 and a
 * few others lowercase to two code points). */
function foldPoint(point: string): string {
  const folded = point.toLowerCase();
  return [...folded].length === 1 ? folded : point;
}
/** ±60 code points around the first query token found in the current text.
 * Computed here rather than through FTS5 `snippet()` so it always reflects
 * the KV row the person is allowed to read, never an indexed copy. */
export function snippet(text: string, query: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  const points = [...compact];
  const lower = points.map(foldPoint);
  let start = -1;
  for (const token of searchTokens(query)) {
    const needle = [...token].map(foldPoint);
    outer: for (let index = 0; index + needle.length <= lower.length; index++) {
      for (let offset = 0; offset < needle.length; offset++)
        if (lower[index + offset] !== needle[offset]) continue outer;
      start = index;
      break;
    }
    if (start >= 0) break;
  }
  const from = Math.max(
    0,
    (start < 0 ? 0 : start) - SNIPPET_CONTEXT_CODE_POINTS,
  );
  const to = Math.min(
    points.length,
    (start < 0 ? 0 : start) + SNIPPET_CONTEXT_CODE_POINTS,
  );
  return `${from > 0 ? "…" : ""}${points.slice(from, to).join("")}${
    to < points.length ? "…" : ""
  }`;
}
export function searchLimit(value: unknown) {
  if (value === undefined || value === null || value === "") return SEARCH_PAGE;
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]?$/.test(value) ||
    Number(value) > SEARCH_PAGE
  )
    throw new HttpError(400, "Choose between 1 and 20 results per page.");
  return Number(value);
}
export function searchChannelId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CHANNEL_ID.test(value))
    throw new HttpError(404, "Channel not found.");
  return value;
}

export class SearchIndex {
  readonly available: boolean;
  private readonly sql: SqlRunner | null;
  constructor(storage: DurableObjectStorage | { sql?: unknown }) {
    const sql = (storage as { sql?: SqlRunner }).sql;
    this.available = typeof sql?.exec === "function";
    this.sql = this.available ? sql! : null;
  }
  /** The marker and tables commit in the same transaction. Do not cache this
   * in memory: a failed transaction can roll back table creation while the
   * object stays warm. Ordinary posts can skip four idempotent DDL statements
   * once the committed marker exists. */
  async ensureSchema(storage?: Pick<KvStorage, "get" | "put">) {
    if (!this.sql) return false;
    if (storage && (await storage.get<number>(SEARCH_SCHEMA_MARKER)) === 1)
      return true;
    for (const statement of SCHEMA) this.sql.exec(statement);
    if (storage) await storage.put(SEARCH_SCHEMA_MARKER, 1);
    return true;
  }
  private run<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return this.sql!.exec<T>(query, ...bindings).toArray();
  }
  private ftsDelete(row: Pick<IndexRow, "rowid" | "text">) {
    this.run(
      "INSERT INTO message_fts(message_fts, rowid, text) VALUES('delete', ?, ?)",
      row.rowid,
      row.text,
    );
  }
  /** Indexes the current revision of a row, replacing any earlier one. */
  async upsert(
    channel: string,
    row: StoredMessage,
    storage?: Pick<KvStorage, "get" | "put">,
  ) {
    if (!(await this.ensureSchema(storage))) return;
    const id = rowId(row);
    if (id === null) return;
    const [existing] = this.run<IndexRow>(
      "SELECT rowid, channel_id, id, created_at, revision, text FROM message_index WHERE channel_id = ? AND id = ?",
      channel,
      id,
    );
    const revision = row.revision ?? 1;
    if (existing) {
      if (existing.revision === revision && existing.text === row.text) return;
      this.ftsDelete(existing);
      this.run(
        "UPDATE message_index SET created_at = ?, revision = ?, author = ?, text = ? WHERE rowid = ?",
        messageTimestamp(row),
        revision,
        row.author,
        row.text,
        existing.rowid,
      );
      this.run(
        "INSERT INTO message_fts(rowid, text) VALUES(?, ?)",
        existing.rowid,
        row.text,
      );
      return;
    }
    const [inserted] = this.run<{ rowid: number }>(
      "INSERT INTO message_index(channel_id, id, created_at, revision, author, text) VALUES(?, ?, ?, ?, ?, ?) RETURNING rowid",
      channel,
      id,
      messageTimestamp(row),
      revision,
      row.author,
      row.text,
    );
    this.run(
      "INSERT INTO message_fts(rowid, text) VALUES(?, ?)",
      inserted.rowid,
      row.text,
    );
  }
  /** Drops a row from the index; a missing row is not an error. */
  async remove(channel: string, id: string | number) {
    if (!(await this.ensureSchema())) return;
    if (!MESSAGE_ID.test(String(id))) return;
    const [existing] = this.run<IndexRow>(
      "SELECT rowid, channel_id, id, created_at, revision, text FROM message_index WHERE channel_id = ? AND id = ?",
      channel,
      Number(id),
    );
    if (!existing) return;
    this.ftsDelete(existing);
    this.run("DELETE FROM message_index WHERE rowid = ?", existing.rowid);
  }
  private state(channel: string): StateRow | undefined {
    return this.run<StateRow>(
      "SELECT channel_id, indexed_through, complete FROM search_state WHERE channel_id = ?",
      channel,
    )[0];
  }
  /** Channels whose backfill has finished, from the given list. */
  completed(channels: readonly string[]): Set<string> {
    if (!this.sql || !channels.length) return new Set();
    // Case history can exceed SQLite's bound-parameter limit. Each query
    // reads a bounded slice; the union retains every completed case.
    if (channels.length > 64)
      return new Set(
        Array.from({ length: Math.ceil(channels.length / 64) }, (_, index) => [
          ...this.completed(channels.slice(index * 64, index * 64 + 64)),
        ]).flat(),
      );
    return new Set(
      this.run<{ channel_id: string }>(
        `SELECT channel_id FROM search_state WHERE complete = 1 AND channel_id IN (${channels.map(() => "?").join(", ")})`,
        ...channels,
      ).map((row) => row.channel_id),
    );
  }
  /** Walks a channel's KV rows newest-first from where the last call stopped,
   * indexing at most `budget` rows. Returns the rows consumed and whether the
   * channel is now complete. Rows written by live upserts are re-checked and
   * skipped when unchanged, so overlap with the live path costs one read. */
  async backfill(
    channel: string,
    storage: Pick<KvStorage, "list">,
    budget = SEARCH_BACKFILL_BUDGET,
  ): Promise<{ consumed: number; complete: boolean }> {
    // Archived text stays in partition indexes. Backfilling it into the room
    // would recreate the original unbounded copy of support history.
    storage = supportStoreFor(storage)?.local ?? storage;
    if (!(await this.ensureSchema())) return { consumed: 0, complete: false };
    const state = this.state(channel);
    if (state?.complete === 1) return { consumed: 0, complete: true };
    let indexedThrough = state?.indexed_through ?? null;
    let consumed = 0;
    let complete = false;
    while (consumed < budget) {
      const pageSize = Math.min(BACKFILL_PAGE, budget - consumed);
      const page = await storage.list<StoredMessage>({
        prefix: `channel-message:${channel}:`,
        reverse: true,
        limit: pageSize,
        ...(indexedThrough === null
          ? {}
          : { end: messageKey(channel, indexedThrough) }),
      });
      for (const row of page.values()) {
        const id = rowId(row);
        if (id === null) continue;
        await this.upsert(channel, row);
        indexedThrough =
          indexedThrough === null ? id : Math.min(indexedThrough, id);
      }
      consumed += page.size;
      if (page.size < pageSize) {
        complete = true;
        break;
      }
    }
    this.run(
      "INSERT INTO search_state(channel_id, indexed_through, complete) VALUES(?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET indexed_through = excluded.indexed_through, complete = excluded.complete",
      channel,
      indexedThrough,
      complete ? 1 : 0,
    );
    return { consumed, complete };
  }
  /** Newest-first candidates for a MATCH expression inside the given
   * channels, after the cursor. Returns ids only; the caller re-reads KV. */
  candidates(
    match: string,
    channels: readonly string[],
    cursor: SearchCursor | null,
    limit: number,
  ): Pick<IndexRow, "channel_id" | "id" | "created_at" | "revision">[] {
    if (!this.sql || !channels.length) return [];
    // SQLite-backed Durable Objects cap bound parameters below the product's
    // 100-channel allowance. Each slice contributes its newest `limit` rows;
    // merging those slices preserves the same global page and cursor order.
    if (channels.length > 64)
      return Array.from(
        { length: Math.ceil(channels.length / 64) },
        (_, index) =>
          this.candidates(
            match,
            channels.slice(index * 64, index * 64 + 64),
            cursor,
            limit,
          ),
      )
        .flat()
        .sort(
          (a, b) =>
            b.created_at - a.created_at ||
            b.channel_id.localeCompare(a.channel_id) ||
            b.id - a.id,
        )
        .slice(0, limit);
    const support = channels.length === 1 && channels[0] === "support:*";
    const bindings: SqlStorageValue[] = support
      ? [match]
      : [match, ...channels];
    let where = support
      ? "message_fts MATCH ? AND message_index.channel_id GLOB 'tc-*'"
      : `message_fts MATCH ? AND message_index.channel_id IN (${channels.map(() => "?").join(", ")})`;
    if (cursor) {
      where +=
        " AND (message_index.created_at < ? OR (message_index.created_at = ? AND (message_index.channel_id < ? OR (message_index.channel_id = ? AND message_index.id < ?))))";
      bindings.push(
        cursor.createdAt,
        cursor.createdAt,
        cursor.channelId,
        cursor.channelId,
        cursor.id,
      );
    }
    bindings.push(limit);
    try {
      return this.run(
        `SELECT message_index.channel_id AS channel_id, message_index.id AS id, message_index.created_at AS created_at, message_index.revision AS revision
         FROM message_fts JOIN message_index ON message_index.rowid = message_fts.rowid
         WHERE ${where}
         ORDER BY message_index.created_at DESC, message_index.channel_id DESC, message_index.id DESC
         LIMIT ?`,
        ...bindings,
      );
    } catch {
      // A MATCH string FTS5 still refuses is a query problem, never a leak:
      // the person gets an empty page instead of an error.
      return [];
    }
  }
}

export type SearchRouteInput = {
  method: string;
  pathname: string;
  query: URLSearchParams;
  /** True when the worker could not read the session at all. */
  sessionUnavailable: boolean;
  viewer: ChatViewer;
  aliases: readonly ChatPrincipalId[];
  /** Every channel of the room; access is decided per hit by `accessible`. */
  channels: readonly { id: string; name: string }[];
  /** The requester's current read access to a channel, re-evaluated per hit. */
  accessible: (channelId: string) => boolean;
  /** A team conversation the requester named explicitly with
   * `?channel=`; it is searched only when `extraAccessible` proves the
   * conversation predicate, and never joins the default room-wide scope, so
   * no thread's existence or text reaches anyone else. */
  extraChannels?: readonly string[];
  supportScope?: boolean;
  extraAccessible?: (channelId: string) => Promise<boolean>;
  render: (channelId: string, rows: StoredMessage[]) => Promise<ChatMessage[]>;
  authors: (
    messages: readonly { author: string }[],
  ) => Promise<{ authors?: Record<string, ChatAuthorFacts> }>;
  now: number;
};
/** `GET /search?q&channel?&cursor?&limit?`. Returns null for other paths. */
export async function searchRoute(
  storage: KvStorage,
  index: SearchIndex | undefined,
  input: SearchRouteInput,
): Promise<Response | null> {
  if (input.pathname !== "/search" || input.method !== "GET") return null;
  if (input.sessionUnavailable)
    throw new HttpError(503, "Sign-in is temporarily unavailable.");
  const principalId = input.viewer.principalId;
  if (!principalId) throw new HttpError(401, "Sign in to search.");
  let query: string;
  try {
    query = searchQuery(input.query.get("q"));
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Type something to search for.",
    );
  }
  const limit = searchLimit(input.query.get("limit"));
  const supportStore = supportStoreFor(storage);
  const rawCursor = input.query.get("cursor");
  const cursor =
    supportStore && rawCursor?.startsWith("sp1.")
      ? null
      : decodeCursor(rawCursor);
  const requested = searchChannelId(input.query.get("channel"));
  const conversation =
    requested !== null && input.extraChannels?.includes(requested)
      ? requested
      : null;
  const conversationAllowed = new Set<string>();
  if (conversation !== null) {
    // The same 404 whether the thread exists or the requester is outside it.
    if (!(await input.extraAccessible?.(conversation)))
      throw new HttpError(404, "Channel not found.");
    conversationAllowed.add(conversation);
  } else if (requested !== null) {
    const channel = input.channels.find((item) => item.id === requested);
    if (!channel) throw new HttpError(404, "Channel not found.");
    if (!input.accessible(channel.id))
      throw new HttpError(403, "A role is needed to search this channel.");
  }
  if (!index?.available) throw new HttpError(503, SEARCH_UNAVAILABLE_ERROR);
  await index.ensureSchema(storage);
  const allowed = (channelId: string) =>
    input.supportScope
      ? input.extraAccessible?.(channelId)
      : conversationAllowed.has(channelId) ||
        (conversation === null && input.accessible(channelId));
  const scope = input.supportScope
    ? (input.extraChannels ?? []).map((id) => ({
        id,
        name: "Support case",
      }))
    : conversation !== null
      ? [{ id: conversation, name: "Case with the team" }]
      : input.channels.filter(
          (channel) =>
            (requested === null || channel.id === requested) &&
            input.accessible(channel.id),
        );
  const names = new Map(scope.map((channel) => [channel.id, channel.name]));
  const scopeIds = scope.map((channel) => channel.id);
  // Catch up channels the index has not finished, within one request budget.
  const completed = index.completed(scopeIds);
  let budget = SEARCH_BACKFILL_BUDGET;
  let indexing = false;
  for (const channelId of scopeIds) {
    if (completed.has(channelId)) continue;
    if (budget <= 0) {
      indexing = true;
      continue;
    }
    const result = await index.backfill(channelId, storage, budget);
    budget -= result.consumed;
    if (!result.complete) indexing = true;
  }
  const match = matchExpression(query);
  const page: ChatSearchPage = { hits: [], nextCursor: null, indexing };
  if (match === null || !scopeIds.length) return json(page);
  let candidates = index.candidates(
    match,
    input.supportScope ? ["support:*"] : scopeIds,
    cursor,
    limit + 1,
  );
  let partitionCursor: string | null | undefined;
  const partitionedSearch =
    supportStore &&
    ((supportStore.supportEnabled &&
      (input.supportScope || conversation !== null)) ||
      (supportStore.hasGroupArchive &&
        !input.supportScope &&
        conversation === null));
  if (rawCursor?.startsWith("sp1.") && !partitionedSearch)
    throw new HttpError(400, "This search expired. Search again.");
  if (partitionedSearch) {
    const channels = input.supportScope ? ["support:*"] : scopeIds;
    const groupScope = !input.supportScope && conversation === null;
    const partitioned = await supportSearchCandidates(supportStore, {
      token: rawCursor,
      user: principalId,
      query,
      scope: input.supportScope
        ? "support:*"
        : conversation !== null
          ? conversation
          : `group:${requested ?? "*"}`,
      now: input.now,
      match,
      channels,
      ...(groupScope ? { manifestPrefix: GROUP_SEARCH_MANIFEST } : {}),
      limit,
      after: cursor,
      local: (after) => index.candidates(match, channels, after, limit + 1),
      valid: async (candidate) => {
        if (!(await allowed(candidate.channel_id))) return false;
        const current = await readMessage(
          storage,
          candidate.channel_id,
          candidate.id,
        );
        return Boolean(
          current && (current.revision ?? 1) === candidate.revision,
        );
      },
    });
    candidates = partitioned.candidates;
    partitionCursor = partitioned.nextCursor;
  }
  const considered = candidates.slice(0, limit);
  for (const candidate of considered) {
    // Every hit is re-read and re-authorized against the current viewer.
    if (!(await allowed(candidate.channel_id))) continue;
    const row = await readMessage(storage, candidate.channel_id, candidate.id);
    if (!row) {
      await index.remove(candidate.channel_id, candidate.id);
      continue;
    }
    if ((row.revision ?? 1) !== candidate.revision) {
      await index.upsert(candidate.channel_id, row);
      continue;
    }
    const [message] = await input.render(candidate.channel_id, [row]);
    if (!message) continue;
    page.hits.push({
      channelId: candidate.channel_id,
      channelName:
        names.get(candidate.channel_id) ??
        (input.supportScope ? "Support case" : candidate.channel_id),
      message,
      snippet: snippet(message.text, query),
    });
  }
  if (partitionCursor !== undefined) page.nextCursor = partitionCursor;
  else if (candidates.length > limit) {
    const last = considered[considered.length - 1];
    page.nextCursor = encodeCursor({
      createdAt: last.created_at,
      channelId: last.channel_id,
      id: last.id,
    });
  }
  const authors = await input.authors(page.hits.map((hit) => hit.message));
  return json({ ...page, ...authors });
}
