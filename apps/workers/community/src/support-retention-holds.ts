/** Legal holds checked again before every deletion batch of a pending
 * thread.
 *
 * The retention sweep checks holds before it tombstones a due thread. The
 * rows go afterwards, at most 100 per call, over several calls. A hold
 * approved between two calls, or a safety store that stops answering, must
 * stop what is left of that deletion:
 *
 * - held: the thread is taken off the pending slot, its `deleting`
 *   tombstone is cleared and its wait goes back into Needs reply as it was
 *   before the tombstone. Rows deleted by earlier batches stay deleted.
 * - holds unreadable: nothing more is deleted. The tombstone stays, so reads
 *   stay closed, and the next call checks again.
 *
 * The restore point is written with the tombstone, in the same transaction,
 * and removed with the thread's last keys. It holds times and index rows
 * only: no message text, principal or wallet. */
import { PERMISSION_REVISION_KEY } from "./room-events";
import { AWAITING_PREFIX, CASE_PREFIX } from "./support-cases";
import type { RetentionHolds } from "./safety";
import { setOpenIndex } from "./support-open-index";
import type { TeamConversationRecord } from "./team-conversations";

/** The pending thread's wait before its tombstone. */
export const RETENTION_RESTORE_KEY = "support-retention-restore-v1";
const SWEEP_PENDING = "support-retention-pending-v1";
const SWEEP_HELD = "support-retention-held-v1";
const WORKFLOW_PREFIX = "support-workflow-v1:";
const THREAD = /^tc-[0-9a-f]{32}$/;

type Storage = DurableObjectTransaction;
type RestorePoint = {
  schemaVersion: 1;
  thread: string;
  /** `awaitingSince` on the support record. */
  workflowAwaitingSince: number | null;
  /** The latest case, 0 when the thread had none. */
  caseSeq: number;
  /** `awaitingSince` on that case. */
  caseAwaitingSince: number | null;
  /** The awaiting index rows the tombstone removed, key and value. */
  awaiting: [string, unknown][];
};

const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const naturalOrNull = (value: unknown) => value === null || natural(value);
// The key formats of support-cases.ts; its helpers are module-private.
const awaitingKey = (since: number, thread: string) =>
  `${AWAITING_PREFIX}${String(since).padStart(16, "0")}:${thread}`;
const caseKey = (thread: string, seq: number) =>
  `${CASE_PREFIX}${thread}:${String(seq).padStart(8, "0")}`;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Saves the thread's wait before the tombstone clears it. Call in the
 * tombstone's transaction, before `clearThreadAwaiting`. */
export async function saveRetentionRestorePoint(
  storage: Storage,
  thread: string,
  workflow: { awaitingSince?: number | null; caseSeq?: number },
): Promise<void> {
  const seq = natural(workflow.caseSeq) ? workflow.caseSeq : 0;
  const stored =
    seq >= 1 ? object(await storage.get(caseKey(thread, seq))) : null;
  const workflowAwaitingSince = natural(workflow.awaitingSince)
    ? workflow.awaitingSince
    : null;
  const caseAwaitingSince = natural(stored?.awaitingSince)
    ? (stored.awaitingSince as number)
    : null;
  const awaiting: [string, unknown][] = [];
  for (const since of new Set(
    [workflowAwaitingSince, caseAwaitingSince].filter(natural),
  )) {
    const key = awaitingKey(since, thread);
    const value = await storage.get(key);
    if (value !== undefined) awaiting.push([key, value]);
  }
  await storage.put(RETENTION_RESTORE_KEY, {
    schemaVersion: 1,
    thread,
    workflowAwaitingSince,
    caseSeq: seq,
    caseAwaitingSince,
    awaiting,
  } satisfies RestorePoint);
}

function checkedRestorePoint(value: unknown, thread: string) {
  const point = object(value);
  if (
    !point ||
    point.schemaVersion !== 1 ||
    point.thread !== thread ||
    !naturalOrNull(point.workflowAwaitingSince) ||
    !natural(point.caseSeq) ||
    !naturalOrNull(point.caseAwaitingSince) ||
    !Array.isArray(point.awaiting) ||
    point.awaiting.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[0] !== "string" ||
        !row[0].startsWith(AWAITING_PREFIX) ||
        !row[0].endsWith(`:${thread}`),
    )
  )
    return null;
  return point as unknown as RestorePoint;
}

/** Puts the thread's wait back as the restore point recorded it. The case
 * row must still exist: a wait whose case an earlier batch deleted would
 * point Needs reply at nothing, so it is left out. */
async function restoreWait(storage: Storage, thread: string) {
  const point = checkedRestorePoint(
    await storage.get(RETENTION_RESTORE_KEY),
    thread,
  );
  if (!point) return false;
  const stored =
    point.caseSeq >= 1
      ? object(await storage.get(caseKey(thread, point.caseSeq)))
      : null;
  if (point.caseSeq >= 1 && !stored) return false;
  if (stored && point.caseAwaitingSince !== null) {
    stored.awaitingSince = point.caseAwaitingSince;
    await storage.put(caseKey(thread, point.caseSeq), stored);
  }
  const workflow = object(await storage.get(`${WORKFLOW_PREFIX}${thread}`));
  if (workflow && point.workflowAwaitingSince !== null) {
    workflow.awaitingSince = point.workflowAwaitingSince;
    await storage.put(`${WORKFLOW_PREFIX}${thread}`, workflow);
  }
  for (const [key, value] of point.awaiting) await storage.put(key, value);
  return true;
}

/** Checks the holds before a deletion batch of the pending thread. Returns
 * null when the batch may go on, "more" when a hold now covers the thread
 * (the deletion stopped and the pass goes on to the next thread), or
 * "holds-unavailable" when the holds could not be read (nothing deleted). */
export async function recheckPendingHolds(
  storage: Storage,
  pending: string,
  readHolds: (roomKey: string) => Promise<RetentionHolds | null>,
): Promise<"more" | "holds-unavailable" | null> {
  const key = `conversation-v1:${pending}`;
  const record = await storage.get<TeamConversationRecord>(key);
  // The record goes last, in the same transaction as the pending slot, so a
  // missing record leaves nothing to keep.
  if (!record || !THREAD.test(pending)) return null;
  const holds = await readHolds(record.room);
  if (!holds) {
    console.warn(
      JSON.stringify({ event: "TEMPL_SUPPORT_RETENTION_HOLDS_UNAVAILABLE" }),
    );
    return "holds-unavailable";
  }
  if (!holds.room && !holds.threads.has(pending)) return null;
  const { deleting: _deleting, ...kept } = record;
  await storage.put(key, kept);
  // Put the reopened thread back in the open index.
  // A hook before a deletion batch may have dropped it; this undoes that.
  await setOpenIndex(storage, kept);
  const restored = await restoreWait(storage, pending);
  if (!restored)
    console.warn(
      JSON.stringify({ event: "TEMPL_SUPPORT_RETENTION_WAIT_NOT_RESTORED" }),
    );
  // Reads and realtime check the revision, so the thread opens again.
  await storage.put(
    PERMISSION_REVISION_KEY,
    ((await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0) + 1,
  );
  await storage.delete([SWEEP_PENDING, RETENTION_RESTORE_KEY]);
  // The pass ends with "held", so the sweep comes back once the hold ends.
  await storage.put(SWEEP_HELD, true);
  console.warn(
    JSON.stringify({ event: "TEMPL_SUPPORT_RETENTION_PENDING_HELD" }),
  );
  return "more";
}
