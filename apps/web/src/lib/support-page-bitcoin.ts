import { bitcoinWalletProofMessage } from "@templ/chat/bitcoin-wallet-proof";
import type { GuestProofHost } from "./support-widget";

type BitcoinSigner = { address: string; sign(message: string): Promise<string> };
type XverseResult = {
  addresses?: { address: string; purpose: string }[];
  address?: string;
  signature?: string;
};
type InjectedBitcoin = {
  XverseProviders?: { BitcoinProvider?: {
    request(method: string, params: object): Promise<{ result?: XverseResult; error?: { code: number } }>;
  } };
  unisat?: {
    requestAccounts(): Promise<string[]>;
    getAccounts(): Promise<string[]>;
    signMessage(message: string, protocol: "bip322-simple"): Promise<string>;
  };
};

class WalletHelp extends Error {}

const mainnetAddress = /^bc1(?:q[02-9ac-hj-np-z]{38}|p[02-9ac-hj-np-z]{58})$/;
const unsupported = "Choose a native SegWit or Taproot address on Bitcoin mainnet.";
const changed = "Your wallet or chat changed. Choose Verify again.";

async function connectBitcoin(page: InjectedBitcoin): Promise<BitcoinSigner> {
  const xverse = page.XverseProviders?.BitcoinProvider;
  if (xverse) {
    const request = async (method: string, params: object) => {
      const response = await xverse.request(method, params);
      if (response.error?.code === 4001)
        throw new WalletHelp("Wallet request cancelled.");
      if (!response.result) throw new WalletHelp("Your Bitcoin wallet could not complete the request.");
      return response.result;
    };
    const connected = await request("wallet_connect", {
      addresses: ["payment", "ordinals"],
      message: "Verify a Bitcoin address for this support chat.",
    });
    const accounts = connected.addresses?.filter(account => mainnetAddress.test(account.address)) ?? [];
    const address = (accounts.find(account => account.purpose === "payment") ?? accounts[0])?.address;
    if (!address) throw new WalletHelp(unsupported);
    return { address, async sign(message) {
      const signed = await request("signMessage", { address, message, protocol: "BIP322" });
      if (signed.address !== address || !signed.signature) throw new WalletHelp(changed);
      return signed.signature;
    } };
  }
  const unisat = page.unisat;
  if (!unisat) throw new WalletHelp("Open this chat in Xverse or UniSat to verify a Bitcoin address.");
  const [address] = await unisat.requestAccounts();
  if (!mainnetAddress.test(address ?? "")) throw new WalletHelp(unsupported);
  return { address, async sign(message) {
    if ((await unisat.getAccounts())[0] !== address) throw new WalletHelp(changed);
    const signature = await unisat.signMessage(message, "bip322-simple");
    if ((await unisat.getAccounts())[0] !== address) throw new WalletHelp(changed);
    return signature;
  } };
}

async function proveBitcoin(host: GuestProofHost) {
  const { workspace, origin, shareConversation: conversation, bearer } = host;
  if (host.stale() || origin !== window.location.origin) throw new WalletHelp(changed);
  const wallet = await connectBitcoin(window as InjectedBitcoin);
  if (host.stale()) throw new WalletHelp(changed);
  const claim = { network: "bitcoin", address: wallet.address };
  const issued = await host.call<{ nonce: string; expiresAt: number; message: string }>(
    "/auth/nonce", { ...claim, shareConversation: conversation }, true, bearer,
  );
  const { nonce, expiresAt, message } = issued;
  const now = Date.now();
  if (host.stale() || !/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt > now + 300000 ||
      message !== bitcoinWalletProofMessage({ origin, workspace, address: wallet.address, conversation, nonce, expiresAt }))
    throw new WalletHelp("This verification request expired or changed. Choose Verify again.");
  const signature = await wallet.sign(message);
  if (host.stale() || Date.now() >= expiresAt) throw new WalletHelp(changed);
  const verified = await host.call<{
    token: string; expiresAt: number; wallet: { network: string; address: string }; shareConversation: string;
    walletReceipt?: string; walletReceiptExpiresAt?: number;
  }>("/auth/verify", { ...claim, message, nonce, signature }, true, bearer);
  if (host.stale() || verified.token !== bearer || !(verified.expiresAt > Date.now()) ||
      verified.wallet?.network !== claim.network || verified.wallet.address !== wallet.address || verified.shareConversation !== conversation)
    throw new WalletHelp("Could not verify this Bitcoin address. Try again.");
  return [verified, { address: wallet.address }] as [typeof verified, { address: string }];
}

export async function verifyBitcoin(host: GuestProofHost) {
  try {
    return await proveBitcoin(host);
  } catch (error) {
    if (error instanceof WalletHelp) return error.message;
    if (typeof error === "object" && error && "code" in error && error.code === 4001)
      return "Wallet request cancelled.";
    throw error;
  }
}
