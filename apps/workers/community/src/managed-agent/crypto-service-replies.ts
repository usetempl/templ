import { isCryptoLanguage } from "@templ/chat/crypto-languages";
import { checkAgentReply } from "@templ/chat/support-safety";
import bundled from "./crypto-service-translations.json" with { type: "json" };

/** Templ's own translations of the crypto desk's fixed replies: language code,
 * then the exact English reply, then its translation. A translation is used
 * only for a visitor's chosen chat language. An entry for a changed English
 * reply is ignored, and so is one that adds a number, link, domain, markup or
 * line break, drops a product or network name, or fails the AI reply screen.
 * The English reply is sent instead, so a fixed reply is never lost. */
const NAMES = ["Security Alliance", "Bitcoin", "Ethereum", "Solana", "Etherscan", "Solscan", "mempool.space"];
const NO_HOSTS: ReadonlySet<string> = new Set();
const DOMAIN = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const DIGITS = /\p{Nd}+/gu;
// Control and bidi characters could make a fixed reply display differently from what was checked.
const UNSAFE = /[\p{Cc}\p{Bidi_Control}<>]|:\/\/|www\.|\]\(/iu;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const digits = (text: string) => (text.match(DIGITS) ?? []).sort().join(" ");

function safeTranslation(english: string, text: unknown): text is string {
  return typeof text === "string" && text.length > 0 && text === text.trim() &&
    bytes(text) <= 1_000 && !UNSAFE.test(text) && digits(text) === digits(english) &&
    (text.match(DOMAIN) ?? []).every((domain) => english.toLowerCase().includes(domain.toLowerCase())) &&
    NAMES.every((name) => !english.includes(name) || text.includes(name)) &&
    !checkAgentReply(text, { allowedHosts: NO_HOSTS, maxBytes: 3_500 });
}

export type ServiceReplyTable = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The checked translations of `sources`, the current English replies. */
export function serviceReplyTable(sources: readonly string[], raw: unknown = bundled): ServiceReplyTable {
  const known = new Set(sources);
  const table = new Map<string, Map<string, string>>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return table;
  for (const [code, replies] of Object.entries(raw)) {
    if (code === "en" || !isCryptoLanguage(code) || !replies || typeof replies !== "object" || Array.isArray(replies))
      continue;
    const checked = new Map<string, string>();
    for (const [english, text] of Object.entries(replies))
      if (known.has(english) && safeTranslation(english, text)) checked.set(english, text);
    if (checked.size) table.set(code, checked);
  }
  return table;
}
