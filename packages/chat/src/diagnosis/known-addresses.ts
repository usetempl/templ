import type { EvmNetwork, Hex } from "./types";

/** Reviewed addresses. A label never comes from a contract's own symbol() or
 * name(). Stablecoin rows match PRODUCT_PAYMENT_ASSETS
 * (known-addresses.test.ts pins the drift). */
export type KnownEvmToken = {
  network: EvmNetwork;
  address: Hex;
  label: string;
  decimals: number;
};

const token = (
  network: EvmNetwork,
  address: string,
  label: string,
  decimals: number,
): KnownEvmToken => ({
  network,
  address: address.toLowerCase() as Hex,
  label,
  decimals,
});

export const EVM_TOKENS: readonly KnownEvmToken[] = [
  token("eip155:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 6),
  token("eip155:1", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", 6),
  token("eip155:1", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH", 18),
  token("eip155:1", "0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", 18),
  token("eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", 6),
  token("eip155:8453", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "USDT", 6),
  token(
    "eip155:8453",
    "0x4200000000000000000000000000000000000006",
    "WETH",
    18,
  ),
  token("eip155:56", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USDC", 18),
  token("eip155:56", "0x55d398326f99059fF775485246999027B3197955", "USDT", 18),
  token("eip155:56", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB", 18),
];

/** Wrapped native tokens whose Deposit and Withdrawal events are decoded. */
const WETH = new Set([
  "eip155:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "eip155:8453:0x4200000000000000000000000000000000000006",
  "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
]);

export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const UNIVERSAL_ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const ENTRY_POINTS: Readonly<Record<string, string>> = {
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "ERC-4337 EntryPoint v0.6",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "ERC-4337 EntryPoint v0.7",
  // v0.8 keeps v0.7's packed user operations and the same UserOperationEvent
  // and UserOperationRevertReason logs; it adds EIP-7702 senders.
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108": "ERC-4337 EntryPoint v0.8",
};

export function knownEvmToken(
  network: EvmNetwork,
  address: string,
): KnownEvmToken | null {
  const lower = address.toLowerCase();
  return (
    EVM_TOKENS.find(
      (item) => item.network === network && item.address === lower,
    ) ?? null
  );
}

export function isKnownWeth(network: EvmNetwork, address: string): boolean {
  return WETH.has(`${network}:${address.toLowerCase()}`);
}

export function isEntryPoint(address: string | null): boolean {
  return (
    !!address &&
    Object.prototype.hasOwnProperty.call(ENTRY_POINTS, address.toLowerCase())
  );
}

/** Label of reviewed infrastructure (Permit2, Multicall3, the Uniswap
 * Universal Router on Ethereum and Base, ERC-4337 EntryPoints). */
export function evmInfrastructureLabel(
  network: EvmNetwork,
  address: string,
): string | null {
  const lower = address.toLowerCase();
  if (lower === PERMIT2) return "Permit2";
  if (lower === MULTICALL3) return "Multicall3";
  if (
    lower === UNIVERSAL_ROUTER &&
    (network === "eip155:1" || network === "eip155:8453")
  )
    return "Uniswap Universal Router";
  return isEntryPoint(lower) ? ENTRY_POINTS[lower] : null;
}

export type KnownSolanaMint = { mint: string; label: string; decimals: number };
export const SOLANA_MINTS: readonly KnownSolanaMint[] = [
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "USDC",
    decimals: 6,
  },
  {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    label: "USDT",
    decimals: 6,
  },
  {
    mint: "So11111111111111111111111111111111111111112",
    label: "SOL",
    decimals: 9,
  },
];

export const SOLANA_PROGRAMS = {
  system: "11111111111111111111111111111111",
  splToken: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;
const SOLANA_PROGRAM_LABELS: Readonly<Record<string, string>> = {
  [SOLANA_PROGRAMS.system]: "System Program",
  [SOLANA_PROGRAMS.splToken]: "SPL Token",
  [SOLANA_PROGRAMS.token2022]: "Token-2022",
  [SOLANA_PROGRAMS.associatedToken]: "Associated Token Account",
  [SOLANA_PROGRAMS.computeBudget]: "Compute Budget",
  [SOLANA_PROGRAMS.memo]: "Memo",
  [SOLANA_PROGRAMS.jupiterV6]: "Jupiter v6",
};

export function knownSolanaMint(mint: string): KnownSolanaMint | null {
  return SOLANA_MINTS.find((item) => item.mint === mint) ?? null;
}

export function solanaProgramLabel(programId: string): string | null {
  return Object.prototype.hasOwnProperty.call(SOLANA_PROGRAM_LABELS, programId)
    ? SOLANA_PROGRAM_LABELS[programId]
    : null;
}
