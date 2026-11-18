import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toFunctionSignature,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { getChatChain, type ChatChainId } from "@templ/chat/chains";
import type {
  DecodedArg,
  DecodedCall,
  DecodedTransaction,
  TransactionCall,
  TransactionFlag,
} from "@templ/chat/transaction-decoding";
import { isUnlimitedAllowance } from "@templ/chat/transaction-decoding";
import {
  CHAT_MULTICALL,
  CHAT_MULTICALL_CODE_HASH,
  chatMulticallAbi,
} from "./chat-multicall";
import { authorizationEndpoints } from "./chain-rpc";
import { HttpError, json, STORAGE_SCOPE_CHAIN_ID, type Env } from "./common";
import { readCapped } from "./bounded-read";
import { requireRpcBudget } from "./rpc-budget";
import { authorizationClient } from "./rpc-consensus";
import {
  builtinFunctions,
  knownAddress,
  UNIVERSAL_ROUTER_COMMAND_MASK,
  UNIVERSAL_ROUTER_COMMANDS,
  type BuiltinAbiGroup,
} from "./transaction-abis";

/** A read-only decoder for EVM calls: what a list of calls does, read by the
 * worker. Kept for ticket diagnosis; no route in this release calls it.
 *
 * Three layers, each adding to the one before and none able to hide a
 * failure behind a wrong answer. The structural layer needs no network: the
 * target, the value, the selector. The target layer reads the network's two
 * reviewed providers at one verified block (code, then symbol, decimals and
 * name in one Multicall3 aggregate) and charges the room's RPC budget; when
 * it fails the answer says `unavailable` and keeps what the first layer knew.
 * The ABI layer matches the builtin ABIs by selector and, for anything else,
 * asks the verified-source services (Sourcify, the Robinhood Blockscout,
 * Etherscan with a key) under a timeout and a size cap, remembering the
 * answer for a day and a miss for an hour in a service-wide catalog object.
 * Multicall3 items, account wrappers and Universal Router commands decode
 * one level deep. Flags come from decoded values only. Nothing here signs or
 * sends. */
const MAX_TEXT_CHARS = 120;
/** Untrusted text from a contract: printable, short. */
function displayText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? Array.from(text).slice(0, MAX_TEXT_CHARS).join("") : null;
}
export const ABI_CACHE_MS = 24 * 60 * 60_000;
export const ABI_MISS_CACHE_MS = 60 * 60_000;
export const ABI_FETCH_TIMEOUT_MS = 8_000;
export const ABI_FETCH_MAX_BYTES = 512 * 1024;
/** Function items kept per verified ABI. */
export const ABI_FUNCTIONS_MAX = 256;
export const ABI_ERRORS_MAX = 256;
export const ABI_CATALOG_SCOPE = `${STORAGE_SCOPE_CHAIN_ID}:abi-catalog:v1`;
export const ABI_CATALOG_PREFIX = "abi-catalog-v1:";
export const ABI_CATALOG_INDEX_KEY = "abi-catalog-index-v1";
export const ABI_CATALOG_ROWS_MAX = 2_048;
const ABI_ENTRY_MAX_CHARS = 100_000;
export const SOURCIFY_BASE = "https://sourcify.dev/server/v2/contract";
export const BLOCKSCOUT_BASES: Partial<Record<ChatChainId, string>> = {
  4663: "https://robinhoodchain.blockscout.com/api/v2/smart-contracts",
};
export const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";
/** Chains the Etherscan v2 API answers for. */
export const ETHERSCAN_CHAINS: readonly ChatChainId[] = [1, 8453, 56];
/** Distinct addresses whose facts one decode reads, and nested items shown. */
export const DECODE_TARGETS_MAX = 16;
export const DECODE_NESTED_MAX = 32;
export const DECODE_LOOKUPS_MAX = 16;
const BYTES_DISPLAY_CHARS = 66;
const STRING_DISPLAY_CHARS = 200;
const SYMBOL_CHARS = 32;

export type AbiSource = "sourcify" | "blockscout" | "etherscan";
export type AbiCacheEntry = {
  /** Function items only; null records a verified-source miss. */
  abi: AbiFunction[] | null;
  source: AbiSource | null;
  checkedAt: number;
  /** Custom error items from the same source, for transaction checks. null
   * means the source had none; absent means the row predates error items. */
  errors?: AbiErrorItem[] | null;
};
/** A verified custom error item: name and inputs only. */
export type AbiErrorItem = {
  type: "error";
  name: string;
  inputs: AbiParameter[];
};
export type AbiCache = {
  get(key: string): Promise<AbiCacheEntry | null>;
  put(key: string, entry: AbiCacheEntry): Promise<void>;
};
export const abiCacheKey = (chainId: ChatChainId, address: string) =>
  `abi:${chainId}:${address.toLowerCase()}`;
/** The subset of the authorization client the decoder reads through. */
export type DecoderClient = {
  getChainId: () => Promise<number>;
  getVerifiedSnapshot: () => Promise<{ blockNumber: bigint }>;
  getCode: (args: {
    address: Address;
    blockNumber?: bigint;
  }) => Promise<Hex | undefined>;
  readContract: (args: {
    address: Address;
    abi: typeof chatMulticallAbi;
    functionName: "aggregate3";
    args: readonly [
      readonly { target: Address; allowFailure: boolean; callData: Hex }[],
    ];
    blockNumber?: bigint;
  }) => Promise<unknown>;
};
export type DecodeOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
  abiCache?: AbiCache;
  client?: DecoderClient;
  /** Reviewed labels for this chain, lowercase address to label. */
  labels?: Record<string, string>;
  budget?: { targets?: number; lookups?: number; nested?: number };
};
export type TargetFacts = {
  contract: boolean;
  symbol: string | null;
  decimals: number | null;
  name: string | null;
};
type Facts = Map<string, TargetFacts>;
type Result = { success: boolean; returnData: Hex };
type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
type Decoded = {
  group: BuiltinAbiGroup | "verified";
  fn: AbiFunction;
  args: readonly unknown[];
};
/** A call while the layers fill it in. */
type Working = {
  index: number;
  to: Address;
  value: string;
  data: Hex;
  selector: Hex | null;
  decoded: Decoded | null;
  depth: 0 | 1;
  nested: Working[];
  /** A verified ABI exists for the target, whether or not it holds this selector. */
  abiFound: boolean;
  lookupFailed: boolean;
};

const erc20Reads = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
]);
const lower = (value: string) => value.toLowerCase();
const isHexData = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const stripControl = (value: string) =>
  value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();

/* ---------------------------------------------------------------------- */
/* Layer 1: structure and builtin decoding                                  */
/* ---------------------------------------------------------------------- */

function selectorOf(data: Hex): Hex | null {
  return data.length >= 10 ? (lower(data.slice(0, 10)) as Hex) : null;
}
/** Tries every builtin function under the selector in group order. */
function decodeBuiltin(data: Hex): Decoded | null {
  const selector = selectorOf(data);
  if (!selector) return null;
  for (const entry of builtinFunctions(selector)) {
    const decoded = decodeWith(entry.fn, entry.group, data);
    if (decoded) return decoded;
  }
  return null;
}
function decodeWith(
  fn: AbiFunction,
  group: Decoded["group"],
  data: Hex,
): Decoded | null {
  try {
    const result = decodeFunctionData({ abi: [fn], data });
    return { group, fn, args: (result.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}
const asAddress = (value: unknown): Address | null =>
  typeof value === "string" && isAddress(value, { strict: false })
    ? getAddress(value)
    : null;
const asBigint = (value: unknown): bigint | null =>
  typeof value === "bigint" ? value : null;
/** Inner calls a decoded bundle carries: Multicall3 items and account
 * wrappers. Universal Router commands are handled apart. */
function innerCalls(
  decoded: Decoded,
  nestedMax: number,
): { to: Address; value: string; data: Hex }[] {
  const { group, fn, args } = decoded;
  const item = (to: unknown, value: unknown, data: unknown) => {
    const address = asAddress(to);
    if (!address || !isHexData(data)) return null;
    return {
      to: address,
      value: (asBigint(value) ?? 0n).toString(),
      data: lower(data) as Hex,
    };
  };
  const list: ({ to: Address; value: string; data: Hex } | null)[] = [];
  if (group === "multicall3") {
    const calls = (fn.name === "tryAggregate" ? args[1] : args[0]) as
      | readonly Record<string, unknown>[]
      | undefined;
    for (const call of Array.isArray(calls) ? calls : [])
      list.push(item(call.target, call.value, call.callData));
  } else if (group === "wrapper") list.push(item(args[0], args[1], args[2]));
  return list
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .slice(0, nestedMax);
}
function working(
  call: { to: Address; value: string; data: Hex },
  index: number,
  depth: 0 | 1,
  nestedMax: number,
): Working {
  const data = lower(call.data) as Hex;
  const decoded = data === "0x" ? null : decodeBuiltin(data);
  const entry: Working = {
    index,
    to: getAddress(call.to),
    value: call.value,
    data,
    selector: selectorOf(data),
    decoded,
    depth,
    nested: [],
    abiFound: false,
    lookupFailed: false,
  };
  if (decoded && depth === 0)
    entry.nested = innerCalls(decoded, nestedMax).map((inner, i) =>
      working(inner, i, 1, nestedMax),
    );
  return entry;
}
const flatten = (calls: Working[]): Working[] =>
  calls.flatMap((call) => [call, ...call.nested]);

/* ---------------------------------------------------------------------- */
/* Layer 2: target facts through the two reviewed providers                 */
/* ---------------------------------------------------------------------- */

const decodeRead = (
  result: Result | undefined,
  functionName: "symbol" | "decimals" | "name",
): unknown => {
  if (!result?.success || result.returnData === "0x") return null;
  try {
    return decodeFunctionResult({
      abi: erc20Reads,
      functionName,
      data: result.returnData,
    });
  } catch {
    return null;
  }
};
/** Reads code for every address and symbol, decimals and name for each
 * contract in one aggregate. Throws on any provider problem; the caller turns
 * that into `unavailable`.
 *
 * @public Ticket diagnosis reads it.
 */
export async function readTargetFacts(
  env: Env,
  chainId: ChatChainId,
  addresses: readonly Address[],
  client?: DecoderClient,
): Promise<{ block: string; facts: Facts }> {
  if (!client) authorizationEndpoints(env, chainId);
  const budget = requireRpcBudget(env);
  budget.setHolding(true);
  try {
    const chain: DecoderClient =
      client ?? (authorizationClient(env, "latest", chainId) as DecoderClient);
    if ((await chain.getChainId()) !== chainId)
      throw new HttpError(503, "Wrong network.");
    const block = await chain.getVerifiedSnapshot();
    const at = { blockNumber: block.blockNumber };
    const facts: Facts = new Map();
    if (!addresses.length)
      return { block: block.blockNumber.toString(), facts };
    const multicall = await chain.getCode({ address: CHAT_MULTICALL, ...at });
    if (!multicall || keccak256(multicall) !== CHAT_MULTICALL_CODE_HASH)
      throw new HttpError(503, "Chain state couldn't be verified.");
    const codes = await Promise.all(
      addresses.map((address) => chain.getCode({ address, ...at })),
    );
    const contracts: Address[] = [];
    addresses.forEach((address, index) => {
      const code = codes[index];
      const contract = Boolean(code && code !== "0x");
      facts.set(lower(address), {
        contract,
        symbol: null,
        decimals: null,
        name: null,
      });
      if (contract) contracts.push(address);
    });
    if (contracts.length) {
      const reads = ["symbol", "decimals", "name"] as const;
      const calls = contracts.flatMap((target) =>
        reads.map((functionName) => ({
          target,
          allowFailure: true,
          callData: encodeFunctionData({ abi: erc20Reads, functionName }),
        })),
      );
      const rows = (await chain.readContract({
        address: CHAT_MULTICALL,
        abi: chatMulticallAbi,
        functionName: "aggregate3",
        args: [calls],
        ...at,
      })) as readonly Result[];
      if (!Array.isArray(rows) || rows.length !== calls.length)
        throw new HttpError(503, "Chain state couldn't be verified.");
      contracts.forEach((target, index) => {
        const symbol = decodeRead(rows[index * 3], "symbol");
        const decimals = decodeRead(rows[index * 3 + 1], "decimals");
        const name = decodeRead(rows[index * 3 + 2], "name");
        const entry = facts.get(lower(target))!;
        entry.symbol =
          typeof symbol === "string"
            ? (displayText(symbol)?.slice(0, SYMBOL_CHARS) ?? null)
            : null;
        entry.decimals =
          typeof decimals === "number" && decimals >= 0 && decimals <= 77
            ? decimals
            : null;
        entry.name = typeof name === "string" ? displayText(name) : null;
      });
    }
    return { block: block.blockNumber.toString(), facts };
  } finally {
    budget.setHolding(false);
  }
}

/* ---------------------------------------------------------------------- */
/* Layer 3: verified ABIs                                                   */
/* ---------------------------------------------------------------------- */

class LookupUnavailable extends Error {}
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TYPE = /^[a-z0-9]{1,32}(?:\[[0-9]*\]){0,3}$/;
function abiParameter(value: unknown, depth: number): AbiParameter | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== "string" || !TYPE.test(raw.type)) return null;
  const name =
    typeof raw.name === "string" && (raw.name === "" || NAME.test(raw.name))
      ? raw.name
      : "";
  if (raw.type.startsWith("tuple")) {
    if (!Array.isArray(raw.components) || raw.components.length > 64)
      return null;
    const components = raw.components.map((component) =>
      abiParameter(component, depth + 1),
    );
    if (components.some((component) => component === null)) return null;
    return {
      name,
      type: raw.type,
      components: components as AbiParameter[],
    } as AbiParameter;
  }
  return { name, type: raw.type };
}
/** Keeps a function item's name, inputs and mutability; drops the rest.
 *
 * @public Ticket diagnosis reads it.
 */
export function abiFunctionItem(value: unknown): AbiFunction | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "function") return null;
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) return null;
  if (!Array.isArray(raw.inputs) || raw.inputs.length > 64) return null;
  const inputs = raw.inputs.map((input) => abiParameter(input, 0));
  if (inputs.some((input) => input === null)) return null;
  const mutability = ["pure", "view", "nonpayable", "payable"].includes(
    String(raw.stateMutability),
  )
    ? (raw.stateMutability as AbiFunction["stateMutability"])
    : "nonpayable";
  return {
    type: "function",
    name: raw.name,
    inputs: inputs as AbiParameter[],
    outputs: [],
    stateMutability: mutability,
  };
}
/** Keeps a custom error item's name and inputs; drops everything else. */
export function abiErrorItem(value: unknown): AbiErrorItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "error") return null;
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) return null;
  if (!Array.isArray(raw.inputs) || raw.inputs.length > 64) return null;
  const inputs = raw.inputs.map((input) => abiParameter(input, 0));
  if (inputs.some((input) => input === null)) return null;
  return { type: "error", name: raw.name, inputs: inputs as AbiParameter[] };
}
/** Error items of an ABI, at most ABI_ERRORS_MAX; null when there are none. */
export function abiErrorItems(value: unknown): AbiErrorItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map(abiErrorItem)
    .filter((item): item is AbiErrorItem => item !== null);
  return items.length ? items.slice(0, ABI_ERRORS_MAX) : null;
}
/** @public Ticket diagnosis reads it. */
export function abiFunctions(value: unknown): AbiFunction[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map(abiFunctionItem)
    .filter((item): item is AbiFunction => item !== null);
  return items.length ? items.slice(0, ABI_FUNCTIONS_MAX) : null;
}
/** One hosted GET: 8 s, 512 KiB, no redirects. A transport failure or an
 * unexpected status throws LookupUnavailable; 404 answers null. */
async function fetchJson(
  fetcher: typeof fetch,
  url: string,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABI_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      throw new LookupUnavailable();
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new LookupUnavailable();
    }
    const bytes = await readCapped(response, ABI_FETCH_MAX_BYTES);
    if (!bytes) throw new LookupUnavailable();
    try {
      return {
        status: 200,
        body: JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown,
      };
    } catch {
      throw new LookupUnavailable();
    }
  } finally {
    clearTimeout(timer);
  }
}
type Lookup = {
  abi: AbiFunction[] | null;
  source: AbiSource | null;
  errors?: AbiErrorItem[] | null;
};
const found = (abi: unknown, source: AbiSource): Lookup => {
  const functions = abiFunctions(abi);
  return functions
    ? { abi: functions, source, errors: abiErrorItems(abi) }
    : { abi: null, source: null };
};
let etherscanPlanLogged = false;
async function sourcify(
  fetcher: typeof fetch,
  chainId: ChatChainId,
  address: Address,
): Promise<Lookup> {
  const answer = await fetchJson(
    fetcher,
    `${SOURCIFY_BASE}/${chainId}/${address}?fields=abi`,
  );
  const body = answer?.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object") return { abi: null, source: null };
  if (body.match !== "exact_match" && body.match !== "match")
    return { abi: null, source: null };
  return found(body.abi, "sourcify");
}
async function blockscout(
  fetcher: typeof fetch,
  chainId: ChatChainId,
  address: Address,
): Promise<Lookup | undefined> {
  const base = BLOCKSCOUT_BASES[chainId];
  if (!base) return undefined;
  const answer = await fetchJson(fetcher, `${base}/${address}`);
  const body = answer?.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object" || body.is_verified !== true)
    return { abi: null, source: null };
  return found(body.abi, "blockscout");
}
async function etherscan(
  env: Env,
  fetcher: typeof fetch,
  chainId: ChatChainId,
  address: Address,
): Promise<Lookup | undefined> {
  const key = env.ETHERSCAN_API_KEY;
  if (!key || !ETHERSCAN_CHAINS.includes(chainId)) return undefined;
  const query = new URLSearchParams({
    chainid: String(chainId),
    module: "contract",
    action: "getabi",
    address,
    apikey: key,
  });
  const answer = await fetchJson(fetcher, `${ETHERSCAN_V2_BASE}?${query}`);
  const body = answer?.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object") return { abi: null, source: null };
  if (body.status === "1" && typeof body.result === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.result);
    } catch {
      return { abi: null, source: null };
    }
    return found(parsed, "etherscan");
  }
  if (typeof body.result === "string" && /not verified/i.test(body.result))
    return { abi: null, source: null };
  // A free key that doesn't cover this chain is "no source here", not an
  // outage: the lookup goes on without Etherscan.
  if (
    body.status === "0" &&
    [body.result, body.message].some(
      (text) =>
        typeof text === "string" &&
        /not supported|upgrade|plan|access/i.test(text),
    )
  ) {
    if (!etherscanPlanLogged) {
      etherscanPlanLogged = true;
      console.warn(
        "TEMPL_DIAGNOSIS_ABI",
        JSON.stringify({
          source: "etherscan",
          chain: chainId,
          problem: "plan",
        }),
      );
    }
    return undefined;
  }
  // Anything else (a rate limit, a key problem) is not an answer about the contract.
  throw new LookupUnavailable();
}
/** The verified ABI for an address: the cache first, then Sourcify, then the
 * chain's Blockscout, then Etherscan with a key. Throws LookupUnavailable
 * when no source could answer; a definite miss is cached for an hour.
 *
 * @public Ticket diagnosis reads it.
 */
export async function lookupVerifiedAbi(
  env: Env,
  chainId: ChatChainId,
  address: Address,
  options: { fetcher?: typeof fetch; abiCache?: AbiCache; now?: number } = {},
): Promise<AbiCacheEntry> {
  const now = options.now ?? Date.now();
  const key = abiCacheKey(chainId, address);
  const cached = await options.abiCache?.get(key).catch(() => null);
  if (
    cached &&
    cached.checkedAt + (cached.abi ? ABI_CACHE_MS : ABI_MISS_CACHE_MS) > now
  )
    return cached;
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  let hit: Lookup | undefined;
  let failures = 0;
  for (const source of [
    () => sourcify(fetcher, chainId, address),
    () => blockscout(fetcher, chainId, address),
    () => etherscan(env, fetcher, chainId, address),
  ]) {
    let answer: Lookup | undefined;
    try {
      answer = await source();
    } catch (error) {
      if (!(error instanceof LookupUnavailable)) throw error;
      failures += 1;
      continue;
    }
    if (answer?.abi) {
      hit = answer;
      break;
    }
  }
  if (!hit && failures) throw new LookupUnavailable();
  const entry: AbiCacheEntry = {
    abi: hit?.abi ?? null,
    source: hit?.source ?? null,
    checkedAt: now,
    // A miss keeps its old shape; a hit records its error items too.
    ...(hit ? { errors: hit.errors ?? null } : {}),
  };
  await options.abiCache?.put(key, entry).catch(() => {});
  return entry;
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                                */
/* ---------------------------------------------------------------------- */

type Render = {
  chainId: ChatChainId;
  facts: Facts | null;
  labels: Record<string, string>;
};
/** A label only from reviewed sources: the room's own labels and the fixed
 * list. Never the symbol a contract claims for itself. */
function labelOf(render: Render, address: string): string | null {
  return (
    render.labels[lower(address)] ??
    knownAddress(render.chainId, address)?.label ??
    null
  );
}
function decimalsOf(render: Render, address: string): number | null {
  return (
    render.facts?.get(lower(address))?.decimals ??
    knownAddress(render.chainId, address)?.decimals ??
    null
  );
}
/** "1 USDC" when the asset's decimals are known, else the raw amount. The
 * unit is the reviewed label; a symbol the contract claims for itself stays
 * in the target block, where the app shows it as such. */
function formatted(render: Render, asset: string, raw: bigint): string {
  const decimals = decimalsOf(render, asset);
  if (decimals === null) return raw.toString();
  const label = labelOf(render, asset);
  return `${formatUnits(raw, decimals)}${label ? ` ${label}` : ""}`;
}
/** "1000000 (1 USDC)" for an argument: the raw value first, the human form
 * after; an allowance at or above 2^255 reads "(unlimited)" the way the flag
 * names it, whatever the asset's decimals. */
function amount(render: Render, asset: string, raw: bigint): string {
  if (isUnlimitedAllowance(raw)) return `${raw} (unlimited)`;
  const human = formatted(render, asset, raw);
  return human === raw.toString() ? human : `${raw} (${human})`;
}
function nativeAmount(chainId: ChatChainId, raw: bigint): string {
  return `${formatUnits(raw, 18)} ${getChatChain(chainId).symbol}`;
}
const truncateHex = (value: string) =>
  value.length > BYTES_DISPLAY_CHARS
    ? `${value.slice(0, BYTES_DISPLAY_CHARS)}…`
    : value;
/** Argument names whose uint value is an amount of the target asset. */
const AMOUNT_NAMES = new Set([
  "value",
  "amount",
  "addedValue",
  "subtractedValue",
  "wad",
  "amountIn",
  "amountOut",
  "amountOutMin",
  "amountInMax",
  "amountMin",
  "requestedAmount",
]);
function scalar(
  render: Render,
  param: AbiParameter,
  value: unknown,
  asset: string | null,
): string {
  if (param.type === "address") {
    const address = asAddress(value);
    if (!address) return String(value);
    const label = labelOf(render, address);
    return label ? `${address} (${label})` : address;
  }
  if (/^u?int/.test(param.type)) {
    const raw = asBigint(value);
    if (raw === null) return String(value);
    return asset && AMOUNT_NAMES.has(param.name ?? "")
      ? amount(render, asset, raw)
      : raw.toString();
  }
  if (param.type === "bool") return value ? "true" : "false";
  if (param.type.startsWith("bytes"))
    return typeof value === "string"
      ? truncateHex(lower(value))
      : String(value);
  if (param.type === "string")
    return typeof value === "string"
      ? stripControl(value).slice(0, STRING_DISPLAY_CHARS)
      : String(value);
  return String(value);
}
/** Deeper structure as JSON with bigints as strings and bytes shortened. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string")
    return isHexData(value) ? truncateHex(lower(value)) : value;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, plain(entry)]),
    );
  return value;
}
function elementType(type: string): string {
  return type.replace(/\[[0-9]*\]$/, "");
}
/** One argument as text: scalars as above, arrays and tuples one level deep. */
function formatArg(
  render: Render,
  param: AbiParameter,
  value: unknown,
  asset: string | null,
): string {
  if (/\]$/.test(param.type)) {
    const items = Array.isArray(value) ? value : [];
    const inner: AbiParameter = {
      ...param,
      type: elementType(param.type),
    } as AbiParameter;
    return JSON.stringify(
      items.map((item) =>
        /\]$/.test(inner.type) || inner.type.startsWith("tuple")
          ? plain(item)
          : scalar(render, inner, item, asset),
      ),
    );
  }
  if (param.type.startsWith("tuple")) {
    const components =
      (param as { components?: readonly AbiParameter[] }).components ?? [];
    const record = value as Record<string, unknown> | unknown[] | null;
    return JSON.stringify(
      Object.fromEntries(
        components.map((component, index) => {
          const entry = Array.isArray(record)
            ? record[index]
            : record?.[component.name ?? String(index)];
          return [
            component.name || String(index),
            /\]$/.test(component.type) || component.type.startsWith("tuple")
              ? plain(entry)
              : scalar(render, component, entry, asset),
          ];
        }),
      ),
    );
  }
  return scalar(render, param, value, asset);
}
function renderArgs(
  render: Render,
  fn: AbiFunction,
  args: readonly unknown[],
  asset: string | null,
): DecodedArg[] {
  return fn.inputs.map((input, index) => ({
    name: input.name || `arg${index}`,
    type: input.type,
    value: formatArg(render, input, args[index], asset),
  }));
}

/* ---------------------------------------------------------------------- */
/* Flags                                                                    */
/* ---------------------------------------------------------------------- */

/** Permit2 amounts are uint160; the top half of that range reads as unlimited,
 * the way isUnlimitedAllowance treats uint256. */
export const isUnlimitedPermit2Amount = (raw: bigint) => raw >= 1n << 159n;
function approval(
  render: Render,
  input: {
    spender: unknown;
    asset: unknown;
    amount: bigint | "all";
    width?: 160 | 256;
  },
): TransactionFlag | null {
  const spender = asAddress(input.spender);
  const asset = asAddress(input.asset);
  if (!spender || !asset) return null;
  const unlimited =
    input.amount === "all" ||
    (input.width === 160
      ? isUnlimitedPermit2Amount(input.amount)
      : isUnlimitedAllowance(input.amount));
  return {
    kind: "approval",
    spender,
    spenderLabel: labelOf(render, spender),
    asset,
    assetLabel: labelOf(render, asset),
    amount:
      input.amount === "all" || unlimited
        ? "unlimited"
        : formatted(render, asset, input.amount),
    unlimited,
  };
}
/** Approvals a decoded builtin call grants: ERC-20/721 approve and permit,
 * ERC-721/1155 setApprovalForAll(true), Permit2 approve and permit. */
function approvalFlags(
  render: Render,
  target: Address,
  decoded: Decoded,
): TransactionFlag[] {
  const { group, fn, args } = decoded;
  const flags: (TransactionFlag | null)[] = [];
  if (group === "erc20") {
    if (fn.name === "approve" || fn.name === "increaseAllowance")
      flags.push(
        approval(render, {
          spender: args[0],
          asset: target,
          amount: asBigint(args[1]) ?? 0n,
        }),
      );
    if (fn.name === "permit")
      flags.push(
        approval(render, {
          spender: args[1],
          asset: target,
          amount: asBigint(args[2]) ?? 0n,
        }),
      );
  } else if (group === "erc721" && fn.name === "setApprovalForAll") {
    if (args[1] === true)
      flags.push(
        approval(render, { spender: args[0], asset: target, amount: "all" }),
      );
  } else if (group === "permit2") {
    if (fn.name === "approve")
      flags.push(
        approval(render, {
          spender: args[1],
          asset: args[0],
          amount: asBigint(args[2]) ?? 0n,
          width: 160,
        }),
      );
    if (fn.name === "permit") {
      const permit = args[1] as Record<string, unknown> | undefined;
      const details = permit?.details;
      for (const entry of Array.isArray(details) ? details : [details])
        flags.push(
          approval(render, {
            spender: permit?.spender,
            asset: (entry as Record<string, unknown> | undefined)?.token,
            amount:
              asBigint(
                (entry as Record<string, unknown> | undefined)?.amount,
              ) ?? 0n,
            width: 160,
          }),
        );
    }
  }
  return flags.filter((flag): flag is TransactionFlag => flag !== null);
}
/** Asset addresses a builtin decode names, so their facts are read too. */
function namedAssets(decoded: Decoded): Address[] {
  const { group, fn, args } = decoded;
  const assets: (Address | null)[] = [];
  if (group === "permit2" && fn.name === "approve")
    assets.push(asAddress(args[0]));
  if (group === "permit2" && fn.name === "permit") {
    const details = (args[1] as Record<string, unknown> | undefined)?.details;
    for (const entry of Array.isArray(details) ? details : [details])
      assets.push(asAddress((entry as Record<string, unknown>)?.token));
  }
  return assets.filter((entry): entry is Address => entry !== null);
}

/* ---------------------------------------------------------------------- */
/* Universal Router commands                                                */
/* ---------------------------------------------------------------------- */

/** Each command byte with its input, rendered as a nested call of the
 * router; a command outside the table shows as unreadable. */
function routerCommands(
  render: Render,
  router: Address,
  decoded: Decoded,
  nestedMax: number,
): DecodedCall[] {
  const commands = decoded.args[0];
  const inputs = decoded.args[1];
  if (!isHexData(commands) || !Array.isArray(inputs)) return [];
  const bytes = commands.slice(2).match(/.{2}/g) ?? [];
  return bytes.slice(0, nestedMax).map((byte, index) => {
    const code = parseInt(byte, 16) & UNIVERSAL_ROUTER_COMMAND_MASK;
    const command = UNIVERSAL_ROUTER_COMMANDS[code];
    const input = inputs[index];
    const base = {
      index,
      to: router,
      target: targetBlock(render, router, "builtin"),
      value: "0",
      selector: null,
      nested: [],
    };
    if (!command || !isHexData(input))
      return {
        ...base,
        call: null,
        flags: [{ kind: "unreadable-call", to: router, selector: null }],
      };
    let values: readonly unknown[];
    try {
      values = decodeAbiParameters(command.params, input);
    } catch {
      return {
        ...base,
        call: null,
        flags: [{ kind: "unreadable-call", to: router, selector: null }],
      };
    }
    const fn: AbiFunction = {
      type: "function",
      name: command.name,
      inputs: command.params as AbiParameter[],
      outputs: [],
      stateMutability: "nonpayable",
    };
    const flags: (TransactionFlag | null)[] = [];
    if (
      command.name === "PERMIT2_PERMIT" ||
      command.name === "PERMIT2_PERMIT_BATCH"
    ) {
      const permit = values[0] as Record<string, unknown> | undefined;
      const details = permit?.details;
      for (const entry of Array.isArray(details) ? details : [details])
        flags.push(
          approval(render, {
            spender: permit?.spender,
            asset: (entry as Record<string, unknown> | undefined)?.token,
            amount:
              asBigint(
                (entry as Record<string, unknown> | undefined)?.amount,
              ) ?? 0n,
            width: 160,
          }),
        );
    }
    const tokenIndex = command.params.findIndex(
      (param) => param.type === "address" && param.name === "token",
    );
    const asset = tokenIndex === -1 ? null : asAddress(values[tokenIndex]);
    return {
      ...base,
      call: {
        name: command.name,
        signature: toFunctionSignature(fn),
        args: renderArgs(render, fn, values, asset),
        source: "builtin",
      },
      flags: flags.filter((flag): flag is TransactionFlag => flag !== null),
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Assembly                                                                 */
/* ---------------------------------------------------------------------- */

function targetBlock(
  render: Render,
  address: Address,
  verified: DecodedCall["target"]["verified"],
): DecodedCall["target"] {
  const facts = render.facts?.get(lower(address)) ?? null;
  return {
    contract: facts ? facts.contract : true,
    label: labelOf(render, address),
    symbol: facts?.symbol ?? null,
    decimals: decimalsOf(render, address),
    verified: facts && !facts.contract ? "not-a-contract" : verified,
  };
}
function finish(render: Render, call: Working, nestedMax: number): DecodedCall {
  const facts = render.facts?.get(lower(call.to)) ?? null;
  const plainTransfer = call.data === "0x";
  const decoded = call.decoded;
  const verified: DecodedCall["target"]["verified"] = decoded
    ? decoded.group === "verified"
      ? "verified"
      : "builtin"
    : call.abiFound
      ? "verified"
      : "unverified";
  const flags: TransactionFlag[] = [];
  const value = BigInt(call.value);
  if (value > 0n)
    flags.push({
      kind: "native-value",
      amount: nativeAmount(render.chainId, value),
    });
  if (facts && !facts.contract && !plainTransfer)
    flags.push({ kind: "not-a-contract", to: call.to });
  else if (!plainTransfer && !decoded) {
    // Only what is known: no verdict on a target nobody could look at.
    if (facts?.contract && !call.abiFound && !call.lookupFailed)
      flags.push({ kind: "unverified-target", to: call.to });
    if (call.abiFound || !call.lookupFailed)
      flags.push({
        kind: "unreadable-call",
        to: call.to,
        selector: call.selector,
      });
  }
  if (decoded && decoded.group !== "verified")
    flags.push(...approvalFlags(render, call.to, decoded));
  const nested =
    decoded?.group === "universal-router" && call.depth === 0
      ? routerCommands(render, call.to, decoded, nestedMax)
      : call.nested.map((inner) => finish(render, inner, nestedMax));
  return {
    index: call.index,
    to: call.to,
    target: targetBlock(render, call.to, verified),
    value: call.value,
    selector: call.selector,
    call: decoded
      ? {
          name: decoded.fn.name,
          signature: toFunctionSignature(decoded.fn),
          args: renderArgs(render, decoded.fn, decoded.args, call.to),
          source: decoded.group === "verified" ? "verified" : "builtin",
        }
      : null,
    nested,
    flags,
  };
}
const flagKey = (flag: TransactionFlag) =>
  flag.kind === "approval"
    ? `approval:${lower(flag.spender)}:${lower(flag.asset)}`
    : "to" in flag
      ? `${flag.kind}:${lower(flag.to)}`
      : flag.kind;
/** The flag summary a diagnosis shows: every call's and nested call's, one
 * per kind and target; native value is summed across the calls.
 *
 * @public Ticket diagnosis reads it.
 */
export function summaryFlags(
  chainId: ChatChainId,
  calls: readonly DecodedCall[],
): TransactionFlag[] {
  const seen = new Map<string, TransactionFlag>();
  let native = 0n;
  const visit = (call: DecodedCall) => {
    for (const flag of call.flags) {
      if (flag.kind === "native-value") continue;
      const key = flagKey(flag);
      const previous = seen.get(key);
      // The same spender and asset twice: the unlimited grant is the one to show.
      const stronger =
        previous?.kind === "approval" &&
        flag.kind === "approval" &&
        flag.unlimited &&
        !previous.unlimited;
      if (!previous || stronger) seen.set(key, flag);
    }
    call.nested.forEach(visit);
  };
  for (const call of calls) {
    native += BigInt(call.value);
    visit(call);
  }
  const flags = [...seen.values()];
  if (native > 0n)
    flags.unshift({
      kind: "native-value",
      amount: nativeAmount(chainId, native),
    });
  return flags;
}
/** Decodes a list of calls on one chain. Never throws for a chain, budget
 * or lookup problem: the status says how far it got.
 *
 * @public Ticket diagnosis reads it.
 */
export async function decodeTransactionCalls(
  env: Env,
  chainId: ChatChainId,
  calls: readonly TransactionCall[],
  options: DecodeOptions = {},
): Promise<DecodedTransaction> {
  const now = options.now?.() ?? Date.now();
  const nestedMax = options.budget?.nested ?? DECODE_NESTED_MAX;
  const targetsMax = options.budget?.targets ?? DECODE_TARGETS_MAX;
  const lookupsMax = options.budget?.lookups ?? DECODE_LOOKUPS_MAX;
  const items = calls.map((call, index) =>
    working(
      { to: call.to, value: call.value, data: call.data },
      index,
      0,
      nestedMax,
    ),
  );
  const every = flatten(items);
  // Distinct targets first, then assets an approval names, under the cap.
  const wanted: Address[] = [];
  const seen = new Set<string>();
  const want = (address: Address) => {
    if (seen.has(lower(address)) || wanted.length >= targetsMax) return;
    seen.add(lower(address));
    wanted.push(address);
  };
  for (const call of every) want(call.to);
  for (const call of every)
    if (call.decoded) namedAssets(call.decoded).forEach(want);
  let facts: Facts | null = null;
  let block: string | null = null;
  try {
    const read = await readTargetFacts(env, chainId, wanted, options.client);
    facts = read.facts;
    block = read.block;
  } catch {
    // A budget refusal, a provider failure or disagreement: the structural
    // layer stands and the status says the rest could not be read.
    facts = null;
  }
  // Verified ABIs for calls no builtin knows, one lookup chain per target.
  const pendingLookups = new Map<string, Working[]>();
  for (const call of every) {
    if (call.data === "0x" || call.decoded) continue;
    const known = facts?.get(lower(call.to));
    if (known && !known.contract) continue;
    const list = pendingLookups.get(lower(call.to)) ?? [];
    list.push(call);
    pendingLookups.set(lower(call.to), list);
  }
  let lookups = 0;
  for (const [address, list] of pendingLookups) {
    if (lookups >= lookupsMax) {
      for (const call of list) call.lookupFailed = true;
      continue;
    }
    lookups += 1;
    let entry: AbiCacheEntry | null = null;
    try {
      entry = await lookupVerifiedAbi(env, chainId, getAddress(address), {
        fetcher: options.fetcher,
        abiCache: options.abiCache,
        now,
      });
    } catch {
      for (const call of list) call.lookupFailed = true;
      continue;
    }
    if (!entry.abi) continue;
    for (const call of list) {
      call.abiFound = true;
      const fn = entry.abi.find(
        (item) => toFunctionSelector(item) === call.selector,
      );
      call.decoded = fn ? decodeWith(fn, "verified", call.data) : null;
    }
  }
  const render: Render = { chainId, facts, labels: options.labels ?? {} };
  const rendered = items.map((call) => finish(render, call, nestedMax));
  const unreadable = every.some((call) => call.data !== "0x" && !call.decoded);
  return {
    status: facts === null ? "unavailable" : unreadable ? "partial" : "decoded",
    checkedAt: new Date(now).toISOString(),
    block,
    calls: rendered,
    flags: summaryFlags(chainId, rendered),
  };
}

/* ---------------------------------------------------------------------- */
/* The service-wide ABI catalog                                             */
/* ---------------------------------------------------------------------- */

function cacheEntry(value: unknown): AbiCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<AbiCacheEntry>;
  if (!Number.isSafeInteger(entry.checkedAt)) return null;
  const abi = entry.abi === null ? null : abiFunctions(entry.abi);
  if (entry.abi !== null && !abi) return null;
  const source =
    entry.source === "sourcify" ||
    entry.source === "blockscout" ||
    entry.source === "etherscan"
      ? entry.source
      : null;
  // Rows written before error items keep no `errors` field and stay readable.
  if (entry.errors === undefined)
    return { abi, source, checkedAt: entry.checkedAt as number };
  const errors = entry.errors === null ? null : abiErrorItems(entry.errors);
  if (entry.errors !== null && !errors) return null;
  return { abi, source, checkedAt: entry.checkedAt as number, errors };
}
const ABI_KEY = /^abi:(1|8453|56|4663):0x[0-9a-f]{40}$/;
/** `abi-get {key}` and `abi-put {key, entry}` on the catalog object: one row
 * per chain and address under an index capped at ABI_CATALOG_ROWS_MAX rows,
 * oldest checked first out. */
export async function abiCatalogRequest(
  storage: Storage,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  const key =
    typeof body.key === "string" && ABI_KEY.test(body.key) ? body.key : null;
  if (!key) throw new HttpError(400, "Invalid ABI cache key.");
  const row = `${ABI_CATALOG_PREFIX}${key}`;
  if (body.op === "abi-get")
    return json({ entry: cacheEntry(await storage.get(row)) });
  if (body.op !== "abi-put") throw new HttpError(400, "Invalid ABI cache op.");
  const entry = cacheEntry(body.entry);
  // DO storage holds 128 KiB per value; an ABI past this is fetched each time.
  if (!entry || JSON.stringify(entry).length > ABI_ENTRY_MAX_CHARS)
    throw new HttpError(400, "Invalid ABI cache entry.");
  const index =
    (await storage.get<Record<string, number>>(ABI_CATALOG_INDEX_KEY)) ?? {};
  index[key] = entry.checkedAt;
  const keys = Object.keys(index);
  if (keys.length > ABI_CATALOG_ROWS_MAX)
    for (const old of keys
      .filter((candidate) => candidate !== key)
      .sort((a, b) => index[a] - index[b])
      .slice(0, keys.length - ABI_CATALOG_ROWS_MAX)) {
      delete index[old];
      await storage.delete(`${ABI_CATALOG_PREFIX}${old}`);
    }
  await storage.put(row, entry);
  await storage.put(ABI_CATALOG_INDEX_KEY, index);
  return json({ ok: true, at: now });
}
/** The default cache: the catalog object behind env.ROOMS, asked through its
 * private ABI catalog route. A failed read is a miss; a failed write is
 * dropped.
 *
 * @public Ticket diagnosis reads it.
 */
export function abiCatalogCache(env: Env): AbiCache {
  const catalog = () => env.ROOMS.get(env.ROOMS.idFromName(ABI_CATALOG_SCOPE));
  const ask = (body: Record<string, unknown>) =>
    catalog().fetch(
      new Request("https://internal/private/abi-catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return {
    async get(key) {
      try {
        const answer = await ask({ op: "abi-get", key });
        if (!answer.ok) return null;
        return cacheEntry((await answer.json<{ entry: unknown }>()).entry);
      } catch {
        return null;
      }
    },
    async put(key, entry) {
      await ask({ op: "abi-put", key, entry }).catch(() => undefined);
    },
  };
}
