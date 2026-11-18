/** Follow-ups: team work that continues after an answer, kept per request.
 *
 * Storage is room-local. Records are the authority; every index (open by
 * owner, owner, due, overdue, per-thread counts) is checked against its
 * record on read and rewritten with it. A record that fails its check is
 * counted as unreadable, never shown to the member and never grants a
 * specialist access.
 *
 * Nothing here posts a message, counts usage or reaches the member except
 * through the one line cached on the conversation record (`followUp`), which
 * carries a label and a date, never an owner, title, note or link. A
 * follow-up grants no wallet authority and causes no transaction. */
import {
  FOLLOW_UP_DEFAULT_LABELS,
  FOLLOW_UP_LIMITS,
  SUPPORT_FOLLOW_UP_STATES,
  SUPPORT_FOLLOW_UP_TYPES,
  addDays,
  currentFollowUp,
  followUpDependencyError,
  followUpId,
  followUpLabelRisk,
  followUpLink,
  followUpMemberText,
  followUpTitleRisk,
  isFollowUpDay,
  parseFollowUpId,
  zonedDayBounds,
  zonedToday,
  type SupportFollowUp,
  type SupportFollowUpLine,
  type SupportFollowUpSource,
  type SupportFollowUpState,
  type SupportFollowUpType,
  type SupportFollowUpWatchView,
} from "@templ/chat/support-follow-ups";
import {
  SUPPORT_HANDOFF_REASONS,
  type SupportHandoffReason,
  type SupportNetwork,
} from "@templ/chat/support";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { AlertEventFacts } from "@templ/chat/support-alerts";
import { HttpError, type Env } from "./common";
import { refusePhrase, refuseSecretRequest } from "./secret-guard";
import { applyCaseEvent, FOLLOW_UP_OVERDUE_PREFIX } from "./support-cases";
import { readCase } from "./support-case-data";
import {
  queueSupportNotification,
  recordSupportActivity,
  supportRecord,
  supportSettings,
  type SupportRecord,
} from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { emitAlert, type AlertEnv } from "./alert-outbox";
import { isRegisteredBot, supportLeads } from "./support-follow-up-access";
import { wakeRoomAt } from "./room-alarm";
import { appendEvents } from "./room-events";
import type { ChatEvent } from "@templ/chat/events";

type Storage = DurableObjectTransaction;
type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;

/* ---------------------------------------------------------------------- */
/* Keys                                                                    */
/* ---------------------------------------------------------------------- */

export const FOLLOW_UP_PREFIX = "support-follow-up-v1:";
export const FOLLOW_UP_CLIENT_PREFIX = "support-follow-up-client-v1:";
export const FOLLOW_UP_OPEN_PREFIX = "support-follow-up-open-v1:";
export const FOLLOW_UP_OWNER_PREFIX = "support-follow-up-owner-v1:";
export const FOLLOW_UP_DUE_PREFIX = "support-follow-up-due-v1:";
export { FOLLOW_UP_OVERDUE_PREFIX };
export const FOLLOW_UP_THREAD_PREFIX = "support-follow-up-thread-v1:";
export const FOLLOW_UP_COUNT_KEY = "support-follow-up-count-v1";
export const FOLLOW_UP_ROUTE_PREFIX = "support-follow-up-route-v1:";
export const MENTION_PREFIX = "support-mention-v1:";
export const MENTION_BY_PREFIX = "support-mention-by-v1:";
export const SPECIALIST_READ_PREFIX = "support-specialist-read-v1:";
/** Active watches, one key per watched follow-up (the 200 cap counts them),
 * and the watch consumer's due index. */
export const WATCH_ACTIVE_PREFIX = "support-watch-active-v1:";
export const WATCH_DUE_PREFIX = "support-watch-due-v1:";

const THREAD = /^tc-[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const pad2 = (value: number) => String(value).padStart(2, "0");
const pad8 = (value: number) => String(value).padStart(8, "0");
export const pad16 = (value: number) =>
  String(Math.max(0, Math.floor(value))).padStart(16, "0");
const iso = (at: number) => new Date(at).toISOString();
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export const followUpKey = (thread: string, seq: number, n: number) =>
  `${FOLLOW_UP_PREFIX}${thread}:${pad8(seq)}:${pad2(n)}`;
const clientKey = (thread: string, clientId: string) =>
  `${FOLLOW_UP_CLIENT_PREFIX}${thread}:${clientId}`;
const ownerIndexKey = (principal: string, thread: string, id: string) =>
  `${FOLLOW_UP_OWNER_PREFIX}${principal}:${thread}:${id}`;
const overdueKey = (thread: string, id: string) =>
  `${FOLLOW_UP_OVERDUE_PREFIX}${thread}:${id}`;
const threadKey = (thread: string) => `${FOLLOW_UP_THREAD_PREFIX}${thread}`;
export const dueKey = (at: number, thread: string, id: string) =>
  `${FOLLOW_UP_DUE_PREFIX}${pad16(at)}:${thread}:${id}`;
export const routeKey = (
  thread: string,
  seq: number,
  reason: SupportHandoffReason,
) => `${FOLLOW_UP_ROUTE_PREFIX}${thread}:${pad8(seq)}:${reason}`;
export const mentionKey = (thread: string, principal: string) =>
  `${MENTION_PREFIX}${thread}:${principal}`;
export const mentionByKey = (principal: string, thread: string) =>
  `${MENTION_BY_PREFIX}${principal}:${thread}`;
export const watchActiveKey = (thread: string, id: string) =>
  `${WATCH_ACTIVE_PREFIX}${thread}:${id}`;
export const watchDueKey = (at: number, thread: string, id: string) =>
  `${WATCH_DUE_PREFIX}${pad16(at)}:${thread}:${id}`;

/* ---------------------------------------------------------------------- */
/* Records                                                                 */
/* ---------------------------------------------------------------------- */

export type StoredWatchSpec =
  | { kind: "tx"; network: SupportNetwork; hash: string }
  | { kind: "block"; network: `eip155:${number}`; number: number }
  | { kind: "time"; at: number };
export type StoredWatch = {
  spec: StoredWatchSpec;
  setAt: number;
  setBy: ChatPrincipalId;
  state: "watching" | "closed" | "failed" | "expired";
  checks: number;
  nextCheckAt: number | null;
  lastCheckedAt: number | null;
  lastResult: SupportFollowUpWatchView["lastResult"];
  readSource?: SupportFollowUpWatchView["readSource"];
};
export type FollowUpFired = {
  remind?: number;
  due?: number;
  escalate?: number;
  updateToday?: number;
  updateMissed?: number;
};
export type StoredFollowUp = {
  schemaVersion: 1;
  thread: string;
  seq: number;
  n: number;
  order: number;
  type: SupportFollowUpType;
  title: string;
  publicLabel: string;
  memberVisible: boolean;
  /** Added by the AI agent and not yet taken or edited by a person: kept
   * team-only with no date, so no member gets a promise nobody owns. */
  awaitingPerson: boolean;
  owner: ChatPrincipalId | null;
  group: string | null;
  dependsOn: string[];
  state: SupportFollowUpState;
  dueAt: number | null;
  nextUpdateOn: string | null;
  nextUpdateUntil: number | null;
  /** When the next-update promise was made (for "missed"). */
  nextUpdateSetAt: number | null;
  link: string | null;
  source: SupportFollowUpSource;
  reason: SupportHandoffReason | null;
  clientId: string | null;
  createdAt: number;
  createdBy: ChatPrincipalId;
  updatedAt: number;
  updatedBy: ChatPrincipalId;
  revision: number;
  closedAt: number | null;
  closedBy: ChatPrincipalId | "watch" | null;
  overdueSince: number | null;
  updateMissedAt: number | null;
  fired: FollowUpFired;
  watch: StoredWatch | null;
};
/** The member line cached on the conversation record. */
export type FollowUpLineCache = {
  seq: number;
  state: "waiting" | "done";
  label: string;
  nextUpdateOn: string | null;
  nextUpdateUntil: number | null;
  at: number;
};
export type FollowUpRecord = TeamConversationRecord & {
  followUp?: FollowUpLineCache | null;
};

const PRINCIPAL = (value: unknown): value is ChatPrincipalId =>
  typeof value === "string" && normalizeChatPrincipal(value) === value;
const FIRED_KEYS = [
  "remind",
  "due",
  "escalate",
  "updateToday",
  "updateMissed",
] as const;
const WATCH_RESULTS = [
  "pending",
  "not-mined",
  "confirming",
  "settled",
  "reverted",
  "failed",
  "reached",
  "unavailable",
  "not-configured",
] as const;
function checkedWatch(raw: unknown): StoredWatch | null | undefined {
  if (raw === null || raw === undefined) return null;
  const w = raw as StoredWatch;
  if (typeof w !== "object" || !w.spec || typeof w.spec !== "object")
    return undefined;
  const spec = w.spec;
  const specOk =
    (spec.kind === "tx" &&
      (spec.network === "solana" ||
        /^eip155:[1-9][0-9]*$/.test(spec.network)) &&
      typeof spec.hash === "string" &&
      spec.hash.length <= 100) ||
    (spec.kind === "block" &&
      /^eip155:[1-9][0-9]*$/.test(spec.network) &&
      Number.isSafeInteger(spec.number) &&
      spec.number >= 1) ||
    (spec.kind === "time" && natural(spec.at));
  if (
    !specOk ||
    (w.readSource !== undefined &&
      (spec.kind === "time" ||
        !w.readSource ||
        typeof w.readSource !== "object" ||
        Array.isArray(w.readSource) ||
        Object.keys(w.readSource).sort().join(",") !== "providerCount,source" ||
        w.readSource.providerCount !== 1 ||
        w.readSource.source !== "alchemy")) ||
    !natural(w.setAt) ||
    !PRINCIPAL(w.setBy) ||
    !["watching", "closed", "failed", "expired"].includes(w.state) ||
    !natural(w.checks) ||
    (w.nextCheckAt !== null && !natural(w.nextCheckAt)) ||
    (w.lastCheckedAt !== null && !natural(w.lastCheckedAt)) ||
    (w.lastResult !== null &&
      !(WATCH_RESULTS as readonly string[]).includes(w.lastResult))
  )
    return undefined;
  return w;
}
/** Every field is checked; anything off returns null (fail closed). */
export function checkedFollowUp(
  raw: unknown,
  thread: string,
  seq: number,
  n: number,
): StoredFollowUp | null {
  const f = raw as StoredFollowUp | undefined;
  if (!f || typeof f !== "object") return null;
  const id = followUpId(seq, n);
  const watch = checkedWatch(f.watch);
  if (
    f.schemaVersion !== 1 ||
    f.thread !== thread ||
    f.seq !== seq ||
    f.n !== n ||
    !natural(f.order) ||
    f.order < 1 ||
    !(SUPPORT_FOLLOW_UP_TYPES as readonly string[]).includes(f.type) ||
    followUpTitleRisk(f.title) !== null ||
    followUpLabelRisk(f.publicLabel) !== null ||
    typeof f.memberVisible !== "boolean" ||
    typeof f.awaitingPerson !== "boolean" ||
    (f.owner !== null && !PRINCIPAL(f.owner)) ||
    (f.group !== null &&
      (typeof f.group !== "string" || !/^g-[0-9a-f]{8}$/.test(f.group))) ||
    !Array.isArray(f.dependsOn) ||
    f.dependsOn.length > FOLLOW_UP_LIMITS.dependsOn ||
    f.dependsOn.some((dep) => {
      const parsed = parseFollowUpId(dep);
      return !parsed || parsed.seq !== seq || dep === id;
    }) ||
    !(SUPPORT_FOLLOW_UP_STATES as readonly string[]).includes(f.state) ||
    (f.dueAt !== null && !natural(f.dueAt)) ||
    (f.nextUpdateOn !== null && !isFollowUpDay(f.nextUpdateOn)) ||
    (f.nextUpdateUntil !== null && !natural(f.nextUpdateUntil)) ||
    (f.nextUpdateSetAt !== null && !natural(f.nextUpdateSetAt)) ||
    (f.link !== null && followUpLink(f.link) !== f.link) ||
    !["person", "route", "agent"].includes(f.source) ||
    (f.reason !== null &&
      !(SUPPORT_HANDOFF_REASONS as readonly string[]).includes(f.reason)) ||
    (f.clientId !== null &&
      (typeof f.clientId !== "string" || f.clientId.length > 40)) ||
    !natural(f.createdAt) ||
    !PRINCIPAL(f.createdBy) ||
    !natural(f.updatedAt) ||
    !PRINCIPAL(f.updatedBy) ||
    !natural(f.revision) ||
    (f.closedAt !== null && !natural(f.closedAt)) ||
    (f.closedBy !== null && f.closedBy !== "watch" && !PRINCIPAL(f.closedBy)) ||
    (f.overdueSince !== null && !natural(f.overdueSince)) ||
    (f.updateMissedAt !== null && !natural(f.updateMissedAt)) ||
    !f.fired ||
    typeof f.fired !== "object" ||
    Object.keys(f.fired).some(
      (key) =>
        !(FIRED_KEYS as readonly string[]).includes(key) ||
        !natural((f.fired as Record<string, unknown>)[key]),
    ) ||
    watch === undefined
  )
    return null;
  return f;
}
/** Follow-ups of a thread (one case when `seq` is given), in key order, at
 * most 400 rows. Unreadable rows are counted, never returned. */
export async function threadFollowUps(
  storage: ReadStorage,
  thread: string,
  seq?: number,
): Promise<{ list: StoredFollowUp[]; unreadable: string[] }> {
  if (!THREAD.test(thread)) return { list: [], unreadable: [] };
  const prefix =
    seq === undefined
      ? `${FOLLOW_UP_PREFIX}${thread}:`
      : `${FOLLOW_UP_PREFIX}${thread}:${pad8(seq)}:`;
  const rows = await storage.list<unknown>({ prefix, limit: 400 });
  const list: StoredFollowUp[] = [];
  const unreadable: string[] = [];
  for (const [key, raw] of rows) {
    const match = /:([0-9]{8}):([0-9]{2})$/.exec(key);
    const s = Number(match?.[1]);
    const n = Number(match?.[2]);
    const f = match ? checkedFollowUp(raw, thread, s, n) : null;
    if (f) list.push(f);
    else if (match) unreadable.push(followUpId(s, n));
  }
  return { list, unreadable };
}
export async function readFollowUp(
  storage: ReadStorage,
  thread: string,
  id: string,
): Promise<StoredFollowUp | null> {
  const parsed = parseFollowUpId(id);
  if (!parsed || !THREAD.test(thread)) return null;
  return checkedFollowUp(
    await storage.get(followUpKey(thread, parsed.seq, parsed.n)),
    thread,
    parsed.seq,
    parsed.n,
  );
}
/** The pure rules' shape: each follow-up with its display id. */
export const withIds = <T extends Pick<StoredFollowUp, "seq" | "n">>(
  list: readonly T[],
): (T & { id: string })[] =>
  list.map((f) => ({ ...f, id: followUpId(f.seq, f.n) }));
export const isActive = (f: Pick<StoredFollowUp, "state">) =>
  f.state === "open" || f.state === "blocked";
/** Where an open follow-up sits in the queue: its owner, its group, or
 * nobody. */
export const ownerKeyOf = (f: Pick<StoredFollowUp, "owner" | "group">) =>
  f.owner ?? (f.group ? `group:${f.group}` : "none");
export const openIndexKey = (f: StoredFollowUp) =>
  `${FOLLOW_UP_OPEN_PREFIX}${ownerKeyOf(f)}:${pad16(f.createdAt)}:${f.thread}:${followUpId(f.seq, f.n)}`;

/* ---------------------------------------------------------------------- */
/* Timers                                                                  */
/* ---------------------------------------------------------------------- */

export type FollowUpEventKind =
  | "remind"
  | "due"
  | "escalate"
  | "update-today"
  | "update-missed";
const FIRED_OF: Record<FollowUpEventKind, keyof FollowUpFired> = {
  remind: "remind",
  due: "due",
  escalate: "escalate",
  "update-today": "updateToday",
  "update-missed": "updateMissed",
};
/** The earliest event not yet fired, for an open or blocked follow-up. */
export function nextTimedEvent(
  f: StoredFollowUp,
  timeZone: string,
): { kind: FollowUpEventKind; at: number } | null {
  if (!isActive(f)) return null;
  const events: { kind: FollowUpEventKind; at: number }[] = [];
  if (f.dueAt !== null) {
    if (
      f.dueAt - DAY_MS > f.createdAt + HOUR_MS &&
      f.fired.remind === undefined
    )
      events.push({ kind: "remind", at: f.dueAt - DAY_MS });
    if (f.fired.due === undefined) events.push({ kind: "due", at: f.dueAt });
    else if (f.fired.escalate === undefined)
      events.push({ kind: "escalate", at: f.dueAt + DAY_MS });
  }
  if (f.nextUpdateOn && f.memberVisible) {
    const bounds = zonedDayBounds(f.nextUpdateOn, timeZone);
    if (f.fired.updateToday === undefined)
      events.push({ kind: "update-today", at: bounds.start + 9 * HOUR_MS });
    if (f.fired.updateMissed === undefined)
      events.push({ kind: "update-missed", at: bounds.end });
  }
  events.sort((a, b) => a.at - b.at);
  return events[0] ?? null;
}
/** Index keys an open follow-up keeps, with their values. */
function indexEntries(
  f: StoredFollowUp,
  timeZone: string,
): Map<string, unknown> {
  const id = followUpId(f.seq, f.n);
  const out = new Map<string, unknown>();
  if (!isActive(f)) return out;
  out.set(openIndexKey(f), { seq: f.seq });
  if (f.owner) out.set(ownerIndexKey(f.owner, f.thread, id), { seq: f.seq });
  const next = nextTimedEvent(f, timeZone);
  if (next) out.set(dueKey(next.at, f.thread, id), { kind: next.kind });
  if (f.overdueSince !== null)
    out.set(overdueKey(f.thread, id), { since: f.overdueSince });
  if (f.watch?.state === "watching") {
    out.set(watchActiveKey(f.thread, id), { seq: f.seq });
    if (f.watch.nextCheckAt !== null)
      out.set(watchDueKey(f.watch.nextCheckAt, f.thread, id), { seq: f.seq });
  }
  return out;
}
/** Replaces the indexes of `before` with those of `after` (either may be
 * null). Keys both keep are rewritten only when their value changed. */
export async function syncIndexes(
  storage: Storage,
  before: StoredFollowUp | null,
  after: StoredFollowUp | null,
  timeZone: string,
) {
  const old = before ? indexEntries(before, timeZone) : new Map();
  const next = after ? indexEntries(after, timeZone) : new Map();
  for (const key of old.keys()) if (!next.has(key)) await storage.delete(key);
  for (const [key, value] of next)
    if (!old.has(key) || JSON.stringify(old.get(key)) !== JSON.stringify(value))
      await storage.put(key, value);
}

/* ---------------------------------------------------------------------- */
/* Counts                                                                  */
/* ---------------------------------------------------------------------- */

type ThreadCounts = { open: number; overdue: number };
export async function threadCounts(
  storage: Pick<DurableObjectStorage, "get">,
  thread: string,
): Promise<ThreadCounts> {
  const raw = await storage.get<ThreadCounts>(threadKey(thread));
  return raw && natural(raw.open) && natural(raw.overdue)
    ? raw
    : { open: 0, overdue: 0 };
}
/** Recounts the thread's open and overdue follow-ups from its records. */
export async function recountThread(storage: Storage, thread: string) {
  const { list } = await threadFollowUps(storage, thread);
  const counts = {
    open: list.filter(isActive).length,
    overdue: list.filter((f) => isActive(f) && f.overdueSince !== null).length,
  };
  if (counts.open === 0 && counts.overdue === 0)
    await storage.delete(threadKey(thread));
  else await storage.put(threadKey(thread), counts);
  return counts;
}
type WorkspaceCount = {
  schemaVersion: 1;
  open: number;
  day: string;
  writes: number;
};
async function workspaceCount(
  storage: Storage,
  now: number,
): Promise<WorkspaceCount> {
  const day = new Date(now).toISOString().slice(0, 10);
  const raw = await storage.get<WorkspaceCount>(FOLLOW_UP_COUNT_KEY);
  if (
    raw &&
    raw.schemaVersion === 1 &&
    natural(raw.open) &&
    natural(raw.writes) &&
    typeof raw.day === "string"
  )
    return raw.day === day ? raw : { ...raw, day, writes: 0 };
  // Recount from the open index: at most one more key than the cap.
  const open = await storage.list({
    prefix: FOLLOW_UP_OPEN_PREFIX,
    limit: FOLLOW_UP_LIMITS.openPerWorkspace + 1,
  });
  return { schemaVersion: 1, open: open.size, day, writes: 0 };
}
/** Moves the workspace's open count without counting a write (the alarm
 * and watches close follow-ups on their own). */
export async function adjustOpenCount(
  storage: Storage,
  now: number,
  delta: number,
) {
  const count = await workspaceCount(storage, now);
  await storage.put(FOLLOW_UP_COUNT_KEY, {
    ...count,
    open: Math.max(0, count.open + delta),
  });
}
/** Counts one write (and an open delta); refuses past the daily cap. */
async function countWrite(storage: Storage, now: number, openDelta: number) {
  const count = await workspaceCount(storage, now);
  if (count.writes >= FOLLOW_UP_LIMITS.writesPerDay)
    throw new HttpError(
      429,
      "Too many follow-up changes today. Try again tomorrow.",
      undefined,
      "follow-up-writes",
    );
  if (openDelta > 0 && count.open >= FOLLOW_UP_LIMITS.openPerWorkspace)
    throw new HttpError(
      409,
      "This workspace has 2,000 open follow-ups. Close some to add more.",
      undefined,
      "follow-up-capacity",
    );
  await storage.put(FOLLOW_UP_COUNT_KEY, {
    ...count,
    open: Math.max(0, count.open + openDelta),
    writes: count.writes + 1,
  });
}

/* ---------------------------------------------------------------------- */
/* The member line                                                          */
/* ---------------------------------------------------------------------- */

function checkedLine(value: unknown): FollowUpLineCache | null {
  const line = value as FollowUpLineCache | null | undefined;
  if (!line || typeof line !== "object") return null;
  if (
    !natural(line.seq) ||
    !natural(line.at) ||
    (line.state !== "waiting" && line.state !== "done") ||
    followUpLabelRisk(line.label) !== null ||
    (line.nextUpdateOn !== null && !isFollowUpDay(line.nextUpdateOn)) ||
    (line.nextUpdateUntil !== null && !natural(line.nextUpdateUntil))
  ) {
    console.warn(
      JSON.stringify({ event: "TEMPL_SUPPORT_FOLLOW_UP_LINE_UNREADABLE" }),
    );
    return null;
  }
  return line;
}
/** The line every viewer of the conversation reads: null when the request
 * is resolved, a done line older than seven days, or nothing cached. A date
 * drops once its day has ended. */
export function followUpLineView(
  record: FollowUpRecord,
  now: number,
): SupportFollowUpLine | null {
  if (record.state === "resolved" || !record.followUp) return null;
  const cache = checkedLine(record.followUp);
  if (!cache) return null;
  if (
    cache.state === "done" &&
    now > cache.at + FOLLOW_UP_LIMITS.doneLineDays * DAY_MS
  )
    return null;
  const past = cache.nextUpdateUntil !== null && now >= cache.nextUpdateUntil;
  return {
    state: cache.state,
    label: cache.label,
    nextUpdateOn: past ? null : cache.nextUpdateOn,
    at: iso(cache.at),
    text: followUpMemberText(
      {
        state: cache.state,
        label: cache.label,
        nextUpdateOn: past ? null : cache.nextUpdateOn,
        nextUpdateUntil: cache.nextUpdateUntil,
      },
      now,
    ),
  };
}
/** A new request starts with no follow-up line: a line kept from an
 * earlier request is cleared. Mutates `record.followUp` and returns whether
 * it changed; the caller saves the record. */
export function clearEarlierFollowUpLine(
  record: FollowUpRecord,
  caseSeq: number,
): boolean {
  if (!record.followUp || record.followUp.seq === caseSeq) return false;
  record.followUp = null;
  return true;
}
/** Recomputes the line from the latest request's follow-ups. `closed` is
 * the follow-up the triggering change closed, if any. Mutates
 * `record.followUp` and returns whether it changed; the caller bumps the
 * revision, saves the record and tells readers. */
export async function refreshFollowUpLine(
  storage: ReadStorage,
  record: FollowUpRecord,
  data: Pick<SupportRecord, "caseSeq">,
  now: number,
  closed?: StoredFollowUp,
): Promise<boolean> {
  const seq = data.caseSeq ?? 0;
  const previous = checkedLine(record.followUp);
  let next: FollowUpLineCache | null = null;
  if (seq >= 1) {
    const { list } = await threadFollowUps(storage, record.id, seq);
    const current = currentFollowUp(withIds(list));
    if (current)
      next = {
        seq,
        state: "waiting",
        label: current.publicLabel,
        nextUpdateOn: current.nextUpdateOn,
        nextUpdateUntil: current.nextUpdateUntil,
        at: now,
      };
    else if (
      closed &&
      closed.seq === seq &&
      closed.state === "done" &&
      closed.memberVisible
    )
      next = {
        seq,
        state: "done",
        label: closed.publicLabel,
        nextUpdateOn: null,
        nextUpdateUntil: null,
        at: now,
      };
    else if (
      !closed &&
      previous?.seq === seq &&
      previous.state === "done" &&
      !list.some(isActive)
    )
      next = previous;
  }
  if (
    previous &&
    next &&
    previous.seq === next.seq &&
    previous.state === next.state &&
    previous.label === next.label &&
    previous.nextUpdateOn === next.nextUpdateOn
  )
    return false;
  if (!next && record.followUp == null) return false;
  record.followUp = next;
  return true;
}
/** Saves a line change: a new revision the member's reads pick up, and
 * the event that tells open sessions. */
async function commitLine(
  storage: Storage,
  record: FollowUpRecord,
  pending: ConversationContext["pending"],
) {
  record.revision++;
  await storage.put(`conversation-v1:${record.id}`, record);
  pending.push({
    type: "conversation.updated",
    channelId: record.id,
    conversationRevision: record.revision,
  });
}
/** The same from a room alarm: the event goes into the room's event log in
 * the alarm's transaction and into `events`, delivered after commit. */
export async function commitAlarmLine(
  storage: Storage,
  record: FollowUpRecord,
  events: ChatEvent[],
  now: number,
) {
  record.revision++;
  await storage.put(`conversation-v1:${record.id}`, record);
  events.push(
    ...(await appendEvents(
      storage,
      [
        {
          type: "conversation.updated",
          channelId: record.id,
          conversationRevision: record.revision,
        },
      ],
      now,
    )),
  );
}

/* ---------------------------------------------------------------------- */
/* Views                                                                   */
/* ---------------------------------------------------------------------- */

export function watchView(
  watch: StoredWatch | null,
): SupportFollowUpWatchView | null {
  if (!watch) return null;
  const base = {
    state: watch.state,
    setAt: iso(watch.setAt),
    lastCheckedAt:
      watch.lastCheckedAt === null ? null : iso(watch.lastCheckedAt),
    lastResult: watch.lastResult,
    ...(watch.readSource ? { readSource: watch.readSource } : {}),
  };
  const spec = watch.spec;
  return spec.kind === "time"
    ? { kind: "time", at: iso(spec.at), ...base }
    : spec.kind === "block"
      ? { kind: "block", network: spec.network, number: spec.number, ...base }
      : { kind: "tx", network: spec.network, hash: spec.hash, ...base };
}
export function followUpView(
  f: StoredFollowUp,
  current: StoredFollowUp | null,
): SupportFollowUp {
  return {
    id: followUpId(f.seq, f.n),
    seq: f.seq,
    order: f.order,
    type: f.type,
    title: f.title,
    publicLabel: f.publicLabel,
    memberVisible: f.memberVisible,
    owner: f.owner,
    group: f.group,
    dependsOn: [...f.dependsOn],
    state: f.state,
    dueAt: f.dueAt === null ? null : iso(f.dueAt),
    nextUpdateOn: f.nextUpdateOn,
    link: f.link,
    overdue: isActive(f) && f.overdueSince !== null,
    updateMissed: isActive(f) && f.updateMissedAt !== null,
    current: current !== null && current.n === f.n && current.seq === f.seq,
    source: f.source,
    reason: f.reason,
    watch: watchView(f.watch),
    createdAt: iso(f.createdAt),
    createdBy: f.createdBy,
    updatedAt: iso(f.updatedAt),
    revision: f.revision,
    closedAt: f.closedAt === null ? null : iso(f.closedAt),
    closedBy: f.closedBy,
  };
}

/* ---------------------------------------------------------------------- */
/* Who acts                                                                */
/* ---------------------------------------------------------------------- */

export type FollowUpActor =
  | { kind: "person"; principal: ChatPrincipalId; lead: boolean }
  | { kind: "bot"; principal: ChatPrincipalId }
  | {
      kind: "specialist";
      principal: ChatPrincipalId;
      aliases: readonly ChatPrincipalId[];
    }
  | {
      kind: "service";
      /** Who caused it (the handoff's actor, the watch's setter). */
      principal: ChatPrincipalId;
      reason: "route" | "alarm" | "watch";
    };
/** What request-path writes need from the conversation context. */
export type FollowUpContext = Pick<
  ConversationContext,
  | "now"
  | "room"
  | "appOrigin"
  | "pending"
  | "pendingAudit"
  | "isSupportStaff"
  | "isSpecialist"
  | "bots"
  | "headers"
> & { env: AlertEnv };

const bad = (status: number, reason: string, message: string) =>
  new HttpError(status, message, undefined, reason);
export const FOLLOW_UP_NOT_FOUND = "Follow-up not found.";

async function parseTitle(value: unknown): Promise<string> {
  if (typeof value === "string") {
    await refusePhrase(value, "saved");
    refuseSecretRequest(value);
  }
  const risk = followUpTitleRisk(value);
  if (risk === "address" || risk === "hash" || risk === "base58")
    throw bad(
      400,
      "follow-up-title-private",
      "Keep wallets and hashes in a note, not the follow-up title.",
    );
  if (risk)
    throw bad(
      400,
      "follow-up-title",
      "Describe the follow-up in 120 characters or fewer.",
    );
  return (value as string).trim();
}
async function parseLabel(value: unknown): Promise<string> {
  if (typeof value === "string") await refusePhrase(value, "saved");
  if (followUpLabelRisk(value))
    throw bad(
      400,
      "follow-up-label",
      "The user line can have up to 48 characters, with no links, addresses or instructions.",
    );
  refuseSecretRequest(value);
  return (value as string).trim();
}
function parseType(value: unknown): SupportFollowUpType {
  if (!(SUPPORT_FOLLOW_UP_TYPES as readonly unknown[]).includes(value))
    throw bad(
      400,
      "follow-up-type",
      "Choose a follow-up type: strategy, access, recovery, decision or bug.",
    );
  return value as SupportFollowUpType;
}
function parseNextUpdate(
  value: unknown,
  now: number,
  timeZone: string,
): { day: string; until: number } {
  const today = zonedToday(now, timeZone);
  if (
    !isFollowUpDay(value) ||
    value < today ||
    value > addDays(today, FOLLOW_UP_LIMITS.nextUpdateMaxDays)
  )
    throw bad(
      400,
      "follow-up-next-update",
      "Choose a next update date within 30 days.",
    );
  return { day: value, until: zonedDayBounds(value, timeZone).end };
}
function parseDue(value: unknown, now: number): number {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (
    !Number.isFinite(at) ||
    at <= now ||
    at > now + FOLLOW_UP_LIMITS.dueMaxDays * DAY_MS
  )
    throw bad(400, "follow-up-due", "Choose a due date within 90 days.");
  return at;
}
async function parseLink(value: unknown): Promise<string> {
  const link = followUpLink(value);
  if (!link)
    throw bad(
      400,
      "follow-up-link",
      "Use a GitHub or Linear link that starts with https://.",
    );
  // The secret guard covers the link too: a recovery phrase in its path,
  // query or fragment, encoded or split by URL punctuation, is refused.
  const url = new URL(link);
  let text = `${url.pathname} ${url.search} ${url.hash}`;
  try {
    text = decodeURIComponent(text);
  } catch {
    // Malformed escapes: screen the raw text.
  }
  await refusePhrase(text.replace(/[^A-Za-z]+/g, " "), "saved");
  return link;
}
/** A current person on the team (not a registered bot) or a current
 * specialist. */
async function assertOwner(
  storage: ReadStorage,
  ctx: FollowUpContext,
  principal: unknown,
): Promise<ChatPrincipalId> {
  const id = PRINCIPAL(principal) ? principal : null;
  const invalid = () =>
    bad(400, "follow-up-owner", "Choose someone on the team or a specialist.");
  if (!id) throw invalid();
  if ((ctx.bots ?? []).includes(id) || (await isRegisteredBot(storage, id)))
    throw invalid();
  const staff = (await ctx.isSupportStaff?.(id)) ?? false;
  const specialist = !staff && ((await ctx.isSpecialist?.(id)) ?? false);
  if (!staff && !specialist) throw invalid();
  return id;
}
const CREATE_KEYS = new Set([
  "clientId",
  "type",
  "title",
  "owner",
  "group",
  "publicLabel",
  "memberVisible",
  "dependsOn",
  "nextUpdateOn",
  "dueAt",
  "link",
  "expectedPrincipalId",
]);
const CHANGE_KEYS = new Set([
  "op",
  "revision",
  "state",
  "owner",
  "group",
  "title",
  "publicLabel",
  "memberVisible",
  "dependsOn",
  "order",
  "nextUpdateOn",
  "dueAt",
  "link",
  "watch",
  "expectedPrincipalId",
]);
function assertKeys(body: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw bad(
      400,
      "follow-up-invalid",
      "This follow-up has a field Templ doesn't know.",
    );
}
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* ---------------------------------------------------------------------- */
/* Notifications and alerts                                                */
/* ---------------------------------------------------------------------- */

/** Queues a text-free email job per recipient (delivery rechecks access at
 * send time) and never to a registered bot or the actor. */
async function notifyPeople(
  storage: Storage,
  target: Pick<ConversationContext, "now" | "room" | "mediaEnv"> & { appOrigin: string },
  record: TeamConversationRecord,
  recipients: readonly ChatPrincipalId[],
  skip: ChatPrincipalId | null,
  wake: boolean,
) {
  // A worker without its app origin has no link to send.
  if (!target.appOrigin) return;
  const seen = new Set<ChatPrincipalId>();
  for (const recipient of recipients) {
    if (seen.has(recipient) || recipient === skip) continue;
    seen.add(recipient);
    if (await isRegisteredBot(storage, recipient)) continue;
    await queueSupportNotification(
      storage,
      target,
      record,
      recipient,
      "follow-up",
      undefined,
      wake ? {} : { wake: false },
    );
  }
}
async function alertFollowUp(
  storage: Storage,
  env: AlertEnv,
  f: StoredFollowUp,
  type: AlertEventFacts["type"],
  now: number,
) {
  await emitAlert(
    storage,
    env,
    {
      type,
      at: now,
      case: { thread: f.thread, seq: f.seq },
      followUp: {
        id: followUpId(f.seq, f.n),
        type: f.type,
        ...(f.dueAt !== null ? { dueAt: f.dueAt } : {}),
      },
    },
    now,
  );
}
/** Current members of a follow-up's group, read from routing settings. */
export type GroupMembers = (group: string) => Promise<ChatPrincipalId[]>;

/* ---------------------------------------------------------------------- */
/* Create                                                                   */
/* ---------------------------------------------------------------------- */

export type CreateInput = Record<string, unknown>;
export type CreateOptions = {
  /** Writable (the rollout var on and Support on for the workspace). */
  gate: { enabled: boolean; writable: boolean };
  groupMembers: GroupMembers;
  /** Group ids the stored routing settings hold; "unreadable" when they
   * fail their check. */
  groups: () => Promise<Set<string> | "unreadable">;
  /** Routing sets these directly. */
  route?: {
    reason: SupportHandoffReason;
    publicLabel: string | null;
    nextUpdateDays: number;
    dueDays: number | null;
    memberVisible: boolean;
  };
};
export function assertFollowUpGate(gate: CreateOptions["gate"]) {
  if (!gate.enabled)
    throw bad(
      503,
      "follow-ups-unavailable",
      "Follow-ups aren't available yet.",
    );
  if (!gate.writable)
    throw new HttpError(
      403,
      "Support is paused until the workspace's balance is topped up.",
      undefined,
      "support-paused",
    );
}
/** Adds a follow-up to the thread's latest request. Every check runs
 * before any write. Returns the stored follow-up and whether it is new (a
 * retry with the same clientId returns the first one). */
export async function createFollowUp(
  storage: Storage,
  ctx: FollowUpContext,
  record: FollowUpRecord,
  body: CreateInput,
  actor: FollowUpActor,
  options: CreateOptions,
): Promise<{ followUp: StoredFollowUp; created: boolean }> {
  assertFollowUpGate(options.gate);
  if (actor.kind === "specialist")
    throw bad(403, "specialist-follow-up", "Only the team can change this.");
  assertKeys(body, CREATE_KEYS);
  const now = ctx.now;
  const clientId =
    typeof body.clientId === "string" ? body.clientId.toLowerCase() : "";
  if (!CLIENT_ID.test(clientId))
    throw bad(400, "follow-up-invalid", "Send a valid follow-up request id.");
  const type = parseType(body.type);
  const title =
    actor.kind === "service" && options.route
      ? String(body.title)
      : await parseTitle(body.title);
  const retry = await storage.get<string>(clientKey(record.id, clientId));
  if (retry) {
    const existing = await readFollowUp(storage, record.id, retry);
    if (
      existing &&
      existing.createdBy === actor.principal &&
      existing.type === type &&
      existing.title === title
    )
      return { followUp: existing, created: false };
    throw bad(
      409,
      "follow-up-retry",
      "This follow-up retry doesn't match the original.",
    );
  }
  const data = await supportRecord(storage, record);
  const seq = data.caseSeq ?? 0;
  const latest =
    seq >= 1
      ? await readCase(storage, { thread: record.id as `tc-${string}`, seq })
      : null;
  if (!latest)
    throw bad(
      409,
      "follow-up-no-request",
      "There's no user case to follow up on yet.",
    );
  if (latest.case.resolvedAt !== null || record.state === "resolved")
    throw bad(
      409,
      "follow-up-resolved",
      "Reopen this case before adding a follow-up.",
    );
  const bot = actor.kind === "bot";
  if (bot && body.publicLabel !== undefined)
    throw bad(
      403,
      "agent-label",
      "An AI agent can use only the default user line.",
    );
  if (bot && (body.nextUpdateOn !== undefined || body.memberVisible === true))
    throw bad(
      403,
      "agent-label",
      "An AI agent can use only the default user line.",
    );
  if (bot && body.owner !== undefined && body.owner !== null)
    throw bad(403, "agent-owner", "An AI agent can't choose an owner.");
  const settings = await supportSettings(storage);
  const timeZone = settings.timezone;
  const publicLabel = options.route?.publicLabel
    ? options.route.publicLabel
    : body.publicLabel === undefined
      ? FOLLOW_UP_DEFAULT_LABELS[type]
      : await parseLabel(body.publicLabel);
  const owner =
    body.owner === undefined || body.owner === null
      ? null
      : await assertOwner(storage, ctx, body.owner);
  let group: string | null = null;
  if (body.group !== undefined && body.group !== null) {
    const groups = await options.groups();
    if (
      owner !== null ||
      groups === "unreadable" ||
      typeof body.group !== "string" ||
      !groups.has(body.group)
    )
      throw bad(400, "follow-up-group", "Choose a follow-up group.");
    group = body.group;
  }
  const { list } = await threadFollowUps(storage, record.id, seq);
  if (list.length >= FOLLOW_UP_LIMITS.perCase)
    throw bad(
      409,
      "follow-up-limit",
      "This case has 20 follow-ups, the most it can hold.",
    );
  const n = Math.max(0, ...list.map((item) => item.n)) + 1;
  if (n > FOLLOW_UP_LIMITS.perCase)
    throw bad(
      409,
      "follow-up-limit",
      "This case has 20 follow-ups, the most it can hold.",
    );
  const order = Math.max(0, ...list.map((item) => item.order)) + 1;
  const id = followUpId(seq, n);
  const dependsOn = Array.isArray(body.dependsOn)
    ? body.dependsOn
    : body.dependsOn === undefined
      ? []
      : null;
  if (
    !dependsOn ||
    dependsOn.some((dep) => typeof dep !== "string") ||
    followUpDependencyError(withIds(list), {
      id,
      order,
      dependsOn: dependsOn as string[],
    })
  )
    throw bad(
      400,
      "follow-up-depends",
      "A follow-up can wait only on earlier follow-ups for the same case.",
    );
  // An AI agent's follow-up stays team-only with no date until a person
  // takes or edits it (unless routing made it for a group).
  const memberVisible = bot
    ? false
    : options.route
      ? options.route.memberVisible
      : body.memberVisible === undefined
        ? true
        : body.memberVisible === true;
  if (
    !bot &&
    body.memberVisible !== undefined &&
    typeof body.memberVisible !== "boolean"
  )
    throw bad(400, "follow-up-invalid", "Choose whether the user sees it.");
  let nextUpdate: { day: string; until: number } | null = null;
  if (memberVisible) {
    const day =
      body.nextUpdateOn !== undefined && body.nextUpdateOn !== null
        ? body.nextUpdateOn
        : addDays(
            zonedToday(now, timeZone),
            options.route?.nextUpdateDays ??
              FOLLOW_UP_LIMITS.defaultNextUpdateDays,
          );
    nextUpdate = parseNextUpdate(day, now, timeZone);
  } else if (body.nextUpdateOn !== undefined && body.nextUpdateOn !== null)
    parseNextUpdate(body.nextUpdateOn, now, timeZone);
  const dueAt = options.route?.dueDays
    ? now + options.route.dueDays * DAY_MS
    : body.dueAt === undefined || body.dueAt === null
      ? null
      : parseDue(body.dueAt, now);
  const link =
    body.link === undefined || body.link === null
      ? null
      : await parseLink(body.link);
  await countWrite(storage, now, 1);
  const f: StoredFollowUp = {
    schemaVersion: 1,
    thread: record.id,
    seq,
    n,
    order,
    type,
    title,
    publicLabel,
    memberVisible,
    awaitingPerson: bot,
    owner,
    group,
    dependsOn: dependsOn as string[],
    state: "open",
    dueAt,
    nextUpdateOn: nextUpdate?.day ?? null,
    nextUpdateUntil: nextUpdate?.until ?? null,
    nextUpdateSetAt: nextUpdate ? now : null,
    link,
    source: bot ? "agent" : options.route ? "route" : "person",
    reason: options.route?.reason ?? null,
    clientId,
    createdAt: now,
    createdBy: actor.principal,
    updatedAt: now,
    updatedBy: actor.principal,
    revision: 1,
    closedAt: null,
    closedBy: null,
    overdueSince: null,
    updateMissedAt: null,
    fired: {},
    watch: null,
  };
  await storage.put(followUpKey(record.id, seq, n), f);
  await storage.put(clientKey(record.id, clientId), id);
  await syncIndexes(storage, null, f, timeZone);
  const counts = await threadCounts(storage, record.id);
  await storage.put(threadKey(record.id), {
    ...counts,
    open: counts.open + 1,
  });
  await applyCaseEvent(storage, record, data, {
    kind: "follow-up",
    seq,
    at: now,
    change: "created",
    open: list.filter(isActive).length + 1,
  });
  if (await refreshFollowUpLine(storage, record, data, now))
    await commitLine(storage, record, ctx.pending);
  await recordSupportActivity(storage, record.id, data, {
    actor: actor.principal,
    action: "follow-up",
    at: now,
    detail: "created",
  });
  ctx.pendingAudit.push({
    actor: actor.principal,
    action: "support.follow-up",
    channelId: record.id,
    target: id,
    after: { op: "create", type, source: f.source },
  });
  if (owner)
    ctx.pendingAudit.push({
      actor: actor.principal,
      action: "support.follow-up.owner",
      channelId: record.id,
      target: owner,
      before: { owner: null },
      after: { owner, followUp: id },
    });
  const recipients = owner
    ? [owner]
    : group
      ? await options.groupMembers(group)
      : [];
  await notifyPeople(storage, { ...ctx, mediaEnv: ctx.env as Env }, record, recipients, actor.principal, true);
  await alertFollowUp(storage, ctx.env, f, "follow-up.assigned", now).catch(
    () => undefined,
  );
  const next = nextTimedEvent(f, timeZone);
  if (next) await wakeRoomAt(storage as never, Math.max(next.at, now + 1_000));
  return { followUp: f, created: true };
}

/* ---------------------------------------------------------------------- */
/* Change                                                                   */
/* ---------------------------------------------------------------------- */

export type ChangeOptions = CreateOptions & {
  /** Validates and stores a watch (support-watches.ts), person only. */
  setWatch?: (
    f: StoredFollowUp,
    value: unknown,
    now: number,
  ) => Promise<StoredWatch | null>;
};
const SPECIALIST_UPDATE_FIELDS = new Set(["nextUpdateOn", "dueAt", "link"]);
/** Changes one follow-up. `revision` must match. Bots can't change any;
 * a specialist changes only its own, and only state (not cancel), dates and
 * link, or gives it back. */
export async function changeFollowUp(
  storage: Storage,
  ctx: FollowUpContext,
  record: FollowUpRecord,
  id: string,
  body: Record<string, unknown>,
  actor: FollowUpActor,
  options: ChangeOptions,
): Promise<StoredFollowUp> {
  assertFollowUpGate(options.gate);
  if (actor.kind === "bot")
    throw bad(
      403,
      "agent-follow-up",
      "An AI agent can add follow-ups but can't change them.",
    );
  assertKeys(body, CHANGE_KEYS);
  const before = await readFollowUp(storage, record.id, id);
  if (!before) throw bad(404, "follow-up-not-found", FOLLOW_UP_NOT_FOUND);
  if (body.revision !== before.revision)
    throw bad(
      409,
      "follow-up-stale",
      "Someone changed this follow-up. Reload it and try again.",
    );
  const specialist = actor.kind === "specialist";
  const ownsIt =
    specialist &&
    before.owner !== null &&
    (actor.aliases.includes(before.owner) || actor.principal === before.owner);
  const now = ctx.now;
  const settings = await supportSettings(storage);
  const timeZone = settings.timezone;
  const data = await supportRecord(storage, record);
  const { list } = await threadFollowUps(storage, record.id, before.seq);
  const f: StoredFollowUp = structuredClone(before);
  const op = body.op;
  const changed: string[] = [];
  let ownerChange: { before: ChatPrincipalId | null } | null = null;
  let closedNow = false;
  let reopened = false;
  const onlyTeam = () =>
    bad(403, "specialist-follow-up", "Only the team can change this.");
  // A person or group member taking over an AI agent's follow-up puts it
  // in front of the member, with the default date.
  const adopt = () => {
    if (!f.awaitingPerson) return;
    f.awaitingPerson = false;
    if (body.memberVisible === false) return;
    f.memberVisible = true;
    if (!f.nextUpdateOn) {
      const day = addDays(
        zonedToday(now, timeZone),
        FOLLOW_UP_LIMITS.defaultNextUpdateDays,
      );
      f.nextUpdateOn = day;
      f.nextUpdateUntil = zonedDayBounds(day, timeZone).end;
      f.nextUpdateSetAt = now;
    }
    changed.push("memberVisible");
  };
  if (op === "state") {
    const state = body.state;
    if (!(SUPPORT_FOLLOW_UP_STATES as readonly unknown[]).includes(state))
      throw bad(
        400,
        "follow-up-invalid",
        "Choose open, blocked, done or cancelled.",
      );
    if (specialist && (!ownsIt || state === "cancelled" || !isActive(before)))
      throw onlyTeam();
    if (state === before.state) return before;
    if (state === "done") {
      const waiting = before.dependsOn.some((dep) => {
        const target = list.find(
          (item) => followUpId(item.seq, item.n) === dep,
        );
        return target && isActive(target);
      });
      if (waiting)
        throw bad(
          409,
          "follow-up-waiting",
          "Finish the follow-ups this one waits for first.",
        );
    }
    if (!isActive(before) && isActive({ state } as StoredFollowUp)) {
      if (specialist) throw onlyTeam();
      reopened = true;
      f.closedAt = null;
      f.closedBy = null;
      f.overdueSince = null;
      f.updateMissedAt = null;
      f.fired = {};
    }
    f.state = state as SupportFollowUpState;
    if (!isActive(f) && isActive(before)) {
      closedNow = true;
      f.closedAt = now;
      f.closedBy = actor.principal;
      if (f.watch?.state === "watching")
        f.watch = { ...f.watch, state: "closed", nextCheckAt: null };
    }
    changed.push("state");
  } else if (op === "update") {
    const fields = Object.keys(body).filter(
      (key) => !["op", "revision", "expectedPrincipalId"].includes(key),
    );
    if (specialist) {
      if (!ownsIt || !isActive(before)) throw onlyTeam();
      if (fields.some((key) => !SPECIALIST_UPDATE_FIELDS.has(key)))
        throw onlyTeam();
    }
    if (body.type !== undefined)
      throw bad(400, "follow-up-invalid", "A follow-up keeps its type.");
    if (body.title !== undefined) {
      f.title = await parseTitle(body.title);
      changed.push("title");
    }
    if (body.publicLabel !== undefined) {
      f.publicLabel = await parseLabel(body.publicLabel);
      changed.push("publicLabel");
    }
    if (body.memberVisible !== undefined) {
      if (typeof body.memberVisible !== "boolean")
        throw bad(400, "follow-up-invalid", "Choose whether the user sees it.");
      f.memberVisible = body.memberVisible;
      f.awaitingPerson = false;
      changed.push("memberVisible");
    }
    if (body.owner !== undefined) {
      const owner =
        body.owner === null
          ? null
          : await assertOwner(storage, ctx, body.owner);
      if (owner !== f.owner) {
        ownerChange = { before: f.owner };
        f.owner = owner;
        changed.push("owner");
      }
    }
    if (body.group !== undefined) {
      if (body.group === null) f.group = null;
      else {
        const groups = await options.groups();
        if (
          groups === "unreadable" ||
          typeof body.group !== "string" ||
          !groups.has(body.group)
        )
          throw bad(400, "follow-up-group", "Choose a follow-up group.");
        f.group = body.group;
      }
      changed.push("group");
    }
    if (body.dependsOn !== undefined || body.order !== undefined) {
      const dependsOn =
        body.dependsOn === undefined ? f.dependsOn : body.dependsOn;
      if (
        !Array.isArray(dependsOn) ||
        dependsOn.some((dep) => typeof dep !== "string")
      )
        throw bad(
          400,
          "follow-up-depends",
          "A follow-up can wait only on earlier follow-ups for the same case.",
        );
      let order = f.order;
      if (body.order !== undefined) {
        if (
          !Number.isSafeInteger(body.order) ||
          (body.order as number) < 1 ||
          (body.order as number) > list.length
        )
          throw bad(
            400,
            "follow-up-depends",
            "A follow-up can wait only on earlier follow-ups for the same case.",
          );
        order = body.order as number;
      }
      // Renumber the case 1..k with this one at its new place, then check
      // every dependency still points earlier.
      const others = list
        .filter((item) => item.n !== f.n)
        .sort((a, b) => a.order - b.order);
      others.splice(order - 1, 0, f);
      const orders = new Map(others.map((item, index) => [item.n, index + 1]));
      const candidate = others.map((item) => ({
        id: followUpId(item.seq, item.n),
        order: orders.get(item.n)!,
        dependsOn: item.n === f.n ? (dependsOn as string[]) : item.dependsOn,
      }));
      for (const item of candidate)
        if (
          followUpDependencyError(
            candidate.filter((other) => other.id !== item.id),
            item,
          )
        )
          throw bad(
            400,
            "follow-up-depends",
            "A follow-up can wait only on earlier follow-ups for the same case.",
          );
      f.dependsOn = dependsOn as string[];
      f.order = orders.get(f.n)!;
      for (const item of list)
        if (item.n !== f.n && orders.get(item.n) !== item.order) {
          const moved = { ...item, order: orders.get(item.n)! };
          await storage.put(followUpKey(item.thread, item.seq, item.n), moved);
        }
      changed.push("order");
    }
    if (body.nextUpdateOn !== undefined) {
      if (body.nextUpdateOn === null) {
        f.nextUpdateOn = null;
        f.nextUpdateUntil = null;
        f.nextUpdateSetAt = null;
      } else {
        const next = parseNextUpdate(body.nextUpdateOn, now, timeZone);
        f.nextUpdateOn = next.day;
        f.nextUpdateUntil = next.until;
        f.nextUpdateSetAt = now;
      }
      delete f.fired.updateToday;
      delete f.fired.updateMissed;
      f.updateMissedAt = null;
      changed.push("nextUpdateOn");
    }
    if (body.dueAt !== undefined) {
      f.dueAt = body.dueAt === null ? null : parseDue(body.dueAt, now);
      delete f.fired.remind;
      delete f.fired.due;
      delete f.fired.escalate;
      f.overdueSince = null;
      changed.push("dueAt");
    }
    if (body.link !== undefined) {
      f.link = body.link === null ? null : await parseLink(body.link);
      changed.push("link");
    }
    if (body.watch !== undefined) {
      if (specialist || !options.setWatch) throw onlyTeam();
      if (!isActive(before))
        throw bad(
          409,
          "follow-up-closed",
          "Reopen this follow-up before watching the chain.",
        );
      f.watch = await options.setWatch(f, body.watch, now);
      changed.push("watch");
    }
    if (!specialist && fields.some((key) => key !== "watch")) adopt();
    if (!changed.length && !fields.length)
      throw bad(400, "follow-up-invalid", "Send a field to change.");
  } else if (op === "take") {
    if (before.owner !== null || !isActive(before))
      throw bad(409, "follow-up-taken", "Someone already has this follow-up.");
    const members = before.group
      ? await options.groupMembers(before.group)
      : [];
    const inGroup =
      actor.kind === "specialist"
        ? members.some((member) => actor.aliases.includes(member))
        : actor.kind === "person";
    if (!inGroup)
      throw bad(
        403,
        "follow-up-group-only",
        "Only people in this follow-up's group can take it.",
      );
    ownerChange = { before: null };
    f.owner = actor.principal;
    changed.push("owner");
    adopt();
  } else if (op === "release") {
    const mine =
      before.owner !== null &&
      (before.owner === actor.principal ||
        (actor.kind === "specialist" && actor.aliases.includes(before.owner)));
    if (!mine)
      throw bad(
        403,
        "follow-up-owner-only",
        "Only the owner can give this back.",
      );
    ownerChange = { before: before.owner };
    f.owner = null;
    changed.push("owner");
  } else
    throw bad(
      400,
      "follow-up-invalid",
      "Choose state, update, take or release.",
    );
  const openDelta = (isActive(f) ? 1 : 0) - (isActive(before) ? 1 : 0);
  await countWrite(storage, now, openDelta);
  if (f.watch?.state === "watching" && !isActive(f))
    f.watch = { ...f.watch, state: "closed", nextCheckAt: null };
  f.revision = before.revision + 1;
  f.updatedAt = now;
  f.updatedBy = actor.principal;
  await storage.put(followUpKey(f.thread, f.seq, f.n), f);
  await syncIndexes(storage, before, f, timeZone);
  const openInCase = (
    await threadFollowUps(storage, record.id, f.seq)
  ).list.filter(isActive).length;
  if (closedNow || reopened)
    await applyCaseEvent(storage, record, data, {
      kind: "follow-up",
      seq: f.seq,
      at: now,
      change: closedNow ? "closed" : "reopened",
      ...(closedNow
        ? {
            closedAs:
              f.state === "cancelled"
                ? ("cancelled" as const)
                : ("done" as const),
          }
        : {}),
      open: openInCase,
    });
  await recordSupportActivity(storage, record.id, data, {
    actor: actor.principal,
    action: "follow-up",
    at: now,
    detail: op === "state" ? String(f.state) : String(op),
  });
  // A step whose watch was met while it waited closes once nothing it waits
  // on is open: this change may have closed its last dependency.
  const closedByWatch = await closeMetWatches(
    storage,
    ctx.env,
    record,
    data,
    f.seq,
    now,
    timeZone,
  );
  await recountThread(storage, record.id);
  if (
    await refreshFollowUpLine(
      storage,
      record,
      data,
      now,
      closedByWatch ?? (closedNow ? f : undefined),
    )
  )
    await commitLine(storage, record, ctx.pending);
  ctx.pendingAudit.push({
    actor: actor.principal,
    action: "support.follow-up",
    channelId: record.id,
    target: id,
    after: {
      op,
      ...(op === "state" ? { state: f.state } : {}),
      changed,
    },
  });
  if (ownerChange)
    ctx.pendingAudit.push({
      actor: actor.principal,
      action: "support.follow-up.owner",
      channelId: record.id,
      target: f.owner,
      before: { owner: ownerChange.before },
      after: { owner: f.owner, followUp: id },
    });
  if (ownerChange && f.owner && f.owner !== actor.principal)
    await notifyPeople(storage, { ...ctx, mediaEnv: ctx.env as Env }, record, [f.owner], actor.principal, true);
  if (closedNow && f.state === "done")
    await alertFollowUp(storage, ctx.env, f, "follow-up.done", now).catch(
      () => undefined,
    );
  const next = nextTimedEvent(f, timeZone);
  if (next) await wakeRoomAt(storage as never, Math.max(next.at, now + 1_000));
  return f;
}

/* ---------------------------------------------------------------------- */
/* Closing by a watch                                                       */
/* ---------------------------------------------------------------------- */

/** A watch whose condition held while its follow-up still waited on
 * earlier steps: it checks no more, and closes the follow-up once nothing
 * it waits on is open. */
export const watchMet = (f: StoredFollowUp) =>
  isActive(f) &&
  f.watch?.state === "watching" &&
  f.watch.nextCheckAt === null &&
  (f.watch.lastResult === "settled" || f.watch.lastResult === "reached");
/** Whether any follow-up `f` waits on is still open or blocked. */
export const waitsOnOpen = (
  f: Pick<StoredFollowUp, "dependsOn">,
  list: readonly StoredFollowUp[],
) =>
  f.dependsOn.some((dep) =>
    list.some((item) => followUpId(item.seq, item.n) === dep && isActive(item)),
  );
/** Closes one follow-up as done by its watch: the record, its indexes, the
 * case ledger, the workspace's open count, the activity entry and the
 * alert. The caller recounts the thread and refreshes the member line. */
export async function closeByWatch(
  storage: Storage,
  env: AlertEnv,
  record: FollowUpRecord,
  data: SupportRecord,
  before: StoredFollowUp,
  now: number,
  timeZone: string,
  result: "settled" | "reached",
): Promise<StoredFollowUp> {
  const f: StoredFollowUp = structuredClone(before);
  const watch = f.watch!;
  watch.state = "closed";
  watch.lastResult = result;
  watch.nextCheckAt = null;
  f.state = "done";
  f.closedAt = now;
  f.closedBy = "watch";
  f.revision = before.revision + 1;
  await storage.put(followUpKey(f.thread, f.seq, f.n), f);
  await syncIndexes(storage, before, f, timeZone);
  await applyCaseEvent(storage, record, data, {
    kind: "follow-up",
    seq: f.seq,
    at: now,
    change: "closed",
    closedAs: "done",
    open: (await threadFollowUps(storage, f.thread, f.seq)).list.filter(
      isActive,
    ).length,
  });
  await adjustOpenCount(storage, now, -1);
  await recordSupportActivity(storage, record.id, data, {
    actor: watch.setBy,
    action: "follow-up",
    at: now,
    detail: "done-by-watch",
  });
  await alertFollowUp(storage, env, f, "follow-up.done", now).catch(
    () => undefined,
  );
  return f;
}
/** Closes, done by their watch, the case's follow-ups whose watch was met
 * while they waited, once nothing they wait on is open; again while a close
 * frees another. Returns the last one closed, or null. */
export async function closeMetWatches(
  storage: Storage,
  env: AlertEnv,
  record: FollowUpRecord,
  data: SupportRecord,
  seq: number,
  now: number,
  timeZone: string,
): Promise<StoredFollowUp | null> {
  let last: StoredFollowUp | null = null;
  for (let round = 0; round < FOLLOW_UP_LIMITS.perCase; round++) {
    const { list } = await threadFollowUps(storage, record.id, seq);
    const ready = list.find((f) => watchMet(f) && !waitsOnOpen(f, list));
    if (!ready) break;
    last = await closeByWatch(
      storage,
      env,
      record,
      data,
      ready,
      now,
      timeZone,
      ready.watch!.lastResult as "settled" | "reached",
    );
  }
  return last;
}

/* ---------------------------------------------------------------------- */
/* Request lifecycle                                                        */
/* ---------------------------------------------------------------------- */

/** The team can't resolve a request while any follow-up of the thread is
 * open or blocked. */
export async function assertNoOpenFollowUps(
  storage: ReadStorage,
  thread: string,
): Promise<void> {
  const { list } = await threadFollowUps(storage, thread);
  if (list.some(isActive))
    throw bad(
      409,
      "actions-open",
      "Close or cancel the open follow-ups first.",
    );
}
/** Marking a request spam cancels its open follow-ups. Returns how many. */
export async function cancelOpenFollowUps(
  storage: Storage,
  ctx: Pick<ConversationContext, "now" | "pending" | "pendingAudit">,
  record: FollowUpRecord,
  actor: ChatPrincipalId,
): Promise<number> {
  const { list } = await threadFollowUps(storage, record.id);
  const open = list.filter(isActive);
  if (!open.length) return 0;
  const settings = await supportSettings(storage);
  const data = await supportRecord(storage, record);
  const now = ctx.now;
  const bySeq = new Map<number, number>();
  for (const f of list)
    if (isActive(f)) bySeq.set(f.seq, (bySeq.get(f.seq) ?? 0) + 1);
  for (const before of open) {
    const f: StoredFollowUp = {
      ...before,
      state: "cancelled",
      closedAt: now,
      closedBy: actor,
      updatedAt: now,
      updatedBy: actor,
      revision: before.revision + 1,
      watch:
        before.watch?.state === "watching"
          ? { ...before.watch, state: "closed", nextCheckAt: null }
          : before.watch,
    };
    await storage.put(followUpKey(f.thread, f.seq, f.n), f);
    await syncIndexes(storage, before, f, settings.timezone);
    const left = (bySeq.get(f.seq) ?? 1) - 1;
    bySeq.set(f.seq, left);
    await applyCaseEvent(storage, record, data, {
      kind: "follow-up",
      seq: f.seq,
      at: now,
      change: "closed",
      closedAs: "cancelled",
      open: left,
    });
  }
  const count = await workspaceCount(storage, now);
  await storage.put(FOLLOW_UP_COUNT_KEY, {
    ...count,
    open: Math.max(0, count.open - open.length),
  });
  await recountThread(storage, record.id);
  if (await refreshFollowUpLine(storage, record, data, now))
    await commitLine(storage, record, ctx.pending);
  ctx.pendingAudit.push({
    actor,
    action: "support.follow-up",
    channelId: record.id,
    target: null,
    after: {
      op: "state",
      state: "cancelled",
      changed: ["spam"],
      count: open.length,
    },
  });
  return open.length;
}

/** A person on the team removes one stored follow-up that fails its check
 * (after a confirmation in the app). Its index rows are found by their id,
 * since the record can't say where they are; the open counts are recounted
 * from the indexes and the case ledger hears it closed. */
export async function discardUnreadableFollowUp(
  storage: Storage,
  ctx: Pick<ConversationContext, "now" | "pending" | "pendingAudit">,
  record: FollowUpRecord,
  id: string,
  actor: ChatPrincipalId,
): Promise<void> {
  const parsed = parseFollowUpId(id);
  if (!parsed || !THREAD.test(record.id))
    throw bad(404, "follow-up-not-found", FOLLOW_UP_NOT_FOUND);
  const key = followUpKey(record.id, parsed.seq, parsed.n);
  if (
    (await storage.get(key)) === undefined ||
    (await readFollowUp(storage, record.id, id))
  )
    throw bad(404, "follow-up-not-found", FOLLOW_UP_NOT_FOUND);
  await storage.delete(key);
  const suffix = `:${record.id}:${id}`;
  for (const prefix of [
    FOLLOW_UP_OPEN_PREFIX,
    FOLLOW_UP_OWNER_PREFIX,
    FOLLOW_UP_OVERDUE_PREFIX,
    FOLLOW_UP_DUE_PREFIX,
    WATCH_ACTIVE_PREFIX,
    WATCH_DUE_PREFIX,
  ]) {
    const rows = await storage.list({ prefix, limit: 2_500 });
    for (const row of rows.keys())
      if (row.endsWith(suffix) || row === `${prefix}${record.id}:${id}`)
        await storage.delete(row);
  }
  // The workspace's open count, recounted from the open index.
  const count = await workspaceCount(storage, ctx.now);
  const open = await storage.list({
    prefix: FOLLOW_UP_OPEN_PREFIX,
    limit: FOLLOW_UP_LIMITS.openPerWorkspace + 1,
  });
  await storage.put(FOLLOW_UP_COUNT_KEY, { ...count, open: open.size });
  await recountThread(storage, record.id);
  const data = await supportRecord(storage, record);
  await applyCaseEvent(storage, record, data, {
    kind: "follow-up",
    seq: parsed.seq,
    at: ctx.now,
    change: "closed",
    closedAs: "cancelled",
    open: (await threadFollowUps(storage, record.id, parsed.seq)).list.filter(
      isActive,
    ).length,
  });
  if (await refreshFollowUpLine(storage, record, data, ctx.now))
    await commitLine(storage, record, ctx.pending);
  ctx.pendingAudit.push({
    actor,
    action: "support.follow-up",
    channelId: record.id,
    target: id,
    after: { op: "discard" },
  });
}

/* ---------------------------------------------------------------------- */
/* Deletion                                                                 */
/* ---------------------------------------------------------------------- */

async function deleteOne(
  storage: Storage,
  f: StoredFollowUp,
  key: string,
): Promise<number> {
  let deleted = 0;
  const id = followUpId(f.seq, f.n);
  const keys = [
    ...indexEntries(f, "UTC").keys(),
    // Index keys written under another zone or an earlier due time are
    // found by the thread sweep's prefix lists below.
    ownerIndexKey(f.owner ?? "-", f.thread, id),
    overdueKey(f.thread, id),
    watchActiveKey(f.thread, id),
    ...(f.clientId ? [clientKey(f.thread, f.clientId)] : []),
    key,
  ];
  for (const item of keys) if (await storage.delete(item)) deleted++;
  if (isActive(f)) {
    const count = await storage.get<WorkspaceCount>(FOLLOW_UP_COUNT_KEY);
    if (count && natural(count.open))
      await storage.put(FOLLOW_UP_COUNT_KEY, {
        ...count,
        open: Math.max(0, count.open - 1),
      });
  }
  return deleted;
}
/** Removes due and watch keys naming a thread (their time comes first in
 * the key, so they are found by scanning the bounded indexes). */
async function deleteThreadTimers(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  let deleted = 0;
  for (const prefix of [FOLLOW_UP_DUE_PREFIX, WATCH_DUE_PREFIX]) {
    const rows = await storage.list({ prefix, limit: 2_500 });
    for (const key of rows.keys()) {
      if (deleted >= budget) return deleted;
      if (key.includes(`:${thread}:`) && (await storage.delete(key))) deleted++;
    }
  }
  return deleted;
}
/** Per-case deleter for the case ledger's prune (365 days). */
export async function deleteCaseFollowUps(
  storage: Storage,
  thread: string,
  seq: number,
  budget: number,
): Promise<number> {
  if (!THREAD.test(thread) || budget <= 0) return 0;
  let deleted = 0;
  const rows = await storage.list<unknown>({
    prefix: `${FOLLOW_UP_PREFIX}${thread}:${pad8(seq)}:`,
    limit: Math.min(budget, 40),
  });
  for (const [key, raw] of rows) {
    const n = Number(key.slice(key.lastIndexOf(":") + 1));
    const f = checkedFollowUp(raw, thread, seq, n);
    deleted += f
      ? await deleteOne(storage, f, key)
      : (await storage.delete(key))
        ? 1
        : 0;
    if (deleted >= budget) return deleted;
  }
  for (const reason of SUPPORT_HANDOFF_REASONS)
    if (await storage.delete(routeKey(thread, seq, reason))) deleted++;
  if (rows.size) await recountThread(storage, thread);
  return deleted;
}
/** Everything a deleted thread kept here: follow-ups with every index,
 * client and route keys, mention grants and the thread counts. At most
 * `budget` keys per call; the caller calls again while it returns more
 * than zero. */
export async function deleteThreadFollowUps(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  if (!THREAD.test(thread) || budget <= 0) return 0;
  let deleted = 0;
  const rows = await storage.list<unknown>({
    prefix: `${FOLLOW_UP_PREFIX}${thread}:`,
    limit: Math.max(1, Math.floor(budget / 8)),
  });
  for (const [key, raw] of rows) {
    const match = /:([0-9]{8}):([0-9]{2})$/.exec(key);
    const f = match
      ? checkedFollowUp(raw, thread, Number(match[1]), Number(match[2]))
      : null;
    deleted += f
      ? await deleteOne(storage, f, key)
      : (await storage.delete(key))
        ? 1
        : 0;
    if (deleted >= budget) return deleted;
  }
  if (rows.size) return deleted;
  for (const prefix of [
    `${FOLLOW_UP_CLIENT_PREFIX}${thread}:`,
    `${FOLLOW_UP_ROUTE_PREFIX}${thread}:`,
    `${MENTION_PREFIX}${thread}:`,
  ]) {
    const keys = await storage.list<{ by?: string }>({
      prefix,
      limit: budget - deleted,
    });
    for (const key of keys.keys()) {
      if (prefix === `${MENTION_PREFIX}${thread}:`) {
        const principal = key.slice(prefix.length);
        await storage.delete(mentionByKey(principal, thread));
      }
      if (await storage.delete(key)) deleted++;
      if (deleted >= budget) return deleted;
    }
  }
  // Open and owner index rows left by an unreadable record.
  for (const prefix of [
    FOLLOW_UP_OPEN_PREFIX,
    FOLLOW_UP_OWNER_PREFIX,
    WATCH_ACTIVE_PREFIX,
    FOLLOW_UP_OVERDUE_PREFIX,
  ]) {
    const keys = await storage.list({ prefix, limit: 2_500 });
    for (const key of keys.keys()) {
      if (!key.includes(`${thread}:`)) continue;
      if (await storage.delete(key)) deleted++;
      if (deleted >= budget) return deleted;
    }
  }
  deleted += await deleteThreadTimers(storage, thread, budget - deleted);
  if (await storage.delete(threadKey(thread))) deleted++;
  return deleted;
}

/* ---------------------------------------------------------------------- */
/* Alarm consumer                                                           */
/* ---------------------------------------------------------------------- */

const DUE_KEY = /^support-follow-up-due-v1:([0-9]{16}):(tc-[0-9a-f]{32}):(.+)$/;
export type FollowUpAlarmEnv = AlertEnv & {
  SUPPORT_FOLLOW_UPS_ENABLED?: string;
  APP_ORIGIN?: string;
};
export type FollowUpAlarmDeps = {
  /** Whether Support is on for the workspace now. */
  covered(storage: Storage, now: number): Promise<boolean>;
  appOrigin: string | null;
  groupMembers(storage: ReadStorage, group: string): Promise<ChatPrincipalId[]>;
  /** Delivers the room events a committed run logged to open sessions. */
  afterCommit?: (events: ChatEvent[]) => void;
};
/** Did a person on the team (not the AI agent) reply after `since`? */
function personRepliedSince(data: SupportRecord, since: number): boolean {
  const last = data.lastStaffReplyAt ?? 0;
  return last > since && last !== data.lastAgentReplyAt;
}
/** Room alarm consumer `support-follow-ups`: reminders, overdue marks,
 * escalations, next-update reminders and missed updates, plus mention
 * expiry and old specialist read markers. Bounded batches, idempotent, and
 * it never calls setAlarm. */
export async function supportFollowUpAlarm(
  state: DurableObjectState,
  env: FollowUpAlarmEnv,
  now: number,
  deps: FollowUpAlarmDeps,
): Promise<number | null> {
  if (!(await state.storage.get("native-room"))) return null;
  const native = await state.storage.get<{ room: { id: string } }>(
    "native-room",
  );
  const room = `room:${native!.room.id}`;
  const events: ChatEvent[] = [];
  const result = await state.storage.transaction(async (tx) => {
    // Only the committed attempt's events are delivered.
    events.length = 0;
    if (!(await deps.covered(tx, now))) return { full: false, hold: true };
    const settings = await supportSettings(tx);
    const timeZone = settings.timezone;
    const due = await tx.list<{ kind?: string }>({
      prefix: FOLLOW_UP_DUE_PREFIX,
      end: `${FOLLOW_UP_DUE_PREFIX}${pad16(now + 1)}`,
      limit: FOLLOW_UP_LIMITS.alarmBatch,
    });
    const target = { now, room, appOrigin: deps.appOrigin ?? "", mediaEnv: env as Env };
    for (const [key, value] of due) {
      const match = DUE_KEY.exec(key);
      if (!match) {
        await tx.delete(key);
        continue;
      }
      const [, , thread, rest] = match;
      if (rest.startsWith("m-")) {
        // A mention grant ends.
        const principal = rest.slice(2);
        const mention = await tx.get<{ until?: number }>(
          mentionKey(thread, principal),
        );
        if (!mention || !natural(mention.until) || mention.until <= now) {
          await tx.delete(mentionKey(thread, principal));
          await tx.delete(mentionByKey(principal, thread));
        }
        await tx.delete(key);
        continue;
      }
      const before = await readFollowUp(tx, thread, rest);
      const expected = before ? nextTimedEvent(before, timeZone) : null;
      if (
        !before ||
        !expected ||
        dueKey(expected.at, thread, rest) !== key ||
        expected.kind !== value?.kind
      ) {
        // Repair: the key no longer matches its record.
        await tx.delete(key);
        if (before && expected)
          await tx.put(dueKey(expected.at, thread, rest), {
            kind: expected.kind,
          });
        continue;
      }
      const record = (await tx.get<FollowUpRecord>(
        `conversation-v1:${thread}`,
      )) as FollowUpRecord | undefined;
      if (!record || record.deleting) {
        await tx.delete(key);
        continue;
      }
      const f: StoredFollowUp = structuredClone(before);
      f.fired[FIRED_OF[expected.kind]] = now;
      const data = await supportRecord(tx, record);
      const leads = await supportLeads(tx, env, now);
      const group = f.group ? await deps.groupMembers(tx, f.group) : [];
      const ownerOrGroup = f.owner ? [f.owner] : group.length ? group : leads;
      let lineChanged = false;
      if (expected.kind === "remind")
        await notifyPeople(tx, target, record, ownerOrGroup, null, false);
      else if (expected.kind === "due") {
        f.overdueSince = now;
        await notifyPeople(tx, target, record, ownerOrGroup, null, false);
        await applyCaseEvent(tx, record, data, {
          kind: "follow-up",
          seq: f.seq,
          at: now,
          change: "overdue",
          open: (await threadFollowUps(tx, thread, f.seq)).list.filter(isActive)
            .length,
        });
        await alertFollowUp(tx, env, f, "follow-up.overdue", now).catch(
          () => undefined,
        );
      } else if (expected.kind === "escalate") {
        await notifyPeople(
          tx,
          target,
          record,
          [...leads, ...(f.owner ? [f.owner] : [])],
          null,
          false,
        );
        await alertFollowUp(tx, env, f, "follow-up.escalated", now).catch(
          () => undefined,
        );
      } else if (expected.kind === "update-today")
        await notifyPeople(tx, target, record, ownerOrGroup, null, false);
      else {
        const since = f.nextUpdateSetAt ?? f.createdAt;
        const updated = f.updatedAt > since || personRepliedSince(data, since);
        if (!updated) {
          f.updateMissedAt = now;
          await notifyPeople(
            tx,
            target,
            record,
            [...(f.owner ? [f.owner] : group), ...leads],
            null,
            false,
          );
          await applyCaseEvent(tx, record, data, {
            kind: "follow-up",
            seq: f.seq,
            at: now,
            change: "update-missed",
            open: (await threadFollowUps(tx, thread, f.seq)).list.filter(
              isActive,
            ).length,
          });
          await alertFollowUp(tx, env, f, "follow-up.update-missed", now).catch(
            () => undefined,
          );
        }
        // The date is past: the member line drops it.
        lineChanged = await refreshFollowUpLine(tx, record, data, now);
      }
      await tx.put(followUpKey(f.thread, f.seq, f.n), f);
      await syncIndexes(tx, before, f, timeZone);
      await recountThread(tx, thread);
      if (lineChanged) await commitAlarmLine(tx, record, events, now);
    }
    // Specialist read markers older than two days.
    const cutoff = zonedToday(now - 2 * DAY_MS, "UTC");
    const old = await tx.list({
      prefix: SPECIALIST_READ_PREFIX,
      end: `${SPECIALIST_READ_PREFIX}${cutoff}`,
      limit: 100,
    });
    for (const key of old.keys()) await tx.delete(key);
    return { full: due.size >= FOLLOW_UP_LIMITS.alarmBatch, hold: false };
  });
  if (events.length) deps.afterCommit?.(events);
  if (result.hold) return now + DAY_MS;
  if (result.full) return now + 1_000;
  const next = await state.storage.list({
    prefix: FOLLOW_UP_DUE_PREFIX,
    limit: 1,
  });
  const first = [...next.keys()][0];
  const at = first ? Number(DUE_KEY.exec(first)?.[1]) : NaN;
  return Number.isSafeInteger(at) ? Math.max(at, now + 1_000) : null;
}
/** A specialist's first read of a thread each UTC day: one access audit
 * entry, in the same transaction as the read. */
export async function noteSpecialistRead(
  storage: Storage,
  pendingAudit: ConversationContext["pendingAudit"],
  input: {
    principal: ChatPrincipalId;
    thread: string;
    via: ("owner" | "mention")[];
    now: number;
  },
) {
  const day = new Date(input.now).toISOString().slice(0, 10);
  const key = `${SPECIALIST_READ_PREFIX}${day}:${input.principal}:${input.thread}`;
  if (await storage.get(key)) return;
  await storage.put(key, true);
  pendingAudit.push({
    actor: input.principal,
    action: "support.specialist.read",
    channelId: input.thread,
    target: input.principal,
    after: { via: input.via },
  });
}
