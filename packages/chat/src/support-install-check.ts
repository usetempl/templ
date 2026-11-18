/** Fixed check ids and results; free text is never part of an install record. */
export const INSTALL_CHECK_IDS = ["context", "consent", "identity", "reply", "secrets", "outage"] as const;
export type InstallCheckId = (typeof INSTALL_CHECK_IDS)[number];
export type InstallCheckResult = { id: InstallCheckId; at: number; pass: boolean };
export type InstallCheckRecord = { id: string; startedAt: number; results: InstallCheckResult[] };
export const INSTALL_CHECK_LABELS: Record<InstallCheckId, { label: string; fix: string }> = {
  context: { label: "Context from the attempted action", fix: "Call captureFailure with the failure kind and app action when the action fails." },
  consent: { label: "Context waits for consent", fix: "Keep app details out of message text. Let the user tick each context row." },
  identity: { label: "Wallet identity is labeled", fix: "Pass the connected wallet to setWallet. Verification happens in the sign-in card." },
  reply: { label: "A team reply returns to this chat", fix: "Reply to the install preview from the inbox, then keep this chat open." },
  secrets: { label: "Recognized keys are refused", fix: "Update the widget and worker together, then run this check again." },
  outage: { label: "Your page works during an outage", fix: "Catch widget loading failures and keep your page usable when support is unavailable." },
};
export function installCheckComplete(record: InstallCheckRecord | null | undefined): boolean {
  return INSTALL_CHECK_IDS.slice(0, 4).every((id) => record?.results.some((row) => row.id === id && row.pass));
}
