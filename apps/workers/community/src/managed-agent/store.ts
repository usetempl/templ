/** What the knowledge object keeps for managed AI, in its `meta` table (no
 * schema change): queued jobs, this workspace's monthly spend, and the
 * golden set with its runs. Jobs hold ids and times only; spend holds
 * counts; the golden runs hold case keys and scores (the cases themselves
 * are the eval store's golden set). All of it goes with the workspace's
 * knowledge on deletion (`purgeAll`). */
import {
  GOLDEN_LIMITS,
  goldenCaseKey,
  goldenSetGate,
  sameFingerprint,
  type GoldenFingerprint,
  type GoldenGate,
  type GoldenGateState,
  type GoldenRun,
} from "@templ/chat/golden-set";
import {
  MANAGED_AGENT_LIMITS,
  MANAGED_AGENT_MODEL,
  spendMonth,
} from "@templ/chat/managed-agent";
import {
  EVAL_SCHEMA,
  checkedEvalCase,
  type EvalCase,
} from "@templ/chat/support-eval";
import { readWorkspaceAiGuidance } from "../support-knowledge-guidance";
import { currentPromptId } from "./prompt";
import {
  isoDay,
  readMeta,
  readMetaJson,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "../support-knowledge-schema";

const JOB = "managed.job:";
const SPEND = "managed.spend:";
const GOLDEN_ACCEPTED = "managed.golden.accepted";
const GOLDEN_LAST = "managed.golden.last";
const GOLDEN_QUEUED = "managed.golden.queued";
const GOLDEN_MANUAL = "managed.golden.manual";
const GOLDEN_PARTIAL = "managed.golden.partial";
const pad15 = (value: number) => String(value).padStart(15, "0");
/** A reservation the runner never settled (it stopped mid-call) is let go
 * after this long. */
export const RESERVATION_MS = 10 * 60_000;

export type StoredJob = {
  id: string;
  kind: "ask-ai" | "member-message" | "handoff-learning" | "golden";
  thread: string | null;
  request: string | null;
  manager: string | null;
  /** When the write that caused it happened. */
  at: number;
  /** When it may run next. */
  due: number;
  attempts: number;
  /** An accepted reply awaiting its conditional managed resolution. */
  close?: { case: number; reply: { id: string; revision: number } };
  handoff?: import("@templ/chat/managed-agent").ManagedHandoffReason;
  /** Learning inference is never repeated after an uncertain attempt. */
  learning?: {
    id: string;
    started?: true;
    result?: import("@templ/chat/support-learning").HandoffLearningResult;
    knowledgeVersion?: string;
  };
};

function listMeta(db: KnowledgeDb, prefix: string, limit: number) {
  return db.sql
    .exec(
      "SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT ?",
      prefix,
      `${prefix}￿`,
      limit,
    )
    .toArray() as { key: string; value: string }[];
}
const deleteMeta = (db: KnowledgeDb, key: string) =>
  db.sql.exec("DELETE FROM meta WHERE key = ?", key);

/* Jobs                                                                    */

const isGolden = (row: { value: string }) => {
  try {
    return (JSON.parse(row.value) as StoredJob).kind === "golden";
  } catch {
    return false;
  }
};
export function addJobs(db: KnowledgeDb, jobs: StoredJob[]) {
  db.transaction(() => {
    for (const job of jobs)
      writeMeta(db, `${JOB}${pad15(job.due)}:${job.id}`, JSON.stringify(job));
    // Past the cap the oldest member and Ask AI jobs go first. Golden jobs
    // don't count toward it: at most one waits (`queueGolden`), and a later
    // duplicate is dropped.
    const all = listMeta(db, JOB, 1_000);
    const golden = all.filter(isGolden);
    for (const row of golden.slice(1)) deleteMeta(db, row.key);
    const requests = all.filter((row) => !isGolden(row));
    for (const row of requests.slice(
      0,
      Math.max(0, requests.length - MANAGED_AGENT_LIMITS.jobsQueued),
    ))
      deleteMeta(db, row.key);
  });
}
export function dueJobs(db: KnowledgeDb, now: number, limit: number) {
  const out: { key: string; job: StoredJob }[] = [];
  for (const row of listMeta(db, JOB, 50)) {
    let job: StoredJob | null = null;
    try {
      job = JSON.parse(row.value) as StoredJob;
    } catch {
      job = null;
    }
    if (!job) {
      deleteMeta(db, row.key);
      continue;
    }
    if (job.due > now) break;
    out.push({ key: row.key, job });
    if (out.length >= limit) break;
  }
  return out;
}
export const finishJob = (db: KnowledgeDb, key: string) => deleteMeta(db, key);
/** Save the accepted reply before closing, so a retry never calls the model again. */
export function saveJob(db: KnowledgeDb, job: StoredJob) {
  writeMeta(db, `${JOB}${pad15(job.due)}:${job.id}`, JSON.stringify(job));
}
/** Tries a job again later, or drops it after its last try. */
export function retryJob(
  db: KnowledgeDb,
  key: string,
  job: StoredJob,
  now: number,
) {
  deleteMeta(db, key);
  if (job.attempts + 1 >= MANAGED_AGENT_LIMITS.jobAttempts) return false;
  const next = {
    ...job,
    attempts: job.attempts + 1,
    due: now + 30_000 * (job.attempts + 1),
  };
  writeMeta(db, `${JOB}${pad15(next.due)}:${next.id}`, JSON.stringify(next));
  return true;
}
export function nextJobDue(db: KnowledgeDb): number | null {
  const [first] = listMeta(db, JOB, 1);
  if (!first) return null;
  try {
    return (JSON.parse(first.value) as StoredJob).due;
  } catch {
    return Date.now();
  }
}

/* This workspace's spend                                                  */

export type SpendRecord = {
  spentCents: number;
  calls: number;
  reservations: Record<string, { cents: number; at: number }>;
};
function readSpend(
  read: () => SpendRecord | null,
  now: number,
  expire = true,
): SpendRecord {
  const stored = read();
  const record: SpendRecord = {
    spentCents: Number.isSafeInteger(stored?.spentCents)
      ? stored!.spentCents
      : 0,
    calls: Number.isSafeInteger(stored?.calls) ? stored!.calls : 0,
    reservations: { ...(stored?.reservations ?? {}) },
  };
  for (const [id, held] of Object.entries(record.reservations ?? {}))
    if (expire && now - held.at > RESERVATION_MS)
      delete record.reservations[id];
  return record;
}
const heldCents = (record: SpendRecord) =>
  Object.values(record.reservations).reduce((sum, held) => sum + held.cents, 0);

/** Holds `cents` against a monthly cap. False when the cap has no room. */
export function reserveSpend(
  record: SpendRecord,
  input: { id: string; cents: number; cap: number; now: number },
): boolean {
  if (input.cap <= 0) return false;
  if (record.spentCents + heldCents(record) + input.cents > input.cap)
    return false;
  record.reservations[input.id] = { cents: input.cents, at: input.now };
  return true;
}
/** Lets a hold go with nothing spent (the call never ran). */
export function releaseSpend(record: SpendRecord, id: string) {
  delete record.reservations[id];
}
/** Replaces a hold with what the call cost. */
export function settleSpend(record: SpendRecord, id: string, cents: number) {
  delete record.reservations[id];
  record.spentCents += Math.max(0, Math.ceil(cents));
  record.calls += 1;
}

export function workspaceSpend(db: KnowledgeDb, now: number) {
  const month = spendMonth(now);
  return {
    month,
    record: readSpend(
      () => readMetaJson<SpendRecord>(db, `${SPEND}${month}`),
      now,
    ),
  };
}
export function saveWorkspaceSpend(
  db: KnowledgeDb,
  month: string,
  record: SpendRecord,
) {
  writeMeta(db, `${SPEND}${month}`, JSON.stringify(record));
}
/** Spend counters older than 13 months go. */
export function pruneSpend(db: KnowledgeDb, now: number) {
  const cutoff = spendMonth(now - 400 * 86_400_000);
  for (const row of listMeta(db, SPEND, 100))
    if (row.key.slice(SPEND.length) < cutoff) deleteMeta(db, row.key);
}

/** Native calls time out after one minute; retain an additional margin before booking unknown provider cost. */
export const PROVIDER_RESERVATION_MS = 15 * 60_000;
type ProviderTerminal = {
  kind: "settled" | "absorbed" | "released" | "refused";
  cents: number;
  at: number;
};

/** Templ's company budget. Expired holds book their full bound; they never become customer charges. */
export async function templSpendRequest(
  storage: DurableObjectStorage,
  body: Record<string, unknown>,
  now: number,
): Promise<{ ok: boolean; usedCents: number }> {
  const month =
    typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)
      ? body.month
      : null;
  const id =
    typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id)
      ? body.id
      : null;
  const cents = Number(body.cents);
  const scope = body.scope;
  if (
    !month ||
    !id ||
    !Number.isSafeInteger(cents) ||
    cents < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !["reserve", "settle", "release"].includes(String(body.op)) ||
    (scope !== undefined &&
      (typeof scope !== "string" || !/^[a-f0-9]{64}$/.test(scope)))
  )
    throw new Error("managed-spend-request");
  const key = `spend:${month}`;
  const terminalKey = (attempt: string) => `spend-terminal:${month}:${attempt}`;
  const scopeKey = `spend-scope:${month}:${id}`;
  return storage.transaction(async (tx) => {
    const saved = await tx.get<SpendRecord>(key);
    const current = readSpend(() => saved ?? null, now, false);
    const assignedScope = await tx.get<string>(scopeKey);
    if (assignedScope !== undefined && assignedScope !== scope)
      throw new Error("managed-spend-replay");
    if (scope !== undefined && assignedScope === undefined) {
      if (current.reservations[id] || (await tx.get(terminalKey(id))))
        throw new Error("managed-spend-replay");
      if (body.op !== "reserve" && !(body.op === "release" && cents === 0))
        throw new Error("managed-spend-unreserved");
      await tx.put(scopeKey, scope);
    }
    if (
      saved &&
      (!Number.isSafeInteger(saved.spentCents) ||
        saved.spentCents < 0 ||
        !Number.isSafeInteger(saved.calls) ||
        saved.calls < 0)
    )
      throw new Error("managed-spend-record");
    for (const [attempt, held] of Object.entries(current.reservations)) {
      if (
        !/^[0-9a-f-]{36}$/.test(attempt) ||
        !held ||
        !Number.isSafeInteger(held.cents) ||
        held.cents < 0 ||
        !Number.isSafeInteger(held.at) ||
        held.at < 0
      )
        throw new Error("managed-spend-record");
      if (now < held.at + PROVIDER_RESERVATION_MS) continue;
      if (await tx.get(terminalKey(attempt)))
        throw new Error("managed-spend-record");
      settleSpend(current, attempt, held.cents);
      await tx.put(terminalKey(attempt), {
        kind: "absorbed",
        cents: held.cents,
        at: now,
      } satisfies ProviderTerminal);
    }
    const terminal = await tx.get<ProviderTerminal>(terminalKey(id));
    let ok = true;
    if (terminal) {
      if (body.op === "reserve") ok = false;
      else if (
        scope !== undefined && body.op === "release" && terminal.kind === "settled"
      )
        throw new Error("managed-spend-replay");
      else if (body.op === "settle" && terminal.kind === "refused")
        throw new Error("managed-spend-unreserved");
      else if (
        body.op === "settle" &&
        terminal.kind !== "absorbed" &&
        (terminal.kind !== "settled" || terminal.cents !== cents)
      )
        throw new Error("managed-spend-replay");
    } else if (body.op === "reserve") {
      const held = current.reservations[id];
      if (held && held.cents !== cents) throw new Error("managed-spend-replay");
      ok =
        Boolean(held) ||
        reserveSpend(current, { id, cents, cap: Number(body.cap) || 0, now });
      if (!ok && scope !== undefined)
        await tx.put(terminalKey(id), {
          kind: "refused", cents: 0, at: now,
        } satisfies ProviderTerminal);
    } else {
      if (
        !current.reservations[id] &&
        !(scope !== undefined && body.op === "release" && cents === 0)
      )
        throw new Error("managed-spend-unreserved");
      if (body.op === "settle") settleSpend(current, id, cents);
      else releaseSpend(current, id);
      await tx.put(terminalKey(id), {
        kind: body.op === "settle" ? "settled" : "released",
        cents: body.op === "settle" ? cents : 0,
        at: now,
      } satisfies ProviderTerminal);
    }
    if (
      !Number.isSafeInteger(current.spentCents) ||
      !Number.isSafeInteger(current.calls)
    )
      throw new Error("managed-spend-record");
    await tx.put(key, current);
    return { ok, usedCents: current.spentCents };
  });
}

/* The golden set                                                          */

export type GoldenLast = { run: GoldenRun; gate: GoldenGate };
export type GoldenEval = { key: string; case: EvalCase };

/** The team's golden set: eval cases in state "golden" from this object's
 * eval store, the first `GOLDEN_LIMITS.casesPerRun` by the time they were
 * saved. Unreadable rows are left out. */
export function goldenCases(db: KnowledgeDb): GoldenEval[] {
  const rows = db.sql
    .exec(
      `SELECT id, version, state, origin, saved_at, updated_at, body FROM eval_cases
       WHERE state = 'golden' ORDER BY saved_at, id LIMIT ?`,
      GOLDEN_LIMITS.casesPerRun,
    )
    .toArray() as {
    id: string;
    version: number;
    state: string;
    origin: string;
    saved_at: number;
    updated_at: number;
    body: string;
  }[];
  const out: GoldenEval[] = [];
  for (const row of rows) {
    let body: unknown;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    const c = checkedEvalCase({
      ...(body as object),
      schema: EVAL_SCHEMA,
      id: row.id,
      version: Number(row.version),
      state: row.state,
      origin: row.origin,
      savedOn: isoDay(Number(row.saved_at)),
      updatedOn: isoDay(Number(row.updated_at)),
    });
    if (c) out.push({ key: goldenCaseKey(c.id, c.version), case: c });
  }
  return out;
}
export const acceptedRun = (db: KnowledgeDb) =>
  readMetaJson<GoldenRun>(db, GOLDEN_ACCEPTED);
export const lastGolden = (db: KnowledgeDb) =>
  readMetaJson<GoldenLast>(db, GOLDEN_LAST);
export const goldenQueuedAt = (db: KnowledgeDb) =>
  Number(readMeta(db, GOLDEN_QUEUED)) || null;
export function setGoldenQueued(db: KnowledgeDb, at: number | null) {
  if (at === null) deleteMeta(db, GOLDEN_QUEUED);
  else writeMeta(db, GOLDEN_QUEUED, String(at));
}
/** When a person last asked for a check. */
export const goldenManualAt = (db: KnowledgeDb) =>
  Number(readMeta(db, GOLDEN_MANUAL)) || null;
export const setGoldenManual = (db: KnowledgeDb, at: number) =>
  writeMeta(db, GOLDEN_MANUAL, String(at));
export const goldenPartial = <T>(db: KnowledgeDb) =>
  readMetaJson<T>(db, GOLDEN_PARTIAL);
export const setGoldenPartial = (db: KnowledgeDb, value: unknown) =>
  writeMeta(db, GOLDEN_PARTIAL, JSON.stringify(value));
export const clearGoldenPartial = (db: KnowledgeDb) =>
  deleteMeta(db, GOLDEN_PARTIAL);
export const goldenJobQueued = (db: KnowledgeDb) =>
  listMeta(db, JOB, 1_000).some(isGolden);

/** Records a finished run and, when the gate lets it through, accepts it. */
export function recordGoldenRun(db: KnowledgeDb, run: GoldenRun): GoldenGate {
  const cases = goldenCases(db).map((golden) => ({ id: golden.key }));
  const gate = goldenSetGate({
    cases,
    accepted: acceptedRun(db),
    candidate: run,
  });
  writeMeta(
    db,
    GOLDEN_LAST,
    JSON.stringify({ run, gate } satisfies GoldenLast),
  );
  if (gate.ok) writeMeta(db, GOLDEN_ACCEPTED, JSON.stringify(run));
  return gate;
}

/** The fingerprint of what the managed AI answers with now: the prompt (by
 * the hash of its text) and model, the knowledge sources' content, the
 * profile, and the golden cases it is graded on. */
export async function currentFingerprint(
  db: KnowledgeDb,
): Promise<GoldenFingerprint> {
  const sources = db.sql
    .exec(
      `SELECT s.id AS id, s.era AS era, s.visibility AS visibility, s.status AS status,
              s.title AS title, COALESCE(s.body_sha256, '') AS sha,
              CASE WHEN s.body_sha256 IS NULL
                THEN (SELECT group_concat(text, char(10)) FROM kb_chunks WHERE source_id = s.id)
                ELSE '' END AS inline
       FROM kb_sources s ORDER BY s.id`,
    )
    .toArray();
  const metrics = db.sql
    .exec("SELECT id, json FROM profile_metrics ORDER BY id")
    .toArray();
  const cases = goldenCases(db)
    .map((golden) => golden.key)
    .sort();
  const guidance = await readWorkspaceAiGuidance(db);
  return {
    prompt: await currentPromptId(),
    model: MANAGED_AGENT_MODEL,
    knowledge: (await sha256Hex(JSON.stringify({ sources, guidance }))).slice(
      0,
      16,
    ),
    profile: (
      await sha256Hex(
        `${readMeta(db, "profile.revision") ?? "0"}|${JSON.stringify(metrics)}`,
      )
    ).slice(0, 16),
    cases: (await sha256Hex(JSON.stringify(cases))).slice(0, 16),
  };
}

/** Where the gate stands for the current fingerprint. A failed run on this
 * fingerprint newer than the accepted one wins over it: a rerun that
 * regressed stops replies again. */
export function goldenState(
  db: KnowledgeDb,
  fingerprint: GoldenFingerprint,
): GoldenGateState {
  const cases = goldenCases(db);
  if (!cases.length) return "none";
  const accepted = acceptedRun(db);
  const last = lastGolden(db);
  const lastHere =
    last && sameFingerprint(last.run.fingerprint, fingerprint) ? last : null;
  if (lastHere && !lastHere.gate.ok) {
    const acceptedHere =
      accepted && sameFingerprint(accepted.fingerprint, fingerprint)
        ? accepted
        : null;
    if (
      !acceptedHere ||
      Date.parse(lastHere.run.at) >= Date.parse(acceptedHere.at)
    )
      return "failed";
  }
  if (accepted && sameFingerprint(accepted.fingerprint, fingerprint)) {
    // An accepted run on this fingerprint still has to cover the current set.
    const ids = new Set(accepted.results.map((result) => result.id));
    if (cases.every((golden) => ids.has(golden.key))) return "passed";
  }
  return "pending";
}
