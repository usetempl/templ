import { PERMISSION_REVISION_KEY } from "./room-events";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { readProductSupport, SUPPORT_REFUSAL } from "./product-entitlements";
import { HttpError } from "./common";
/** Refuses a new support message once this period's ledger is full. Reads
 * only, so a typing mark can meet the refusal its reply would. A member
 * reads only that the team can't take new requests. */
export async function assertSupportMessageAvailable(
  storage: Pick<DurableObjectTransaction, "get">,
  nowMs: number,
  role: "member" | "team" = "team",
) {
  const { funded } = await readProductSupport(storage, nowMs);
  const key = `support-message-period-v1:${resolutionMonth(nowMs)}`;
  const used = (await storage.get<number>(key)) ?? 0;
  const limit = funded
    ? PRODUCT_LIMITS.supportMessagesPerPeriod
    : PRODUCT_LIMITS.freeSupportMessages;
  if (used >= limit)
    throw new HttpError(
      429,
      role === "member"
        ? SUPPORT_REFUSAL
        : "This workspace reached its message limit for this month. Existing cases stay readable.",
      3600,
      "support-message-capacity",
    );
  return { key, used };
}
/** Support rows never enter the channel rotation pool. This ledger limits new
 * writes in a UTC calendar month without deleting an unresolved case. */
export async function reserveSupportMessage(
  storage: DurableObjectTransaction,
  nowMs: number,
  role: "member" | "team" = "team",
) {
  const { key, used } = await assertSupportMessageAvailable(
    storage,
    nowMs,
    role,
  );
  await storage.put(key, used + 1);
}
/** Rows these prefixes name belong to no current record: people counts
 * and places of a per-person allowance. The sweep deletes them, a bounded
 * batch per call, until none is left. */
const UNUSED_PREFIXES = ["product-usage-v1:", "product-reserve-v1:"];
const UNUSED_BATCH = 200;
async function dropUnusedRows(storage: DurableObjectTransaction) {
  for (const prefix of UNUSED_PREFIXES) {
    const rows = await storage.list({ prefix, limit: UNUSED_BATCH });
    if (rows.size) {
      await storage.delete([...rows.keys()]);
      return;
    }
  }
}

import { PRODUCT_STATE_KEY } from "./product-entitlements";
import type { TeamConversationRecord } from "./team-conversations";
import { SUPPORT_MEDIA_BYTES_KEY, supportRecord } from "./support-workflow";
import type { SupportAttachment } from "@templ/chat/support";
import type { SupportMediaReference } from "./media";
import type { RetentionHolds } from "./safety";
import { dropOpenIndex } from "./support-open-index";
import { deleteThreadFollowUps } from "./support-follow-ups";
import { deleteThreadPositions } from "./support-positions";
import { deleteThreadPriority } from "./support-priority";
import { clearThreadAwaiting, deleteThreadCases } from "./support-cases";
import { deleteThreadDrafts } from "./support-drafts";
import { deleteThreadEvidence } from "./support-evidence-store";
import { deleteThreadDiagnoses } from "./support-diagnosis";
import {
  recheckPendingHolds,
  RETENTION_RESTORE_KEY,
  saveRetentionRestorePoint,
} from "./support-retention-holds";
import { deleteThreadCorpusMarkers } from "./support-corpus";
import { deleteThreadHandoffLearning } from "./support-handoff-learning";
import { deleteThreadEncryption } from "./support-encryption";
import {
  retainThreadQuality,
  type KnowledgeRetention,
} from "./support-knowledge-retention";
const DAY = 86_400_000;
const SWEEP_CURSOR = "support-retention-cursor-v1";
const SWEEP_PENDING = "support-retention-pending-v1";
/** The thread the sweep is deleting; the recovery tool queues privacy
 * re-deletions behind it (storage-recovery-room.ts). */
export const SUPPORT_RETENTION_PENDING_KEY = SWEEP_PENDING;
/** Set while a pass skips a due thread under a hold; read and cleared when
 * the pass ends, so a hold anywhere in the pass brings the sweep back. */
const SWEEP_HELD = "support-retention-held-v1";
/** Stands for the thread's case rows in the deletion order. */
const CASES = "support-case-v1";
/** "more": call again soon. "held": a due thread is under a legal hold, so
 * check again later. "holds-unavailable": the holds could not be read, so
 * nothing was deleted; retry. "done": nothing is due. */
export type SweepOutcome = "more" | "done" | "held" | "holds-unavailable";
/** Delete at most 100 parent-owned rows per transaction. A tombstone closes
 * every read before chunked deletion starts, including realtime and exports.
 * A thread due for deletion is kept while a legal hold approved by Templ
 * covers it or its workspace; when the holds cannot be read, nothing is
 * deleted. Holds are read again before every batch: a hold approved after
 * the tombstone stops the rest of the deletion and reopens the thread. */
export async function sweepSupportRetention(
  storage: DurableObjectTransaction,
  nowMs: number,
  onDelete: (channel: string, id: string) => Promise<void>,
  onDeleteAttachment: (
    room: string,
    conversation: string,
    attachment: SupportAttachment,
    reference: SupportMediaReference,
  ) => Promise<void>,
  readHolds: (roomKey: string) => Promise<RetentionHolds | null>,
  // Eval copies' links and purge (optional).
  knowledge?: KnowledgeRetention,
): Promise<SweepOutcome> {
  if (!(await storage.get(PRODUCT_STATE_KEY))) return "done";
  await dropUnusedRows(storage);
  let pending = await storage.get<string>(SWEEP_PENDING);
  let moreParents = false;
  if (!pending) {
    const cursor = await storage.get<string>(SWEEP_CURSOR);
    const records = await storage.list<TeamConversationRecord>({
      prefix: "conversation-v1:",
      limit: 20,
      ...(cursor ? { startAfter: cursor } : {}),
    });
    moreParents = records.size === 20;
    // One read of the holds per call, made only once a thread is due.
    const holds = new Map<string, Promise<RetentionHolds | null>>();
    for (const [key, record] of records) {
      const workflow = await supportRecord(storage, record);
      // Every workspace keeps `supportHistoryDays` from each closed
      // request's last message, whatever its balance.
      const due =
        ["resolved", "abandoned", "spam"].includes(workflow.state) &&
        (record.lastMessageAt ?? record.createdAt) <=
          nowMs - PRODUCT_LIMITS.supportHistoryDays * DAY;
      if (due) {
        if (!holds.has(record.room))
          holds.set(record.room, readHolds(record.room));
        const held = await holds.get(record.room)!;
        if (!held) {
          // The cursor stays before this thread, so a later pass resumes here.
          console.warn(
            JSON.stringify({
              event: "TEMPL_SUPPORT_RETENTION_HOLDS_UNAVAILABLE",
            }),
          );
          return "holds-unavailable";
        }
        if (held.room || held.threads.has(record.id)) {
          await storage.put(SWEEP_CURSOR, key);
          await storage.put(SWEEP_HELD, true);
          continue;
        }
      }
      await storage.put(SWEEP_CURSOR, key);
      if (!due) continue;
      pending = record.id;
      await storage.put(SWEEP_PENDING, pending);
      await storage.put(key, { ...record, deleting: true });
      // A hold approved before the rows go puts the wait back from here.
      await saveRetentionRestorePoint(storage, record.id, workflow);
      // The thread leaves Needs reply and the pulse with its tombstone.
      await clearThreadAwaiting(storage, record.id, workflow);
      await storage.put(
        PERMISSION_REVISION_KEY,
        ((await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0) + 1,
      );
      // Commit the access tombstone before any distributed cleanup can fail.
      return "more";
    }
    if (records.size < 20 && !pending) await storage.delete(SWEEP_CURSOR);
  }
  if (!pending) {
    if (moreParents) return "more";
    // The pass is over: come back later if any due thread was held.
    const held = (await storage.get<boolean>(SWEEP_HELD)) === true;
    if (held) await storage.delete(SWEEP_HELD);
    return held ? "held" : "done";
  }
  // The four blocks below run before every deletion batch of the pending
  // thread, not once per thread: each call deletes at most 100 rows and the
  // next call re-enters here. Their work must be idempotent. Once-per-thread
  // work, such as an audit entry, goes in the block at final cleanup, keyed
  // by the thread id so a retried call still writes it once.
  // Recheck holds before a pending deletion goes on.
  {
    const recheck = await recheckPendingHolds(storage, pending, readHolds);
    if (recheck) return recheck;
  }
  // Delete a thread's drafts, evidence and case frames.
  if ((await deleteThreadEncryption(storage, pending, 100)) > 0) return "more";
  {
    // Drafts, Ask AI requests, provenance, frames and evidence go first, at
    // most 100 keys per call; the next call resumes (idempotent).
    const batch = 100;
    let removed = await deleteThreadDrafts(storage, pending, batch);
    if (removed < batch)
      removed += await deleteThreadEvidence(storage, pending, batch - removed);
    if (removed > 0) return "more";
  }
  // Unlink eval copies, delete quality records.
  {
    if ((await retainThreadQuality(storage, pending, 100, knowledge)) > 0)
      return "more";
  }
  // Transaction checks of the thread (idempotent like the one above).
  {
    const removed = await deleteThreadDiagnoses(storage, pending, 100);
    if (removed > 0) return "more";
  }
  // Follow-ups, mention grants, watches and position reads of the thread
  // (idempotent like the ones above).
  {
    let removed = await deleteThreadFollowUps(storage, pending, 100);
    if (removed < 100)
      removed += await deleteThreadPositions(storage, pending, 100 - removed);
    if (removed > 0) return "more";
  }
  // The thread's build markers go; its de-identified
  // rows stay to their own limit (support-corpus.ts). Idempotent.
  if ((await deleteThreadCorpusMarkers(storage, pending, 100)) > 0) return "more";
  if ((await deleteThreadHandoffLearning(storage, pending, 100)) > 0) return "more";
  // Drop the thread from the open index.
  await deleteThreadPriority(storage, pending);
  await dropOpenIndex(storage, pending);
  let remaining = 100;
  for (const prefix of [
    `channel-message:${pending}:`,
    `message-history-v1:${pending}:`,
    `message-reactions-v1:${pending}:`,
    `support-search-location-v1:${pending}:`,
    `support-note-v1:${pending}:`,
    `support-note-client-v1:${pending}:`,
    `support-activity-v1:${pending}:`,
    // Each case with its awaiting and date index rows.
    CASES,
    `support-seen-v1:${pending}:`,
    `support-notification-v1:${pending}:`,
    `guest-follow-up-v1:${pending}:`,
  ]) {
    if (prefix === CASES) {
      remaining -= await deleteThreadCases(storage, pending, remaining);
      if (!remaining) return "more";
      continue;
    }
    const rows = await storage.list({ prefix, limit: remaining });
    for (const key of rows.keys()) {
      if (prefix.startsWith("channel-message:"))
        await onDelete(
          pending,
          String(Number(key.slice(key.lastIndexOf(":") + 1))),
        );
      if (prefix.startsWith("support-notification-v1:"))
        await storage.put(
          "support-notification-count-v1",
          Math.max(
            0,
            ((await storage.get<number>("support-notification-count-v1")) ??
              1) - 1,
          ),
        );
      await storage.delete(key);
      remaining--;
    }
    if (!remaining) return "more";
  }
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${pending}`,
  );
  if (record) {
    const workflow = await supportRecord(storage, record);
    for (const attachment of workflow.attachments) {
      const reference = workflow.attachmentMedia[attachment.id];
      if (!reference)
        throw new HttpError(503, "Screenshot storage is unavailable.");
      await onDeleteAttachment(record.room, record.id, attachment, reference);
    }
    await storage.put(
      SUPPORT_MEDIA_BYTES_KEY,
      Math.max(
        0,
        ((await storage.get<number>(SUPPORT_MEDIA_BYTES_KEY)) ?? 0) -
          workflow.attachments.reduce((sum, image) => sum + image.bytes, 0),
      ),
    );
    const memberKey = `conversation-member-v1:${record.member}`;
    if (await storage.get<string>(memberKey) === pending) await storage.delete(memberKey);
    const counts = await storage.get<{
      schemaVersion: 1;
      records: number;
      open: number;
    }>("conversation-state-v1");
    if (counts)
      await storage.put("conversation-state-v1", {
        ...counts,
        records: Math.max(0, counts.records - 1),
        open: Math.max(0, counts.open - (record.state === "open" ? 1 : 0)),
      });
  }
  for (const key of [
    `conversation-v1:${pending}`,
    `support-workflow-v1:${pending}`,
    `support-app-answer-v1:${pending}`,
    `support-app-answer-outbox-v1:${pending}`,
    `channel-sequence:${pending}`,
    `channel-deletions:${pending}`,
    `support-activity-sequence-v1:${pending}`,
    RETENTION_RESTORE_KEY,
    SWEEP_PENDING,
  ])
    await storage.delete(key);
  return "more";
}
