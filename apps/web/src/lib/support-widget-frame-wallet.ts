/** The Solana account a page's wallet shows, for frame mode's host file and
 * its wallet bridge: a Wallet Standard account on a Solana chain, or an
 * adapter's public key. */
import type { SupportSolanaWallet } from "./support-widget";

export function solanaAddress(wallet?: SupportSolanaWallet): string | null {
  if (!wallet) return null;
  const found =
    "accounts" in wallet
      ? wallet.accounts.find(
          (account) =>
            !account.chains ||
            account.chains.some((chain) => chain.startsWith("solana:")),
        )?.address
      : wallet.publicKey?.toBase58();
  return typeof found == "string" ? found : null;
}
