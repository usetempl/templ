import { evmReceiptView } from "@templ/chat/diagnosis/evm-normalize";
import type {
  DiagnosisReadSource,
  Hex,
  Quantity,
} from "@templ/chat/diagnosis/types";
import { diagnosisEndpoints, diagnosisPrimaryEndpoint } from "../chain-rpc";
import { agreed, type ReadFailure } from "./agree";
import { createRunMeter } from "./budgets";
import { enabledDiagnosisChains, type DiagnosisEnv } from "./chains";
import { agreedLatestHead, chainIdMatches } from "./heads";
import {
  createDiagnosisRpc,
  createPrimaryDiagnosisRpc,
  type Fetcher,
} from "./rpc";

export type AgreedReceiptStatus = (
  | {
      state: "mined";
      success: boolean;
      block: Quantity;
      /** Latest head under the selected read policy minus inclusion block, plus one. */
      confirmations: number;
      /** At least the chain's watchConfirmations. */
      settled: boolean;
    }
  | { state: "not-mined" }
  | { state: "unavailable"; reason: ReadFailure | "not-configured" }
) & { readSource?: DiagnosisReadSource };

/** A receipt and latest head under the transaction-check read policy.
 * Alchemy mode records one source; the default still requires agreement.
 * A chain that is not enabled for checks is "not-configured". */
export async function readAgreedReceiptStatus(
  env: DiagnosisEnv,
  network: string,
  hash: Hex,
  deps: { fetcher?: Fetcher; now?: () => number } = {},
): Promise<AgreedReceiptStatus> {
  const chain = enabledDiagnosisChains(env).find(
    (item) => item.network === network,
  );
  const primaryOnly = env.SUPPORT_DIAGNOSIS_RPC_MODE === "alchemy";
  const primary =
    chain && primaryOnly ? diagnosisPrimaryEndpoint(env, chain.id) : null;
  const endpoints =
    chain && !primaryOnly ? diagnosisEndpoints(env, chain.id) : null;
  if (!chain || (!primary && !endpoints))
    return { state: "unavailable", reason: "not-configured" };
  if (!/^0x[0-9a-f]{64}$/.test(hash))
    return { state: "unavailable", reason: "provider-error" };
  const now = deps.now ?? (() => Date.now());
  const rpcDeps = {
    fetcher: deps.fetcher,
    now,
    deadlineAt: now() + 10_000,
    meter: createRunMeter(12),
  };
  const rpc = primary
    ? createPrimaryDiagnosisRpc(env, "evm", primary, rpcDeps)
    : createDiagnosisRpc(env, "evm", endpoints!, rpcDeps);
  const source = primary
    ? { readSource: { providerCount: 1 as const, source: "alchemy" as const } }
    : {};
  if (primary) {
    const identity = await chainIdMatches(rpc, chain.id);
    if (!identity.ok)
      return { state: "unavailable", reason: identity.reason, ...source };
  }
  const head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
  if (!head.ok) return { state: "unavailable", reason: head.reason, ...source };
  const read = agreed(
    await rpc.both("eth_getTransactionReceipt", [hash], {
      maxBytes: 8 * 1024 * 1024,
    }),
    evmReceiptView,
    ["transactionHash", "status", "blockHash", "blockNumber"],
    [],
  );
  if (read.kind === "both-null") return { state: "not-mined", ...source };
  if (read.kind !== "agreed")
    return {
      state: "unavailable",
      reason: read.kind === "unavailable" ? read.reason : "providers-disagree",
      ...source,
    };
  if (read.value.transactionHash !== hash)
    return { state: "unavailable", reason: "provider-error", ...source };
  const depth = BigInt(head.block.number) - BigInt(read.value.blockNumber) + 1n;
  const confirmations = depth > 0n ? Number(depth) : 0;
  return {
    state: "mined",
    success: read.value.status === "0x1",
    block: read.value.blockNumber,
    confirmations,
    settled: confirmations >= chain.watchConfirmations,
    ...source,
  };
}
