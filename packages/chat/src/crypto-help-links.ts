export type CryptoNetwork =
  | "bitcoin"
  | "ethereum"
  | "base"
  | "op-mainnet"
  | "arbitrum"
  | "solana";
export type CryptoLink = {
  label: string;
  url: string;
  /** A guide is official documentation and a wallet is the app's own download
   * page. An app list names apps on one network and reviews none of them.
   * Emergency help is for a scam or hack. */
  kind: "guide" | "wallet" | "apps" | "emergency";
  networks: readonly CryptoNetwork[];
  /** When the AI may offer the link. A link without one is only a citation. */
  offer?: string;
  /** Saved copies of the page, such as the Markdown file an index lists. */
  copies?: readonly string[];
};

const EVM: readonly CryptoNetwork[] = ["ethereum", "base", "op-mainnet", "arbitrum"];
export const NETWORK_NAMES: Record<CryptoNetwork, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  base: "Base",
  "op-mainnet": "OP Mainnet",
  arbitrum: "Arbitrum",
  solana: "Solana",
};
const appList = (network: CryptoNetwork): CryptoLink => ({
  label: `${NETWORK_NAMES[network]} apps on DefiLlama`,
  url: `https://defillama.com/chain/${network}`,
  kind: "apps",
  networks: [network],
  offer: "Lists apps on this network. A listing is not a safety review.",
});

export const CRYPTO_LINKS: readonly CryptoLink[] = [
  // One reviewed wallet per network, beside the network's own wallet guide.
  { label: "Bitcoin wallet guide", url: "https://bitcoin.org/en/choose-your-wallet", kind: "guide", networks: ["bitcoin"], offer: "Compares Bitcoin wallets." },
  { label: "BlueWallet", url: "https://bluewallet.io/", kind: "wallet", networks: ["bitcoin"], offer: "A wallet app." },
  { label: "Ethereum wallet finder", url: "https://ethereum.org/wallets/find-wallet/", kind: "guide", networks: EVM, offer: "Compares wallets for Ethereum and its layer 2 networks." },
  { label: "MetaMask", url: "https://metamask.com/download", kind: "wallet", networks: EVM, offer: "A wallet app." },
  { label: "Solana wallet guide", url: "https://solana.com/learn/what-is-a-wallet", kind: "guide", networks: ["solana"], offer: "Explains Solana wallets and keys." },
  { label: "Phantom", url: "https://phantom.com/download", kind: "wallet", networks: ["solana"], offer: "A wallet app." },
  ...(["bitcoin", "ethereum", "base", "op-mainnet", "arbitrum", "solana"] as const).map(appList),
  { label: "Security Alliance emergency help", url: "https://securityalliance.org/sos", kind: "emergency", networks: [], offer: "Free emergency help after a scam, a hack or a drained wallet." },
  // Official pages the desk's research reads.
  { label: "Bitcoin FAQ", url: "https://bitcoin.org/en/faq", kind: "guide", networks: ["bitcoin"] },
  { label: "Secure your Bitcoin wallet", url: "https://bitcoin.org/en/secure-your-wallet", kind: "guide", networks: ["bitcoin"] },
  { label: "Ethereum network fees", url: "https://ethereum.org/gas/", kind: "guide", networks: ["ethereum"] },
  { label: "Using an Ethereum wallet", url: "https://ethereum.org/guides/how-to-use-a-wallet/", kind: "guide", networks: EVM },
  { label: "OP Mainnet fees", url: "https://docs.optimism.io/op-stack/transactions/fees", kind: "guide", networks: ["op-mainnet"], copies: ["https://docs.optimism.io/op-stack/transactions/fees.md"] },
  { label: "OP Mainnet withdrawals", url: "https://docs.optimism.io/op-stack/bridging/withdrawal-flow", kind: "guide", networks: ["op-mainnet"], copies: ["https://docs.optimism.io/op-stack/bridging/withdrawal-flow.md"] },
  { label: "Solana transactions", url: "https://solana.com/docs/core/transactions", kind: "guide", networks: ["solana"] },
  { label: "Solana fee payers", url: "https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction", kind: "guide", networks: ["solana"] },
  { label: "Aave liquidations", url: "https://aave.com/help/borrowing/liquidations", kind: "guide", networks: EVM },
  { label: "Uniswap price impact", url: "https://support.uniswap.org/hc/en-us/articles/8643794102669-Price-Impact-vs-Price-Slippage", kind: "guide", networks: EVM },
  { label: "Bitcoin glossary", url: "https://bitcoin.org/en/vocabulary", kind: "guide", networks: ["bitcoin"] },
  { label: "Before you use Bitcoin", url: "https://bitcoin.org/en/you-need-to-know", kind: "guide", networks: ["bitcoin"] },
  { label: "Bitcoin payment processing", url: "https://developer.bitcoin.org/devguide/payment_processing.html", kind: "guide", networks: ["bitcoin"] },
  { label: "Ethereum wallets", url: "https://ethereum.org/wallets/", kind: "guide", networks: EVM, copies: ["https://ethereum.org/en/wallets/"] },
  { label: "Ethereum layer 2s", url: "https://ethereum.org/layer-2/", kind: "guide", networks: EVM, copies: ["https://ethereum.org/en/layer-2/"] },
  { label: "MetaMask network guide", url: "https://support.metamask.com/manage-crypto/move-crypto/send/funds-sent-on-wrong-network/", kind: "guide", networks: EVM },
  { label: "Base wallet builder codes", url: "https://docs.base.org/specifications/builder-codes/for-wallet-developers", kind: "guide", networks: ["base"] },
  { label: "Solana fees", url: "https://solana.com/developers/docs/core/fees", kind: "guide", networks: ["solana"], copies: ["https://solana.com/docs/core/fees", "https://raw.githubusercontent.com/solana-foundation/solana-com/main/apps/docs/content/docs/en/core/fees/index.mdx"] },
  { label: "Solana payments", url: "https://solana.com/developers/docs/payments/how-payments-work", kind: "guide", networks: ["solana"], copies: ["https://solana.com/docs/payments/how-payments-work", "https://raw.githubusercontent.com/solana-foundation/solana-com/main/apps/docs/content/docs/en/payments/how-payments-work.mdx"] },
  { label: "Chainabuse help after a hack", url: "https://safety.chainabuse.com/article/i-may-have-been-hacked", kind: "guide", networks: [] },
  { label: "ETHSkills network concepts", url: "https://ethskills.com/concepts/SKILL.md", kind: "guide", networks: EVM },
  { label: "ETHSkills gas guide", url: "https://ethskills.com/gas/SKILL.md", kind: "guide", networks: EVM },
  { label: "ETHSkills layer 2 guide", url: "https://ethskills.com/l2s/SKILL.md", kind: "guide", networks: EVM },
  { label: "ETHSkills protocol guide", url: "https://ethskills.com/protocol/SKILL.md", kind: "guide", networks: EVM },
  // Documentation homes of the sites the desk's research reads.
  { label: "Bitcoin website", url: "https://bitcoin.org/en/", kind: "guide", networks: ["bitcoin"] },
  { label: "Ethereum website", url: "https://ethereum.org/", kind: "guide", networks: ["ethereum"] },
  { label: "Solana docs", url: "https://solana.com/docs", kind: "guide", networks: ["solana"] },
  { label: "Base docs", url: "https://docs.base.org/", kind: "guide", networks: ["base"] },
  { label: "OP Mainnet docs", url: "https://docs.optimism.io/", kind: "guide", networks: ["op-mainnet"] },
  { label: "Arbitrum docs", url: "https://docs.arbitrum.io/", kind: "guide", networks: ["arbitrum"] },
  { label: "Aave Help Center", url: "https://aave.com/help", kind: "guide", networks: EVM },
];

export function cryptoSourceLink(url?: string) {
  if (!url) return;
  return CRYPTO_LINKS.find(link => link.url === url || link.copies?.includes(url));
}
