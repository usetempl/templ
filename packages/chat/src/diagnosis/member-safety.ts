import { DIAGNOSIS_LIMITS } from "./rules";

/** The stricter gate for member drafts. It refuses any risky verb, negated or
 * not, so a template can never ask a member to act on a wallet. */
const CHECKS: readonly [string, RegExp][] = [
  ["control", /[\p{Cc}\p{Cf}]/u],
  ["link", /https?:\/\/|\bwww\./i],
  [
    "domain",
    /\b[a-z0-9-]+\.(?:com|io|xyz|org|net|app|fi|finance|exchange|link|gg|co)\b/i,
  ],
  ["address", /0x[0-9a-fA-F]{40}/],
  ["hash", /0x[0-9a-fA-F]{64}/],
  ["base58", /[1-9A-HJ-NP-Za-km-z]{32,}/],
  [
    "action",
    /\b(?:sign|signing|approve|approving|revoke|send|resend|submit|retry|try again|speed up|cancel|click|tap|visit|go to|connect|import|paste|enter|share|download|install|scan|claim|refund|reimburse|compensat\w*|guarantee\w*|seed|private key|recovery phrase|mnemonic|secret|password)\b/i,
  ],
];

/** The first risk in a member text, or null when it is safe to draft. */
export function memberTextRisk(text: string): string | null {
  if (typeof text !== "string") return "type";
  if (text.length > DIAGNOSIS_LIMITS.memberTextChars) return "length";
  for (const [name, pattern] of CHECKS) if (pattern.test(text)) return name;
  return null;
}
