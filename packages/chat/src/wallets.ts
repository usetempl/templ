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
/** One account holds at most five proven EVM wallets and five Solana wallets. */
export const ACCOUNT_METHOD_LIMITS = {
  wallets: 5,
  solanaWallets: 5,
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
export type AccountMethods = {
  wallets: AccountWalletMethod[];
  solanaWallets: AccountSolanaWalletMethod[];
  /** Whether one more wallet of that kind can be removed. False when it
   * would remove the account's last wallet, EVM and Solana counted together. */
  canRemove: {
    wallets: boolean;
    solanaWallets: boolean;
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
