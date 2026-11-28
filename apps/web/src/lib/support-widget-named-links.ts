const MARKDOWN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/;
const SOURCE_BULLET = new RegExp(
  String.raw`^[^\S\n]*[-*+][^\S\n]+(?=(?:${MARKDOWN.source}|https?:\/\/\S+)[^\S\n]*$)`,
  "gm",
);
const LINKS = new RegExp(String.raw`${MARKDOWN.source}|\bhttps?:\/\/[^\s<>"\x60()[\]{}]+`, "gi");

export function namedLinks(node: HTMLElement, value: string, review: (href: string) => string | undefined) {
  const text = value.replace(/<(https?:\/\/[^\s<>]+)>/gi, "$1").replace(SOURCE_BULLET, "");
  // Decide link destinations from the original message. Format only the surrounding AI prose.
  const assistant = node.hasAttribute("data-assistant");
  const append = (part: string) => node.append(assistant
    ? part.replace(/(^|[^*])\*\*([^*\s](?:[^*\r\n]*?[^*\s])?)\*\*(?!\*)/g, "$1$2")
    : part);
  let end = 0;
  for (const match of text.matchAll(LINKS)) {
    const [whole, title, linked] = match;
    const href = linked ?? whole.replace(/[.,!?;:]+$/, "");
    const name = review(href);
    append(text.slice(end, match.index));
    if (name) {
      const link = document.createElement("a");
      link.textContent = name;
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow ugc";
      link.referrerPolicy = "no-referrer";
      node.append(link);
    } else node.append(title?.trim() || href);
    end = match.index + (linked ? whole.length : href.length);
  }
  append(text.slice(end));
}
