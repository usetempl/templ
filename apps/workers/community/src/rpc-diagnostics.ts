import { logVersionId, type VersionEnv } from "./ops-log";
/** Availability diagnostics contain fixed labels only, never RPC URLs, params,
 * provider messages, wallet data, cookies or signatures. */
export type RpcFailureCategory =
  | "http-rate-limit"
  | "http-server"
  | "http-redirect"
  | "http-other"
  | "rpc-rate-limit"
  | "header-unavailable"
  | "state-unavailable"
  | "execution-reverted"
  | "rpc-other"
  | "transport-timeout"
  | "transport-other"
  | "canonical-disagreement"
  | "stale-state"
  | "wrapped-other"
  | "different-request-context";
/** The block a failed request named: a tag, a number or an EIP-1898 hash. */
export type RpcBlockReference = "tag" | "number" | "hash";
const blockReferences = new Set<string>(["tag", "number", "hash"]);
const categories = new Set<string>([
  "http-rate-limit",
  "http-server",
  "http-redirect",
  "http-other",
  "rpc-rate-limit",
  "header-unavailable",
  "state-unavailable",
  "execution-reverted",
  "rpc-other",
  "transport-timeout",
  "transport-other",
  "canonical-disagreement",
  "stale-state",
  "wrapped-other",
  "different-request-context",
]);
const methods = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_call",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getProof",
  "eth_estimateGas",
  "eth_gasPrice",
]);
const stages = new Set([
  "upstream-http",
  "upstream-rpc",
  "upstream-transport",
  "community-request",
]);
const operatorsByHost: Readonly<Record<string, string>> = {
  "eth-mainnet.g.alchemy.com": "alchemy",
  "base-mainnet.g.alchemy.com": "alchemy",
  "bnb-mainnet.g.alchemy.com": "alchemy",
  "robinhood-mainnet.g.alchemy.com": "alchemy",
  "lb.drpc.live": "drpc",
};
export function classifyRpcFailure(error: unknown): RpcFailureCategory {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let i = 0;
    current && typeof current === "object" && i < 8 && !seen.has(current);
    i++
  ) {
    seen.add(current);
    const value = current as {
      name?: unknown;
      message?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    // Text is inspected only to select a constant label, never returned/logged.
    const text = [value.name, value.message, value.details]
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.slice(0, 4096))
      .join(" ");
    if (/different request|request context|request.*cancelled/i.test(text))
      return "different-request-context";
    if (/providers disagree|canonical.*mismatch/i.test(text))
      return "canonical-disagreement";
    if (/verification is stale/i.test(text)) return "stale-state";
    if (
      /rate.?limit|too many requests|request limit|quota exceeded/i.test(text)
    )
      return "rpc-rate-limit";
    if (
      /header not found|unknown block|block not found|cannot find block|block.*not available/i.test(
        text,
      )
    )
      return "header-unavailable";
    // dRPC answers "Unknown state. First available state is 1" when the node
    // it routes to does not hold the requested state.
    if (
      /missing trie|historical state|unknown state|state.*unavailable|state.*not available|state.*not found|pruned/i.test(
        text,
      )
    )
      return "state-unavailable";
    if (/execution reverted/i.test(text)) return "execution-reverted";
    if (/timeout|timed out|AbortError|aborted/i.test(text))
      return "transport-timeout";
    current = value.cause;
  }
  return "wrapped-other";
}
export function reportRpcFailure({
  stage,
  category,
  url,
  method,
  code,
  block,
  env,
}: {
  /** Callers that hold the worker env pass it, so the line carries the
   * deployed version id (`logVersionId`). */
  env?: VersionEnv;
  stage: string;
  category: RpcFailureCategory;
  url?: string;
  method?: string;
  code?: unknown;
  block?: RpcBlockReference;
}) {
  let operator = "unknown";
  try {
    const host = new URL(url ?? "").hostname;
    operator = Object.hasOwn(operatorsByHost, host)
      ? operatorsByHost[host]
      : "unknown";
  } catch {
    /* Unknown transport has no operator attribution. */
  }
  const safeCode =
    typeof code === "number" &&
    Number.isSafeInteger(code) &&
    Math.abs(code) <= 2 ** 31
      ? code
      : undefined;
  console.error(
    "TEMPL_RPC_FAILURE",
    JSON.stringify({
      schemaVersion: 1,
      ...(env ? { versionId: logVersionId(env) } : {}),
      stage: stages.has(stage) ? stage : "community-request",
      category: categories.has(category) ? category : "wrapped-other",
      operator,
      method: methods.has(method ?? "") ? method : "other",
      ...(safeCode === undefined ? {} : { code: safeCode }),
      ...(block && blockReferences.has(block) ? { block } : {}),
    }),
  );
}
