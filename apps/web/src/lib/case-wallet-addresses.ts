import type { TeamConversation } from "@templ/chat/index";

export function sharedWalletAddresses(
  conversation?: Pick<TeamConversation, "verifiedWalletAddresses" | "verifiedWalletAddress" | "verifiedBitcoinWalletAddresses">,
  fallback?: string,
): string[] {
  const first = conversation?.verifiedWalletAddress ?? fallback;
  const addresses = conversation?.verifiedWalletAddresses ?? (first ? [first] : []);
  const bitcoin = conversation?.verifiedBitcoinWalletAddresses;
  return bitcoin?.length ? [...addresses, ...bitcoin] : addresses;
}
