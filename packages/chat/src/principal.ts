import { isAddress, zeroAddress, type Address } from "viem";

/** Chat identity and an independently authorized transaction wallet are separate. */
export type ChatPrincipalId = Address | `account:${string}`;
export type ChatVisibility = "public" | "private";
/** How a session was opened. "wallet" is an EVM wallet proven with a signed
 * Sign In With Ethereum text; "solana" is a Solana wallet proven with a signed
 * Sign In With Solana text. Both resolve to the same account principal.
 * "guest" is a support-widget visitor with no proof at all; the worker accepts
 * it only inside the widget scope that created it, never as an app session.
 * A stored session of any other kind is refused. */
export type AuthMethod = "wallet" | "solana" | "email" | "guest";
export const AUTH_METHODS: readonly AuthMethod[] = [
  "wallet",
  "solana",
  "email",
  "guest",
];
export function isAuthMethod(value: unknown): value is AuthMethod {
  return (
    typeof value === "string" && AUTH_METHODS.includes(value as AuthMethod)
  );
}
export type ChatSession = {
  principalId: ChatPrincipalId;
  authMethod: AuthMethod;
  /** Set only for a newly verified, current email sign-in. */
  emailSignIn?: true;
  address: Address | null;
  /** The Solana wallet that opened a "solana" session; absent otherwise. */
  solanaAddress?: string | null;
  expiresAt: number;
  authenticatedAt: number;
  walletRevision: number;
  walletAuthorizationExpiresAt: number | null;
  /** Server-verified identities belonging to this account; never supplied by a client mutation. */
  servicePrincipals: ChatPrincipalId[];
};

const accountId =
  /^account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeChatPrincipal(value: unknown): ChatPrincipalId | null {
  if (typeof value !== "string") return null;
  if (accountId.test(value)) return value as ChatPrincipalId;
  if (isAddress(value) && value.toLowerCase() !== zeroAddress)
    return value.toLowerCase() as Address;
  return null;
}

/** A linked account can retain one original wallet identity. Two opaque accounts
 * are never merged by a sign-in or a caller-provided alias list. */
export function normalizeServicePrincipals(
  primary: ChatPrincipalId,
  value: unknown,
): ChatPrincipalId[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    return null;
  const ids = value.map(normalizeChatPrincipal);
  if (
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    !ids.includes(primary)
  )
    return null;
  if (primary.startsWith("account:")) {
    if (ids.some((id) => id!.startsWith("account:") && id !== primary))
      return null;
  } else if (ids.length !== 1) return null;
  return ids as ChatPrincipalId[];
}

export function principalLabel(value: string): string {
  return value.startsWith("account:")
    ? `User ${value.slice(8, 14)}`
    : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
