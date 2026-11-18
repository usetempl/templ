import { isAddress, toHex } from "viem";
import { HttpError } from "./common";
import { requireRpcBudget } from "./rpc-budget";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
export type PaymentFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type PaymentReceipt = {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  status: string;
  from: string;
  to: string | null;
  logs: { address: string; topics: string[]; data: string; logIndex: string }[];
};
export type PaymentBlock = { number: string; hash: string; timestamp: string };
export const PAYMENT_RPC_RETRY_AFTER_MAX_SECONDS = 300;
export function paymentRpcResponseError(
  response: Response,
  now = Date.now(),
): HttpError {
  if (response.status !== 429)
    return new HttpError(503, "Payment verification is unavailable.");
  const value = response.headers.get("Retry-After")?.trim();
  let seconds = 60;
  if (value && /^\d+$/.test(value)) {
    seconds = Number(value);
  } else if (value && /[a-z]/i.test(value)) {
    const deadline = Date.parse(value);
    if (Number.isFinite(deadline)) seconds = Math.ceil((deadline - now) / 1000);
  }
  return new HttpError(
    429,
    "Payment verification is unavailable.",
    Math.min(PAYMENT_RPC_RETRY_AFTER_MAX_SECONDS, Math.max(1, seconds)),
  );
}
export function rpcQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !QUANTITY.test(value))
    throw new HttpError(503, "Chain state cannot be verified.");
  return BigInt(value);
}
export function paymentReceiptTime(value: unknown): number | undefined {
  const timestamp = (value as { blockTimestamp?: unknown } | null)
    ?.blockTimestamp;
  if (timestamp === undefined) return undefined;
  const paidAt = Number(rpcQuantity(timestamp)) * 1000;
  if (!Number.isSafeInteger(paidAt))
    throw new HttpError(503, "Payment receipt cannot be verified.");
  return paidAt;
}
export function normalizeReceipt(value: unknown): PaymentReceipt | null {
  if (value === null) return null;
  const row = value as PaymentReceipt;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    !HASH.test(row.transactionHash) ||
    !HASH.test(row.blockHash) ||
    !QUANTITY.test(row.blockNumber) ||
    !["0x0", "0x1"].includes(row.status) ||
    !isAddress(row.from) ||
    (row.to !== null && !isAddress(row.to)) ||
    !Array.isArray(row.logs) ||
    row.logs.length > 64
  )
    throw new HttpError(503, "Payment receipt cannot be verified.");
  let bytes = 0;
  return {
    transactionHash: row.transactionHash.toLowerCase(),
    blockHash: row.blockHash.toLowerCase(),
    blockNumber: toHex(rpcQuantity(row.blockNumber)),
    status: row.status,
    from: row.from.toLowerCase(),
    to: row.to?.toLowerCase() ?? null,
    logs: row.logs.map((log) => {
      if (
        !log ||
        !isAddress(log.address) ||
        !Array.isArray(log.topics) ||
        log.topics.length > 4 ||
        !log.topics.every(
          (topic) => typeof topic === "string" && HASH.test(topic),
        ) ||
        typeof log.data !== "string" ||
        log.data.length > 8194 ||
        !DATA.test(log.data) ||
        !QUANTITY.test(log.logIndex)
      )
        throw new HttpError(503, "Payment receipt cannot be verified.");
      bytes += (log.data.length - 2) / 2 + log.topics.length * 32;
      if (bytes > 65_536)
        throw new HttpError(503, "Payment receipt cannot be verified.");
      return {
        address: log.address.toLowerCase(),
        topics: log.topics.map((x) => x.toLowerCase()),
        data: log.data.toLowerCase(),
        logIndex: toHex(rpcQuantity(log.logIndex)),
      };
    }),
  };
}
export function block(value: unknown): PaymentBlock {
  const row = value as PaymentBlock;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    !QUANTITY.test(row.number) ||
    !HASH.test(row.hash) ||
    !QUANTITY.test(row.timestamp)
  )
    throw new HttpError(503, "Finalized chain state is unavailable.");
  return {
    number: toHex(rpcQuantity(row.number)),
    hash: row.hash.toLowerCase(),
    timestamp: toHex(rpcQuantity(row.timestamp)),
  };
}
/** Payments make one transport attempt. Alarms provide spaced recovery; a
 * transport retry would spend the network budget without advancing finality. */
export async function paymentRpc(
  env: object,
  url: string,
  method: string,
  params: unknown[],
  fetcher: PaymentFetcher = fetch,
): Promise<unknown> {
  const reservation = await requireRpcBudget(env).reserve(url, method, true);
  try {
    await reservation.beforeAttempt();
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw paymentRpcResponseError(response);
    const reader = response.body?.getReader();
    if (!reader)
      throw new HttpError(503, "Payment verification is unavailable.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const row = await reader.read();
        if (row.done) break;
        length += row.value.byteLength;
        if (length > 1_048_576) {
          await reader.cancel();
          throw new HttpError(503, "Payment verification is unavailable.");
        }
        chunks.push(row.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes)) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (
      !result ||
      result.jsonrpc !== "2.0" ||
      result.id !== 1 ||
      !Object.hasOwn(result, "result") ||
      Object.hasOwn(result, "error")
    )
      throw new HttpError(503, "Payment verification is unavailable.");
    return result.result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Payment verification is unavailable.");
  } finally {
    await reservation.settle();
  }
}
