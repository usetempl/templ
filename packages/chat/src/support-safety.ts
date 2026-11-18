/** Recovery-phrase and secret-request rules shared by the worker and the
 * support agent. The worker refuses writes that contain a recovery phrase,
 * and staff or bot text that asks for one; the agent checks its replies and
 * removes secrets from the model's copy of a conversation.
 *
 * No Buffer or Node APIs: the module runs in workerd and browsers. The
 * widget imports support-safety-hex so its lazy chunk needs no wordlist. */
import { english } from "viem/accounts";
import { detectKeySecret, hideAmbiguousHex, solanaSecretCandidates, type KeySecretKind } from "@templ/chat/support-safety-hex";
export { ambiguousHexValues, hideAmbiguousHex } from "@templ/chat/support-safety-hex";

const WORDS = new Set<string>(english);
/** BIP39 phrases have 12 to 24 words. */
export const RECOVERY_PHRASE_MIN_WORDS = 12;
/** What replaces a removed value in the model's copy of a conversation. */
export const REDACTION_MARKERS = {
  phrase: "[removed: possible recovery phrase]",
  hex: "[hex value hidden]",
  base58: "[removed: long base58 value]",
  bytes: "[removed: possible key bytes]",
} as const;
export type RedactionKind = keyof typeof REDACTION_MARKERS;

/** Runs of at least 12 BIP39 English words. Tokens are /[A-Za-z]+/g,
 * lowercased; anything between tokens (spaces, commas, newlines, "1."
 * numbering, quotes, brackets) is ignored, and any other letter token breaks
 * the run. With `misses: 1` one token that is not a list word may sit inside
 * a run (a misspelled word) and counts toward its length. `words` is the
 * number of tokens the run covers. */
export function findRecoveryPhrases(
  text: string,
  options: { misses: 0 | 1 } = { misses: 0 },
): { start: number; end: number; words: number }[] {
  const allowed = options.misses === 1 ? 1 : 0;
  const tokens = [...String(text).matchAll(/[A-Za-z]+/g)];
  const listed = tokens.map((token) => WORDS.has(token[0].toLowerCase()));
  const runs: { start: number; end: number; words: number }[] = [];
  for (let start = 0; start < tokens.length; start++) {
    if (!listed[start]) continue;
    let last = start;
    let misses = 0;
    for (let next = start + 1; next < tokens.length; next++) {
      if (listed[next]) last = next;
      else if (++misses > allowed) break;
    }
    const words = last - start + 1;
    if (words < RECOVERY_PHRASE_MIN_WORDS) continue;
    runs.push({
      start: tokens[start].index!,
      end: tokens[last].index! + tokens[last][0].length,
      words,
    });
    start = last;
  }
  return runs;
}
/** The worker's refusal test: 12 consecutive list words, no misspelling. */
export function containsRecoveryPhrase(text: string): boolean {
  return findRecoveryPhrases(text, { misses: 0 }).length > 0;
}

const ASK = "send|share|enter|paste|give|provide|type|tell";
const DISCLOSE = `${ASK}|upload|attach|input|show|reveal|forward|copy|export|scan|photograph|encode`;
const SECRET_OBJECT = String.raw`private[-\s]+keys?|secret[-\s]+keys?|seed(?:[-\s]+phrases?)?|recovery[-\s]+(?:phrases?|words?)|mnemonic(?:[-\s]+phrases?)?|secret[-\s]+phrases?|keystore(?:[-\s]+files?)?|(?:wallet[-\s]+)?backups?(?:[-\s]+files?)?`;
const SECRET_MEDIUM = String.raw`screenshots?|screen[-\s]+shots?|photos?|photographs?|pictures?|images?|scans?|qr(?:[-\s]+codes?)?`;
/** "sign", but not "sign in", "sign-up" or "sign out". */
const SIGN = String.raw`sign(?![- ](?:in(?! your wallet)|up|out)\b)`;
export type TeamTextRefusal = "asks for a secret" | "asks for a credential" | "transaction instruction" | "signing instruction";
export type TeamTextOptions = { allowWalletInstructions?: boolean };
type AskRule = {
  refusal: TeamTextRefusal;
  verbs: string;
  things: string;
  reach: number;
};
/** Requests an agent must never make, each a verb followed closely by what
 * it asks for. The first is the secret request the worker refuses. */
const SECRET_ASK: AskRule = {
  refusal: "asks for a secret",
  verbs: DISCLOSE,
  things: SECRET_OBJECT,
  reach: 160,
};
const ASKS: readonly AskRule[] = [
  { refusal: "signing instruction", verbs: SIGN, things: "[.!?]?$|below|now|here|when prompted", reach: 40 },
  { refusal: "transaction instruction", verbs: "approve", things: "[.!?]?$|now|here|when prompted", reach: 40 },
  { refusal: "signing instruction", verbs: SIGN, things: "anything|this|that|it|in your wallet|with your wallet|to continue|to claim|to unlock|again", reach: 40 },
  { refusal: "transaction instruction", verbs: "approve", things: "spend|allowance|USDC|USDT|DAI|ETH|SOL|anything|this|that|it|in your wallet|the request", reach: 40 },
  { refusal: "transaction instruction", verbs: "send|transfer|deposit|pay", things: String.raw`(?:\d+(?:\.\d+)?\s*)?(?:ETH|SOL|USDC|USDT|DAI|BTC|tokens?|funds|crypto)\b|to (?:this|the|my|our) address`, reach: 40 },
  { refusal: "signing instruction", verbs: "connect", things: "claim|sign|rewards", reach: 80 },
  SECRET_ASK,
  {
    refusal: "asks for a credential",
    verbs: ASK,
    things: String.raw`api[- ]keys?|bot tokens?|access tokens?|auth(?:entication)? tokens?|passwords?|passcodes?|credentials?|admin (?:access|rights|permissions)|server access|2fa|one[- ]time (?:codes?|passwords?)`,
    reach: 60,
  },
  {
    refusal: "transaction instruction",
    verbs: "sign|approve|confirm|send|submit",
    things: "transaction|approval|transfer",
    reach: 30,
  },
  {
    refusal: "signing instruction",
    verbs: SIGN,
    things: "messages?|permits?|typed data|signatures?",
    reach: 40,
  },
  {
    refusal: "signing instruction",
    verbs: ASK,
    things: String.raw`signed messages?|(?:message|permit|typed[- ]data) signatures?|(?:a|an|your|new|fresh|another) signatures?|signatures? (?:of|for|on|from) (?:this|that|the|a|your) (?:message|permit|wallet|deployer)`,
    reach: 40,
  },
];
/** A warning such as "Never share a recovery phrase", "You don't need to send
 * a password" or "No one from Templ will ask you to sign a message": the
 * negation governs the verb, with only these words between them. "Don't
 * worry, share your key" and "Don't you want to share it?" stay refused. */
const GOVERNED = new RegExp(
  String.raw`\b(?:never|not|cannot|can't|don't|do not|doesn't|does not|won't|will not|shouldn't|should not|mustn't|must not|no one|nobody|no need to)(?!\s+you\b)(?:\s+(?:ever|need|needs|to|have|has|ask|asks|asked|you|anyone|anybody|us|we|be|will|would|should|must|required|want|at|from|templ|the|team|a|person|or|${DISCLOSE}|take|create|${SIGN}))*\s*$`,
  "i",
);
/** Sign, approve and send words that describe rather than instruct: a
 * diagnostic question ("Did you approve the spend?", "Why did the wallet ask
 * you to sign?"), the condition of an "if" clause ("If the wallet asks you
 * to approve, you can reject it.") and what the team or the app does ("We
 * will send the refund in USDC."). Secret and credential asks stay refused
 * in every form. */
const QUESTION = /^\s*(?:(?:and|so|but|ok|okay)[, ]+)?(?:(?:did|have|has|had|was|were)\b|(?:do|does|is|are)\s+(?:the|your|our|this|that|a|an|it)\b|(?:when|why|what|how|where|which)\s+(?:did|do|does|have|has|had|was|were|is|are)\b)[^?]*\?\s*$/i;
const CONDITION = /\bif\s+(?:(?:(?:the|your|our|an?)\s+)?(?:wallet|app|site|protocol|page|it|someone|anyone)\s+(?:asks?|asked|prompts?|prompted|tells?|told|requires?|required)\s+(?:you\s+)?to|you\s+(?:(?:are|were)\s+|(?:have|had)\s+been\s+)(?:asked|prompted|told|required)\s+to)\s*$/i;
const TEAM_SUBJECT = /\b(?:we|we'll|we've|our team|the team|templ|the app|our app|the protocol)\s+(?:(?:will|would|can|could|may|might|should|shall|just|already|then|also|usually|always|need to|have to|are going to|going to)\s+)*$/i;
function describes(sentence: string, before: string, replyContext = false) {
  const after = sentence.slice(before.length);
  const messageReview =
    /^(?:a|the) current group administrator must\s*$/i.test(before.trim()) &&
    (/^approve the (?:reply|message draft) before it reaches the (?:user|member)[.!]?$/i.test(
      after.trim(),
    ) ||
      (replyContext &&
        /^approve it before it reaches the (?:user|member)[.!]?$/i.test(
          after.trim(),
        )));
  const condition = CONDITION.test(before) && (
    /^[^,;:]*,/.test(after) ||
    /\b(?:reject|decline|refuse|avoid|don't|do not|never)\b/i.test(after)
  );
  const question = QUESTION.test(sentence) &&
    !/[,;:]|\b(?:then|please|(?:can|could|would|will) you|how about|why don't you|what if you)\b/i.test(before,
    );
  return question || condition || messageReview || TEAM_SUBJECT.test(before);
}
/** The first request in a sentence that no negation governs. Every verb is
 * checked, so "Don't send it here, share your seed phrase" is refused. */
function unguardedAsk(sentence: string, rules: readonly AskRule[],
  replyContext = false,
) {
  for (const { refusal, verbs, things, reach } of rules) {
    const strict = refusal === "asks for a secret" || refusal === "asks for a credential";
    const ask = new RegExp(
      String.raw`^(?:${verbs})\b[^!?;]{0,${reach}}\b(?:${things})`,
      "i",
    );
    for (const verb of sentence.matchAll(
      new RegExp(String.raw`\b(?:${verbs})\b`, "gi"),
    ))
      if (
        ask.test(sentence.slice(verb.index)) &&
        !GOVERNED.test(sentence.slice(0, verb.index)) &&
        !/\b(?:the|a|an|your|our|this|that|my)\s+$/i.test(sentence.slice(0, verb.index),
        ) &&
        (strict || !describes(sentence, sentence.slice(0, verb.index), replyContext))
      )
        return refusal;
  }
  return null;
}
/** A medium can request disclosure without a known verb, such as
 * "A screenshot of your seed phrase would help". Keep warnings allowed. */
function secretMediumRequest(sentence: string): boolean {
  const request = new RegExp(String.raw`\b(?:${SECRET_MEDIUM})\b[^!?;]{0,160}\b(?:${SECRET_OBJECT})\b`, "gi");
  for (const match of sentence.matchAll(request)) {
    const before = sentence.slice(0, match.index);
    const object = match[0].match(new RegExp(String.raw`\b(?:${SECRET_OBJECT})\b`, "i"))!;
    const after = sentence.slice(match.index! + match[0].length);
    if (GOVERNED.test(before) ||
        /\b(?:remove|delete|redact|hide|blur)\s+(?:(?:the|a|an|your)\s+)*$/i.test(before) ||
        /\b(?:without|excluding)\s+(?:your\s+|the\s+)?$/i.test(match[0].slice(0, object.index)) ||
        /^\s+(?:hidden|removed|redacted|excluded|covered|blurred)\b/i.test(after)) continue;
    return true;
  }
  return false;
}
/** Asking for a public transaction reference ("send the transaction
 * signature", "paste the tx hash", "share the signature from Solscan") is
 * how a case starts, not a request to sign or send anything. A new
 * signature ("provide a signature", "your signature of this message") stays
 * refused. */
const TX_REFERENCE = /\b(?:transaction|tx|txn)\s+(?:signatures?|hash(?:es)?|ids?|links?|urls?|receipts?)\b/gi;
/** Sentence by sentence, so "Never share a recovery phrase" stays allowed. */
function sentences(text: string) {
  return text.replace(/[‘’]/g, "'").split(/(?<=[.!?])\s+/);
}
/** True for "Send your seed phrase", false for "Never share your recovery
 * phrase". The worker applies it to team text only: a member quoting what a
 * scam site asked for must still reach the team. */
export function asksForSecret(text: string): boolean {
  if (typeof text !== "string") return false;
  return sentences(text).some(
    (sentence) => unguardedAsk(sentence, [SECRET_ASK]) !== null || secretMediumRequest(sentence),
  );
}
/** The first request for a secret, a credential, a signature or a
 * transaction that no negation governs, or null. The same requests
 * `checkAgentReply` refuses, without its address, link and length rules:
 * the eval scorer's "next step is safe" item. */
export function screenTeamText(text: string, options: TeamTextOptions = {}): TeamTextRefusal | null {
  if (typeof text !== "string") return null;
  if (asksForSecret(text)) return "asks for a secret";
  const rules = options.allowWalletInstructions
    ? ASKS.filter((rule) => rule.refusal === "asks for a secret" || rule.refusal === "asks for a credential")
    : ASKS;
  let previous = "";
  for (const sentence of sentences(text.replace(TX_REFERENCE, "tx reference"),
  )) {
    const replyContext =
      /\bprepare (?:a|the) reply[.!]?$/i.test(previous) &&
      !/\b(?:wallet|transaction|transfer|token|funds|spend|USDC|USDT|ETH|SOL|signature|permit)\b/i.test(
        previous,
      );
    const refusal = unguardedAsk(sentence, rules, replyContext);
    if (refusal) return refusal;
    previous = sentence;
  }
  return null;
}
/** An agent reply is refused (the reason is returned) when it is empty or
 * too long, asks for a secret, a credential, a signature or a transaction,
 * contains a recovery phrase, links outside `allowedHosts` or names an
 * address. Null means the reply may be sent. */
export function checkAgentReply(
  text: string,
  options: { allowedHosts: ReadonlySet<string>; maxBytes?: number },
): string | null {
  if (typeof text !== "string" || !text.trim()) return "empty reply";
  if (new TextEncoder().encode(text).length > (options.maxBytes ?? 3500))
    return "reply too long";
  const refusal = screenTeamText(text);
  if (refusal) return refusal;
  const secret = detectSecret(text);
  if (secret) return secret === "phrase" ? "contains a recovery phrase" : "contains a private key";
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]"']+/gi)) {
    let host: string;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      return "malformed link";
    }
    if (!options.allowedHosts.has(host)) return `link to ${host}`;
  }
  if (/\b(0x[0-9a-f]{40})\b/i.test(text)) return "names an address";
  return null;
}

/** The values a transaction check lets a registered AI agent restate: the
 * `claims` of the agent's view of one check. */
export type DiagnosisClaimSet = {
  status: string;
  networks: readonly string[];
  numbers: readonly string[];
  tokens: readonly string[];
  shortRefs: readonly string[];
};
const CLAIM_NUMBER = /<0\.000001|\d+(?:[.,]\d+)*/g;
const CLAIM_SHORT_REF =
  /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}|[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/g;
/** A symbol written next to an amount: "12.5 USDC", "0.3 stETH" or
 * "USDC 12.5". A symbol has two capitals in a row, so a word such as
 * "Step 2" is not one. */
const CLAIM_TOKEN =
  /\d(?:[\d.,]*\d)?\s*([a-z]{0,4}[A-Z]{2,}[A-Z0-9]*(?:\.[a-z])?)(?![A-Za-z0-9])|(?<![A-Za-z0-9])([a-z]{0,4}[A-Z]{2,}[A-Z0-9]*(?:\.[a-z])?)\s*\d/g;
const withoutGrouping = (value: string) => value.replace(/,(?=\d{3}\b)/g, "");

/** A reply that rests on transaction checks may restate only what the
 * checks found. Returns why the reply is refused, or null when every
 * number, short reference, token next to an amount and network name it
 * mentions is in one of `claims`. `networks` lists the network names Templ
 * reads (the check list's `networks`), so a network the checks don't name
 * is caught too. Nothing else in the check, such as the team's next steps,
 * is ever part of `claims`. */
export function checkDiagnosisClaims(
  text: string,
  claims: readonly DiagnosisClaimSet[],
  known: { networks?: readonly string[] } = {},
): string | null {
  if (typeof text !== "string" || !claims.length) return null;
  const numbers = new Set(
    claims.flatMap((set) => set.numbers.map(withoutGrouping)),
  );
  const tokens = new Set(claims.flatMap((set) => set.tokens));
  const refs = new Set(claims.flatMap((set) => set.shortRefs));
  const networks = new Set(claims.flatMap((set) => set.networks));
  for (const ref of text.match(CLAIM_SHORT_REF) ?? [])
    if (!refs.has(ref)) return `reference ${ref} is not in the check`;
  // Short references carry digits; they are checked above.
  const rest = text.replace(CLAIM_SHORT_REF, " ");
  for (const found of rest.match(CLAIM_NUMBER) ?? [])
    if (!numbers.has(withoutGrouping(found)))
      return `number ${found} is not in the check`;
  for (const match of rest.matchAll(CLAIM_TOKEN)) {
    const symbol = match[1] ?? match[2];
    if (!tokens.has(symbol)) return `token ${symbol} is not in the check`;
  }
  for (const name of known.networks ?? [])
    if (
      !networks.has(name) &&
      new RegExp(
        `(?:^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
      ).test(text)
    )
      return `network ${name} is not in the check`;
  return null;
}

/** 32 bytes as hex: a private key and a transaction hash look the same. */
const HEX_32 = /(?<![0-9A-Za-z])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
/** An extended private key (BIP32 xprv and its variants). */
const EXTENDED_KEY = /\b[xtyz]prv[1-9A-HJ-NP-Za-km-z]{100,}\b/g;
/** 64 bytes in base58: a Solana secret key or transaction signature. */
const BASE58_64 = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![0-9A-Za-z])/g;
/** A 64-byte keypair written as a number array, as Solana's CLI saves it. */
const KEY_BYTES = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;
const hexValue = (value: string) =>
  value.trim().replace(/^0x/i, "").toLowerCase();

/** The model's copy of one message. Recovery phrases (one misspelled word
 * tolerated), 64-byte key arrays, 64-character hex values, extended private
 * keys and long base58 values are replaced by REDACTION_MARKERS. `shared`
 * lists the thread's member-shared, server-checked transaction hashes and
 * signatures; an exact match of one stays. `found` names what was removed,
 * never the value. */
export function redactForModel(
  text: string,
  shared: {
    evmHashes?: readonly string[];
    solanaSignatures?: readonly string[];
  } = {},
): { text: string; found: RedactionKind[] } {
  const hashes = new Set(
    (shared.evmHashes ?? [])
      .filter((value) => typeof value === "string")
      .map(hexValue),
  );
  const signatures = new Set(
    (shared.solanaSignatures ?? [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim()),
  );
  const found: RedactionKind[] = [];
  let out = String(text);
  for (const run of findRecoveryPhrases(out, { misses: 1 }).reverse()) {
    out =
      out.slice(0, run.start) + REDACTION_MARKERS.phrase + out.slice(run.end);
    found.push("phrase");
  }
  const replace = (
    kind: RedactionKind,
    pattern: RegExp,
    keep: (value: string) => boolean = () => false,
  ) => {
    out = out.replace(pattern, (value) => {
      if (keep(value)) return value;
      found.push(kind);
      return REDACTION_MARKERS[kind];
    });
  };
  const ambiguous = solanaSecretCandidates(out).filter((candidate) => !signatures.has(candidate.value));
  const hiddenHex = hideAmbiguousHex(out, [...hashes, ...signatures]);
  if (hiddenHex !== out) {
    found.push(...ambiguous.map((candidate) => candidate.kind === "key-bytes" ? "bytes" as const : "base58" as const));
    found.push(...[...out.matchAll(HEX_32)].filter((match) => !hashes.has(hexValue(match[0]))).map(() => "hex" as const));
    out = hiddenHex;
  }
  replace("base58", EXTENDED_KEY);
  replace("base58", BASE58_64, (value) => signatures.has(value));
  replace("base58", /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{50,88}(?![0-9A-Za-z])/g, (value) => signatures.has(value) || detectSecret(value) === null);
  return { text: out, found };
}

/** Recognized secret formats are refused before any content is stored. */
export type SecretKind = "phrase" | KeySecretKind;
export function detectSecret(text: string): SecretKind | null {
  if (containsRecoveryPhrase(text)) return "phrase";
  return detectKeySecret(text);
}
