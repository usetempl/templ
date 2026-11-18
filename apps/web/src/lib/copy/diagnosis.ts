import type { SupportDiagnosisErrorReason } from "@templ/chat/support-diagnosis";

/** Words for the transaction check panel in the inbox. Team only. Checked
 * against the no-ai-slop eval: plain actions, no claims beyond what the
 * check read. */
export const DIAGNOSIS_COPY = {
  title: "Transaction check",
  teamOnly: "Team only",
  shared: "Shared by the user",
  check: "Check",
  checkAgain: "Check again",
  checking: "Checking the transaction",
  pastePlaceholder: "Transaction hash or explorer link",
  pasteLabel: "Check another transaction",
  noTransaction: "No transaction shared yet. Paste a hash or an explorer link.",
  networkOff: "Templ doesn't check {network} yet.",
  solanaOff: "Templ doesn't check Solana transactions here yet.",
  evmOff: "Templ doesn't check EVM transactions here yet.",
  appReported: "The app reported",
  chainShows: "The chain shows",
  templReading: "Templ's reading",
  inference: "Inference",
  notKnown: "Not known",
  observed: "Observed {time} UTC",
  captured: "Captured {time} UTC",
  succeeded:
    "A successful transaction doesn't mean the user's problem is solved.",
  unknownPending:
    "The transaction has not reached a final result. Check again when the providers have an update.",
  unknownMissing:
    "The providers did not find this transaction. It may still show up.",
  unknownUnavailable:
    "The providers could not confirm the result. A person should review the evidence and check again.",
  unknownDisagree:
    "The providers gave different answers. A person should review both observations before drawing a conclusion.",
  nextStep: "Next step (team only)",
  needsPerson: "Someone on the team should answer this one.",
  checkedBy: "Checked {time} UTC by {name}",
  you: "you",
  checkedShare: "Checked {time} UTC when the user shared it",
  checkedAskAi: "Checked {time} UTC for Ask AI",
  openOn: "Open on {host}",
  putInReply: "Put summary in reply",
  replaceAsk: "Replace the reply you started with the check summary?",
  replace: "Replace",
  keepMine: "Keep mine",
  noSummary:
    "There's no summary for the user on this one. Write the reply yourself.",
  rateAsk: "Was this check right?",
  rateYes: "Yes",
  ratePartly: "Partly",
  rateNo: "No",
  rated: "Saved.",
  refusal: [
    "A shared value looked like a wallet private key.",
    "Templ didn't check it and removed it from the shared details.",
    "Ask the user to move their funds to a new wallet and delete any message with the key.",
  ],
  unreadable: "A saved check can't be shown. Run it again.",
  error: "The check didn't run. Try again.",
} as const;

export const DIAGNOSIS_ERRORS: Partial<
  Record<SupportDiagnosisErrorReason, string>
> = {
  "diagnosis-unavailable": "Transaction checks aren't available yet.",
  "diagnosis-network-off": "Templ doesn't check that network yet.",
  "diagnosis-busy":
    "Another check is running in this case. Try again in a minute.",
  "diagnosis-too-soon":
    "This transaction was checked a few seconds ago. Try again shortly.",
  "diagnosis-limit": "The daily limit for transaction checks is used up.",
  "support-paused":
    "Support is paused until the team adds balance, so transaction checks wait too.",
  "secret-refused": "This looks like a private key. Templ didn't check it.",
  "invalid-transaction":
    "This doesn't look like a transaction hash. Paste the hash or the explorer link.",
  "invalid-network": "Choose a supported network.",
};
