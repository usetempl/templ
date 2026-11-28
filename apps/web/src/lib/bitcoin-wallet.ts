import { isBitcoinAccountAddress } from "@templ/chat/bitcoin-account-auth";

export type BitcoinSigner = {
  address: string;
  signMessage(message: string): Promise<string>;
};
type XverseResult = {
  addresses?: { address: string; purpose: string }[];
  address?: string;
  signature?: string;
};
type InjectedBitcoin = {
  XverseProviders?: {
    BitcoinProvider?: {
      request(
        method: string,
        params: object,
      ): Promise<{ result?: XverseResult; error?: { code: number } }>;
    };
  };
  unisat?: {
    requestAccounts(): Promise<string[]>;
    getAccounts(): Promise<string[]>;
    signMessage(message: string, protocol: "bip322-simple"): Promise<string>;
  };
};

export class BitcoinWalletError extends Error {}

function normalizedAddress(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    (value !== value.toLowerCase() && value !== value.toUpperCase())
  )
    return undefined;
  const lower = value.toLowerCase();
  return isBitcoinAccountAddress(lower) ? lower : undefined;
}
const unsupported =
  "Choose a native SegWit or Taproot address on Bitcoin mainnet.";
const changed = "Your wallet address changed. Try again.";

const prompts = {
  support: "Verify a Bitcoin address for this support chat.",
  "sign-in": "Sign in to Templ with your Bitcoin wallet.",
  attach: "Add this Bitcoin wallet to your Templ account.",
};

export async function connectBitcoinWallet(
  purpose: keyof typeof prompts,
  page: InjectedBitcoin = window as InjectedBitcoin,
): Promise<BitcoinSigner> {
  const xverse = page.XverseProviders?.BitcoinProvider;
  if (xverse) {
    const request = async (method: string, params: object) => {
      const response = await xverse.request(method, params);
      if (response.error?.code === 4001)
        throw new BitcoinWalletError("Wallet request cancelled.");
      if (!response.result)
        throw new BitcoinWalletError(
          "Your Bitcoin wallet could not complete the request.",
        );
      return response.result;
    };
    const connected = await request("wallet_connect", {
      addresses: ["payment", "ordinals"],
      message: prompts[purpose],
    });
    const accounts =
      connected.addresses?.filter((account) =>
        normalizedAddress(account.address),
      ) ?? [];
    const selected = (
      accounts.find((account) => account.purpose === "payment") ?? accounts[0]
    )?.address;
    const address = normalizedAddress(selected);
    if (!address) throw new BitcoinWalletError(unsupported);
    return {
      address,
      async signMessage(message) {
        const signed = await request("signMessage", {
          address: selected,
          message,
          protocol: "BIP322",
        });
        if (normalizedAddress(signed.address) !== address || !signed.signature)
          throw new BitcoinWalletError(changed);
        return signed.signature;
      },
    };
  }
  const unisat = page.unisat;
  if (!unisat)
    throw new BitcoinWalletError(
      "Open this page in Xverse or UniSat to use a Bitcoin wallet.",
    );
  const address = normalizedAddress((await unisat.requestAccounts())[0]);
  if (!address) throw new BitcoinWalletError(unsupported);
  return {
    address,
    async signMessage(message) {
      if (normalizedAddress((await unisat.getAccounts())[0]) !== address)
        throw new BitcoinWalletError(changed);
      const signature = await unisat.signMessage(message, "bip322-simple");
      if (normalizedAddress((await unisat.getAccounts())[0]) !== address)
        throw new BitcoinWalletError(changed);
      return signature;
    },
  };
}
