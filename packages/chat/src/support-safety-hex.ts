/** Browser-safe candidate detection; only the worker proves a Solana keypair. */
import { base58Decode } from "@templ/chat/solana";
const HEX_32 = /(?<![0-9A-Za-z])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
const BASE58_64 = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{64,88}(?![0-9A-Za-z])/g;
const KEY_BYTES = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;
const PHRASE_SHAPE = /(?:^|[^a-z])(?:[a-z]{3,8}[^a-z]+){11,23}[a-z]{3,8}(?:[^a-z]|$)/i;
/** Conservative storage screen. The worker checks the full word list before storage. */
export function hasRecoveryPhraseShape(text: string): boolean {
  return PHRASE_SHAPE.test(text);
}
export type SolanaSecretCandidate = { value: string; start: number; end: number; bytes: Uint8Array; kind: "solana-key" | "key-bytes" };
export function solanaSecretCandidates(text: string): SolanaSecretCandidate[] {
  const found: SolanaSecretCandidate[] = [];
  for (const match of text.matchAll(BASE58_64)) {
    const bytes = base58Decode(match[0]);
    if (bytes.length === 64) found.push({ value: match[0], start: match.index!, end: match.index! + match[0].length, bytes, kind: "solana-key" });
  }
  for (const match of text.matchAll(KEY_BYTES)) {
    try {
      const bytes: unknown = JSON.parse(match[0]);
      if (Array.isArray(bytes) && bytes.length === 64 && bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))
        found.push({ value: match[0], start: match.index!, end: match.index! + match[0].length, bytes: new Uint8Array(bytes), kind: "key-bytes" });
    } catch { /* Only JSON byte arrays are candidates. */ }
  }
  return found;
}
export type KeySecretKind =
  | "solana-key"
  | "key-bytes"
  | "extended-key"
  | "wif"
  | "labelled-hex";
/** Recognizes key formats without a recovery-word list or keypair proof. */
export function detectKeySecret(text: string): KeySecretKind | null {
  if (/\b[xt]prv[1-9A-HJ-NP-Za-km-z]{100,}\b/.test(text)) return "extended-key";
  for (const match of text.matchAll(
    /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{50,52}(?![0-9A-Za-z])/g,
  )) {
    const bytes = base58Decode(match[0]);
    if (
      bytes[0] === 0x80 &&
      (bytes.length === 37 || (bytes.length === 38 && bytes[33] === 1))
    )
      return "wif";
  }
  for (const candidate of solanaSecretCandidates(text))
    if (nearKeyLabel(text, candidate.start, candidate.end))
      return candidate.kind;
  for (const value of text.matchAll(HEX_32))
    if (nearKeyLabel(text, value.index!, value.index! + value[0].length))
      return "labelled-hex";
  return null;
}
/** Recognize an object label beside its value during device persistence. */
export function detectKeySecretValue(
  label: string,
  value: unknown,
): KeySecretKind | null {
  const serialized = JSON.stringify(value);
  const normalized = label.replace(/([a-z])([A-Z])/g, "$1 $2");
  return (
    detectKeySecret(`${label}: ${serialized}`) ??
    (normalized === label
      ? null
      : detectKeySecret(`${normalized}: ${serialized}`))
  );
}
/** A key label must be within 40 characters of either side of the value. */
function nearKeyLabel(text: string, start: number, end: number): boolean {
  return [
    ...text.matchAll(/\b(?:private\s+key|privkey|secret\s+key|pk|seed)\b/gi),
  ].some((label) => {
    const distance =
      label.index! < start
        ? start - (label.index! + label[0].length)
        : label.index! - end;
    return distance >= 0 && distance <= 40;
  });
}
const canonical = (value: string) => /^(?:0x)?[0-9a-f]{64}$/i.test(value) ? value.replace(/^0x/i, "").toLowerCase() : value;
function candidates(text: string) {
  return [
    ...[...text.matchAll(HEX_32)].map((match) => ({ value: match[0], start: match.index!, end: match.index! + match[0].length })),
    ...solanaSecretCandidates(text),
  ].sort((a, b) => a.start - b.start);
}
export function ambiguousHexValues(text: string, sharedHashes: readonly string[] = []): string[] {
  const shared = new Set(sharedHashes.map(canonical));
  return [...new Set(candidates(text).filter(({ value }) => !shared.has(canonical(value))).map(({ value }) => value))];
}
/** One sink screen for ambiguous hex, Solana signatures and keypair-shaped byte arrays. */
export function hideAmbiguousHex(text: string, sharedHashes: readonly string[] = []): string {
  const shared = new Set(sharedHashes.map(canonical));
  let out = text;
  for (const candidate of candidates(text).reverse())
    if (!shared.has(canonical(candidate.value))) out = out.slice(0, candidate.start) + "[hex value hidden]" + out.slice(candidate.end);
  return out;
}
