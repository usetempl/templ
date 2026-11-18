import {
  profileAddress,
  profileKey,
  type ProfileMatch,
  type ProfileRef,
} from "@templ/chat/protocol-profile";
import {
  PRIORITY_CONTRACT_LIMIT,
  type PriorityPosition,
} from "@templ/chat/support-priority";
import { diagnosisEndpoints } from "./chain-rpc";
import { agreedValue } from "./tx-diagnosis/agree";
import {
  createRunMeter,
  DIAGNOSIS_READ_LIMITS,
  RPC_CALLS_PER_RUN,
} from "./tx-diagnosis/budgets";
import { keyGuardChains, type DiagnosisEnv } from "./tx-diagnosis/chains";
import { agreedLatestHead, chainIdMatches } from "./tx-diagnosis/heads";
import { formatUnits, POSITION_SELECTORS } from "./tx-diagnosis/positions";
import {
  createDiagnosisRpc,
  type DiagnosisRpc,
  type Fetcher,
  type Pair,
} from "./tx-diagnosis/rpc";
import type { AgreedBlock } from "@templ/chat/diagnosis/types";
import type { AuthorizationRpcObservation } from "./rpc-upstream";
import {
  priorityDepositInScope,
  priorityNetworkInScope,
} from "./support-priority-scope";
import {
  priorityPriceCache,
  priorityStableAsset,
  type PriorityPriceCache,
} from "./support-priority-prices";

export type PriorityPositionDeps = {
  fetcher?: Fetcher;
  priceFetcher?: Fetcher;
  now?: () => number;
  prices?: PriorityPriceCache;
  maxRpcCalls?: number;
  observeRpc?: (
    network: string,
    observation: AuthorizationRpcObservation,
  ) => Promise<void>;
  observePrice?: NonNullable<
    Parameters<PriorityPriceCache["read"]>[1]
  >["observe"];
};
type Holding = { asset: ProfileRef; raw: string; decimals: number };
const ERC4626_ASSET = "0x38d52e0f";
const WORD = /^0x[0-9a-fA-F]{64}$/;
const pad32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const decimalsOf = (entry: ProfileMatch | undefined) =>
  entry &&
  Number.isSafeInteger(entry.decimals) &&
  entry.decimals !== null &&
  entry.decimals >= 0 &&
  entry.decimals <= 77
    ? entry.decimals
    : null;

function callUint(pair: Pair) {
  const read = agreedValue(pair, (raw) => {
    if (typeof raw !== "string" || !WORD.test(raw)) throw new Error("word");
    return BigInt(raw).toString();
  });
  return read.kind === "agreed" ? read.value : null;
}

function underlying(entry: ProfileMatch, profile: Map<string, ProfileMatch>) {
  if (!entry.underlying || entry.underlying.network !== entry.network)
    return null;
  const asset = profile.get(profileKey(entry.underlying));
  const stable = priorityStableAsset(entry.underlying);
  const decimals = decimalsOf(asset) ?? stable?.decimals ?? null;
  if (decimals === null || (stable && stable.decimals !== decimals))
    return null;
  return { asset: entry.underlying, decimals };
}

function pinnedCall(block: AgreedBlock, token: string, data: string) {
  return {
    method: "eth_call",
    params: [
      { to: token, data },
      { blockHash: block.hash, requireCanonical: true },
    ],
  };
}

async function evmHoldings(
  rpc: DiagnosisRpc,
  block: AgreedBlock,
  wallet: string,
  entries: readonly ProfileMatch[],
  profile: Map<string, ProfileMatch>,
): Promise<Holding[] | null> {
  const values: Omit<Holding, "raw">[] = [];
  for (const entry of entries) {
    if (!priorityDepositInScope(entry)) return null;
    const valueAsset = underlying(entry, profile);
    if (!valueAsset || valueAsset.decimals === null) return null;
    const stable = priorityStableAsset(valueAsset.asset);
    if (stable && stable.decimals !== valueAsset.decimals) return null;
    values.push({ ...valueAsset, decimals: valueAsset.decimals });
    rpc.allowCallTo(entry.address);
  }
  const assetChecks = entries.map((entry, index) => ({
    index,
    call: pinnedCall(block, entry.address, ERC4626_ASSET),
  }));
  const pairs = await rpc.bothBatch([
    ...entries.map((entry) =>
      pinnedCall(
        block,
        entry.address,
        `${POSITION_SELECTORS.balanceOf}${pad32(wallet)}`,
      ),
    ),
    ...assetChecks.map(({ call }) => call),
  ]);
  for (const [offset, { index }] of assetChecks.entries()) {
    const asset = agreedValue(pairs[entries.length + offset], (raw) => {
      if (typeof raw !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(raw))
        throw new Error("asset");
      return `0x${raw.slice(-40).toLowerCase()}`;
    });
    if (asset.kind !== "agreed" || asset.value !== values[index].asset.address)
      return null;
  }
  const holdings: Holding[] = [];
  const conversions: { index: number; call: ReturnType<typeof pinnedCall> }[] =
    [];
  for (const [index, pair] of pairs.slice(0, entries.length).entries()) {
    const shares = callUint(pair);
    if (shares === null) return null;
    holdings.push({ ...values[index], raw: shares });
    conversions.push({
      index,
      call: pinnedCall(
        block,
        entries[index].address,
        `${POSITION_SELECTORS.convertToAssets}${pad32(BigInt(shares).toString(16))}`,
      ),
    });
  }
  if (conversions.length) {
    const converted = await rpc.bothBatch(conversions.map(({ call }) => call));
    for (const [index, pair] of converted.entries()) {
      const assets = callUint(pair);
      if (assets === null) return null;
      holdings[conversions[index].index].raw = assets;
    }
  }
  return holdings;
}

/** One position snapshot. The caller supplies a workspace-scoped wallet proof. */
export async function readPriorityPosition(
  env: DiagnosisEnv,
  wallet: PriorityPosition["wallet"],
  selected: readonly ProfileRef[],
  entries: readonly ProfileMatch[],
  deps: PriorityPositionDeps = {},
): Promise<PriorityPosition> {
  const now = deps.now ?? Date.now;
  const started = now();
  const base = {
    wallet,
    asOf: new Date(started).toISOString(),
    estimated: false,
  };
  const unavailable = (): PriorityPosition => ({
    ...base,
    state: "unavailable",
    usd: null,
  });
  if (
    selected.some((ref) => !priorityNetworkInScope(ref.network)) ||
    (wallet.network !== "evm" &&
      !/^eip155:[1-9][0-9]*$/.test(wallet.network)) ||
    !/^0x[0-9a-fA-F]{40}$/.test(wallet.address) ||
    selected.length > PRIORITY_CONTRACT_LIMIT
  )
    return unavailable();
  const profile = new Map(entries.map((entry) => [profileKey(entry), entry]));
  const refs = new Map<string, ProfileRef>();
  for (const ref of selected) {
    if (profileAddress(ref.network, ref.address) !== ref.address)
      return unavailable();
    refs.set(profileKey(ref), ref);
  }
  const groups = new Map<string, ProfileMatch[]>();
  for (const [key, ref] of refs) {
    const entry = profile.get(key);
    if (!entry || !priorityDepositInScope(entry)) return unavailable();
    const group = groups.get(ref.network) ?? [];
    group.push(entry);
    groups.set(ref.network, group);
  }
  if (groups.size === 0 || groups.size > DIAGNOSIS_READ_LIMITS.probeNetworks)
    return unavailable();
  const cap =
    deps.maxRpcCalls === undefined
      ? RPC_CALLS_PER_RUN
      : Number.isSafeInteger(deps.maxRpcCalls)
        ? Math.max(0, Math.min(RPC_CALLS_PER_RUN, deps.maxRpcCalls))
        : 0;
  const meter = createRunMeter(cap);
  const rpcDeps = {
    fetcher: deps.fetcher,
    now,
    deadlineAt: started + 15_000,
    meter,
    maxAttempts: 1 as const,
  };
  const batches = await Promise.all(
    [...groups].map(async ([network, tokens]) => {
      const chain = keyGuardChains(env).find(
        (item) => item.network === network,
      );
      const endpoints = chain && diagnosisEndpoints(env, chain.id);
      if (!chain || !endpoints) return null;
      const rpc = createDiagnosisRpc(env, "evm", endpoints, {
        ...rpcDeps,
        observe:
          deps.observeRpc &&
          ((observation) => deps.observeRpc!(network, observation)),
      });
      if (!(await chainIdMatches(rpc, chain.id)).ok) return null;
      const head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
      if (!head.ok) return null;
      return evmHoldings(
        rpc,
        head.block,
        wallet.address.toLowerCase(),
        tokens,
        profile,
      );
    }),
  );
  const balances: Holding[] = [];
  for (const batch of batches) {
    if (batch === null) return unavailable();
    balances.push(...batch);
  }
  const nonzero = balances.filter((holding) => BigInt(holding.raw) > 0n);
  const prices = await (deps.prices ?? priorityPriceCache).read(
    nonzero.map((holding) => holding.asset),
    {
      now,
      fetcher: deps.priceFetcher,
      observe: deps.observePrice,
    },
  );
  let usd = 0;
  let estimated = false;
  let asOf = started;
  for (const holding of nonzero) {
    const price = prices.get(profileKey(holding.asset));
    if (!price || price.decimals !== holding.decimals) return unavailable();
    usd +=
      Number(formatUnits(holding.raw, holding.decimals, holding.decimals)) *
      price.usd;
    estimated ||= price.estimated;
    asOf = Math.min(asOf, Date.parse(price.asOf));
  }
  if (!Number.isFinite(usd) || usd < 0 || usd > Number.MAX_SAFE_INTEGER)
    return unavailable();
  return {
    ...base,
    usd,
    state: "ready",
    estimated,
    asOf: new Date(asOf).toISOString(),
  };
}
