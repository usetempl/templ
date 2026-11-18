import type { EvmNetwork, Hex } from "@templ/chat/diagnosis/types";
import {
  diagnosisEndpoints,
  diagnosisPrimaryEndpoint,
  solanaDiagnosisPrimaryEndpoint,
} from "../chain-rpc";
import { solanaEndpoints } from "../solana";
import { createRunMeter, meterSubrequests, type RunMeter } from "./budgets";
import {
  enabledDiagnosisChains,
  keyGuardChains,
  solanaDiagnosisEnabled,
  type DiagnosisChain,
  type DiagnosisEnv,
} from "./chains";
import { checkEvmKeyGuard, guardNetworks, isSolanaKeypair } from "./key-guard";
import type {
  DiagnosisReadResult,
  DiagnosisReads,
  DiagnosisRunPlan,
} from "./plan";
import {
  NO_PROFILE,
  safeProfileSource,
  type DiagnosisProfileSource,
} from "./profile";
import { readEvmInput, type EvmEnrichment } from "./read-evm";
import { errorAbiFor, methodFactFor } from "./decode";
import { tokenFactsFor } from "./tokens";
import { readSolanaInput } from "./read-solana";
import {
  createDiagnosisRpc,
  createPrimaryDiagnosisRpc,
  type DiagnosisRpc,
  type Fetcher,
} from "./rpc";

export type * from "./plan";
export type { DiagnosisEnv } from "./chains";

export type ReadDeps = {
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  profile?: DiagnosisProfileSource;
  enrich?: EvmEnrichment;
  meter?: RunMeter;
};

/** Solana providers whose history is complete (the archival allowlist). A
 * dRPC confirmation endpoint is keyed but not on it. */
const ARCHIVAL_SOLANA_HOSTS = new Set([
  "mainnet.helius-rpc.com",
  "solana-mainnet.g.alchemy.com",
  "solana-mainnet.core.chainstack.com",
]);

/** The kept decoder core and token reads, through this run's clients. */
export function defaultEnrichment(
  env: DiagnosisEnv,
  deps: { fetcher?: Fetcher; now?: () => number } = {},
): EvmEnrichment {
  const decodeDeps = {
    fetcher: deps.fetcher as typeof fetch | undefined,
    now: deps.now,
  };
  return {
    method: (input) => methodFactFor(env, input, decodeDeps),
    errorAbi: (input) => errorAbiFor(env, input, decodeDeps),
    tokens: (input) => tokenFactsFor(env, input),
  };
}

/** Reads what the engine needs for one planned check, at the edge, under
 * the request's RPC budget. The key guard runs before any value leaves
 * Templ. Never throws for chain trouble; a programming error (an unlisted
 * method) still throws. */
export async function readDiagnosisInput(
  env: DiagnosisEnv,
  plan: DiagnosisRunPlan,
  deps: ReadDeps = {},
): Promise<DiagnosisReadResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const primaryOnly = env.SUPPORT_DIAGNOSIS_RPC_MODE === "alchemy";
  const source = primaryOnly
    ? { readSource: { providerCount: 1 as const, source: "alchemy" as const } }
    : {};
  const meter = deps.meter ?? createRunMeter();
  const touched = new Set<string>();
  const reads = (): DiagnosisReads => ({
    calls: meter.calls,
    attempts: meter.attempts,
    primaryCu: meter.primaryCu,
    confirmationAttempts: meter.confirmationAttempts,
    subrequests: meterSubrequests(meter),
    ms: Math.max(0, now() - started),
    networks: [...touched],
    budgetLimited: meter.budgetLimited,
  });
  const rpcDeps = {
    fetcher: deps.fetcher,
    now,
    sleep: deps.sleep,
    deadlineAt: plan.deadlineAt,
    meter,
  };
  if (plan.subject.kind === "solana") {
    // A pasted Solana keypair is refused locally; nothing is sent.
    if (await isSolanaKeypair(plan.subject.signature))
      return { kind: "refused-key", reads: reads() };
    if (plan.trigger === "key-guard")
      return { kind: "guard-clear", reads: reads() };
    let rpc: DiagnosisRpc | null = null;
    let archival = false;
    if (solanaDiagnosisEnabled(env)) {
      const endpoints = primaryOnly
        ? ([solanaDiagnosisPrimaryEndpoint(env)!] as const)
        : solanaEndpoints(env);
      archival = endpoints.every((url) =>
        ARCHIVAL_SOLANA_HOSTS.has(new URL(url).hostname),
      );
      rpc =
        endpoints.length === 1
          ? createPrimaryDiagnosisRpc(env, "solana", endpoints[0], rpcDeps)
          : createDiagnosisRpc(env, "solana", endpoints, rpcDeps);
      touched.add("solana");
    }
    const input = await readSolanaInput(plan, rpc, archival);
    return {
      kind: "input",
      input: { ...input, ...source },
      reads: reads(),
      profileRefs: [],
    };
  }

  const enabled = enabledDiagnosisChains(env);
  const clients = new Map<
    EvmNetwork,
    { chain: DiagnosisChain; rpc: DiagnosisRpc }
  >();
  const client = (chain: DiagnosisChain) => {
    const existing = clients.get(chain.network);
    if (existing) return existing;
    const primary = primaryOnly
      ? diagnosisPrimaryEndpoint(env, chain.id)
      : null;
    const endpoints = primaryOnly
      ? primary
        ? ([primary] as const)
        : null
      : diagnosisEndpoints(env, chain.id);
    if (!endpoints) return null;
    const entry = {
      chain,
      rpc:
        endpoints.length === 1
          ? createPrimaryDiagnosisRpc(env, "evm", endpoints[0], rpcDeps)
          : createDiagnosisRpc(env, "evm", endpoints, rpcDeps),
    };
    clients.set(chain.network, entry);
    return entry;
  };
  const hash = plan.subject.hash as Hex;
  if (plan.keyGuard || plan.trigger === "key-guard") {
    const guards = guardNetworks(keyGuardChains(env), plan.guardNetworks)
      .map(client)
      .filter((item) => item !== null);
    for (const guard of guards) touched.add(guard.chain.network);
    const guard = await checkEvmKeyGuard(hash, guards);
    if (guard.outcome === "suspected")
      return { kind: "refused-key", reads: reads() };
    if (plan.trigger === "key-guard")
      return { kind: "guard-clear", reads: reads() };
    if (guard.outcome === "unavailable") {
      // Fail closed: the value is never sent when the guard could not read.
      const networks = plan.networks.filter(
        (network): network is EvmNetwork => network !== "solana",
      );
      const first = networks[0] ?? "eip155:1";
      // The guard reads the address derived from the value, not the
      // transaction, so its providers disagreeing says nothing about the
      // transaction's outcome.
      const reason =
        guard.reason === "providers-disagree" ? "provider-error" : guard.reason;
      return {
        kind: "input",
        input: {
          ...source,
          v: 1,
          kind: "evm",
          checkedAt: plan.checkedAt,
          hint: plan.hint,
          wallet: plan.wallet,
          profile: null,
          unavailable: { reason, network: first },
          hash,
          probes: (networks.length ? networks : [first]).map((network) => ({
            network,
            outcome: "unavailable" as const,
            reason,
          })),
          found: null,
          previous: plan.previous
            ? { ...plan.previous, confirmedNonceNow: null }
            : null,
        },
        reads: reads(),
        profileRefs: [],
      };
    }
  }
  for (const network of plan.networks) {
    const chain = enabled.find((item) => item.network === network);
    if (chain && client(chain)) touched.add(network);
  }
  const { input, profileRefs } = await readEvmInput(plan, {
    rpcs: clients,
    profile: safeProfileSource(deps.profile ?? NO_PROFILE),
    enrich:
      deps.enrich ?? defaultEnrichment(env, { fetcher: deps.fetcher, now }),
  });
  return {
    kind: "input",
    input: { ...input, ...source },
    reads: reads(),
    profileRefs,
  };
}
