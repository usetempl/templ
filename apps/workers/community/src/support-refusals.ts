import {
  SUPPORT_REFUSAL_POLICY,
  SUPPORT_REFUSAL_REASONS,
  type SupportRefusalDay,
  type SupportRefusalReason,
  type SupportRefusals,
} from "@templ/chat/support";
import { HttpError } from "./common";
import { MESSAGE_RETRY_WINDOW_MS, messageClientId } from "./message-retries";

/** Counts of turned-away member requests, by UTC day and reason. The ledger
 * holds counts and times only: no principal, wallet, IP digest, origin,
 * thread id or text. A refused clientId leaves a dedupe marker for the
 * retry window, so a retried request counts once. Counting never fails the
 * request it describes: an unreadable day record is left alone and the
 * refusal goes uncounted. Every key here is room-local. */
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;

export const REFUSAL_DAY_PREFIX = "support-refusals-v1:";
export const REFUSAL_CLIENT_PREFIX = "support-refusal-client-v1:";
export const REFUSAL_CLIENT_COUNT_KEY = "support-refusal-client-count-v1";
/** Widget settings object (`<namespace>:widget-config:<room>`): widget opens
 * on a website the workspace has not approved. */
export const WIDGET_REFUSAL_PREFIX = "widget-refusals-v1:";
export const REFUSAL_WINDOW_DAYS = [1, 7, 30] as const;
export type RefusalWindowDays = (typeof REFUSAL_WINDOW_DAYS)[number];
/** Fixed log label for an unreadable ledger record; it names nothing else. */
export const REFUSAL_LEDGER_INVALID = "TEMPL_SUPPORT_REFUSAL_LEDGER_INVALID";

const DAY_MS = 24 * 60 * 60_000;
const DAY_PRUNE_PAGE = 16;
const CLIENT_PRUNE_PAGE = 32;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The room counts its own refusals; unapproved widget origins are counted
 * by the widget settings object and merged when read. */
const ROOM_REASONS: readonly SupportRefusalReason[] =
  SUPPORT_REFUSAL_REASONS.filter((reason) => reason !== "origin-not-approved");

type StoredRefusalDay = {
  schema: 1;
  day: string;
  counts: Partial<Record<SupportRefusalReason, number>>;
  firstAt: Partial<Record<SupportRefusalReason, number>>;
  lastAt: Partial<Record<SupportRefusalReason, number>>;
  approximate: boolean;
};
type StoredWidgetRefusalDay = {
  schema: 1;
  day: string;
  count: number;
  firstAt: number;
  lastAt: number;
};
/** What the widget settings object's `refusals` op returns, newest first. */
export type WidgetRefusalDay = {
  day: string;
  count: number;
  firstAt: string;
  lastAt: string;
};

const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isReason = (value: unknown): value is SupportRefusalReason =>
  (SUPPORT_REFUSAL_REASONS as readonly unknown[]).includes(value);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** `?days=` for `GET /conversations/refusals`: 1, 7 or 30, default 7. */
export function refusalWindowDays(value: unknown): RefusalWindowDays {
  if (value === undefined || value === null || value === "") return 7;
  const days =
    typeof value === "string" && /^(?:1|7|30)$/.test(value)
      ? Number(value)
      : value;
  if (!(REFUSAL_WINDOW_DAYS as readonly unknown[]).includes(days))
    throw new HttpError(400, "Choose 1, 7 or 30 days.");
  return days as RefusalWindowDays;
}

/** A stored day: known reasons only, natural counts no higher than the cap,
 * a first and last time for every counted reason and nothing else. */
function checkedDay(value: unknown, day: string): StoredRefusalDay | null {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    value.day !== day ||
    typeof value.approximate !== "boolean" ||
    !isObject(value.counts) ||
    !isObject(value.firstAt) ||
    !isObject(value.lastAt)
  )
    return null;
  const { counts, firstAt, lastAt } = value;
  for (const [reason, count] of Object.entries(counts))
    if (
      !isReason(reason) ||
      !natural(count) ||
      count > SUPPORT_REFUSAL_POLICY.maxCount ||
      !natural(firstAt[reason]) ||
      !natural(lastAt[reason]) ||
      (firstAt[reason] as number) > (lastAt[reason] as number)
    )
      return null;
  for (const times of [firstAt, lastAt])
    for (const reason of Object.keys(times))
      if (!Object.hasOwn(counts, reason)) return null;
  return value as StoredRefusalDay;
}

function checkedWidgetDay(
  value: unknown,
  day: string,
): StoredWidgetRefusalDay | null {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    value.day !== day ||
    !natural(value.count) ||
    value.count > SUPPORT_REFUSAL_POLICY.maxCount ||
    !natural(value.firstAt) ||
    !natural(value.lastAt) ||
    value.firstAt > value.lastAt
  )
    return null;
  return value as StoredWidgetRefusalDay;
}

/** Deletes up to one page of day records older than the retention. */
async function pruneDays(storage: Storage, prefix: string, nowMs: number) {
  const cutoff = utcDay(nowMs - SUPPORT_REFUSAL_POLICY.retentionDays * DAY_MS);
  const old = await storage.list({
    prefix,
    end: `${prefix}${cutoff}`,
    limit: DAY_PRUNE_PAGE,
  });
  for (const key of old.keys()) await storage.delete(key);
}

/** Deletes up to one page of dedupe markers past the retry window. UUIDv7
 * keys sort by creation time, so the oldest come first. */
async function pruneClientMarkers(storage: Storage, nowMs: number) {
  const before = Math.max(0, nowMs - MESSAGE_RETRY_WINDOW_MS + 1)
    .toString(16)
    .padStart(12, "0");
  const expired = await storage.list({
    prefix: REFUSAL_CLIENT_PREFIX,
    end: `${REFUSAL_CLIENT_PREFIX}${before.slice(0, 8)}-${before.slice(8, 12)}`,
    limit: CLIENT_PRUNE_PAGE,
  });
  if (!expired.size) return;
  for (const key of expired.keys()) await storage.delete(key);
  // An unreadable count stays as it is, so it keeps reading as full.
  const count = await storage.get<unknown>(REFUSAL_CLIENT_COUNT_KEY);
  if (natural(count))
    await storage.put(
      REFUSAL_CLIENT_COUNT_KEY,
      Math.max(0, count - expired.size),
    );
}

/** A refusal's retry key: a valid, unexpired UUIDv7 clientId, else null. */
function refusalClientId(value: string | null, nowMs: number): string | null {
  if (value === null) return null;
  try {
    return messageClientId(value, nowMs)?.clientId ?? null;
  } catch {
    return null;
  }
}

/** Counts one turned-away member request in its UTC day. Run it in its own
 * small transaction after the refused request rolled back. A retry with the
 * same clientId inside the retry window is not counted again. */
export async function recordSupportRefusal(
  storage: Storage,
  input: {
    reason: SupportRefusalReason;
    clientId: string | null;
    nowMs: number;
  },
): Promise<{ counted: boolean; first: boolean }> {
  const { reason, nowMs } = input;
  if (!ROOM_REASONS.includes(reason) || !natural(nowMs))
    return { counted: false, first: false };
  const clientId = refusalClientId(input.clientId, nowMs);
  const marker = clientId ? `${REFUSAL_CLIENT_PREFIX}${clientId}` : null;
  if (marker && (await storage.get(marker)) !== undefined)
    return { counted: false, first: false };

  const day = utcDay(nowMs);
  const key = `${REFUSAL_DAY_PREFIX}${day}`;
  const stored = await storage.get(key);
  const record: StoredRefusalDay | null =
    stored === undefined
      ? {
          schema: 1,
          day,
          counts: {},
          firstAt: {},
          lastAt: {},
          approximate: false,
        }
      : checkedDay(stored, day);
  if (!record) {
    console.error(REFUSAL_LEDGER_INVALID);
    return { counted: false, first: false };
  }
  const count = Math.min(
    (record.counts[reason] ?? 0) + 1,
    SUPPORT_REFUSAL_POLICY.maxCount,
  );
  record.counts[reason] = count;
  record.firstAt[reason] ??= nowMs;
  record.lastAt[reason] = Math.max(record.lastAt[reason] ?? 0, nowMs);

  if (marker) {
    // An unreadable count reads as full, never as room to spare.
    const markers = await storage.get<unknown>(REFUSAL_CLIENT_COUNT_KEY);
    const used =
      markers === undefined
        ? 0
        : natural(markers)
          ? markers
          : SUPPORT_REFUSAL_POLICY.clientMarkers;
    if (used < SUPPORT_REFUSAL_POLICY.clientMarkers) {
      await storage.put(marker, { at: nowMs });
      await storage.put(REFUSAL_CLIENT_COUNT_KEY, used + 1);
    } else record.approximate = true;
  }
  await storage.put(key, record);
  await pruneDays(storage, REFUSAL_DAY_PREFIX, nowMs);
  await pruneClientMarkers(storage, nowMs);

  // The caller alerts the team on the first refusal of a reason in a day
  // (alert-outbox.ts, from the refusal wrapper in channels.ts).
  return { counted: true, first: count === 1 };
}

/** The room's day records for the last `days` UTC days (today included),
 * newest first. Unreadable records are skipped and logged. */
export async function readSupportRefusals(
  storage: Pick<Storage, "list">,
  input: { days: number; nowMs: number },
): Promise<SupportRefusals> {
  const days = refusalWindowDays(input.days);
  const today = dayStart(input.nowMs);
  const rows = await storage.list({
    prefix: REFUSAL_DAY_PREFIX,
    start: `${REFUSAL_DAY_PREFIX}${utcDay(today - (days - 1) * DAY_MS)}`,
    end: `${REFUSAL_DAY_PREFIX}${utcDay(today + DAY_MS)}`,
    limit: days * 2,
  });
  const out: SupportRefusalDay[] = [];
  let invalid = false;
  for (const [key, value] of rows) {
    const day = key.slice(REFUSAL_DAY_PREFIX.length);
    const record = DAY.test(day) ? checkedDay(value, day) : null;
    if (!record) {
      invalid = true;
      continue;
    }
    const firstAt: SupportRefusalDay["firstAt"] = {};
    const lastAt: SupportRefusalDay["lastAt"] = {};
    for (const reason of Object.keys(record.counts) as SupportRefusalReason[]) {
      firstAt[reason] = iso(record.firstAt[reason]!);
      lastAt[reason] = iso(record.lastAt[reason]!);
    }
    out.push({
      day,
      counts: { ...record.counts },
      firstAt,
      lastAt,
      approximate: record.approximate,
    });
  }
  if (invalid) console.error(REFUSAL_LEDGER_INVALID);
  return summarize(out.reverse());
}

function summarize(days: SupportRefusalDay[]): SupportRefusals {
  const totals: SupportRefusals["totals"] = {};
  for (const day of days)
    for (const [reason, count] of Object.entries(day.counts) as [
      SupportRefusalReason,
      number,
    ][])
      totals[reason] = (totals[reason] ?? 0) + count;
  return {
    days,
    totals,
    approximate: days.some((day) => day.approximate),
    retentionDays: SUPPORT_REFUSAL_POLICY.retentionDays,
  };
}

/** The error's refusal cause, for the room's post-rollback count: the cause
 * the room set at the throw site, else an admission refusal's own cause,
 * else a storage or record limit read from the reason code. Anything else,
 * including every non-HttpError, is not a counted refusal. */
export function refusalCauseFromError(
  error: unknown,
  explicit?: SupportRefusalReason | null,
): SupportRefusalReason | null {
  if (!(error instanceof HttpError)) return null;
  if (
    explicit !== undefined &&
    explicit !== null &&
    ROOM_REASONS.includes(explicit)
  )
    return explicit;
  const refusal = (error as HttpError & { refusal?: unknown }).refusal;
  if (
    refusal === "paused" ||
    refusal === "suspended" ||
    refusal === "credit-limit" ||
    refusal === "demo-limit"
  )
    return refusal;
  if (error.reason === "support-credit-limit") return "credit-limit";
  if (error.reason === "support-demo-limit") return "demo-limit";
  if (error.reason === "support-storage-busy") return "storage-busy";
  if (error.reason === "provider-capacity") return "record-limit";
  return null;
}

/** Counts one widget open on a website the workspace has not approved, in
 * the widget settings object, so no room object wakes for that traffic. */
export async function recordWidgetOriginRefusal(
  storage: Storage,
  nowMs: number,
): Promise<{ counted: boolean; first: boolean }> {
  if (!natural(nowMs)) return { counted: false, first: false };
  const day = utcDay(nowMs);
  const key = `${WIDGET_REFUSAL_PREFIX}${day}`;
  const stored = await storage.get(key);
  const record: StoredWidgetRefusalDay | null =
    stored === undefined
      ? { schema: 1, day, count: 0, firstAt: nowMs, lastAt: nowMs }
      : checkedWidgetDay(stored, day);
  if (!record) {
    console.error(REFUSAL_LEDGER_INVALID);
    return { counted: false, first: false };
  }
  record.count = Math.min(record.count + 1, SUPPORT_REFUSAL_POLICY.maxCount);
  record.lastAt = Math.max(record.lastAt, nowMs);
  await storage.put(key, record);
  await pruneDays(storage, WIDGET_REFUSAL_PREFIX, nowMs);
  return { counted: true, first: record.count === 1 };
}

/** The widget settings object's day counts for the last `days` UTC days,
 * newest first. Unreadable records are skipped and logged. */
export async function readWidgetOriginRefusals(
  storage: Pick<Storage, "list">,
  input: { days: number; nowMs: number },
): Promise<WidgetRefusalDay[]> {
  const days = refusalWindowDays(input.days);
  const today = dayStart(input.nowMs);
  const rows = await storage.list({
    prefix: WIDGET_REFUSAL_PREFIX,
    start: `${WIDGET_REFUSAL_PREFIX}${utcDay(today - (days - 1) * DAY_MS)}`,
    end: `${WIDGET_REFUSAL_PREFIX}${utcDay(today + DAY_MS)}`,
    limit: days * 2,
  });
  const out: WidgetRefusalDay[] = [];
  let invalid = false;
  for (const [key, value] of rows) {
    const day = key.slice(WIDGET_REFUSAL_PREFIX.length);
    const record = DAY.test(day) ? checkedWidgetDay(value, day) : null;
    if (!record) {
      invalid = true;
      continue;
    }
    out.push({
      day,
      count: record.count,
      firstAt: iso(record.firstAt),
      lastAt: iso(record.lastAt),
    });
  }
  if (invalid) console.error(REFUSAL_LEDGER_INVALID);
  return out.reverse();
}

/** Checks the widget settings object's `refusals` answer as it crosses the
 * object boundary. Null means the origin counts are unavailable. */
export function checkedWidgetRefusalDays(
  value: unknown,
): WidgetRefusalDay[] | null {
  if (!Array.isArray(value) || value.length > REFUSAL_WINDOW_DAYS.at(-1)!)
    return null;
  const days: WidgetRefusalDay[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry.day !== "string" ||
      !DAY.test(entry.day) ||
      seen.has(entry.day) ||
      !natural(entry.count) ||
      entry.count > SUPPORT_REFUSAL_POLICY.maxCount ||
      typeof entry.firstAt !== "string" ||
      typeof entry.lastAt !== "string" ||
      !Number.isFinite(Date.parse(entry.firstAt)) ||
      !Number.isFinite(Date.parse(entry.lastAt)) ||
      Date.parse(entry.firstAt) > Date.parse(entry.lastAt)
    )
      return null;
    seen.add(entry.day);
    days.push({
      day: entry.day,
      count: entry.count,
      firstAt: iso(Date.parse(entry.firstAt)),
      lastAt: iso(Date.parse(entry.lastAt)),
    });
  }
  return days;
}

/** Adds the widget's unapproved-origin counts to the room's view. Null
 * widget days (a failed or unreadable second read) keep the room counts and
 * say the origin counts are missing. Inputs are not changed. */
export function mergeOriginRefusals(
  room: SupportRefusals,
  widgetDays: WidgetRefusalDay[] | null,
): SupportRefusals & { originCountsUnavailable?: true } {
  if (widgetDays === null)
    return { ...structuredClone(room), originCountsUnavailable: true };
  const byDay = new Map<string, SupportRefusalDay>(
    room.days.map((day) => [day.day, structuredClone(day)]),
  );
  for (const widget of widgetDays) {
    if (widget.count === 0) continue;
    const day = byDay.get(widget.day) ?? {
      day: widget.day,
      counts: {},
      firstAt: {},
      lastAt: {},
      approximate: false,
    };
    const reason = "origin-not-approved";
    day.counts[reason] = (day.counts[reason] ?? 0) + widget.count;
    const first = day.firstAt[reason];
    const last = day.lastAt[reason];
    day.firstAt[reason] =
      first && Date.parse(first) < Date.parse(widget.firstAt)
        ? first
        : widget.firstAt;
    day.lastAt[reason] =
      last && Date.parse(last) > Date.parse(widget.lastAt)
        ? last
        : widget.lastAt;
    byDay.set(widget.day, day);
  }
  return summarize(
    [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
  );
}
