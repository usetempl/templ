/** The eval store inside SupportKnowledge: de-identified cases, their
 * states, runs posted back by a team's agent, and retention.
 *
 * The room has already checked the caller's current access and screened
 * text for recovery phrases and identifiers; this module keeps shapes,
 * caps, idempotency and retention. A stored case never holds a thread id,
 * principal, name or link in its body; `source_link` and `saved_by` are
 * internal columns, never exported. */
import {
  EVAL_LIMITS,
  EVAL_SCHEMA,
  checkedEvalBody,
  checkedEvalCase,
  residualIdentifiers,
  residualInBody,
  evalTexts,
  type EvalCase,
  type EvalCaseBody,
  type EvalCaseSummary,
  type EvalOrigin,
  type EvalRunInput,
  type EvalRunView,
  type EvalState,
} from "@templ/chat/support-eval";
import {
  RUBRIC_ITEMS,
  type RubricItem,
  type RubricScore,
} from "@templ/chat/support-quality";
import { hideAmbiguousHex } from "@templ/chat/support-safety";
import { detectStoredSecret } from "./secret-guard";
import {
  DAY_MS,
  HOUR_MS,
  KnowledgeError,
  RowSkips,
  iso,
  isoDay,
  randomHex,
  type KnowledgeDb,
} from "./support-knowledge-schema";
import { profileAddressesIn } from "./support-knowledge-profile";

const EVAL_ID = /^ev-[0-9a-f]{16}$/;
const RUN_ID = /^run-[0-9a-f]{16}$/;
const LINK = /^tc-[0-9a-f]{32}:[1-9][0-9]{0,7}:[1-9][0-9]{0,14}$/;
const THREAD = /^tc-[0-9a-f]{32}$/;
const PAGE = 50;
const RUN_PAGE = 20;

type EvalRow = {
  id: string;
  version: number;
  state: string;
  origin: string;
  saved_at: number;
  updated_at: number;
  category: string | null;
  labels: string;
  body: string;
  source_link: string | null;
  saved_by: string | null;
};
function rowCase(row: EvalRow, skips: RowSkips): EvalCase | null {
  let body: unknown;
  try {
    body = JSON.parse(row.body);
  } catch {
    skips.skip("eval_cases", row.id);
    return null;
  }
  const c = checkedEvalCase({
    ...(body as object),
    schema: EVAL_SCHEMA,
    id: row.id,
    version: row.version,
    state: row.state,
    origin: row.origin,
    savedOn: isoDay(row.saved_at),
    updatedOn: isoDay(row.updated_at),
  });
  if (!c) skips.skip("eval_cases", row.id);
  return c;
}
const summary = (
  c: EvalCase,
  last: EvalCaseSummary["lastResult"],
): EvalCaseSummary => ({
  id: c.id,
  version: c.version,
  state: c.state,
  origin: c.origin,
  savedOn: c.savedOn,
  category: c.category,
  labels: c.labels,
  firstTurn: (c.input.turns.find((turn) => turn.role === "member")?.text ??
    c.input.turns[0].text).slice(0, 80),
  lastResult: last,
});
const bodyOf = (c: EvalCaseBody): string =>
  JSON.stringify({
    category: c.category,
    tags: c.tags,
    handoffReason: c.handoffReason,
    diagnosisRules: c.diagnosisRules,
    labels: c.labels,
    input: c.input,
    evaluated: c.evaluated,
    expected: c.expected,
    notes: c.notes,
  });

export function evalCounts(db: KnowledgeDb) {
  const rows = db.sql
    .exec("SELECT state, COUNT(*) AS n FROM eval_cases GROUP BY state")
    .toArray();
  const counts = { candidate: 0, golden: 0, retired: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    if (row.state === "candidate" || row.state === "golden" || row.state === "retired")
      counts[row.state] += n;
    counts.total += n;
  }
  return counts;
}

export function saveEval(
  db: KnowledgeDb,
  args: {
    body: unknown;
    origin: EvalOrigin;
    sourceLink: string | null;
    savedBy: string | null;
    cap: number;
  },
  now: number,
): { id: string; state: EvalState } {
  const body = checkedEvalBody(args.body);
  if (!body)
    throw new KnowledgeError(400, "eval-invalid", "This eval case is too long or incomplete.");
  if (args.sourceLink !== null && !LINK.test(args.sourceLink))
    throw new KnowledgeError(400, "eval-invalid", "This eval case is too long or incomplete.");
  const { total } = evalCounts(db);
  if (total >= args.cap)
    throw new KnowledgeError(
      409,
      "eval-limit",
      `This workspace has ${total.toLocaleString("en-US")} eval cases. Delete old ones to save more.`,
      { count: total },
    );
  const id = `ev-${randomHex(8)}`;
  db.sql.exec(
    `INSERT INTO eval_cases (id, version, state, origin, saved_at, updated_at, category, labels, body, source_link, saved_by)
     VALUES (?, 1, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    args.origin,
    now,
    now,
    body.category,
    JSON.stringify(body.labels),
    bodyOf(body),
    args.sourceLink,
    args.savedBy,
  );
  return { id, state: "candidate" };
}

function lastResults(db: KnowledgeDb, ids: string[]) {
  const out = new Map<string, EvalCaseSummary["lastResult"]>();
  if (!ids.length) return out;
  const rows = db.sql
    .exec(
      `SELECT r.eval_id AS eval_id, r.pass AS pass, r.run_id AS run_id, runs.posted_at AS posted_at
       FROM eval_results r JOIN eval_runs runs ON runs.id = r.run_id
       WHERE r.eval_id IN (${ids.map(() => "?").join(",")})
       ORDER BY runs.posted_at DESC`,
      ...ids,
    )
    .toArray();
  for (const row of rows) {
    const id = String(row.eval_id);
    if (!out.has(id))
      out.set(id, {
        runId: String(row.run_id),
        pass: Number(row.pass) === 1,
        at: iso(Number(row.posted_at)),
      });
  }
  return out;
}

export function listEvals(
  db: KnowledgeDb,
  args: { state?: unknown; label?: unknown; category?: unknown; after?: unknown },
) {
  const where: string[] = [];
  const bind: (string | number)[] = [];
  if (typeof args.state === "string" && ["candidate", "golden", "retired"].includes(args.state)) {
    where.push("state = ?");
    bind.push(args.state);
  }
  if (typeof args.label === "string" && /^[a-z-]{1,40}$/.test(args.label)) {
    where.push("labels LIKE ?");
    bind.push(`%"${args.label}"%`);
  }
  if (typeof args.category === "string" && args.category.length <= 60) {
    where.push("category = ?");
    bind.push(args.category);
  }
  if (typeof args.after === "string") {
    const match = /^([0-9]{1,16}):(ev-[0-9a-f]{16})$/.exec(args.after);
    if (match) {
      where.push("(saved_at < ? OR (saved_at = ? AND id < ?))");
      bind.push(Number(match[1]), Number(match[1]), match[2]);
    }
  }
  const rows = db.sql
    .exec(
      `SELECT * FROM eval_cases ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY saved_at DESC, id DESC LIMIT ?`,
      ...bind,
      PAGE + 1,
    )
    .toArray() as EvalRow[];
  const skips = new RowSkips();
  const page = rows.slice(0, PAGE);
  const cases = page
    .map((row) => rowCase(row, skips))
    .filter((c): c is EvalCase => c !== null);
  const last = lastResults(db, cases.map((c) => c.id));
  const tail = page[page.length - 1];
  return {
    cases: cases.map((c) => summary(c, last.get(c.id) ?? null)),
    next: rows.length > PAGE && tail ? `${tail.saved_at}:${tail.id}` : null,
    counts: evalCounts(db),
    invalidRows: skips.count,
  };
}

function readRow(db: KnowledgeDb, id: unknown): EvalRow {
  if (typeof id !== "string" || !EVAL_ID.test(id))
    throw new KnowledgeError(404, "eval-not-found", "Eval case not found.");
  const row = db.sql.exec("SELECT * FROM eval_cases WHERE id = ?", id).toArray()[0] as
    | EvalRow
    | undefined;
  if (!row) throw new KnowledgeError(404, "eval-not-found", "Eval case not found.");
  return row;
}
export function getEval(db: KnowledgeDb, args: { id: unknown }) {
  const row = readRow(db, args.id);
  const skips = new RowSkips();
  const c = rowCase(row, skips);
  if (!c) throw new KnowledgeError(404, "eval-not-found", "Eval case not found.");
  const results = db.sql
    .exec(
      `SELECT r.*, runs.posted_at AS posted_at, runs.agent_name AS agent_name
       FROM eval_results r JOIN eval_runs runs ON runs.id = r.run_id
       WHERE r.eval_id = ? ORDER BY runs.posted_at DESC LIMIT 10`,
      c.id,
    )
    .toArray()
    .map((result) => ({
      runId: String(result.run_id),
      at: iso(Number(result.posted_at)),
      agent: String(result.agent_name),
      caseVersion: Number(result.case_version),
      pass: Number(result.pass) === 1,
      items: safeJson(result.items) as Record<RubricItem, RubricScore>,
    }));
  return {
    case: c,
    results,
    linked: row.source_link !== null,
    savedBy: row.saved_by,
  };
}
const safeJson = (value: unknown) => {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

export function updateEval(
  db: KnowledgeDb,
  args: { id: unknown; action: unknown; body?: unknown },
  now: number,
): { id: string; state: EvalState; version: number } {
  const row = readRow(db, args.id);
  let state = row.state as EvalState;
  let version = row.version;
  if (args.action === "promote") {
    if (state !== "golden") {
      if (evalCounts(db).golden >= EVAL_LIMITS.golden)
        throw new KnowledgeError(
          409,
          "eval-golden-limit",
          "The golden set holds 500 cases. Retire one to add another.",
        );
      state = "golden";
    }
  } else if (args.action === "retire") state = "retired";
  else if (args.action === "restore") state = "candidate";
  else if (args.action === "edit") {
    const body = checkedEvalBody(args.body);
    if (!body)
      throw new KnowledgeError(400, "eval-invalid", "This eval case is too long or incomplete.");
    version++;
    db.sql.exec(
      "UPDATE eval_cases SET body = ?, labels = ?, category = ?, version = ?, updated_at = ? WHERE id = ?",
      bodyOf(body),
      JSON.stringify(body.labels),
      body.category,
      version,
      now,
      row.id,
    );
    return { id: row.id, state, version };
  } else throw new KnowledgeError(400, "eval-action", "Choose an eval action.");
  db.sql.exec(
    "UPDATE eval_cases SET state = ?, updated_at = ? WHERE id = ?",
    state,
    now,
    row.id,
  );
  return { id: row.id, state, version };
}

export function deleteEval(db: KnowledgeDb, args: { id: unknown }) {
  const row = readRow(db, args.id);
  db.sql.exec("DELETE FROM eval_cases WHERE id = ?", row.id);
  return { deleted: true };
}

/** Eval copies saved from one thread (or one request of it), while the
 * thread still exists. */
export function evalsBySource(
  db: KnowledgeDb,
  args: { thread: unknown; seq?: unknown },
) {
  if (typeof args.thread !== "string" || !THREAD.test(args.thread)) return { evals: [] };
  const prefix =
    Number.isSafeInteger(args.seq) && (args.seq as number) >= 1
      ? `${args.thread}:${args.seq}:`
      : `${args.thread}:`;
  const rows = db.sql
    .exec(
      "SELECT id, state, source_link FROM eval_cases WHERE source_link >= ? AND source_link < ? ORDER BY saved_at LIMIT 100",
      prefix,
      `${prefix}~`,
    )
    .toArray();
  return {
    evals: rows.map((row) => ({
      id: String(row.id),
      state: String(row.state) as EvalState,
      seq: Number(String(row.source_link).split(":")[1]),
    })),
  };
}
export function deleteEvalsBySource(db: KnowledgeDb, args: { thread: unknown }) {
  if (typeof args.thread !== "string" || !THREAD.test(args.thread)) return { deleted: 0 };
  const count = Number(
    db.sql
      .exec(
        "SELECT COUNT(*) AS n FROM eval_cases WHERE source_link >= ? AND source_link < ?",
        `${args.thread}:`,
        `${args.thread}:~`,
      )
      .toArray()[0]?.n ?? 0,
  );
  db.sql.exec(
    "DELETE FROM eval_cases WHERE source_link >= ? AND source_link < ?",
    `${args.thread}:`,
    `${args.thread}:~`,
  );
  return { deleted: count };
}
/** Clears the link of every copy of these threads (the threads are gone). */
export function unlinkEvals(db: KnowledgeDb, args: { threads: unknown }) {
  const threads = Array.isArray(args.threads)
    ? args.threads.filter((t): t is string => typeof t === "string" && THREAD.test(t)).slice(0, 100)
    : [];
  for (const thread of threads)
    db.sql.exec(
      "UPDATE eval_cases SET source_link = NULL WHERE source_link >= ? AND source_link < ?",
      `${thread}:`,
      `${thread}:~`,
    );
  return { unlinked: threads.length };
}
/** Distinct linked threads, for the room's check that they still exist. */
export function evalLinks(db: KnowledgeDb, args: { limit?: unknown }) {
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
  const rows = db.sql
    .exec(
      "SELECT DISTINCT substr(source_link, 1, 35) AS thread FROM eval_cases WHERE source_link IS NOT NULL LIMIT ?",
      limit,
    )
    .toArray();
  return { threads: rows.map((row) => String(row.thread)).filter((t) => THREAD.test(t)) };
}

export function importEvals(
  db: KnowledgeDb,
  args: { cases: unknown; cap: unknown; savedBy?: unknown },
  now: number,
) {
  const cases = args.cases;
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > EVAL_LIMITS.importLines)
    throw new KnowledgeError(400, "eval-import", "Send 1 to 500 eval case lines.");
  const cap = Number(args.cap) || EVAL_LIMITS.casesFree;
  const refused: { index: number; reason: string }[] = [];
  let imported = 0;
  let total = evalCounts(db).total;
  db.transaction(() => {
    cases.forEach((raw: unknown, index: number) => {
      const candidate =
        raw && typeof raw === "object"
          ? {
              ...(raw as object),
              schema: EVAL_SCHEMA,
              id: `ev-${"0".repeat(16)}`,
              version: 1,
              state: "candidate",
              origin: "import",
              savedOn: isoDay(now),
              updatedOn: isoDay(now),
            }
          : null;
      const c = candidate ? checkedEvalCase(candidate) : null;
      if (!c) return refused.push({ index, reason: "eval-invalid" });
      if (total >= cap) return refused.push({ index, reason: "eval-limit" });
      const id = `ev-${randomHex(8)}`;
      db.sql.exec(
        `INSERT INTO eval_cases (id, version, state, origin, saved_at, updated_at, category, labels, body, source_link, saved_by)
         VALUES (?, 1, 'candidate', 'import', ?, ?, ?, ?, ?, NULL, ?)`,
        id,
        now,
        now,
        c.category,
        JSON.stringify(c.labels),
        bodyOf(c),
        typeof args.savedBy === "string" ? args.savedBy : null,
      );
      imported++;
      total++;
    });
  });
  return { imported, refused };
}

/** One export page: cases ordered by id, re-checked for identifiers. */
export async function exportEvals(
  db: KnowledgeDb,
  args: {
    set: unknown;
    after?: unknown;
    keepAddresses?: unknown;
    keepHosts?: unknown;
  },
) {
  const set = args.set === "all" ? "all" : "golden";
  const after =
    typeof args.after === "string" && EVAL_ID.test(args.after) ? args.after : "";
  const states = set === "all" ? ["golden", "candidate"] : ["golden"];
  const rows = db.sql
    .exec(
      `SELECT * FROM eval_cases WHERE state IN (${states.map(() => "?").join(",")}) AND id > ?
       ORDER BY id LIMIT ?`,
      ...states,
      after,
      EVAL_LIMITS.exportPage + 1,
    )
    .toArray() as EvalRow[];
  const count = Number(
    db.sql
      .exec(
        `SELECT COUNT(*) AS n FROM eval_cases WHERE state IN (${states.map(() => "?").join(",")})`,
        ...states,
      )
      .toArray()[0]?.n ?? 0,
  );
  const keep = {
    keepAddresses: new Set(
      Array.isArray(args.keepAddresses) ? (args.keepAddresses as string[]) : [],
    ),
    keepHosts: new Set(Array.isArray(args.keepHosts) ? (args.keepHosts as string[]) : []),
  };
  const skips = new RowSkips();
  const cases: EvalCase[] = [];
  const withheld: string[] = [];
  for (const row of rows.slice(0, EVAL_LIMITS.exportPage)) {
    const c = rowCase(row, skips);
    if (!c) continue;
    // A case keeps the profile addresses it lists that are still entries
    // of this profile, and nothing else.
    const own = profileAddressesIn(db, [
      ...c.input.profile,
      ...(c.input.frame?.product?.address
        ? [{ network: c.input.frame.product.network, address: c.input.frame.product.address }]
        : []),
    ]);
    const caseKeep = {
      keepAddresses: new Set([...keep.keepAddresses, ...own]),
      keepHosts: keep.keepHosts,
    };
    const secrets = await Promise.all(evalTexts(c).map((text) => detectStoredSecret(text)));
    if (secrets.some(Boolean) || residualInBody(c, caseKeep).length) {
      withheld.push(c.id);
      continue;
    }
    cases.push(c);
  }
  const page = rows.slice(0, EVAL_LIMITS.exportPage);
  return {
    set,
    count,
    cases,
    withheld,
    next: rows.length > EVAL_LIMITS.exportPage ? page[page.length - 1].id : null,
  };
}

/* Runs                                                                    */

type RunRow = {
  id: string;
  client_run_id: string;
  posted_at: number;
  poster: string;
  agent_name: string;
  agent_version: string;
  model: string | null;
  prompt_sha256: string | null;
  scorer: string;
  scorer_version: string;
  set_name: string;
  exported_at: string;
  unknown_cases: number;
};
function runView(db: KnowledgeDb, run: RunRow): EvalRunView {
  const results = db.sql
    .exec("SELECT eval_id, case_version, pass, items FROM eval_results WHERE run_id = ?", run.id)
    .toArray();
  const byItem = Object.fromEntries(
    RUBRIC_ITEMS.map((item) => [item, { pass: 0, fail: 0, na: 0 }]),
  ) as EvalRunView["byItem"];
  let passed = 0;
  for (const row of results) {
    if (Number(row.pass) === 1) passed++;
    const items = (safeJson(row.items) ?? {}) as Record<string, string>;
    for (const item of RUBRIC_ITEMS) {
      const score = items[item];
      if (score === "pass") byItem[item].pass++;
      else if (score === "fail") byItem[item].fail++;
      else byItem[item].na++;
    }
  }
  const previous = db.sql
    .exec(
      "SELECT id FROM eval_runs WHERE agent_name = ? AND (posted_at < ? OR (posted_at = ? AND id < ?)) ORDER BY posted_at DESC, id DESC LIMIT 1",
      run.agent_name,
      run.posted_at,
      run.posted_at,
      run.id,
    )
    .toArray()[0];
  const regressions: string[] = [];
  const newPasses: string[] = [];
  if (previous) {
    const before = new Map(
      db.sql
        .exec("SELECT eval_id, case_version, pass FROM eval_results WHERE run_id = ?", String(previous.id))
        .toArray()
        .map((row) => [
          `${row.eval_id}@${row.case_version}`,
          Number(row.pass) === 1,
        ]),
    );
    for (const row of results) {
      const key = `${row.eval_id}@${row.case_version}`;
      if (!before.has(key)) continue;
      const now = Number(row.pass) === 1;
      if (before.get(key) && !now) regressions.push(String(row.eval_id));
      if (!before.get(key) && now) newPasses.push(String(row.eval_id));
    }
  }
  return {
    id: run.id as `run-${string}`,
    postedAt: iso(run.posted_at),
    poster: run.poster === "agent" ? "agent" : "person",
    agent: {
      name: run.agent_name,
      version: run.agent_version,
      ...(run.model ? { model: run.model } : {}),
      ...(run.prompt_sha256 ? { promptSha256: run.prompt_sha256 } : {}),
    },
    scorer: {
      name: run.scorer === "custom" ? "custom" : "templ-reference",
      version: run.scorer_version,
    },
    set: run.set_name === "all" ? "all" : "golden",
    total: results.length,
    passed,
    byItem,
    regressions: regressions.sort(),
    newPasses: newPasses.sort(),
    unknownCases: run.unknown_cases,
  };
}

/** Posts a run, or one more part of it under the same `clientRunId`. The
 * same part again changes nothing and answers the stored run. */
export async function postEvalRun(
  db: KnowledgeDb,
  args: { input: EvalRunInput; poster: "agent" | "person" },
  now: number,
): Promise<{ run: EvalRunView; created: boolean }> {
  const input = args.input;
  const secrets = await Promise.all(input.results.map(async (result) => ({
    output: await detectStoredSecret(result.output ?? ""),
    notes: await detectStoredSecret(result.notes ?? ""),
  })));
  const existing = db.sql
    .exec("SELECT * FROM eval_runs WHERE client_run_id = ?", input.clientRunId)
    .toArray()[0] as RunRow | undefined;
  if (
    existing &&
    (existing.agent_name !== input.agent.name ||
      existing.agent_version !== input.agent.version ||
      existing.scorer !== input.scorer.name ||
      existing.set_name !== input.set)
  )
    throw new KnowledgeError(
      409,
      "eval-run-mismatch",
      "This run id was used for another agent, scorer or set.",
    );
  let run = existing;
  if (!run) {
    const recent = Number(
      db.sql
        .exec("SELECT COUNT(*) AS n FROM eval_runs WHERE posted_at > ?", now - HOUR_MS)
        .toArray()[0]?.n ?? 0,
    );
    if (recent >= EVAL_LIMITS.runsPerHour)
      throw new KnowledgeError(429, "eval-run-rate", "Try posting runs again in an hour.", {
        retryAfterSeconds: 3600,
      });
  }
  // Durable Object SQL binds at most 100 values per statement.
  const known = new Map<string, number>();
  for (let at = 0; at < input.results.length; at += 90) {
    const ids = input.results.slice(at, at + 90).map((r) => r.id);
    for (const row of db.sql
      .exec(
        `SELECT id, version FROM eval_cases WHERE id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      )
      .toArray())
      known.set(String(row.id), Number(row.version));
  }
  let created = false;
  db.transaction(() => {
    if (!run) {
      const id = `run-${randomHex(8)}`;
      db.sql.exec(
        `INSERT INTO eval_runs (id, client_run_id, posted_at, poster, agent_name, agent_version, model, prompt_sha256, scorer, scorer_version, set_name, exported_at, unknown_cases)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        id,
        input.clientRunId,
        now,
        args.poster,
        input.agent.name,
        input.agent.version,
        input.agent.model ?? null,
        input.agent.promptSha256 ?? null,
        input.scorer.name,
        input.scorer.version,
        input.set,
        input.exportedAt,
      );
      run = db.sql.exec("SELECT * FROM eval_runs WHERE id = ?", id).toArray()[0] as RunRow;
      created = true;
    }
    const stored = Number(
      db.sql.exec("SELECT COUNT(*) AS n FROM eval_results WHERE run_id = ?", run.id).toArray()[0]?.n ?? 0,
    );
    let room = EVAL_LIMITS.runResults - stored;
    let unknown = 0;
    for (const [index, result] of input.results.entries()) {
      if (!known.has(result.id)) {
        unknown++;
        continue;
      }
      const present = db.sql
        .exec("SELECT 1 AS one FROM eval_results WHERE run_id = ? AND eval_id = ?", run.id, result.id)
        .toArray().length;
      if (present || room <= 0) continue;
      let output: string | null = result.output ?? null;
      let refusedReason: string | null = null;
      if (output !== null && secrets[index].output) {
        output = null;
        refusedReason = secrets[index].output;
      } else if (output !== null) {
        output = hideAmbiguousHex(output);
        const kinds = residualIdentifiers(output, {
          keepAddresses: new Set(),
          keepHosts: new Set(),
        });
        if (kinds.length) {
          output = null;
          refusedReason = kinds.join(",");
        }
      }
      db.sql.exec(
        `INSERT INTO eval_results (run_id, eval_id, case_version, pass, items, action, output, output_refused, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        run.id,
        result.id,
        result.caseVersion,
        result.pass ? 1 : 0,
        JSON.stringify(result.items),
        result.action ?? null,
        output,
        refusedReason,
        result.notes && !secrets[index].notes ? hideAmbiguousHex(result.notes) : null,
      );
      room--;
    }
    if (unknown && created)
      db.sql.exec("UPDATE eval_runs SET unknown_cases = ? WHERE id = ?", unknown, run.id);
  });
  return { run: runView(db, run!), created };
}
export function listEvalRuns(db: KnowledgeDb, args: { after?: unknown }) {
  const after = typeof args.after === "string" && RUN_ID.test(args.after) ? args.after : null;
  const cursor = after
    ? (db.sql.exec("SELECT posted_at FROM eval_runs WHERE id = ?", after).toArray()[0]?.posted_at as number | undefined)
    : undefined;
  const rows = (
    cursor !== undefined
      ? db.sql
          .exec(
            "SELECT * FROM eval_runs WHERE posted_at < ? OR (posted_at = ? AND id < ?) ORDER BY posted_at DESC, id DESC LIMIT ?",
            cursor,
            cursor,
            after!,
            RUN_PAGE + 1,
          )
          .toArray()
      : db.sql
          .exec("SELECT * FROM eval_runs ORDER BY posted_at DESC, id DESC LIMIT ?", RUN_PAGE + 1)
          .toArray()
  ) as RunRow[];
  const page = rows.slice(0, RUN_PAGE);
  return {
    runs: page.map((run) => runView(db, run)),
    next: rows.length > RUN_PAGE ? page[page.length - 1].id : null,
  };
}
export function getEvalRun(db: KnowledgeDb, args: { id: unknown }) {
  if (typeof args.id !== "string" || !RUN_ID.test(args.id))
    throw new KnowledgeError(404, "run-not-found", "Run not found.");
  const run = db.sql.exec("SELECT * FROM eval_runs WHERE id = ?", args.id).toArray()[0] as
    | RunRow
    | undefined;
  if (!run) throw new KnowledgeError(404, "run-not-found", "Run not found.");
  const results = db.sql
    .exec("SELECT * FROM eval_results WHERE run_id = ? ORDER BY eval_id", run.id)
    .toArray()
    .map((row) => ({
      id: String(row.eval_id),
      caseVersion: Number(row.case_version),
      pass: Number(row.pass) === 1,
      items: safeJson(row.items),
      action: row.action ?? null,
      output: row.output ?? null,
      outputRefused: row.output_refused ?? null,
      notes: row.notes ?? null,
    }));
  return { run: runView(db, run), results };
}

/** Deletes every eval case, run, result and import of the workspace. The
 * profile stays. */
export function purgeEvals(db: KnowledgeDb) {
  db.transaction(() => {
    db.sql.exec("DELETE FROM eval_results");
    db.sql.exec("DELETE FROM eval_runs");
    db.sql.exec("DELETE FROM eval_cases");
    db.sql.exec("DELETE FROM profile_import_rows");
    db.sql.exec("DELETE FROM profile_imports");
  });
  return { purged: true };
}

/** Daily retention: cases after 730 days; runs past the newest 100 or
 * older than 180 days, with their results. */
export function evalRetention(db: KnowledgeDb, now: number) {
  db.sql.exec(
    "DELETE FROM eval_cases WHERE saved_at < ?",
    now - EVAL_LIMITS.retentionDays * DAY_MS,
  );
  const keep = db.sql
    .exec("SELECT id FROM eval_runs ORDER BY posted_at DESC, id DESC LIMIT ?", EVAL_LIMITS.runsKept)
    .toArray()
    .map((row) => String(row.id));
  const stale = db.sql
    .exec("SELECT id, posted_at FROM eval_runs")
    .toArray()
    .filter(
      (row) =>
        !keep.includes(String(row.id)) ||
        Number(row.posted_at) < now - EVAL_LIMITS.runRetentionDays * DAY_MS,
    )
    .map((row) => String(row.id));
  for (const id of stale) {
    db.sql.exec("DELETE FROM eval_results WHERE run_id = ?", id);
    db.sql.exec("DELETE FROM eval_runs WHERE id = ?", id);
  }
}
