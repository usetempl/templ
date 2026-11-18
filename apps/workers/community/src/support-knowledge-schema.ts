/** The SupportKnowledge object's SQLite schema. One object per workspace
 * holds the eval store (v1), the protocol profile (v2), the knowledge
 * base with its full-text index (v3) and the improvement copy (v4).
 *
 * Versioning fails closed: an object whose applied schema is newer than
 * this code answers 503 and reads nothing; missing migrations apply in
 * order inside one transaction, and any failure rolls back and answers 503.
 * Every row read goes through a checker; an invalid row is skipped, counted
 * and logged by table and key, never by content. */

/** The part of the Durable Object SQL API the store uses. Tests pass an
 * adapter over node:sqlite. */
export type KnowledgeSqlValue = string | number | null;
export type KnowledgeSql = {
  exec(
    query: string,
    ...bindings: KnowledgeSqlValue[]
  ): { toArray(): Record<string, unknown>[] };
};
export type KnowledgeDb = {
  sql: KnowledgeSql;
  /** Runs `fn` in one transaction: all of it commits or none. */
  transaction<T>(fn: () => T): T;
};

// Schema v5 includes retained-upload usage and independent price reviews.
export const KNOWLEDGE_SCHEMA_VERSION = 5;
/** The improvement copy's tables (support-knowledge-corpus.ts), deleted
 * before everything else when the object is purged. */
export const CORPUS_TABLES = ["audit_labels", "corpus_cases"] as const;

export class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}
export const KNOWLEDGE_UPGRADING =
  "Support knowledge is being upgraded. Try again later.";

const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE eval_cases (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
  origin TEXT NOT NULL, saved_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  category TEXT, labels TEXT NOT NULL, body TEXT NOT NULL,
  source_link TEXT, saved_by TEXT
);
CREATE INDEX eval_by_state ON eval_cases (state, saved_at);
CREATE INDEX eval_by_source ON eval_cases (source_link);
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY, client_run_id TEXT NOT NULL UNIQUE, posted_at INTEGER NOT NULL,
  poster TEXT NOT NULL, agent_name TEXT NOT NULL, agent_version TEXT NOT NULL,
  model TEXT, prompt_sha256 TEXT, scorer TEXT NOT NULL, scorer_version TEXT NOT NULL,
  set_name TEXT NOT NULL, exported_at TEXT NOT NULL, unknown_cases INTEGER NOT NULL
);
CREATE INDEX eval_runs_by_time ON eval_runs (posted_at);
CREATE INDEX eval_runs_by_agent ON eval_runs (agent_name, posted_at);
CREATE TABLE eval_results (
  run_id TEXT NOT NULL, eval_id TEXT NOT NULL, case_version INTEGER NOT NULL,
  pass INTEGER NOT NULL, items TEXT NOT NULL, action TEXT, output TEXT,
  output_refused TEXT, notes TEXT,
  PRIMARY KEY (run_id, eval_id)
) WITHOUT ROWID;
CREATE INDEX eval_results_by_case ON eval_results (eval_id);
`,
  2: `
CREATE TABLE profile_contracts (
  network TEXT NOT NULL, address TEXT NOT NULL,
  label TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  generation TEXT, product TEXT, symbol TEXT, decimals INTEGER,
  successor_network TEXT, successor_address TEXT,
  underlying_network TEXT, underlying_address TEXT, conversion TEXT,
  migration_doc_url TEXT, last_supported_on TEXT, abi_id TEXT,
  staff_note TEXT, visibility TEXT NOT NULL,
  source TEXT NOT NULL, registry_missing_since INTEGER,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY (network, address)
) WITHOUT ROWID;
CREATE INDEX profile_by_status ON profile_contracts (status, network);
CREATE INDEX profile_by_kind ON profile_contracts (kind, network);
CREATE INDEX profile_by_product ON profile_contracts (product);
CREATE INDEX profile_by_label ON profile_contracts (label COLLATE NOCASE);
CREATE TABLE profile_metrics (
  id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE profile_abis (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, json TEXT NOT NULL,
  functions INTEGER NOT NULL, events INTEGER NOT NULL, errors INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE TABLE profile_imports (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, origin TEXT NOT NULL,
  status TEXT NOT NULL, applied INTEGER NOT NULL
);
CREATE TABLE profile_import_rows (
  import_id TEXT NOT NULL, n INTEGER NOT NULL, row TEXT, error TEXT,
  PRIMARY KEY (import_id, n)
) WITHOUT ROWID;
CREATE TABLE profile_sync_log (
  at INTEGER PRIMARY KEY, trigger TEXT NOT NULL, result TEXT NOT NULL
);
`,
  3: `
CREATE TABLE kb_sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
  era TEXT NOT NULL, visibility TEXT NOT NULL, addresses TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, etag TEXT, body_sha256 TEXT,
  last_fetch_at INTEGER, next_fetch_at INTEGER, archived_at INTEGER,
  updated_at INTEGER NOT NULL, parent TEXT
);
CREATE INDEX kb_sources_due ON kb_sources (next_fetch_at);
CREATE TABLE kb_chunks (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, seq INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX kb_chunks_by_source ON kb_chunks (source_id, seq);
CREATE VIRTUAL TABLE kb_fts USING fts5(text, title, chunk_id UNINDEXED, tokenize = 'porter unicode61');
`,
  4: `
CREATE TABLE corpus_cases (
  ref TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL,
  rules TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX corpus_by_created ON corpus_cases (created);
CREATE INDEX corpus_by_expiry ON corpus_cases (expires);
CREATE TABLE audit_labels (
  ref TEXT PRIMARY KEY, label TEXT NOT NULL, reason TEXT NOT NULL,
  rules TEXT NOT NULL, at INTEGER NOT NULL
);
`,
  5: `
ALTER TABLE kb_sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'unclassified';
CREATE TABLE kb_upload_bytes (source_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK (bytes >= 0));
CREATE TABLE kb_storage_meter (id INTEGER PRIMARY KEY CHECK (id = 1), measured_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE kb_storage_months (month TEXT NOT NULL, scope TEXT NOT NULL, byte_ms TEXT NOT NULL, PRIMARY KEY (month, scope)) WITHOUT ROWID;
CREATE TABLE kb_storage_authorizations (id TEXT PRIMARY KEY, record TEXT NOT NULL);
`,
};

const splitStatements = (script: string) =>
  script
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);

/** Applies missing migrations, or refuses a schema newer than this code. */
export function ensureSchema(
  db: KnowledgeDb,
  now: number,
  target = KNOWLEDGE_SCHEMA_VERSION,
): number {
  db.sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const rows = db.sql
    .exec("SELECT MAX(version) AS version FROM schema_migrations")
    .toArray();
  const applied = Number(rows[0]?.version ?? 0) || 0;
  if (applied > target)
    throw new KnowledgeError(503, "knowledge-schema-newer", KNOWLEDGE_UPGRADING);
  if (applied === target) return applied;
  try {
    db.transaction(() => {
      for (let version = applied + 1; version <= target; version++) {
        const script = MIGRATIONS[version];
        if (!script) throw new Error(`missing migration ${version}`);
        for (const statement of splitStatements(script))
          db.sql.exec(statement);
        db.sql.exec(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          version,
          now,
        );
      }
    });
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    console.error("TEMPL_KNOWLEDGE_MIGRATION_FAILED", { from: applied, to: target });
    throw new KnowledgeError(
      503,
      "knowledge-migration-failed",
      KNOWLEDGE_UPGRADING,
    );
  }
  return target;
}

export function readMeta(db: KnowledgeDb, key: string): string | null {
  const row = db.sql
    .exec("SELECT value FROM meta WHERE key = ?", key)
    .toArray()[0];
  return typeof row?.value === "string" ? row.value : null;
}
export function writeMeta(db: KnowledgeDb, key: string, value: string) {
  db.sql.exec(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}
export function readMetaJson<T>(db: KnowledgeDb, key: string): T | null {
  const value = readMeta(db, key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Counts skipped rows for one call and logs each table and key once. */
export class RowSkips {
  count = 0;
  private logged = new Set<string>();
  skip(table: string, key: string) {
    this.count++;
    const id = `${table}:${key}`;
    if (this.logged.has(id)) return;
    this.logged.add(id);
    console.warn("TEMPL_KNOWLEDGE_ROW_SKIPPED", { table, key });
  }
}

export const randomHex = (bytes = 8) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
export const iso = (at: number) => new Date(at).toISOString();
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Everything the object holds, for a deleted workspace: the improvement
 * copy, eval copies and runs first, then the profile, the knowledge base
 * and the metadata. */
export function purgeAll(db: KnowledgeDb) {
  db.transaction(() => {
    for (const table of [
      ...CORPUS_TABLES,
      "eval_results",
      "eval_runs",
      "eval_cases",
      "profile_import_rows",
      "profile_imports",
      "profile_sync_log",
      "profile_abis",
      "profile_metrics",
      "profile_contracts",
      "kb_storage_authorizations",
      "kb_storage_months",
      "kb_storage_meter",
      "kb_upload_bytes",
      "kb_fts",
      "kb_chunks",
      "kb_sources",
    ])
      db.sql.exec(`DELETE FROM ${table}`);
    db.sql.exec("DELETE FROM meta WHERE key <> 'room'");
  });
}
