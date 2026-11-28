/** Proven wallets on one account. Browser-safe types only; the worker proves
 * wallets with SIWE. One EVM address links to at most one account. */
import type { ChatChainId } from "./chains";
import type { ChatPrincipalId } from "./principal";

export type ProvenWallet = {
  address: `0x${string}`;
  kind: "eoa" | "contract";
  chainId: ChatChainId;
  provenAt: string;
  /** The wallet that signed in; a Solana session has none. */
  primary: boolean;
};
export type AccountWallets = {
  principalId: ChatPrincipalId;
  wallets: ProvenWallet[];
  /** Bumps on every add or remove. */
  walletRevision: number;
};

export const WALLET_LINK_STATEMENT = "Add this wallet to your Templ account.";
export const WALLET_LINK_RESOURCE_PREFIXES = {
  principal: "urn:templ:principal:",
  session: "urn:templ:session:",
  walletRevision: "urn:templ:wallet-revision:",
} as const;

export function emptyAccountWallets(
  principalId: ChatPrincipalId,
): AccountWallets {
  return {
    principalId,
    wallets: [],
    walletRevision: 0,
  };
}

// Sign-in methods on one account, as GET /auth/account reports them.
/** Each wallet family has an independent account limit. */
export const ACCOUNT_METHOD_LIMITS = {
  wallets: 5,
  solanaWallets: 5,
  bitcoinWallets: 5,
} as const;
export type AccountWalletMethod = {
  address: `0x${string}`;
  kind: "eoa" | "contract";
  addedAt: string;
  /** The wallet that signed this session in. */
  current: boolean;
};
/** A Solana wallet on the account: proven with a signed Sign In With
 * Solana text, it signs in. */
export type AccountSolanaWalletMethod = {
  /** Base58 public key. */
  address: string;
  addedAt: string;
  /** The wallet that signed this session in. */
  current: boolean;
};
export type AccountBitcoinWalletMethod = {
  address: string;
  addedAt: string;
  current: boolean;
};
export type AccountMethods = {
  wallets: AccountWalletMethod[];
  solanaWallets: AccountSolanaWalletMethod[];
  /** Absent on older services. Addresses use lowercase Bitcoin mainnet encoding. */
  bitcoinWallets?: AccountBitcoinWalletMethod[];
  /** Whether one more wallet of that kind can be removed. False when it
   * would remove the account's last wallet across the supported families. */
  canRemove: {
    wallets: boolean;
    solanaWallets: boolean;
    bitcoinWallets?: boolean;
  };
};
/** GET /auth/account. */
export type ChatAccount = {
  principalId: ChatPrincipalId;
  /** The optional alert address: support alerts go there. It never signs in. */
  emailVerified: boolean;
  /** First character plus the domain, or null without an alert address. */
  emailMasked: string | null;
  /** Whether this service can verify an alert address now: support alerts
   * and the sender are configured. */
  alertEmailAvailable: boolean;
  /** The session's verified wallet, or null for an account without one. */
  wallet: `0x${string}` | null;
  wallets: number;
  methods: AccountMethods;
};
