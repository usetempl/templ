import type {
  SupportWallet,
  SupportWalletProvider,
  SupportSolanaWallet,
} from "./support-widget";

type PageWallets = Window & {
  ethereum?: SupportWalletProvider;
  solana?: SupportSolanaWallet;
  phantom?: { solana?: SupportSolanaWallet };
  solflare?: SupportSolanaWallet;
  backpack?: SupportSolanaWallet;
};
/** Supplies wallet interfaces to the widget. The sign-in card owns every prompt. */
export function supportPageWallet(network: "evm" | "solana"): SupportWallet;
export function supportPageWallet(network: "evm" | "solana", fallback: false): SupportWallet | null;
export function supportPageWallet(network: "evm" | "solana", fallback = true): SupportWallet | null {
  const page = window as PageWallets;
  const solana = network === "solana" ? page.phantom?.solana ?? page.solflare ?? page.backpack ?? page.solana : null;
  if (!fallback) {
    return network === "evm"
      ? page.ethereum ? { evm: page.ethereum } : null
      : solana ? { solana } : null;
  }
  if (network === "evm")
    return {
      evm: page.ethereum ?? {
        request: async () => {
          throw new Error(
            "Connect an EVM wallet on this website.",
          );
        },
      },
    };
  return {
    solana: solana ?? {
        publicKey: null,
        connect: async () => {
          throw new Error(
            "Connect a Solana wallet on this website.",
          );
        },
      },
  };
}
