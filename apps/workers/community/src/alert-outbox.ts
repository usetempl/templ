import { customerBillingManagedByTempl } from "./customer-debt-access";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
/** The alert-event outbox: one emit call per event, one queue per
 * destination, and a room alarm consumer that leases, renders, sends, logs
 * and acknowledges. Every key is room-local.
 *
 * - `emitAlert` runs inside the caller's transaction and never throws for
 *   an alert reason: a full queue or an unreadable index is counted, and the
 *   member's request still commits.
 * - The consumer keeps a durable due index (`alert-due-v1:<due>:<dest>`, at
 *   most one per destination), bounds each run, is idempotent under retry
 *   (attempts are written before each send) and rechecks the destination,
 *   its manager and the release switch at send time. It never calls
 *   setAlarm; it returns its next due time to the room alarm. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import {
  SUPPORT_ALERT_LIMITS,
  type AlertEventFacts,
  type AlertEventType,
  type AlertLogEntry,
  type AlertLogOutcome,
  type AlertWebhookMember,
} from "@templ/chat/support-alerts";
import { wakeRoomAt } from "./room-alarm";
import {
  DEST_INDEX_KEY,
  DEST_PREFIX,
  checkedDestination,
  indexEntry,
  type AlertDestinationRecord,
  type AlertTarget,
  type DestinationIndexEntry,
} from "./alert-destinations";
import {
  AlertSecretUnreadable,
  alertAad,
  alertKeyConfigured,
  openAlertSecret,
  type AlertCryptoEnv,
} from "./alert-crypto";
import {
  chatBody,
  chatPost,
  webhookBody,
  type AlertInboxFooter,
  type StoredAlertEvent,
} from "./alert-render";
import {
  sendChatWebhook,
  sendTelegram,
  sendWebhook,
  webhookHeaders,
  type SendDeps,
  type SendResult,
} from "./alert-send";
import { uuidv7 } from "./uuidv7";
import { aiPrincipals, BOT_SETTINGS_ERROR } from "./bots";
import { HttpError } from "./common";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { currentHumanAdmin } from "./workspace-admin";

export type AlertEnv = WorkspaceFlagEnv &
  AlertCryptoEnv & {
  SUPPORT_ALERTS_ENABLED?: string;
  TEMPL_STAFF_PRINCIPALS?: string;
  APP_ORIGIN?: string;
  WORKERS_DEV_SUBDOMAIN?: string;
};
type Tx = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;

export const EVENT_PREFIX = "alert-event-v1:";
export const EVENT_COUNT_KEY = "alert-event-count-v1";
export const QUEUE_PREFIX = "alert-queue-v1:";
export const QUEUE_COUNT_PREFIX = "alert-queue-count-v1:";
export const DUE_PREFIX = "alert-due-v1:";
/** Where each destination's single due entry sits, so it can move. */
export const DUE_OF_PREFIX = "alert-due-of-v1:";
export const OVERFLOW_PREFIX = "alert-overflow-v1:";
export const LOG_PREFIX = "alert-log-v1:";
export const LOG_COUNT_PREFIX = "alert-log-count-v1:";
export const DAY_PREFIX = "alert-day-v1:";
export const TEST_PREFIX = "alert-test-v1:";
export const SUMMARY_PREFIX = "alert-summary-v1:";
/** Member reply-email tickets by hash (`{ principal, expiresAt }`), each
 * principal's one live ticket (the hash), the page grants, and the daily
 * count of channel creates. */
export const TICKET_PREFIX = "alert-ticket-v1:";
export const TICKET_OF_PREFIX = "alert-ticket-of-v1:";
export const GRANT_PREFIX = "alert-grant-v1:";
export const CREATES_PREFIX = "alert-creates-v1:";
/** The one-click unsubscribe tokens of member reply emails. */
export const UNSUBSCRIBE_PREFIX = "alert-unsub-v1:";
/** @public Every key prefix team alerts and member reply email write. The
 * locality test checks none of them lands in a support partition. */
export const ALERT_KEY_PREFIXES = [
  DEST_PREFIX,
  DEST_INDEX_KEY,
  EVENT_PREFIX,
  EVENT_COUNT_KEY,
  QUEUE_PREFIX,
  QUEUE_COUNT_PREFIX,
  DUE_PREFIX,
  DUE_OF_PREFIX,
  OVERFLOW_PREFIX,
  LOG_PREFIX,
  LOG_COUNT_PREFIX,
  DAY_PREFIX,
  TEST_PREFIX,
  SUMMARY_PREFIX,
  TICKET_PREFIX,
  TICKET_OF_PREFIX,
  GRANT_PREFIX,
  CREATES_PREFIX,
  UNSUBSCRIBE_PREFIX,
] as const;

const LEASE_MS = 30_000;
const DESTINATIONS_PER_RUN = 10;
const CHAT_ROWS_PER_POST = 20;
const WEBHOOK_ROWS_PER_RUN = 10;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Delays after each failed attempt. */
export const WEBHOOK_BACKOFF = [30_000, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
export const CHAT_BACKOFF = [30_000, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR];

export type QueueRow = {
  type: AlertEventType;
  /** The event's time, for its deadline. */
  at: number;
  attempts: number;
  firstAttemptAt?: number;
  nextAt: number;
  uncertain?: boolean;
};
type EventRow = StoredAlertEvent & { pending: number };
type OverflowRow = {
  count: number;
  since: number;
  byType: Partial<Record<AlertEventType, number>>;
  /** Of `count`, how many met the daily delivery cap. */
  dailyCap?: number;
};

const pad16 = (value: number) => String(Math.max(0, Math.floor(value))).padStart(16, "0");
const pad2 = (value: number) => String(Math.min(99, value)).padStart(2, "0");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const chatKind = (kind: AlertDestinationRecord["kind"]) => kind !== "webhook";
const deadlineOf = (kind: AlertDestinationRecord["kind"], at: number) =>
  at + (chatKind(kind) ? SUPPORT_ALERT_LIMITS.chatDeadlineMs : SUPPORT_ALERT_LIMITS.webhookDeadlineMs);
export const destKey = (id: string) => `${DEST_PREFIX}${id}`;
const queueKey = (dest: string, event: string) => `${QUEUE_PREFIX}${dest}:${event}`;

/** Team alerts go out only with the release switch on and the worker key
 * present. Without either, nothing is queued and nothing is sent. */
export function alertsEnabled(env: AlertEnv): boolean {
  return (
    alertKeyConfigured(env) &&
    ["webhook", "slack", "discord", "telegram"].some((kind) =>
      alertFeatureOn(env, kind),
    )
  );
}
export function alertFeatureOn(env: AlertEnv, kind: string): boolean {
  const key = `alerts.${kind}`;
  return (
    [
      "alerts.webhook",
      "alerts.slack",
      "alerts.discord",
      "alerts.telegram",
    ].includes(key) &&
    featureOn(
      env,
      undefined,
      key as
        | "alerts.webhook"
        | "alerts.slack"
        | "alerts.discord"
        | "alerts.telegram",
    )
  );
}
/** One fixed-label operator line; never a URL, token, chat id, workspace or
 * thread. */
export function logAlertFailure(kind: string, status: number | null, reason: string) {
  console.error(
    JSON.stringify({
      event: "TEMPL_SUPPORT_FAILURE",
      route: "alert-delivery",
      kind,
      statusClass: status === null ? "none" : `${Math.floor(status / 100)}xx`,
      reason,
    }),
  );
}

function checkedIndex(value: unknown): DestinationIndexEntry[] | null {
  if (!Array.isArray(value) || value.length > FEATURE_LIMITS.alertDestinationsPerWorkspace)
    return null;
  for (const entry of value)
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.kind !== "string" ||
      !Array.isArray(entry.events) ||
      !["unverified", "active", "paused"].includes(entry.status)
    )
      return null;
  return value as DestinationIndexEntry[];
}
/** The destination list, rebuilt from the rows when the index is missing
 * or unreadable. An unreadable row is left out of the index. */
export async function readDestinationIndex(storage: Tx): Promise<DestinationIndexEntry[]> {
  const stored = await storage.get(DEST_INDEX_KEY);
  const index = stored === undefined ? null : checkedIndex(stored);
  if (index) return index;
  const rows = await storage.list<unknown>({
    prefix: DEST_PREFIX,
    limit: FEATURE_LIMITS.alertDestinationsPerWorkspace + 8,
  });
  const rebuilt: DestinationIndexEntry[] = [];
  for (const [key, value] of rows) {
    const row = checkedDestination(value, key.slice(DEST_PREFIX.length));
    if (row && rebuilt.length < FEATURE_LIMITS.alertDestinationsPerWorkspace)
      rebuilt.push(indexEntry(row));
  }
  if (rebuilt.length || stored !== undefined) await storage.put(DEST_INDEX_KEY, rebuilt);
  return rebuilt;
}
/** Saves a destination row and its index entry together. */
export async function saveDestination(storage: Tx, row: AlertDestinationRecord) {
  await storage.put(destKey(row.id), row);
  const index = (await readDestinationIndex(storage)).filter((entry) => entry.id !== row.id);
  index.push(indexEntry(row));
  await storage.put(DEST_INDEX_KEY, index);
}
/** Moves a destination's single due entry to `at` (or removes it). */
export async function scheduleDue(storage: Tx, dest: string, at: number | null, earlierOnly = false) {
  const pointer = `${DUE_OF_PREFIX}${dest}`;
  const current = await storage.get<number>(pointer);
  if (earlierOnly && natural(current) && at !== null && current <= at) return;
  if (natural(current)) await storage.delete(`${DUE_PREFIX}${pad16(current)}:${dest}`);
  if (at === null) {
    await storage.delete(pointer);
    return;
  }
  await storage.put(pointer, at);
  await storage.put(`${DUE_PREFIX}${pad16(at)}:${dest}`, true);
}
async function bump(storage: Tx, key: string, by: number) {
  const value = await storage.get<number>(key);
  const next = Math.max(0, (natural(value) ? value : 0) + by);
  if (next) await storage.put(key, next);
  else await storage.delete(key);
  return next;
}
async function addOverflow(storage: Tx, dest: string, type: AlertEventType, now: number, dailyCap = false) {
  const key = `${OVERFLOW_PREFIX}${dest}`;
  const stored = await storage.get<OverflowRow>(key);
  const row: OverflowRow =
    stored && natural(stored.count) && natural(stored.since)
      ? stored
      : { count: 0, since: now, byType: {} };
  row.count++;
  row.byType[type] = (row.byType[type] ?? 0) + 1;
  if (dailyCap) row.dailyCap = (row.dailyCap ?? 0) + 1;
  await storage.put(key, row);
  logAlertFailure("overflow", null, dailyCap ? "daily-cap" : "queue-full");
}
export async function readOverflow(storage: Pick<Tx, "get">, dest: string) {
  const row = await storage.get<OverflowRow>(`${OVERFLOW_PREFIX}${dest}`);
  return row && natural(row.count) && natural(row.since) ? row : null;
}

/** Queues one event for every active destination that subscribes to it
 * (or only `only`, for a test ping or a waiting summary). Runs in the
 * caller's transaction; never throws for an alert reason. */
export async function emitAlert(
  storage: Tx,
  env: AlertEnv,
  input: AlertEventFacts,
  now: number,
  options: { only?: string } = {},
): Promise<{ queued: number; overflowed: number }> {
  if (!alertsEnabled(env)) return { queued: 0, overflowed: 0 };
  try {
    const native = await storage.get<{ room?: { id?: string } }>("native-room");
    if (input.type === "capacity" && input.capacity?.alert !== "suspended" &&
        customerBillingManagedByTempl(native?.room?.id ?? "")) return { queued: 0, overflowed: 0 };
    const index = await readDestinationIndex(storage);
    const targets = index.filter(
      (entry) =>
        entry.status === "active" &&
        (options.only
          ? entry.id === options.only
          : (entry.events as readonly string[]).includes(input.type)),
    );
    if (!targets.length) return { queued: 0, overflowed: 0 };
    const id = uuidv7(now);
    const events = await storage.get<number>(EVENT_COUNT_KEY);
    const eventsFull = natural(events) && events >= FEATURE_LIMITS.alertPendingEvents;
    let queued = 0;
    let overflowed = 0;
    let earliest = Infinity;
    for (const target of targets) {
      const count = await storage.get<number>(`${QUEUE_COUNT_PREFIX}${target.id}`);
      if (eventsFull || (natural(count) && count >= SUPPORT_ALERT_LIMITS.pendingPerDestination)) {
        await addOverflow(storage, target.id, input.type, now);
        overflowed++;
        continue;
      }
      const row = checkedDestination(await storage.get(destKey(target.id)), target.id);
      if (!row || row.status !== "active" || !alertFeatureOn(env, row.kind)) continue;
      const nextAt = chatKind(row.kind)
        ? Math.max(now, (row.lastSentAt ?? 0) + SUPPORT_ALERT_LIMITS.chatWindowMs)
        : now;
      await storage.put(queueKey(target.id, id), {
        type: input.type,
        at: input.at,
        attempts: 0,
        nextAt,
      } satisfies QueueRow);
      await bump(storage, `${QUEUE_COUNT_PREFIX}${target.id}`, 1);
      await scheduleDue(storage, target.id, nextAt, true);
      earliest = Math.min(earliest, nextAt);
      queued++;
    }
    if (queued) {
      await storage.put(`${EVENT_PREFIX}${id}`, { ...input, v: 1, id, pending: queued } satisfies EventRow);
      await bump(storage, EVENT_COUNT_KEY, 1);
      await wakeRoomAt(storage, earliest);
    }
    return { queued, overflowed };
  } catch {
    logAlertFailure("emit", null, "unreadable");
    return { queued: 0, overflowed: 0 };
  }
}

async function writeLog(
  storage: Tx,
  dest: string,
  event: { id: string; type: AlertEventType },
  attempt: number,
  now: number,
  outcome: AlertLogOutcome,
  status: number | null,
  ms: number | null,
  reason: string | null,
) {
  await storage.put(
    `${LOG_PREFIX}${dest}:${pad16(now)}:${event.id}:${pad2(attempt)}`,
    {
      at: new Date(now).toISOString(),
      event: event.type,
      attempt,
      outcome,
      status,
      ms,
      reason,
    } satisfies AlertLogEntry,
  );
  await bump(storage, `${LOG_COUNT_PREFIX}${dest}`, 1);
}
/** Removes one queue row and, when it was the event's last, the event. */
async function ack(storage: Tx, dest: string, eventId: string) {
  const key = queueKey(dest, eventId);
  if ((await storage.get(key)) === undefined) return;
  await storage.delete(key);
  await bump(storage, `${QUEUE_COUNT_PREFIX}${dest}`, -1);
  const eventKey = `${EVENT_PREFIX}${eventId}`;
  const event = await storage.get<EventRow>(eventKey);
  if (!event) return;
  if (!natural(event.pending) || event.pending <= 1) {
    await storage.delete(eventKey);
    await bump(storage, EVENT_COUNT_KEY, -1);
  } else await storage.put(eventKey, { ...event, pending: event.pending - 1 });
}
function checkedQueueRow(value: unknown): QueueRow | null {
  const row = value as QueueRow;
  return row &&
    typeof row.type === "string" &&
    natural(row.at) &&
    natural(row.attempts) &&
    natural(row.nextAt)
    ? row
    : null;
}
async function queueRows(storage: Tx, dest: string) {
  const rows = await storage.list<unknown>({
    prefix: `${QUEUE_PREFIX}${dest}:`,
    limit: SUPPORT_ALERT_LIMITS.pendingPerDestination + 1,
  });
  const out: { eventId: string; row: QueueRow | null }[] = [];
  for (const [key, value] of rows)
    out.push({ eventId: key.slice(`${QUEUE_PREFIX}${dest}:`.length), row: checkedQueueRow(value) });
  return out;
}
/** A paused or unavailable destination keeps its queue; rows past their
 * deadline are logged "skipped" and removed. Returns the next deadline. */
async function ageOut(storage: Tx, row: AlertDestinationRecord, now: number) {
  let next: number | null = null;
  for (const { eventId, row: queued } of await queueRows(storage, row.id)) {
    const deadline = queued ? deadlineOf(row.kind, queued.at) : 0;
    if (!queued || deadline <= now) {
      await writeLog(storage, row.id, { id: eventId, type: queued?.type ?? "ping" }, queued?.attempts ?? 0, now, "skipped", null, null, queued ? "paused" : "unreadable");
      await ack(storage, row.id, eventId);
    } else next = next === null ? deadline : Math.min(next, deadline);
  }
  return next;
}

export type OutboxDeps = SendDeps & {
  /** The inbox numbers for a post's footer. */
  footer?: (storage: Tx) => Promise<AlertInboxFooter | null>;
  /** Wallet and shared transactions for an opted-in webhook, read at send
   * time; null when the thread or case is gone. */
  member?: (storage: Tx, thread: string) => Promise<AlertWebhookMember | null>;
  /** Queues the manager's email when a destination pauses after failing. */
  notifyPaused?: (storage: Tx, row: AlertDestinationRecord, now: number) => Promise<void>;
};

type Leased = {
  row: AlertDestinationRecord;
  due: { eventId: string; row: QueueRow; event: EventRow | null }[];
  overflow: OverflowRow | null;
};
async function humanManager(
  storage: Pick<DurableObjectTransaction, "get">,
  manager: string,
): Promise<boolean> {
  const settings = await storage.get<object>("chat-settings");
  if (!settings) throw new HttpError(503, BOT_SETTINGS_ERROR);
  return !(await aiPrincipals(storage, settings)).includes(manager as ChatPrincipalId);
}
async function currentApproval(storage: Tx, env: AlertEnv, row: AlertDestinationRecord, manager?: string) {
  if (!manager || (row.approvalOwner ?? row.approvedBy) !== manager) return false;
  if (row.approvedBy === manager) return humanManager(storage, manager);
  return !row.walletContext && row.approvalOwner !== undefined &&
    currentHumanAdmin(storage, row.approvedBy, row.approvalAliases, env);
}
/** Step 2 of a run for one destination, in its own transaction. */
async function lease(storage: Tx, env: AlertEnv, dest: string, now: number,
): Promise<Leased | { next: number | null }> {
  const row = checkedDestination(await storage.get(destKey(dest)), dest);
  if (!row) {
    await scheduleDue(storage, dest, null);
    return { next: null };
  }
  const native = await storage.get<{ room?: { id?: string; manager?: string } }>("native-room");
  const manager = native?.room?.manager;
  if (row.status === "active" &&
    (!(await currentApproval(storage, env, row, manager)))) {
    row.status = "paused";
    row.pausedReason = "manager-changed";
    row.updatedAt = now;
    await saveDestination(storage, row);
  }
  if (row.status !== "active" || !alertsEnabled(env) ||
    !alertFeatureOn(env, row.kind)) {
    const next = await ageOut(storage, row, now);
    await scheduleDue(storage, dest, next);
    return { next };
  }
  if ((row.leaseUntil ?? 0) > now) {
    await scheduleDue(storage, dest, row.leaseUntil!);
    return { next: row.leaseUntil! };
  }
  const overflowRow = await readOverflow(storage, dest);
  let overflow = overflowRow;
  // A webhook hears of dropped events as an event of its own.
  if (overflowRow && row.kind === "webhook") {
    const id = uuidv7(now);
    await storage.put(`${EVENT_PREFIX}${id}`, {
      v: 1,
      id,
      type: "overflow",
      at: now,
      overflow: { count: overflowRow.count, since: overflowRow.since, byType: overflowRow.byType },
      pending: 1,
    } satisfies EventRow);
    await bump(storage, EVENT_COUNT_KEY, 1);
    await storage.put(queueKey(dest, id), { type: "overflow", at: now, attempts: 0, nextAt: now } satisfies QueueRow);
    await bump(storage, `${QUEUE_COUNT_PREFIX}${dest}`, 1);
    await storage.delete(`${OVERFLOW_PREFIX}${dest}`);
    overflow = null;
  }
  const internalBilling = customerBillingManagedByTempl(native?.room?.id ?? "");
  const due: Leased["due"] = [];
  let next: number | null = null;
  const limit = chatKind(row.kind) ? CHAT_ROWS_PER_POST : WEBHOOK_ROWS_PER_RUN;
  const dayKey = `${DAY_PREFIX}${utcDay(now)}`;
  const day = await storage.get<{ deliveries: number }>(dayKey);
  let deliveries = natural(day?.deliveries) ? day!.deliveries : 0;
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  for (const { eventId, row: queued } of await queueRows(storage, dest)) {
    if (!queued) {
      await writeLog(storage, dest, { id: eventId, type: "ping" }, 0, now, "skipped", null, null, "unreadable");
      await ack(storage, dest, eventId);
      continue;
    }
    if (deadlineOf(row.kind, queued.at) <= now) {
      await writeLog(storage, dest, { id: eventId, type: queued.type }, queued.attempts, now, "expired", null, null, "deadline");
      await ack(storage, dest, eventId);
      continue;
    }
    if (queued.nextAt > now || due.length >= limit) {
      next = next === null ? queued.nextAt : Math.min(next, queued.nextAt);
      continue;
    }
    const event = checkedEvent(await storage.get(`${EVENT_PREFIX}${eventId}`), eventId);
    if (internalBilling && event?.type === "capacity" && event.capacity?.alert !== "suspended") {
      await writeLog(storage, dest, { id: eventId, type: event.type }, queued.attempts, now, "skipped", null, null, "billing-managed-by-templ");
      await ack(storage, dest, eventId);
      continue;
    }
    // A chat post is one delivery; each webhook POST is one.
    const cost = chatKind(row.kind) ? (due.length ? 0 : 1) : 1;
    if (deliveries + cost > FEATURE_LIMITS.alertDeliveriesPerDay) {
      await storage.put(queueKey(dest, eventId), { ...queued, nextAt: midnight });
      await addOverflow(storage, dest, queued.type, now, true);
      next = next === null ? midnight : Math.min(next, midnight);
      continue;
    }
    deliveries += cost;
    const attempt: QueueRow = {
      ...queued,
      attempts: queued.attempts + 1,
      firstAttemptAt: queued.firstAttemptAt ?? now,
      uncertain: true,
    };
    // Written before the send: a crash after this is an uncertain attempt.
    await storage.put(queueKey(dest, eventId), attempt);
    due.push({ eventId, row: attempt, event });
  }
  await storage.put(dayKey, { deliveries });
  if (!due.length) {
    await scheduleDue(storage, dest, next);
    return { next };
  }
  row.leaseUntil = now + LEASE_MS;
  await storage.put(destKey(dest), row);
  await scheduleDue(storage, dest, row.leaseUntil);
  return { row, due, overflow };
}
function checkedEvent(value: unknown, id: string): EventRow | null {
  const event = value as EventRow;
  return event && event.v === 1 && event.id === id && typeof event.type === "string" && natural(event.at)
    ? event
    : null;
}

/** Step 6: logs, acknowledgements, retries and the destination's delivery
 * state, in one transaction. */
async function settle(
  storage: Tx,
  dest: string,
  leased: Leased,
  results: { eventId: string; result: SendResult }[],
  now: number,
  deps: OutboxDeps,
) {
  const row = checkedDestination(await storage.get(destKey(dest)), dest);
  if (!row) return null;
  const backoff = chatKind(row.kind) ? CHAT_BACKOFF : WEBHOOK_BACKOFF;
  let delivered = false;
  let failed = false;
  for (const { eventId, result } of results) {
    const entry = leased.due.find((item) => item.eventId === eventId)!;
    const type = entry.event?.type ?? entry.row.type;
    const attempt = entry.row.attempts;
    const status = result.status;
    if (result.outcome === "delivered") {
      await writeLog(storage, dest, { id: eventId, type }, attempt, now, "delivered", status, result.ms, null);
      await ack(storage, dest, eventId);
      delivered = true;
      continue;
    }
    const reason = result.reason;
    if (result.outcome === "retry") {
      const delay = Math.min(HOUR, result.retryAfterMs ?? backoff[Math.min(attempt, backoff.length) - 1] ?? HOUR);
      const nextAt = now + Math.max(1_000, delay);
      if (attempt >= backoff.length + 1 || nextAt >= deadlineOf(row.kind, entry.row.at)) {
        await writeLog(storage, dest, { id: eventId, type }, attempt, now, "expired", status, result.ms, reason);
        await ack(storage, dest, eventId);
        logAlertFailure(row.kind, status, "expired");
      } else {
        await writeLog(storage, dest, { id: eventId, type }, attempt, now, "retrying", status, result.ms, reason);
        await storage.put(queueKey(dest, eventId), { ...entry.row, nextAt, uncertain: false } satisfies QueueRow);
      }
      failed = true;
      continue;
    }
    if (result.outcome === "paused") {
      await writeLog(storage, dest, { id: eventId, type }, attempt, now, "failed", status, result.ms, reason);
      await storage.put(queueKey(dest, eventId), { ...entry.row, uncertain: false } satisfies QueueRow);
      row.status = "paused";
      row.pausedReason = "provider-disabled";
      logAlertFailure(row.kind, status, reason);
      failed = true;
      continue;
    }
    await writeLog(storage, dest, { id: eventId, type }, attempt, now, "failed", status, result.ms, reason);
    await ack(storage, dest, eventId);
    logAlertFailure(row.kind, status, reason);
    failed = true;
  }
  if (delivered) {
    row.lastSentAt = now;
    row.lastOkAt = now;
    row.consecutiveFailures = 0;
    delete row.failingSince;
    if (leased.overflow) await storage.delete(`${OVERFLOW_PREFIX}${dest}`);
  } else if (failed) {
    const first = results[0].result;
    row.consecutiveFailures++;
    row.failingSince ??= now;
    row.lastFailure = {
      at: now,
      status: first.status,
      reason: first.outcome === "delivered" ? "" : first.reason,
    };
    if (
      row.status === "active" &&
      now - row.failingSince >= SUPPORT_ALERT_LIMITS.failingPauseMs &&
      (row.lastOkAt ?? 0) < row.failingSince
    ) {
      row.status = "paused";
      row.pausedReason = "failing";
      await deps.notifyPaused?.(storage, row, now);
    }
  }
  delete row.leaseUntil;
  row.updatedAt = now;
  await saveDestination(storage, row);
  let next: number | null = null;
  for (const { row: queued } of await queueRows(storage, dest))
    if (queued) next = next === null ? queued.nextAt : Math.min(next, queued.nextAt);
  if (row.status !== "active") {
    const aged = await ageOut(storage, row, now);
    next = aged;
  }
  await scheduleDue(storage, dest, next);
  return next;
}

type Room = { storage: DurableObjectStorage };
/** Recheck the approval and exact leased destination just before the network write. */
async function deliveryDestination(storage: Tx, env: AlertEnv, leased: Leased, workspace: string, kind: AlertDestinationRecord["kind"]) {
  const row = checkedDestination(await storage.get(destKey(leased.row.id)), leased.row.id);
  const native = await storage.get<{ room?: { id?: string; manager?: string } }>("native-room");
  return row && native?.room?.id === workspace && alertsEnabled(env) &&
    alertFeatureOn(env, row.kind) && row.status === "active" && row.kind === kind &&
    row.leaseUntil === leased.row.leaseUntil &&
    row.secret.kv === leased.row.secret.kv && row.secret.iv === leased.row.secret.iv && row.secret.ct === leased.row.secret.ct &&
    await currentApproval(storage, env, row, native.room.manager) ? row : null;
}

async function send(
  env: AlertEnv,
  leased: Leased,
  target: AlertTarget,
  workspace: string,
  footer: AlertInboxFooter | null,
  storage: DurableObjectStorage,
  deps: OutboxDeps,
  now: number,
): Promise<{ eventId: string; result: SendResult }[]> {
  const appOrigin = env.APP_ORIGIN ?? "https://templ.vip";
  const readable = leased.due.filter((entry) => entry.event);
  const sendDeps: SendDeps = {
    fetch: async (url, init) => {
      if (target.kind !== "webhook" && init?.method === "POST") {
        const allowed = await storage.transaction(tx => deliveryDestination(tx, env, leased, workspace, target.kind));
        if (!allowed) throw new Error("Alert delivery refused.");
      }
      return (deps.fetch ?? fetch)(url, init);
    },
    resolve: deps.resolve,
    workersDevSubdomain: env.WORKERS_DEV_SUBDOMAIN,
  };
  if (target.kind === "webhook") {
    const out: { eventId: string; result: SendResult }[] = [];
    for (const entry of readable) {
      const id = `msg_${entry.eventId.replace(/-/g, "")}_${leased.row.id}`;
      let refusal: "destination" | "thread" | "too-large" | null = null;
      const body = JSON.stringify(webhookBody(entry.event!, { appOrigin, workspace, inbox: footer }));
      const result = await sendWebhook(target, { id, body, now }, {
        ...sendDeps,
        fetch: async (url, init) => {
          const fetcher = deps.fetch ?? fetch;
          if (init?.method !== "POST") return fetcher(url, init);
          if (new URL(String(url)).toString() !== new URL(target.url).toString()) {
            refusal = "destination";
            throw new Error("Alert destination changed.");
          }
          const prepared = await storage.transaction(async (tx) => {
            const row = await deliveryDestination(tx, env, leased, workspace, "webhook");
            if (!row) return { refusal: "destination" as const };
            const event = entry.event!;
            if (
              event.type !== "ping" && event.type !== "overflow" &&
              !row.events.some((type) => type === event.type)
            ) return { refusal: "thread" as const };
            const thread = event.case?.thread;
            let member: AlertWebhookMember | null = null;
            if (thread) {
              const record = await tx.get<{ id?: string; room?: string; deleting?: boolean }>(`conversation-v1:${thread}`);
              if (!record || record.id !== thread || record.room !== `room:${workspace}` || record.deleting)
                return { refusal: "thread" as const };
              if (row.walletContext && deps.member)
                member = await deps.member(tx, thread).catch(() => null);
            }
            const body = JSON.stringify(webhookBody(event, {
              appOrigin, workspace, inbox: footer, ...(member ? { member } : {}),
            }));
            if (new TextEncoder().encode(body).length > SUPPORT_ALERT_LIMITS.webhookPayloadBytes)
              return { refusal: "too-large" as const };
            const at = Date.now();
            const headers = await webhookHeaders(target.secrets, id, Math.floor(at / 1000), body, at);
            return { body, headers };
          });
          if (prepared.refusal !== undefined) {
            refusal = prepared.refusal;
            throw new Error("Alert delivery refused.");
          }
          return fetcher(url, { ...init, body: prepared.body, headers: prepared.headers });
        },
      },
      );
      if (refusal === "destination") break;
      out.push({
        eventId: entry.eventId,
        result: refusal
          ? { outcome: "failed", status: null, reason: refusal === "too-large" ? "too-large" : "access-revoked", ms: 0 }
          : result,
      });
      if (result.outcome === "paused") break;
    }
    return out;
  }
  if (!readable.length && !leased.overflow) return [];
  const post = chatPost(target.kind, readable.map((entry) => entry.event!), {
    appOrigin,
    workspace,
    footer,
    overflow: leased.overflow?.count ?? 0,
    now,
  });
  const body = chatBody(target.kind, post);
  const result =
    target.kind === "telegram"
      ? await sendTelegram(target, body, sendDeps)
      : await sendChatWebhook(target.kind, target.url, body, sendDeps);
  return readable.map((entry) => ({ eventId: entry.eventId, result }));
}

/** The `alert-outbox` room alarm consumer. */
export async function alertOutboxAlarm(
  state: Room,
  env: AlertEnv,
  now: number,
  deps: OutboxDeps = {},
): Promise<number | null> {
  const storage = state.storage;
  const workspace = ((await storage.get<{ room?: { id?: string } }>("native-room"))?.room?.id ?? "") as string;
  const dueRows = await storage.list({
    prefix: DUE_PREFIX,
    end: `${DUE_PREFIX}${pad16(now + 1)}`,
    limit: DESTINATIONS_PER_RUN,
  });
  const dests = [...new Set([...dueRows.keys()].map((key) => key.split(":").at(-1)!))];
  for (const dest of dests) {
    const leased = await storage.transaction((tx) => lease(tx, env, dest, now));
    if (!("row" in leased)) continue;
    let target: AlertTarget;
    try {
      target = await openAlertSecret<AlertTarget>(env, alertAad(`room:${workspace}`, dest, leased.row.kind), leased.row.secret);
      if (target.kind !== leased.row.kind) throw new AlertSecretUnreadable();
    } catch {
      await storage.transaction(async (tx) => {
        const row = checkedDestination(await tx.get(destKey(dest)), dest);
        if (!row) return;
        for (const entry of leased.due)
          await tx.put(queueKey(dest, entry.eventId), { ...entry.row, uncertain: false });
        delete row.leaseUntil;
        if (alertKeyConfigured(env)) {
          row.status = "paused";
          row.pausedReason = "secret-unreadable";
        }
        await saveDestination(tx, row);
        await scheduleDue(tx, dest, alertKeyConfigured(env) ? await ageOut(tx, row, now) : null);
      });
      logAlertFailure(leased.row.kind, null, "secret-unreadable");
      continue;
    }
    const unreadable = leased.due.filter((entry) => !entry.event);
    const footer = deps.footer
      ? await storage.transaction((tx) => deps.footer!(tx)).catch(() => null)
      : null;
    const results = await send(env, leased, target, workspace, footer, storage, deps, now);
    await storage.transaction(async (tx) => {
      const sent = new Set(results.map((entry) => entry.eventId));
      for (const entry of leased.due) {
        if (sent.has(entry.eventId) || !entry.event) continue;
        const key = queueKey(dest, entry.eventId);
        const queued = checkedQueueRow(await tx.get(key));
        if (queued && queued.attempts === entry.row.attempts)
          await tx.put(key, { ...queued, uncertain: false });
      }
      for (const entry of unreadable) {
        await writeLog(tx, dest, { id: entry.eventId, type: entry.row.type }, entry.row.attempts, now, "skipped", null, null, "unreadable");
        await ack(tx, dest, entry.eventId);
      }
      if (results.length) await settle(tx, dest, leased, results, Date.now(), deps);
      else {
        const row = checkedDestination(await tx.get(destKey(dest)), dest);
        if (row) {
          delete row.leaseUntil;
          await saveDestination(tx, row);
        }
        let next: number | null = null;
        if (row && (row.status !== "active" || !alertsEnabled(env) ||
            !alertFeatureOn(env, row.kind)))
          next = await ageOut(tx, row, Date.now());
        else
          for (const { row: queued } of await queueRows(tx, dest))
            if (queued) next = next === null ? queued.nextAt : Math.min(next, queued.nextAt);
        await scheduleDue(tx, dest, next);
      }
    });
  }
  await storage.transaction((tx) => pruneAlerts(tx, now));
  const first = [...(await storage.list({ prefix: DUE_PREFIX, limit: 1 })).keys()][0];
  if (!first) return null;
  const at = Number(first.slice(DUE_PREFIX.length, DUE_PREFIX.length + 16));
  return Number.isSafeInteger(at) ? Math.max(at, now + 1_000) : now + 60_000;
}

/** Bounded cleanup: logs past 7 days or 1,000 per destination, test
 * counters past 2 hours, day counters past 2 days, events whose queue rows
 * are all gone (at most 24 hours plus a margin). */
export async function pruneAlerts(storage: Tx, now: number) {
  let budget = 200;
  const logCutoff = now - SUPPORT_ALERT_LIMITS.logDays * DAY;
  const index = await readDestinationIndex(storage);
  for (const entry of index) {
    if (budget <= 0) break;
    const prefix = `${LOG_PREFIX}${entry.id}:`;
    const old = await storage.list({ prefix, end: `${prefix}${pad16(logCutoff)}`, limit: budget });
    if (old.size) {
      await storage.delete([...old.keys()].slice(0, 128));
      budget -= Math.min(old.size, 128);
      await bump(storage, `${LOG_COUNT_PREFIX}${entry.id}`, -Math.min(old.size, 128));
    }
    const total = await storage.get<number>(`${LOG_COUNT_PREFIX}${entry.id}`);
    const over = natural(total) ? total - SUPPORT_ALERT_LIMITS.logEntriesPerDestination : 0;
    if (over > 0 && budget > 0) {
      const extra = await storage.list({ prefix, limit: Math.min(over, budget, 128) });
      await storage.delete([...extra.keys()]);
      budget -= extra.size;
      await bump(storage, `${LOG_COUNT_PREFIX}${entry.id}`, -extra.size);
    }
  }
  const tests = await storage.list({ prefix: TEST_PREFIX, limit: 64 });
  const hourNow = Math.floor(now / HOUR);
  const staleTests = [...tests.keys()].filter((key) => Number(key.split(":").at(-1)) < hourNow - 1);
  if (staleTests.length) await storage.delete(staleTests);
  const days = await storage.list({ prefix: DAY_PREFIX, end: `${DAY_PREFIX}${utcDay(now - 2 * DAY)}`, limit: 16 });
  if (days.size) await storage.delete([...days.keys()]);
  const creates = await storage.list({ prefix: CREATES_PREFIX, end: `${CREATES_PREFIX}${utcDay(now)}`, limit: 16 });
  if (creates.size) await storage.delete([...creates.keys()]);
  await pruneMemberTickets(storage, now);
  const events = await storage.list<unknown>({ prefix: EVENT_PREFIX, limit: 20 });
  for (const [key, value] of events) {
    const event = value as EventRow;
    const at = natural(event?.at) ? event.at : 0;
    if (at > now - SUPPORT_ALERT_LIMITS.webhookDeadlineMs - HOUR) break;
    await storage.delete(key);
    await bump(storage, EVENT_COUNT_KEY, -1);
  }
}

/** Expired reply-email tickets and page grants, a bounded batch at a time.
 * Each principal keeps at most one live ticket, so few are ever live. */
export async function pruneMemberTickets(storage: Pick<Tx, "list" | "delete">, now: number) {
  for (const prefix of [TICKET_PREFIX, GRANT_PREFIX]) {
    const rows = await storage.list<{ expiresAt?: unknown }>({ prefix, limit: 50 });
    const stale = [...rows]
      .filter(([, row]) => !(typeof row?.expiresAt === "number" && row.expiresAt > now))
      .map(([key]) => key);
    if (stale.length) await storage.delete(stale);
  }
}

/** Removes a destination and everything queued or logged for it, within
 * one transaction (bounded by the per-destination caps). */
export async function deleteDestinationData(storage: Tx, dest: string) {
  for (const { eventId } of await queueRows(storage, dest)) await ack(storage, dest, eventId);
  await scheduleDue(storage, dest, null);
  for (;;) {
    const logs = await storage.list({ prefix: `${LOG_PREFIX}${dest}:`, limit: 128 });
    if (!logs.size) break;
    await storage.delete([...logs.keys()]);
  }
  const tests = await storage.list({ prefix: `${TEST_PREFIX}${dest}:`, limit: 64 });
  await storage.delete([
    ...tests.keys(),
    `${LOG_COUNT_PREFIX}${dest}`,
    `${QUEUE_COUNT_PREFIX}${dest}`,
    `${OVERFLOW_PREFIX}${dest}`,
    `${SUMMARY_PREFIX}${dest}`,
    destKey(dest),
  ]);
  await storage.put(
    DEST_INDEX_KEY,
    (await readDestinationIndex(storage)).filter((entry) => entry.id !== dest),
  );
}

/** A page of a destination's delivery log, newest first. */
export async function readAlertLog(
  storage: Pick<Tx, "list">,
  dest: string,
  before: string | null,
  limit = 50,
): Promise<{ entries: AlertLogEntry[]; next: string | null }> {
  const prefix = `${LOG_PREFIX}${dest}:`;
  const rows = await storage.list<AlertLogEntry>({
    prefix,
    reverse: true,
    limit: limit + 1,
    ...(before && /^[0-9]{16}:[0-9a-f-]{36}:[0-9]{2}$/.test(before) ? { end: `${prefix}${before}` } : {}),
  });
  const keys = [...rows.keys()];
  const entries = [...rows.values()].slice(0, limit);
  return {
    entries,
    next: keys.length > limit ? keys[limit - 1].slice(prefix.length) : null,
  };
}
