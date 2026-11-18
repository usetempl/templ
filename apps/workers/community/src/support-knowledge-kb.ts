import type { KnowledgeContextPage } from "@templ/chat/knowledge";
import { brainUploadUseAllowed, type StorageUploadGrant } from "./brain-storage";
/** The knowledge base inside SupportKnowledge: sources (docs pages, FAQ
 * entries, saved replies the team opted in), their chunks, the full-text
 * index, era and visibility tags, and the query managed AI reads.
 *
 * Retrieval rules:
 * - current sources answer by default;
 * - a legacy source answers only when the query asks for legacy and names
 *   an address the source lists (the request's legacy facts);
 * - a member-facing query sees member-safe sources only;
 * - a page that disappeared keeps its archived copy with `archivedAt`.
 * Profile entries answer as `profile:<network>:<address>` hits under the
 * same rules: live entries are current, every other status is legacy. */
import { detectSecret, asksForSecret, hideAmbiguousHex } from "@templ/chat/support-safety";
import {
  KNOWLEDGE_ERAS,
  KNOWLEDGE_LIMITS,
  PROFILE_VISIBILITY,
  profileAddress,
  type KnowledgeEraTag,
  type KnowledgeOverview,
  type KnowledgeSourceView,
  type ProfileVisibility,
} from "@templ/chat/protocol-profile";
import {
  HOUR_MS,
  KnowledgeError,
  iso,
  randomHex,
  readMeta,
  writeMeta,
  sha256Hex,
  type KnowledgeDb,
} from "./support-knowledge-schema";

export type KnowledgeHitRow = {
  sourceId: string;
  kind: "doc" | "faq" | "profile" | "saved-reply";
  title: string;
  excerpt: string;
  url?: string;
  era: KnowledgeEraTag;
  visibility: ProfileVisibility;
  updatedAt: string;
  archivedAt?: string;
};
const SOURCE_ID = /^kb-[0-9a-f]{16}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

type SourceRow = {
  id: string;
  origin: string;
  kind: string;
  title: string;
  url: string | null;
  era: string;
  visibility: string;
  addresses: string;
  status: string;
  error: string | null;
  etag: string | null;
  body_sha256: string | null;
  last_fetch_at: number | null;
  next_fetch_at: number | null;
  archived_at: number | null;
  updated_at: number;
  parent: string | null;
};
const parseAddresses = (value: string): string[] => {
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((a) => typeof a === "string") : [];
  } catch {
    return [];
  }
};
function view(db: KnowledgeDb, row: SourceRow): KnowledgeSourceView {
  const chunks = Number(
    db.sql.exec("SELECT COUNT(*) AS n FROM kb_chunks WHERE source_id = ?", row.id).toArray()[0]?.n ?? 0,
  );
  const learning = sourceLearningView(db, row);
  return {
    id: row.id,
    kind: row.kind as KnowledgeSourceView["kind"],
    title: row.title,
    url: row.url,
    era: row.era as KnowledgeEraTag,
    visibility: row.visibility as ProfileVisibility,
    addresses: parseAddresses(row.addresses),
    status: row.status as KnowledgeSourceView["status"],
    error: row.error,
    chunks,
    lastFetchAt: row.last_fetch_at === null ? null : iso(row.last_fetch_at),
    nextFetchAt: row.next_fetch_at === null ? null : iso(row.next_fetch_at),
    archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    updatedAt: iso(row.updated_at),
    ...learning,
  };
}

/** These are staff source-list hints only. They never alter the source,
 * become answer passages, or expose the private case provenance. */
function sourceLearningView(db: KnowledgeDb, row: SourceRow): Pick<KnowledgeSourceView, "learning" | "possiblyOutdated"> {
  const result: Pick<KnowledgeSourceView, "learning" | "possiblyOutdated"> = {};
  try {
    const owned = JSON.parse(readMeta(db, "knowledge.learning.source:" + row.id) ?? "null") as Record<string, unknown> | null;
    if (row.origin === "learning" && owned && ["collection", "entry"].includes(String(owned.kind)) && typeof owned.reviewRequired === "boolean")
      result.learning = {
        kind: owned.kind as "collection" | "entry",
        reviewRequired: owned.reviewRequired && row.visibility === "staff-only",
        ...(typeof owned.parentId === "string" && SOURCE_ID.test(owned.parentId) ? { parentId: owned.parentId } : {}),
      };
    if (result.learning && row.visibility === "staff-only" && owned?.paused && typeof owned.paused === "object") {
      const paused = owned.paused as Record<string, unknown>;
      if (paused.sourceUpdatedAt === iso(row.updated_at) && typeof paused.at === "string" && Number.isFinite(Date.parse(paused.at)) &&
          typeof paused.reason === "string" && ["wrong-facts", "wrong-product", "wrong-metric-or-window", "unsupported-claim", "unsafe"].includes(paused.reason)) {
        result.learning.pausedAt = paused.at;
        result.learning.reviewReason = paused.reason;
      }
    }
  } catch { /* Invalid metadata conveys no source authority. */ }
  try {
    const warnings = JSON.parse(readMeta(db, "knowledge.learning.conflicts:" + row.id) ?? "null") as unknown;
    if (Array.isArray(warnings)) {
      const current = warnings.filter((warning): warning is NonNullable<KnowledgeSourceView["possiblyOutdated"]>[number] => {
        if (!warning || typeof warning !== "object" || Array.isArray(warning)) return false;
        const item = warning as Record<string, unknown>;
        return typeof item.entryId === "string" && SOURCE_ID.test(item.entryId) &&
          typeof item.quote === "string" && item.quote.length > 0 && item.quote.length <= 1_200 &&
          typeof item.reason === "string" && item.reason.length > 0 && item.reason.length <= 600 &&
          item.sourceUpdatedAt === iso(row.updated_at) &&
          item.sourceGeneration === readMeta(db, "knowledge.context.source:" + row.id) &&
          db.sql.exec("SELECT id FROM kb_sources WHERE id = ? AND origin = 'learning'", item.entryId).toArray().length > 0;
      });
      if (current.length) result.possiblyOutdated = current.map(({ entryId, quote, reason, sourceUpdatedAt }) => ({ entryId, quote, reason, sourceUpdatedAt }));
    }
  } catch { /* Stale or invalid annotations do not change knowledge. */ }
  return result;
}

export function checkedTags(args: {
  era?: unknown;
  visibility?: unknown;
  addresses?: unknown;
}): { era?: KnowledgeEraTag; visibility?: ProfileVisibility; addresses?: string[] } {
  const out: { era?: KnowledgeEraTag; visibility?: ProfileVisibility; addresses?: string[] } = {};
  if (args.era !== undefined) {
    if (!KNOWLEDGE_ERAS.includes(args.era as KnowledgeEraTag))
      throw new KnowledgeError(400, "knowledge-era", "Choose current or older product.");
    out.era = args.era as KnowledgeEraTag;
  }
  if (args.visibility !== undefined) {
    if (!PROFILE_VISIBILITY.includes(args.visibility as ProfileVisibility))
      throw new KnowledgeError(400, "knowledge-visibility", "Choose who may see this source.");
    out.visibility = args.visibility as ProfileVisibility;
  }
  if (args.addresses !== undefined) {
    if (!Array.isArray(args.addresses) || args.addresses.length > KNOWLEDGE_LIMITS.addresses)
      throw new KnowledgeError(400, "knowledge-addresses", "List at most 16 addresses.");
    const addresses: string[] = [];
    for (const raw of args.addresses) {
      const value = String(raw).trim();
      const address =
        profileAddress("eip155:1", value) ?? profileAddress("solana", value);
      if (!address)
        throw new KnowledgeError(400, "knowledge-addresses", "List contract addresses Templ can read.");
      addresses.push(address);
    }
    out.addresses = [...new Set(addresses)];
  }
  return out;
}
const textOk = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);

export function sourceCount(db: KnowledgeDb) {
  return Number(db.sql.exec("SELECT COUNT(*) AS n FROM kb_sources").toArray()[0]?.n ?? 0);
}
/** A docs page (fetched later), an FAQ entry or an opted-in saved reply. */
export function addSource(
  db: KnowledgeDb,
  args: {
    kind: unknown;
    url?: unknown;
    title?: unknown;
    text?: unknown;
    era?: unknown;
    visibility?: unknown;
    addresses?: unknown;
    parent?: unknown;
    ref?: unknown;
  },
  now: number,
): KnowledgeSourceView {
  const sourceText = [args.title, args.text].filter((value): value is string => typeof value === "string");
  if (sourceText.some((value) => detectSecret(value)))
    throw new KnowledgeError(422, "secret-refused", "This looks like a private key or recovery phrase, so it wasn't saved.");
  if (sourceText.some((value) => asksForSecret(value)))
    throw new KnowledgeError(422, "secret-request-refused", "Templ doesn't save knowledge that asks for a private key or recovery phrase.");
  if (typeof args.title === "string") args.title = hideAmbiguousHex(args.title);
  if (typeof args.text === "string") args.text = hideAmbiguousHex(args.text);
  if (sourceCount(db) >= KNOWLEDGE_LIMITS.sources)
    throw new KnowledgeError(409, "knowledge-limit", "The knowledge base holds up to 500 sources.");
  const tags = checkedTags(args);
  const era = tags.era ?? "current";
  const visibility = tags.visibility ?? "member-safe";
  const addresses = JSON.stringify(tags.addresses ?? []);
  const id = `kb-${randomHex(8)}`;
  if (args.kind === "doc") {
    if (typeof args.url !== "string")
      throw new KnowledgeError(400, "knowledge-url", "Use a public https address for this page.");
    const url = new URL(args.url);
    url.hash = "";
    url.search = "";
    const existing = db.sql
      .exec("SELECT id FROM kb_sources WHERE url = ?", url.toString())
      .toArray()[0];
    if (existing)
      throw new KnowledgeError(409, "knowledge-duplicate", "This page is already a source.");
    db.sql.exec(
      `INSERT INTO kb_sources (id, kind, title, url, era, visibility, addresses, status, updated_at, next_fetch_at, parent, origin)
       VALUES (?, 'doc', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'link')`,
      id,
      textOk(args.title, KNOWLEDGE_LIMITS.titleChars) ? args.title.trim() : url.hostname + url.pathname,
      url.toString(),
      era,
      visibility,
      addresses,
      now,
      now,
      typeof args.parent === "string" && SOURCE_ID.test(args.parent) ? args.parent : null,
    );
  } else if (args.kind === "faq" || args.kind === "saved-reply") {
    if (!textOk(args.title, KNOWLEDGE_LIMITS.titleChars) || !textOk(args.text, KNOWLEDGE_LIMITS.faqChars))
      throw new KnowledgeError(400, "knowledge-text", "Write a question and an answer within the limits.");
    if (args.kind === "saved-reply" && typeof args.ref === "string") {
      const existing = db.sql
        .exec("SELECT id FROM kb_sources WHERE kind = 'saved-reply' AND url = ?", `saved-reply:${args.ref}`)
        .toArray()[0];
      if (existing) {
        replaceChunks(db, String(existing.id), args.title.trim(), args.text.trim());
        db.sql.exec("UPDATE kb_sources SET title = ?, updated_at = ? WHERE id = ?", args.title.trim(), now, String(existing.id));
        return getSource(db, String(existing.id));
      }
    }
    db.sql.exec(
      `INSERT INTO kb_sources (id, kind, title, url, era, visibility, addresses, status, updated_at, origin, parent)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      id,
      args.kind,
      args.title.trim(),
      args.kind === "saved-reply" && typeof args.ref === "string" ? `saved-reply:${args.ref}` : null,
      era,
      visibility,
      addresses,
      now,
      args.kind,
      typeof args.parent === "string" && SOURCE_ID.test(args.parent) ? args.parent : null,
    );
    replaceChunks(db, id, args.title.trim(), args.text.trim());
  } else throw new KnowledgeError(400, "knowledge-kind", "Choose a docs page, an FAQ entry or a saved reply.");
  return getSource(db, id);
}
export function getSource(db: KnowledgeDb, id: unknown): KnowledgeSourceView {
  if (typeof id !== "string" || !SOURCE_ID.test(id))
    throw new KnowledgeError(404, "knowledge-not-found", "Source not found.");
  const row = db.sql.exec("SELECT * FROM kb_sources WHERE id = ?", id).toArray()[0] as
    | SourceRow
    | undefined;
  if (!row) throw new KnowledgeError(404, "knowledge-not-found", "Source not found.");
  return view(db, row);
}
/** Only the manager reads an FAQ's stored answer for editing. */
export function getFaq(db: KnowledgeDb, id: unknown): KnowledgeSourceView & { text: string } {
  const source = getSource(db, id);
  if (source.kind !== "faq") throw new KnowledgeError(404, "knowledge-not-found", "FAQ not found.");
  const text = db.sql.exec("SELECT text FROM kb_chunks WHERE source_id = ? ORDER BY seq", source.id)
    .toArray().map((row) => String(row.text)).join("\n\n");
  return { ...source, text };
}
export function sourceRow(db: KnowledgeDb, id: string): SourceRow | null {
  return (db.sql.exec("SELECT * FROM kb_sources WHERE id = ?", id).toArray()[0] as SourceRow) ?? null;
}
export function updateSource(
  db: KnowledgeDb,
  args: { id: unknown; era?: unknown; visibility?: unknown; addresses?: unknown; title?: unknown; text?: unknown; ifUpdatedAt?: unknown },
  now: number,
) {
  return db.transaction(() => {
    const current = getSource(db, args.id);
    if (args.ifUpdatedAt !== undefined && args.ifUpdatedAt !== current.updatedAt)
      throw new KnowledgeError(409, "knowledge-changed", "This source changed. Reload it before saving.");
    if (args.text !== undefined && (current.kind !== "faq" || sourceRow(db, current.id)?.origin === "upload"))
      throw new KnowledgeError(400, "knowledge-text-kind", "Only FAQ answers can be edited here.");
    if (args.text !== undefined && (args.ifUpdatedAt === undefined || !textOk(args.text, KNOWLEDGE_LIMITS.faqChars)))
      throw new KnowledgeError(400, "knowledge-text", "Load the FAQ and write an answer within the limits.");
    if (args.text !== undefined && args.title !== undefined && !textOk(args.title, KNOWLEDGE_LIMITS.titleChars))
      throw new KnowledgeError(400, "knowledge-text", "Write a question within the limit.");
    const tags = checkedTags(args);
    const fields = [args.title, args.text].filter((value): value is string => typeof value === "string");
    if (fields.some((value) => detectSecret(value)))
      throw new KnowledgeError(422, "secret-refused", "This looks like a private key or recovery phrase, so it wasn't saved.");
    if (fields.some((value) => asksForSecret(value)))
      throw new KnowledgeError(422, "secret-request-refused", "Templ doesn't save knowledge that asks for a private key or recovery phrase.");
    const title = textOk(args.title, KNOWLEDGE_LIMITS.titleChars) ? hideAmbiguousHex(args.title.trim()) : current.title;
    if (current.kind === "faq" && (args.text !== undefined || title !== current.title))
      replaceChunks(db, current.id, title, args.text === undefined ? getFaq(db, current.id).text : hideAmbiguousHex(String(args.text).trim()));
    db.sql.exec(
      "UPDATE kb_sources SET era = ?, visibility = ?, addresses = ?, title = ?, updated_at = ? WHERE id = ?",
      tags.era ?? current.era,
      tags.visibility ?? current.visibility,
      JSON.stringify(tags.addresses ?? current.addresses),
      title,
      current.kind === "faq" ? Math.max(now, Date.parse(current.updatedAt) + 1) : now,
      current.id,
    );
    return getSource(db, current.id);
  });
}
export function removeSource(db: KnowledgeDb, args: { id: unknown }) {
  const current = getSource(db, args.id);
  db.transaction(() => {
    const ids = [current.id];
    for (const child of db.sql.exec("SELECT id FROM kb_sources WHERE parent = ?", current.id).toArray())
      ids.push(String(child.id));
    for (const id of ids) {
      clearChunks(db, id);
      db.sql.exec("DELETE FROM kb_sources WHERE id = ?", id);
      db.sql.exec("DELETE FROM meta WHERE key = ?", "knowledge.context.source:" + id);
    }
  });
  return { removed: true };
}
export function listSources(
  db: KnowledgeDb,
  args: {
    after?: unknown;
    q?: unknown;
    kind?: unknown;
    status?: unknown;
  },
): KnowledgeOverview {
  const after =
    typeof args.after === "string" && SOURCE_ID.test(args.after)
      ? args.after
      : "";
  const query = args.q == null ? "" : args.q;
  const kind = args.kind == null ? "" : args.kind;
  const status = args.status == null ? "" : args.status;
  if (
    typeof query !== "string" ||
    query.length > 120 ||
    typeof kind !== "string" ||
    typeof status !== "string" ||
    !["", "doc", "faq", "file", "saved-reply"].includes(kind) ||
    !["", "pending", "ready", "failed", "archived"].includes(status)
  )
    throw new KnowledgeError(
      400,
      "knowledge-filter",
      "Choose valid source filters.",
    );
  const clauses = ["id > ?"];
  const values: (string | number)[] = [after];
  const search = query.trim().toLowerCase();
  if (kind === "file") clauses.push("origin = 'upload'");
  else if (kind) {
    clauses.push("kind = ?");
    values.push(String(kind));
    if (kind === "doc") clauses.push("origin <> 'upload'");
  }
  if (status) {
    clauses.push("status = ?");
    values.push(String(status));
  }
  const rows = db.sql
    .exec(
      `SELECT * FROM kb_sources WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
      ...values,
      search ? KNOWLEDGE_LIMITS.sources + 1 : KNOWLEDGE_LIMITS.listPage + 1,
    )
    .toArray() as SourceRow[];
  if (search && rows.length > KNOWLEDGE_LIMITS.sources)
    throw new KnowledgeError(503, "knowledge-source-limit", "Source search is unavailable. Try again later.");
  // The source cap bounds this read. Fold both sides in JavaScript so
  // non-ASCII titles follow the same case rules as the query.
  const matched = search
    ? rows.filter(row =>
        String(row.title).toLowerCase().includes(search) ||
        String(row.url ?? "").toLowerCase().includes(search))
    : rows;
  const page = matched.slice(0, KNOWLEDGE_LIMITS.listPage);
  const counts = db.sql
    .exec(
      "SELECT COUNT(*) AS sources, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM kb_sources",
    )
    .toArray()[0];
  const chunks = Number(
    db.sql.exec("SELECT COUNT(*) AS n FROM kb_chunks").toArray()[0]?.n ?? 0,
  );
  return {
    sources: page.map((row) => view(db, row)),
    counts: {
      sources: Number(counts?.sources ?? 0),
      chunks,
      failed: Number(counts?.failed ?? 0),
    },
    next:
      matched.length > KNOWLEDGE_LIMITS.listPage ? page[page.length - 1].id : null,
  };
}

function clearChunks(db: KnowledgeDb, sourceId: string) {
  writeMeta(db, "knowledge.context.source:" + sourceId, randomHex(16));
  db.sql.exec("DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE source_id = ?)", sourceId);
  db.sql.exec("DELETE FROM kb_chunks WHERE source_id = ?", sourceId);
}
/** Splits text into chunks of about 1,200 characters on paragraph and
 * sentence breaks, at most 200 per source. */
export function chunkText(text: string): string[] {
  const max = KNOWLEDGE_LIMITS.chunkChars;
  const parts = text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const part of parts) {
    const pieces =
      part.length <= max ? [part] : part.split(/(?<=[.!?])\s+/).flatMap((s) =>
        s.length <= max ? [s] : s.match(new RegExp(`.{1,${max}}`, "g")) ?? [],
      );
    for (const piece of pieces) {
      if (current.length + piece.length + 1 > max) push();
      current += (current ? " " : "") + piece;
    }
    if (current.length > max * 0.6) push();
    if (chunks.length >= KNOWLEDGE_LIMITS.chunksPerSource) break;
  }
  push();
  return chunks.slice(0, KNOWLEDGE_LIMITS.chunksPerSource);
}
export function replaceChunks(db: KnowledgeDb, sourceId: string, title: string, text: string) {
  db.transaction(() => {
    clearChunks(db, sourceId);
    chunkText(text).forEach((chunk, index) => {
      const id = `${sourceId}-${index + 1}`;
      db.sql.exec(
        "INSERT INTO kb_chunks (id, source_id, seq, text) VALUES (?, ?, ?, ?)",
        id,
        sourceId,
        index + 1,
        chunk,
      );
      db.sql.exec("INSERT INTO kb_fts (text, title, chunk_id) VALUES (?, ?, ?)", chunk, title, id);
    });
  });
}
/** Stores a page's fetched text, or records why it could not be read. A
 * page that is gone keeps its last copy, marked archived. */
export function recordFetch(
  db: KnowledgeDb,
  id: string,
  outcome:
    | { kind: "text"; title: string | null; text: string; etag: string | null; sha256: string }
    | { kind: "unchanged" }
    | { kind: "gone" }
    | { kind: "failed"; error: string },
  now: number,
) {
  const row = sourceRow(db, id);
  if (!row) return;
  const next = now + 24 * HOUR_MS;
  if (outcome.kind === "text") {
    const title = outcome.title?.slice(0, KNOWLEDGE_LIMITS.titleChars).trim() || row.title;
    if (outcome.sha256 !== row.body_sha256) replaceChunks(db, id, title, outcome.text);
    db.sql.exec(
      "UPDATE kb_sources SET status = 'ready', error = NULL, etag = ?, body_sha256 = ?, title = ?, last_fetch_at = ?, next_fetch_at = ?, archived_at = NULL, updated_at = ? WHERE id = ?",
      outcome.etag,
      outcome.sha256,
      title,
      now,
      next,
      now,
      id,
    );
  } else if (outcome.kind === "unchanged")
    db.sql.exec(
      "UPDATE kb_sources SET status = CASE WHEN archived_at IS NULL THEN 'ready' ELSE status END, last_fetch_at = ?, next_fetch_at = ? WHERE id = ?",
      now,
      next,
      id,
    );
  else if (outcome.kind === "gone")
    db.sql.exec(
      "UPDATE kb_sources SET status = CASE WHEN body_sha256 IS NULL THEN 'failed' ELSE 'archived' END, error = CASE WHEN body_sha256 IS NULL THEN 'gone' ELSE NULL END, archived_at = COALESCE(archived_at, ?), last_fetch_at = ?, next_fetch_at = ?, updated_at = ? WHERE id = ?",
      now,
      now,
      next,
      now,
      id,
    );
  else
    db.sql.exec(
      "UPDATE kb_sources SET status = CASE WHEN body_sha256 IS NULL THEN 'failed' ELSE status END, error = ?, last_fetch_at = ?, next_fetch_at = ? WHERE id = ?",
      outcome.error,
      now,
      next,
      id,
    );
}
export function dueSources(db: KnowledgeDb, now: number, limit: number): SourceRow[] {
  return db.sql
    .exec(
      "SELECT * FROM kb_sources WHERE kind = 'doc' AND origin <> 'upload' AND next_fetch_at IS NOT NULL AND next_fetch_at <= ? ORDER BY next_fetch_at LIMIT ?",
      now,
      limit,
    )
    .toArray() as SourceRow[];
}
export function nextDue(db: KnowledgeDb): number | null {
  const row = db.sql
    .exec("SELECT MIN(next_fetch_at) AS at FROM kb_sources WHERE kind = 'doc' AND origin <> 'upload' AND next_fetch_at IS NOT NULL")
    .toArray()[0];
  return row?.at === null || row?.at === undefined ? null : Number(row.at);
}

/* ---------------------------------------------------------------------- */
/* Query                                                                   */
/* ---------------------------------------------------------------------- */

export type KnowledgeQueryArgs = {
  text: string;
  limit?: number;
  eras?: readonly KnowledgeEraTag[];
  addresses?: readonly string[];
  audience?: "member" | "team";
  storageGrant?: StorageUploadGrant | null;
  now?: number;
};
/** A stable page of complete current sources. Source edits invalidate later pages. */
export async function readKnowledgeContext(
  db: KnowledgeDb,
  args: { after?: unknown; version?: unknown; storageGrant?: StorageUploadGrant | null; now?: number },
): Promise<KnowledgeContextPage> {
  const after = args.after === undefined ? null : typeof args.after === "string"
    ? /^(kb-[a-f0-9]{16}):([1-9][0-9]{0,2})$/.exec(args.after) : null;
  if ((args.after !== undefined && (!after || Number(after[2]) > KNOWLEDGE_LIMITS.chunksPerSource)) ||
      (args.version !== undefined && (typeof args.version !== "string" || !/^[a-f0-9]{64}$/.test(args.version))) ||
      (after && args.version === undefined))
    throw new KnowledgeError(400, "knowledge-context-cursor", "Use the previous knowledge page and version.");
  const uploadsAllowed = brainUploadUseAllowed(db, args.storageGrant, args.now ?? Date.now());
  const allowed = "s.era = 'current' AND s.visibility = 'member-safe' AND s.archived_at IS NULL AND s.status = 'ready' AND s.kind IN ('doc', 'faq', 'saved-reply') AND (s.origin <> 'upload' OR ? = 1)";
  const snapshot = db.transaction(() => ({
    sources: db.sql.exec(
      `SELECT s.id, s.kind, s.title, s.url, s.origin, s.updated_at, s.body_sha256, (SELECT value FROM meta WHERE key = 'knowledge.context.source:' || s.id) AS generation FROM kb_sources s WHERE ${allowed} ORDER BY s.id`,
      uploadsAllowed ? 1 : 0,
    ).toArray(),
    rows: db.sql.exec(
      `SELECT c.id AS chunk_id, c.seq AS chunk_seq, c.text, s.* FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE ${allowed} AND (s.id > ? OR (s.id = ? AND c.seq > ?)) ORDER BY s.id, c.seq LIMIT 65`,
      uploadsAllowed ? 1 : 0, after?.[1] ?? "", after?.[1] ?? "", after ? Number(after[2]) : 0,
    ).toArray(),
  }));
  const version = await sha256Hex(JSON.stringify({ uploadsAllowed, sources: snapshot.sources }));
  if (args.version !== undefined && args.version !== version)
    throw new KnowledgeError(409, "knowledge-context-changed", "Knowledge changed. Read it again from the first page.");
  const rows = snapshot.rows.slice(0, 64);
  const hits: KnowledgeContextPage["hits"] = rows.map((row) => {
    const excerpt = hideAmbiguousHex(String(row.text));
    if (!excerpt.trim() || excerpt.length > KNOWLEDGE_LIMITS.chunkChars)
      throw new KnowledgeError(503, "knowledge-context-invalid", "A knowledge source cannot be read completely.");
    return {
      sourceId: `kb:${row.chunk_id}`, kind: row.kind as KnowledgeContextPage["hits"][number]["kind"],
      title: hideAmbiguousHex(String(row.title)), excerpt,
      ...(row.kind === "doc" && row.url ? { url: hideAmbiguousHex(String(row.url)) } : {}),
      era: "current", visibility: "member-safe", updatedAt: iso(Number(row.updated_at)),
    };
  });
  const last = rows.at(-1);
  return { hits, nextCursor: snapshot.rows.length > 64 && last ? `${last.id}:${last.chunk_seq}` : null, version };
}

function ftsQuery(text: string): string | null {
  const words = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 12),
    ),
  ];
  return words.length ? words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" OR ") : null;
}
function normalizeAddresses(list: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const value = String(raw).trim();
    const address = profileAddress("eip155:1", value) ?? profileAddress("solana", value);
    if (address) out.add(address);
  }
  return out;
}
export function queryKnowledgeBase(db: KnowledgeDb, args: KnowledgeQueryArgs): KnowledgeHitRow[] {
  if (typeof args.text !== "string" || !args.text.trim() || args.text.length > KNOWLEDGE_LIMITS.queryChars)
    throw new KnowledgeError(400, "knowledge-query", "Ask with up to 500 characters.");
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, KNOWLEDGE_LIMITS.queryLimit));
  const eras = new Set(args.eras?.length ? args.eras : ["current"]);
  const addresses = normalizeAddresses(args.addresses);
  const team = args.audience === "team";
  const uploadsAllowed = brainUploadUseAllowed(db, args.storageGrant, args.now ?? Date.now());
  const hits: (KnowledgeHitRow & { rank: number })[] = [];
  const match = ftsQuery(args.text);
  if (match) {
    const rows = db.sql
      .exec(
        `SELECT kb_fts.chunk_id AS chunk_id, bm25(kb_fts) AS rank, c.text AS text, s.*
         FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.chunk_id JOIN kb_sources s ON s.id = c.source_id
         WHERE kb_fts MATCH ? ORDER BY rank LIMIT 60`,
        match,
      )
      .toArray();
    for (const row of rows) {
      if (row.origin === "upload" && !uploadsAllowed) continue;
      const era = row.era as KnowledgeEraTag;
      if (!eras.has(era)) continue;
      if (era === "legacy") {
        const listed = parseAddresses(String(row.addresses));
        if (!listed.some((address) => addresses.has(address))) continue;
      }
      if (!team && row.visibility !== "member-safe") continue;
      hits.push({
        sourceId: `kb:${row.chunk_id}`,
        kind: row.kind as KnowledgeHitRow["kind"],
        title: String(row.title),
        excerpt: hideAmbiguousHex(String(row.text)).slice(0, KNOWLEDGE_LIMITS.excerptChars),
        ...(row.kind === "doc" && row.url ? { url: String(row.url) } : {}),
        era,
        visibility: row.visibility as ProfileVisibility,
        updatedAt: iso(Number(row.updated_at)),
        ...(row.archived_at !== null && row.archived_at !== undefined
          ? { archivedAt: iso(Number(row.archived_at)) }
          : {}),
        rank: Number(row.rank),
      });
    }
  }
  // Profile entries by label, product or symbol words.
  const words = (args.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 6);
  const seen = new Set<string>();
  for (const word of words) {
    const rows = db.sql
      .exec(
        "SELECT * FROM profile_contracts WHERE lower(label) LIKE ? OR product = ? OR lower(symbol) = ? LIMIT 10",
        `%${word.replace(/[%_]/g, "")}%`,
        word,
        word,
      )
      .toArray();
    for (const row of rows) {
      const key = `${row.network}:${row.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const era: KnowledgeEraTag = row.status === "live" ? "current" : "legacy";
      if (!eras.has(era)) continue;
      if (era === "legacy" && !addresses.has(String(row.address))) continue;
      if (!team && row.visibility !== "member-safe") continue;
      const status = String(row.status);
      hits.push({
        sourceId: `profile:${key}`,
        kind: "profile",
        title: String(row.label),
        excerpt: hideAmbiguousHex([
          `${row.label} (${row.kind}, ${status})`,
          row.last_supported_on ? `Last supported ${row.last_supported_on}.` : "",
          row.migration_doc_url ? `Migration guide: ${row.migration_doc_url}` : "",
        ]
          .filter(Boolean)
          .join(" "))
          .slice(0, KNOWLEDGE_LIMITS.excerptChars),
        ...(row.migration_doc_url ? { url: String(row.migration_doc_url) } : {}),
        era,
        visibility: row.visibility as ProfileVisibility,
        updatedAt: iso(Number(row.updated_at)),
        rank: 0,
      });
    }
  }
  return hits
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ rank: _rank, ...hit }) => ({
      ...hit,
      title: hideAmbiguousHex(hit.title),
      excerpt: hideAmbiguousHex(hit.excerpt),
      ...(hit.url ? { url: hideAmbiguousHex(hit.url) } : {}),
    }));
}

/** Who may see each cited source: `profile:<network>:<address>`,
 * `metric:<id>` and `kb:<chunk>`. Anything else, or a source that is gone,
 * is "unknown". */
export function sourceVisibilities(
  db: KnowledgeDb,
  ids: unknown,
  grant?: unknown,
  now = Date.now(),
): Record<string, ProfileVisibility | "unknown"> {
  const out: Record<string, ProfileVisibility | "unknown"> = {};
  if (!Array.isArray(ids)) return out;
  const uploadsAllowed = brainUploadUseAllowed(db, grant, now);
  for (const raw of ids.slice(0, 40)) {
    const id = String(raw);
    let visibility: string | undefined;
    const profile = /^profile:(eip155:[1-9][0-9]*|solana):(.+)$/.exec(id);
    const metric = /^metric:([a-z0-9][a-z0-9-]{0,39})$/.exec(id);
    const chunk = /^kb:(kb-[0-9a-f]{16}-[1-9][0-9]{0,3})$/.exec(id);
    if (profile)
      visibility = db.sql
        .exec("SELECT visibility FROM profile_contracts WHERE network = ? AND address = ?", profile[1], profile[2])
        .toArray()[0]?.visibility as string | undefined;
    else if (metric) {
      const row = db.sql.exec("SELECT json FROM profile_metrics WHERE id = ?", metric[1]).toArray()[0];
      try {
        visibility = row ? (JSON.parse(String(row.json)).visibility as string) : undefined;
      } catch {
        visibility = undefined;
      }
    } else if (chunk) {
      const row = db.sql.exec(
        "SELECT s.visibility AS visibility, s.origin AS origin FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE c.id = ?",
        chunk[1],
      ).toArray()[0];
      visibility = row?.origin === "upload" && !uploadsAllowed ? undefined : row?.visibility as string | undefined;
    }
    out[id] = PROFILE_VISIBILITY.includes(visibility as ProfileVisibility)
      ? (visibility as ProfileVisibility)
      : "unknown";
  }
  return out;
}
