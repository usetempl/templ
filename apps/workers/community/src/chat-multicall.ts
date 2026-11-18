import { parseAbi } from "viem";

// Canonical Multicall3 serves the read-only transaction decoder.
// It is infrastructure, not a room or access-contract revision.
export const CHAT_MULTICALL =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
export const CHAT_MULTICALL_CODE_HASH =
  "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891" as const;
export const chatMulticallAbi = parseAbi([
  "struct Call3 {address target;bool allowFailure;bytes callData;}",
  "struct Result {bool success;bytes returnData;}",
  "function aggregate3(Call3[] calls) payable returns(Result[] returnData)",
]);
