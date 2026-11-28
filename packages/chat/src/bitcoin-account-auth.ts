export type BitcoinAccountPurpose = "login" | "connect" | "attach";
export type BitcoinAccountChallenge = {
  origin: string;
  address: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  purpose: BitcoinAccountPurpose;
  connectCode?: string;
  principalId?: string;
  sessionHash?: string;
};

const bitcoinAccountHash = /^[a-f0-9]{64}$/;
const bitcoinAccountPrincipal =
  /^(?:account:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|0x[a-f0-9]{40})$/;
const bitcoinConnectCode = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const bitcoinAccountAddress =
  /^bc1(?:q[02-9ac-hj-np-z]{38}|p[02-9ac-hj-np-z]{58})$/;
export function isBitcoinAccountAddress(value: unknown): value is string {
  return typeof value === "string" && bitcoinAccountAddress.test(value);
}
const bitcoinChallengeLifetime = 5 * 60_000;

export function bitcoinAccountMessage(c: BitcoinAccountChallenge): string {
  const site = new URL(c.origin);
  if (
    site.origin !== c.origin ||
    site.protocol !== "https:" ||
    !isBitcoinAccountAddress(c.address) ||
    !bitcoinAccountHash.test(c.nonce) ||
    !Number.isSafeInteger(c.issuedAt) ||
    !Number.isSafeInteger(c.expiresAt) ||
    c.issuedAt <= 0 ||
    c.expiresAt <= c.issuedAt ||
    c.expiresAt - c.issuedAt > bitcoinChallengeLifetime
  )
    throw new Error("Invalid Bitcoin account challenge.");
  let consent: string;
  const binding: string[] = [];
  switch (c.purpose) {
    case "login":
      if (
        c.connectCode !== undefined ||
        c.principalId !== undefined ||
        c.sessionHash !== undefined
      )
        throw new Error("Invalid Bitcoin sign-in challenge.");
      consent = "Sign in to your Templ account with Bitcoin.";
      break;
    case "connect":
      if (
        typeof c.connectCode !== "string" ||
        !bitcoinConnectCode.test(c.connectCode) ||
        c.principalId !== undefined ||
        c.sessionHash !== undefined
      )
        throw new Error("Invalid Bitcoin connection challenge.");
      consent =
        "Sign in with Bitcoin to connect this app to your Templ workspace.";
      binding.push(`Install request: ${c.origin}/connect/${c.connectCode}`);
      break;
    case "attach":
      if (
        c.connectCode !== undefined ||
        typeof c.principalId !== "string" ||
        !bitcoinAccountPrincipal.test(c.principalId) ||
        typeof c.sessionHash !== "string" ||
        !bitcoinAccountHash.test(c.sessionHash)
      )
        throw new Error("Invalid Bitcoin wallet link challenge.");
      consent =
        "Add this Bitcoin wallet as a sign-in method for your Templ account.";
      binding.push(`Account: ${c.principalId}`, `Session: ${c.sessionHash}`);
      break;
    default:
      throw new Error("Invalid Bitcoin account purpose.");
  }
  return [
    consent,
    "",
    `Site: ${c.origin}`,
    "Network: Bitcoin mainnet",
    `Address: ${c.address}`,
    ...binding,
    `Nonce: ${c.nonce}`,
    `Issued: ${new Date(c.issuedAt).toISOString()}`,
    `Expires: ${new Date(c.expiresAt).toISOString()}`,
  ].join("\n");
}

/** Check the complete signed text against the intent shown in the browser. */
export function validateBitcoinAccountChallenge(
  response: unknown,
  expected: {
    origin: string;
    address: string;
    purpose: BitcoinAccountPurpose;
    connectCode?: string;
    principalId?: string;
  },
  now = Date.now(),
): boolean {
  if (!response || typeof response !== "object") return false;
  const { challenge, message, expiresAt } = response as Record<string, unknown>;
  if (
    !challenge ||
    typeof challenge !== "object" ||
    typeof message !== "string"
  )
    return false;
  if (
    Object.keys(challenge).some(
      (key) =>
        ![
          "origin",
          "address",
          "nonce",
          "issuedAt",
          "expiresAt",
          "purpose",
          "connectCode",
          "principalId",
          "sessionHash",
        ].includes(key),
    )
  )
    return false;
  const c = challenge as BitcoinAccountChallenge;
  try {
    return (
      c.origin === expected.origin &&
      c.purpose === expected.purpose &&
      (expected.address === expected.address.toLowerCase() ||
        expected.address === expected.address.toUpperCase()) &&
      c.address === expected.address.toLowerCase() &&
      expiresAt === c.expiresAt &&
      c.connectCode === expected.connectCode &&
      c.principalId === expected.principalId &&
      c.issuedAt <= now &&
      now < c.expiresAt &&
      bitcoinAccountMessage(c) === message
    );
  } catch {
    return false;
  }
}
