/** Staff on a phone: wallet-app links, the phone inbox and push alerts. */
export const phone = {
  // Wallet-app handoff (dialog and workspace card)
  "phone.handoff.titleRequest": "Open this case in your wallet app",
  "phone.handoff.copyHint":
    "Paste it in your wallet app’s browser, such as Rabby, Coinbase Wallet, Rainbow or Trust.",
  "phone.handoff.openIn": "Open in {name}",
  "phone.handoff.solana": "Solana wallets",
  "phone.handoff.copyLink": "Copy link",
  "phone.handoff.copied": "Copied",
  "phone.handoff.linkCopied": "Link copied.",
  "phone.card.body":
    "Templ signs in with your wallet. Your phone’s browser has none, so open this link in your wallet app. You stay signed in there for up to 30 days.",
  "phone.card.here": "Sign in here instead",
  // Phone inbox
  "phone.details.open": "Details",
  "phone.details.back": "Back to the case",
  "phone.actions.open": "Actions",
  // Push alerts
  "phone.push.label": "Push alerts on this device",
  "phone.push.blocked":
    "Alerts are blocked for this site in your browser settings.",
  "phone.push.privacy": "Alerts never include message text.",
  "phone.push.failed": "That didn’t work. Try again.",
} as const;
