/** An explicit dismissal of Templ's sign-in dialog, not an authentication failure. */
export class ChatSignInCanceledError extends Error {
  constructor() {
    super("Sign-in canceled.");
    this.name = "ChatSignInCanceledError";
  }
}

export function isChatSignInCanceled(
  reason: unknown,
): reason is ChatSignInCanceledError {
  return reason instanceof ChatSignInCanceledError;
}
