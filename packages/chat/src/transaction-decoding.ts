/** What the read-only EVM decoder returns: the calls it read, how far it got
 * and what is worth a look. Kept for ticket diagnosis. Server-side only: no
 * browser code imports it. Nothing here reads a chain, signs or sends. */
import { CHAT_CHAINS, type ChatChainId } from "./chains";

export type TransactionCall = {
  /** Checksummed on output; any case is accepted on input. */
  to: `0x${string}`;
  /** "0x" for a plain transfer. */
  data: `0x${string}`;
  /** Decimal wei; "0" allowed. */
  value: string;
};
/** What the decoder found worth a look. */
export type TransactionFlag =
  | {
      kind: "approval";
      /** The address that gains the allowance, labeled when known. */
      spender: `0x${string}`;
      spenderLabel: string | null;
      asset: `0x${string}`;
      assetLabel: string | null;
      /** Formatted amount, or "unlimited". */
      amount: string;
      unlimited: boolean;
    }
  | { kind: "native-value"; amount: string }
  | { kind: "unverified-target"; to: `0x${string}` }
  | {
      kind: "unreadable-call";
      to: `0x${string}`;
      selector: `0x${string}` | null;
    }
  | { kind: "not-a-contract"; to: `0x${string}` };
export type DecodedArg = { name: string; type: string; value: string };
export type DecodedCall = {
  index: number;
  to: `0x${string}`;
  target: {
    contract: boolean;
    label: string | null;
    symbol: string | null;
    decimals: number | null;
    verified: "builtin" | "verified" | "unverified" | "not-a-contract";
  };
  /** Decimal wei. */
  value: string;
  selector: `0x${string}` | null;
  call: {
    name: string;
    signature: string;
    args: DecodedArg[];
    source: "builtin" | "verified";
  } | null;
  /** Multicall items and execute() wrappers, one level deep. */
  nested: DecodedCall[];
  flags: TransactionFlag[];
};
export type DecodedTransaction = {
  /** unavailable: a provider or budget failure; the structural layer still shows. */
  status: "decoded" | "partial" | "unavailable";
  checkedAt: string;
  block: string | null;
  calls: DecodedCall[];
  /** Every call's flags, deduplicated by kind and target. */
  flags: TransactionFlag[];
};

/** Whether an allowance reads as unlimited: the max uint256, or anything at
 * or above 2^255, the way wallets and explorers treat it. */
export function isUnlimitedAllowance(raw: bigint): boolean {
  return raw >= 1n << 255n;
}
export function addressExplorerUrl(
  chainId: ChatChainId,
  address: `0x${string}`,
): string {
  const chain = CHAT_CHAINS.find((entry) => entry.id === chainId)!;
  return `${chain.explorer}/address/${address}`;
}
