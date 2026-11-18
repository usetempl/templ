/** The improvement copy inside the workspace's SupportKnowledge object
 * (schema v4): `corpus_cases` holds rows by ref, `audit_labels` the shadow
 * label of each row. Rows arrive only from the workspace's own room
 * (`corpus.add`), are checked again here and are refused when any text
 * still holds something the rules would replace. Templ's corpus readers
 * reach rows only through `/corpus/read`, which returns rows without their
 * ref and answers nothing else.
 *
 * Retention: `CORPUS_LIMITS.retentionDays` after a row is built, the oldest
 * past `rowsPerWorkspace`, rows of any other rule version, and every row
 * with the workspace's support content or the workspace itself. */
import { CORPUS_LIMITS } from "@templ/chat/plans";
import {
  CORPUS_RULES,
  checkedCorpusCase,
  corpusTexts,
  type CorpusCase,
} from "@templ/chat/support-corpus";
import { corpusResiduals } from "@templ/chat/support-corpus-build";
import type { KnowledgeRequest } from "./support-knowledge";
import {
  CORPUS_TABLES,
  DAY_MS,
  KnowledgeError,
  readMeta,
  readMetaJson,
  type KnowledgeDb,
} from "./support-knowledge-schema";

const REF = /^[0-9a-f]{64}$/;

/** Addresses and hosts the row may keep: profile entries members may see,
 * and the workspace's official hosts. */
function keeps(db: KnowledgeDb) {
  const keepAddresses = new Set<string>();
  for (const row of db.sql
    .exec("SELECT network, address FROM profile_contracts WHERE visibility = 'member-safe'")
    .toArray())
    keepAddresses.add(
      String(row.network).startsWith("eip155:")
        ? String(row.address).toLowerCase()
        : String(row.address),
    );
  const keepHosts = new Set<string>();
  for (const origin of readMetaJson<string[]>(db, "profile.officialUrls") ?? [])
    try {
      keepHosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      /* not a URL */
    }
  return { keepAddresses, keepHosts };
}

export function corpusAdd(db: KnowledgeDb, args: Record<string, unknown>, now: number) {
  const ref = args.ref;
  if (typeof ref !== "string" || !REF.test(ref))
    throw new KnowledgeError(400, "corpus-ref", "Invalid row.");
  const row = checkedCorpusCase(args.row);
  if (!row) throw new KnowledgeError(400, "corpus-row", "Invalid row.");
  const keep = keeps(db);
  const kinds = new Set<string>();
  for (const text of corpusTexts(row))
    for (const kind of corpusResiduals(text, keep)) kinds.add(kind);
  if (kinds.size)
    throw new KnowledgeError(422, "corpus-not-deidentified", "The row still holds an identifier.", {
      kinds: [...kinds].sort(),
    });
  const body = JSON.stringify(row);
  db.transaction(() => {
    db.sql.exec(
      `INSERT INTO corpus_cases (ref, created, expires, rules, body) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ref) DO UPDATE SET created = excluded.created, expires = excluded.expires,
       rules = excluded.rules, body = excluded.body`,
      ref,
      now,
      now + CORPUS_LIMITS.retentionDays * DAY_MS,
      CORPUS_RULES,
      body,
    );
    db.sql.exec(
      `INSERT INTO audit_labels (ref, label, reason, rules, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ref) DO UPDATE SET label = excluded.label, reason = excluded.reason,
       rules = excluded.rules, at = excluded.at`,
      ref,
      row.shadow.label,
      row.shadow.reason,
      CORPUS_RULES,
      now,
    );
    const over =
      Number(db.sql.exec("SELECT COUNT(*) AS n FROM corpus_cases").toArray()[0]?.n ?? 0) -
      CORPUS_LIMITS.rowsPerWorkspace;
    if (over > 0) {
      const old = db.sql
        .exec("SELECT ref FROM corpus_cases ORDER BY created, ref LIMIT ?", over)
        .toArray()
        .map((r) => String(r.ref));
      for (const id of old) deleteRef(db, id);
    }
  });
  return { added: true };
}
function deleteRef(db: KnowledgeDb, ref: string) {
  const before = Number(
    db.sql.exec("SELECT COUNT(*) AS n FROM corpus_cases WHERE ref = ?", ref).toArray()[0]?.n ?? 0,
  );
  db.sql.exec("DELETE FROM corpus_cases WHERE ref = ?", ref);
  db.sql.exec("DELETE FROM audit_labels WHERE ref = ?", ref);
  return before;
}
export function corpusDeleteRefs(db: KnowledgeDb, args: Record<string, unknown>) {
  const refs = args.refs;
  if (!Array.isArray(refs) || refs.length > 400 || !refs.every((ref) => typeof ref === "string" && REF.test(ref)))
    throw new KnowledgeError(400, "corpus-ref", "Invalid rows.");
  let deleted = 0;
  db.transaction(() => {
    for (const ref of new Set(refs as string[])) deleted += deleteRef(db, ref);
  });
  return { deleted };
}
export function corpusStats(db: KnowledgeDb) {
  return {
    rows: Number(db.sql.exec("SELECT COUNT(*) AS n FROM corpus_cases").toArray()[0]?.n ?? 0),
  };
}
export function purgeCorpus(db: KnowledgeDb) {
  db.transaction(() => {
    for (const table of CORPUS_TABLES) db.sql.exec(`DELETE FROM ${table}`);
  });
  return { purged: true };
}
/** Daily: expired rows, rows of another rule version, and labels left
 * without a row. */
export function corpusRetention(db: KnowledgeDb, now: number) {
  db.transaction(() => {
    db.sql.exec("DELETE FROM corpus_cases WHERE expires <= ? OR rules <> ?", now, CORPUS_RULES);
    db.sql.exec("DELETE FROM audit_labels WHERE ref NOT IN (SELECT ref FROM corpus_cases)");
  });
}

const parsed = (body: unknown): CorpusCase | null => {
  try {
    return checkedCorpusCase(JSON.parse(String(body)));
  } catch {
    return null;
  }
};
/** A page cursor: a build time, and how many rows built at that time the
 * reader has already read. Rows of one build time come in ref order. */
const CURSOR = /^(\d{1,16})(?:-(\d{1,6}))?$/;
/** A corpus reader's page: rows built at or after the cursor, oldest first,
 * or the one row a dispute names by `ref`, or `sample` random rows. Rows
 * come back without their ref; `next` is the cursor to continue from. */
export function corpusRead(db: KnowledgeDb, args: Record<string, unknown>) {
  const limit = Math.max(1, Math.min(Number(args.limit) || CORPUS_LIMITS.rowsPerRead, CORPUS_LIMITS.rowsPerRead));
  let rows: Record<string, unknown>[];
  let next: string | null = null;
  if (typeof args.ref === "string") {
    if (!REF.test(args.ref)) throw new KnowledgeError(400, "corpus-ref", "Invalid row.");
    rows = db.sql.exec("SELECT created, body FROM corpus_cases WHERE ref = ?", args.ref).toArray();
  } else if (args.sample === true) {
    rows = db.sql.exec("SELECT created, body FROM corpus_cases ORDER BY random() LIMIT ?", limit).toArray();
  } else {
    const cursor = CURSOR.exec(String(args.since ?? "0"));
    if (!cursor) throw new KnowledgeError(400, "corpus-cursor", "Invalid cursor.");
    const since = Number(cursor[1]);
    const skip = Number(cursor[2] ?? 0);
    rows = db.sql
      .exec(
        "SELECT created, body FROM corpus_cases WHERE created >= ? ORDER BY created, ref LIMIT ? OFFSET ?",
        since,
        limit,
        skip,
      )
      .toArray();
    if (rows.length === limit) {
      const last = Number(rows.at(-1)!.created);
      const same = rows.filter((row) => Number(row.created) === last).length;
      next = `${last}-${same + (last === since ? skip : 0)}`;
    }
  }
  const out = rows.map((row) => parsed(row.body)).filter((row): row is CorpusCase => row !== null);
  return { rows: out, next };
}

/** The corpus ops a room may call, or undefined for any other op. The
 * eval purge (`purge`, when the workspace's support content is deleted)
 * takes the copy with it. */
export function corpusOperation(db: KnowledgeDb, request: KnowledgeRequest, now: number) {
  switch (request.op) {
    case "corpus.add":
      return corpusAdd(db, request.args, now);
    case "corpus.deleteRefs":
      return corpusDeleteRefs(db, request.args);
    case "corpus.stats":
      return corpusStats(db);
    case "corpus.purge":
      return purgeCorpus(db);
    case "purge":
      purgeCorpus(db);
      return undefined;
    default:
      return undefined;
  }
}
/** `/corpus/read`, for the operator route only: the room it names must be
 * the one this object belongs to. An object no room has used has no rows. */
export function corpusReadRequest(db: KnowledgeDb, body: Record<string, unknown>) {
  const bound = readMeta(db, "room");
  if (bound === null) return { rows: [], next: null };
  if (typeof body.room !== "string" || bound !== body.room)
    throw new KnowledgeError(409, "knowledge-room", "Unknown workspace.");
  return corpusRead(db, body);
}
