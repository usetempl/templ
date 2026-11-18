/** The wallet kind the last sign-in on this browser used, so the dialog can
 * say which one it was. */
export type SignInMethod = "wallet" | "solana" | "email";

const storageKey = "templ:last-sign-in-method";

function isSignInMethod(value: unknown): value is SignInMethod {
  return value === "wallet" || value === "solana" || value === "email";
}

export function readLastSignInMethod(): SignInMethod | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(storageKey);
    return isSignInMethod(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberSignInMethod(method: SignInMethod): void {
  if (typeof window === "undefined" || !isSignInMethod(method)) return;
  try {
    window.localStorage.setItem(storageKey, method);
  } catch {
    // A blocked or full store must not interrupt a successful sign-in.
  }
}
