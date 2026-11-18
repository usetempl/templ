import { observedRpcFetch } from "../workspace-resource-observations";
import { rpcCapacityError, requireRpcBudget } from "../rpc-budget";
import {
  createAuthorizationUpstream,
  RPC_RESPONSE_MAX_BYTES,
  type AuthorizationRpcObservation,
} from "../rpc-upstream";
import { chargeAttempt, type RunMeter } from "./budgets";

/** Every method a transaction check may send. Nothing here signs, sends or
 * simulates on a member's behalf: eth_call only replays a mined transaction
 * or reads token metadata through Multicall3, pinned to an agreed block. */
export const EVM_DIAGNOSIS_METHODS = Object.freeze([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_call",
  "eth_getBalance",
] as const);
export const SOLANA_DIAGNOSIS_METHODS = Object.freeze([
  "getSignatureStatuses",
  "getTransaction",
  "getEpochInfo",
  // SPL token balances of a proven wallet for position
  // reads and the legacy trigger (read only, finalized commitment).
  "getTokenAccountsByOwner",
] as const);
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

export type ProviderRole = "primary" | "confirmation";
export type SideFailure = "provider-error" | "budget";
/** One provider's answer: a result, a JSON-RPC error, or no answer. */
export type Side = {
  result?: unknown;
  error?: { code: number; message?: unknown; data?: unknown };
  failed?: SideFailure;
};
/** One response per configured source; a single response is never duplicated. */
export type Pair = [Side] | [Side, Side];

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type DiagnosisRpcDeps = {
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Absolute epoch ms; rounds after it are skipped as provider-error. */
  deadlineAt: number;
  meter: RunMeter;
  /** A single attempt for position snapshots; other reads allow recovery. */
  maxAttempts?: 1 | 3;
  observe?: (observation: AuthorizationRpcObservation) => Promise<void>;
};

export type DiagnosisRpc = {
  readonly family: "evm" | "solana";
  readonly providerCount?: 1 | 2;
  /** Read each configured provider once. Never throws for a provider
   * problem; a side that got no answer carries `failed`. */
  both(
    method: string,
    params: unknown[],
    options?: { maxBytes?: number },
  ): Promise<Pair>;
  bothBatch(
    calls: readonly { method: string; params: unknown[] }[],
    options?: { maxBytes?: number },
  ): Promise<Pair[]>;
  /** One provider only, for display-only reads such as the pending nonce. */
  one(role: ProviderRole, method: string, params: unknown[]): Promise<Side>;
  expired(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** eth_call targets this run may name (tx.to for the replay, Multicall3). */
  allowCallTo(address: string): void;
};

/** A programming error: the read layer asked for something it must never
 * send. Tests pin every refusal. */
export class DiagnosisMethodRefused extends Error {
  constructor(detail: string) {
    super(`diagnosis-method-refused: ${detail}`);
    this.name = "DiagnosisMethodRefused";
  }
}

const isPinnedBlock = (value: unknown) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === "blockHash,requireCanonical" &&
  typeof (value as { blockHash?: unknown }).blockHash === "string" &&
  /^0x[0-9a-f]{64}$/.test((value as { blockHash: string }).blockHash) &&
  (value as { requireCanonical?: unknown }).requireCanonical === true;

/** A two-provider client for one chain and one run. It goes through the
 * request's RPC budget (never the recovery lane) and the run meter. */
export function createDiagnosisRpc(
  env: object,
  family: "evm" | "solana",
  endpoints: readonly [string, string],
  deps: DiagnosisRpcDeps,
): DiagnosisRpc {
  return createReadRpc(env, family, endpoints, deps);
}

/** Primary-only reads are explicit and keep the same method and budget guards. */
export function createPrimaryDiagnosisRpc(
  env: object,
  family: "evm" | "solana",
  endpoint: string,
  deps: DiagnosisRpcDeps,
): DiagnosisRpc {
  return createReadRpc(env, family, [endpoint], deps);
}

function createReadRpc(
  env: object,
  family: "evm" | "solana",
  endpoints: readonly [string] | readonly [string, string],
  deps: DiagnosisRpcDeps,
): DiagnosisRpc {
  const budget = requireRpcBudget(env);
  // Diagnosis never uses the recovery lane that sign-in and payments fall
  // back to when the room's normal budget is used up.
  budget.setHolding(true);
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const allowed = new Set<string>(
    family === "evm" ? EVM_DIAGNOSIS_METHODS : SOLANA_DIAGNOSIS_METHODS,
  );
  const callTargets = new Set<string>([MULTICALL3]);
  const roles = new Map<string, ProviderRole>([
    [endpoints[0], "primary"],
    ...(endpoints.length === 2
      ? [[endpoints[1], "confirmation"] as [string, ProviderRole]]
      : []),
  ]);
  const upstream = createAuthorizationUpstream({
    budget,
    sleep,
    maxAttempts: deps.maxAttempts,
    observe: deps.observe,
    fetcher: async (url, init) => {
      const request: { method: string } | { method: string }[] = JSON.parse(
        String(init.body),
      );
      const methods = Array.isArray(request)
        ? request.map((call) => call.method)
        : request.method;
      if (deps.meter.attempts >= deps.meter.cap) {
        // Stop at the per-run cap; the upstream reads this as a throttle
        // and the side becomes "budget". No request leaves Templ.
        deps.meter.budgetLimited = true;
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "3600" },
        });
      }
      chargeAttempt(deps.meter, roles.get(url) ?? "confirmation", methods);
      return observedRpcFetch(budget, url, init, deps.fetcher ?? ((u, i) => fetch(u, i)));
    },
  });
  const check = (method: string, params: unknown[]) => {
    if (!allowed.has(method)) throw new DiagnosisMethodRefused(method);
    if (!Array.isArray(params)) throw new DiagnosisMethodRefused("params");
    if (method === "eth_call") {
      const call = params[0] as { to?: unknown } | undefined;
      if (
        !call ||
        typeof call.to !== "string" ||
        !callTargets.has(call.to.toLowerCase())
      )
        throw new DiagnosisMethodRefused("eth_call target");
      if (!isPinnedBlock(params[1]))
        throw new DiagnosisMethodRefused("eth_call block");
    }
  };
  const endpointFor = (role: ProviderRole): string => {
    const endpoint = endpoints[role === "primary" ? 0 : 1];
    if (!endpoint)
      throw new DiagnosisMethodRefused("unconfigured confirmation source");
    return endpoint;
  };
  const send = async (
    role: ProviderRole,
    method: string,
    params: unknown[],
    maxBytes: number,
  ): Promise<Side> => {
    if (now() >= deps.deadlineAt) return { failed: "provider-error" };
    if (deps.meter.attempts >= deps.meter.cap) {
      deps.meter.budgetLimited = true;
      return { failed: "budget" };
    }
    deps.meter.calls += 1;
    try {
      const reply = await upstream(endpointFor(role), method, params, {
        maxBytes,
      });
      if (reply.error && typeof reply.error === "object")
        return { error: reply.error };
      return { result: reply.result };
    } catch (error) {
      if (rpcCapacityError(error) || deps.meter.attempts >= deps.meter.cap) {
        deps.meter.budgetLimited = true;
        return { failed: "budget" };
      }
      return { failed: "provider-error" };
    }
  };
  const sendBatch = async (
    role: ProviderRole,
    calls: readonly { method: string; params: unknown[] }[],
    maxBytes: number,
  ): Promise<Side[]> => {
    const failed = (reason: SideFailure) =>
      calls.map(() => ({ failed: reason }));
    if (now() >= deps.deadlineAt) return failed("provider-error");
    if (deps.meter.attempts >= deps.meter.cap) {
      deps.meter.budgetLimited = true;
      return failed("budget");
    }
    deps.meter.calls += 1;
    try {
      const replies = await upstream.batch(endpointFor(role), calls, {
        maxBytes,
      });
      return replies.map((reply) =>
        reply.error && typeof reply.error === "object"
          ? { error: reply.error }
          : { result: reply.result },
      );
    } catch (error) {
      if (rpcCapacityError(error) || deps.meter.attempts >= deps.meter.cap) {
        deps.meter.budgetLimited = true;
        return failed("budget");
      }
      return failed("provider-error");
    }
  };
  return {
    family,
    providerCount: endpoints.length,
    async both(method, params, options = {}) {
      check(method, params);
      const maxBytes = options.maxBytes ?? RPC_RESPONSE_MAX_BYTES;
      if (endpoints.length === 1)
        return [await send("primary", method, params, maxBytes)];
      return Promise.all([
        send("primary", method, params, maxBytes),
        send("confirmation", method, params, maxBytes),
      ]);
    },
    async one(role, method, params) {
      check(method, params);
      return send(role, method, params, RPC_RESPONSE_MAX_BYTES);
    },
    async bothBatch(calls, options = {}) {
      for (const { method, params } of calls) check(method, params);
      if (calls.length === 0) return [];
      const maxBytes = options.maxBytes ?? RPC_RESPONSE_MAX_BYTES;
      if (endpoints.length === 1) {
        const primary = await sendBatch("primary", calls, maxBytes);
        return primary.map((side): Pair => [side]);
      }
      const [a, b] = await Promise.all([
        sendBatch("primary", calls, maxBytes),
        sendBatch("confirmation", calls, maxBytes),
      ]);
      return calls.map((_, index) => [a[index], b[index]]);
    },
    expired: () => now() >= deps.deadlineAt,
    sleep,
    now,
    allowCallTo(address) {
      callTargets.add(address.toLowerCase());
    },
  };
}
