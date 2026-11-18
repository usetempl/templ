import type { DiagnosisNetwork, EvmNetwork } from "./types";

export type NetworkInfo = {
  name: string;
  /** Explorer host; transaction links are https://<host>/tx/<ref>. */
  explorer: string;
  native: string;
};

/** Names and explorer hosts match SUPPORT_WALLET_CHAINS and
 * LEGACY_EXIT_CHAINS in ../chains and the staff panel, row for row. The engine keeps its own copy so it never
 * imports the wallet and checkout modules at runtime; r1-parity.test.ts pins
 * the drift. A row here only names a network: which chains Templ reads is
 * decided by the worker's keyed provider pairs and the release manifest. */
export const NETWORK_INFO: Readonly<Record<string, NetworkInfo>> = {
  "eip155:1": { name: "Ethereum", explorer: "etherscan.io", native: "ETH" },
  "eip155:10": {
    name: "OP Mainnet",
    explorer: "optimistic.etherscan.io",
    native: "ETH",
  },
  "eip155:56": { name: "BNB Chain", explorer: "bscscan.com", native: "BNB" },
  "eip155:137": { name: "Polygon", explorer: "polygonscan.com", native: "POL" },
  "eip155:146": { name: "Sonic", explorer: "sonicscan.org", native: "S" },
  "eip155:324": {
    name: "zkSync Era",
    explorer: "explorer.zksync.io",
    native: "ETH",
  },
  "eip155:8453": { name: "Base", explorer: "basescan.org", native: "ETH" },
  "eip155:42161": {
    name: "Arbitrum One",
    explorer: "arbiscan.io",
    native: "ETH",
  },
  "eip155:43114": {
    name: "Avalanche",
    explorer: "snowtrace.io",
    native: "AVAX",
  },
  "eip155:59144": { name: "Linea", explorer: "lineascan.build", native: "ETH" },
  "eip155:81457": { name: "Blast", explorer: "blastscan.io", native: "ETH" },
  "eip155:534352": {
    name: "Scroll",
    explorer: "scrollscan.com",
    native: "ETH",
  },
  "eip155:747474": {
    name: "Katana",
    explorer: "explorer.katanarpc.com",
    native: "ETH",
  },
  "eip155:4663": {
    name: "Robinhood Chain",
    explorer: "robinhoodchain.blockscout.com",
    native: "ETH",
  },
  // Legacy exits (LEGACY_EXIT_CHAINS in ../chains): named, never read.
  "eip155:100": { name: "Gnosis", explorer: "gnosisscan.io", native: "xDAI" },
  "eip155:250": { name: "Fantom", explorer: "ftmscan.com", native: "FTM" },
  solana: { name: "Solana", explorer: "solscan.io", native: "SOL" },
};

const EVM_NETWORK = /^eip155:([1-9][0-9]{0,15})$/;

/** A positive safe integer chain id, written without leading zeros. */
export function isEvmNetwork(value: unknown): value is EvmNetwork {
  if (typeof value !== "string") return false;
  const match = EVM_NETWORK.exec(value);
  return !!match && Number.isSafeInteger(Number(match[1]));
}

/** "eip155:<positive safe integer>" or "solana"; anything else is null. */
export function parseNetwork(value: unknown): DiagnosisNetwork | null {
  if (value === "solana") return "solana";
  return isEvmNetwork(value) ? value : null;
}

export function networkInfo(network: string): NetworkInfo | null {
  return Object.prototype.hasOwnProperty.call(NETWORK_INFO, network)
    ? NETWORK_INFO[network]
    : null;
}

/** The display name. Chains outside the table read "EVM chain <id>". */
export function networkName(network: DiagnosisNetwork): string {
  const info = networkInfo(network);
  if (info) return info.name;
  return network === "solana" ? "Solana" : `EVM chain ${network.slice(7)}`;
}

/** Names a member text may use: the table's names only. */
export const MEMBER_NETWORK_NAMES: ReadonlySet<string> = new Set(
  Object.keys(NETWORK_INFO).map((key) => NETWORK_INFO[key].name),
);
