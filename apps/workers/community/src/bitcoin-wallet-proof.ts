import { decodeAddress, verifySignature } from "@orangecheck/bip322";

/** Accept mainnet native SegWit and key-path Taproot wallet addresses. */
export function canonicalBitcoinProofAddress(input: unknown): string | null {
  if (typeof input !== "string" || (input.length !== 42 && input.length !== 62)) return null;
  const address = input.toLowerCase();
  if (input !== address && input !== input.toUpperCase()) return null;
  if (!address.startsWith("bc1")) return null;
  const parsed = decodeAddress(address);
  return parsed?.network === "mainnet" && (parsed.type === "p2wpkh" || parsed.type === "p2tr")
    ? address
    : null;
}

/** Accept only BIP-322 simple. Some wallets omit the modern "smp" prefix. */
export function verifyBitcoinWalletProof(address: string, message: string, signature: string): boolean {
  if (canonicalBitcoinProofAddress(address) !== address || typeof message !== "string" ||
      message.length > 1024 || typeof signature !== "string" || signature.length > 155) return false;
  const encoded = signature.startsWith("smp") ? signature.slice(3) : signature;
  try {
    if (!encoded || btoa(atob(encoded)) !== encoded) return false;
    // With the prefix this library dispatches only to its BIP-322 simple verifier.
    // Its generic unprefixed verification path can also accept BIP-137.
    return verifySignature(address, message, "smp" + encoded);
  } catch {
    return false;
  }
}
