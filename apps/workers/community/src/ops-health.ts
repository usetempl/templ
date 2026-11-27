import { HttpError, json, readJson, type Env } from "./common";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import { logVersionId } from "./ops-log";

/** Health of Templ's own support path. Every stored value and every answer
 * holds fixed labels, counts and times only: nothing names a person, a
 * workspace, a thread, an address, an IP or a URL. */
export type OpsHealthEnv = Env &
  OperatorAdminEnv & {
    COST_METRICS?: DurableObjectNamespace;
    /** Templ's own support workspace. A plain var, UUIDv7. */
    TEMPL_SUPPORT_WORKSPACE?: string;
    /** The canary's wallet. A plain var, lowercase 0x address. */
    SUPPORT_CANARY_ACCOUNT?: string;
    /** Worker secret, required when the account var is set. It signs only
     * the canary's own sign-in text; the account holds no funds. */
    SUPPORT_CANARY_KEY?: string;
    /** Optional Worker secret: the Better Stack heartbeat address. Never
     * logged, stored or returned. */
    OPS_HEARTBEAT_URL?: string;
  };
/** The one instance of the operator metrics object that keeps these values. */
export const OPS_INSTANCE = "ops-health-v1";
/** The canary cron the release manifest declares with the canary account. */
export const CANARY_SCHEDULE = "*/5 * * * *";

export const STORAGE_CHECKS = ["ok", "failed"] as const;
export const CHAIN_CHECKS = ["ok", "failed"] as const;
export const TEMPL_CHECKS = [
  "active",
  "setup",
  "paused",
  "suspended",
  "missing",
  "unreadable",
  "not-configured",
] as const;
export const CANARY_CHECKS = [
  "ok",
  "failing",
  "stale",
  "needs-setup",
  "off",
] as const;
export type StorageCheck = (typeof STORAGE_CHECKS)[number];
export type ChainCheck = (typeof CHAIN_CHECKS)[number];
export type TemplCheck = (typeof TEMPL_CHECKS)[number];
export type CanaryCheck = (typeof CANARY_CHECKS)[number];
export type SupportHealth = {
  schemaVersion: 1;
  status: "ok" | "degraded" | "down";
  checks: {
    storage: StorageCheck;
    chain: ChainCheck;
    templSupport: TemplCheck;
    canary: CanaryCheck;
  };
  checkedAt: string;
};

export const CANARY_STAGES = [
  "config",
  "probe",
  "preflight",
  "policy",
  "nonce",
  "challenge",
  "verify",
  "room-health",
  "join",
  "status",
  "write",
  "read-back",
  "logout",
] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];
export const CANARY_SETUPS = [
  "ok",
  "off",
  "needs-listing",
  "misconfigured",
] as const;
export type CanarySetup = (typeof CANARY_SETUPS)[number];
export const ALERT_OUTCOMES = [
  "sent",
  "failed",
  "not-configured",
  "invalid",
] as const;
export type AlertOutcome = (typeof ALERT_OUTCOMES)[number];
export type CanaryKind = "light" | "full";
export type CanaryState = {
  schemaVersion: 1;
  setup: CanarySetup;
  lastRunAt: number | null;
  lastRunKind: CanaryKind | null;
  lastOkAt: number | null;
  /** The last full run that wrote a message and read it back. */
  lastFullOkAt: number | null;
  consecutiveFailures: number;
  lastFailure: {
    at: number;
    kind: CanaryKind;
    stage: CanaryStage;
    status: number;
  } | null;
  alert: {
    state: "ok" | "failing";
    /** When the last failure alert was decided. A success ping does not
     * change it. */
    lastSentAt: number | null;
    /** The heartbeat outcome of that failure alert. */
    lastOutcome: AlertOutcome | null;
  };
};
export type CanaryReport = {
  kind: CanaryKind;
  ok: boolean;
  stage?: CanaryStage;
  /** The failing request's HTTP status, or 0 when no request answered. */
  status?: number;
  /** Omitted when this run did not check setup. The ops transaction keeps
   * its current value; an earlier inspection can be missing or stale. */
  setup?: CanarySetup;
};
export type CanaryNotify = "success" | "fail" | null;

export const SUPPORT_SURFACES = ["widget", "app"] as const;
export type SupportSurface = (typeof SUPPORT_SURFACES)[number];
export const SUPPORT_ROUTE_CLASSES = [
  "preflight",
  "auth-policy",
  "auth-guest",
  "auth-nonce",
  "auth-verify",
  "auth-logout",
  "list",
  "status",
  "join",
  "ask",
  "pulse",
  "team-tools",
  "thread",
  "messages-read",
  "messages-write",
  "message-edit",
  "workflow-read",
  "workflow-write",
  "resolve",
  "stop",
  "claim",
  "release",
  "typing",
  "export",
  "other",
] as const;
export type SupportRouteClass = (typeof SUPPORT_ROUTE_CLASSES)[number];

const H = 3_600_000;
const DAY = 86_400_000;
export const OPS_POLICY = {
  /** `/health/support` answers from one isolate's memo for this long. */
  memoMs: 10_000,
  probeWriteMs: 15_000,
  /** Chain and Templ workspace samples are reused for this long. */
  sampleMaxAgeMs: 60_000,
  probeTimeoutMs: 2_000,
  sampleTimeoutMs: 1_000,
  chainTimeoutMs: 5_000,
  roomTimeoutMs: 3_000,
  canaryStaleMs: 12 * 60_000,
  failingAfter: 2,
  realertMs: 6 * H,
  failureHours: 168,
  buildDays: 120,
  failureKeys: 64,
  buildKeys: 24,
  pruneBatch: 64,
  maxCount: 1_000_000,
} as const;

const PROBE_KEY = "ops-probe-v1";
const SAMPLE_KEY = "ops-sample-v1";
const CANARY_KEY = "ops-canary-v1";
const FAILURES_PREFIX = "ops-failures-v1:";
const BUILDS_PREFIX = "ops-widget-builds-v1:";
export const FAILURE_OVERFLOW = "other|other|0";
export const BUILD_OVERFLOW = "other";
const hourOf = (now: number) => new Date(now).toISOString().slice(0, 13);
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAILURE_KEY = new RegExp(
  `^(?:${SUPPORT_SURFACES.join("|")})\\|(?:${SUPPORT_ROUTE_CLASSES.join("|")})\\|5[0-9]{2}$`,
);
const BUILD_KEY = /^(?:[0-9a-f]{16}|legacy|dev|other)$/;
export const validFailureKey = (key: string) =>
  key === FAILURE_OVERFLOW || FAILURE_KEY.test(key);
export const validBuildKey = (key: string) => BUILD_KEY.test(key);

type SampleEntry<T> = { at: number; state: T };
type OpsSample = {
  schemaVersion: 1;
  chain?: SampleEntry<ChainCheck>;
  templSupport?: SampleEntry<TemplCheck>;
};
type Counts = Record<string, number>;
export type OpsSnapshot = {
  schemaVersion: 1;
  probe: { at: number } | null;
  sample: OpsSample | null;
  canary: CanaryState | null;
  failures: { lastHour: Counts; last24h: Counts };
  widgetBuilds: { days: 7; counts: Counts };
};

const includes = <T extends string>(list: readonly T[], value: unknown) =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const invalid = () => new HttpError(400, "Invalid ops health request.");
function fields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
) {
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    required.some((key) => body[key] === undefined)
  )
    throw invalid();
}

function checkedEntry<T extends string>(
  value: unknown,
  labels: readonly T[],
): SampleEntry<T> | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !time(value.at) || !includes(labels, value.state))
    return undefined;
  return { at: value.at as number, state: value.state as T };
}
function checkedSample(value: unknown): OpsSample | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const chain = checkedEntry(value.chain, CHAIN_CHECKS);
  const templSupport = checkedEntry(value.templSupport, TEMPL_CHECKS);
  return {
    schemaVersion: 1,
    ...(chain ? { chain } : {}),
    ...(templSupport ? { templSupport } : {}),
  };
}
const nullableTime = (value: unknown) => value === null || time(value);
/** A stored canary state, or null when it is absent or unreadable. */
export function checkedCanaryState(value: unknown): CanaryState | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const failure = value.lastFailure;
  const alert = value.alert;
  if (
    !includes(CANARY_SETUPS, value.setup) ||
    !nullableTime(value.lastRunAt) ||
    !(
      value.lastRunKind === null ||
      includes(["light", "full"], value.lastRunKind)
    ) ||
    !nullableTime(value.lastOkAt) ||
    !nullableTime(value.lastFullOkAt) ||
    !Number.isSafeInteger(value.consecutiveFailures) ||
    (value.consecutiveFailures as number) < 0 ||
    !(
      failure === null ||
      (isRecord(failure) &&
        time(failure.at) &&
        includes(["light", "full"], failure.kind) &&
        includes(CANARY_STAGES, failure.stage) &&
        Number.isSafeInteger(failure.status) &&
        (failure.status as number) >= 0 &&
        (failure.status as number) <= 599)
    ) ||
    !isRecord(alert) ||
    !includes(["ok", "failing"], alert.state) ||
    !nullableTime(alert.lastSentAt) ||
    !(alert.lastOutcome === null || includes(ALERT_OUTCOMES, alert.lastOutcome))
  )
    return null;
  return {
    schemaVersion: 1,
    setup: value.setup as CanarySetup,
    lastRunAt: value.lastRunAt as number | null,
    lastRunKind: value.lastRunKind as CanaryKind | null,
    lastOkAt: value.lastOkAt as number | null,
    lastFullOkAt: value.lastFullOkAt as number | null,
    consecutiveFailures: value.consecutiveFailures as number,
    lastFailure: failure as CanaryState["lastFailure"],
    alert: {
      state: alert.state as "ok" | "failing",
      lastSentAt: alert.lastSentAt as number | null,
      lastOutcome: alert.lastOutcome as AlertOutcome | null,
    },
  };
}
export function emptyCanaryState(): CanaryState {
  return {
    schemaVersion: 1,
    setup: "off",
    lastRunAt: null,
    lastRunKind: null,
    lastOkAt: null,
    lastFullOkAt: null,
    consecutiveFailures: 0,
    lastFailure: null,
    alert: { state: "ok", lastSentAt: null, lastOutcome: null },
  };
}

/** Records one canary run and decides the heartbeat. A passing run pings
 * success. A failing run pings failure when it is the second in a row, and
 * again only after `realertMs` while the failures continue. */
export function decideCanary(
  current: CanaryState,
  run: CanaryReport,
  now: number,
): { state: CanaryState; notify: CanaryNotify } {
  // Light runs cannot check the account's listing. Ignore their old-format
  // listing claims too, so an in-flight older run cannot undo a full check.
  const setup =
    run.kind === "light" &&
    (run.setup === "ok" || run.setup === "needs-listing")
      ? undefined
      : run.setup;
  const state: CanaryState = {
    ...current,
    setup: setup ?? current.setup,
    lastRunAt: now,
    lastRunKind: run.kind,
    alert: { ...current.alert },
  };
  if (run.ok) {
    state.lastOkAt = now;
    if (run.kind === "full" && run.setup === "ok") state.lastFullOkAt = now;
    state.consecutiveFailures = 0;
    state.alert.state = "ok";
    return { state, notify: "success" };
  }
  state.consecutiveFailures = Math.min(
    current.consecutiveFailures + 1,
    OPS_POLICY.maxCount,
  );
  state.lastFailure = {
    at: now,
    kind: run.kind,
    stage: run.stage!,
    status: run.status!,
  };
  if (
    state.consecutiveFailures >= OPS_POLICY.failingAfter &&
    (current.alert.state === "ok" ||
      current.alert.lastSentAt === null ||
      now - current.alert.lastSentAt >= OPS_POLICY.realertMs)
  ) {
    state.alert.state = "failing";
    state.alert.lastSentAt = now;
    return { state, notify: "fail" };
  }
  return { state, notify: null };
}

function checkedCounts(
  value: unknown,
  valid: (key: string) => boolean,
  max: number,
) {
  if (!isRecord(value)) throw invalid();
  const entries = Object.entries(value);
  if (
    !entries.length ||
    entries.length > max ||
    entries.some(
      ([key, count]) =>
        !valid(key) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 1 ||
        (count as number) > OPS_POLICY.maxCount,
    )
  )
    throw invalid();
  return entries as [string, number][];
}
function storedCounts(value: unknown, valid: (key: string) => boolean): Counts {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, count]) =>
        valid(key) && Number.isSafeInteger(count) && (count as number) > 0,
    ),
  ) as Counts;
}
/** Adds counts to a bucket that holds at most `maxKeys` keys; a new key that
 * does not fit is added to the overflow key. */
function addCounts(
  bucket: Counts,
  entries: [string, number][],
  maxKeys: number,
  overflow: string,
) {
  for (const [raw, count] of entries) {
    const regular = Object.keys(bucket).filter((key) => key !== overflow);
    const key =
      raw in bucket || raw === overflow || regular.length < maxKeys - 1
        ? raw
        : overflow;
    bucket[key] = Math.min((bucket[key] ?? 0) + count, OPS_POLICY.maxCount);
  }
  return bucket;
}
function sumCounts(
  buckets: Iterable<unknown>,
  valid: (key: string) => boolean,
) {
  const total: Counts = {};
  for (const bucket of buckets)
    for (const [key, count] of Object.entries(storedCounts(bucket, valid)))
      total[key] = Math.min((total[key] ?? 0) + count, OPS_POLICY.maxCount);
  return total;
}

async function opsSnapshot(
  storage: DurableObjectStorage,
  now: number,
): Promise<OpsSnapshot> {
  const probe = await storage.get<{ at: number }>(PROBE_KEY);
  const hours = await storage.list({
    start: FAILURES_PREFIX + hourOf(now - 23 * H),
    end: `${FAILURES_PREFIX}${hourOf(now)}~`,
    limit: 24,
  });
  const days = await storage.list({
    start: BUILDS_PREFIX + dayOf(now - 6 * DAY),
    end: `${BUILDS_PREFIX}${dayOf(now)}~`,
    limit: 7,
  });
  return {
    schemaVersion: 1,
    probe:
      isRecord(probe) && time(probe.at) ? { at: probe.at as number } : null,
    sample: checkedSample(await storage.get(SAMPLE_KEY)),
    canary: checkedCanaryState(await storage.get(CANARY_KEY)),
    failures: {
      lastHour: sumCounts(
        [hours.get(FAILURES_PREFIX + hourOf(now))],
        validFailureKey,
      ),
      last24h: sumCounts(hours.values(), validFailureKey),
    },
    widgetBuilds: { days: 7, counts: sumCounts(days.values(), validBuildKey) },
  };
}

/** Served by the operator metrics object (the `COST_METRICS` binding) for
 * the `ops-health-v1` instance. Only the worker reaches it. Every body is
 * checked field by field; unknown keys are refused. */
export async function opsHealthRequest(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/ops/")) return null;
  const route = url.pathname.slice("/ops/".length);
  const now = Date.now();
  if (route === "snapshot") {
    if (request.method !== "GET") throw new HttpError(404, "Not found.");
    return json(await opsSnapshot(storage, now));
  }
  if (
    request.method !== "POST" ||
    !["probe", "sample", "canary", "alert", "failures", "builds"].includes(
      route,
    )
  )
    throw new HttpError(404, "Not found.");
  const body = await readJson(request, 8192);
  if (route === "probe") {
    fields(body, []);
    return json(
      await storage.transaction(async (local) => {
        const stored = await local.get<{ at: number }>(PROBE_KEY);
        if (
          !isRecord(stored) ||
          !time(stored.at) ||
          stored.at > now ||
          now - stored.at >= OPS_POLICY.probeWriteMs
        )
          await local.put(PROBE_KEY, { at: now });
        const back = await local.get<{ at: number }>(PROBE_KEY);
        if (!isRecord(back) || !time(back.at))
          throw new HttpError(503, "Ops storage is unavailable.");
        return {
          storage: "ok",
          sample: checkedSample(await local.get(SAMPLE_KEY)),
          canary: checkedCanaryState(await local.get(CANARY_KEY)),
        };
      }),
    );
  }
  if (route === "sample") {
    fields(body, ["chain", "templSupport"]);
    const entry = <T extends string>(value: unknown, labels: readonly T[]) => {
      if (value === undefined) return undefined;
      const checked = checkedEntry(value, labels);
      if (!checked || checked.at > now + 60_000) throw invalid();
      return checked;
    };
    const chain = entry(body.chain, CHAIN_CHECKS);
    const templSupport = entry(body.templSupport, TEMPL_CHECKS);
    if (!chain && !templSupport) throw invalid();
    await storage.transaction(async (local) => {
      const current = checkedSample(await local.get(SAMPLE_KEY)) ?? {
        schemaVersion: 1 as const,
      };
      const next = { ...current };
      if (chain && (!current.chain || chain.at > current.chain.at))
        next.chain = chain;
      if (
        templSupport &&
        (!current.templSupport || templSupport.at > current.templSupport.at)
      )
        next.templSupport = templSupport;
      await local.put(SAMPLE_KEY, next);
    });
    return json({ ok: true });
  }
  if (route === "canary") {
    fields(body, ["kind", "ok", "stage", "status", "setup"], ["kind", "ok"]);
    if (
      !includes(["light", "full"], body.kind) ||
      typeof body.ok !== "boolean" ||
      (body.setup !== undefined && !includes(CANARY_SETUPS, body.setup)) ||
      (body.kind === "full" && body.ok === true && body.setup === undefined) ||
      (body.ok
        ? body.stage !== undefined || body.status !== undefined
        : !includes(CANARY_STAGES, body.stage) ||
          !Number.isSafeInteger(body.status) ||
          (body.status as number) < 0 ||
          (body.status as number) > 599)
    )
      throw invalid();
    const run: CanaryReport = {
      kind: body.kind as CanaryKind,
      ok: body.ok,
      ...(body.setup === undefined ? {} : { setup: body.setup as CanarySetup }),
      ...(body.ok
        ? {}
        : { stage: body.stage as CanaryStage, status: body.status as number }),
    };
    const notify = await storage.transaction(async (local) => {
      const current =
        checkedCanaryState(await local.get(CANARY_KEY)) ?? emptyCanaryState();
      const decided = decideCanary(current, run, now);
      await local.put(CANARY_KEY, decided.state);
      return decided.notify;
    });
    return json({ notify });
  }
  if (route === "alert") {
    fields(body, ["outcome"], ["outcome"]);
    if (!includes(ALERT_OUTCOMES, body.outcome)) throw invalid();
    await storage.transaction(async (local) => {
      const current = checkedCanaryState(await local.get(CANARY_KEY));
      if (!current) throw new HttpError(409, "No canary run is recorded.");
      current.alert.lastOutcome = body.outcome as AlertOutcome;
      await local.put(CANARY_KEY, current);
    });
    return json({ ok: true });
  }
  const failures = route === "failures";
  fields(body, ["counts"], ["counts"]);
  const entries = checkedCounts(
    body.counts,
    failures ? validFailureKey : validBuildKey,
    failures ? OPS_POLICY.failureKeys : OPS_POLICY.buildKeys,
  );
  const key = failures
    ? FAILURES_PREFIX + hourOf(now)
    : BUILDS_PREFIX + dayOf(now);
  await storage.transaction(async (local) => {
    const bucket = storedCounts(
      await local.get(key),
      failures ? validFailureKey : validBuildKey,
    );
    await local.put(
      key,
      addCounts(
        bucket,
        entries,
        failures ? OPS_POLICY.failureKeys : OPS_POLICY.buildKeys,
        failures ? FAILURE_OVERFLOW : BUILD_OVERFLOW,
      ),
    );
    if ((await local.getAlarm()) === null) await local.setAlarm(now + DAY);
  });
  return json({ ok: true });
}

/** Deletes failure buckets older than 168 hours and build buckets older than
 * 120 days, 64 of each per pass. Says whether any ops key remains, so the
 * daily alarm keeps running. */
export async function pruneOpsHealth(
  storage: Pick<DurableObjectStorage, "list" | "delete">,
  nowMs: number,
) {
  for (const [prefix, cutoff] of [
    [FAILURES_PREFIX, hourOf(nowMs - (OPS_POLICY.failureHours - 1) * H)],
    [BUILDS_PREFIX, dayOf(nowMs - (OPS_POLICY.buildDays - 1) * DAY)],
  ] as const) {
    const old = await storage.list({
      prefix,
      end: prefix + cutoff,
      limit: OPS_POLICY.pruneBatch,
    });
    if (old.size) await storage.delete([...old.keys()]);
  }
  return (await storage.list({ prefix: "ops-", limit: 1 })).size > 0;
}

// Worker side: `/health/support` and `/operator/health`.

export type HealthDeps = {
  verifiedChain: (env: Env) => Promise<unknown>;
  /** Per-isolate memo shared by both public health routes. */
  memo?: HealthMemo;
};
export type HealthMemo = {
  current: { at: number; body: SupportHealth } | null;
  chain?: SampleEntry<ChainCheck>;
  pendingChain?: Promise<SampleEntry<ChainCheck>>;
  pendingSupport?: Promise<SupportHealth>;
};
export const createHealthMemo = (): HealthMemo => ({ current: null });

/** Room answer of `POST /private/support/health` (the room route arrives
 * with the conversation wiring). Fixed labels; `canaryThread` never leaves
 * the worker. */
export type RoomHealth = {
  schemaVersion: 1;
  workspace: "found" | "missing";
  product: "active" | "setup" | "paused" | "suspended" | "unreadable";
  canAdmit: boolean;
  canaryListed: boolean;
  canaryThread: `tc-${string}` | null;
};
export function checkedRoomHealth(value: unknown): RoomHealth | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !includes(["found", "missing"], value.workspace) ||
    !includes(
      ["active", "setup", "paused", "suspended", "unreadable"],
      value.product,
    ) ||
    typeof value.canAdmit !== "boolean" ||
    typeof value.canaryListed !== "boolean" ||
    !(
      value.canaryThread === null ||
      (typeof value.canaryThread === "string" &&
        /^tc-[0-9a-f]{32}$/.test(value.canaryThread))
    )
  )
    return null;
  return {
    schemaVersion: 1,
    workspace: value.workspace as RoomHealth["workspace"],
    product: value.product as RoomHealth["product"],
    canAdmit: value.canAdmit,
    canaryListed: value.canaryListed,
    canaryThread: value.canaryThread as RoomHealth["canaryThread"],
  };
}
export function templCheck(room: RoomHealth | null): TemplCheck {
  if (!room) return "unreadable";
  if (room.workspace === "missing") return "missing";
  return room.product;
}
/** Asks Templ's workspace room for its fixed-label health. Any answer other
 * than a well-formed 200 (including the 404 of a room without the route)
 * reads as unreadable. */
export async function readRoomHealth(
  env: Pick<Env, "ROOMS" | "CF_VERSION_METADATA">,
  workspace: string,
  canary?: string,
): Promise<{ status: number; room: RoomHealth | null }> {
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(OPS_POLICY.roomTimeoutMs);
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(`native-room:${workspace}`),
    ).fetch(
      new Request("https://internal/private/support/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(canary ? { canary } : {}),
        signal,
      }),
    );
    if (!response.ok) {
      logRoomHealthFailure(env, "http-refused", response.status);
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, room: null };
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch (error) {
      logRoomHealthFailure(
        env,
        roomHealthFailure(error, signal),
        response.status,
      );
      return { status: response.status, room: null };
    }
    const room = checkedRoomHealth(answer);
    if (!room) logRoomHealthFailure(env, "invalid-response", response.status);
    else if (room.product === "unreadable")
      logRoomHealthFailure(env, "product-unreadable", response.status);
    return { status: response.status, room };
  } catch (error) {
    logRoomHealthFailure(env, roomHealthFailure(error, signal));
    return { status: 0, room: null };
  }
}

type RoomHealthFailure =
  | "timeout"
  | "http-refused"
  | "invalid-response"
  | "transport-failed"
  | "product-unreadable";

function roomHealthFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): RoomHealthFailure {
  if (
    signal?.aborted ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  )
    return "timeout";
  return error instanceof SyntaxError ? "invalid-response" : "transport-failed";
}

/** No workspace, canary, request/response body or exception text enters logs. */
function logRoomHealthFailure(
  env: Pick<OpsHealthEnv, "CF_VERSION_METADATA">,
  reason: RoomHealthFailure,
  status?: number,
) {
  console.error(
    "TEMPL_SUPPORT_ROOM_HEALTH_FAILED",
    JSON.stringify({
      schemaVersion: 1,
      versionId: logVersionId(env),
      reason,
      ...(typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? { status }
        : {}),
    }),
  );
}

type ProbeFailure =
  | "not-configured"
  | "timeout"
  | "http-refused"
  | "invalid-response"
  | "transport-failed";

function logProbeFailure(
  env: Pick<OpsHealthEnv, "CF_VERSION_METADATA">,
  path: string,
  reason: ProbeFailure,
  status?: number,
) {
  if (path !== "/ops/probe") return;
  console.error(
    "TEMPL_SUPPORT_HEALTH_PROBE_FAILED",
    JSON.stringify({
      schemaVersion: 1,
      versionId: logVersionId(env),
      reason,
      ...(typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? { status }
        : {}),
    }),
  );
}

/** Calls the ops instance. Never throws: null means no usable answer.
 * Only probe failures log fixed labels, without request or response data. */
export async function opsCall<T>(
  env: Pick<OpsHealthEnv, "COST_METRICS" | "CF_VERSION_METADATA">,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T | null> {
  if (!env.COST_METRICS) {
    logProbeFailure(env, path, "not-configured");
    return null;
  }
  let signal: AbortSignal | undefined;
  let status: number | undefined;
  let reading = false;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const response = await env.COST_METRICS.get(
      env.COST_METRICS.idFromName(OPS_INSTANCE),
    ).fetch(
      new Request(`https://internal${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal,
      }),
    );
    status = response.status;
    if (!response.ok) {
      logProbeFailure(env, path, "http-refused", status);
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    reading = true;
    const answer = await response.json();
    if (
      path === "/ops/probe" &&
      (!isRecord(answer) || answer.storage !== "ok")
    ) {
      logProbeFailure(env, path, "invalid-response", status);
      return null;
    }
    return answer as T;
  } catch (error) {
    const timedOut =
      signal?.aborted ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"));
    logProbeFailure(
      env,
      path,
      timedOut
        ? "timeout"
        : reading && error instanceof SyntaxError
          ? "invalid-response"
          : "transport-failed",
      status,
    );
    return null;
  }
}

export function healthStatus(
  checks: SupportHealth["checks"],
): SupportHealth["status"] {
  if (
    checks.storage === "failed" ||
    ["paused", "suspended", "missing", "unreadable"].includes(
      checks.templSupport,
    ) ||
    checks.canary === "failing"
  )
    return "down";
  if (
    checks.chain === "failed" ||
    checks.templSupport === "setup" ||
    ["stale", "needs-setup"].includes(checks.canary)
  )
    return "degraded";
  return "ok";
}
export function canaryCheck(
  env: Pick<OpsHealthEnv, "SUPPORT_CANARY_ACCOUNT" | "SUPPORT_CANARY_KEY">,
  state: CanaryState | null,
  now: number,
): CanaryCheck {
  if (!env.SUPPORT_CANARY_KEY && !env.SUPPORT_CANARY_ACCOUNT) return "off";
  if (state?.setup !== "ok") return "needs-setup";
  if (state.consecutiveFailures >= OPS_POLICY.failingAfter) return "failing";
  if (
    state.lastRunAt === null ||
    now - state.lastRunAt > OPS_POLICY.canaryStaleMs
  )
    return "stale";
  return "ok";
}
export const HEARTBEAT_URL =
  /^https:\/\/uptime\.betterstack\.com\/api\/v1\/heartbeat\/[A-Za-z0-9]{16,64}$/;
export function alertHookState(
  env: Pick<OpsHealthEnv, "OPS_HEARTBEAT_URL">,
): "configured" | "not-configured" | "invalid" {
  const url = env.OPS_HEARTBEAT_URL;
  if (url === undefined || url === "") return "not-configured";
  return HEARTBEAT_URL.test(url) ? "configured" : "invalid";
}

async function chainCheck(
  env: Env,
  deps: Pick<HealthDeps, "verifiedChain">,
): Promise<ChainCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.verifiedChain(env),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          OPS_POLICY.chainTimeoutMs,
        );
      }),
    ]);
    return "ok";
  } catch {
    return "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const freshSample = (entry: { at: number } | undefined, now: number) =>
  !!entry && entry.at <= now && now - entry.at < OPS_POLICY.sampleMaxAgeMs;

async function sampledChainCheck(
  env: OpsHealthEnv,
  deps: HealthDeps,
  now: number,
  sample: SampleEntry<ChainCheck> | undefined,
  storageReady: boolean,
): Promise<ChainCheck> {
  const memo = deps.memo;
  if (freshSample(memo?.chain, now)) return memo!.chain!.state;
  if (freshSample(sample, now)) {
    if (memo) memo.chain = sample;
    return sample!.state;
  }
  if (memo?.pendingChain) return (await memo.pendingChain).state;
  const pending = (async () => {
    const entry = { at: now, state: await chainCheck(env, deps) };
    if (storageReady)
      await opsCall(
        env,
        "/ops/sample",
        { chain: entry },
        OPS_POLICY.sampleTimeoutMs,
      );
    if (memo) memo.chain = entry;
    return entry;
  })();
  if (memo) memo.pendingChain = pending;
  try {
    return (await pending).state;
  } finally {
    if (memo?.pendingChain === pending) delete memo.pendingChain;
  }
}

/** The support health route reuses the ops object's 60-second chain sample.
 * The isolate shares a refresh while the first provider read is in flight. */
export async function inspectChainHealth(
  env: OpsHealthEnv,
  deps: HealthDeps,
  now: number,
  providedProbe?: Record<string, unknown> | null,
): Promise<ChainCheck> {
  if (freshSample(deps.memo?.chain, now)) return deps.memo!.chain!.state;
  if (deps.memo?.pendingChain) return (await deps.memo.pendingChain).state;
  const answer =
    providedProbe === undefined
      ? await opsCall<Record<string, unknown>>(
          env,
          "/ops/probe",
          {},
          OPS_POLICY.probeTimeoutMs,
        )
      : providedProbe;
  const probe = isRecord(answer) && answer.storage === "ok" ? answer : null;
  return sampledChainCheck(
    env,
    deps,
    now,
    checkedSample(probe?.sample)?.chain,
    !!probe,
  );
}

export type HealthInspection = {
  body: SupportHealth;
  /** The stored canary state, when storage answered. */
  canary: CanaryState | null;
};
/** Probes storage, then reads the chain and Templ's workspace unless a sample
 * younger than a minute exists, records fresh samples and derives the fixed
 * labels. Never throws. */
export async function inspectSupportHealth(
  env: OpsHealthEnv,
  deps: HealthDeps,
  now: number,
): Promise<HealthInspection> {
  const answer = await opsCall<Record<string, unknown>>(
    env,
    "/ops/probe",
    {},
    OPS_POLICY.probeTimeoutMs,
  );
  const probe = isRecord(answer) && answer.storage === "ok" ? answer : null;
  const sample = probe ? checkedSample(probe.sample) : null;
  const stored = probe ? checkedCanaryState(probe.canary) : null;
  const record: {
    templSupport?: SampleEntry<TemplCheck>;
  } = {};
  const chain = await inspectChainHealth(env, deps, now, probe);
  const workspace = env.TEMPL_SUPPORT_WORKSPACE;
  let templSupport: TemplCheck;
  if (!workspace) templSupport = "not-configured";
  else if (!UUIDV7.test(workspace)) templSupport = "missing";
  else if (freshSample(sample?.templSupport, now))
    templSupport = sample!.templSupport!.state;
  else {
    templSupport = templCheck((await readRoomHealth(env, workspace)).room);
    record.templSupport = { at: now, state: templSupport };
  }
  if (probe && record.templSupport)
    await opsCall(env, "/ops/sample", record, OPS_POLICY.sampleTimeoutMs);
  const checks: SupportHealth["checks"] = {
    storage: probe ? "ok" : "failed",
    chain,
    templSupport,
    canary: canaryCheck(env, stored, now),
  };
  return {
    body: {
      schemaVersion: 1,
      status: healthStatus(checks),
      checks,
      checkedAt: new Date(now).toISOString(),
    },
    canary: stored,
  };
}

/** `GET /health/support`: public, without Origin, like `/health`. Fixed
 * labels only; 503 when the support path is down. */
export async function supportHealthRoute(
  request: Request,
  env: OpsHealthEnv,
  deps: HealthDeps,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/health/support") return null;
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  if (
    !env.CHAT_READ_RATE_LIMITER ||
    !(
      await env.CHAT_READ_RATE_LIMITER.limit({
        key: `health:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
      })
    ).success
  )
    throw new HttpError(429, "Too many requests. Please try again shortly.");
  const now = Date.now();
  const memo = deps.memo?.current;
  let body =
    memo && memo.at <= now && now - memo.at < OPS_POLICY.memoMs
      ? memo.body
      : null;
  if (!body) {
    const pending =
      deps.memo?.pendingSupport ??
      inspectSupportHealth(env, deps, now).then(
        (inspection) => inspection.body,
      );
    if (deps.memo) deps.memo.pendingSupport = pending;
    try {
      body = await pending;
      if (deps.memo) deps.memo.current = { at: now, body };
    } finally {
      if (deps.memo?.pendingSupport === pending)
        delete deps.memo.pendingSupport;
    }
  }
  return json(body, body.status === "down" ? 503 : 200);
}

export type OperatorHealth = {
  schemaVersion: 1;
  checkedAt: string;
  status: SupportHealth["status"];
  checks: SupportHealth["checks"];
  schedule: typeof CANARY_SCHEDULE | null;
  /** Null until a canary run is recorded. */
  canary: Omit<CanaryState, "schemaVersion"> | null;
  alertHook: ReturnType<typeof alertHookState>;
  failures: OpsSnapshot["failures"];
  widgetBuilds: OpsSnapshot["widgetBuilds"];
};
/** `GET /operator/health`: the same checks computed fresh, the canary's
 * record, the heartbeat setup and the failure and widget-build counts. */
export async function operatorHealthRoute<S extends ServiceSession>(
  request: Request,
  env: OpsHealthEnv,
  auth: { session: () => Promise<S> } & Pick<HealthDeps, "verifiedChain">,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/operator/health") return null;
  const session = await auth.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(403, "This page is for Templ operators.");
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  const inspection = await inspectSupportHealth(env, auth, Date.now());
  const snapshot = await opsCall<OpsSnapshot>(
    env,
    "/ops/snapshot",
    undefined,
    OPS_POLICY.probeTimeoutMs,
  );
  const stored = checkedCanaryState(snapshot?.canary) ?? inspection.canary;
  const canary = stored
    ? (({ schemaVersion: _, ...rest }) => rest)(stored)
    : null;
  const failures = isRecord(snapshot?.failures) ? snapshot.failures : null;
  const builds = isRecord(snapshot?.widgetBuilds)
    ? snapshot.widgetBuilds
    : null;
  return json({
    schemaVersion: 1,
    checkedAt: inspection.body.checkedAt,
    status: inspection.body.status,
    checks: inspection.body.checks,
    schedule: env.SUPPORT_CANARY_ACCOUNT ? CANARY_SCHEDULE : null,
    canary,
    alertHook: alertHookState(env),
    failures: {
      lastHour: storedCounts(failures?.lastHour, validFailureKey),
      last24h: storedCounts(failures?.last24h, validFailureKey),
    },
    widgetBuilds: {
      days: 7,
      counts: storedCounts(builds?.counts, validBuildKey),
    },
  } satisfies OperatorHealth);
}
