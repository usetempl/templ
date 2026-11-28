import sourceHeadings from "./crypto-source-headings.json" with { type: "json" };
import { OPERATIONAL_LIMITS } from "@templ/chat/plans";
import { CRYPTO_REPLY_LIMIT } from "@templ/chat/support-models";

import { CRYPTO_LINKS, CRYPTO_PROVIDER_PAGES, NETWORK_NAMES, cryptoSourceLink, type CryptoProviderPage } from "@templ/chat/crypto-help-links";
export { CRYPTO_LINKS, type CryptoNetwork, type CryptoLink } from "@templ/chat/crypto-help-links";

const byUrl = new Map(CRYPTO_LINKS.map((link) => [link.url, link] as const));
const providerByUrl = new Map<string, CryptoProviderPage>(Object.values(CRYPTO_PROVIDER_PAGES).map(page => [page.url, page]));
/** Hosts of reviewed links, for the shared reply check. The exact address
 * and its label are checked separately. */
export const CRYPTO_LINK_HOSTS: ReadonlySet<string> = new Set(
  CRYPTO_LINKS.map((link) => new URL(link.url).hostname),
);
/** Links the AI may write in one answer, and source lines Templ adds to it. */
export const CRYPTO_LINK_LIMITS = { inline: 4, sources: 3 } as const;

/** The links the AI may offer, one per line, for its prompt and its verifier. */
export const CRYPTO_OFFERED_LINKS = CRYPTO_LINKS.filter((link) => link.offer)
  .map(
    (link) =>
      `[${link.label}](${link.url}) for ${
        link.networks.length
          ? link.networks.map((network) => NETWORK_NAMES[network]).join(", ")
          : "any network"
      }: ${link.offer}`,
  )
  .join("\n");

/** Wallet basics Templ reviewed for beginners. The desk's AI may state them
 * without a passage, and its verifier accepts them. Each sentence passes the
 * reply screen, so a copied sentence is never refused. */
export const CRYPTO_WALLET_BASICS = [
  "A receive address is public. Share it to receive funds. It cannot move your funds. On these public networks, people can look up the activity of an address. A wallet uses a public key and a private key. In an ordinary Solana wallet, its public key is the receive address. Bitcoin and Ethereum wallets display an address you can copy.",
  "A recovery phrase, also called a seed phrase or secret recovery phrase, is usually 12 or 24 words. It can restore the keys created from those words. A private key lets its holder authorize spending. Anyone with the secret can spend from an ordinary single-key wallet. Never share them or type them into a website, chat or form. Real support never asks for them, and Templ never will.",
  "To make a new wallet, install a wallet app from its official site or app store page. Choose to create a new wallet. If the app shows a recovery phrase, write it on paper in the right order. Keep the paper private and offline. Do not take a photo or screenshot of it. The app then shows your receive address.",
  "Funds move on one network. The sender and the receiver must use the same network for the asset. An exchange can offer one coin on several networks, such as USDC on Ethereum, Base or Solana, so choose a network the receiving wallet supports. A regular Ethereum account has the same address on Base, OP Mainnet and Arbitrum, and each network keeps a separate balance. A smart contract wallet may not have the same address on every network. A Bitcoin address works only on Bitcoin, and a Solana address works only on Solana. Funds sent on a network the receiver does not support can be hard or impossible to recover.",
  "Before a first or large transfer to a new address, many people make a small test transfer. They check that it arrived on the right network before they move the rest. Each transfer pays its own network fee.",
  "Network fees are paid in the network's own coin: BTC on Bitcoin, ETH on Ethereum, Base, OP Mainnet and Arbitrum, and SOL on Solana. Some apps pay this fee for the user.",
]
  .map((line) => "- " + line)
  .join("\n");

// Bidirectional controls, invisible characters, soft hyphens and tag
// characters can make the address a visitor reads differ from the real one.
const HIDDEN =
  /[\u{ad}\u{34f}\u{61c}\u{115f}\u{1160}\u{180e}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{3164}\u{feff}\u{ffa0}\u{e0000}-\u{e007f}]/u;
// Joiners and variation selectors belong to some scripts and emoji, never
// inside Latin text.
const JOINED = /[!-~][\u{200c}\u{200d}\u{fe00}-\u{fe0f}]|[\u{200c}\u{200d}\u{fe00}-\u{fe0f}][!-~]/u;
const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\(([^()\s]{1,500})\)/g;
const SCHEME =
  /\b[a-z][a-z0-9+.-]{1,30}:\/\/|\b(?:about|blob|data|file|intent|javascript|mailto|sms|tel|vbscript|bitcoin|ethereum|lightning|solana|tron|wc|ipfs|ipns|magnet):(?=[\p{L}\p{N}/+])/iu;
// Domain-like words with an ASCII ending. Prose in a script without spaces
// can run into the first label.
const DOMAIN =
  /(?<![\p{L}\p{N}.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63})(?![a-z0-9-])/giu;
// Two letters end a country domain. Code files, ENS names and SNS names are
// not web addresses, so only these longer endings count.
const CODE_ENDINGS = new Set("cs db go gz js kt md py rb rs sh ts xz".split(" "));
const WEB_ENDINGS = new Set(
  "app bond biz buzz capital cash cfd claims click cloud club com credit crypto cyou dao dev digital edu exchange finance foundation fun fund gift global gov help icu info link live lol market money mov net nft online org pro quest sbs shop site space store support tech top trade vip wallet website world wtf xyz zip".split(" "),
);
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** Why a desk reply's links break the policy, or null. Each link must be a
 * reviewed address with its own label, written as [label](address). The
 * reply may name a reviewed site, such as bitcoin.org, without a path. It may
 * not hold any other address, scheme or hidden character. */
export function cryptoLinkProblem(
  text: string,
  maxLinks: number = CRYPTO_LINK_LIMITS.inline,
  allowProviderCitations = false,
): string | null {
  if (HIDDEN.test(text) || JOINED.test(text)) return "hidden characters";
  const linked = new Set<string>();
  let rest = "",
    at = 0;
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const link = byUrl.get(match[2]) ?? (allowProviderCitations ? providerByUrl.get(match[2]) : undefined);
    if (!link || link.label !== match[1]) return "unreviewed link";
    linked.add(link.url);
    rest += text.slice(at, match.index) + " ";
    at = match.index! + match[0].length;
  }
  rest += text.slice(at);
  if (linked.size > maxLinks) return "too many links";
  const shown = rest
    .normalize("NFKC")
    .replace(/(?<=[a-z0-9-])[\u{3002}\u{ff0e}\u{ff61}](?=[a-z0-9-])/giu, ".");
  if (/\]\(|<\s*a\b|\bhref\s*=/i.test(shown) || SCHEME.test(shown))
    return "unreviewed link";
  for (const token of shown.match(/[\p{L}\p{N}-]*\.[\p{L}\p{N}.-]*/gu) ?? [])
    if (/[a-z]/i.test(token) && LOOKALIKE.test(token)) return "lookalike letters";
  for (const match of shown.matchAll(DOMAIN)) {
    const ending = match[0].slice(match[0].lastIndexOf(".") + 1).toLowerCase();
    if (
      !ending.startsWith("xn--") &&
      (ending.length === 2 ? CODE_ENDINGS.has(ending) : !WEB_ENDINGS.has(ending))
    )
      continue;
    const tail = match[0].replace(/^.*\P{ASCII}/su, "");
    const start = match.index! + match[0].length - tail.length;
    if (
      !CRYPTO_LINK_HOSTS.has(tail.toLowerCase()) ||
      /[/:@]/.test(shown[start - 1] ?? "") ||
      /[/:@?#]/.test(shown[match.index! + match[0].length] ?? "")
    )
      return "unreviewed address";
  }
  return null;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** The answer and, after a "Sources:" line, one line per reviewed page behind
 * it. Each link names the actual page used, including reviewed copies. Wallet
 * downloads and app lists are never sources. */
export function withCryptoSources(text: string, hits: readonly { url?: string; kind?: string; visibility?: string; excerpt?: string }[], language?: string, providers: readonly CryptoProviderPage[] = []) {
  const heading = language && Object.hasOwn(sourceHeadings, language)
    ? sourceHeadings[language as keyof typeof sourceHeadings] : "Sources:";
  const lines = new Set(providers.map(page => `[${page.label}](${page.url})`));
  for (const hit of hits) {
    const urls = hit.url ? [hit.url] : [];
    if (hit.kind === "faq" && hit.visibility === "member-safe")
      for (const match of (hit.excerpt ?? "").matchAll(/\bReference: (https:\/\/[^\s<>()[\]]+)/g))
        urls.push(match[1]);
    for (const url of urls) {
      const link = cryptoSourceLink(url);
      if (!link || link.kind === "wallet" || link.kind === "apps") continue;
      const line = `[${link.label}](${link.url})`;
      if (lines.has(line)) continue;
      const candidate = `${text}\n\n${heading}\n${[...lines, line].join("\n")}`;
      if ([...candidate].length > CRYPTO_REPLY_LIMIT || bytes(candidate) > OPERATIONAL_LIMITS.messageMaxBytes) continue;
      lines.add(line);
      if (lines.size === CRYPTO_LINK_LIMITS.sources) return candidate;
    }
  }
  return lines.size ? `${text}\n\n${heading}\n${[...lines].join("\n")}` : text;
}
