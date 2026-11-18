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
export function supportPageWallet(network: "evm" | "solana"): SupportWallet {
  const page = window as PageWallets;
  if (network === "evm")
    return {
      evm: page.ethereum ?? {
        request: async () => {
          throw new Error(
            "Open this page in your EVM wallet browser, then try again.",
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
            "Open this page in your Solana wallet browser, then try again.",
          );
        },
      },
  };
}
