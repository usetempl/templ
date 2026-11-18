import type { ChatChainId } from "./chains";

export type ProductPaymentNetwork = ChatChainId | "solana";
export type ProductPaymentAssetSymbol = "USDC" | "USDT";
export type ProductPaymentAsset = {
  symbol: ProductPaymentAssetSymbol;
  label: string;
  address: string;
  decimals: 6 | 18;
  source: string;
  checkedAt: "2026-09-30";
  decimalsSource: string;
};

/** Stablecoin addresses read from issuer documentation on 2026-09-30.
 * Binance-Peg assets use the BscScan token pages as the reviewed bridge source.
 * A listed asset needs a recipient and hosted rail evidence before payment. */
export const PRODUCT_PAYMENT_ASSETS: Readonly<
  Record<
    ProductPaymentNetwork,
    Partial<Record<ProductPaymentAssetSymbol, ProductPaymentAsset>>
  >
> = {
  // Read 2026-09-30: Circle USDC addresses and Tether supported protocols.
  // https://developers.circle.com/stablecoins/usdc-contract-addresses
  // https://tether.to/en/supported-protocols/
  // Etherscan token pages confirm 6 decimals for both Ethereum assets.
  1: {
    USDC: {
      symbol: "USDC",
      label: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      source:
        "https://developers.circle.com/stablecoins/usdc-contract-addresses",
      checkedAt: "2026-09-30",
      decimalsSource: "https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    },
    USDT: {
      symbol: "USDT",
      label: "USDT",
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
      source: "https://tether.to/en/supported-protocols/",
      checkedAt: "2026-09-30",
      decimalsSource: "https://etherscan.io/token/0xdac17f958d2ee523a2206206994597c13d831ec7",
    },
  },
  // Read 2026-09-30: Circle USDC addresses; Circle's guide confirms 6 decimals.
  // https://developers.circle.com/stablecoins/usdc-contract-addresses
  // https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-usdc/SKILL.md
  8453: {
    USDC: {
      symbol: "USDC",
      label: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      source:
        "https://developers.circle.com/stablecoins/usdc-contract-addresses",
      checkedAt: "2026-09-30",
      decimalsSource: "https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-usdc/SKILL.md",
    },
  },
  // Read 2026-09-30: BscScan identifies both Binance-Peg tokens with 18 decimals.
  // https://bscscan.com/token/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d
  // https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955
  56: {
    USDC: {
      symbol: "USDC",
      label: "Binance-Peg USDC",
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      decimals: 18,
      source: "https://bscscan.com/token/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      checkedAt: "2026-09-30",
      decimalsSource: "https://bscscan.com/token/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    },
    USDT: {
      symbol: "USDT",
      label: "Binance-Peg USDT",
      address: "0x55d398326f99059fF775485246999027B3197955",
      decimals: 18,
      source: "https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955",
      checkedAt: "2026-09-30",
      decimalsSource: "https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955",
    },
  },
  // Neither Circle nor Tether lists Robinhood Chain on 2026-09-30.
  4663: {},
  // Read 2026-09-30: Circle USDC addresses and Tether supported protocols.
  // https://developers.circle.com/stablecoins/usdc-contract-addresses
  // https://tether.to/en/supported-protocols/
  // Circle's Solana guide and Solana RPC examples confirm 6 decimals.
  solana: {
    USDC: {
      symbol: "USDC",
      label: "USDC",
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      source:
        "https://developers.circle.com/stablecoins/usdc-contract-addresses",
      checkedAt: "2026-09-30",
      decimalsSource: "https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-usdc/references/solana.md",
    },
    USDT: {
      symbol: "USDT",
      label: "USDT",
      address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      decimals: 6,
      source: "https://tether.to/en/supported-protocols/",
      checkedAt: "2026-09-30",
      decimalsSource: "https://solana.com/docs/rpc/json-structures",
    },
  },
};
export function isProductPaymentNetwork(
  value: unknown,
): value is ProductPaymentNetwork {
  return (
    value === 1 ||
    value === 8453 ||
    value === 56 ||
    value === 4663 ||
    value === "solana"
  );
}
export function isProductPaymentAssetSymbol(
  value: unknown,
): value is ProductPaymentAssetSymbol {
  return value === "USDC" || value === "USDT";
}
export function getProductPaymentAsset(
  network: ProductPaymentNetwork,
  symbol: ProductPaymentAssetSymbol,
): ProductPaymentAsset | undefined {
  return PRODUCT_PAYMENT_ASSETS[network]?.[symbol];
}
/** Each option needs its recipient and release gate before payment. */
export const PRODUCT_CHECKOUT_OPTIONS = [
  { network: 1, symbol: "USDC" },
  { network: 1, symbol: "USDT" },
  { network: 8453, symbol: "USDC" },
  { network: 56, symbol: "USDC" },
  { network: 56, symbol: "USDT" },
  { network: "solana", symbol: "USDC" },
  { network: "solana", symbol: "USDT" },
] as const satisfies readonly {
  network: ProductPaymentNetwork;
  symbol: ProductPaymentAssetSymbol;
}[];
