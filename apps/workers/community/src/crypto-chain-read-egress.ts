import { isSolanaSignature } from "@templ/chat/diagnosis/subject";
import { isSolanaAddress } from "@templ/chat/solana";
import { readCapped } from "./bounded-read";

/** Every request a public crypto lookup sends goes through this file: one of
 * the fixed providers below, one fixed route or read-only method, and the
 * one validated ID or address. Nothing here signs, sends or simulates a
 * transaction, and nothing from the case, the prompt or the visitor's
 * request (headers, links) is sent. */

export type CryptoChain = "bitcoin" | "ethereum" | "solana";

/** Free public services that need no account and no key. Each chain has two
 * independent operators for cross-checks, except address history on
 * Ethereum: JSON-RPC has no history method, so Blockscout is the one source.
 * https://mempool.space/docs/api/rest
 * https://github.com/Blockstream/esplora/blob/master/API.md
 * https://ethereum-rpc.publicnode.com, https://drpc.org/chainlist/ethereum
 * https://eth.blockscout.com/api-docs
 * https://solana.com/docs/references/clusters, https://solana-rpc.publicnode.com */
export const CRYPTO_PROVIDERS = Object.freeze({
  "mempool.space": {
    chain: "bitcoin",
    api: "esplora",
    base: "https://mempool.space/api",
  },
  "blockstream.info": {
    chain: "bitcoin",
    api: "esplora",
    base: "https://blockstream.info/api",
  },
  publicnode: {
    chain: "ethereum",
    api: "rpc",
    base: "https://ethereum-rpc.publicnode.com",
  },
  drpc: { chain: "ethereum", api: "rpc", base: "https://eth.drpc.org" },
  blockscout: {
    chain: "ethereum",
    api: "blockscout",
    base: "https://eth.blockscout.com/api/v2",
  },
  "solana-foundation": {
    chain: "solana",
    api: "rpc",
    base: "https://api.mainnet-beta.solana.com",
  },
  "publicnode-solana": {
    chain: "solana",
    api: "rpc",
    base: "https://solana-rpc.publicnode.com",
  },
} as const);
export type CryptoProviderId = keyof typeof CRYPTO_PROVIDERS;
export type EsploraProvider = "mempool.space" | "blockstream.info";
export type EthereumRpcProvider = "publicnode" | "drpc";
export type SolanaRpcProvider = "solana-foundation" | "publicnode-solana";

export const SOLANA_MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const REQUEST_TIMEOUT_MS = 4_000;
const DEFAULT_DEADLINE_MS = 8_000;
const MAX_DEADLINE_MS = 10_000;
/** A 429 without Retry-After, or a JSON-RPC rate-limit error, waits this long. */
const DEFAULT_COOLDOWN_SECONDS = 60;
const IDENTITY_TTL_MS = 10 * 60_000;
/** The most items any lookup returns. */
export const MAX_ITEMS = 10;

const TXID = /^[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
// The bitcoin module checks the checksum; this keeps any other text out of a path.
const BTC_ADDRESS = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[02-9ac-hj-np-z]{11,71})$/;

/** A programming error: the read layer asked for something it must never
 * send. Tests pin every refusal. */
export class CryptoEgressRefused extends Error {
  constructor(detail: string) {
    super(`crypto-egress-refused: ${detail}`);
    this.name = "CryptoEgressRefused";
  }
}

export type CryptoFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Retry-After memory and checked network identities, by provider. One
 * default instance lives per isolate; a caller may pass a durable one. */
export type CryptoProviderState = {
  /** Epoch ms before which a provider gets no request. */
  cooldownUntil: Map<CryptoProviderId, number>;
  /** Epoch ms until which a provider's chain ID or genesis stays checked. */
  identityUntil: Map<CryptoProviderId, number>;
};
export const createCryptoProviderState = (): CryptoProviderState => ({
  cooldownUntil: new Map(),
  identityUntil: new Map(),
});
const isolateState = createCryptoProviderState();

export type CryptoChainReadDeps = {
  fetch?: CryptoFetch;
  now?: () => number;
  /** The whole lookup, in ms: default 8000, at most 10000. Each request also
   * stops after 4000 ms. */
  deadlineMs?: number;
  state?: CryptoProviderState;
};

export type CryptoSourceOutcome =
  | "answered"
  | "not-found"
  | "rate-limited"
  | "cooling-down"
  | "timeout"
  | "too-large"
  | "http-error"
  | "rpc-error"
  | "invalid-response"
  | "wrong-network"
  | "skipped";
export type Failure =
  | { outcome: "rate-limited" | "cooling-down"; retryAfterSeconds: number }
  | {
      outcome: Exclude<
        CryptoSourceOutcome,
        "answered" | "not-found" | "rate-limited" | "cooling-down"
      >;
    };
export type CryptoSourceReport = {
  provider: CryptoProviderId;
  outcome: CryptoSourceOutcome;
  /** Seconds until Templ may ask this provider again. */
  retryAfterSeconds?: number;
  /** Requests that left Templ for this provider in this lookup. */
  requests: number;
};

export type ReadContext = {
  readonly fetch: CryptoFetch;
  readonly now: () => number;
  readonly deadlineAt: number;
  readonly state: CryptoProviderState;
  readonly tallies: Map<CryptoProviderId, { requests: number; failure: Failure | null }>;
  nextId: number;
};

export function readContext(deps: CryptoChainReadDeps = {}): ReadContext {
  const now = deps.now ?? (() => Date.now());
  const requested = deps.deadlineMs;
  const span =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(MAX_DEADLINE_MS, Math.max(1, Math.floor(requested)))
      : DEFAULT_DEADLINE_MS;
  return {
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    now,
    deadlineAt: now() + span,
    state: deps.state ?? isolateState,
    tallies: new Map(),
    nextId: 1,
  };
}

export const checkedAt = (ctx: ReadContext) =>
  new Date(ctx.now()).toISOString().replace(/\.\d{3}Z$/, "Z");

function tally(ctx: ReadContext, provider: CryptoProviderId) {
  let entry = ctx.tallies.get(provider);
  if (!entry) {
    entry = { requests: 0, failure: null };
    ctx.tallies.set(provider, entry);
  }
  return entry;
}

/** Records a provider's failure for this lookup. A provider that failed once
 * gets no further request in the same lookup: its observation is void. */
export function fail(
  ctx: ReadContext,
  provider: CryptoProviderId,
  failure: Failure,
): { ok: false; failure: Failure } {
  const entry = tally(ctx, provider);
  return { ok: false, failure: (entry.failure ??= failure) };
}

function coolDown(ctx: ReadContext, provider: CryptoProviderId, seconds: number) {
  const until = ctx.now() + seconds * 1000;
  const current = ctx.state.cooldownUntil.get(provider) ?? 0;
  if (until > current) ctx.state.cooldownUntil.set(provider, until);
}

/** Seconds from a Retry-After value (delta seconds or an HTTP date). */
export function retryAfterSeconds(value: string | null, now: number) {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

type Sent = { ok: true; status: 200 | 404; text: string } | { ok: false; failure: Failure };

async function send(
  ctx: ReadContext,
  provider: CryptoProviderId,
  url: string,
  body: string | null,
  maxBytes: number,
  notFound: boolean,
): Promise<Sent> {
  const entry = tally(ctx, provider);
  if (entry.failure) return { ok: false, failure: entry.failure };
  const now = ctx.now();
  const until = ctx.state.cooldownUntil.get(provider) ?? 0;
  if (until > now)
    return fail(ctx, provider, {
      outcome: "cooling-down",
      retryAfterSeconds: Math.ceil((until - now) / 1000),
    });
  const remaining = ctx.deadlineAt - now;
  if (remaining <= 0) return fail(ctx, provider, { outcome: "skipped" });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(REQUEST_TIMEOUT_MS, remaining),
  );
  entry.requests += 1;
  try {
    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method: body === null ? "GET" : "POST",
        headers:
          body === null
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        ...(body === null ? {} : { body }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return fail(ctx, provider, {
        outcome: controller.signal.aborted ? "timeout" : "http-error",
      });
    }
    if (response.status === 429 || response.status === 503) {
      await response.body?.cancel().catch(() => {});
      const seconds =
        retryAfterSeconds(response.headers.get("retry-after"), ctx.now()) ??
        (response.status === 429 ? DEFAULT_COOLDOWN_SECONDS : null);
      if (seconds === null) return fail(ctx, provider, { outcome: "http-error" });
      coolDown(ctx, provider, seconds);
      return fail(ctx, provider, {
        outcome: "rate-limited",
        retryAfterSeconds: seconds,
      });
    }
    // Redirects are never followed: the next hop is not a reviewed provider.
    if (response.status !== 200 && !(notFound && response.status === 404)) {
      await response.body?.cancel().catch(() => {});
      return fail(ctx, provider, { outcome: "http-error" });
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(response, maxBytes);
    } catch {
      return fail(ctx, provider, {
        outcome: controller.signal.aborted ? "timeout" : "http-error",
      });
    }
    if (!bytes) return fail(ctx, provider, { outcome: "too-large" });
    try {
      return {
        ok: true,
        status: response.status as 200 | 404,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      };
    } catch {
      return fail(ctx, provider, { outcome: "invalid-response" });
    }
  } finally {
    clearTimeout(timer);
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export type EsploraRequest =
  | { route: "tx"; txid: string }
  | { route: "tip-height" }
  | { route: "address-txs"; address: string };
/** Response caps: a single transaction, the tip, and an address page of up
 * to 50 unconfirmed plus 25 confirmed transactions. */
const ESPLORA_MAX_BYTES = { tx: 1_000_000, "tip-height": 64, "address-txs": 2_000_000 };

/** One Esplora GET. `found` is false only for a transaction the provider does
 * not know (404). */
export async function esplora(
  ctx: ReadContext,
  provider: EsploraProvider,
  request: EsploraRequest,
): Promise<{ ok: true; found: boolean; body: unknown } | { ok: false; failure: Failure }> {
  const { base, api } = CRYPTO_PROVIDERS[provider];
  if (api !== "esplora") throw new CryptoEgressRefused("provider");
  let path: string;
  if (request.route === "tx" && TXID.test(request.txid)) path = `/tx/${request.txid}`;
  else if (request.route === "tip-height") path = "/blocks/tip/height";
  else if (request.route === "address-txs" && BTC_ADDRESS.test(request.address))
    path = `/address/${request.address}/txs`;
  else throw new CryptoEgressRefused(request.route);
  const reply = await send(
    ctx,
    provider,
    base + path,
    null,
    ESPLORA_MAX_BYTES[request.route],
    request.route === "tx",
  );
  if (!reply.ok) return reply;
  if (reply.status === 404) return { ok: true, found: false, body: null };
  if (request.route === "tip-height") {
    const text = reply.text.trim();
    return /^\d{1,9}$/.test(text)
      ? { ok: true, found: true, body: Number(text) }
      : fail(ctx, provider, { outcome: "invalid-response" });
  }
  const body = parseJson(reply.text);
  return body === undefined
    ? fail(ctx, provider, { outcome: "invalid-response" })
    : { ok: true, found: true, body };
}

/** One Blockscout page of an address's transactions or token transfers, the
 * first page only. `found` is false when Blockscout has never seen the
 * address (404). */
export async function blockscout(
  ctx: ReadContext,
  route: "transactions" | "token-transfers",
  address: string,
): Promise<{ ok: true; found: boolean; body: unknown } | { ok: false; failure: Failure }> {
  if (!EVM_ADDRESS.test(address) || (route !== "transactions" && route !== "token-transfers"))
    throw new CryptoEgressRefused("blockscout");
  const url = `${CRYPTO_PROVIDERS.blockscout.base}/addresses/${address}/${route}`;
  const reply = await send(ctx, "blockscout", url, null, 1_000_000, true);
  if (!reply.ok) return reply;
  if (reply.status === 404) return { ok: true, found: false, body: null };
  const body = parseJson(reply.text);
  return body === undefined
    ? fail(ctx, "blockscout", { outcome: "invalid-response" })
    : { ok: true, found: true, body };
}

/** The read-only methods a lookup may send, with the only values each may
 * carry. Parameters are built here, never passed through. */
export type RpcCall =
  | { method: "eth_chainId" }
  | { method: "eth_blockNumber" }
  | { method: "getGenesisHash" }
  | {
      method:
        | "eth_getTransactionByHash"
        | "eth_getTransactionReceipt"
        | "eth_getBlockByHash";
      hash: string;
    }
  | { method: "getSignatureStatuses" | "getTransaction"; signature: string }
  | { method: "getSignaturesForAddress"; address: string; limit: number };
export const ETHEREUM_METHODS = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByHash",
] as const);
export const SOLANA_METHODS = Object.freeze([
  "getGenesisHash",
  "getSignatureStatuses",
  "getTransaction",
  "getSignaturesForAddress",
] as const);
const RPC_MAX_BYTES: Record<RpcCall["method"], number> = {
  eth_chainId: 1_000,
  eth_blockNumber: 1_000,
  getGenesisHash: 1_000,
  // Calldata is at most 128 KB, twice that in hex.
  eth_getTransactionByHash: 400_000,
  eth_getTransactionReceipt: 1_000_000,
  // Transaction hashes only, never full transactions.
  eth_getBlockByHash: 250_000,
  getSignatureStatuses: 10_000,
  getTransaction: 1_000_000,
  getSignaturesForAddress: 200_000,
};

function rpcParams(chain: CryptoChain, call: RpcCall): unknown[] {
  const ethereum = (ETHEREUM_METHODS as readonly string[]).includes(call.method);
  const solana = (SOLANA_METHODS as readonly string[]).includes(call.method);
  if ((chain === "ethereum" && !ethereum) || (chain === "solana" && !solana))
    throw new CryptoEgressRefused(call.method);
  switch (call.method) {
    case "eth_chainId":
    case "eth_blockNumber":
    case "getGenesisHash":
      return [];
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt":
    case "eth_getBlockByHash":
      if (!HASH.test(call.hash)) throw new CryptoEgressRefused("hash");
      return call.method === "eth_getBlockByHash" ? [call.hash, false] : [call.hash];
    case "getSignatureStatuses":
      if (!isSolanaSignature(call.signature)) throw new CryptoEgressRefused("signature");
      return [[call.signature], { searchTransactionHistory: true }];
    case "getTransaction":
      if (!isSolanaSignature(call.signature)) throw new CryptoEgressRefused("signature");
      return [
        call.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ];
    case "getSignaturesForAddress":
      if (
        !isSolanaAddress(call.address) ||
        !Number.isSafeInteger(call.limit) ||
        call.limit < 1 ||
        call.limit > MAX_ITEMS
      )
        throw new CryptoEgressRefused("address");
      return [call.address, { limit: call.limit, commitment: "confirmed" }];
  }
}

/** EIP-1474 "limit exceeded" and the HTTP code some providers put in the body. */
const RATE_LIMIT_CODES = new Set([-32005, 429]);

/** One JSON-RPC call. The answer must echo this request's id. */
export async function rpc(
  ctx: ReadContext,
  provider: EthereumRpcProvider | SolanaRpcProvider,
  call: RpcCall,
): Promise<{ ok: true; result: unknown } | { ok: false; failure: Failure }> {
  const { base, api, chain } = CRYPTO_PROVIDERS[provider];
  if (api !== "rpc") throw new CryptoEgressRefused("provider");
  const params = rpcParams(chain, call);
  const id = ctx.nextId++;
  const reply = await send(
    ctx,
    provider,
    base,
    JSON.stringify({ jsonrpc: "2.0", id, method: call.method, params }),
    RPC_MAX_BYTES[call.method],
    false,
  );
  if (!reply.ok) return reply;
  const body = parseJson(reply.text);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    (body as { id?: unknown }).id !== id
  )
    return fail(ctx, provider, { outcome: "invalid-response" });
  const { error } = body as { error?: unknown };
  if (error !== undefined && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && RATE_LIMIT_CODES.has(code)) {
      coolDown(ctx, provider, DEFAULT_COOLDOWN_SECONDS);
      return fail(ctx, provider, {
        outcome: "rate-limited",
        retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      });
    }
    return fail(ctx, provider, { outcome: "rpc-error" });
  }
  if (!Object.hasOwn(body, "result"))
    return fail(ctx, provider, { outcome: "invalid-response" });
  return { ok: true, result: (body as { result: unknown }).result };
}

/** Checks once per ten minutes that a provider serves mainnet: chain ID 1
 * on Ethereum, the mainnet genesis hash on Solana. */
export async function checkIdentity(
  ctx: ReadContext,
  provider: EthereumRpcProvider | SolanaRpcProvider,
): Promise<Failure | null> {
  if ((ctx.state.identityUntil.get(provider) ?? 0) > ctx.now()) return null;
  const ethereum = CRYPTO_PROVIDERS[provider].chain === "ethereum";
  const reply = await rpc(ctx, provider, {
    method: ethereum ? "eth_chainId" : "getGenesisHash",
  });
  if (!reply.ok) return reply.failure;
  if (reply.result !== (ethereum ? "0x1" : SOLANA_MAINNET_GENESIS))
    return fail(ctx, provider, { outcome: "wrong-network" }).failure;
  ctx.state.identityUntil.set(provider, ctx.now() + IDENTITY_TTL_MS);
  return null;
}

/** What one provider reported, or why it reported nothing. */
export type Observed<T> =
  | { provider: CryptoProviderId; ok: true; value: T }
  | { provider: CryptoProviderId; ok: false; failure: Failure };

export type CryptoAgreement = "agreed" | "single" | "conflict" | "unavailable";

/** Two answers agree when `same` holds; `merge` then combines the fields that
 * move with each provider's own tip (confirmations, commitment). */
export function agree<T>(
  observed: readonly Observed<T>[],
  same: (a: T, b: T) => boolean,
  merge: (a: T, b: T) => T = (a) => a,
): {
  agreement: CryptoAgreement;
  value: T | null;
  observations: { provider: CryptoProviderId; value: T }[];
} {
  const answered = observed.filter(
    (item): item is Extract<Observed<T>, { ok: true }> => item.ok,
  );
  if (!answered.length) return { agreement: "unavailable", value: null, observations: [] };
  if (answered.length === 1)
    return { agreement: "single", value: answered[0].value, observations: [] };
  const [a, b] = answered;
  return same(a.value, b.value)
    ? { agreement: "agreed", value: merge(a.value, b.value), observations: [] }
    : {
        agreement: "conflict",
        value: null,
        observations: answered.map(({ provider, value }) => ({ provider, value })),
      };
}

/** One report per provider, in the order given. A provider that failed a
 * later request in the lookup (a detail read) reports that failure. */
export function sourceReports<T>(
  ctx: ReadContext,
  observed: readonly Observed<T>[],
  found: (value: T) => boolean,
): CryptoSourceReport[] {
  return observed.map((item): CryptoSourceReport => {
    const entry = ctx.tallies.get(item.provider);
    const requests = entry?.requests ?? 0;
    const reported = item.ok ? (entry?.failure ?? null) : item.failure;
    if (!reported)
      return {
        provider: item.provider,
        outcome: item.ok && found(item.value) ? "answered" : "not-found",
        requests,
      };
    return {
      provider: item.provider,
      outcome: reported.outcome,
      ...("retryAfterSeconds" in reported
        ? { retryAfterSeconds: reported.retryAfterSeconds }
        : {}),
      requests,
    };
  });
}

/** Stable comparison of normalized facts. */
export const sameFacts = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A thrown parse error: the provider's answer is not what the method
 * promises. Callers void the provider's observation on any error from a
 * parse, except CryptoEgressRefused. */
export class InvalidAnswer extends Error {
  constructor(detail: string) {
    super(`invalid provider answer: ${detail}`);
    this.name = "InvalidAnswer";
  }
}
export const invalid = (detail: string): never => {
  throw new InvalidAnswer(detail);
};

/** Second-precision ISO time of a chain timestamp in seconds. */
export function isoSeconds(seconds: number | bigint) {
  const ms = Number(seconds) * 1000;
  return Number.isSafeInteger(ms) && ms >= 0 && ms <= 8.64e15
    ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
    : invalid("time");
}
