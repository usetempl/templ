import {
  classifyRpcFailure,
  reportRpcFailure,
  type RpcBlockReference,
} from "./rpc-diagnostics";
import { HttpError } from "./common";
import type { RpcBudget } from "./rpc-budget";

export type AuthorizationRpcReply = {
  result?: unknown;
  error?: { code: number; message?: unknown; data?: unknown };
};
export type AuthorizationRpcCall = {
  method: string;
  params: unknown[] | Record<string, unknown>;
};
export type AuthorizationRpcObservation =
  | {
      kind: "dispatch";
      requestId: string;
      url: string;
      at: string;
      transport: "single" | "batch";
      batch: {
        jsonrpc: "2.0";
        id: number;
        method: string;
        params: unknown[] | Record<string, unknown>;
      }[];
    }
  | {
      kind: "response";
      requestId: string;
      url: string;
      at: string;
      responses: unknown[];
    }
  | { kind: "incomplete"; requestId: string };
/** Default response cap. A caller may raise it to at most 8 MiB for one
 * call; transaction diagnosis does so for a receipt only. */
export const RPC_RESPONSE_MAX_BYTES = 1024 * 1024;
export const RPC_RESPONSE_MAX_BYTES_CEILING = 8 * 1024 * 1024;

const unavailable = () =>
  new HttpError(
    503,
    "Independent chain verification is temporarily unavailable.",
  );

/** The JSON-RPC error of a refused request, read from at most 16 KiB. */
async function rpcErrorBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const reply: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return reply &&
      typeof reply === "object" &&
      "error" in reply &&
      reply.error &&
      typeof reply.error === "object"
      ? (reply.error as { code?: unknown; message?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}
function reportRejectedBlock(
  url: string,
  request: AuthorizationRpcCall,
  error: { code?: unknown; message?: unknown } | undefined,
) {
  if (!error) return;
  const classification = classifyRpcFailure(error);
  reportRpcFailure({
    stage: "upstream-rpc",
    url,
    method: String(request.method),
    code: error.code,
    category: classification === "wrapped-other" ? "rpc-other" : classification,
    block: blockReference(String(request.method), request.params),
  });
}
/** Where each method takes its block parameter. */
const BLOCK_PARAM: Readonly<Record<string, number>> = {
  eth_getBlockByNumber: 0,
  eth_call: 1,
  eth_getCode: 1,
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_estimateGas: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
};
/** Which block a request names, as a fixed label: a tag such as "latest", a
 * number, or an EIP-1898 hash pin. It says whether a provider refused pinned
 * or numbered state without logging the request itself. */
export function blockReference(
  method: string,
  params: unknown,
): RpcBlockReference | undefined {
  if (!Array.isArray(params) || !Object.hasOwn(BLOCK_PARAM, method))
    return undefined;
  const value = params[BLOCK_PARAM[method]];
  if (value && typeof value === "object" && "blockHash" in value) return "hash";
  if (typeof value !== "string") return undefined;
  return /^0x[0-9a-fA-F]+$/.test(value) ? "number" : "tag";
}

/** Same-operator transport recovery only. Successful replies still require
 * canonical agreement in rpc-consensus; no completed result is cached here.
 * With `defer`, releasing a reservation's unused capacity does not hold up
 * the reply: every fetch is still reserved before it starts, and the
 * capacity stays reserved until the deferred settlement lands. */
export function createAuthorizationUpstream({
  fetcher = (url: string, init: RequestInit) => fetch(url, init),
  budget,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  defer = undefined as ((settling: Promise<void>) => void) | undefined,
  maxAttempts = 3 as 1 | 3,
  observe,
}: {
  budget: RpcBudget;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  defer?: (settling: Promise<void>) => void;
  maxAttempts?: 1 | 3;
  observe?: (observation: AuthorizationRpcObservation) => Promise<void>;
}) {
  if (!budget) throw unavailable();
  const pending = new Map<string, Promise<AuthorizationRpcReply>>();
  const pendingBatches = new Map<string, Promise<AuthorizationRpcReply[]>>();
  const notify = async (observation: AuthorizationRpcObservation) => {
    try {
      await observe?.(observation);
    } catch {
      /* Observation cannot change a product answer. */
    }
  };
  const perform = async (
    url: string,
    body: string,
    calls: readonly AuthorizationRpcCall[],
    maxBytes: number,
    batch: boolean,
  ): Promise<AuthorizationRpcReply[]> => {
    const reservations: Awaited<ReturnType<RpcBudget["reserve"]>>[] = [];
    let observationId: string | undefined;
    try {
      for (const call of calls)
        reservations.push(await budget.reserve(url, call.method, true));
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        for (const reservation of reservations)
          await reservation.beforeAttempt();
        if (observe) {
          observationId = crypto.randomUUID();
          await notify({
            kind: "dispatch",
            requestId: observationId,
            url,
            at: new Date().toISOString(),
            transport: batch ? "batch" : "single",
            batch: calls.map((call, index) => ({
              jsonrpc: "2.0",
              id: index + 1,
              method: call.method,
              params: call.params,
            })),
          });
        }
        const response = await fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // workerd supports manual/follow only. Never send this request to a redirect target.
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok)
          for (const call of calls)
            reportRpcFailure({
              stage: "upstream-http",
              url,
              method: call.method,
              code: response.status,
              category:
                response.status === 429
                  ? "http-rate-limit"
                  : response.status >= 500
                    ? "http-server"
                    : response.status >= 300 && response.status < 400
                      ? "http-redirect"
                      : "http-other",
            });
        if (
          [429, 502, 503, 504].includes(response.status) &&
          attempt + 1 < maxAttempts
        ) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          await response.body?.cancel();
          if (
            response.status === 429 &&
            Number.isFinite(retryAfter) &&
            retryAfter > 2
          )
            throw new HttpError(
              429,
              "Independent chain verification is temporarily busy.",
              Math.min(3600, Math.ceil(retryAfter)),
            );
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(2000, Math.max(500, retryAfter * 1000))
              : (attempt + 1) * 500,
          );
          continue;
        }
        if (!response.ok) {
          // A provider can refuse a block with HTTP 400 and a JSON-RPC error
          // body (dRPC's "Unknown state"). Log which kind of refusal it was;
          // the request still fails.
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            const error = await rpcErrorBody(response);
            for (const call of calls) reportRejectedBlock(url, call, error);
          } else await response.body?.cancel();
          throw unavailable();
        }
        const reader = response.body?.getReader();
        if (!reader) throw unavailable();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reading = async () => {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw unavailable();
            }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (
            batch &&
            (!Array.isArray(decoded) || decoded.length !== calls.length)
          )
            throw unavailable();
          const values: unknown[] = batch ? (decoded as unknown[]) : [decoded];
          const replies: AuthorizationRpcReply[] = new Array(calls.length);
          for (const reply of values) {
            if (
              !reply ||
              typeof reply !== "object" ||
              Array.isArray(reply) ||
              !("jsonrpc" in reply) ||
              reply.jsonrpc !== "2.0" ||
              !("id" in reply) ||
              typeof reply.id !== "number" ||
              !Number.isSafeInteger(reply.id) ||
              reply.id < 1 ||
              reply.id > calls.length ||
              replies[reply.id - 1] !== undefined ||
              Object.hasOwn(reply, "result") === Object.hasOwn(reply, "error")
            )
              throw unavailable();
            if (
              batch &&
              "error" in reply &&
              (!reply.error ||
                typeof reply.error !== "object" ||
                Array.isArray(reply.error) ||
                !("code" in reply.error) ||
                !Number.isSafeInteger(reply.error.code))
            )
              throw unavailable();
            replies[reply.id - 1] = reply as AuthorizationRpcReply;
            if ("error" in reply)
              reportRejectedBlock(
                url,
                calls[reply.id - 1],
                (reply.error ?? {}) as { code?: unknown; message?: unknown },
              );
          }
          if (observationId)
            await notify({
              kind: "response",
              requestId: observationId,
              url,
              at: new Date().toISOString(),
              responses: values,
            });
          return replies;
        };
        try {
          return await Promise.race([
            reading(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                void reader.cancel();
                reject(unavailable());
              }, 8000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw unavailable();
    } catch (error) {
      if (observationId)
        await notify({ kind: "incomplete", requestId: observationId });
      if (!(error instanceof HttpError)) {
        const category = classifyRpcFailure(error);
        for (const call of calls)
          reportRpcFailure({
            stage: "upstream-transport",
            url,
            method: call.method,
            category:
              category === "wrapped-other" ? "transport-other" : category,
          });
      }
      if (error instanceof HttpError && error.status === 429) throw error;
      throw unavailable();
    } finally {
      const settlements = reservations.map((reservation) =>
        reservation.settle(),
      );
      if (defer) for (const settling of settlements) defer(settling);
      else await Promise.allSettled(settlements);
    }
  };
  const validMaxBytes = (maxBytes: number) =>
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= RPC_RESPONSE_MAX_BYTES &&
    maxBytes <= RPC_RESPONSE_MAX_BYTES_CEILING;
  const call = (
    url: string,
    method: string,
    params: unknown[] | Record<string, unknown>,
    { maxBytes = RPC_RESPONSE_MAX_BYTES }: { maxBytes?: number } = {},
  ): Promise<AuthorizationRpcReply> => {
    if (!validMaxBytes(maxBytes))
      return Promise.reject(new RangeError("maxBytes is out of range."));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const key = `${url}\n${maxBytes}\n${body}`;
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size + pendingBatches.size >= 64)
      return Promise.reject(unavailable());
    const promise = perform(url, body, [{ method, params }], maxBytes, false)
      .then(([reply]) => reply)
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  };
  const batch = (
    url: string,
    calls: readonly AuthorizationRpcCall[],
    { maxBytes = RPC_RESPONSE_MAX_BYTES }: { maxBytes?: number } = {},
  ): Promise<AuthorizationRpcReply[]> => {
    if (!validMaxBytes(maxBytes))
      return Promise.reject(new RangeError("maxBytes is out of range."));
    if (calls.length === 0) return Promise.resolve([]);
    const body = JSON.stringify(
      calls.map(({ method, params }, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method,
        params,
      })),
    );
    const key = `${url}\n${maxBytes}\n${body}`;
    const existing = pendingBatches.get(key);
    if (existing) return existing;
    if (pending.size + pendingBatches.size >= 64)
      return Promise.reject(unavailable());
    const promise = perform(url, body, calls, maxBytes, true).finally(() => {
      pendingBatches.delete(key);
    });
    pendingBatches.set(key, promise);
    return promise;
  };
  return Object.assign(call, { batch });
}
