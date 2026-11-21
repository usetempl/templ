import type {
  SupportWallet,
  SupportWalletProvider,
  SupportSolanaWallet,
} from "./support-widget";

type PageWallets = Window & {
  ethereum?: SupportWalletProvider;
  solana?: SupportSolanaWallet;
  phantom?: { solana?: SupportSolanaWallet };
};
/** Supplies wallet interfaces to the widget. The sign-in card owns every prompt. */
export function supportPageWallet(network: "evm" | "solana"): SupportWallet;
export function supportPageWallet(network: "evm" | "solana", fallback: false): SupportWallet | null;
export function supportPageWallet(network: "evm" | "solana", fallback = true): SupportWallet | null {
  const page = window as PageWallets;
  if (!fallback) {
    const solana = page.phantom?.solana ?? page.solana;
    return network === "evm"
      ? page.ethereum ? { evm: page.ethereum } : null
      : solana ? { solana } : null;
  }
  if (network === "evm")
    return {
      evm: page.ethereum ?? {
        request: async () => {
          throw new Error(
            "Open this chat in your EVM wallet browser. Choose Verify wallet again.",
          );
        },
      },
    };
  return {
    solana: page.phantom?.solana ??
      page.solana ?? {
        publicKey: null,
        connect: async () => {
          throw new Error(
            "Open this chat in your Solana wallet browser. Choose Verify wallet again.",
          );
        },
      },
  };
}
