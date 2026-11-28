import { CRYPTO_LINKS, CRYPTO_PROVIDER_PAGES, cryptoSourceLink } from "@templ/chat/crypto-help-links";

export const CRYPTO_DESK = {
  name: "Crypto Help Desk",
  logo: "/art/workspaces/crypto-networks.svg",
  stillLogo: "/art/workspaces/crypto-networks-still.svg",
} as const;

const reviewed = new Map([...CRYPTO_LINKS, ...Object.values(CRYPTO_PROVIDER_PAGES)].map(link => [link.url, link.label]));
export const cryptoDeskLink = (href: string) => reviewed.get(href);

export function cryptoDeskSources(sources: { title: string; url?: string }[], answer: string) {
  const seen = new Set<string>();
  const listed = answer.split("\n").filter(line => /^\s*(?:[-*+]\s+)?\[[^\]]+\]\(https:\/\/[^)]+\)\s*$/.test(line));
  return sources.flatMap(source => {
    const page = cryptoSourceLink(source.url);
    if (!page) return [];
    const { url, label: title } = page;
    if (seen.has(url) || listed.some(line => line.trimEnd().endsWith("(" + url + ")"))) return [];
    seen.add(url);
    return [{ title, url }];
  });
}
