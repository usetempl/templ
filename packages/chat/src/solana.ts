/** Solana (SVM) facts shared by the app and the worker: the network name,
 * base58 and public-key checks, and the explorer. Nothing here signs or
 * reads a chain. */
export const SOLANA_NETWORK = "solana" as const;
export type SolanaNetwork = typeof SOLANA_NETWORK;
export const SOLANA_NAME = "Solana";
export const SOLANA_EXPLORER = "https://solscan.io";
/** How the wallet standard names Solana mainnet. */
export const SOLANA_WALLET_CHAIN = "solana:mainnet";
/** Key prefix for asset names and decimals of Solana mints, beside the
 * `${chainId}:${contract}` keys EVM assets use. */
export const solanaAssetKey = (mint: string) =>
  `${SOLANA_NETWORK}:${mint}` as const;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function base58Decode(value: string): Uint8Array {
  if (!value || !BASE58.test(value)) throw new Error("Invalid base58 text.");
  let big = 0n;
  for (const char of value) big = big * 58n + BigInt(ALPHABET.indexOf(char));
  const bytes: number[] = [];
  while (big > 0n) {
    bytes.push(Number(big & 255n));
    big >>= 8n;
  }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros++;
  return new Uint8Array([
    ...new Array<number>(zeros).fill(0),
    ...bytes.reverse(),
  ]);
}
export function base58Encode(bytes: Uint8Array): string {
  let big = 0n;
  for (const byte of bytes) big = (big << 8n) + BigInt(byte);
  let out = "";
  while (big > 0n) {
    out = ALPHABET[Number(big % 58n)] + out;
    big /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}
/** A 32-byte public key in base58 (32 to 44 characters): a wallet, a mint
 * or a collection address. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44)
    return false;
  if (!BASE58.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}
export function shortSolanaAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** The chain label inside the Sign In With Solana text. */
export const SOLANA_CHAIN_LABEL = "mainnet";
/** The Sign In With Solana text (the wallet-standard `signIn` format). The
 * worker builds it and compares it byte for byte on verification; the app
 * parses it before asking a wallet to sign. */
export type SolanaSignInFields = {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
  resources?: string[];
};
export function createSolanaSignInMessage(fields: SolanaSignInFields): string {
  const lines = [
    `${fields.domain} wants you to sign in with your Solana account:`,
    fields.address,
    "",
    fields.statement,
    "",
    `URI: ${fields.uri}`,
    "Version: 1",
    `Chain ID: ${SOLANA_CHAIN_LABEL}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expiration Time: ${fields.expirationTime.toISOString()}`,
  ];
  if (fields.resources?.length)
    lines.push("Resources:", ...fields.resources.map((item) => `- ${item}`));
  return lines.join("\n");
}
export type ParsedSolanaSignIn = {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  resources: string[];
};
export function parseSolanaSignInMessage(
  message: string,
): ParsedSolanaSignIn | null {
  const lines = message.split("\n");
  const header = /^(.+) wants you to sign in with your Solana account:$/.exec(
    lines[0] ?? "",
  );
  if (!header || !isSolanaAddress(lines[1]) || lines[2] !== "") return null;
  const statementEnd = lines.indexOf("", 3);
  if (statementEnd < 0) return null;
  const statement = lines.slice(3, statementEnd).join("\n");
  const fields: Record<string, string> = {};
  const resources: string[] = [];
  let inResources = false;
  for (const line of lines.slice(statementEnd + 1)) {
    if (inResources) {
      if (!line.startsWith("- ")) return null;
      resources.push(line.slice(2));
      continue;
    }
    if (line === "Resources:") {
      inResources = true;
      continue;
    }
    const separator = line.indexOf(": ");
    if (separator < 0) return null;
    fields[line.slice(0, separator)] = line.slice(separator + 2);
  }
  if (
    fields.Version !== "1" ||
    fields["Chain ID"] !== SOLANA_CHAIN_LABEL ||
    !fields.URI ||
    !fields.Nonce ||
    !fields["Issued At"] ||
    !fields["Expiration Time"]
  )
    return null;
  return {
    domain: header[1],
    address: lines[1],
    statement,
    uri: fields.URI,
    nonce: fields.Nonce,
    issuedAt: fields["Issued At"],
    expirationTime: fields["Expiration Time"],
    resources,
  };
}
