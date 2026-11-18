import type { ProfileContract } from "@templ/chat/protocol-profile";
import { priorityDepositAdapter } from "@templ/chat/support-priority";
import { PRODUCT_PAYMENT_ASSETS } from "@templ/chat/product-payment-assets";

export const PRIORITY_DEPOSIT_SCOPE = "erc4626-native-usdc-evm" as const;
export const priorityNetworkInScope = (network: string): boolean =>
  network === "eip155:1" || network === "eip155:8453";

/** Count app deposits backed by Circle native USDC on Ethereum and Base. */
export function priorityDepositInScope(
  entry: Pick<
    ProfileContract,
    "network" | "address" | "kind" | "conversion" | "underlying" | "decimals"
  >,
): boolean {
  if (
    !priorityNetworkInScope(entry.network) ||
    priorityDepositAdapter(entry) !== "erc4626"
  )
    return false;
  const chain = entry.network === "eip155:1" ? 1 : 8453;
  return (
    entry.underlying?.address ===
    PRODUCT_PAYMENT_ASSETS[chain].USDC!.address.toLowerCase()
  );
}
