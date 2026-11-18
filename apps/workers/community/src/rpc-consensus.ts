import { observedRpcFetch } from "./workspace-resource-observations";
import { createPublicClient, custom, toHex, type PublicClient } from "viem";
import { HttpError, SMART_WALLET_AUTH_CHAIN_ID, type Env } from "./common";
import type { ChatChainId } from "@templ/chat/chains";
import { authorizationEndpoints } from "./chain-rpc";

import { defer } from "./request-context";
import { requireRpcBudget } from "./rpc-budget";
import { createAuthorizationUpstream } from "./rpc-upstream";

type Block = {
  number: string;
  hash: string;
  stateRoot: string;
  timestamp: string;
};
const HEX = /^0x[0-9a-fA-F]+$/;
/** How long a provider that is behind gets to reach the other's head. */
export const CATCH_UP_MS = 300;

function canonical(value: unknown): string {
  if (typeof value === "string" && value.startsWith("0x"))
    return value.toLowerCase();
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return JSON.stringify(value);
}
function validBlock(value: unknown): value is Block {
  const b = value as Block | undefined;
  return Boolean(
    b &&
    typeof b.number === "string" &&
    HEX.test(b.number) &&
    /^0x[0-9a-fA-F]{64}$/.test(b.hash) &&
    /^0x[0-9a-fA-F]{64}$/.test(b.stateRoot) &&
    HEX.test(b.timestamp),
  );
}
/** The same block from two replies: number, hash, state root and time. */
function sameBlock(a: Block, b: Block) {
  return (
    a.number === b.number &&
    a.hash.toLowerCase() === b.hash.toLowerCase() &&
    a.stateRoot.toLowerCase() === b.stateRoot.toLowerCase() &&
    a.timestamp === b.timestamp
  );
}
type AuthorizationClient = PublicClient & {
  getVerifiedSnapshot: () => Promise<{
    blockNumber: bigint;
    timestamp: bigint;
    blockHash: `0x${string}`;
  }>;
};
/** Authorization reads use two independently operated providers at the same
 * finalized state. Every caller names its chain: /health reads the app's
 * sign-in chain, ERC-1271 the smart-wallet chain and the decoder its own. */
export function authorizationClient(
  env: Env,
  finality: "finalized" | "latest",
  chainId: ChatChainId,
  options?: {
    sleep?: (ms: number) => Promise<unknown>;
    /** The chain's two keyed providers, for a chain whose pair is not in
     * chain-rpc.ts (the widget's smart-wallet chains). */
    endpoints?: readonly [string, string];
  },
): AuthorizationClient;
export function authorizationClient(
  env: Env,
  finality: "finalized" | "latest" = "finalized",
  // Only an untyped caller can omit the chain; it gets the historical
  // smart-wallet chain, never the app's sign-in default.
  chainId: ChatChainId = SMART_WALLET_AUTH_CHAIN_ID,
  {
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    endpoints,
  }: {
    sleep?: (ms: number) => Promise<unknown>;
    endpoints?: readonly [string, string];
  } = {},
): AuthorizationClient {
  const providers = () => endpoints ?? authorizationEndpoints(env, chainId);
  const call = createAuthorizationUpstream({
    budget: requireRpcBudget(env),
    fetcher: (url, init) => observedRpcFetch(requireRpcBudget(env), url, init, (target, options) => fetch(target, options)),
    // Each fetch is reserved before it starts; returning the unused part of
    // that reservation runs after the reply instead of in front of it.
    defer: (settling) => defer(env, settling),
  });
  let pinned: Promise<Block> | undefined;
  let network: Promise<string> | undefined;
  const agree = async (method: string, params: unknown[]) => {
    const replies = await Promise.all(
      providers().map((url) =>
        call(url, method, params),
      ),
    );
    if (
      replies.some((reply) => reply.error) ||
      !replies.every((reply) => "result" in reply)
    )
      throw new HttpError(503, "Chain state cannot be verified.");
    if (canonical(replies[0].result) !== canonical(replies[1].result))
      throw new HttpError(503, "Chain providers disagree. Please try again.");
    return replies[0].result;
  };
  // The client is request-local. Every read still requires the independently
  // agreed chain, but getChainId() and the verified snapshot need not ask both
  // providers for the same immutable network identity twice.
  const verifiedNetwork = () =>
    (network ??= (async () => {
      const value = await agree("eth_chainId", []);
      if (value !== toHex(chainId))
        throw new HttpError(503, "Wrong community network.");
      return value as string;
    })());
  const unavailable = () =>
    new HttpError(503, "Finalized chain state is unavailable.");
  const disagree = () =>
    new HttpError(503, "Chain providers disagree. Please try again.");
  /** One provider's block at `number`, or undefined when it cannot serve
   * that number now. Capacity refusals stay 429s. */
  const blockAt = async (url: string, number: string) => {
    try {
      const reply = await call(url, "eth_getBlockByNumber", [number, false]);
      return validBlock(reply.result) ? reply.result : undefined;
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) throw error;
      return undefined;
    }
  };
  /** The block both providers agree on, given each one's head. */
  const agreedAnchor = async (
    urls: readonly string[],
    heads: readonly [Block, Block],
  ) => {
    // Both fresh provider replies can establish the snapshot themselves.
    if (sameBlock(heads[0], heads[1])) return heads[0];
    // Different heads: the lower head is already a validated reply from its
    // own provider, so only the other provider is asked for that number.
    const low = BigInt(heads[0].number) <= BigInt(heads[1].number) ? 0 : 1;
    const high = 1 - low;
    const atLow = await blockAt(urls[high], heads[low].number);
    if (atLow) {
      if (!sameBlock(heads[low], atLow)) throw disagree();
      return heads[low];
    }
    // The provider ahead cannot serve that number (a load-balanced node can
    // lack it, or answer "unknown state"). For current reads, anchor on its
    // head instead: the provider behind must return the same block for that
    // number, once more after a short wait if it has not reached it yet.
    // Finalized reads never do this, because only one provider would then
    // call the block final.
    if (finality !== "latest") throw unavailable();
    for (let attempt = 0; ; attempt++) {
      const atHigh = await blockAt(urls[low], heads[high].number);
      if (atHigh) {
        if (!sameBlock(heads[high], atHigh)) throw disagree();
        return heads[high];
      }
      if (attempt >= 1) throw unavailable();
      await sleep(CATCH_UP_MS);
    }
  };
  const finalized = () =>
    (pinned ??= (async () => {
      const urls = providers();
      // The chain identity and both heads are fetched together. The heads are
      // used only after both providers agree on the chain ID; a mismatch
      // discards them.
      const [network, heads] = await Promise.allSettled([
        verifiedNetwork(),
        Promise.all(
          urls.map((url) =>
            call(url, "eth_getBlockByNumber", [finality, false]),
          ),
        ),
      ]);
      if (network.status === "rejected") throw network.reason;
      if (heads.status === "rejected") throw heads.reason;
      const [first, second] = heads.value.map((head) => head.result);
      if (!validBlock(first) || !validBlock(second)) throw unavailable();
      const a = await agreedAnchor(urls, [first, second]);
      const age = BigInt(Math.floor(Date.now() / 1000)) - BigInt(a.timestamp);
      if (age < -30n || age > (finality === "latest" ? 90n : 3600n))
        throw new HttpError(
          503,
          "Chain verification is stale. Please try again.",
        );
      return a;
    })());
  const client = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") {
            return verifiedNetwork();
          }
          if (method === "eth_blockNumber") return (await finalized()).number;
          const args = Array.isArray(params) ? [...params] : [];
          if (
            [
              "eth_call",
              "eth_getCode",
              "eth_getBalance",
              "eth_getStorageAt",
              "eth_getTransactionCount",
              "eth_estimateGas",
            ].includes(method)
          ) {
            const blockIndex = method === "eth_getStorageAt" ? 2 : 1;
            if (
              args[blockIndex] === undefined ||
              ["latest", "pending", "safe", "finalized"].includes(
                String(args[blockIndex]),
              )
            )
              args[blockIndex] = (await finalized()).number;
            if (
              method !== "eth_estimateGas" &&
              typeof args[blockIndex] === "string"
            ) {
              const number = args[blockIndex] as string;
              const anchor = await finalized();
              let verifiedBlock = anchor;
              if (BigInt(number) !== BigInt(anchor.number)) {
                const replies = await Promise.all(
                  providers().map((url) =>
                    call(url, "eth_getBlockByNumber", [number, false]),
                  ),
                );
                if (!replies.every((r) => validBlock(r.result)))
                  throw new HttpError(503, "Chain block cannot be verified.");
                const a = replies[0].result as Block,
                  b = replies[1].result as Block;
                if (
                  a.hash.toLowerCase() !== b.hash.toLowerCase() ||
                  a.stateRoot.toLowerCase() !== b.stateRoot.toLowerCase() ||
                  BigInt(a.number) !== BigInt(number) ||
                  BigInt(b.number) !== BigInt(number)
                )
                  throw new HttpError(503, "Chain providers disagree.");
                verifiedBlock = a;
              }
              args[blockIndex] = {
                blockHash: verifiedBlock.hash,
                requireCanonical: true,
              };
            }
            if (method === "eth_estimateGas") {
              const replies = await Promise.all(
                providers().map((url) =>
                  call(url, method, args),
                ),
              );
              if (
                !replies.every(
                  (r) => typeof r.result === "string" && HEX.test(r.result),
                )
              )
                throw new HttpError(503, "Gas cannot be verified.");
              const values = replies.map((r) => BigInt(r.result as string));
              const low = values[0] < values[1] ? values[0] : values[1],
                high = values[0] > values[1] ? values[0] : values[1];
              if (low <= 0n || high > low * 2n)
                throw new HttpError(503, "Gas providers disagree.");
              return toHex(high);
            }
            return agree(method, args);
          }
          if (method === "eth_getBlockByNumber") {
            const tag = args[0];
            if (
              ["latest", "pending", "safe", "finalized"].includes(String(tag))
            )
              args[0] = (await finalized()).number;
            const results = await Promise.all(
              providers().map((url) =>
                call(url, method, args),
              ),
            );
            if (!results.every((r) => validBlock(r.result)))
              throw new HttpError(503, "Chain block cannot be verified.");
            const a = results[0].result as Block,
              b = results[1].result as Block;
            if (
              a.hash.toLowerCase() !== b.hash.toLowerCase() ||
              a.stateRoot.toLowerCase() !== b.stateRoot.toLowerCase()
            )
              throw new HttpError(
                503,
                "Chain providers disagree. Please try again.",
              );
            return results[0].result;
          }
          return agree(method, args);
        },
      },
      { retryCount: 0 },
    ),
  });
  return Object.assign(client, {
    getVerifiedSnapshot: async () => {
      const block = await finalized();
      return {
        blockNumber: BigInt(block.number),
        timestamp: BigInt(block.timestamp),
        blockHash: block.hash.toLowerCase() as `0x${string}`,
      };
    },
  });
}
