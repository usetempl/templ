/** EVM networks accepted by app wallet sign-in. */
export const CHAT_CHAIN_IDS = [1, 8453, 56, 4663] as const;
export type ChatChainId = (typeof CHAT_CHAIN_IDS)[number];
/** Default network for the app's own SIWE and for the worker's /health check. */
export const DEFAULT_CHAT_AUTH_CHAIN_ID = 8453;
/** ERC-1271 proofs bind smart-wallet principals to this chain.
 * A contract at the same address on another chain grants no authority. */
export const SMART_WALLET_AUTH_CHAIN_ID = 4663;
export const CHAT_CHAINS = [
  { id: 1, name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io" },
  { id: 8453, name: "Base", symbol: "ETH", explorer: "https://basescan.org" },
  { id: 56, name: "BNB Chain", symbol: "BNB", explorer: "https://bscscan.com" },
  {
    id: 4663,
    name: "Robinhood Chain",
    symbol: "ETH",
    explorer: "https://robinhoodchain.blockscout.com",
  },
] as const;
export function isChatChainId(value: unknown): value is ChatChainId {
  return CHAT_CHAIN_IDS.some((id) => id === value);
}
export function getChatChain(chainId: ChatChainId) {
  return CHAT_CHAINS.find((chain) => chain.id === chainId)!;
}
/** An EVM network the support widget and inbox name. Widget sign-in with an
 * ordinary wallet accepts the ones marked `siwe`; any other chain id a wallet
 * reports stays a claim. */
export type SupportWalletChain = {
  readonly id: number;
  readonly name: string;
  /** Explorer templates; `{hash}` and `{address}` are replaced only after
   * format checks. */
  readonly tx: string;
  readonly address: string;
  /** EOA widget sign-in may bind this chain id. */
  readonly siwe: boolean;
  /** The worker has a keyed Alchemy and dRPC policy for it. Diagnosis is not
   * live. */
  readonly diagnosisReady: boolean;
};
export const SUPPORT_WALLET_CHAINS = [
  {
    id: 1,
    name: "Ethereum",
    tx: "https://etherscan.io/tx/{hash}",
    address: "https://etherscan.io/address/{address}",
    siwe: true,
    diagnosisReady: true,
  },
  {
    id: 10,
    name: "OP Mainnet",
    tx: "https://optimistic.etherscan.io/tx/{hash}",
    address: "https://optimistic.etherscan.io/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 56,
    name: "BNB Chain",
    tx: "https://bscscan.com/tx/{hash}",
    address: "https://bscscan.com/address/{address}",
    siwe: true,
    diagnosisReady: true,
  },
  {
    id: 137,
    name: "Polygon",
    tx: "https://polygonscan.com/tx/{hash}",
    address: "https://polygonscan.com/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 146,
    name: "Sonic",
    tx: "https://sonicscan.org/tx/{hash}",
    address: "https://sonicscan.org/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 324,
    name: "zkSync Era",
    tx: "https://explorer.zksync.io/tx/{hash}",
    address: "https://explorer.zksync.io/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 8453,
    name: "Base",
    tx: "https://basescan.org/tx/{hash}",
    address: "https://basescan.org/address/{address}",
    siwe: true,
    diagnosisReady: true,
  },
  {
    id: 42161,
    name: "Arbitrum One",
    tx: "https://arbiscan.io/tx/{hash}",
    address: "https://arbiscan.io/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 43114,
    name: "Avalanche",
    tx: "https://snowtrace.io/tx/{hash}",
    address: "https://snowtrace.io/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 59144,
    name: "Linea",
    tx: "https://lineascan.build/tx/{hash}",
    address: "https://lineascan.build/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 81457,
    name: "Blast",
    tx: "https://blastscan.io/tx/{hash}",
    address: "https://blastscan.io/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 534352,
    name: "Scroll",
    tx: "https://scrollscan.com/tx/{hash}",
    address: "https://scrollscan.com/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 747474,
    name: "Katana",
    tx: "https://explorer.katanarpc.com/tx/{hash}",
    address: "https://explorer.katanarpc.com/address/{address}",
    siwe: true,
    diagnosisReady: false,
  },
  {
    id: 4663,
    name: "Robinhood Chain",
    tx: "https://robinhoodchain.blockscout.com/tx/{hash}",
    address: "https://robinhoodchain.blockscout.com/address/{address}",
    siwe: true,
    diagnosisReady: true,
  },
] as const satisfies readonly SupportWalletChain[];
export type SupportSiweChainId = Extract<
  (typeof SUPPORT_WALLET_CHAINS)[number],
  { siwe: true }
>["id"];
/* Fantom and Gnosis labels live in ./legacy-exit-chains to keep widget imports small. */
/** Any EIP-155 chain id a wallet can report: a positive safe integer. A
 * claim on it proves nothing. */
export function isEip155ChainId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function isSupportSiweChainId(
  value: unknown,
): value is SupportSiweChainId {
  return SUPPORT_WALLET_CHAINS.some(
    (chain) => chain.siwe && chain.id === value,
  );
}
export function supportWalletChain(id: number): SupportWalletChain | null {
  return SUPPORT_WALLET_CHAINS.find((chain) => chain.id === id) ?? null;
}
/** "Arbitrum One (42161)" for a listed chain, "Chain 7777777" otherwise. */
export function supportChainLabel(id: number): string {
  const chain = supportWalletChain(id);
  return chain ? `${chain.name} (${chain.id})` : `Chain ${id}`;
}
export type ChatNetworkAvailability = (typeof CHAT_CHAINS)[number] & {
  walletSignIn: true;
  smartWalletSignIn: boolean;
};
/** Wallet sign-in facts for the app's supported EVM networks. */
export function chatNetworkAvailability(): ChatNetworkAvailability[] {
  return CHAT_CHAINS.map((chain) => ({
    ...chain,
    walletSignIn: true as const,
    smartWalletSignIn: chain.id === SMART_WALLET_AUTH_CHAIN_ID,
  }));
}
