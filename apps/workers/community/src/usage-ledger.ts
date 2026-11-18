import { HttpError } from "./common";

export type UsageStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};
const DAY = 86_400;
const HOUR = 3_600;
const RETENTION = 30 * DAY;
const MAX_HOURS = RETENTION / HOUR + 1;
export type UsageMeter = {
  used: number;
  limit: number;
  windowSeconds: number;
  nextAvailableAt: string | null;
};
export class UsageLimitError extends HttpError {
  readonly retryAfterSeconds: number;
  constructor(
    public readonly resource: "provider-capacity",
    public readonly meter?: UsageMeter,
    nowMs = Date.now(),
  ) {
    super(429, "Chat verification is busy. Please try again later.");
    this.retryAfterSeconds = meter?.nextAvailableAt
      ? Math.min(
          86_400,
          Math.max(
            1,
            Math.ceil((Date.parse(meter.nextAvailableAt) - nowMs) / 1_000),
          ),
        )
      : 60;
  }
}
const invalid = () =>
  new HttpError(503, "Chat usage is temporarily unavailable.");
function check(value: unknown): asserts value {
  if (!value) throw invalid();
}
function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function second(nowMs: number) {
  check(natural(nowMs));
  return Math.floor(nowMs / 1_000);
}
type Hour = { hour: number; count: number };
type Counter = { schema: 1; asOf: number; total: number; hours: Hour[] };
type Seconds = [at: number, count: number][];
const prefix = (name: string) => `usage-v1:${name}`;
const bucketKey = (name: string, hour: number) =>
  `${prefix(name)}:hour:${hour}`;
function checkedSeconds(raw: unknown, hour: number, expected: number): Seconds {
  check(Array.isArray(raw) && raw.length > 0 && raw.length <= HOUR);
  let previous = -1,
    total = 0;
  for (const entry of raw) {
    check(Array.isArray(entry) && entry.length === 2);
    const [at, count] = entry;
    check(
      natural(at) &&
        at > previous &&
        Math.floor(at / HOUR) === hour &&
        natural(count) &&
        count > 0,
    );
    previous = at;
    total += count;
    check(natural(total));
  }
  check(total === expected);
  return raw as Seconds;
}
/** Caller supplies transaction-local storage. All mutations, including expiry,
 * must commit or roll back with the admitted action. No internal transaction is opened. */
async function counter(storage: UsageStorage, name: string, nowMs: number) {
  const key = prefix(name);
  const raw = await storage.get<Counter>(key);
  const state: Counter = raw ?? {
    schema: 1,
    asOf: second(nowMs),
    total: 0,
    hours: [],
  };
  check(
    state.schema === 1 &&
      natural(state.asOf) &&
      natural(state.total) &&
      Array.isArray(state.hours) &&
      state.hours.length <= MAX_HOURS,
  );
  let previous = -1,
    total = 0;
  for (const item of state.hours) {
    check(
      natural(item.hour) &&
        item.hour <= Math.floor(state.asOf / HOUR) &&
        item.hour > previous &&
        natural(item.count) &&
        item.count > 0,
    );
    previous = item.hour;
    total += item.count;
    check(natural(total));
  }
  check(total === state.total);
  // A clock rollback cannot resurrect expired allowance or move a charge backwards.
  const now = Math.max(second(nowMs), state.asOf);
  const cutoff = now - RETENTION;
  const expired = state.hours.filter(
    (item) => (item.hour + 1) * HOUR <= cutoff,
  );
  for (const item of expired) {
    await storage.delete(bucketKey(name, item.hour));
    state.total -= item.count;
  }
  state.hours = state.hours.slice(expired.length);
  const first = state.hours[0];
  if (first && first.hour * HOUR <= cutoff) {
    const entries = checkedSeconds(
      await storage.get(bucketKey(name, first.hour)),
      first.hour,
      first.count,
    );
    const kept = entries.filter(([at]) => at > cutoff);
    const removed = entries
      .filter(([at]) => at <= cutoff)
      .reduce((sum, [, amount]) => sum + amount, 0);
    if (removed) {
      state.total -= removed;
      first.count -= removed;
      if (kept.length) await storage.put(bucketKey(name, first.hour), kept);
      else {
        await storage.delete(bucketKey(name, first.hour));
        state.hours.shift();
      }
    }
  }
  state.asOf = now;
  // Persist the watermark even for a read, so later clock rollback cannot reset quota.
  await storage.put(key, state);
  return { state, now, key };
}
async function meter(
  storage: UsageStorage,
  name: string,
  limit: number,
  windowSeconds: number,
  nowMs: number,
): Promise<UsageMeter> {
  const { state, now } = await counter(storage, name, nowMs);
  const cutoff = now - windowSeconds;
  const hours = state.hours.filter((item) => (item.hour + 1) * HOUR > cutoff);
  let used = hours.reduce((sum, item) => sum + item.count, 0);
  let earliest: number | undefined;
  if (hours.length) {
    const first = hours[0];
    const entries = checkedSeconds(
      await storage.get(bucketKey(name, first.hour)),
      first.hour,
      first.count,
    );
    for (const [at, count] of entries) {
      if (at <= cutoff) used -= count;
      else if (earliest === undefined) earliest = at;
    }
    if (earliest === undefined && hours[1]) {
      const next = hours[1];
      earliest = checkedSeconds(
        await storage.get(bucketKey(name, next.hour)),
        next.hour,
        next.count,
      )[0][0];
    }
  }
  return {
    used,
    limit,
    windowSeconds,
    nextAvailableAt:
      earliest === undefined
        ? null
        : new Date((earliest + windowSeconds) * 1_000).toISOString(),
  };
}
async function add(
  storage: UsageStorage,
  name: string,
  amount: number,
  nowMs: number,
) {
  check(natural(amount) && amount > 0);
  const { state, now, key } = await counter(storage, name, nowMs);
  const hour = Math.floor(now / HOUR);
  let item = state.hours.at(-1);
  check(!item || item.hour <= hour);
  let entries: Seconds;
  if (item?.hour === hour)
    entries = checkedSeconds(
      await storage.get(bucketKey(name, hour)),
      hour,
      item.count,
    );
  else {
    item = { hour, count: 0 };
    state.hours.push(item);
    entries = [];
  }
  const last = entries.at(-1);
  if (last?.[0] === now) last[1] += amount;
  else entries.push([now, amount]);
  item.count += amount;
  state.total += amount;
  check(natural(state.total) && state.hours.length <= MAX_HOURS);
  await storage.put(bucketKey(name, hour), entries);
  await storage.put(key, state);
  return now;
}
/** Published standard EVM Alchemy CU weights, checked 2026-09-13 against
 * https://www.alchemy.com/docs/reference/compute-unit-costs. These weights
 * apply to the keyed Alchemy primary; confirmation attempts have their own
 * bounded metric and are not billed as primary compute units.
 * Never accept a cost supplied by a
 * browser, agent, or RPC response. Zero-CU methods still have finite attempt counts.
 * Throughput and the independent provider's quota are separate budgets. */
export const RPC_METHOD_CU = {
  // Conservative admission units, not provider invoices. DAS search is a
  // heavier indexed read; every actual retry reserves the same work again.
  getGenesisHash: 10,
  getAccountInfo: 100,
  getMultipleAccounts: 100,
  isBlockhashValid: 100,
  getTokenAccountsByOwner: 100,
  getTransaction: 100,
  getSignaturesForAddress: 100,
  getSignatureStatuses: 100,
  getLatestBlockhash: 100,
  // Transaction checks read block height and slot together in one call.
  getEpochInfo: 100,
  getAsset: 160,
  searchAssets: 480,
  eth_chainId: 0,
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getBlockByHash: 20,
  eth_getCode: 20,
  eth_call: 26,
  eth_getBalance: 20,
  eth_getStorageAt: 20,
  eth_getTransactionCount: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionReceipt: 20,
  eth_getLogs: 60,
  eth_getProof: 20,
  eth_estimateGas: 20,
  eth_gasPrice: 20,
} as const;
export type RpcBudgetMethod = keyof typeof RPC_METHOD_CU;
export type RpcBudgetMetric = "primary-cu" | "confirmation-attempts";
/** Internal per-room admission budgets. Product status never changes provider
 * safety limits; all rooms use the same conservative ceiling. */
export const RPC_USAGE_LIMITS = {
  "primary-cu": 1_000_000,
  "confirmation-attempts": 60_000,
} as const satisfies Record<RpcBudgetMetric, number>;
export const RPC_SERVICE_LIMITS = {
  "primary-cu": 20_000_000,
  "confirmation-attempts": 1_200_000,
} as const satisfies Record<RpcBudgetMetric, number>;
function metricNames(metric: RpcBudgetMetric = "primary-cu") {
  check(metric === "primary-cu" || metric === "confirmation-attempts");
  return metric === "primary-cu"
    ? { counter: "rpc-cu", journal: "usage-v1:rpc-reservations" }
    : {
        counter: "rpc-confirmation-attempts",
        journal: "usage-v1:rpc-confirmation-reservations",
      };
}
export const MAX_RPC_RESERVATIONS = 128;
export const RPC_RESERVATION_TTL_MS = 120_000;
type RpcReservation = {
  at: number;
  expiresAt: number;
  reservedCu: number;
  usedCu: number;
  remainingAttempts: Partial<Record<RpcBudgetMethod, number>>;
};
type RpcJournal = {
  schema: 1;
  asOf: number;
  entries: Record<string, RpcReservation>;
};
function cost(method: RpcBudgetMethod, metric: RpcBudgetMetric = "primary-cu") {
  check(Object.prototype.hasOwnProperty.call(RPC_METHOD_CU, method));
  metricNames(metric);
  return metric === "confirmation-attempts" ? 1 : RPC_METHOD_CU[method];
}
function reservationId(id: string) {
  check(typeof id === "string" && /^[a-z0-9-]{16,64}$/.test(id));
}
async function journal(
  storage: UsageStorage,
  nowMs: number,
  metric: RpcBudgetMetric = "primary-cu",
) {
  const names = metricNames(metric);
  const reservationsKey = names.journal;
  const value = (await storage.get<RpcJournal>(reservationsKey)) ?? {
    schema: 1 as const,
    asOf: second(nowMs),
    entries: {},
  };
  check(
    value.schema === 1 &&
      natural(value.asOf) &&
      value.entries &&
      typeof value.entries === "object" &&
      !Array.isArray(value.entries) &&
      Object.keys(value.entries).length <= MAX_RPC_RESERVATIONS,
  );
  // A usage-only read may advance this metric's durable clock without touching
  // its tickets. Keep both clocks aligned through later server clock rollback.
  const usageState = await storage.get<Counter>(prefix(names.counter));
  check(!usageState || (usageState.schema === 1 && natural(usageState.asOf)));
  const now = Math.max(second(nowMs), value.asOf, usageState?.asOf ?? 0);
  for (const [id, entry] of Object.entries(value.entries)) {
    reservationId(id);
    check(
      entry &&
        natural(entry.at) &&
        entry.at <= value.asOf &&
        natural(entry.expiresAt) &&
        entry.expiresAt === entry.at + RPC_RESERVATION_TTL_MS / 1_000 &&
        natural(entry.reservedCu) &&
        natural(entry.usedCu) &&
        entry.remainingAttempts &&
        typeof entry.remainingAttempts === "object" &&
        !Array.isArray(entry.remainingAttempts),
    );
    let remainingCu = 0,
      attempts = 0;
    for (const [method, count] of Object.entries(entry.remainingAttempts)) {
      check(natural(count) && count <= 192);
      attempts += count;
      remainingCu += cost(method as RpcBudgetMethod, metric) * count;
    }
    check(attempts <= 192 && entry.usedCu + remainingCu === entry.reservedCu);
    // A crashed/expired operation keeps its conservative full charge. Expiry
    // cannot refund unobserved attempts or allow the same ticket to run again.
    if (entry.expiresAt <= now) delete value.entries[id];
  }
  value.asOf = now;
  await storage.put(reservationsKey, value);
  return { value, now, reservationsKey };
}
async function refund(
  storage: UsageStorage,
  at: number,
  amount: number,
  nowMs: number,
  metric: RpcBudgetMetric,
) {
  if (!amount) return;
  check(natural(amount));
  const name = metricNames(metric).counter;
  const { state, now, key } = await counter(storage, name, nowMs);
  if (at <= now - RETENTION) return;
  const hour = Math.floor(at / HOUR);
  const item = state.hours.find((entry) => entry.hour === hour);
  check(item);
  const entries = checkedSeconds(
    await storage.get(bucketKey(name, hour)),
    hour,
    item.count,
  );
  const entry = entries.find(([time]) => time === at);
  check(
    entry &&
      entry[1] >= amount &&
      item.count >= amount &&
      state.total >= amount,
  );
  entry[1] -= amount;
  item.count -= amount;
  state.total -= amount;
  const kept = entries.filter(([, count]) => count > 0);
  if (kept.length) await storage.put(bucketKey(name, hour), kept);
  else {
    await storage.delete(bucketKey(name, hour));
    state.hours = state.hours.filter((value) => value.hour !== hour);
  }
  await storage.put(key, state);
}
export function readRpcUsage(
  storage: UsageStorage,
  {
    limitCu,
    nowMs,
    metric = "primary-cu",
  }: { limitCu: number; nowMs: number; metric?: RpcBudgetMetric },
) {
  check(natural(limitCu) && limitCu > 0);
  return meter(storage, metricNames(metric).counter, limitCu, RETENTION, nowMs);
}
/** Reserve before ANY upstream work. Calls is a server-built operation plan;
 * three attempts/logical call includes the transport's two permitted retries.
 * Use separately in the room and service-wide budget DO; both must admit before
 * dispatch. No default account-wide cap is inferred for unrelated applications. */
export async function reserveRpcBudget(
  storage: UsageStorage,
  input: {
    calls: readonly RpcBudgetMethod[];
    /** Units selected by metric: conservative primary CU or confirmation-provider attempts. */
    limitCu: number;
    metric?: RpcBudgetMetric;
    nowMs: number;
    /** Internal server-generated ID only; never take it from request JSON. */
    id?: string;
  },
) {
  check(
    Array.isArray(input.calls) &&
      input.calls.length > 0 &&
      input.calls.length <= 64,
  );
  const metric = input.metric ?? "primary-cu";
  const { value, now, reservationsKey } = await journal(
    storage,
    input.nowMs,
    metric,
  );
  const id = input.id ?? crypto.randomUUID();
  reservationId(id);
  check(!Object.prototype.hasOwnProperty.call(value.entries, id));
  if (Object.keys(value.entries).length >= MAX_RPC_RESERVATIONS)
    throw new UsageLimitError("provider-capacity");
  const remainingAttempts: RpcReservation["remainingAttempts"] = {};
  let reservedCu = 0;
  for (const method of input.calls as readonly RpcBudgetMethod[]) {
    reservedCu += cost(method, metric) * 3;
    remainingAttempts[method] = (remainingAttempts[method] ?? 0) + 3;
  }
  const usage = await readRpcUsage(storage, {
    limitCu: input.limitCu,
    metric,
    nowMs: now * 1_000,
  });
  if (reservedCu > usage.limit - usage.used)
    throw new UsageLimitError("provider-capacity", usage, now * 1_000);
  if (reservedCu)
    await add(storage, metricNames(metric).counter, reservedCu, now * 1_000);
  const expiresAt = now + RPC_RESERVATION_TTL_MS / 1_000;
  value.entries[id] = {
    at: now,
    expiresAt,
    reservedCu,
    usedCu: 0,
    remainingAttempts,
  };
  await storage.put(reservationsKey, value);
  return {
    id,
    reservedCu,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  };
}
/** Commit this consumption BEFORE fetch, including each retry. HTTP/provider
 * errors still count. Unknown methods and exhausted/expired tickets fail closed. */
export async function consumeRpcAttempt(
  storage: UsageStorage,
  input: {
    id: string;
    method: RpcBudgetMethod;
    nowMs: number;
    metric?: RpcBudgetMetric;
  },
) {
  reservationId(input.id);
  const metric = input.metric ?? "primary-cu";
  const cu = cost(input.method, metric);
  const { value, reservationsKey } = await journal(
    storage,
    input.nowMs,
    metric,
  );
  const entry = value.entries[input.id];
  if (!entry || !(entry.remainingAttempts[input.method]! > 0))
    throw new UsageLimitError("provider-capacity");
  entry.remainingAttempts[input.method]!--;
  entry.usedCu += cu;
  await storage.put(reservationsKey, value);
  return { chargedCu: cu };
}
/** Cancel the one precharged room attempt when service admission failed before
 * any provider fetch. No general-purpose refund is exposed: only a fresh,
 * single-method ticket with exactly its first attempt charged qualifies. */
export async function abortRpcFirstAttempt(
  storage: UsageStorage,
  input: {
    id: string;
    method: RpcBudgetMethod;
    nowMs: number;
    metric?: RpcBudgetMetric;
  },
) {
  reservationId(input.id);
  const metric = input.metric ?? "primary-cu";
  const cu = cost(input.method, metric);
  const { value, now, reservationsKey } = await journal(
    storage,
    input.nowMs,
    metric,
  );
  const entry = value.entries[input.id];
  if (
    !entry ||
    entry.reservedCu !== 3 * cu ||
    entry.usedCu !== cu ||
    entry.remainingAttempts[input.method] !== 2 ||
    Object.keys(entry.remainingAttempts).length !== 1
  )
    return { aborted: false };
  await refund(storage, entry.at, entry.reservedCu, now * 1_000, metric);
  delete value.entries[input.id];
  await storage.put(reservationsKey, value);
  return { aborted: true };
}
/** No caller-supplied usage totals. Refund only the persisted unused allowance;
 * duplicate/late settlement cannot lower another operation's charge. */
export async function settleRpcBudget(
  storage: UsageStorage,
  input: { id: string; nowMs: number; metric?: RpcBudgetMetric },
) {
  reservationId(input.id);
  const metric = input.metric ?? "primary-cu";
  const { value, now, reservationsKey } = await journal(
    storage,
    input.nowMs,
    metric,
  );
  const entry = value.entries[input.id];
  if (!entry) return { settled: false, refundedCu: 0 };
  const refundedCu = entry.reservedCu - entry.usedCu;
  await refund(storage, entry.at, refundedCu, now * 1_000, metric);
  delete value.entries[input.id];
  await storage.put(reservationsKey, value);
  return { settled: true, refundedCu };
}

export const PRIMARY_RPC_BURST_CU = 500;
export const PRIMARY_RPC_REFILL_CU_PER_SECOND = 250;
/** Service-wide actual-attempt admission, not a reservation. Commit in the same
 * transaction as the selected ticket consumption, before fetch. The fixed refill
 * protects this service; it cannot account for other apps sharing an API key. */
export async function consumePrimaryRpcBurst(
  storage: UsageStorage,
  input: { method: RpcBudgetMethod; nowMs: number },
) {
  check(natural(input.nowMs));
  // Chain IDs are free in the monthly bill but still consume provider throughput.
  const chargedCu = input.method === "eth_chainId" ? 5 : cost(input.method);
  const key = "usage-v1:primary-rpc-burst";
  const capacity = PRIMARY_RPC_BURST_CU * 1_000;
  const saved = await storage.get<{
    schema: 1;
    asOfMs: number;
    milliCu: number;
  }>(key);
  check(
    !saved ||
      (saved.schema === 1 &&
        natural(saved.asOfMs) &&
        natural(saved.milliCu) &&
        saved.milliCu <= capacity),
  );
  const nowMs = Math.max(input.nowMs, saved?.asOfMs ?? input.nowMs);
  // Clamp elapsed time before multiplication to retain exact safe integers.
  const elapsed = Math.min(2_000, nowMs - (saved?.asOfMs ?? nowMs));
  const available = Math.min(
    capacity,
    (saved?.milliCu ?? capacity) + elapsed * PRIMARY_RPC_REFILL_CU_PER_SECOND,
  );
  const required = chargedCu * 1_000;
  if (required > available) {
    const waitMs = Math.ceil(
      (required - available) / PRIMARY_RPC_REFILL_CU_PER_SECOND,
    );
    throw new UsageLimitError(
      "provider-capacity",
      {
        used: PRIMARY_RPC_BURST_CU - available / 1_000,
        limit: PRIMARY_RPC_BURST_CU,
        windowSeconds: 2,
        nextAvailableAt: new Date(nowMs + waitMs).toISOString(),
      },
      input.nowMs,
    );
  }
  await storage.put(key, {
    schema: 1,
    asOfMs: nowMs,
    milliCu: available - required,
  });
  return { chargedCu };
}
