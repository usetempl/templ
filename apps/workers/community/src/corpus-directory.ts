/** Templ's corpus directory: one instance of the private `COST_METRICS`
 * object, named `corpus-v1`, that keeps
 *
 * - which workspace each pseudonym (`ws_…`) names, registered by the
 *   workspace's own room when it builds its first row, so the operator
 *   route can find the knowledge object without a room call;
 * - the `corpus.read` log: reader, time, purpose, workspace pseudonym and
 *   row count for every read, kept `CORPUS_LIMITS.readLogDays`, and each
 *   workspace's monthly total of rows read and purposes, which the team's
 *   Activity and Settings show;
 * - each reader's rows read per UTC day, for the daily limit;
 * - leak samples: rows sampled and rows that still held a direct
 *   identifier. Two samples in a row over `leakRowsPerHundred` pause every
 *   workspace's builds until a clean sample.
 *
 * It never holds row text, a ref, a thread id or a member. */
import { CORPUS_LIMITS } from "@templ/chat/plans";
import { CORPUS_PURPOSES, type CorpusPurpose } from "@templ/chat/support-corpus";
import { HttpError, json, readJson } from "./common";

export const CORPUS_DIRECTORY_INSTANCE = "corpus-v1";
export type CorpusDirectoryEnv = { COST_METRICS?: DurableObjectNamespace };

const WORKSPACE = "corpus-ws-v1:";
const LOG = "corpus-read-v1:";
/** `<prefix><YYYY-MM>:<ws>` → `{ rows, purposes }`. */
const MONTH = "corpus-read-month-v1:";
const TAKE = "corpus-take-v1:";
const LEAK = "corpus-leak-v1:";
const LEAK_SEQUENCE = "corpus-leak-sequence-v1";
const DAY = 86_400_000;
const WS = /^ws_[0-9a-f]{16}$/;
const ROOM = /^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READER = /^(?:0x[0-9a-f]{40}|account:[0-9a-f-]{36})$/;
const pad16 = (n: number) => String(n).padStart(16, "0");
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const month = (at: number) => new Date(at).toISOString().slice(0, 7);
type MonthTotal = { rows: number; purposes: CorpusPurpose[] };

export type CorpusReadEntry = {
  at: number;
  reader: string;
  purpose: CorpusPurpose;
  workspace: string;
  rows: number;
};
type Storage = DurableObjectStorage;

/** The directory's requests, served inside CostMetrics.fetch. Returns null
 * for any other path. */
export async function corpusDirectoryRequest(
  request: Request,
  storage: Storage,
  now = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/corpus/")) return null;
  try {
    return await directoryOp(request, storage, url.pathname.slice("/corpus/".length), now);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(
      {
        error: error.message,
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
      error.status,
    );
  }
}
async function directoryOp(
  request: Request,
  storage: Storage,
  op: string,
  now: number,
): Promise<Response> {
  if (request.method === "GET" && op === "state") return json(await leakState(storage));
  if (request.method === "GET" && op === "workspaces") {
    const rows = await storage.list({ prefix: WORKSPACE, limit: 1_000 });
    return json({ workspaces: [...rows.keys()].map((key) => key.slice(WORKSPACE.length)) });
  }
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const body = await readJson(request, 4_096);
  if (op === "register") {
    if (typeof body.workspace !== "string" || !WS.test(body.workspace) || typeof body.room !== "string" || !ROOM.test(body.room))
      throw new HttpError(400, "Invalid workspace.");
    const current = await storage.get<string>(WORKSPACE + body.workspace);
    if (current && current !== body.room) throw new HttpError(409, "Pseudonym in use.");
    if (!current) await storage.put(WORKSPACE + body.workspace, body.room);
    await ensureAlarm(storage, now);
    return json({ ok: true });
  }
  if (op === "resolve") {
    if (typeof body.workspace !== "string" || !WS.test(body.workspace))
      throw new HttpError(400, "Invalid workspace.");
    const room = await storage.get<string>(WORKSPACE + body.workspace);
    if (!room) throw new HttpError(404, "Not found.");
    return json({ room });
  }
  if (op === "take") {
    const rows = Number(body.rows);
    if (typeof body.reader !== "string" || !READER.test(body.reader) || !Number.isSafeInteger(rows) || rows < 1 || rows > CORPUS_LIMITS.rowsPerRead)
      throw new HttpError(400, "Invalid read.");
    const key = `${TAKE}${day(now)}:${body.reader}`;
    const used = (await storage.get<number>(key)) ?? 0;
    if (used + rows > CORPUS_LIMITS.readerRowsPerDay)
      throw new HttpError(
        429,
        "You've read today's rows. Read again tomorrow (UTC).",
        Math.ceil((Date.parse(`${day(now)}T00:00:00Z`) + DAY - now) / 1000),
        "corpus-daily-limit",
      );
    await storage.put(key, used + rows);
    await ensureAlarm(storage, now);
    return json({ used: used + rows });
  }
  if (op === "log") {
    const rows = Number(body.rows);
    if (
      typeof body.reader !== "string" ||
      !READER.test(body.reader) ||
      !(CORPUS_PURPOSES as readonly unknown[]).includes(body.purpose) ||
      typeof body.workspace !== "string" ||
      !WS.test(body.workspace) ||
      !Number.isSafeInteger(rows) ||
      rows < 0 ||
      rows > CORPUS_LIMITS.rowsPerRead
    )
      throw new HttpError(400, "Invalid log entry.");
    const entry: CorpusReadEntry = {
      at: now,
      reader: body.reader,
      purpose: body.purpose as CorpusPurpose,
      workspace: body.workspace,
      rows,
    };
    await storage.put(`${LOG}${pad16(now)}:${crypto.randomUUID().slice(0, 8)}`, entry);
    const totalKey = `${MONTH}${month(now)}:${entry.workspace}`;
    const total = (await storage.get<MonthTotal>(totalKey)) ?? { rows: 0, purposes: [] };
    await storage.put(totalKey, {
      rows: total.rows + rows,
      purposes: CORPUS_PURPOSES.filter((p) => p === entry.purpose || total.purposes.includes(p)),
    } satisfies MonthTotal);
    await ensureAlarm(storage, now);
    return json({ ok: true });
  }
  if (op === "summary") {
    if (typeof body.workspace !== "string" || !WS.test(body.workspace) || typeof body.month !== "string" || !/^\d{4}-\d{2}$/.test(body.month))
      throw new HttpError(400, "Invalid summary.");
    const total = await storage.get<MonthTotal>(`${MONTH}${body.month}:${body.workspace}`);
    return json({ month: body.month, rows: total?.rows ?? 0, purposes: total?.purposes ?? [] });
  }
  if (op === "leak") {
    const sampled = Number(body.sampled);
    const leaked = Number(body.leaked);
    if (
      typeof body.reader !== "string" ||
      !READER.test(body.reader) ||
      !Number.isSafeInteger(sampled) ||
      sampled < 1 ||
      sampled > CORPUS_LIMITS.leakSampleRows ||
      !Number.isSafeInteger(leaked) ||
      leaked < 0 ||
      leaked > sampled
    )
      throw new HttpError(400, "Invalid sample.");
    // Numbered, so two results in the same millisecond keep their order.
    const n = ((await storage.get<number>(LEAK_SEQUENCE)) ?? 0) + 1;
    await storage.put(LEAK_SEQUENCE, n);
    await storage.put(`${LEAK}${pad16(n)}`, { at: now, reader: body.reader, sampled, leaked });
    return json(await leakState(storage));
  }
  throw new HttpError(404, "Not found.");
}

async function leakState(storage: Storage) {
  const last = [
    ...(
      await storage.list<{ sampled: number; leaked: number }>({ prefix: LEAK, reverse: true, limit: 2 })
    ).values(),
  ];
  const over = (sample: { sampled: number; leaked: number }) =>
    sample.leaked * 100 > sample.sampled * CORPUS_LIMITS.leakRowsPerHundred;
  return { paused: last.length === 2 && last.every(over) };
}
async function ensureAlarm(storage: Storage, now: number) {
  if ((await storage.getAlarm()) === null) await storage.setAlarm(now + DAY);
}
/** Daily prune from CostMetrics.alarm: the read log and monthly totals
 * after 730 days, daily takes after two days. Returns whether anything is
 * left to prune later. */
export async function pruneCorpusDirectory(storage: Storage, now: number) {
  const logs = await storage.list({
    prefix: LOG,
    end: `${LOG}${pad16(now - CORPUS_LIMITS.readLogDays * DAY)}`,
    limit: 128,
  });
  if (logs.size) await storage.delete([...logs.keys()]);
  const totals = await storage.list({
    prefix: MONTH,
    end: `${MONTH}${month(now - CORPUS_LIMITS.readLogDays * DAY)}`,
    limit: 128,
  });
  if (totals.size) await storage.delete([...totals.keys()]);
  const takes = await storage.list({ prefix: TAKE, end: `${TAKE}${day(now - 2 * DAY)}`, limit: 128 });
  if (takes.size) await storage.delete([...takes.keys()]);
  const left = await storage.list({ prefix: LOG, limit: 1 });
  return left.size > 0;
}

/** The directory, called from the room and the operator route. */
export function corpusDirectory(env: CorpusDirectoryEnv) {
  const namespace = env.COST_METRICS;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(CORPUS_DIRECTORY_INSTANCE));
  const call = async <T>(op: string, body?: object): Promise<T> => {
    const response = await stub.fetch(
      new Request(`https://internal/corpus/${op}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10_000),
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw new HttpError(
        response.status >= 500 ? 503 : response.status,
        typeof data.error === "string" ? data.error : "The corpus directory is unavailable.",
        typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : undefined,
        typeof data.reason === "string" ? data.reason : undefined,
      );
    return data as T;
  };
  return {
    state: () => call<{ paused: boolean }>("state"),
    workspaces: () => call<{ workspaces: string[] }>("workspaces"),
    register: (workspace: string, room: string) => call("register", { workspace, room }),
    resolve: (workspace: string) => call<{ room: string }>("resolve", { workspace }),
    take: (reader: string, rows: number) => call("take", { reader, rows }),
    log: (entry: Omit<CorpusReadEntry, "at">) => call("log", entry),
    summary: (workspace: string, month: string) =>
      call<{ month: string; rows: number; purposes: CorpusPurpose[] }>("summary", { workspace, month }),
    leak: (reader: string, sampled: number, leaked: number) =>
      call<{ paused: boolean }>("leak", { reader, sampled, leaked }),
  };
}
