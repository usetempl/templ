import type { ProfileContract } from "@templ/chat/protocol-profile";
import { priorityDepositAdapter } from "@templ/chat/support-priority";

export const PRIORITY_RELEASE_SCOPE = {
  networks: ["Ethereum", "Base"],
  adapter: "ERC-4626",
  asset: "native USDC",
} as const;

const assets: Readonly<Record<string, string>> = {
  "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
};

export function releasedPriorityAdapter(entry: ProfileContract) {
  return (
    priorityDepositAdapter(entry) === "erc4626" &&
    Object.hasOwn(assets, entry.network) &&
    entry.underlying?.address === assets[entry.network]
  );
}
