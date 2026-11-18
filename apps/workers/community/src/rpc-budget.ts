import { queueWorkspaceResources, type ResourceObservation } from "./workspace-resource-observations";
import { defer } from "./request-context";
import { recordCostMetric } from "./cost-observability";
import { isPrimaryRpcEndpoint } from "./chain-rpc";
import { HttpError, json, STORAGE_SCOPE_CHAIN_ID, type Env } from "./common";
import {
  abortRpcFirstAttempt,
  consumePrimaryRpcBurst,
  consumeRpcAttempt,
  reserveRpcBudget,
  settleRpcBudget,
  RPC_METHOD_CU,
  RPC_USAGE_LIMITS,
  RPC_SERVICE_LIMITS,
  UsageLimitError,
  type RpcBudgetMetric,
  type RpcBudgetMethod,
  type UsageStorage,
} from "./usage-ledger";

// A request-local capability, installed by worker code and payment checks. It is never a
// binding string, request header, caller-supplied object, or cross-request cache.
export const RPC_BUDGET = Symbol("authorization-rpc-budget");
export type RpcBudgetEnv = Env & {
  [RPC_BUDGET]?: ReturnType<typeof createRpcBudget>;
};
export type RpcBudget = ReturnType<typeof createRpcBudget>;
/** A missing request capability refuses the read before any provider call. */
export function requireRpcBudget(env: object): RpcBudget {
  const budget = (env as RpcBudgetEnv)[RPC_BUDGET];
  if (!budget) throw unavailable();
  return budget;
}
export const RPC_RECOVERY_LIMITS = {
  "primary-cu": 100_000,
  "confirmation-attempts": 6_000,
} as const;
type Lane = "normal" | "recovery";
type Scope = {
  stub: DurableObjectStub;
  kind: "service" | "room";
  lane: Lane;
};
export type RpcBudgetRefusal = {
  at: string;
  status: 429;
  request: {
    op: string;
    metric: RpcBudgetMetric;
    kind: "room";
    lane: "normal";
  } & Record<string, unknown>;
  response: unknown;
};
const unavailable = () =>
  new HttpError(503, "Chat usage is temporarily unavailable.");
/** Viem wraps local transport errors. Trust only our actual HttpError instance,
 * never an upstream JSON object's status/message fields. */
export function rpcCapacityError(error: unknown): HttpError | undefined {
  const visited = new Set<unknown>();
  for (
    let depth = 0;
    depth < 8 && error && typeof error === "object" && !visited.has(error);
    depth++
  ) {
    if (error instanceof HttpError && error.status === 429) return error;
    visited.add(error);
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}
const limited = (retry = 60) =>
  new HttpError(
    429,
    "Chat verification is busy. Please try again later.",
    retry,
  );
const internal = async (
  scope: Scope,
  op: string,
  metric: RpcBudgetMetric,
  input: object = {},
  observe?: (refusal: RpcBudgetRefusal) => Promise<void>,
) => {
  const response = await scope.stub.fetch(
    new Request("https://internal/private/rpc-budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op,
        metric,
        kind: scope.kind,
        lane: scope.lane,
        ...input,
      }),
    }),
  );
  if (response.status === 429) {
    if (observe && scope.kind === "room" && scope.lane === "normal") {
      try {
        await observe({
          at: new Date().toISOString(),
          status: 429,
          request: { op, metric, kind: "room", lane: "normal", ...input },
          response: await response.json(),
        });
      } catch {
        /* A capture failure preserves the ordinary refusal. */
      }
    }
    throw limited(Number(response.headers.get("Retry-After")) || 60);
  }
  if (!response.ok) throw unavailable();
  return response.json<{ id: string; aborted?: boolean }>();
};

/** All current worker RPC goes through the service budget. Known rooms also
 * charge their room and billing owner. Payment recovery uses this budget. */
export function createRpcBudget(env: Env) {
  let room: DurableObjectStub | undefined;
  let workspace: string | undefined;
  let scheduleResource = (work: () => Promise<unknown>) => defer(env, work);
  let holding = false;
  let providerLimited = false;
  let retryAfterSeconds = 0;
  let observe: ((refusal: RpcBudgetRefusal) => Promise<void>) | undefined;
  const rememberLimit = (error: unknown) => {
    const capacity = rpcCapacityError(error);
    if (capacity) {
      recordCostMetric(env, "rpcBlockedAttempts");
      providerLimited = true;
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        capacity.retryAfterSeconds ?? 60,
      );
    }
  };
  const service = () =>
    env.ROOMS.get(
      env.ROOMS.idFromName(`${STORAGE_SCOPE_CHAIN_ID}:authorization-usage:v1`),
    );
  const scopes = (lane: Lane): Scope[] => [
    { stub: service(), kind: "service", lane: "normal" },
    ...(room ? [{ stub: room, kind: "room" as const, lane }] : []),
  ];
  const budgetRequest: typeof internal = (scope, op, metric, input) => {
    recordCostMetric(env, "rpcBudgetRequests");
    return internal(scope, op, metric, input, observe);
  };
  return {
    observeRefusals(callback: (refusal: RpcBudgetRefusal) => Promise<void>) {
      const previous = observe;
      observe = callback;
      return () => {
        if (observe === callback) observe = previous;
      };
    },
    setRoom(stub: DurableObjectStub, trustedWorkspace?: string, schedule?: (work: () => Promise<unknown>) => void) {
      room = stub;
      // Only server callers with a resolved native record set attribution.
      workspace = trustedWorkspace;
      scheduleResource = schedule ?? (work => defer(env, work));
    },
    providerAttemptObserver(url: string, methods: readonly string[]) {
      // Capture scope before dispatch; a later setRoom cannot reassign this attempt.
      const target = workspace;
      const schedule = scheduleResource;
      if (!target) return undefined;
      try {
        const host = new URL(url).hostname;
        const provider = host.endsWith(".g.alchemy.com") ? "alchemy" : host === "lb.drpc.live" ? "drpc" : "unknown";
        const counts = new Map<string, number>();
        for (const method of methods) if (Object.hasOwn(RPC_METHOD_CU, method)) counts.set(method, (counts.get(method) ?? 0) + 1);
        return (outcome: "accepted" | "failed" | "unknown") => {
          const observations: ResourceObservation[] = [...counts].map(([method, quantity]) => ({
            kind: "rpc", provider, metric: "rpc-attempts", quantity: String(quantity),
            unit: "request", method, outcome,
          }));
          queueWorkspaceResources(env, target, observations, schedule);
        };
      } catch { return undefined; }
    },
    setHolding(value: boolean) {
      holding = value;
    },
    get limited() {
      return providerLimited;
    },
    get retryAfterSeconds() {
      return retryAfterSeconds;
    },
    async reserve(url: string, method: string, firstAttempt = false) {
      if (!Object.hasOwn(RPC_METHOD_CU, method)) throw unavailable();
      const endpoint = new URL(url);
      // Confirmation reads use the same conservative admission units, not an
      // asserted provider billing price. Selecting it never resets capacity.
      const metric: RpcBudgetMetric = isPrimaryRpcEndpoint(endpoint)
        ? "primary-cu"
        : "confirmation-attempts";
      const rpcMethod = method as RpcBudgetMethod;
      const tickets: { scope: Scope; id: string }[] = [];
      let firstAttemptCharged = false;
      let failedScope: Scope["kind"] | undefined;
      const settle = async () => {
        const saved = tickets.splice(0);
        // A failed settlement conservatively retains reserved capacity. It must
        // not turn a verified successful read into an authorization failure.
        await Promise.allSettled(
          saved.map(({ scope, id }) =>
            budgetRequest(scope, "settle", metric, { id }),
          ),
        );
      };
      const abortUnfetchedRoom = async () => {
        if (!firstAttempt || failedScope !== "service") return;
        // The room's first attempt was charged before the shared service
        // refused admission. No fetch can have started yet; refund this exact
        // fresh ticket, while retaining it conservatively on failure.
        const roomTicket = tickets.find(({ scope }) => scope.kind === "room");
        if (!roomTicket) return;
        try {
          const result = await budgetRequest(
            roomTicket.scope,
            "abort-first-attempt",
            metric,
            { id: roomTicket.id, method: rpcMethod },
          );
          if (result.aborted) tickets.splice(tickets.indexOf(roomTicket), 1);
        } catch {
          // A lost abort response cannot prove a refund. Settlement keeps the
          // charged attempt and releases only unused reservation.
        }
      };
      const admit = async (lane: Lane) => {
        // Admit and charge the room's first attempt before shared capacity.
        // A denied room attempt cannot spend the service-wide burst or CU.
        const ordered = firstAttempt ? scopes(lane).reverse() : scopes(lane);
        for (const scope of ordered) {
          failedScope = scope.kind;
          const ticket = await budgetRequest(
            scope,
            firstAttempt ? "reserve-attempt" : "reserve",
            metric,
            {
              method: rpcMethod,
            },
          );
          failedScope = undefined;
          tickets.push({ scope, id: ticket.id });
          if (firstAttempt) firstAttemptCharged = true;
        }
      };
      try {
        await admit("normal");
      } catch (error) {
        await abortUnfetchedRoom();
        await settle();
        rememberLimit(error);
        if (
          !(error instanceof HttpError) ||
          error.status !== 429 ||
          failedScope !== "room" ||
          holding ||
          !room
        )
          throw error;
        try {
          await admit("recovery");
        } catch (recoveryError) {
          rememberLimit(recoveryError);
          await abortUnfetchedRoom();
          await settle();
          throw recoveryError;
        }
      }
      return {
        async beforeAttempt() {
          // Persist each actual attempt in every admitted scope before fetch.
          // A partial failed admission remains conservatively charged.
          try {
            if (firstAttemptCharged) firstAttemptCharged = false;
            else {
              for (const { scope, id } of tickets)
                await budgetRequest(scope, "attempt", metric, {
                  id,
                  method: rpcMethod,
                });
            }
            recordCostMetric(
              env,
              metric === "primary-cu"
                ? "rpcPrimaryAttempts"
                : "rpcConfirmationAttempts",
            );
            if (metric === "primary-cu")
              recordCostMetric(
                env,
                "rpcPrimaryComputeUnits",
                RPC_METHOD_CU[rpcMethod],
              );
          } catch (error) {
            rememberLimit(error);
            throw error;
          }
        },
        settle,
      };
    },
  };
}

const prefixed = (storage: UsageStorage, prefix: string): UsageStorage => ({
  get: <T>(key: string) => storage.get<T>(prefix + key),
  put: (key, value) => storage.put(prefix + key, value),
  delete: (key) => storage.delete(prefix + key),
});

/** Private binding endpoint. The worker selects scope, lane and method; limits
 * and all charged costs are fixed here, never copied from HTTP request input. */
export async function rpcBudgetRequest(
  storage: UsageStorage,
  body: Record<string, unknown>,
) {
  // This endpoint already runs inside one room storage transaction. Ledger
  // helpers may update the same journal or counter several times while checking
  // expiry, reserving, consuming or refunding. Persist only its final value.
  // Reads still see each intermediate write, with the same copy semantics as KV.
  const writes = new Map<string, { value: unknown } | null>();
  const buffered: UsageStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      if (writes.has(key)) {
        const pending = writes.get(key);
        return pending ? (structuredClone(pending.value) as T) : undefined;
      }
      return storage.get<T>(key);
    },
    async put(key, value) {
      writes.set(key, { value: structuredClone(value) });
    },
    async delete(key) {
      writes.set(key, null);
    },
  };
  const response = await applyRpcBudgetRequest(buffered, body);
  // Rejected quota responses also commit their conservative clock/expiry
  // watermarks. Exceptions or a failed flush roll back in the caller's existing
  // transaction. There is no provider fetch or cross-request cache here.
  for (const [key, pending] of writes) {
    if (pending) await storage.put(key, pending.value);
    else await storage.delete(key);
  }
  return response;
}

async function applyRpcBudgetRequest(
  storage: UsageStorage,
  body: Record<string, unknown>,
) {
  const metric = body.metric as RpcBudgetMetric;
  const kind = body.kind;
  const lane = body.lane;
  if (
    !["primary-cu", "confirmation-attempts"].includes(metric) ||
    !["service", "room"].includes(String(kind)) ||
    !["normal", "recovery"].includes(String(lane)) ||
    (kind === "service" && lane !== "normal")
  )
    throw new HttpError(400, "Invalid usage request.");
  const ledger = lane === "recovery" ? prefixed(storage, "recovery:") : storage;
  const nowMs = Date.now();
  try {
    if (body.op === "settle")
      return json(
        await settleRpcBudget(ledger, { id: String(body.id), metric, nowMs }),
      );
    const method = body.method as RpcBudgetMethod;
    if (!Object.hasOwn(RPC_METHOD_CU, method))
      throw new HttpError(400, "Invalid usage method.");
    if (body.op === "abort-first-attempt") {
      if (kind !== "room") throw new HttpError(400, "Invalid usage request.");
      return json(
        await abortRpcFirstAttempt(ledger, {
          id: String(body.id),
          method,
          metric,
          nowMs,
        }),
      );
    }
    if (body.op === "reserve" || body.op === "reserve-attempt") {
      const limitCu =
        kind === "service"
          ? RPC_SERVICE_LIMITS[metric]
          : lane === "recovery"
            ? RPC_RECOVERY_LIMITS[metric]
            : RPC_USAGE_LIMITS[metric];
      const ticket = await reserveRpcBudget(ledger, {
        calls: [method],
        metric,
        limitCu,
        nowMs,
      });
      if (body.op === "reserve-attempt") {
        try {
          if (kind === "service" && metric === "primary-cu")
            await consumePrimaryRpcBurst(storage, { method, nowMs });
          await consumeRpcAttempt(ledger, {
            id: ticket.id,
            metric,
            method,
            nowMs,
          });
        } catch (error) {
          // The first attempt was not admitted. Release this new ticket before
          // returning a quota response; no upstream fetch has occurred.
          await settleRpcBudget(ledger, {
            id: ticket.id,
            metric,
            nowMs,
          });
          throw error;
        }
      }
      return json(ticket);
    }
    if (body.op === "attempt") {
      if (kind === "service" && metric === "primary-cu")
        await consumePrimaryRpcBurst(storage, { method, nowMs });
      return json(
        await consumeRpcAttempt(ledger, {
          id: String(body.id),
          metric,
          method,
          nowMs,
        }),
      );
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    // Return inside the transaction so conservative clock/expiry watermarks on a
    // rejected attempt survive rollback. No fetch occurs after a rejected lease.
    if (error instanceof UsageLimitError)
      return json({ error: error.message }, 429, {
        "Retry-After": String(error.retryAfterSeconds),
      });
    throw error;
  }
}
