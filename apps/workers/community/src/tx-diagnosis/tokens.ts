import { isChatChainId } from "@templ/chat/chains";
import { EVENT_TOPICS } from "@templ/chat/diagnosis/evm-abi";
import type { EvmReceiptView } from "@templ/chat/diagnosis/evm-normalize";
import { knownEvmToken } from "@templ/chat/diagnosis/known-addresses";
import type {
  AgreedBlock,
  EvmTokenFact,
  Hex,
  ProtocolProfileFacts,
} from "@templ/chat/diagnosis/types";
import { getAddress, type Address } from "viem";
import type { Env } from "../common";
import { requireRpcBudget } from "../rpc-budget";
import { readTargetFacts } from "../transaction-decoder";
import { DIAGNOSIS_READ_LIMITS } from "./budgets";
import type { DiagnosisChain } from "./chains";
import { pinnedDecoderClient } from "./decode";
import type { DiagnosisRpc } from "./rpc";

/** Logs whose emitter is a token (or a vault share) the check should name. */
const TOKEN_TOPICS: ReadonlySet<string> = new Set([
  EVENT_TOPICS.transfer,
  EVENT_TOPICS.approval,
  EVENT_TOPICS.vaultDeposit,
  EVENT_TOPICS.vaultWithdraw,
  EVENT_TOPICS.wethDeposit,
  EVENT_TOPICS.wethWithdrawal,
]);

/** Addresses to read: token emitters, distinct, at most 16, without the ones
 * the engine already knows or the manager's profile labels. */
export function tokenAddresses(
  chain: DiagnosisChain,
  receipt: EvmReceiptView,
  profile: ProtocolProfileFacts | null,
): Hex[] {
  const labeled = new Set(
    (profile?.contracts ?? [])
      .filter((item) => item.network === chain.network && item.symbol)
      .map((item) => item.address.toLowerCase()),
  );
  const out: Hex[] = [];
  for (const log of receipt.logs) {
    if (!TOKEN_TOPICS.has(log.topics[0] ?? "")) continue;
    const address = log.address.toLowerCase() as Hex;
    if (out.includes(address)) continue;
    if (knownEvmToken(chain.network, address) || labeled.has(address)) continue;
    out.push(address);
    if (out.length >= DIAGNOSIS_READ_LIMITS.tokens) break;
  }
  return out;
}

/** Decimals and symbols through Multicall3 at the inclusion block, after the
 * Multicall3 code-hash check. A symbol is what the contract claims, never a
 * verified name. Any failure gives [] and amounts show in raw units. */
export async function tokenFactsFor(
  env: Env,
  input: {
    chain: DiagnosisChain;
    rpc: DiagnosisRpc;
    block: AgreedBlock;
    receipt: EvmReceiptView;
    profile: ProtocolProfileFacts | null;
  },
): Promise<EvmTokenFact[]> {
  const { chain, rpc, block, receipt, profile } = input;
  if (!isChatChainId(chain.id)) return [];
  const addresses = tokenAddresses(chain, receipt, profile);
  if (!addresses.length) return [];
  const budget = requireRpcBudget(env);
  try {
    const { facts } = await readTargetFacts(
      env,
      chain.id,
      addresses.map((address) => getAddress(address) as Address),
      pinnedDecoderClient(rpc, chain.id, block),
    );
    return addresses.flatMap((address): EvmTokenFact[] => {
      const fact = facts.get(address);
      if (!fact?.contract) return [];
      return [
        {
          network: chain.network,
          address,
          decimals: fact.decimals,
          decimalsSource: fact.decimals === null ? null : "chain-read",
          symbol: fact.symbol,
          symbolSource: fact.symbol === null ? null : "contract-claimed",
        },
      ];
    });
  } catch {
    return [];
  } finally {
    // readTargetFacts clears the budget's holding flag when it ends; a check
    // never falls back to the recovery lane.
    budget.setHolding(true);
  }
}
