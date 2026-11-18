import { isAddress, type Address } from "viem";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  ACCOUNT_METHOD_LIMITS,
  type AccountMethods,
  type AccountSolanaWalletMethod,
  type AccountWalletMethod,
  type ChatAccount,
} from "@templ/chat/wallets";
import { isSolanaAddress } from "@templ/chat/solana";
import { chatMutation } from "./chat-api";
import { communityFetch } from "./community-client";
import { attachSolanaWallet, peekCommunitySession } from "./community-auth";
import type { SolanaSigner } from "./solana-wallet";

/** The browser side of one account's wallets and its alert
 * email. Every call names the signed-in principal as `expectedPrincipalId`;
 * the worker decides what can be added or removed and answers with the whole
 * wallet list, and this module never renders a partial list as the account. */
export const METHODS_UNREADABLE = "Your sign-in methods could not be read.";
export const ACCOUNT_CHANGED = "Your account changed. Open the page again.";
export { ACCOUNT_METHOD_LIMITS };

const isIso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const isLowerAddress = (value: unknown): value is Address =>
  typeof value === "string" &&
  /^0x[0-9a-f]{40}$/.test(value) &&
  isAddress(value);
function isWalletMethod(value: unknown): value is AccountWalletMethod {
  const w = value as Partial<AccountWalletMethod> | null;
  return (
    !!w &&
    typeof w === "object" &&
    isLowerAddress(w.address) &&
    (w.kind === "eoa" || w.kind === "contract") &&
    isIso(w.addedAt) &&
    typeof w.current === "boolean"
  );
}
/** A Solana wallet on the account: base58 key, added date and whether it
 * signed this session in. */
function isSolanaWalletMethod(
  value: unknown,
): value is AccountSolanaWalletMethod {
  const w = value as Partial<AccountSolanaWalletMethod> | null;
  return (
    !!w &&
    typeof w === "object" &&
    isSolanaAddress(w.address) &&
    isIso(w.addedAt) &&
    typeof w.current === "boolean"
  );
}
/** Fails closed: a method list missing a field is unreadable. */
export function validAccountMethods(raw: unknown): AccountMethods {
  const value = raw as Partial<AccountMethods> | null;
  const canRemove = value?.canRemove as
    | Partial<AccountMethods["canRemove"]>
    | undefined;
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.wallets) ||
    !value.wallets.every(isWalletMethod) ||
    value.wallets.length > ACCOUNT_METHOD_LIMITS.wallets ||
    !canRemove ||
    typeof canRemove !== "object" ||
    typeof canRemove.wallets !== "boolean" ||
    typeof canRemove.solanaWallets !== "boolean" ||
    !Array.isArray(value.solanaWallets) ||
    !value.solanaWallets.every(isSolanaWalletMethod) ||
    value.solanaWallets.length > ACCOUNT_METHOD_LIMITS.solanaWallets
  )
    throw new Error(METHODS_UNREADABLE);
  return {
    wallets: value.wallets.map((w) => ({ ...w })),
    solanaWallets: value.solanaWallets.map((w) => ({ ...w })),
    canRemove: {
      wallets: canRemove.wallets,
      solanaWallets: canRemove.solanaWallets,
    },
  };
}
export function validChatAccount(raw: unknown): ChatAccount {
  const value = raw as Partial<ChatAccount> | null;
  const principalId = normalizeChatPrincipal(value?.principalId);
  if (
    !value ||
    typeof value !== "object" ||
    !principalId ||
    typeof value.emailVerified !== "boolean" ||
    !(value.emailMasked === null || typeof value.emailMasked === "string") ||
    typeof value.alertEmailAvailable !== "boolean" ||
    !(value.wallet === null || isLowerAddress(value.wallet)) ||
    !Number.isSafeInteger(value.wallets) ||
    (value.wallets ?? -1) < 0
  )
    throw new Error(METHODS_UNREADABLE);
  return {
    principalId,
    emailVerified: value.emailVerified,
    emailMasked: value.emailMasked ?? null,
    alertEmailAvailable: value.alertEmailAvailable,
    wallet: value.wallet ?? null,
    wallets: value.wallets as number,
    methods: validAccountMethods(value.methods),
  };
}

function assertPrincipal(principal: ChatPrincipalId) {
  if (peekCommunitySession()?.principalId !== principal)
    throw new Error(ACCOUNT_CHANGED);
}
const withTimeout = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);

/** GET /auth/account with the method list. */
export async function readAccountMethods(
  principal: ChatPrincipalId,
  signal?: AbortSignal,
): Promise<ChatAccount> {
  assertPrincipal(principal);
  const params = new URLSearchParams({ expectedPrincipalId: principal });
  const value = validChatAccount(
    await communityFetch<unknown>(
      `/auth/account?${params}`,
      undefined,
      withTimeout(signal),
    ),
  );
  assertPrincipal(principal);
  if (value.principalId !== principal) throw new Error(ACCOUNT_CHANGED);
  return value;
}

/** A mutation answers with the account's whole method list. */
function methodsFrom(raw: unknown): AccountMethods {
  const value = raw as { methods?: unknown } | null;
  return validAccountMethods(value?.methods);
}

// The alert email: one address per account for support alerts. A code sent
// there proves the mailbox; the address never signs in.
export type AlertEmail = {
  principalId: ChatPrincipalId;
  emailVerified: boolean;
  emailMasked: string | null;
};
function alertEmailFrom(principal: ChatPrincipalId, raw: unknown): AlertEmail {
  const value = raw as Partial<AlertEmail> | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.principalId !== principal ||
    typeof value.emailVerified !== "boolean" ||
    !(value.emailMasked === null || typeof value.emailMasked === "string")
  )
    throw new Error("The email change could not be verified.");
  return {
    principalId: value.principalId,
    emailVerified: value.emailVerified,
    emailMasked: value.emailMasked,
  };
}
export function startEmailLink(
  principal: ChatPrincipalId,
  email: string,
  requestId: string,
  assertCurrent: () => void = () => assertPrincipal(principal),
) {
  return chatMutation<{ expiresAt: number; resendAfter: number }>(
    principal,
    "/auth/email/link/start",
    { email, requestId },
    assertCurrent,
    withTimeout(),
  ).then((value) => {
    if (
      !value ||
      !Number.isFinite(value.expiresAt) ||
      !Number.isFinite(value.resendAfter)
    )
      throw new Error("The email request could not be verified.");
    return { expiresAt: value.expiresAt, resendAfter: value.resendAfter };
  });
}
/** Verifies the code. The worker sets the address on this account and
 * answers for this account only; the session does not change. */
export async function verifyEmailLink(
  principal: ChatPrincipalId,
  email: string,
  code: string,
  assertCurrent: () => void = () => assertPrincipal(principal),
): Promise<AlertEmail> {
  const response = await chatMutation<unknown>(
    principal,
    "/auth/email/link/verify",
    { email, code },
    assertCurrent,
    withTimeout(),
  );
  assertCurrent();
  const value = alertEmailFrom(principal, response);
  if (!value.emailVerified)
    throw new Error("The email change could not be verified.");
  return value;
}
export function removeAccountEmail(
  principal: ChatPrincipalId,
): Promise<AlertEmail> {
  return chatMutation<unknown>(
    principal,
    "/auth/email/remove",
    {},
    () => assertPrincipal(principal),
    withTimeout(),
  ).then((value) => alertEmailFrom(principal, value));
}

// Solana wallets: proven with a Sign In With Solana text bound to this
// account; each one signs in.
export function addSolanaWallet(
  principal: ChatPrincipalId,
  connect: () => Promise<SolanaSigner>,
): Promise<AccountMethods> {
  assertPrincipal(principal);
  return attachSolanaWallet(principal, connect).then((result) =>
    methodsFrom(result),
  );
}
export function removeSolanaWallet(
  principal: ChatPrincipalId,
  address: string,
): Promise<AccountMethods> {
  if (!isSolanaAddress(address))
    throw new Error("Choose a Solana wallet to remove.");
  return chatMutation<unknown>(
    principal,
    "/auth/solana/remove",
    { address },
    () => assertPrincipal(principal),
    withTimeout(),
  ).then(methodsFrom);
}
