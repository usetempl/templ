import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex as ViemHex,
} from "viem";
import { isChatChainId, type ChatChainId } from "@templ/chat/chains";
import type { EvmTxView } from "@templ/chat/diagnosis/evm-normalize";
import type {
  AbiParameterFact,
  AgreedBlock,
  EvmAbiErrorItem,
  EvmMethodFact,
  Hex,
  VerifiedAbiSource,
} from "@templ/chat/diagnosis/types";
import type { DecodedCall } from "@templ/chat/transaction-decoding";
import type { Env } from "../common";
import { builtinFunctions } from "../transaction-abis";
import {
  abiCatalogCache,
  abiCacheKey,
  decodeTransactionCalls,
  lookupVerifiedAbi,
  type AbiCache,
  type DecoderClient,
} from "../transaction-decoder";
import { chatMulticallAbi } from "../chat-multicall";
import { agreedValue } from "./agree";
import type { DiagnosisChain } from "./chains";
import { MULTICALL3, type DiagnosisRpc } from "./rpc";

/** The kept decoder core, adapted for transaction checks: calls are decoded
 * offline first (reviewed builtin ABIs), then with one verified lookup; the
 * decoder reads the chain only through this run's two-provider client,
 * pinned to one agreed block. No Safe, settlement or product-payment group
 * exists in the builtin set. */

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ARG_CHARS = 200;
const pinned = (block: AgreedBlock) => ({
  blockHash: block.hash,
  requireCanonical: true,
});

/** A DecoderClient over the diagnosis rpc: the table's chain id, the pinned
 * block number, and code and Multicall3 reads at that block's hash with
 * two-provider agreement. Any disagreement throws, which the decoder reads
 * as "unavailable". */
export function pinnedDecoderClient(
  rpc: DiagnosisRpc,
  chainId: number,
  block: AgreedBlock,
): DecoderClient {
  return {
    getChainId: async () => chainId,
    getVerifiedSnapshot: async () => ({ blockNumber: BigInt(block.number) }),
    async getCode({ address }) {
      const read = agreedValue(
        await rpc.both("eth_getCode", [address.toLowerCase(), pinned(block)]),
        (raw) => {
          if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw))
            throw new Error("code");
          return raw.toLowerCase() as ViemHex;
        },
      );
      if (read.kind !== "agreed") throw new Error(read.reason);
      return read.value;
    },
    async readContract({ address, args }) {
      if (address.toLowerCase() !== MULTICALL3) throw new Error("target");
      const data = encodeFunctionData({
        abi: chatMulticallAbi,
        functionName: "aggregate3",
        args,
      });
      const read = agreedValue(
        await rpc.both("eth_call", [{ to: MULTICALL3, data }, pinned(block)]),
        (raw) => {
          if (typeof raw !== "string") throw new Error("result");
          return raw.toLowerCase();
        },
      );
      if (read.kind !== "agreed") throw new Error(read.reason);
      return decodeFunctionResult({
        abi: chatMulticallAbi,
        functionName: "aggregate3",
        data: read.value as ViemHex,
      });
    },
  };
}

const cut = (value: string) =>
  value.length > ARG_CHARS ? value.slice(0, ARG_CHARS) : value;
const safeName = (value: string | null | undefined) =>
  typeof value === "string" && NAME.test(value) ? value : null;

/** The builtin group a selector decodes under, first match wins. */
function builtinGroup(selector: Hex | null, data: Hex): EvmMethodFact["group"] {
  if (!selector) return null;
  // The decoder's own order: the first builtin whose function decodes.
  for (const entry of builtinFunctions(selector as ViemHex)) {
    try {
      decodeFunctionData({ abi: [entry.fn], data: data as ViemHex });
      return entry.group;
    } catch {
      continue;
    }
  }
  return null;
}

/** A DecodedCall as the engine's method fact. */
export function methodFactFromDecodedCall(
  call: DecodedCall,
  data: Hex,
  abiSource: VerifiedAbiSource | null,
): EvmMethodFact {
  const selector = (call.selector?.toLowerCase() as Hex | null) ?? null;
  const verified = call.call?.source === "verified";
  const group: EvmMethodFact["group"] = call.call
    ? verified
      ? "verified"
      : builtinGroup(selector, data)
    : null;
  return {
    selector,
    name: safeName(call.call?.name),
    source: call.call ? (verified ? abiSource : "builtin") : null,
    group,
    args: (call.call?.args ?? []).slice(0, 16).map((arg) => ({
      name: cut(arg.name),
      type: cut(arg.type),
      value: cut(arg.value),
    })),
    routerCommands:
      group === "universal-router"
        ? call.nested
            .map((item) => safeName(item.call?.name))
            .filter((name): name is string => name !== null)
            .slice(0, 32)
        : [],
    nested:
      group === "universal-router"
        ? []
        : call.nested.slice(0, 32).map((item) => ({
            to: item.to.toLowerCase() as Hex,
            name: safeName(item.call?.name),
          })),
  };
}

export type DecodeDeps = {
  fetcher?: typeof fetch;
  abiCache?: AbiCache;
  now?: () => number;
};

/** The method a transaction called, decoded without reading any target
 * (tokens come from their own read). Null for a contract creation, input
 * under 4 bytes, or a chain outside the decoder's label and lookup table
 * (1, 8453, 56, 4663): its labels would name another chain's contracts. */
export async function methodFactFor(
  env: Env,
  input: {
    chain: DiagnosisChain;
    rpc: DiagnosisRpc;
    tx: EvmTxView;
    block: AgreedBlock;
  },
  deps: DecodeDeps = {},
): Promise<EvmMethodFact | null> {
  const { chain, rpc, tx, block } = input;
  if (!tx.to || (tx.input.length - 2) / 2 < 4) return null;
  if (!isChatChainId(chain.id)) return null;
  const chainId: ChatChainId = chain.id;
  const abiCache = deps.abiCache ?? abiCatalogCache(env);
  const decoded = await decodeTransactionCalls(
    env,
    chainId,
    [
      {
        to: getAddress(tx.to) as Address,
        data: tx.input,
        value: BigInt(tx.value).toString(),
      },
    ],
    {
      client: pinnedDecoderClient(rpc, chainId, block),
      abiCache,
      fetcher: deps.fetcher,
      now: deps.now,
      budget: { targets: 0, lookups: 1, nested: 32 },
    },
  );
  const call = decoded.calls[0];
  if (!call) return null;
  let source: VerifiedAbiSource | null = null;
  if (call.call?.source === "verified") {
    const entry = await abiCache
      .get(abiCacheKey(chainId, tx.to))
      .catch(() => null);
    source = entry?.source ?? null;
  }
  return methodFactFromDecodedCall(call, tx.input, source);
}

const toParameterFact = (value: {
  name?: string;
  type: string;
  components?: readonly unknown[];
}): AbiParameterFact => ({
  name: value.name ?? "",
  type: value.type,
  ...(value.components
    ? {
        components: value.components.map((item) =>
          toParameterFact(item as { name?: string; type: string }),
        ),
      }
    : {}),
});

/** Verified error items for tx.to, from the catalog. A cached row from
 * before error items is fetched again once. Null on a miss, an unavailable
 * lookup, or a chain outside the decoder's lookup table. */
export async function errorAbiFor(
  env: Env,
  input: { chain: DiagnosisChain; to: Hex },
  deps: DecodeDeps = {},
): Promise<{ source: VerifiedAbiSource; items: EvmAbiErrorItem[] } | null> {
  if (!isChatChainId(input.chain.id)) return null;
  const chainId = input.chain.id;
  const cache = deps.abiCache ?? abiCatalogCache(env);
  const now = deps.now?.() ?? Date.now();
  try {
    let entry = await lookupVerifiedAbi(env, chainId, getAddress(input.to), {
      fetcher: deps.fetcher,
      abiCache: cache,
      now,
    });
    if (entry.abi && entry.errors === undefined)
      entry = await lookupVerifiedAbi(env, chainId, getAddress(input.to), {
        fetcher: deps.fetcher,
        // Skip the stale row; the fresh answer is written back.
        abiCache: {
          get: async () => null,
          put: (key, value) => cache.put(key, value),
        },
        now,
      });
    if (!entry.source || !entry.errors?.length) return null;
    return {
      source: entry.source,
      items: entry.errors.map((item) => ({
        type: "error" as const,
        name: item.name,
        inputs: item.inputs.map((parameter) =>
          toParameterFact(parameter as { name?: string; type: string }),
        ),
      })),
    };
  } catch {
    return null;
  }
}
