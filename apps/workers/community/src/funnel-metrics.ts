import {
  addFunnelEvent,
  emptyFunnelDay,
  FUNNEL_POLICY,
  funnelDayOf,
  funnelEvent,
  type FunnelDay,
  type FunnelEvent,
  type WorkspaceFunnelStep,
} from "@templ/chat/funnel";
import { HttpError, json, readJson } from "./common";
/** Onboarding counts live in one instance of the operator metrics object,
 * apart from the sampled cost shards. */
export type FunnelEnv = {
  COST_METRICS?: DurableObjectNamespace;
  AUTH_RECORDS?: DurableObjectNamespace;
  APP_ORIGIN?: string;
};
export const FUNNEL_INSTANCE = "onboarding-funnel-v1";
const DAY_PREFIX = "onboarding-funnel-day-v1:";
const DAY = 86_400_000;
const DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Writes one fixed-label log line per event and adds the batch to the
 * counts. It never throws: a lost count cannot change the user's action. */
export async function sendFunnelEvents(
  env: FunnelEnv,
  events: FunnelEvent[],
): Promise<boolean> {
  if (!events.length) return true;
  for (const event of events)
    console.log("TEMPL_FUNNEL", JSON.stringify({ schemaVersion: 1, ...event }));
  if (!env.COST_METRICS) return false;
  try {
    const response = await env.COST_METRICS.get(
      env.COST_METRICS.idFromName(FUNNEL_INSTANCE),
    ).fetch(
      new Request("https://internal/funnel/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(2000),
      }),
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

const STEP_PREFIX = "funnel-step-v1:";
/** Counts the steps `markWorkspaceStep` marked in this isolate. A workspace
 * object compares it before and after a request to learn that it has steps
 * to send; a mark by another object in the same isolate, or one a rolled-back
 * transaction discarded, only costs one extra check. */
let marks = 0;
export const workspaceStepMarks = () => marks;
type StepMarker = {
  at: number;
  sent: boolean;
  event: FunnelEvent;
};
type MarkerStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
};
/** Call inside the workspace's own storage transaction. The first call for a
 * step (or for one refusal cause of it) marks it for `flushWorkspaceSteps`;
 * later calls change nothing. Returns whether it marked the step. */
export async function markWorkspaceStep(
  storage: MarkerStorage,
  step: WorkspaceFunnelStep,
  nowMs: number,
  cause?: "origin-not-approved",
) {
  const key = `${STEP_PREFIX}${step}${cause ? `:${cause}` : ""}`;
  if (await storage.get(key)) return false;
  const event: FunnelEvent = cause
    ? { step, outcome: "failed", cause }
    : { step, outcome: "done" };
  await storage.put(key, {
    at: nowMs,
    sent: false,
    event,
  } satisfies StepMarker);
  marks++;
  return true;
}
/** After commit: sends the marked steps not sent yet, then records them as
 * sent. False means they stay marked for the next attempt. A marked step the
 * current step list does not name is never sent: it is recorded as sent, so
 * it cannot hold back the others. */
export async function flushWorkspaceSteps(
  storage: DurableObjectStorage,
  env: FunnelEnv,
) {
  const markers = await storage.list<StepMarker>({
    prefix: STEP_PREFIX,
    limit: 64,
  });
  const pending = [...markers].filter(([, marker]) => !marker.sent);
  if (!pending.length) return true;
  const events = pending
    .map(([, marker]) => funnelEvent(marker.event))
    .filter((event): event is FunnelEvent => event !== undefined);
  for (let offset = 0; offset < events.length; offset += FUNNEL_POLICY.maxBatch)
    if (
      !(await sendFunnelEvents(
        env,
        events.slice(offset, offset + FUNNEL_POLICY.maxBatch),
      ))
    )
      return false;
  await storage.transaction(async (local) => {
    for (const [key] of pending) {
      const marker = await local.get<StepMarker>(key);
      if (marker && !marker.sent)
        await local.put(key, { ...marker, sent: true });
    }
  });
  return true;
}

/** Served by the operator metrics object (the `COST_METRICS` binding) for
 * the onboarding instance. Fixed daily counters; nothing names a person or a
 * workspace. */
export async function funnelMetricsRequest(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/funnel/snapshot" && request.method === "GET") {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (
      !DATE.test(from) ||
      !DATE.test(to) ||
      from > to ||
      Date.parse(to) - Date.parse(from) >
        (Math.max(...FUNNEL_POLICY.windows) - 1) * DAY
    )
      throw new HttpError(400, "Choose a valid date range.");
    const days = await storage.list<FunnelDay>({
      start: DAY_PREFIX + from,
      end: `${DAY_PREFIX}${to}~`,
      limit: Math.max(...FUNNEL_POLICY.windows),
    });
    return json({ days: [...days.values()] });
  }
  if (url.pathname !== "/funnel/ingest") return null;
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const body = await readJson(request, 8192);
  const raw = body.events;
  if (
    Object.keys(body).some((key) => key !== "events") ||
    !Array.isArray(raw) ||
    !raw.length ||
    raw.length > FUNNEL_POLICY.maxBatch
  )
    throw new HttpError(400, "Invalid funnel batch.");
  const events = raw.map(funnelEvent);
  if (events.some((event) => !event))
    throw new HttpError(400, "Invalid funnel batch.");
  const now = Date.now(),
    day = funnelDayOf(now),
    key = DAY_PREFIX + day;
  await storage.transaction(async (local) => {
    const current = await local.get<FunnelDay>(key);
    const next = current ?? emptyFunnelDay(day);
    for (const event of events) addFunnelEvent(next, event!);
    await local.put(key, next);
    if (!current) {
      await pruneFunnelDays(local, now);
      if ((await local.getAlarm()) === null) await local.setAlarm(now + DAY);
    }
  });
  return json({ ok: true });
}
/** Deletes days older than the retention and says whether any remain. */
export async function pruneFunnelDays(
  storage: Pick<DurableObjectStorage, "list" | "delete">,
  nowMs: number,
) {
  const old = await storage.list({
    prefix: DAY_PREFIX,
    end:
      DAY_PREFIX + funnelDayOf(nowMs - (FUNNEL_POLICY.retentionDays - 1) * DAY),
    limit: 64,
  });
  if (old.size) await storage.delete([...old.keys()]);
  return (await storage.list({ prefix: DAY_PREFIX, limit: 1 })).size > 0;
}
