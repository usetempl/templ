import type { Env } from "./common";
import type { EmailEnv } from "./email-delivery";
import type { ProductBillingEnv } from "./product-billing";
import type { SearchIndex } from "./search-index";

/** Every timed job in a room object. The room keeps one platform alarm; each
 * consumer reports when it next needs to run and the scheduler keeps the
 * earliest time. Registration order is `roomAlarmConsumers()` in channels.ts. */
export const ROOM_ALARM_CONSUMER_IDS = [
  "priority-trial-capture",
  "workspace-flags",
  "own-encryption-qualification",
  "support-notifications",
  "support-storage-flush",
  "support-retention",
  "support-trial-archive",
  "group-attachment-outbox",
  "group-storage-discovery",
  "group-storage-migration",
  "support-case-ledger",
  // Member silence deadlines.
  // Each thread has one durable due-index entry.
  "support-abandon",
  // Alert-outbox and support-escalation consumers.
  // Escalation, waiting summaries and unseen replies, then the
  // outbox, so an alert made in this run is sent in the same run.
  "support-escalation",
  "alert-outbox",
  "native-telegram",
  "app-ai-replies",
  // The guard-only diagnosis job.
  // Queued automatic transaction checks (a member's share, Ask AI, the
  // key guard) and the daily sweep of check keys whose thread is gone.
  "support-diagnosis",
  // The watch consumer.
  // Follow-up reminders, overdue marks and escalations, then chain-state
  // watches and queued position reads.
  "support-follow-ups",
  "support-watches",
  // The open-thread index backfill.
  "support-open-index",
  // The charge ledger and billing alerts.
  "product-billing",
  "stripe-deletion-cleanup",
  // Text-free push alerts to staff.
  "staff-push",
  // Queued managed AI jobs handed to the knowledge object.
  "managed-agent",
  // Retried cleanup of uncertain learned FAQ writes; never model calls.
  "handoff-learning-cleanup",
  "storage-recovery",
  // Templ's de-identified copy of finished requests.
  "support-corpus",
  // Workspace deletion after its cancel window.
  "workspace-deletion",
  "room-daily",
] as const;
export type RoomAlarmConsumerId = (typeof ROOM_ALARM_CONSUMER_IDS)[number];
/** Reserved for later releases. Registering one needs its own durable due index. */
export const RESERVED_ROOM_ALARM_CONSUMER_IDS = [
  // R3 managed agent knowledge base
  "knowledge-refresh",
] as const;
export type ReservedRoomAlarmConsumerId =
  (typeof RESERVED_ROOM_ALARM_CONSUMER_IDS)[number];
export type RoomAlarmContext = {
  state: DurableObjectState;
  env: Env & ProductBillingEnv & Partial<EmailEnv>;
  searchIndex: SearchIndex;
};
export type RoomAlarmConsumer = {
  /** A reserved id cannot be registered until it has its own due index. */
  id: Exclude<RoomAlarmConsumerId, ReservedRoomAlarmConsumerId>;
  /** Does at most a bounded batch of work and returns the absolute epoch ms at
   * which it next needs to run, or null when it has nothing timed. It must not
   * call setAlarm/deleteAlarm; request paths use wakeRoomAt. */
  run(context: RoomAlarmContext, now: number): Promise<number | null>;
};
export const ROOM_ALARM_RECOVERY_MS = 60_000;
export const ROOM_ALARM_MIN_DELAY_MS = 1_000;
type AlarmStorage = {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
};

/** The only "schedule earlier" primitive for room code. Safe from any request
 * or transaction: it can only move the alarm earlier. */
export async function wakeRoomAt(
  storage: AlarmStorage,
  at: number,
): Promise<void> {
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > at) await storage.setAlarm(at);
}

/** Runs every consumer in order, then sets the alarm to the earliest due time.
 * A consumer that throws does not stop the others; the room retries within a
 * minute and the first error is rethrown after scheduling. */
export async function runRoomAlarm(
  context: RoomAlarmContext,
  consumers: readonly RoomAlarmConsumer[],
): Promise<number | null> {
  const storage = context.state.storage;
  const recoveryAt = Date.now() + ROOM_ALARM_RECOVERY_MS;
  // Arm recovery before any distributed work: a thrown read must not exhaust
  // the platform's bounded retries and strand accepted writes.
  await wakeRoomAt(storage, recoveryAt);
  let due = Infinity;
  const errors: unknown[] = [];
  for (const consumer of consumers) {
    try {
      const next = await consumer.run(context, Date.now());
      if (next === null) continue;
      if (!Number.isSafeInteger(next))
        throw new Error(`Invalid due time from ${consumer.id}`);
      due = Math.min(due, next);
    } catch (error) {
      errors.push(error);
      due = Math.min(due, Date.now() + ROOM_ALARM_RECOVERY_MS);
    }
  }
  const now = Date.now();
  const target = Number.isFinite(due)
    ? Math.max(now + ROOM_ALARM_MIN_DELAY_MS, due)
    : null;
  const current = await storage.getAlarm();
  // A concurrent request may have set an earlier wake-up while consumers
  // awaited I/O. wakeRoomAt only ever lowers the alarm, so any value other than
  // our own recovery time is a real, earlier or equal need and is kept.
  if (target === null) {
    if (current === recoveryAt) await storage.deleteAlarm();
  } else if (current === null || current === recoveryAt || current > target) {
    await storage.setAlarm(target);
  }
  if (errors.length) throw errors[0];
  return target;
}
