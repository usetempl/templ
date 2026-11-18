import { HttpError } from "./common";
import type { AuthMethod } from "@templ/chat/principal";

export const AUTHENTICATED_AT_HEADER = "X-Session-Authenticated-At";
export const AUTH_METHOD_HEADER = "X-Session-Auth-Method";
/** The caller must validate the current session and current permissions first.
 * A valid EVM or Solana wallet session needs no additional age cutoff.
 * Attaching a wallet and widget guest sessions never qualify. */
const STRONG_METHODS: readonly AuthMethod[] = ["wallet", "solana"];
export function requireWalletAuth(
  auth: { authenticatedAt?: number; authMethod?: AuthMethod },
  confirmed: unknown,
  now = Date.now(),
): number {
  const at = auth.authenticatedAt;
  if (
    !auth.authMethod ||
    !STRONG_METHODS.includes(auth.authMethod) ||
    !Number.isSafeInteger(at) ||
    at! <= 0 ||
    at! > now
  )
    throw new HttpError(
      403,
      "Sign in with a wallet, then review and confirm this change.",
      undefined,
      "strong-auth-required",
    );
  if (confirmed !== true)
    throw new HttpError(
      400,
      "Review and confirm this privileged change.",
      undefined,
      "confirmation-required",
    );
  return at!;
}
export function requirePrivilegedHeaders(
  headers: Headers,
  confirmed: unknown,
  now = Date.now(),
) {
  return requireWalletAuth(
    {
      authenticatedAt: Number(headers.get(AUTHENTICATED_AT_HEADER)),
      authMethod: headers.get(AUTH_METHOD_HEADER) as AuthMethod | undefined,
    },
    confirmed,
    now,
  );
}

/** A valid email session can confirm a team invitation or delegated Admin change.
 * Manager and billing changes still need a wallet. */
export function requireTeamInvitationAuth(
  auth: { authenticatedAt?: number; authMethod?: AuthMethod },
  confirmed: unknown,
  now = Date.now(),
): number {
  if (auth.authMethod !== "email")
    return requireWalletAuth(auth, confirmed, now);
  const at = auth.authenticatedAt;
  if (
    !Number.isSafeInteger(at) ||
    at! <= 0 ||
    at! > now
  )
    throw new HttpError(
      403,
      "Sign in with email, then review and confirm this change.",
      undefined,
      "email-sign-in-required",
    );
  if (confirmed !== true)
    throw new HttpError(
      400,
      "Review and confirm this change.",
      undefined,
      "confirmation-required",
    );
  return at!;
}

/** Delegated Admin changes accept email; owner changes require wallet proof. */
export function requireWorkspaceAdminAuth(
  auth: { authenticatedAt?: number; authMethod?: AuthMethod },
  owner: boolean, confirmed: unknown, now = Date.now(),
): number {
  return owner ? requireWalletAuth(auth, confirmed, now)
    : requireTeamInvitationAuth(auth, confirmed, now);
}
export function requireWorkspaceAdminHeaders(
  headers: Headers, owner: boolean, confirmed: unknown, now = Date.now(),
): number {
  return requireWorkspaceAdminAuth({
    authenticatedAt: Number(headers.get(AUTHENTICATED_AT_HEADER)),
    authMethod: headers.get(AUTH_METHOD_HEADER) as AuthMethod | undefined,
  }, owner, confirmed, now);
}
