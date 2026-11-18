/** Read access to the case ledger for other features: quality review,
 * evals, legacy facts and the case routes. A read returns times, counts
 * and flags only, never message, note or tag text, a wallet or a transaction
 * hash. It grants nothing: the caller has already checked the reader's
 * current access to the workspace and, for a thread read, to that thread.
 *
 * Also the registry of case data deleters: every feature that keeps rows per
 * case adds its deleter to `supportCaseDataDeleters()`, and the ledger's
 * daily prune removes those rows before it removes a case. */
import type { SupportCase } from "@templ/chat/support";
import {
  CASE_OPENED_PREFIX,
  CASE_PREFIX,
  checkedCase,
  type CaseDataDeleter,
} from "./support-cases";
import { deleteCaseDrafts } from "./support-drafts";
import { deleteCaseEvidence } from "./support-evidence-store";
import { deleteCaseQuality } from "./support-quality";
import { deleteCaseDiagnoses } from "./support-diagnosis";
import { deleteCaseFollowUps } from "./support-follow-ups";
import { deleteCaseCorpusMarker } from "./support-corpus";
import { deleteCaseHandoffLearning } from "./support-handoff-learning";
import { deleteCaseEncryption } from "./support-encryption";

type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;

export type CaseThreadId = `tc-${string}`;
/** One member request: the thread and its case number. */
export type CaseRef = { thread: CaseThreadId; seq: number };
export type CaseRead = CaseRef & { case: SupportCase };

const THREAD = /^tc-[0-9a-f]{32}$/;
const OPENED_KEY =
  /^support-case-open-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9]{8})$/;
const pad8 = (value: number) => String(value).padStart(8, "0");
const pad16 = (value: number) => String(value).padStart(16, "0");
/** Keys per batched read (the storage API's limit). */
const READ_BATCH = 128;
/** Most cases one windowed read returns. */
const MAX_WINDOW = 5_000;
/** Most cases one thread read returns. */
const MAX_THREAD = 100;
const validSeq = (seq: unknown): seq is number =>
  Number.isSafeInteger(seq) && (seq as number) >= 1;
/** A case read shows metadata only; the follow-up counts stay in (they are
 * counts), nothing else is added. */
const read = (thread: CaseThreadId, seq: number, c: SupportCase): CaseRead => ({
  thread,
  seq,
  case: c,
});

export async function readCase(
  storage: Pick<ReadStorage, "get">,
  ref: CaseRef,
): Promise<CaseRead | null> {
  if (!THREAD.test(ref.thread) || !validSeq(ref.seq)) return null;
  const c = checkedCase(
    await storage.get(`${CASE_PREFIX}${ref.thread}:${pad8(ref.seq)}`),
    ref.thread,
    ref.seq,
  );
  return c ? read(ref.thread, ref.seq, c) : null;
}

/** A thread's cases, newest first. Rows that fail their checks are left
 * out. */
export async function readThreadCases(
  storage: ReadStorage,
  thread: CaseThreadId,
  options: { limit?: number; before?: number } = {},
): Promise<CaseRead[]> {
  if (!THREAD.test(thread)) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_THREAD));
  const rows = await storage.list<unknown>({
    prefix: `${CASE_PREFIX}${thread}:`,
    reverse: true,
    limit,
    ...(validSeq(options.before)
      ? { end: `${CASE_PREFIX}${thread}:${pad8(options.before)}` }
      : {}),
  });
  const out: CaseRead[] = [];
  for (const [key, raw] of rows) {
    const seq = Number(key.slice(key.lastIndexOf(":") + 1));
    const c = checkedCase(raw, thread, seq);
    if (c) out.push(read(thread, seq, c));
  }
  return out;
}

/** Cases opened in [from, to), oldest first (newest first with `newest`),
 * from the date index. */
export async function readCasesOpened(
  storage: ReadStorage,
  window: { from: number; to: number; limit?: number; newest?: boolean },
): Promise<CaseRead[]> {
  const limit = Math.max(1, Math.min(window.limit ?? 1_000, MAX_WINDOW));
  if (!(window.to > window.from)) return [];
  const index = await storage.list<unknown>({
    prefix: CASE_OPENED_PREFIX,
    start: `${CASE_OPENED_PREFIX}${pad16(Math.max(0, window.from))}`,
    end: `${CASE_OPENED_PREFIX}${pad16(Math.max(0, window.to))}`,
    limit,
    ...(window.newest ? { reverse: true } : {}),
  });
  const entries = [...index.keys()]
    .map((key) => OPENED_KEY.exec(key))
    .filter((match) => match !== null)
    .map((match) => ({
      openedAt: Number(match[1]),
      thread: match[2] as CaseThreadId,
      seq: Number(match[3]),
    }));
  const out: CaseRead[] = [];
  for (let offset = 0; offset < entries.length; offset += READ_BATCH) {
    const batch = entries.slice(offset, offset + READ_BATCH);
    const keys = batch.map(
      (entry) => `${CASE_PREFIX}${entry.thread}:${pad8(entry.seq)}`,
    );
    const values = await storage.get<unknown>(keys);
    batch.forEach((entry, index) => {
      const c = checkedCase(values.get(keys[index]), entry.thread, entry.seq);
      // An index row whose case is gone or was rebuilt is not a request.
      if (c && c.openedAt === entry.openedAt)
        out.push(read(entry.thread, entry.seq, c));
    });
  }
  return out;
}

/** Every feature's per-case deleter. The ledger's prune calls each before
 * it removes a case; a feature lane adds its own deleter here. */
export function supportCaseDataDeleters(): CaseDataDeleter[] {
  return [
    deleteCaseDrafts,
    deleteCaseEvidence,
    deleteCaseQuality,
    deleteCaseDiagnoses,
    deleteCaseFollowUps,
    deleteCaseCorpusMarker,
    deleteCaseHandoffLearning,
    deleteCaseEncryption,
  ];
}
