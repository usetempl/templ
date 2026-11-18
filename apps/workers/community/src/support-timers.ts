/** The `support-escalation` room alarm consumer: every timed support alert
 * except follow-ups (the follow-up consumer owns those).
 *
 * 1. Escalation: a request in Needs you waiting past the target escalates
 *    once (level 1: the assignee, or the manager and everyone who handles
 *    conversations when unassigned). When level 1 went only to an assignee
 *    and the wait reaches twice the target, level 2 goes to everyone. A new
 *    wait on the same case escalates again.
 * 2. Waiting summaries per destination that asked for them.
 * 3. Unseen replies: a signed member who hasn't opened a team reply after
 *    10 minutes (webhooks with wallet details only).
 *
 * Each part keeps a durable index, bounds its work, is idempotent under
 * retry and never calls setAlarm. Email jobs are authorized again at send. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { AlertSummaryMinutes } from "@templ/chat/support-alerts";
import {
  alertsEnabled,
  emitAlert,
  readDestinationIndex,
  SUMMARY_PREFIX,
  type AlertEnv,
} from "./alert-outbox";
import { checkedDestination } from "./alert-destinations";
import {
  UNSEEN_DUE_PREFIX,
  inboxFooter,
  memberSeenKey,
  readEscalationMinutes,
  roomSupportStaff,
} from "./support-alert-emit";
import { AWAITING_PREFIX, ESCALATED_PREFIX, ledgerState } from "./support-cases";
import { queueStaffNotification } from "./support-notifications";
import type { TeamConversationRecord } from "./team-conversations";
import { canaryPrincipal } from "./support-canary";

type Tx = DurableObjectTransaction;
type Room = { storage: DurableObjectStorage };
const MINUTE = 60_000;
const EMITS_PER_RUN = 50;
const AWAITING_READ = 1_001;
const pad8 = (value: number) => String(value).padStart(8, "0");
const pad16 = (value: number) => String(Math.max(0, Math.floor(value))).padStart(16, "0");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const AWAITING_KEY = /^support-awaiting-v1:([0-9]{16}):(tc-[0-9a-f]{32})$/;

/** `support-escalated-v1:<tc>:<seq>`: the wait it escalated and the level
 * reached. `assigneeOnly` is set when level 1 went to an assignee alone. */
export type EscalationMarker = {
  since: number;
  level: 1 | 2;
  at: number;
  assigneeOnly: boolean;
};
const markerKey = (thread: string, seq: number) => `${ESCALATED_PREFIX}${thread}:${pad8(seq)}`;
function checkedMarker(value: unknown): EscalationMarker | null {
  const marker = value as EscalationMarker;
  return marker &&
    natural(marker.since) &&
    (marker.level === 1 || marker.level === 2) &&
    natural(marker.at) &&
    typeof marker.assigneeOnly === "boolean"
    ? marker
    : null;
}

export type TimersDeps = {
  /** Templ's hourly check account in this room, never alerted about. */
  canary?: ChatPrincipalId | null;
  appOrigin?: string;
};

async function escalate(
  storage: Tx,
  env: AlertEnv,
  now: number,
  deps: TimersDeps,
): Promise<number | null> {
  const minutes = await readEscalationMinutes(storage);
  if (minutes === 0) return null;
  // No ledger yet: nothing can be waiting. The first request creates it and
  // wakes the room for its own escalation (emitCaseAlerts). A running
  // backfill keeps the room awake through its own consumer, which runs
  // first; this retry only covers a marker that stays unreadable.
  const ledger = await ledgerState(storage);
  if (ledger === "absent") return null;
  if (ledger !== "ready") return now + MINUTE;
  const target = minutes * MINUTE;
  const rows = await storage.list<{ seq?: unknown }>({ prefix: AWAITING_PREFIX, limit: AWAITING_READ });
  let next: number | null = null;
  const later = (at: number) => {
    next = next === null ? at : Math.min(next, at);
  };
  let emits = 0;
  const workspace = (await storage.get<{ room?: { id?: string } }>("native-room"))?.room?.id;
  const room = workspace ? `room:${workspace}` : null;
  let staff: Awaited<ReturnType<typeof roomSupportStaff>> | null = null;
  for (const [key, value] of rows) {
    const match = AWAITING_KEY.exec(key);
    const seq = value?.seq;
    if (!match || !natural(seq) || seq < 1) continue;
    const since = Number(match[1]);
    const thread = match[2];
    if (since + target > now) {
      later(since + target);
      // The index is oldest first: every later row is due later.
      break;
    }
    if (emits >= EMITS_PER_RUN) {
      later(now + 1_000);
      break;
    }
    const marker = checkedMarker(await storage.get(markerKey(thread, seq)));
    const fresh = !marker || marker.since !== since;
    const second = !fresh && marker!.level === 1 && marker!.assigneeOnly;
    if (!fresh && !second) continue;
    if (second && since + 2 * target > now) {
      later(since + 2 * target);
      continue;
    }
    const record = await storage.get<TeamConversationRecord>(`conversation-v1:${thread}`);
    if (!record || record.deleting || record.stopped) continue;
    if (deps.canary && record.member === deps.canary) continue;
    staff ??= await roomSupportStaff(storage, env, now);
    const assignee = record.assignment?.principalId;
    const assigneeOnly =
      fresh && assignee !== undefined && (assignee === staff.manager || staff.handlers.includes(assignee));
    const level: 1 | 2 = fresh ? 1 : 2;
    await emitAlert(
      storage,
      env,
      { type: "request.escalated", at: now, case: { thread, seq }, level, waitingSince: since },
      now,
    );
    const recipients = assigneeOnly
      ? [assignee!]
      : [...(staff.manager ? [staff.manager] : []), ...staff.handlers];
    if (room)
      for (const recipient of new Set(recipients))
        await queueStaffNotification(storage, {
          now,
          room,
          appOrigin: deps.appOrigin ?? env.APP_ORIGIN ?? "https://templ.vip",
          recipient,
          kind: "escalation",
          conversation: thread,
          waitingSince: since,
        }, env);
    await storage.put(markerKey(thread, seq), {
      since,
      level,
      at: now,
      assigneeOnly: fresh ? assigneeOnly : false,
    } satisfies EscalationMarker);
    if (level === 1 && assigneeOnly) later(since + 2 * target);
    emits++;
  }
  if (rows.size >= AWAITING_READ && next === null) later(now + 5 * MINUTE);
  return next;
}

async function summaries(storage: Tx, env: AlertEnv, now: number): Promise<number | null> {
  if (!alertsEnabled(env)) return null;
  const index = await readDestinationIndex(storage);
  let next: number | null = null;
  let footer: Awaited<ReturnType<typeof inboxFooter>> | null = null;
  for (const entry of index) {
    if (entry.status !== "active" || !(entry.events as readonly string[]).includes("request.waiting"))
      continue;
    const row = checkedDestination(await storage.get(`alert-dest-v1:${entry.id}`), entry.id);
    const every: AlertSummaryMinutes = row?.summaryMinutes ?? 0;
    if (!row || every === 0) continue;
    const key = `${SUMMARY_PREFIX}${entry.id}`;
    const last = (await storage.get<{ lastAt: number }>(key))?.lastAt ?? 0;
    const dueAt = last + every * MINUTE;
    if (dueAt > now) {
      next = next === null ? dueAt : Math.min(next, dueAt);
      continue;
    }
    footer ??= await inboxFooter(storage);
    if (footer.needsReply > 0)
      await emitAlert(
        storage,
        env,
        { type: "request.waiting", at: now, ...(footer.oldestWaitingSince ? { waitingSince: footer.oldestWaitingSince } : {}) },
        now,
        { only: entry.id },
      );
    await storage.put(key, { lastAt: now, lastOldest: footer.oldestWaitingSince });
    const again = now + every * MINUTE;
    next = next === null ? again : Math.min(next, again);
  }
  return next;
}

async function unseen(storage: Tx, env: AlertEnv, now: number): Promise<number | null> {
  const rows = await storage.list<{ replyAt?: unknown; seq?: unknown }>({
    prefix: UNSEEN_DUE_PREFIX,
    end: `${UNSEEN_DUE_PREFIX}${pad16(now + 1)}`,
    limit: 100,
  });
  for (const [key, value] of rows) {
    await storage.delete(key);
    const thread = key.split(":").at(-1)!;
    const replyAt = value?.replyAt;
    const seq = value?.seq;
    if (!natural(replyAt) || !natural(seq) || !/^tc-[0-9a-f]{32}$/.test(thread)) continue;
    const record = await storage.get<TeamConversationRecord>(`conversation-v1:${thread}`);
    if (!record || record.deleting) continue;
    const data = await storage.get<{ wallet?: unknown }>(`support-workflow-v1:${thread}`);
    if (!data?.wallet) continue;
    const seen = await storage.get<number>(memberSeenKey(thread));
    if (natural(seen) && seen >= replyAt) continue;
    await emitAlert(storage, env, { type: "member.reply_unseen", at: now, case: { thread, seq } }, now);
  }
  const first = [...(await storage.list({ prefix: UNSEEN_DUE_PREFIX, limit: 1 })).keys()][0];
  if (!first) return null;
  const at = Number(first.slice(UNSEEN_DUE_PREFIX.length, UNSEEN_DUE_PREFIX.length + 16));
  return Number.isSafeInteger(at) ? Math.max(at, now + 1_000) : null;
}

/** Runs the three parts; each returns its next due time and the consumer
 * returns the earliest. */
export async function supportTimersAlarm(
  state: Room,
  env: AlertEnv,
  now: number,
  deps: TimersDeps = {},
): Promise<number | null> {
  const native = await state.storage.get<{ room?: { id?: string } }>("native-room");
  if (!native?.room?.id) return null;
  if (deps.canary === undefined) {
    let canary: ChatPrincipalId | null = null;
    try {
      canary = canaryPrincipal(env as never, `room:${native.room.id}`);
    } catch {
      canary = null;
    }
    deps = { ...deps, canary };
  }
  const parts = [
    (tx: Tx) => escalate(tx, env, now, deps),
    (tx: Tx) => summaries(tx, env, now),
    (tx: Tx) => unseen(tx, env, now),
  ];
  let due: number | null = null;
  for (const part of parts) {
    const next = await state.storage.transaction(part);
    if (next !== null) due = due === null ? next : Math.min(due, next);
  }
  return due;
}
