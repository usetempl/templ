import { supportWalletChain } from "./chains";
import { SUPPORT_IDENTITY_LABELS, threadIdentity } from "./support-identity";
import type { WidgetWallet } from "./widget-wallet";

/** Name a proven wallet's network only when the stored proof names it. */
export function threadIdentityLabel(thread: {
  access?: { level: string } | null;
  wallet?: WidgetWallet | null;
  appWallet?: { network: "solana" } | null;
}): string {
  const identity = threadIdentity(thread);
  const label = SUPPORT_IDENTITY_LABELS[identity];
  if (identity !== "verified") return label;
  const wallet = thread.wallet ?? thread.appWallet;
  const network =
    wallet?.network === "solana"
      ? "Solana"
      : wallet?.network === "evm"
        ? supportWalletChain(wallet.chainId)?.name
        : undefined;
  return network ? `${label} on ${network}` : label;
}
