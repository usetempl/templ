export const BAD_HASH = "This doesn't look like a transaction ID.";
export const WALLET_CHANGED = "Your wallet changed. Sign in again.";
/** Only reviewed visitor-facing copy may enter the widget's error line. */
export const UNAVAILABLE = "Support is unavailable. Try again.";
export const SIGN_IN_AGAIN = "Sign in again to keep your case.";
const SECRET =
  "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone.";
const PUBLIC_COPY = /* @__PURE__ */ new Set([
  UNAVAILABLE,
  SIGN_IN_AGAIN,
  SECRET,
  "Support could not load. Reload this page.",
  "Contact could not load. Reload this page.",
  "Connect a wallet on this website.",
  "Connect an EVM wallet on this website.",
  "Connect a Solana wallet on this website.",
  "Sign in with your wallet to contact support.",
  "This team asks you to sign in with your wallet.",
  WALLET_CHANGED,
  "Your wallet changed. Try again.",
  "The wallet sign-in does not match this website.",
  "Couldn’t check your wallet. Sign in again.",
  "Signature cancelled. Nothing was sent.",
  "Could not verify this wallet sign-in.",
  "The wallet did not respond. Try again.",
  "This wallet can't sign in here. Try another wallet.",
  "Start a new case.",
  "Open secure chat.",
  "Wait for your message to send.",
  "Verify your wallet before sending.",
  "You're offline. It will send when you're back online.",
  "Connection interrupted. Try again.",
  "Support is busy. Try again soon.",
  "Support tools are being tested.",
  "This link could not open your case.",
  "The check couldn't load. Try again.",
  BAD_HASH,
  "This doesn't look like a transaction ID. Paste the hash or the explorer link.",
  "This doesn't look like a transaction ID. Paste the hash, signature or explorer link.",
  "Wait a moment before sending again.",
  "Too many cases were opened recently. Try again later.",
  "This team cannot accept a new case right now.",
  "This team can't take new cases right now.",
  "This team can’t take new cases right now. To reopen your case, send a message here later.",
  "This case is closed. Send a message to open it again.",
  "Case not found.",
  "You do not have permission to do that.",
  "You are banned from posting in this chat.",
  "You are muted in this chat.",
  "You already answered.",
  "Choose a PNG, JPEG or WebP image.",
  "This image is too large. Try a smaller screenshot.",
  "This case can't take more screenshots.",
  "Email isn't available right now.",
]);

/** Read cross-frame errors too. Browser names and unknown text stay private. */
export function widgetErrorMessage(reason: unknown) {
  const value = reason as {
    name?: string;
    message?: string;
    reason?: string;
    status?: number;
  } | null;
  if (/^(Abort|Timeout|Type|Syntax)Error$/.test(value?.name ?? ""))
    return UNAVAILABLE;
  if (typeof value?.message === "string" && PUBLIC_COPY.has(value.message))
    return value.message;
  if (value?.reason === "new-case-stale")
    return "This case changed. Open your latest case and try again.";
  if (value?.reason === "secret-refused") return SECRET;
  if (value?.reason === "access-level-required")
    return "This team asks you to sign in with your wallet.";
  if (value?.reason === "session-ended" || value?.status === 401)
    return SIGN_IN_AGAIN;
  if (value?.status === 429) return "Wait a moment before sending again.";
  return UNAVAILABLE;
}
