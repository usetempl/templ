export type BitcoinWalletProofChallenge = {
  origin: string;
  workspace: string;
  address: string;
  conversation: string;
  nonce: string;
  expiresAt: number;
};

/** Both the browser and the worker construct these exact UTF-8 message bytes. */
export function bitcoinWalletProofMessage({
  origin, workspace, address, conversation, nonce, expiresAt,
}: BitcoinWalletProofChallenge): string {
  const site = new URL(origin);
  if (
    site.protocol !== "https:" || site.origin !== origin ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(workspace) ||
    !/^bc1(?:q[02-9ac-hj-np-z]{38}|p[02-9ac-hj-np-z]{58})$/.test(address) ||
    (conversation !== "next" && !/^tc-[0-9a-f]{32}$/.test(conversation)) ||
    !/^[0-9a-f]{64}$/.test(nonce) ||
    !Number.isSafeInteger(expiresAt) || expiresAt <= 0
  ) throw new Error("Invalid Bitcoin support proof challenge.");

  return [
    "Share a Bitcoin address with Templ support",
    "",
    "Signing proves you control this address for this support request.",
    "It does not sign you in or authorize a transaction.",
    "",
    `Site: ${origin}`,
    `Workspace: ${workspace}`,
    "Network: Bitcoin mainnet",
    `Address: ${address}`,
    `Support request: ${conversation}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
  ].join("\n");
}
