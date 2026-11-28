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

/** Public pages for the fixed read-only providers. A citation never identifies a transaction or address. */
export const CRYPTO_PROVIDER_PAGES = {
  "mempool.space": { label: "mempool.space", url: "https://mempool.space/" },
  "blockstream.info": { label: "Blockstream Explorer", url: "https://blockstream.info/" },
  publicnode: { label: "PublicNode Ethereum", url: "https://ethereum.publicnode.com/" },
  drpc: { label: "dRPC Ethereum", url: "https://drpc.org/chainlist/ethereum-mainnet-rpc" },
  blockscout: { label: "Blockscout Ethereum", url: "https://eth.blockscout.com/" },
  "solana-foundation": { label: "Solana public RPC", url: "https://solana.com/developers/docs/references/clusters" },
  "publicnode-solana": { label: "PublicNode Solana", url: "https://solana.publicnode.com/" },
} as const;
export type CryptoProviderPage = (typeof CRYPTO_PROVIDER_PAGES)[keyof typeof CRYPTO_PROVIDER_PAGES];

export const CRYPTO_LINKS: readonly CryptoLink[] = [
  // One reviewed wallet per network, beside the network's own wallet guide.
  { label: "Bitcoin wallet guide", url: "https://bitcoin.org/en/choose-your-wallet", kind: "guide", networks: ["bitcoin"], offer: "Compares Bitcoin wallets." },
  { label: "BlueWallet", url: "https://bluewallet.io/", kind: "wallet", networks: ["bitcoin"], offer: "A wallet app." },
  { label: "Ethereum wallet finder", url: "https://ethereum.org/wallets/find-wallet/", kind: "guide", networks: EVM, offer: "Compares wallets for Ethereum and its layer 2 networks." },
  { label: "MetaMask", url: "https://metamask.com/download", kind: "wallet", networks: EVM, offer: "A wallet app." },
  { label: "Solana wallet guide", url: "https://solana.com/learn/what-is-a-wallet", kind: "guide", networks: ["solana"], offer: "Explains Solana wallets and keys." },
  { label: "Phantom", url: "https://phantom.com/download", kind: "wallet", networks: ["solana"], offer: "A wallet app." },
  {
    label: "Coinbase",
    url: "https://help.coinbase.com/en/coinbase/trading-and-funding/buying-selling-or-converting-crypto/how-do-i-buy-digital-currency",
    kind: "guide",
    networks: ["bitcoin", "ethereum", "solana"],
    offer: "Official buying guide. Where Coinbase supports the visitor's country and payment method, its app has Buy & sell, an asset picker and an order preview. The visitor can check the amount and fees before deciding.",
  },
  {
    label: "Coinbase Brasil",
    url: "https://help.coinbase.com/pt-br/coinbase/trading-and-funding/depositing-or-withdrawing-fiat-money/funding-your-account-namerica-latam",
    kind: "guide",
    networks: ["bitcoin", "ethereum", "solana"],
    offer: "Brazil only. Coinbase shows a Pix code to deposit reais from a bank account with the same CPF. After the reais appear in the exchange balance, its Buy screen lets the visitor choose the coin and review the order.",
  },
  {
    label: "Binance Brasil",
    url: "https://www.binance.com/pt-BR/support/faq/detail/b90065c7a7d44d0bb8b2ac7dc2cb0391",
    kind: "guide",
    networks: ["bitcoin", "ethereum", "solana"],
    offer: "Brazil only. Binance's Comprar Cripto screen offers Pix for eligible purchases in reais. It shows the selected asset, the amount in BRL and its own Pix code. The bank account must belong to the same CPF.",
  },
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
  { label: "Borrowing on Aave", url: "https://aave.com/help/borrowing/borrow-tokens", kind: "guide", networks: EVM },
  { label: "How Bitcoin works", url: "https://bitcoin.org/en/how-it-works", kind: "guide", networks: ["bitcoin"] },
  { label: "Lightning payment lifecycle", url: "https://docs.lightning.engineering/the-lightning-network/payment-lifecycle", kind: "guide", networks: ["bitcoin"] },
  { label: "Ethereum bridges", url: "https://ethereum.org/bridges/", kind: "guide", networks: EVM },
  { label: "Ethereum block explorers", url: "https://ethereum.org/developers/docs/data-and-analytics/block-explorers/", kind: "guide", networks: ["ethereum"] },
  { label: "How Ethereum gas works", url: "https://ethereum.org/developers/docs/gas/", kind: "guide", networks: ["ethereum"] },
  { label: "Ethereum and Bitcoin", url: "https://ethereum.org/ethereum-vs-bitcoin/", kind: "guide", networks: ["ethereum", "bitcoin"] },
  { label: "Ethereum security guide", url: "https://ethereum.org/security/", kind: "guide", networks: EVM },
  { label: "Ethereum stablecoins", url: "https://ethereum.org/stablecoins/", kind: "guide", networks: ["ethereum"] },
  { label: "Ethereum staking pools", url: "https://ethereum.org/staking/pools/", kind: "guide", networks: ["ethereum"] },
  { label: "What is ether?", url: "https://ethereum.org/what-is-ether/", kind: "guide", networks: ["ethereum"] },
  { label: "Coinbase transaction IDs", url: "https://help.coinbase.com/en/coinbase/getting-started/crypto-education/what-is-a-transaction-hash-hash-id", kind: "guide", networks: [] },
  { label: "Cash out on Coinbase", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/buying-selling-or-converting-crypto/cash-out-funds", kind: "guide", networks: [] },
  { label: "Sell crypto on Coinbase", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/buying-selling-or-converting-crypto/how-do-i-sell-or-cash-out-my-digital-currency", kind: "guide", networks: [] },
  { label: "Coinbase payment availability", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/depositing-or-withdrawing-fiat-money/available-services", kind: "guide", networks: [] },
  { label: "Exchanges and self-custody wallets", url: "https://help.coinbase.com/en/coinbase/getting-started/crypto-education/exchanges-self-custody-wallets", kind: "guide", networks: [] },
  { label: "Coinbase fees and spreads", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/pricing-and-fees/fees", kind: "guide", networks: [] },
  { label: "Coinbase available balance", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/available-balance-faq", kind: "guide", networks: [] },
  { label: "Coinbase tags and memos", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/destination-tag-memo-faq", kind: "guide", networks: [] },
  { label: "Coinbase Exchange pending deposits", url: "https://help.coinbase.com/en/exchange/crypto-transfers/deposit-pending-unconfirmed-transaction", kind: "guide", networks: [] },
  { label: "Sending and receiving SOL", url: "https://solana.com/learn/sending-and-receiving-sol", kind: "guide", networks: ["solana"] },
  { label: "What is Solana?", url: "https://solana.com/learn/what-is-solana", kind: "guide", networks: ["solana"] },
  { label: "Restore missing MetaMask accounts", url: "https://support.metamask.com/configure/accounts/how-to-add-missing-accounts-after-restoring-with-secret-recovery-phrase/", kind: "guide", networks: [] },
  { label: "MetaMask password recovery", url: "https://support.metamask.com/configure/wallet/how-can-i-reset-my-password/", kind: "guide", networks: [] },
  { label: "MetaMask security alerts", url: "https://support.metamask.com/configure/wallet/security-alerts/", kind: "guide", networks: [] },
  { label: "Display tokens in MetaMask", url: "https://support.metamask.com/manage-crypto/tokens/how-to-display-tokens-in-metamask/", kind: "guide", networks: EVM },
  { label: "Disconnect a site in MetaMask", url: "https://support.metamask.com/more-web3/dapps/disconnect-wallet-from-a-dapp/", kind: "guide", networks: [] },
  { label: "Revoke token approvals in MetaMask", url: "https://support.metamask.com/more-web3/learn/how-to-revoke-smart-contract-allowances-token-approvals/", kind: "guide", networks: EVM },
  { label: "MetaMask token contract addresses", url: "https://support.metamask.com/more-web3/learn/what-is-a-token-contract-address/", kind: "guide", networks: EVM },
  { label: "MetaMask recovery phrases and keys", url: "https://support.metamask.com/start/user-guide-secret-recovery-phrase-password-and-private-keys/", kind: "guide", networks: [] },
  { label: "Uniswap token approvals", url: "https://support.uniswap.org/hc/en-us/articles/8120520483085-What-is-an-approval-transaction", kind: "guide", networks: EVM },
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
