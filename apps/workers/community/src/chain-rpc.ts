import { type ChatChainId } from "@templ/chat/chains";
import { HttpError, type Env } from "./common";

/** Runtime secrets are explicit per network. No key is copied between providers. */
export type ChainRpcEnv = Env & {
  ETHEREUM_AUTH_RPC_URL?: string;
  ETHEREUM_CONFIRMATION_RPC_URL?: string;
  BASE_AUTH_RPC_URL?: string;
  BASE_CONFIRMATION_RPC_URL?: string;
  BNB_AUTH_RPC_URL?: string;
  BNB_CONFIRMATION_RPC_URL?: string;
} & Partial<
    Record<`${DiagnosisRpcPrefix}_${"AUTH" | "CONFIRMATION"}_RPC_URL`, string>
  >;
/** Secret prefixes of the diagnosis-only chains. A prefix names where the
 * founder's keyed pair would go; it reads nothing on its own. */
export const DIAGNOSIS_RPC_PREFIXES = {
  10: "OPTIMISM",
  100: "GNOSIS",
  137: "POLYGON",
  146: "SONIC",
  250: "FANTOM",
  42161: "ARBITRUM",
  747474: "KATANA",
} as const;
export type DiagnosisRpcPrefix =
  (typeof DIAGNOSIS_RPC_PREFIXES)[keyof typeof DIAGNOSIS_RPC_PREFIXES];
type DiagnosisRpcPolicy = {
  prefix: DiagnosisRpcPrefix;
  /** Exact keyed Alchemy host, read from the founder's dashboard. */
  alchemy: string;
  /** Exact dRPC network slug, read from the founder's dashboard. */
  confirmationNetwork: string;
};
/** Documented provider rows. Deploys probe both keyed providers before use.
 * https://www.alchemy.com/docs/choosing-a-web3-network
 * https://drpc.org/docs/optimism-api
 * https://drpc.org/docs/arbitrum-api
 * Missing pairs remain off. Katana, Fantom and Gnosis have no provider row. */
export const DIAGNOSIS_RPC_POLICIES: Readonly<
  Partial<Record<keyof typeof DIAGNOSIS_RPC_PREFIXES, DiagnosisRpcPolicy>>
> = Object.freeze({
  10: {
    prefix: "OPTIMISM",
    alchemy: "opt-mainnet.g.alchemy.com",
    confirmationNetwork: "optimism",
  },
  42161: {
    prefix: "ARBITRUM",
    alchemy: "arb-mainnet.g.alchemy.com",
    confirmationNetwork: "arbitrum",
  },
});
const policies = {
  1: {
    prefix: "ETHEREUM",
    alchemy: "eth-mainnet.g.alchemy.com",
    confirmationNetwork: "ethereum",
  },
  8453: {
    prefix: "BASE",
    alchemy: "base-mainnet.g.alchemy.com",
    confirmationNetwork: "base",
  },
  56: {
    prefix: "BNB",
    alchemy: "bnb-mainnet.g.alchemy.com",
    confirmationNetwork: "bsc",
  },
  4663: {
    prefix: "ROBINHOOD",
    alchemy: "robinhood-mainnet.g.alchemy.com",
    confirmationNetwork: "robinhood",
  },
} as const;
type Policy = (typeof policies)[keyof typeof policies];
/** @public The chains with a keyed Alchemy and dRPC policy. They match the
 * `diagnosisReady` networks in SUPPORT_WALLET_CHAINS; a parity test reads it. */
export const RPC_POLICY_CHAIN_IDS = Object.keys(policies).map(Number);
const PROVIDER_KEY = /^[A-Za-z0-9_-]{8,256}$/;
function exactKeyedUrl(
  value: string | undefined,
  host: string,
  prefix: string,
) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const pathPrefix = prefix ? `/${prefix}/` : "/";
    const key = url.pathname.startsWith(pathPrefix)
      ? url.pathname.slice(pathPrefix.length)
      : "";
    const canonical = `https://${host}${pathPrefix}${key}`;
    return url.href === canonical &&
      value === canonical &&
      PROVIDER_KEY.test(key)
      ? canonical
      : null;
  } catch {
    return null;
  }
}
/** Both providers use dedicated keyed endpoints. A failed read never selects
 * another endpoint or falls back to an anonymous public service. */
const primaryFor = (value: string | undefined, policy: { alchemy: string }) =>
  exactKeyedUrl(value, policy.alchemy, "v2");
export function isPrimaryRpcEndpoint(url: URL) {
  if (exactKeyedUrl(url.href, "solana-mainnet.g.alchemy.com", "v2"))
    return true;
  if (
    exactKeyedUrl(url.href, "solana-mainnet.core.chainstack.com", "") ||
    (url.href.startsWith("https://mainnet.helius-rpc.com/?api-key=") &&
      /^[A-Za-z0-9_-]{8,256}$/.test(
        url.href.slice("https://mainnet.helius-rpc.com/?api-key=".length),
      ))
  )
    return true;
  return [...Object.values(policies), ...Object.values(DIAGNOSIS_RPC_POLICIES)]
    .filter((policy) => policy !== undefined)
    .some((policy) => primaryFor(url.href, policy) !== null);
}
/** The keyed pair a transaction check reads on this chain, or null when the
 * chain has no row or either secret is missing or malformed. Never falls back
 * to another endpoint. Whether a chain is read at all is decided by
 * enabledDiagnosisChains (tx-diagnosis/chains.ts), never by these secrets. */
export function diagnosisEndpoints(
  env: ChainRpcEnv,
  chainId: number,
): readonly [string, string] | null {
  const policy: Policy | DiagnosisRpcPolicy | undefined = Object.hasOwn(
    policies,
    chainId,
  )
    ? policies[chainId as keyof typeof policies]
    : Object.hasOwn(DIAGNOSIS_RPC_POLICIES, chainId)
      ? DIAGNOSIS_RPC_POLICIES[chainId as keyof typeof DIAGNOSIS_RPC_PREFIXES]
      : undefined;
  if (!policy) return null;
  const read = (kind: "AUTH" | "CONFIRMATION") =>
    (env as unknown as Record<string, unknown>)[
      `${policy.prefix}_${kind}_RPC_URL`
    ];
  const first = read("AUTH");
  const second = read("CONFIRMATION");
  if (typeof first !== "string" || typeof second !== "string") return null;
  const primary = primaryFor(first, policy);
  const confirmation = exactKeyedUrl(
    second,
    "lb.drpc.live",
    policy.confirmationNetwork,
  );
  return primary && confirmation ? ([primary, confirmation] as const) : null;
}
/** Two independent operators on the selected chain; never substitute a fallback
 * after a disagreement. Additional networks remain deployment-gated separately. */
export function authorizationEndpoints(env: ChainRpcEnv, chainId: ChatChainId) {
  const policy = policies[chainId];
  if (!policy) throw new HttpError(503, "Unsupported verification network.");
  const first = env[`${policy.prefix}_AUTH_RPC_URL`];
  const second = env[`${policy.prefix}_CONFIRMATION_RPC_URL`];
  if (!first || !second)
    throw new HttpError(503, "Independent chain verification is being set up.");
  const primary = primaryFor(first, policy);
  const confirmation = exactKeyedUrl(
    second,
    "lb.drpc.live",
    policy.confirmationNetwork,
  );
  if (!primary || !confirmation)
    throw new HttpError(
      503,
      "Independent chain verification is not configured.",
    );
  return [primary, confirmation] as const;
}

/** One Alchemy source for informational transaction checks. Authority callers
 * keep authorizationEndpoints and its independent confirmation requirement. */
export function diagnosisPrimaryEndpoint(
  env: ChainRpcEnv,
  chainId: number,
): string | null {
  const policy = Object.hasOwn(policies, chainId)
    ? policies[chainId as keyof typeof policies]
    : DIAGNOSIS_RPC_POLICIES[chainId as keyof typeof DIAGNOSIS_RPC_PREFIXES];
  if (!policy) return null;
  const value = (env as unknown as Record<string, unknown>)[
    `${policy.prefix}_AUTH_RPC_URL`
  ];
  return typeof value === "string" ? primaryFor(value, policy) : null;
}

export function solanaDiagnosisPrimaryEndpoint(env: {
  SOLANA_AUTH_RPC_URL?: string;
}): string | null {
  return exactKeyedUrl(
    env.SOLANA_AUTH_RPC_URL,
    "solana-mainnet.g.alchemy.com",
    "v2",
  );
}
