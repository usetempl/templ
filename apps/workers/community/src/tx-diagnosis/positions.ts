/** Pinned position reads for one proven wallet.
 *
 * EVM: at an agreed block (and optionally an earlier one the team names),
 * the wallet's share balance of a vault or receipt token from the protocol
 * profile, its value through the profile's conversion (`convertToAssets`
 * for ERC-4626 vaults, `pricePerShare` for share-price vaults), and the
 * vault's `totalAssets`. Every call is pinned to the agreed block by hash
 * and both providers must return the same value.
 *
 * Solana: SPL token balances only, at finalized commitment on both
 * providers. There is no share-price read and no program-account decoding.
 *
 * Reads only: nothing here signs, sends or simulates on anyone's behalf,
 * and the calls go through the transaction check's read layer and budget. */
import type { AgreedBlock, Quantity } from "@templ/chat/diagnosis/types";
import { isSolanaAddress } from "@templ/chat/solana";
import { diagnosisEndpoints } from "../chain-rpc";
import { solanaEndpoints } from "../solana";
import { agreedValue, pairFailure, type ReadFailure } from "./agree";
import { createRunMeter } from "./budgets";
import {
  enabledDiagnosisChains,
  solanaDiagnosisEnabled,
  type DiagnosisEnv,
} from "./chains";
import { agreedBlockByNumber, agreedLatestHead, chainIdMatches } from "./heads";
import { createDiagnosisRpc, type DiagnosisRpc, type Fetcher } from "./rpc";

/** Function selectors of the reads (fixed; no ABI decoding). */
export const POSITION_SELECTORS = {
  balanceOf: "0x70a08231",
  convertToAssets: "0x07a2d13a",
  pricePerShare: "0x99530b06",
  totalAssets: "0x01e1d114",
} as const;
export type PositionConversion = "erc4626" | "price-per-share" | "one-to-one";
export type EvmPositionInput = {
  network: `eip155:${number}`;
  /** The vault or receipt token (profile entry), lowercase hex. */
  token: string;
  /** The member's proven wallet, lowercase hex. */
  wallet: string;
  conversion: PositionConversion | null;
  /** An earlier block to read too, below the agreed head. */
  compareBlock: number | null;
};
export type EvmPositionPoint = {
  block: number;
  /** Raw integers as decimal strings. */
  shares: string;
  assets: string | null;
  pricePerShare: string | null;
  totalAssets: string | null;
};
export type PositionReadFailure =
  | ReadFailure
  | "not-configured"
  | "call-error"
  | "bad-input";
export type EvmPositionRead =
  | { kind: "ok"; points: EvmPositionPoint[] }
  | { kind: "unavailable"; reason: PositionReadFailure };
export type SplBalanceRead =
  | { kind: "ok"; amount: string; decimals: number; accounts: number }
  | { kind: "unavailable"; reason: PositionReadFailure };
export type PositionReadDeps = { fetcher?: Fetcher; now?: () => number };

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const pad32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const toQuantity = (value: number) => `0x${value.toString(16)}` as Quantity;
function uint256(raw: unknown): string {
  if (typeof raw !== "string" || !WORD.test(raw)) throw new Error("word");
  return BigInt(raw).toString();
}
async function callAt(
  rpc: DiagnosisRpc,
  block: AgreedBlock,
  to: string,
  data: string,
): Promise<
  { ok: true; value: string } | { ok: false; reason: PositionReadFailure }
> {
  const pair = await rpc.both("eth_call", [
    { to, data },
    { blockHash: block.hash, requireCanonical: true },
  ]);
  if (pair.some((side) => side.error))
    return { ok: false, reason: "call-error" };
  const read = agreedValue(pair, uint256);
  return read.kind === "agreed"
    ? { ok: true, value: read.value }
    : { ok: false, reason: read.reason };
}
/** The wallet's position in one profile token at the agreed head (and an
 * earlier block when asked), each value agreed by both providers. */
export async function readEvmPosition(
  env: DiagnosisEnv,
  input: EvmPositionInput,
  deps: PositionReadDeps = {},
): Promise<EvmPositionRead> {
  if (!HEX_ADDRESS.test(input.token) || !HEX_ADDRESS.test(input.wallet))
    return { kind: "unavailable", reason: "bad-input" };
  const chain = enabledDiagnosisChains(env).find(
    (item) => item.network === input.network,
  );
  const endpoints = chain ? diagnosisEndpoints(env, chain.id) : null;
  if (!chain || !endpoints)
    return { kind: "unavailable", reason: "not-configured" };
  const now = deps.now ?? (() => Date.now());
  const rpc = createDiagnosisRpc(env, "evm", endpoints, {
    fetcher: deps.fetcher,
    now,
    deadlineAt: now() + 15_000,
    meter: createRunMeter(24),
  });
  rpc.allowCallTo(input.token);
  const id = await chainIdMatches(rpc, chain.id);
  if (!id.ok) return { kind: "unavailable", reason: id.reason };
  const head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
  if (!head.ok) return { kind: "unavailable", reason: head.reason };
  const blocks: AgreedBlock[] = [head.block];
  if (input.compareBlock !== null) {
    if (
      !Number.isSafeInteger(input.compareBlock) ||
      input.compareBlock < 1 ||
      BigInt(input.compareBlock) >= BigInt(head.block.number)
    )
      return { kind: "unavailable", reason: "bad-input" };
    const earlier = await agreedBlockByNumber(
      rpc,
      toQuantity(input.compareBlock),
    );
    if (!earlier.ok) return { kind: "unavailable", reason: earlier.reason };
    blocks.unshift(earlier.block);
  }
  const points: EvmPositionPoint[] = [];
  for (const block of blocks) {
    const shares = await callAt(
      rpc,
      block,
      input.token,
      `${POSITION_SELECTORS.balanceOf}${pad32(input.wallet)}`,
    );
    if (!shares.ok) return { kind: "unavailable", reason: shares.reason };
    let assets: string | null = null;
    let pricePerShare: string | null = null;
    let totalAssets: string | null = null;
    if (input.conversion === "erc4626") {
      const converted = await callAt(
        rpc,
        block,
        input.token,
        `${POSITION_SELECTORS.convertToAssets}${pad32(BigInt(shares.value).toString(16))}`,
      );
      if (!converted.ok)
        return { kind: "unavailable", reason: converted.reason };
      assets = converted.value;
    }
    if (input.conversion === "price-per-share") {
      const price = await callAt(
        rpc,
        block,
        input.token,
        POSITION_SELECTORS.pricePerShare,
      );
      if (!price.ok) return { kind: "unavailable", reason: price.reason };
      pricePerShare = price.value;
    }
    if (
      input.conversion === "erc4626" ||
      input.conversion === "price-per-share"
    ) {
      const total = await callAt(
        rpc,
        block,
        input.token,
        POSITION_SELECTORS.totalAssets,
      );
      if (!total.ok) return { kind: "unavailable", reason: total.reason };
      totalAssets = total.value;
    }
    points.push({
      block: Number(BigInt(block.number)),
      shares: shares.value,
      assets,
      pricePerShare,
      totalAssets,
    });
  }
  return { kind: "ok", points };
}
type TokenAccount = {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: unknown;
          owner?: unknown;
          tokenAmount?: { amount?: unknown; decimals?: unknown };
        };
      };
    };
  };
};
/** The owner's balance of one SPL mint at finalized commitment, summed over
 * its token accounts, agreed by both providers (the context slot may
 * differ; the balance may not). */
export async function readSplBalance(
  env: DiagnosisEnv,
  input: { owner: string; mint: string },
  deps: PositionReadDeps = {},
): Promise<SplBalanceRead> {
  if (!isSolanaAddress(input.owner) || !isSolanaAddress(input.mint))
    return { kind: "unavailable", reason: "bad-input" };
  if (!solanaDiagnosisEnabled(env))
    return { kind: "unavailable", reason: "not-configured" };
  const now = deps.now ?? (() => Date.now());
  let endpoints: readonly [string, string];
  try {
    endpoints = solanaEndpoints(env);
  } catch {
    return { kind: "unavailable", reason: "not-configured" };
  }
  const rpc = createDiagnosisRpc(env, "solana", endpoints, {
    fetcher: deps.fetcher,
    now,
    deadlineAt: now() + 10_000,
    meter: createRunMeter(4),
  });
  const pair = await rpc.both("getTokenAccountsByOwner", [
    input.owner,
    { mint: input.mint },
    { encoding: "jsonParsed", commitment: "finalized" },
  ]);
  const failure = pairFailure(pair);
  if (failure) return { kind: "unavailable", reason: failure };
  const read = agreedValue(pair, (raw) => {
    const value = (raw as { value?: unknown } | null)?.value;
    if (!Array.isArray(value) || value.length > 50) throw new Error("accounts");
    let amount = 0n;
    let decimals: number | null = null;
    for (const entry of value as TokenAccount[]) {
      const info = entry?.account?.data?.parsed?.info;
      const raw = info?.tokenAmount?.amount;
      const places = info?.tokenAmount?.decimals;
      if (
        info?.mint !== input.mint ||
        info?.owner !== input.owner ||
        typeof raw !== "string" ||
        !/^[0-9]{1,30}$/.test(raw) ||
        typeof places !== "number" ||
        !Number.isSafeInteger(places) ||
        places < 0 ||
        places > 18 ||
        (decimals !== null && decimals !== places)
      )
        throw new Error("account");
      decimals = places;
      amount += BigInt(raw);
    }
    return {
      amount: amount.toString(),
      decimals: decimals ?? 0,
      accounts: value.length,
    };
  });
  return read.kind === "agreed"
    ? { kind: "ok", ...read.value }
    : { kind: "unavailable", reason: read.reason };
}
/** A raw integer with `decimals` places as a plain decimal string with at
 * most `places` fraction digits (trailing zeros dropped). */
export function formatUnits(raw: string, decimals: number, places = 6): string {
  const value = BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (decimals <= 0) return `${negative ? "-" : ""}${abs.toString()}`;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base)
    .toString()
    .padStart(decimals, "0")
    .slice(0, Math.max(0, Math.min(places, decimals)))
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}
