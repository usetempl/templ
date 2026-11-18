/** The open-thread index.
 *
 * One room-local key per open conversation, `conversation-open-v1:<tc>`,
 * written and deleted in the same transaction as the record's state. The
 * inbox's open views read it instead of scanning every record, which lets a
 * funded workspace keep more records than one list call can scan.
 *
 * Existing rooms fill the index in the background: the `support-open-index`
 * alarm consumer indexes 200 records a run until the marker says ready.
 * Until then the list keeps its full scan and the retained cap stays at
 * PRE_INDEX_RETAINED_RECORDS. The index grants nothing: every list row still
 * reads its record and passes the same access checks. */
import { PRODUCT_LIMITS } from "@templ/chat/plans";

/** Records a funded workspace keeps, and the inbox list scans per call,
 * until its open-thread index is ready. The full retained records
 * (PRODUCT_LIMITS.supportRetainedRecords) apply once the index serves the
 * open views. */
export const PRE_INDEX_RETAINED_RECORDS = 10_000;
/** Records one list call scans for the views the index does not serve. */
export const LIST_SCAN_RECORDS = 10_000;
export const OPEN_INDEX_PREFIX = "conversation-open-v1:";
export const OPEN_INDEX_MARKER = "conversation-open-index-v1";
/** Records the backfill indexes per alarm run. */
export const OPEN_INDEX_BACKFILL_BATCH = 200;
const RECORD_PREFIX = "conversation-v1:";
const THREAD = /^tc-[0-9a-f]{32}$/;

type IndexStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list<T>(options: {
    prefix: string;
    startAfter?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
};
type Marker = { schema: 1; state: "running" | "ready"; after?: string };
type IndexedRecord = { id: string; state: string; deleting?: boolean };

const openKey = (thread: string) => `${OPEN_INDEX_PREFIX}${thread}`;
const isOpen = (record: IndexedRecord) =>
  record.state === "open" && record.deleting !== true;

/** Keeps the index in step with one record write. Idempotent. */
export async function setOpenIndex(
  storage: Pick<IndexStorage, "put" | "delete">,
  record: IndexedRecord,
) {
  if (!THREAD.test(record.id)) return;
  if (isOpen(record)) await storage.put(openKey(record.id), true);
  else await storage.delete(openKey(record.id));
}

/** Drops a thread from the index, as retention deletes it. Idempotent. */
export async function dropOpenIndex(
  storage: Pick<IndexStorage, "delete">,
  thread: string,
) {
  if (THREAD.test(thread)) await storage.delete(openKey(thread));
}

async function marker(storage: Pick<IndexStorage, "get">) {
  const value = await storage.get<Marker>(OPEN_INDEX_MARKER);
  return value?.schema === 1 &&
    (value.state === "running" || value.state === "ready")
    ? value
    : null;
}

/** Starts the marker the first time a room writes a record: a room with no
 * records yet is ready at once, any other starts its backfill. */
export async function ensureOpenIndexMarker(
  storage: Pick<IndexStorage, "get" | "put" | "list">,
) {
  if (await storage.get(OPEN_INDEX_MARKER)) return;
  const any = await storage.list({ prefix: RECORD_PREFIX, limit: 1 });
  await storage.put(OPEN_INDEX_MARKER, {
    schema: 1,
    state: any.size ? "running" : "ready",
  } satisfies Marker);
}
/** Whether the index serves the open views. */
export async function openIndexReady(storage: Pick<IndexStorage, "get">) {
  return (await marker(storage))?.state === "ready";
}

/** Retained records a funded room may keep now. */
export async function fundedRetainedRecords(storage: Pick<IndexStorage, "get">) {
  return (await openIndexReady(storage))
    ? PRODUCT_LIMITS.supportRetainedRecords
    : PRE_INDEX_RETAINED_RECORDS;
}

/** One backfill step, inside a storage transaction. Returns true while
 * records remain. A room with no records is ready at once. */
export async function backfillOpenIndex(storage: IndexStorage) {
  const current = await marker(storage);
  if (current?.state === "ready") return false;
  const after = current?.after;
  const page = await storage.list<IndexedRecord>({
    prefix: RECORD_PREFIX,
    ...(after ? { startAfter: `${RECORD_PREFIX}${after}` } : {}),
    limit: OPEN_INDEX_BACKFILL_BATCH,
  });
  let last: string | undefined = after;
  for (const [key, record] of page) {
    const id = key.slice(RECORD_PREFIX.length);
    last = id;
    if (!record || typeof record !== "object" || record.id !== id) continue;
    await setOpenIndex(storage, record);
  }
  const done = page.size < OPEN_INDEX_BACKFILL_BATCH;
  await storage.put(OPEN_INDEX_MARKER, {
    schema: 1,
    state: done ? "ready" : "running",
    ...(!done && last ? { after: last } : {}),
  } satisfies Marker);
  return !done;
}

/** The open records after `cursor`, in thread order, read through the
 * index. Returns the raw records keyed as the record scan keys them, so the
 * list applies the same checks to both. */
export async function openIndexRecords(
  storage: Pick<IndexStorage, "get" | "list">,
  cursor: string | null,
) {
  const keys = await storage.list<true>({
    prefix: OPEN_INDEX_PREFIX,
    ...(cursor ? { startAfter: openKey(cursor) } : {}),
    // The open cap bounds the index; one more shows a stale entry.
    limit: PRODUCT_LIMITS.supportOpenRecords + 1,
  });
  const recordKeys = [...keys.keys()].map(
    (key) => `${RECORD_PREFIX}${key.slice(OPEN_INDEX_PREFIX.length)}`,
  );
  const records = new Map<string, unknown>();
  for (const key of recordKeys) {
    const value = await storage.get<unknown>(key);
    if (value !== undefined) records.set(key, value);
  }
  return records;
}

/** The alarm consumer body: run one backfill step and ask to come back in
 * a second while records remain. */
export async function openIndexAlarm(
  state: Pick<DurableObjectState, "storage">,
  now: number,
) {
  const more = await state.storage.transaction((txn) =>
    backfillOpenIndex(txn as unknown as IndexStorage),
  );
  return more ? now + 1_000 : null;
}
