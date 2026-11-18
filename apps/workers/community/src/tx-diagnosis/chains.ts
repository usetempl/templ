import { featureOn, type WorkspaceFlagEnv } from "../workspace-flags";
import { namedEvmChain } from "@templ/chat/legacy-exit-chains";
import type { DiagnosisNetwork, EvmNetwork } from "@templ/chat/diagnosis/types";
import {
  diagnosisEndpoints,
  diagnosisPrimaryEndpoint,
  solanaDiagnosisPrimaryEndpoint,
  type ChainRpcEnv,
} from "../chain-rpc";
import { solanaEndpoints, type SolanaRpcEnv } from "../solana";

/** The worker's transaction-check chain table. A row names a chain the read
 * layer knows how to read; it reads nothing by itself. */
export type DiagnosisChain = {
  id: number;
  network: EvmNetwork;
  name: string;
  /** "https://basescan.org/tx/{hash}" */
  explorerTx: string;
  native: string;
  /** Etherscan V2 serves verified sources for this chain. */
  etherscan: boolean;
  /** Blockscout API base for verified sources, or null. */
  blockscout: string | null;
  /** Latest-head age that counts as stale. */
  maxHeadAgeSeconds: number;
  /** R3 chain watches only; diagnosis finality uses the finalized tag. */
  watchConfirmations: number;
  probeOrder: number;
};

const row = (
  id: number,
  native: string,
  probeOrder: number,
  sources: { etherscan: boolean; blockscout?: string | null },
): DiagnosisChain => {
  const chain = namedEvmChain(id);
  if (!chain) throw new Error(`No named chain ${id}`);
  return {
    id,
    network: `eip155:${id}`,
    name: chain.name,
    explorerTx: chain.tx,
    native,
    etherscan: sources.etherscan,
    blockscout: sources.blockscout ?? null,
    maxHeadAgeSeconds: 90,
    watchConfirmations: 64,
    probeOrder,
  };
};

/** In probe order. Fantom and Gnosis are legacy exits: rows exist so a
 * founder-confirmed pair can turn them on later, and none does today. */
export const DIAGNOSIS_CHAIN_TABLE: readonly DiagnosisChain[] = Object.freeze(
  [
    row(1, "ETH", 1, { etherscan: true }),
    row(8453, "ETH", 2, { etherscan: true }),
    row(42161, "ETH", 3, { etherscan: true }),
    row(10, "ETH", 4, { etherscan: true }),
    row(137, "POL", 5, { etherscan: true }),
    row(56, "BNB", 6, { etherscan: true }),
    row(146, "S", 7, { etherscan: true }),
    row(747474, "ETH", 8, { etherscan: false }),
    row(4663, "ETH", 9, {
      etherscan: false,
      blockscout: "https://robinhoodchain.blockscout.com",
    }),
    row(250, "FTM", 10, { etherscan: false }),
    row(100, "xDAI", 11, { etherscan: true }),
  ].map((item) => Object.freeze(item)),
);

export type DiagnosisEnv = WorkspaceFlagEnv &
  ChainRpcEnv &
  SolanaRpcEnv & {
    /** "true" turns transaction checks on; anything else keeps them off. */
    SUPPORT_DIAGNOSIS_ENABLED?: string;
    /** Explicit source policy; absent preserves independent reads. */
    SUPPORT_DIAGNOSIS_RPC_MODE?: string;
    /** Policy var from the release manifest: a JSON list of chain ids as
     * strings, numbers ascending then "solana". Absent or invalid is []. */
    SUPPORT_DIAGNOSIS_CHAINS?: string;
  };

const CHAIN_ID = /^[1-9][0-9]{0,15}$/;

/** The policy var, parsed strictly. Anything but the exact projection shape
 * (strings, unique, numbers ascending, "solana" last) turns every chain off. */
export function parseDiagnosisChainsVar(
  value: string | undefined,
): (number | "solana")[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > 32) return [];
  const out: (number | "solana")[] = [];
  let last = 0;
  let solana = false;
  for (const item of parsed) {
    if (item === "solana" && !solana) {
      solana = true;
      out.push("solana");
      continue;
    }
    if (typeof item !== "string" || solana || !CHAIN_ID.test(item)) return [];
    const id = Number(item);
    if (!Number.isSafeInteger(id) || id <= last) return [];
    last = id;
    out.push(id);
  }
  return out;
}

/** EVM rows Templ reads now: SUPPORT_DIAGNOSIS_ENABLED is "true", the chain
 * is in SUPPORT_DIAGNOSIS_CHAINS, and its selected source policy is
 * present and exact. Secrets alone never turn a chain on. */
export function enabledDiagnosisChains(env: DiagnosisEnv): DiagnosisChain[] {
  if (!featureOn(env, undefined, "diagnosis.evm")) return [];
  return keyGuardChains(env);
}

/** Key checks use the global chain policy, independent of workspace flags. */
export function keyGuardChains(env: DiagnosisEnv): DiagnosisChain[] {
  if (env.SUPPORT_DIAGNOSIS_ENABLED !== "true") return [];
  const listed = new Set(parseDiagnosisChainsVar(env.SUPPORT_DIAGNOSIS_CHAINS));
  return DIAGNOSIS_CHAIN_TABLE.filter(
    (chain) =>
      listed.has(chain.id) &&
      (env.SUPPORT_DIAGNOSIS_RPC_MODE === "alchemy"
        ? diagnosisPrimaryEndpoint(env, chain.id)
        : diagnosisEndpoints(env, chain.id)),
  ).sort((a, b) => a.probeOrder - b.probeOrder);
}

export function keyGuardNetworks(env: DiagnosisEnv): (EvmNetwork | "solana")[] {
  return [
    ...keyGuardChains(env).map((chain) => chain.network),
    ...(env.SUPPORT_DIAGNOSIS_ENABLED === "true" ? ["solana" as const] : []),
  ];
}

/** Solana checks: on, listed, with the explicitly selected source policy configured. */
export function solanaDiagnosisEnabled(env: DiagnosisEnv): boolean {
  if (!featureOn(env, undefined, "diagnosis.solana")) return false;
  if (!parseDiagnosisChainsVar(env.SUPPORT_DIAGNOSIS_CHAINS).includes("solana"))
    return false;
  if (env.SUPPORT_DIAGNOSIS_RPC_MODE === "alchemy")
    return !!solanaDiagnosisPrimaryEndpoint(env);
  try {
    solanaEndpoints(env);
    return true;
  } catch {
    return false;
  }
}

/** The value of the edge-only header that tells the room which networks are
 * on: "eip155:1,eip155:8453,solana". Empty means off. */
export function diagnosisNetworksHeader(env: DiagnosisEnv): string {
  return enabledDiagnosisNetworks(env).join(",");
}

/** This workspace's gates, chain list and provider pairs decide its networks. */
export function enabledDiagnosisNetworks(
  env: DiagnosisEnv,
): DiagnosisNetwork[] {
  return [
    ...enabledDiagnosisChains(env).map((chain) => chain.network),
    ...(solanaDiagnosisEnabled(env) ? ["solana" as const] : []),
  ];
}
