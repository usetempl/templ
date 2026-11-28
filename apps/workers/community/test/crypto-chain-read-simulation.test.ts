import { cryptoChainReader } from "../src/managed-agent/crypto-chain-reader";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { rng, simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { base58Encode } from "@templ/chat/solana";
import { sha256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  CRYPTO_PROVIDERS,
  createCryptoProviderState,
  parseCryptoAddress,
  parseCryptoTxPermalink,
  readCryptoAddressActivity,
  readCryptoTransaction,
  type CryptoAddressQuery,
  type CryptoChain,
  type CryptoProviderId,
  type CryptoProviderState,
  type CryptoTxQuery,
} from "../src/crypto-chain-read";

const T0 = Date.UTC(2026, 10, 27, 12);
const CHECKED_AT = "2026-11-27T12:00:00Z";
/** Text from the visitor's case. It must never leave Templ or come back. */
const SECRET = "kestrel-42-case-text";
const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_SOL = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const ESPLORA = ["mempool.space", "blockstream.info"] as const;
const ETHEREUM_RPC = ["publicnode", "drpc"] as const;
const SOLANA_RPC = ["solana-foundation", "publicnode-solana"] as const;
const BASES = Object.fromEntries(
  Object.entries(CRYPTO_PROVIDERS).map(([id, provider]) => [id, provider.base]),
) as Record<CryptoProviderId, string>;

const base58Check = (payload: number[]) => {
  const bytes = Uint8Array.from(payload);
  const checksum = sha256(sha256(bytes, "bytes"), "bytes").slice(0, 4);
  return base58Encode(Uint8Array.from([...bytes, ...checksum]));
};
// The genesis block's address, BIP-173 and BIP-350 vectors, and a P2SH built here.
const SATOSHI = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const P2SH = base58Check([0x05, ...Array<number>(20).fill(7)]);
const P2WPKH = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const P2WSH = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const P2TR = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const BTC_ADDRESSES = [SATOSHI, P2SH, P2WPKH, P2WSH, P2TR];
// A zero scalar cannot control funds. Encode it in both private-key
// formats so the same refusal is exercised without publishing a usable key.
const WIF = base58Check([0x80, ...Array<number>(32).fill(0)]);
const XPRV = base58Check([0x04, 0x88, 0xad, 0xe4, ...Array<number>(74).fill(0)]);

const hex = (draw: Rng, bytes: number) => draw.text("0123456789abcdef", bytes * 2);
const randomBytes = (draw: Rng, length: number) =>
  Uint8Array.from({ length }, () => draw.int(0, 255));
const solanaAddress = (draw: Rng) => base58Encode(randomBytes(draw, 32));
const solanaSignature = (draw: Rng) => base58Encode(randomBytes(draw, 64));
const quantity = (value: bigint | number) => "0x" + BigInt(value).toString(16);
const word = (value: bigint) => "0x" + value.toString(16).padStart(64, "0");
const topic = (address: string) => "0x" + "0".repeat(24) + address.slice(2);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const tokenAccount = (mint: string, owner: string) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(SPL_TOKEN)).toBase58();

/** Exact decimal text of an integer amount, written apart from the module. */
function decimal(value: bigint, decimals: number) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
}

async function solanaKeypair(seed: Uint8Array) {
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from([...prefix, ...seed]), { name: "Ed25519" }, true, ["sign"]);
  const { x } = (await crypto.subtle.exportKey("jwk", key)) as { x: string };
  return base58Encode(Uint8Array.from([...seed, ...Buffer.from(x, "base64url")]));
}

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
  rpc: { jsonrpc: string; id: number; method: string; params: unknown[] } | null;
  provider: CryptoProviderId | "unknown";
};

/** A recorded fake network. Unknown hosts are recorded, then refused. */
function network(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const provider =
      (Object.keys(BASES) as CryptoProviderId[]).find(
        (id) => url === BASES[id] || url.startsWith(BASES[id] + "/"),
      ) ?? "unknown";
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      redirect: init.redirect,
      rpc: typeof init.body === "string" ? JSON.parse(init.body) : null,
      provider,
    };
    calls.push(call);
    if (provider === "unknown") throw new Error(`Request to an unknown host: ${url}`);
    return route(call);
  };
  return { fetch, calls };
}

const deps = (
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  state: CryptoProviderState = createCryptoProviderState(),
  now: () => number = () => T0,
) => ({ fetch, now, state });
const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
const rpcReply = (call: Call, result: unknown) => json({ jsonrpc: "2.0", id: call.rpc!.id, result });

const METHODS: Record<"ethereum" | "solana", string[]> = {
  ethereum: ["eth_chainId", "eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByHash"],
  solana: ["getGenesisHash", "getSignatureStatuses", "getTransaction", "getSignaturesForAddress"],
};
const OPTION_KEYS = new Set(["searchTransactionHistory", "encoding", "maxSupportedTransactionVersion", "commitment", "limit"]);
const OPTION_STRINGS = new Set(["jsonParsed", "confirmed"]);
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      expect(OPTION_KEYS.has(key), key).toBe(true);
      strings(item, out);
    }
  return out;
}

/** Every request went to a fixed provider route or read-only method,
 * carried only `values` and nothing from the visitor. */
function expectEgress(calls: readonly Call[], values: readonly string[]) {
  const ids = new Set<number>();
  for (const call of calls) {
    expect(call.provider, call.url).not.toBe("unknown");
    expect(JSON.stringify(call)).not.toContain(SECRET);
    expect(call.redirect).toBe("manual");
    expect(call.url).not.toContain("?");
    const provider = call.provider as CryptoProviderId;
    const { api, chain } = CRYPTO_PROVIDERS[provider];
    const base = BASES[provider];
    if (api === "rpc") {
      expect(call.url).toBe(base);
      expect(call.method).toBe("POST");
      expect(call.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
      const body = call.rpc!;
      expect(Object.keys(body).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
      expect(body.jsonrpc).toBe("2.0");
      expect(ids.has(body.id), "a reused request id").toBe(false);
      ids.add(body.id);
      expect(METHODS[chain as "ethereum" | "solana"]).toContain(body.method);
      for (const text of strings(body.params))
        expect(values.includes(text) || OPTION_STRINGS.has(text), text).toBe(true);
    } else {
      expect(call.method).toBe("GET");
      expect(call.headers).toEqual({ accept: "application/json" });
      expect(call.rpc).toBeNull();
      const path = call.url.slice(base.length);
      const routes =
        api === "esplora"
          ? ["/blocks/tip/height", ...values.flatMap((value) => [`/tx/${value}`, `/address/${value}/txs`])]
          : values.flatMap((value) => [`/addresses/${value}/transactions`, `/addresses/${value}/token-transfers`]);
      expect(routes, call.url).toContain(path);
    }
  }
}

/** What two providers' answers add up to, written apart from the module. */
function expectedAgreement<T>(
  results: { provider: CryptoProviderId; result: T }[],
  key: (result: T) => unknown,
  merge: (a: T, b: T) => T,
) {
  if (!results.length) return { agreement: "unavailable", result: null, observations: [] };
  if (results.length === 1)
    return { agreement: "single", result: results[0].result, observations: [] };
  const [a, b] = results;
  return JSON.stringify(key(a.result)) === JSON.stringify(key(b.result))
    ? { agreement: "agreed", result: merge(a.result, b.result), observations: [] }
    : { agreement: "conflict", result: null, observations: results };
}
const outcomeOf = (read: unknown) => {
  const { agreement, result, observations } = read as Record<string, unknown>;
  return { agreement, result, observations };
};
function sourceNotes(agreement: string, behaviors: Record<string, string>) {
  const notes = new Set<string>();
  if (agreement === "single") notes.add("single-source");
  if (agreement === "conflict") notes.add("providers-conflict");
  if (Object.values(behaviors).includes("rate-limited")) notes.add("provider-wait");
  return notes;
}

const REST_BEHAVIORS = ["ok", "ok", "ok", "not-found", "rate-limited", "http-error", "invalid", "redirect", "too-large"] as const;
type RestBehavior = (typeof REST_BEHAVIORS)[number];
const REST_OUTCOME: Record<RestBehavior, string> = {
  ok: "answered",
  "not-found": "not-found",
  "rate-limited": "rate-limited",
  "http-error": "http-error",
  invalid: "invalid-response",
  redirect: "http-error",
  "too-large": "too-large",
};
function restFailure(behavior: string, wait: number): Response | null {
  if (behavior === "not-found") return new Response("Transaction not found", { status: 404 });
  if (behavior === "rate-limited")
    return new Response("Too Many Requests", { status: 429, headers: { "retry-after": String(wait) } });
  if (behavior === "http-error") return new Response("Internal error", { status: 500 });
  if (behavior === "redirect")
    return new Response(null, { status: 302, headers: { location: `https://elsewhere.example/${SECRET}` } });
  if (behavior === "too-large") return new Response("x".repeat(2_000_001));
  return null;
}

const RPC_BEHAVIORS = ["ok", "ok", "ok", "not-found", "rate-limited", "wrong-network", "wrong-id", "rpc-error", "invalid"] as const;
type RpcBehavior = (typeof RPC_BEHAVIORS)[number] | "processing";
const RPC_OUTCOME: Record<RpcBehavior, string> = {
  ok: "answered",
  processing: "answered",
  "not-found": "not-found",
  "rate-limited": "rate-limited",
  "wrong-network": "wrong-network",
  "wrong-id": "invalid-response",
  "rpc-error": "rpc-error",
  invalid: "invalid-response",
};
function rpcFailure(call: Call, behavior: RpcBehavior, wait: number): Response | null {
  if (behavior === "rate-limited")
    return new Response("Too Many Requests", { status: 429, headers: { "retry-after": String(wait) } });
  if (behavior === "wrong-id") return json({ jsonrpc: "2.0", id: call.rpc!.id + 1000, result: null });
  if (behavior === "rpc-error")
    return json({ jsonrpc: "2.0", id: call.rpc!.id, error: { code: -32000, message: SECRET } });
  return null;
}

type BitcoinFixture = {
  txid: string;
  weight: number;
  fee: number;
  inputs: { address: string; value: number }[];
  outputs: { address: string | null; value: number }[];
  block: { height: number; hash: string; time: number } | null;
};
function bitcoinTx(
  draw: Rng,
  txid: string,
  confirmed: boolean,
  party?: { address: string; side: "in" | "out" },
): BitcoinFixture {
  const outputs: BitcoinFixture["outputs"] = Array.from({ length: draw.int(1, 3) }, () => ({
    address: draw.pick(BTC_ADDRESSES),
    value: draw.int(546, 50_000_000),
  }));
  if (draw.chance(0.2)) outputs.push({ address: null, value: 0 });
  const fee = draw.int(150, 40_000);
  const total = outputs.reduce((sum, output) => sum + output.value, 0) + fee;
  const split = draw.chance(0.5) ? draw.int(1, total - 1) : total;
  const inputs = [{ address: draw.pick(BTC_ADDRESSES), value: split }];
  if (split < total) inputs.push({ address: draw.pick(BTC_ADDRESSES), value: total - split });
  if (party?.side === "in") inputs[0].address = party.address;
  if (party?.side === "out") outputs[0].address = party.address;
  return {
    txid,
    weight: draw.int(400, 4_000),
    fee,
    inputs,
    outputs,
    block: confirmed
      ? { height: draw.int(850_000, 900_000), hash: hex(draw, 32), time: draw.int(1_700_000_000, 1_790_000_000) }
      : null,
  };
}
const esploraJson = (tx: BitcoinFixture) => ({
  txid: tx.txid,
  version: 2,
  locktime: 0,
  size: Math.floor(tx.weight / 4),
  weight: tx.weight,
  fee: tx.fee,
  vin: tx.inputs.map((input) => ({
    txid: "ab".repeat(32),
    vout: 0,
    prevout: {
      scriptpubkey: "0014",
      scriptpubkey_asm: "OP_0",
      scriptpubkey_type: "v0_p2wpkh",
      scriptpubkey_address: input.address,
      value: input.value,
    },
    scriptsig: "",
    scriptsig_asm: "",
    witness: ["3044"],
    is_coinbase: false,
    sequence: 4294967293,
  })),
  vout: tx.outputs.map((output) =>
    output.address === null
      ? { scriptpubkey: "6a04", scriptpubkey_asm: "OP_RETURN", scriptpubkey_type: "op_return", value: 0 }
      : {
          scriptpubkey: "0014",
          scriptpubkey_asm: "OP_0",
          scriptpubkey_type: "v0_p2wpkh",
          scriptpubkey_address: output.address,
          value: output.value,
        },
  ),
  status: tx.block
    ? { confirmed: true, block_height: tx.block.height, block_hash: tx.block.hash, block_time: tx.block.time }
    : { confirmed: false },
});
function bitcoinFacts(tx: BitcoinFixture, confirmations: number | null) {
  const vsize = Math.ceil(tx.weight / 4);
  const tenths = Math.round((tx.fee * 10) / vsize);
  const totalOut = tx.outputs.reduce((sum, output) => sum + output.value, 0);
  return {
    chain: "bitcoin",
    txid: tx.txid,
    state: tx.block ? "confirmed" : "unconfirmed",
    blockHeight: tx.block?.height ?? null,
    blockHash: tx.block?.hash ?? null,
    blockTime: tx.block ? iso(tx.block.time) : null,
    confirmations,
    coinbase: false,
    feeSats: String(tx.fee),
    feeBtc: decimal(BigInt(tx.fee), 8),
    vsize,
    feeRateSatVb: `${Math.floor(tenths / 10)}.${tenths % 10}`,
    inputCount: tx.inputs.length,
    outputCount: tx.outputs.length,
    inputs: tx.inputs.map((input) => ({ address: input.address, valueSats: String(input.value) })),
    outputs: tx.outputs.map((output) => ({
      address: output.address,
      valueSats: String(output.value),
      kind: output.address === null ? "op_return" : "address",
    })),
    totalOutSats: String(totalOut),
    totalOutBtc: decimal(BigInt(totalOut), 8),
  };
}
type Found<T> = { found: true; tx: T } | { found: false };
const lowerConfirmations = <T extends { confirmations: number | null }>(a: Found<T>, b: Found<T>): Found<T> =>
  a.found && b.found
    ? {
        found: true,
        tx: {
          ...a.tx,
          confirmations:
            a.tx.confirmations === null || b.tx.confirmations === null
              ? null
              : Math.min(a.tx.confirmations, b.tx.confirmations),
        },
      }
    : a;
const withoutConfirmations = <T>(result: Found<T>) =>
  result.found ? { ...result.tx, confirmations: null } : result;

function ethereumFixture(draw: Rng) {
  const hash = "0x" + hex(draw, 32);
  const from = "0x" + hex(draw, 20);
  const to = "0x" + hex(draw, 20);
  const state = draw.pick(["succeeded", "failed", "pending"] as const);
  const value = draw.chance(0.4) ? 0n : BigInt(draw.int(1, 2 ** 40)) * 1_000_000n;
  const nonce = draw.int(0, 5_000);
  const gasUsed = BigInt(draw.int(21_000, 400_000));
  const price = BigInt(draw.int(1, 200)) * 1_000_000_000n + BigInt(draw.int(0, 999));
  const blob = draw.chance(0.2) ? { used: 131_072n, price: BigInt(draw.int(1, 1_000)) } : null;
  const block =
    state === "pending"
      ? null
      : { number: draw.int(21_000_000, 24_000_000), hash: "0x" + hex(draw, 32), time: draw.int(1_700_000_000, 1_790_000_000) };
  const transfers =
    state === "succeeded"
      ? Array.from({ length: draw.int(0, 3) }, () => ({
          token: draw.chance(0.5) ? USDC_ETH : "0x" + hex(draw, 20),
          from: "0x" + hex(draw, 20),
          to: "0x" + hex(draw, 20),
          amount: draw.chance(0.2) ? 0n : BigInt(draw.int(1, 2 ** 40)),
        }))
      : [];
  const others = state === "succeeded" ? draw.int(0, 2) : 0;
  const input = transfers.length ? "0xa9059cbb" + hex(draw, 64) : draw.pick(["0x", "0x", "0xd0e30db0"]);
  const logs = [
    ...transfers.map((transfer, index) => ({
      address: transfer.token,
      topics: [TRANSFER, topic(transfer.from), topic(transfer.to)],
      data: word(transfer.amount),
      logIndex: quantity(index),
      removed: false,
    })),
    ...Array.from({ length: others }, (_, index) => ({
      address: "0x" + hex(draw, 20),
      topics: [APPROVAL, topic(from), topic(to)],
      data: word(1n),
      logIndex: quantity(transfers.length + index),
      removed: false,
    })),
  ];
  const txJson = {
    hash,
    from,
    to,
    value: quantity(value),
    nonce: quantity(nonce),
    input,
    gas: quantity(500_000),
    gasPrice: quantity(price),
    type: "0x2",
    chainId: "0x1",
    blockNumber: block ? quantity(block.number) : null,
    blockHash: block?.hash ?? null,
    transactionIndex: block ? "0x0" : null,
  };
  const receiptJson = block
    ? {
        transactionHash: hash,
        status: state === "succeeded" ? "0x1" : "0x0",
        from,
        to,
        contractAddress: null,
        gasUsed: quantity(gasUsed),
        cumulativeGasUsed: quantity(gasUsed),
        effectiveGasPrice: quantity(price),
        blockNumber: quantity(block.number),
        blockHash: block.hash,
        logs,
        type: "0x2",
        ...(blob ? { blobGasUsed: quantity(blob.used), blobGasPrice: quantity(blob.price) } : {}),
      }
    : null;
  return { hash, from, to, state, value, nonce, gasUsed, price, blob, block, transfers, others, input, txJson, receiptJson };
}
type EthereumFixture = ReturnType<typeof ethereumFixture>;
function ethereumFacts(fx: EthereumFixture, confirmations: number | null) {
  const fee = fx.block ? fx.gasUsed * fx.price + (fx.blob ? fx.blob.used * fx.blob.price : 0n) : null;
  return {
    chain: "ethereum",
    hash: fx.hash,
    state: fx.state,
    from: fx.from,
    to: fx.to,
    contractCreated: null,
    nonce: String(fx.nonce),
    valueWei: String(fx.value),
    valueEth: decimal(fx.value, 18),
    valueMoved: fx.state === "succeeded" && fx.value > 0n,
    feeWei: fee === null ? null : String(fee),
    feeEth: fee === null ? null : decimal(fee, 18),
    gasUsed: fx.block ? String(fx.gasUsed) : null,
    blockNumber: fx.block?.number ?? null,
    blockHash: fx.block?.hash ?? null,
    blockTime: fx.block ? iso(fx.block.time) : null,
    confirmations,
    selector: fx.input.length >= 10 ? fx.input.slice(0, 10) : null,
    tokenTransfers: fx.transfers.map((transfer) => ({
      token: transfer.token,
      label: transfer.token === USDC_ETH ? "USDC" : null,
      from: transfer.from,
      to: transfer.to,
      amountRaw: String(transfer.amount),
      amount: transfer.token === USDC_ETH ? decimal(transfer.amount, 6) : null,
    })),
    tokenTransferCount: fx.transfers.length,
    otherLogCount: fx.others,
  };
}
function ethereumRoute(
  fx: EthereumFixture,
  behaviors: Record<(typeof ETHEREUM_RPC)[number], RpcBehavior>,
  tips: Record<(typeof ETHEREUM_RPC)[number], number>,
  waits: Record<(typeof ETHEREUM_RPC)[number], number> = { publicnode: 60, drpc: 60 },
) {
  return (call: Call) => {
    const provider = call.provider as (typeof ETHEREUM_RPC)[number];
    const behavior = behaviors[provider];
    const failure = rpcFailure(call, behavior, waits[provider]);
    if (failure) return failure;
    const { method, params } = call.rpc!;
    if (method === "eth_chainId") return rpcReply(call, behavior === "wrong-network" ? "0x89" : "0x1");
    if (method === "eth_blockNumber") return rpcReply(call, quantity(tips[provider]));
    if (method === "eth_getBlockByHash")
      return rpcReply(
        call,
        fx.block && params[0] === fx.block.hash
          ? { hash: fx.block.hash, number: quantity(fx.block.number), timestamp: quantity(fx.block.time), transactions: [fx.hash] }
          : null,
      );
    if (behavior === "not-found") return rpcReply(call, null);
    if (method === "eth_getTransactionByHash")
      return rpcReply(call, behavior === "invalid" ? { ...fx.txJson, hash: "0x" + "ee".repeat(32) } : fx.txJson);
    if (method === "eth_getTransactionReceipt") return rpcReply(call, fx.receiptJson);
    throw new Error(`Unexpected method ${method}`);
  };
}

function solanaFixture(draw: Rng) {
  const signature = solanaSignature(draw);
  const otherSignature = solanaSignature(draw);
  const payer = solanaAddress(draw);
  const recipient = solanaAddress(draw);
  const failed = draw.chance(0.3);
  const fee = draw.int(5_000, 90_000);
  const lamports = draw.chance(0.3) ? 0 : draw.int(1, 5_000_000_000);
  const accounts = [payer, recipient, solanaAddress(draw), solanaAddress(draw), SYSTEM];
  const pre = [draw.int(fee + lamports, 900_000_000_000), draw.int(0, 10_000_000_000), 2_039_280, 2_039_280, 1];
  const post = [...pre];
  post[0] -= fee;
  if (!failed) {
    post[0] -= lamports;
    post[1] += lamports;
  }
  const mint = draw.chance(0.5) ? USDC_SOL : solanaAddress(draw);
  const decimals = mint === USDC_SOL ? 6 : draw.int(0, 9);
  const amount = draw.chance(0.4) ? 0n : BigInt(draw.int(1, 1_000_000_000));
  const payerTokens = amount + BigInt(draw.int(0, 1_000_000));
  const recipientTokens = BigInt(draw.int(0, 1_000_000));
  const balance = (accountIndex: number, owner: string, raw: bigint) => ({
    accountIndex,
    mint,
    owner,
    programId: SPL_TOKEN,
    uiTokenAmount: { amount: String(raw), decimals, uiAmount: null, uiAmountString: "0" },
  });
  const preTokens = [balance(2, payer, payerTokens), balance(3, recipient, recipientTokens)];
  const postTokens = failed
    ? preTokens
    : [balance(2, payer, payerTokens - amount), balance(3, recipient, recipientTokens + amount)];
  const err = failed ? { InstructionError: [1, { Custom: 6001 }] } : null;
  const slot = draw.int(300_000_000, 400_000_000);
  const blockTime = draw.int(1_700_000_000, 1_790_000_000);
  const txJson = {
    slot,
    blockTime,
    version: 0,
    meta: {
      err,
      status: err ? { Err: err } : { Ok: null },
      fee,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: preTokens,
      postTokenBalances: postTokens,
      innerInstructions: [],
      logMessages: [`Program log: Memo ${SECRET}`],
      computeUnitsConsumed: 1_400,
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: accounts.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: index < 4, source: "transaction" })),
        instructions: [],
        recentBlockhash: solanaAddress(draw),
      },
    },
  };
  return { signature, otherSignature, payer, recipient, failed, fee, lamports, accounts, pre, post, mint, decimals, amount, err, slot, blockTime, txJson };
}
type SolanaFixture = ReturnType<typeof solanaFixture>;
type Commitment = "processed" | "confirmed" | "finalized";
const RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };
function solanaFacts(fx: SolanaFixture, commitment: Commitment) {
  const label = fx.mint === USDC_SOL ? "USDC" : null;
  const moved = !fx.failed && fx.amount > 0n;
  const token = (account: string, owner: string, change: bigint) => ({
    account,
    owner,
    mint: fx.mint,
    label,
    decimals: fx.decimals,
    changeRaw: String(change),
    change: decimal(change, fx.decimals),
  });
  return {
    chain: "solana",
    signature: fx.signature,
    state: fx.failed ? "failed" : "succeeded",
    commitment,
    slot: fx.slot,
    blockTime: iso(fx.blockTime),
    feeLamports: String(fx.fee),
    feeSol: decimal(BigInt(fx.fee), 9),
    feePayer: fx.payer,
    error: fx.failed ? { kind: "InstructionError", instruction: 1, detail: "Custom", code: 6001 } : null,
    solChanges: fx.accounts.flatMap((account, index) => {
      const change = BigInt(fx.post[index]) - BigInt(fx.pre[index]);
      return change === 0n ? [] : [{ account, changeLamports: String(change), changeSol: decimal(change, 9) }];
    }),
    tokenChanges: moved
      ? [token(fx.accounts[2], fx.payer, -fx.amount), token(fx.accounts[3], fx.recipient, fx.amount)]
      : [],
    accountCount: 5,
    omittedChanges: 0,
  };
}
const processingFacts = (fx: SolanaFixture) => ({
  chain: "solana",
  signature: fx.signature,
  state: "processing",
  commitment: "processed",
  slot: fx.slot,
  blockTime: null,
  feeLamports: null,
  feeSol: null,
  feePayer: null,
  error: null,
  solChanges: [],
  tokenChanges: [],
  accountCount: 0,
  omittedChanges: 0,
});
function solanaRoute(
  fx: SolanaFixture,
  behaviors: Record<(typeof SOLANA_RPC)[number], RpcBehavior>,
  commitments: Record<(typeof SOLANA_RPC)[number], Commitment>,
  waits: Record<(typeof SOLANA_RPC)[number], number>,
) {
  return (call: Call) => {
    const provider = call.provider as (typeof SOLANA_RPC)[number];
    const behavior = behaviors[provider];
    const failure = rpcFailure(call, behavior, waits[provider]);
    if (failure) return failure;
    const { method } = call.rpc!;
    if (method === "getGenesisHash")
      return rpcReply(call, behavior === "wrong-network" ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" : GENESIS);
    if (method === "getSignatureStatuses") {
      if (behavior === "not-found") return rpcReply(call, { context: { slot: fx.slot + 50 }, value: [null] });
      const commitment = behavior === "processing" ? "processed" : commitments[provider];
      return rpcReply(call, {
        context: { slot: fx.slot + 50 },
        value: [
          {
            slot: fx.slot,
            confirmations: commitment === "finalized" ? null : 3,
            err: fx.err,
            status: fx.err ? { Err: fx.err } : { Ok: null },
            confirmationStatus: commitment,
          },
        ],
      });
    }
    if (method === "getTransaction") {
      if (behavior === "not-found" || behavior === "processing") return rpcReply(call, null);
      if (behavior === "invalid")
        return rpcReply(call, { ...fx.txJson, transaction: { ...fx.txJson.transaction, signatures: [fx.otherSignature] } });
      return rpcReply(call, fx.txJson);
    }
    throw new Error(`Unexpected method ${method}`);
  };
}

describe("public chain reads", () => {
  simulate("reads a Bitcoin transaction from two Esplora operators and reports each one as it answered", async (draw) => {
    for (let round = 0; round < 10; round++) {
      const tx = bitcoinTx(draw, hex(draw, 32), draw.chance(0.7));
      const behaviors = { "mempool.space": draw.pick(REST_BEHAVIORS), "blockstream.info": draw.pick(REST_BEHAVIORS) };
      const height = tx.block?.height ?? 0;
      const tips = { "mempool.space": height + draw.int(0, 6), "blockstream.info": height + draw.int(0, 6) };
      const waits = { "mempool.space": draw.int(1, 900), "blockstream.info": draw.int(1, 900) };
      const net = network((call) => {
        const provider = call.provider as (typeof ESPLORA)[number];
        if (call.url.endsWith("/blocks/tip/height")) return new Response(String(tips[provider]));
        const behavior = behaviors[provider];
        return (
          restFailure(behavior, waits[provider]) ??
          json(behavior === "invalid" ? { ...esploraJson(tx), fee: tx.fee + 1 } : esploraJson(tx))
        );
      });
      const query = {
        chain: "bitcoin",
        txid: draw.chance(0.5) ? tx.txid.toUpperCase() : tx.txid,
        evidence: { kind: "permalink", url: `https://${draw.pick(ESPLORA)}/tx/${tx.txid}#${SECRET}` },
        // A field a caller adds by mistake is never read.
        prompt: SECRET,
      } as CryptoTxQuery;
      const read = await readCryptoTransaction(query, deps(net.fetch));
      expectEgress(net.calls, [tx.txid]);
      const reading = await cryptoChainReader(deps(net.fetch))(
        { chain: "bitcoin", subject: "transaction", value: tx.txid, permalink: "https://mempool.space/tx/" + tx.txid },
        { signal: new AbortController().signal, deadlineMs: 8_000 },
      );
      if (reading.ok) expect(reading.answeredProviders).toEqual(ESPLORA.filter(provider => behaviors[provider] === "ok"));
      const confirmations = (provider: (typeof ESPLORA)[number]) =>
        tx.block ? tips[provider] - tx.block.height + 1 : null;
      const results = ESPLORA.flatMap((provider) =>
        behaviors[provider] === "ok"
          ? [{ provider, result: { found: true, tx: bitcoinFacts(tx, confirmations(provider)) } as Found<ReturnType<typeof bitcoinFacts>> }]
          : behaviors[provider] === "not-found"
            ? [{ provider, result: { found: false } as Found<ReturnType<typeof bitcoinFacts>> }]
            : [],
      );
      const expected = expectedAgreement(results, withoutConfirmations, lowerConfirmations);
      expect(read).toMatchObject({ kind: "read", chain: "bitcoin", id: tx.txid, checkedAt: CHECKED_AT });
      expect(outcomeOf(read)).toEqual(expected);
      expect((read as { sources: unknown }).sources).toEqual(
        ESPLORA.map((provider) => ({
          provider,
          outcome: REST_OUTCOME[behaviors[provider]],
          ...(behaviors[provider] === "rate-limited" ? { retryAfterSeconds: waits[provider] } : {}),
          requests: behaviors[provider] === "ok" && tx.block ? 2 : 1,
        })),
      );
      const notes = sourceNotes(expected.agreement, behaviors);
      if (expected.result && !expected.result.found) notes.add("not-found-meaning");
      if (expected.result?.found && !tx.block) notes.add("unconfirmed-can-change");
      expect(new Set((read as { notes: string[] }).notes)).toEqual(notes);
      expect(JSON.stringify(read)).not.toContain(SECRET);
    }
  });

  simulate("reads an Ethereum transaction from two public RPC operators with exact value and fee meaning", async (draw) => {
    for (let round = 0; round < 10; round++) {
      const fx = ethereumFixture(draw);
      const behaviors = { publicnode: draw.pick(RPC_BEHAVIORS), drpc: draw.pick(RPC_BEHAVIORS) };
      const height = fx.block?.number ?? 0;
      const tips = { publicnode: height + draw.int(0, 30), drpc: height + draw.int(0, 30) };
      const waits = { publicnode: draw.int(1, 900), drpc: draw.int(1, 900) };
      const order: string[] = [];
      const route = ethereumRoute(fx, behaviors, tips, waits);
      const net = network((call) => {
        order.push(call.rpc!.method);
        return route(call);
      });
      const guard = vi.fn(async (hash: string) => {
        order.push(`guard ${hash}`);
        return { outcome: "clear" as const };
      });
      const guarded = draw.chance(0.5);
      const read = await readCryptoTransaction(
        {
          chain: "ethereum",
          hash: draw.chance(0.5) ? "0x" + fx.hash.slice(2).toUpperCase() : fx.hash,
          evidence: guarded
            ? { kind: "key-guard", check: guard }
            : { kind: "permalink", url: `https://${draw.pick(["etherscan.io", "www.etherscan.io", "eth.blockscout.com"])}/tx/${fx.hash}#${SECRET}` },
        },
        deps(net.fetch),
      );
      if (guarded) {
        expect(guard).toHaveBeenCalledTimes(1);
        expect(order[0]).toBe(`guard ${fx.hash}`);
      } else expect(guard).not.toHaveBeenCalled();
      expectEgress(net.calls, fx.block ? [fx.hash, fx.block.hash] : [fx.hash]);
      const confirmations = (provider: (typeof ETHEREUM_RPC)[number]) =>
        fx.block ? tips[provider] - fx.block.number + 1 : null;
      type Facts = ReturnType<typeof ethereumFacts>;
      const results = ETHEREUM_RPC.flatMap((provider) =>
        behaviors[provider] === "ok"
          ? [{ provider, result: { found: true, tx: ethereumFacts(fx, confirmations(provider)) } as Found<Facts> }]
          : behaviors[provider] === "not-found"
            ? [{ provider, result: { found: false } as Found<Facts> }]
            : [],
      );
      const expected = expectedAgreement(results, withoutConfirmations, lowerConfirmations);
      expect(read).toMatchObject({ kind: "read", chain: "ethereum", id: fx.hash, checkedAt: CHECKED_AT });
      expect(outcomeOf(read)).toEqual(expected);
      expect((read as { sources: unknown }).sources).toEqual(
        ETHEREUM_RPC.map((provider) => ({
          provider,
          outcome: RPC_OUTCOME[behaviors[provider]],
          ...(behaviors[provider] === "rate-limited" ? { retryAfterSeconds: waits[provider] } : {}),
          requests: behaviors[provider] === "ok" && fx.block ? 5 : 3,
        })),
      );
      const notes = sourceNotes(expected.agreement, behaviors);
      const result = expected.result as Found<Facts> | null;
      if (result && !result.found) {
        notes.add("not-found-meaning");
        notes.add("ethereum-mainnet-only");
      }
      if (result?.found) {
        if (fx.state === "failed") notes.add("failed-fee-charged");
        if (fx.state === "pending") notes.add("pending-no-fee-yet");
        if (result.tx.selector !== null) notes.add("internal-transfers-not-shown");
        if (result.tx.tokenTransfers.some((transfer) => transfer.label === null)) notes.add("unreviewed-token");
        if (result.tx.tokenTransfers.some((transfer) => transfer.amountRaw === "0")) notes.add("zero-value-token-transfer");
      }
      expect(new Set((read as { notes: string[] }).notes)).toEqual(notes);
    }
  });

  simulate("reads a Solana transaction at confirmed commitment with the fee paid even on failure", async (draw) => {
    const behaviorsFor = [...RPC_BEHAVIORS, "processing"] as const;
    for (let round = 0; round < 10; round++) {
      const fx = solanaFixture(draw);
      const behaviors = { "solana-foundation": draw.pick(behaviorsFor), "publicnode-solana": draw.pick(behaviorsFor) };
      const commitments = {
        "solana-foundation": draw.pick(["confirmed", "finalized"] as const),
        "publicnode-solana": draw.pick(["confirmed", "finalized"] as const),
      };
      const waits = { "solana-foundation": draw.int(1, 900), "publicnode-solana": draw.int(1, 900) };
      const net = network(solanaRoute(fx, behaviors, commitments, waits));
      const read = await readCryptoTransaction({ chain: "solana", signature: fx.signature }, deps(net.fetch));
      expectEgress(net.calls, [fx.signature]);
      type Facts = ReturnType<typeof solanaFacts> | ReturnType<typeof processingFacts>;
      const results = SOLANA_RPC.flatMap((provider) =>
        behaviors[provider] === "ok"
          ? [{ provider, result: { found: true, tx: solanaFacts(fx, commitments[provider]) } as Found<Facts> }]
          : behaviors[provider] === "processing"
            ? [{ provider, result: { found: true, tx: processingFacts(fx) } as Found<Facts> }]
            : behaviors[provider] === "not-found"
              ? [{ provider, result: { found: false } as Found<Facts> }]
              : [],
      );
      const expected = expectedAgreement(
        results,
        (result) => (result.found ? { ...result.tx, commitment: null } : result),
        (a, b) =>
          a.found && b.found
            ? {
                found: true,
                tx: {
                  ...a.tx,
                  commitment:
                    RANK[a.tx.commitment as Commitment] <= RANK[b.tx.commitment as Commitment]
                      ? a.tx.commitment
                      : b.tx.commitment,
                },
              }
            : a,
      );
      expect(read).toMatchObject({ kind: "read", chain: "solana", id: fx.signature, checkedAt: CHECKED_AT });
      expect(outcomeOf(read)).toEqual(expected);
      expect((read as { sources: unknown }).sources).toEqual(
        SOLANA_RPC.map((provider) => ({
          provider,
          outcome: RPC_OUTCOME[behaviors[provider]],
          ...(behaviors[provider] === "rate-limited" ? { retryAfterSeconds: waits[provider] } : {}),
          requests: 3,
        })),
      );
      const notes = sourceNotes(expected.agreement, behaviors);
      const result = expected.result as Found<Facts> | null;
      if (result && !result.found) notes.add("not-found-meaning");
      if (result?.found && result.tx.state === "failed") notes.add("failed-fee-charged");
      if (result?.found && result.tx.tokenChanges.some((change) => change.label === null)) notes.add("unreviewed-token");
      expect(new Set((read as { notes: string[] }).notes)).toEqual(notes);
      expect(JSON.stringify(read)).not.toContain(SECRET);
    }
  });

  simulate("lists a Bitcoin address newest first with its own received and sent amounts", async (draw) => {
    for (let round = 0; round < 6; round++) {
      const address = draw.pick(BTC_ADDRESSES);
      const side = () => draw.pick(["in", "out"] as const);
      const pending = Array.from({ length: draw.int(0, 2) }, () => bitcoinTx(draw, hex(draw, 32), false, { address, side: side() }));
      let height = 899_000;
      const mined = Array.from({ length: draw.int(0, 5) }, () => {
        const tx = bitcoinTx(draw, hex(draw, 32), true, { address, side: side() });
        height -= draw.int(1, 500);
        tx.block!.height = height;
        return tx;
      });
      const all = [...pending, ...mined];
      const lagging = pending.length > 0 && draw.chance(0.5);
      const listed = { "mempool.space": all, "blockstream.info": lagging ? all.slice(1) : all };
      const behaviors = {
        "mempool.space": draw.pick(["ok", "ok", "rate-limited", "invalid"] as const),
        "blockstream.info": draw.pick(["ok", "ok", "http-error"] as const),
      };
      const stranger = BTC_ADDRESSES.find((other) => other !== address)!;
      const unrelated = bitcoinTx(draw, hex(draw, 32), true);
      for (const part of [...unrelated.inputs, ...unrelated.outputs]) if (part.address !== null) part.address = stranger;
      const net = network((call) => {
        const provider = call.provider as (typeof ESPLORA)[number];
        const failure = restFailure(behaviors[provider], 300);
        if (failure) return failure;
        const list = listed[provider].map(esploraJson);
        return json(behaviors[provider] === "invalid" ? [...list, esploraJson(unrelated)] : list);
      });
      const read = await readCryptoAddressActivity({ chain: "bitcoin", address }, deps(net.fetch));
      expectEgress(net.calls, [address]);
      const answered = ESPLORA.filter((provider) => behaviors[provider] === "ok");
      const seen = new Map<string, CryptoProviderId[]>();
      for (const provider of answered)
        for (const tx of listed[provider]) seen.set(tx.txid, [...(seen.get(tx.txid) ?? []), provider]);
      const items = all
        .filter((tx) => seen.has(tx.txid))
        .map((tx) => {
          const received = tx.outputs.filter((output) => output.address === address).reduce((sum, output) => sum + output.value, 0);
          const sent = tx.inputs.filter((input) => input.address === address).reduce((sum, input) => sum + input.value, 0);
          const seenBy = seen.get(tx.txid)!;
          return {
            txid: tx.txid,
            state: tx.block ? "confirmed" : "unconfirmed",
            blockHeight: tx.block?.height ?? null,
            blockTime: tx.block ? iso(tx.block.time) : null,
            receivedSats: String(received),
            sentSats: String(sent),
            netSats: String(received - sent),
            netBtc: decimal(BigInt(received - sent), 8),
            feeSats: String(tx.fee),
            seenBy,
            agreement: seenBy.length === 2 ? "agreed" : "single",
          };
        });
      const agreement = !answered.length
        ? "unavailable"
        : answered.length === 2 && items.every((item) => item.agreement === "agreed")
          ? "agreed"
          : "single";
      expect(read).toMatchObject({ kind: "read", chain: "bitcoin", address, checkedAt: CHECKED_AT, agreement });
      expect((read as { activity: unknown }).activity).toEqual(
        answered.length ? { chain: "bitcoin", items, history: { shown: items.length, complete: true } } : null,
      );
      expect((read as { sources: unknown }).sources).toEqual(
        ESPLORA.map((provider) => ({
          provider,
          outcome:
            behaviors[provider] === "ok"
              ? listed[provider].length
                ? "answered"
                : "not-found"
              : REST_OUTCOME[behaviors[provider]],
          ...(behaviors[provider] === "rate-limited" ? { retryAfterSeconds: 300 } : {}),
          requests: 1,
        })),
      );
      const notes = sourceNotes(agreement, behaviors);
      if (items.some((item) => item.state === "unconfirmed")) notes.add("unconfirmed-can-change");
      expect(new Set((read as { notes: string[] }).notes)).toEqual(notes);
    }
  });

  it("marks Bitcoin history partial when Esplora returns its full page", async () => {
    const draw = rng(5);
    let height = 899_000;
    const txs = Array.from({ length: 25 }, () => {
      const tx = bitcoinTx(draw, hex(draw, 32), true, { address: P2WPKH, side: "out" });
      tx.block!.height = height--;
      return tx;
    });
    const net = network(() => json(txs.map(esploraJson)));
    const read = (await readCryptoAddressActivity({ chain: "bitcoin", address: P2WPKH, limit: 3 }, deps(net.fetch))) as {
      agreement: string;
      activity: { items: { txid: string }[]; history: unknown };
      notes: string[];
    };
    expect(read.agreement).toBe("agreed");
    expect(read.activity.items.map((item) => item.txid)).toEqual(txs.slice(0, 3).map((tx) => tx.txid));
    expect(read.activity.history).toEqual({ shown: 3, complete: false });
    expect(read.notes).toContain("history-partial");
  });

  it("reads Ethereum address history from Blockscout as one source with only reviewed token names", async () => {
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const self = checksummed.toLowerCase();
    const other = "0x" + "22".repeat(20);
    const spoof = "0x" + "33".repeat(20);
    const sender = "0x" + "44".repeat(20);
    const time = "2026-11-27T11:59:00.000000Z";
    const pages: Record<string, unknown> = {
      transactions: {
        items: [
          { hash: "0x" + "a1".repeat(32), from: { hash: other }, to: { hash: checksummed }, value: "1500000000000000000", fee: { type: "actual", value: "420000000000000" }, status: "ok", result: "success", block_number: 21_000_002, timestamp: time, method: "Claim reward at evil.example" },
          { hash: "0x" + "a2".repeat(32), from: { hash: checksummed }, to: { hash: other }, value: "2000000000000000000", fee: { type: "actual", value: "21000000000000" }, status: "error", result: "Reverted", block_number: 21_000_001, timestamp: time },
          { hash: "0x" + "a3".repeat(32), from: { hash: checksummed }, to: { hash: checksummed }, value: "0", fee: { type: "maximum", value: "999" }, status: null, result: "pending", block_number: null, timestamp: null },
        ],
        next_page_params: { block_number: 21_000_000, index: 0, items_count: 50 },
      },
      "token-transfers": {
        items: [
          { transaction_hash: "0x" + "b1".repeat(32), log_index: 7, block_number: 21_000_003, timestamp: time, from: { hash: other }, to: { hash: checksummed }, token: { address_hash: USDC_ETH, symbol: "USDC", name: "USD Coin", decimals: "6", type: "ERC-20" }, total: { decimals: "6", value: "2500000" }, type: "token_transfer" },
          { transaction_hash: "0x" + "b2".repeat(32), log_index: 1, block_number: 21_000_000, timestamp: time, from: { hash: sender }, to: { hash: checksummed }, token: { address_hash: spoof, symbol: "USDC", name: "USD Coin Official", decimals: "6", type: "ERC-20" }, total: { decimals: "6", value: "0" }, type: "token_transfer" },
          { transaction_hash: "0x" + "b3".repeat(32), log_index: 2, block_number: 20_999_999, timestamp: time, from: { hash: other }, to: { hash: checksummed }, token: { address_hash: "0x" + "55".repeat(20), symbol: "NFT", type: "ERC-721" }, total: { token_id: "1" }, type: "token_transfer" },
        ],
        next_page_params: null,
      },
    };
    const net = network((call) => json(pages[call.url.split("/").pop()!]));
    const read = await readCryptoAddressActivity({ chain: "ethereum", address: checksummed }, deps(net.fetch));
    expectEgress(net.calls, [self]);
    const at = "2026-11-27T11:59:00Z";
    expect(read).toEqual({
      kind: "read",
      chain: "ethereum",
      address: self,
      checkedAt: CHECKED_AT,
      agreement: "single",
      activity: {
        chain: "ethereum",
        transactions: [
          { hash: "0x" + "a1".repeat(32), state: "succeeded", blockNumber: 21_000_002, time: at, from: other, to: self, direction: "in", valueWei: "1500000000000000000", valueEth: "1.5", valueMoved: true, feeWei: "420000000000000", feeEth: "0.00042" },
          { hash: "0x" + "a2".repeat(32), state: "failed", blockNumber: 21_000_001, time: at, from: self, to: other, direction: "out", valueWei: "2000000000000000000", valueEth: "2", valueMoved: false, feeWei: "21000000000000", feeEth: "0.000021" },
          { hash: "0x" + "a3".repeat(32), state: "pending", blockNumber: null, time: null, from: self, to: self, direction: "self", valueWei: "0", valueEth: "0", valueMoved: false, feeWei: null, feeEth: null },
        ],
        tokenTransfers: [
          { token: USDC_ETH, label: "USDC", from: other, to: self, amountRaw: "2500000", amount: "2.5", hash: "0x" + "b1".repeat(32), logIndex: 7, blockNumber: 21_000_003, time: at, direction: "in" },
          { token: spoof, label: null, from: sender, to: self, amountRaw: "0", amount: null, hash: "0x" + "b2".repeat(32), logIndex: 1, blockNumber: 21_000_000, time: at, direction: "in" },
        ],
        history: {
          transactions: { shown: 3, complete: false },
          tokenTransfers: { shown: 2, complete: true },
        },
      },
      sources: [{ provider: "blockscout", outcome: "answered", requests: 2 }],
      notes: expect.any(Array),
    });
    expect(new Set((read as { notes: string[] }).notes)).toEqual(
      new Set([
        "single-source",
        "ethereum-mainnet-only",
        "history-partial",
        "failed-fee-charged",
        "pending-no-fee-yet",
        "unreviewed-token",
        "zero-value-token-transfer",
        "internal-transfers-not-shown",
        "free-text-omitted",
      ]),
    );
    expect(JSON.stringify(read)).not.toContain("evil.example");
    expect(JSON.stringify(read)).not.toContain("USD Coin");
  });

  it("keeps the token list when Blockscout refuses the transaction list, and says so", async () => {
    const self = "0x" + "11".repeat(20);
    const state = createCryptoProviderState();
    const net = network((call) =>
      call.url.endsWith("/transactions")
        ? new Response(null, { status: 429, headers: { "retry-after": "30" } })
        : json({
            items: [
              { transaction_hash: "0x" + "c1".repeat(32), log_index: 0, block_number: 21_000_000, timestamp: "2026-11-27T11:00:00.000000Z", from: { hash: "0x" + "22".repeat(20) }, to: { hash: self }, token: { address_hash: USDC_ETH, type: "ERC-20" }, total: { decimals: "6", value: "1000000" } },
            ],
            next_page_params: null,
          }),
    );
    const read = (await readCryptoAddressActivity({ chain: "ethereum", address: self }, deps(net.fetch, state))) as {
      agreement: string;
      activity: { transactions: unknown[]; tokenTransfers: { amount: string }[]; history: unknown };
      sources: unknown;
      notes: string[];
    };
    expect(read.agreement).toBe("single");
    expect(read.activity.transactions).toEqual([]);
    expect(read.activity.tokenTransfers.map((transfer) => transfer.amount)).toEqual(["1"]);
    expect(read.activity.history).toEqual({
      transactions: { shown: 0, complete: false },
      tokenTransfers: { shown: 1, complete: true },
    });
    expect(read.sources).toEqual([{ provider: "blockscout", outcome: "rate-limited", retryAfterSeconds: 30, requests: 2 }]);
    expect(read.notes).toEqual(expect.arrayContaining(["ordinary-history-unavailable", "provider-wait", "history-partial"]));
    expect(state.cooldownUntil.get("blockscout")).toBe(T0 + 30_000);
  });

  it("reads a Solana wallet with its reviewed token accounts and this wallet's own changes", async () => {
    const draw = rng(9);
    const wallet = solanaAddress(draw);
    const sender = solanaAddress(draw);
    const senderUsdc = solanaAddress(draw);
    const usdcAccount = tokenAccount(USDC_SOL, wallet);
    const usdtAccount = tokenAccount(USDT_SOL, wallet);
    const [s1, s2, s3, s4] = Array.from({ length: 4 }, () => solanaSignature(draw));
    const failure = { InstructionError: [0, "InvalidAccountData"] };
    const entry = (signature: string, slot: number, failed = false, commitment = "finalized") => ({
      signature,
      slot,
      err: failed ? failure : null,
      memo: `[12] ${SECRET}`,
      blockTime: 1_790_000_000 + slot,
      confirmationStatus: commitment,
    });
    const lists = (fresh: string): Record<string, unknown[]> => ({
      [wallet]: [entry(s1, 300, false, fresh), entry(s3, 280, true), entry(s4, 270)],
      [usdcAccount]: [entry(s2, 290)],
      [usdtAccount]: [],
    });
    const histories: Record<string, Record<string, unknown[]>> = {
      "solana-foundation": lists("confirmed"),
      "publicnode-solana": lists("finalized"),
    };
    const usdc = (accountIndex: number, owner: string, amount: number) => ({
      accountIndex,
      mint: USDC_SOL,
      owner,
      programId: SPL_TOKEN,
      uiTokenAmount: { amount: String(amount), decimals: 6 },
    });
    const tx = (
      signature: string,
      slot: number,
      accounts: string[],
      pre: number[],
      post: number[],
      preTokens: unknown[] = [],
      postTokens: unknown[] = [],
      err: unknown = null,
    ) => ({
      slot,
      blockTime: 1_790_000_000 + slot,
      meta: { err, fee: 5_000, preBalances: pre, postBalances: post, preTokenBalances: preTokens, postTokenBalances: postTokens, logMessages: [SECRET] },
      transaction: { signatures: [signature], message: { accountKeys: accounts.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: true, source: "transaction" })) } },
    });
    const transactions: Record<string, unknown> = {
      [s1]: tx(s1, 300, [sender, wallet, SYSTEM], [10_000_000_000, 1_000_000_000, 1], [7_999_995_000, 3_000_000_000, 1]),
      [s2]: tx(
        s2,
        290,
        [sender, senderUsdc, usdcAccount, SPL_TOKEN],
        [5_000_000_000, 2_039_280, 2_039_280, 1],
        [4_999_995_000, 2_039_280, 2_039_280, 1],
        [usdc(1, sender, 9_000_000), usdc(2, wallet, 1_000_000)],
        [usdc(1, sender, 4_000_000), usdc(2, wallet, 6_000_000)],
      ),
      [s3]: tx(s3, 280, [wallet, sender, SYSTEM], [1_000_000_000, 0, 1], [999_995_000, 0, 1], [], [], failure),
    };
    const net = network((call) => {
      const provider = call.provider as (typeof SOLANA_RPC)[number];
      const { method, params } = call.rpc!;
      if (method === "getGenesisHash") return rpcReply(call, GENESIS);
      if (method === "getSignaturesForAddress") return rpcReply(call, histories[provider][params[0] as string] ?? []);
      if (method === "getTransaction") return rpcReply(call, transactions[params[0] as string] ?? null);
      throw new Error(`Unexpected method ${method}`);
    });
    const read = await readCryptoAddressActivity({ chain: "solana", address: wallet }, deps(net.fetch));
    expectEgress(net.calls, [wallet, usdcAccount, usdtAccount, s1, s2, s3]);
    const both = ["solana-foundation", "publicnode-solana"];
    const change = (sol: string, lamports: string, feePaid: boolean, tokens: unknown[] = []) => ({
      solChangeLamports: lamports,
      solChange: sol,
      feePaid,
      feeLamports: feePaid ? "5000" : "0",
      tokens,
      seenBy: both,
    });
    const item = (signature: string, slot: number, state: string, commitment: string, itemChange: unknown) => ({
      signature,
      slot,
      blockTime: iso(1_790_000_000 + slot),
      state,
      commitment,
      seenBy: both,
      agreement: "agreed",
      change: itemChange,
    });
    expect(read).toEqual({
      kind: "read",
      chain: "solana",
      address: wallet,
      checkedAt: CHECKED_AT,
      agreement: "agreed",
      activity: {
        chain: "solana",
        accounts: [wallet, usdcAccount, usdtAccount],
        items: [
          item(s1, 300, "succeeded", "confirmed", change("2", "2000000000", false)),
          item(s2, 290, "succeeded", "finalized", change("0", "0", false, [{ mint: USDC_SOL, label: "USDC", decimals: 6, changeRaw: "5000000", change: "5" }])),
          item(s3, 280, "failed", "finalized", change("-0.000005", "-5000", true)),
          item(s4, 270, "succeeded", "finalized", null),
        ],
        history: { shown: 4, complete: true },
      },
      sources: [
        { provider: "solana-foundation", outcome: "answered", requests: 7 },
        { provider: "publicnode-solana", outcome: "answered", requests: 7 },
      ],
      notes: expect.any(Array),
    });
    expect(new Set((read as { notes: string[] }).notes)).toEqual(
      new Set(["failed-fee-charged", "solana-token-accounts", "free-text-omitted"]),
    );
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  it("sends nothing for a bare hash, a mismatched link, a suspected key or a keypair", async () => {
    const net = network(() => {
      throw new Error("No request is expected.");
    });
    const txid = "ab".repeat(32);
    const hash = "0x" + "cd".repeat(32);
    const keypair = await solanaKeypair(new Uint8Array(32).fill(9));
    const cases: [CryptoTxQuery, string][] = [
      [{ chain: "bitcoin", txid, evidence: undefined as never }, "evidence-required"],
      [{ chain: "bitcoin", txid, evidence: { kind: "permalink", url: `https://mempool.space/testnet/tx/${txid}` } }, "evidence-required"],
      [{ chain: "bitcoin", txid, evidence: { kind: "permalink", url: `https://mempool.space/tx/${"ef".repeat(32)}` } }, "evidence-mismatch"],
      [{ chain: "bitcoin", txid, evidence: { kind: "permalink", url: `https://etherscan.io/tx/0x${txid}` } }, "evidence-mismatch"],
      [{ chain: "bitcoin", txid, evidence: { kind: "key-guard", check: async () => ({ outcome: "clear" }) } }, "evidence-required"],
      [{ chain: "bitcoin", txid: "0x" + txid, evidence: { kind: "permalink", url: `https://mempool.space/tx/${txid}` } }, "invalid-id"],
      [{ chain: "ethereum", hash, evidence: { kind: "permalink", url: `https://etherscan.io/tx/${hash}?a=1` } }, "evidence-required"],
      [{ chain: "ethereum", hash, evidence: { kind: "permalink", url: `https://basescan.org/tx/${hash}` } }, "evidence-required"],
      [{ chain: "ethereum", hash, evidence: { kind: "key-guard", check: async () => ({ outcome: "suspected" }) } }, "key-suspected"],
      [{ chain: "ethereum", hash, evidence: { kind: "key-guard", check: async () => ({ outcome: "unavailable", reason: "provider-error" }) } }, "key-guard-unavailable"],
      [{ chain: "ethereum", hash, evidence: { kind: "key-guard", check: async () => { throw new Error("The guard is down."); } } }, "key-guard-unavailable"],
      [{ chain: "ethereum", hash: hash.slice(0, -2), evidence: { kind: "permalink", url: `https://etherscan.io/tx/${hash}` } }, "invalid-id"],
      [{ chain: "solana", signature: keypair }, "keypair"],
      [{ chain: "solana", signature: SECRET }, "invalid-id"],
    ];
    for (const [query, reason] of cases)
      expect(await readCryptoTransaction(query, deps(net.fetch)), reason).toEqual({ kind: "refused", chain: query.chain, reason });
    const addresses: [CryptoAddressQuery, string][] = [
      [{ chain: "bitcoin", address: WIF }, "private-key"],
      [{ chain: "bitcoin", address: XPRV }, "private-key"],
      [{ chain: "bitcoin", address: txid }, "invalid-address"],
      [{ chain: "ethereum", address: hash }, "invalid-address"],
      [{ chain: "solana", address: keypair }, "keypair"],
      [{ chain: "solana", address: base58Encode(new Uint8Array(64).fill(3)) }, "invalid-address"],
      [{ chain: "dogecoin" as CryptoChain, address: SATOSHI }, "unsupported-chain"],
    ];
    for (const [query, reason] of addresses)
      expect(await readCryptoAddressActivity(query, deps(net.fetch)), reason).toEqual({ kind: "refused", chain: query.chain, reason });
    expect(net.calls).toEqual([]);
  });

  it("accepts only exact mainnet explorer links as evidence", () => {
    const txid = "ab".repeat(32);
    const hash = "0x" + "cd".repeat(32);
    expect(parseCryptoTxPermalink(`https://mempool.space/tx/${txid}`)).toEqual({ chain: "bitcoin", txid });
    expect(parseCryptoTxPermalink(`https://blockstream.info/tx/${txid.toUpperCase()}/`)).toEqual({ chain: "bitcoin", txid });
    expect(parseCryptoTxPermalink(`https://mempool.space/tx/${txid}#vout=1`)).toEqual({ chain: "bitcoin", txid });
    expect(parseCryptoTxPermalink(`https://etherscan.io/tx/${hash}`)).toEqual({ chain: "ethereum", hash });
    expect(parseCryptoTxPermalink(`https://www.etherscan.io/tx/${hash}`)).toEqual({ chain: "ethereum", hash });
    expect(parseCryptoTxPermalink(`https://eth.blockscout.com/tx/${hash}`)).toEqual({ chain: "ethereum", hash });
    for (const url of [
      txid,
      hash,
      `http://mempool.space/tx/${txid}`,
      `https://mempool.space/testnet/tx/${txid}`,
      `https://mempool.space/signet/tx/${txid}`,
      `https://mempool.space/tx/${txid}?showFlow=1`,
      `https://mempool.space:8443/tx/${txid}`,
      `https://user@mempool.space/tx/${txid}`,
      `https://mempool.space.elsewhere.example/tx/${txid}`,
      `https://mempool.space/tx/0x${txid}`,
      `https://etherscan.io/tx/${txid}`,
      `https://sepolia.etherscan.io/tx/${hash}`,
      `https://etherscan.io/address/${hash.slice(0, 42)}`,
      `https://etherscan.io/tx/${hash}ff`,
      `https://etherscan.io/tx/${hash} https://elsewhere.example`,
    ])
      expect(parseCryptoTxPermalink(url), url).toBeNull();
  });

  it("normalizes mainnet addresses and names a pasted private key", async () => {
    const keypair = await solanaKeypair(new Uint8Array(32).fill(4));
    const compressedWif = base58Check([0x80, ...Array<number>(32).fill(0x11), 0x01]);
    const accepted: [CryptoChain, string, string][] = [
      ["bitcoin", SATOSHI, SATOSHI],
      ["bitcoin", P2SH, P2SH],
      ["bitcoin", P2WPKH.toUpperCase(), P2WPKH],
      ["bitcoin", P2WSH, P2WSH],
      ["bitcoin", P2TR, P2TR],
      ["ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"],
      ["ethereum", "0x52908400098527886E0F7030069857D2E4169EE7", "0x52908400098527886e0f7030069857d2e4169ee7"],
      ["ethereum", "0xde709f2102306220921060314715629080e2fb77", "0xde709f2102306220921060314715629080e2fb77"],
      ["solana", USDC_SOL, USDC_SOL],
      ["solana", SYSTEM, SYSTEM],
    ];
    for (const [chain, input, address] of accepted)
      expect(await parseCryptoAddress(chain, input), input).toEqual({ ok: true, address });
    const refused: [CryptoChain, string, string][] = [
      ["bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "invalid-address"],
      ["bitcoin", "bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "invalid-address"],
      ["bitcoin", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "invalid-address"],
      ["bitcoin", "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "invalid-address"],
      ["bitcoin", SATOSHI.slice(0, -1) + "b", "invalid-address"],
      ["bitcoin", "ab".repeat(32), "invalid-address"],
      ["bitcoin", WIF, "private-key"],
      ["bitcoin", compressedWif, "private-key"],
      ["bitcoin", XPRV, "private-key"],
      ["ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", "invalid-address"],
      ["ethereum", "0x" + "ab".repeat(32), "invalid-address"],
      ["ethereum", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "invalid-address"],
      ["solana", keypair, "keypair"],
      ["solana", "0x" + "ab".repeat(20), "invalid-address"],
    ];
    for (const [chain, input, reason] of refused)
      expect(await parseCryptoAddress(chain, input), input).toEqual({ ok: false, reason });
  });

  it("waits out Retry-After per provider and never asks a waiting provider", async () => {
    const draw = rng(42);
    const tx = bitcoinTx(draw, hex(draw, 32), true);
    const state = createCryptoProviderState();
    let now = T0;
    let limited = true;
    const net = network((call) => {
      if (call.url.endsWith("/blocks/tip/height")) return new Response(String(tx.block!.height + 2));
      if (call.provider === "mempool.space" && limited)
        return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      return json(esploraJson(tx));
    });
    const query: CryptoTxQuery = {
      chain: "bitcoin",
      txid: tx.txid,
      evidence: { kind: "permalink", url: `https://mempool.space/tx/${tx.txid}` },
    };
    const lookup = async (at: number) => {
      now = at;
      return (await readCryptoTransaction(query, deps(net.fetch, state, () => now))) as {
        agreement: string;
        sources: { provider: string; outcome: string }[];
      };
    };
    const first = await lookup(T0);
    expect(first.agreement).toBe("single");
    expect(first.sources).toEqual([
      { provider: "mempool.space", outcome: "rate-limited", retryAfterSeconds: 120, requests: 1 },
      { provider: "blockstream.info", outcome: "answered", requests: 2 },
    ]);
    limited = false;
    const before = net.calls.length;
    const second = await lookup(T0 + 60_000);
    expect(net.calls.slice(before).map((call) => call.provider)).toEqual(["blockstream.info", "blockstream.info"]);
    expect(second.sources[0]).toEqual({ provider: "mempool.space", outcome: "cooling-down", retryAfterSeconds: 60, requests: 0 });
    const third = await lookup(T0 + 120_000);
    expect(third.agreement).toBe("agreed");
    expect(third.sources.map((source) => source.outcome)).toEqual(["answered", "answered"]);
  });

  it("reads Retry-After as an HTTP date and keeps a 503 without it an ordinary error", async () => {
    const txid = "12".repeat(32);
    const state = createCryptoProviderState();
    const net = network((call) =>
      call.provider === "mempool.space"
        ? new Response(null, { status: 503, headers: { "retry-after": new Date(T0 + 90_000).toUTCString() } })
        : new Response(null, { status: 503 }),
    );
    const read = await readCryptoTransaction(
      { chain: "bitcoin", txid, evidence: { kind: "permalink", url: `https://blockstream.info/tx/${txid}` } },
      deps(net.fetch, state),
    );
    expect((read as { sources: unknown }).sources).toEqual([
      { provider: "mempool.space", outcome: "rate-limited", retryAfterSeconds: 90, requests: 1 },
      { provider: "blockstream.info", outcome: "http-error", requests: 1 },
    ]);
    expect(state.cooldownUntil.get("mempool.space")).toBe(T0 + 90_000);
    expect(state.cooldownUntil.has("blockstream.info")).toBe(false);
  });

  it("treats a JSON-RPC rate-limit error as a one-minute wait", async () => {
    const hash = "0x" + "12".repeat(32);
    const state = createCryptoProviderState();
    const net = network((call) =>
      call.provider === "publicnode"
        ? json({ jsonrpc: "2.0", id: call.rpc!.id, error: { code: -32005, message: "limit exceeded" } })
        : rpcReply(call, call.rpc!.method === "eth_chainId" ? "0x1" : null),
    );
    const read = (await readCryptoTransaction(
      { chain: "ethereum", hash, evidence: { kind: "permalink", url: `https://etherscan.io/tx/${hash}` } },
      deps(net.fetch, state),
    )) as { agreement: string; result: unknown; sources: unknown; notes: string[] };
    expect(read.sources).toEqual([
      { provider: "publicnode", outcome: "rate-limited", retryAfterSeconds: 60, requests: 3 },
      { provider: "drpc", outcome: "not-found", requests: 3 },
    ]);
    expect(read.agreement).toBe("single");
    expect(read.result).toEqual({ found: false });
    expect(new Set(read.notes)).toEqual(
      new Set(["single-source", "provider-wait", "not-found-meaning", "ethereum-mainnet-only"]),
    );
    expect(state.cooldownUntil.get("publicnode")).toBe(T0 + 60_000);
  });

  it("checks each RPC provider's network once per ten minutes", async () => {
    const draw = rng(11);
    const fx = ethereumFixture(draw);
    const height = fx.block?.number ?? 0;
    const state = createCryptoProviderState();
    let now = T0;
    const net = network(ethereumRoute(fx, { publicnode: "ok", drpc: "ok" }, { publicnode: height + 1, drpc: height + 1 }));
    const query: CryptoTxQuery = {
      chain: "ethereum",
      hash: fx.hash,
      evidence: { kind: "permalink", url: `https://etherscan.io/tx/${fx.hash}` },
    };
    const chainIds = () => net.calls.filter((call) => call.rpc?.method === "eth_chainId").length;
    await readCryptoTransaction(query, deps(net.fetch, state, () => now));
    expect(chainIds()).toBe(2);
    now = T0 + 9 * 60_000;
    expect(await readCryptoTransaction(query, deps(net.fetch, state, () => now))).toMatchObject({ agreement: "agreed" });
    expect(chainIds()).toBe(2);
    now = T0 + 10 * 60_000 + 1;
    await readCryptoTransaction(query, deps(net.fetch, state, () => now));
    expect(chainIds()).toBe(4);
  });

  it("stops a silent provider at the deadline and does not try again", async () => {
    const urls: string[] = [];
    const fetch = (url: string, init: RequestInit) => {
      urls.push(url);
      return new Promise<Response>((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    };
    const txid = "34".repeat(32);
    const read = await readCryptoTransaction(
      { chain: "bitcoin", txid, evidence: { kind: "permalink", url: `https://mempool.space/tx/${txid}` } },
      { fetch, now: () => T0, deadlineMs: 25, state: createCryptoProviderState() },
    );
    expect(read).toMatchObject({
      agreement: "unavailable",
      result: null,
      sources: [
        { provider: "mempool.space", outcome: "timeout", requests: 1 },
        { provider: "blockstream.info", outcome: "timeout", requests: 1 },
      ],
    });
    expect(urls).toEqual([`${BASES["mempool.space"]}/tx/${txid}`, `${BASES["blockstream.info"]}/tx/${txid}`]);
  });
});
