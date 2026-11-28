import { bitcoinWalletProofMessage } from "@templ/chat/bitcoin-wallet-proof";
import type { GuestProofHost } from "./support-widget";
import { BitcoinWalletError, connectBitcoinWallet } from "./bitcoin-wallet";

const changed = "Your wallet or chat changed. Choose Verify again.";

async function proveBitcoin(host: GuestProofHost) {
  const { workspace, origin, shareConversation: conversation, bearer } = host;
  if (host.stale() || origin !== window.location.origin) throw new BitcoinWalletError(changed);
  const wallet = await connectBitcoinWallet("support");
  if (host.stale()) throw new BitcoinWalletError(changed);
  const claim = { network: "bitcoin", address: wallet.address };
  const issued = await host.call<{ nonce: string; expiresAt: number; message: string }>(
    "/auth/nonce", { ...claim, shareConversation: conversation }, true, bearer,
  );
  const { nonce, expiresAt, message } = issued;
  const now = Date.now();
  if (host.stale() || !/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt > now + 300000 ||
      message !== bitcoinWalletProofMessage({ origin, workspace, address: wallet.address, conversation, nonce, expiresAt }))
    throw new BitcoinWalletError("This verification request expired or changed. Choose Verify again.");
  const signature = await wallet.signMessage(message);
  if (host.stale() || Date.now() >= expiresAt) throw new BitcoinWalletError(changed);
  const verified = await host.call<{
    token: string; expiresAt: number; wallet: { network: string; address: string }; shareConversation: string;
    walletReceipt?: string; walletReceiptExpiresAt?: number;
  }>("/auth/verify", { ...claim, message, nonce, signature }, true, bearer);
  if (host.stale() || verified.token !== bearer || !(verified.expiresAt > Date.now()) ||
      verified.wallet?.network !== claim.network || verified.wallet.address !== wallet.address || verified.shareConversation !== conversation)
    throw new BitcoinWalletError("Could not verify this Bitcoin address. Try again.");
  return [verified, { address: wallet.address }] as [typeof verified, { address: string }];
}

export async function verifyBitcoin(host: GuestProofHost) {
  try {
    return await proveBitcoin(host);
  } catch (error) {
    if (error instanceof BitcoinWalletError) return error.message;
    if (typeof error === "object" && error && "code" in error && error.code === 4001)
      return "Wallet request cancelled.";
    throw error;
  }
}
