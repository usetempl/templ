/** Reads what a workspace points Templ at: its protocol registry file, its
 * docs pages and sitemaps. External requests go through `safeFetch` (https
 * only, public hosts, no Templ zones, redirects re-checked, size and time
 * capped). Website previews can also read fixed public Templ pages. Nothing here signs, sends a transaction or follows a link found
 * in chat. Tests inject `fetch` and `resolve`. */
import { asksForSecret, hideAmbiguousHex } from "@templ/chat/support-safety";
import { detectStoredSecret } from "./secret-guard";
import { HttpError } from "./common";
import { parseSupportImport, importRowRefusal, IMPORT_REASON, type ImportRow } from "./support-import-parser";
import { KNOWLEDGE_LIMITS, PROFILE_LIMITS } from "@templ/chat/protocol-profile";
import {
  SafeFetchRefused,
  checkPublicHttpsUrl,
  safeFetch,
  type SafeFetchDependencies,
} from "./safe-fetch";
import { KnowledgeError } from "./support-knowledge-schema";

import { fetchWebsiteAsset, websiteBrand, type WebsiteBrand } from "./website-brand";

export type IngestDependencies = SafeFetchDependencies;

const media = (headers: Headers) =>
  (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
const decode = (body: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body);

/** A registry URL the manager may save: public https, no query. */
export function checkedRegistryUrl(value: unknown): string {
  try {
    return checkPublicHttpsUrl(String(value ?? ""), { allowQuery: false }).toString();
  } catch {
    throw new KnowledgeError(400, "registry-url", "Use a public https address for your registry.");
  }
}
export const REGISTRY_REASON_TEXT: Record<string, string> = {
  "registry-unreachable": "it didn't answer",
  "registry-timeout": "it took too long",
  "registry-too-large": "the file is over 5 MB",
  "registry-format": "the file isn't templ-profile/1 JSON or CSV",
};

export type RegistryFetch =
  | { kind: "text"; text: string; contentType: string; etag: string | null }
  | { kind: "unchanged" }
  | { kind: "failed"; reason: "registry-unreachable" | "registry-timeout" | "registry-too-large" | "registry-format" };

/** Reads the registry file, at most 5 MB in 10 seconds, with two
 * redirects on the same host and the stored ETag. */
export async function fetchRegistry(
  url: string,
  etag: string | null,
  dependencies: IngestDependencies = {},
): Promise<RegistryFetch> {
  try {
    const response = await safeFetch(
      url,
      {
        maxBytes: PROFILE_LIMITS.registryBytes,
        timeoutMs: 10_000,
        maxRedirects: 2,
        sameHost: true,
        allowQuery: false,
        headers: {
          accept: "application/json, text/csv",
          ...(etag ? { "if-none-match": etag } : {}),
        },
      },
      dependencies,
    );
    if (response.status === 304) return { kind: "unchanged" };
    if (response.status !== 200) return { kind: "failed", reason: "registry-unreachable" };
    const type = media(response.headers);
    if (!["application/json", "text/csv"].includes(type))
      return { kind: "failed", reason: "registry-format" };
    return {
      kind: "text",
      text: decode(response.body),
      contentType: type,
      etag: response.headers.get("etag"),
    };
  } catch (error) {
    if (error instanceof SafeFetchRefused) {
      if (error.reason === "timeout") return { kind: "failed", reason: "registry-timeout" };
      if (error.reason === "too-large") return { kind: "failed", reason: "registry-too-large" };
      if (error.reason === "content-type") return { kind: "failed", reason: "registry-format" };
    }
    return { kind: "failed", reason: "registry-unreachable" };
  }
}

/** A docs page URL the manager may add: public https; the query and
 * fragment are dropped. */
export function checkedPageUrl(value: unknown): string {
  try {
    const url = checkPublicHttpsUrl(String(value ?? ""), { allowQuery: true });
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw new KnowledgeError(400, "knowledge-url", "Use a public https address for this page.");
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, name: string) => {
    if (/^#x/i.test(name)) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    if (name.startsWith("#")) {
      const code = Number(name.slice(1));
      return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}
/** Readable text and the title of an HTML page: scripts, styles, navigation
 * and forms are dropped; block elements become paragraph breaks. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;
  const text = main
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|li|h[1-6]|tr|pre|blockquote|dd|dt)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() || null : null,
    text: decodeEntities(text)
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

async function suggestedQuestion(html: string) {
  const headings: string[] = [];
  let heading = "";
  const parser = new HTMLRewriter().on("h2, h3, h4", {
    element(tag) {
      heading = "";
      tag.onEndTag(() => {
        const text = heading.trim().replace(/\s+/g, " ").replace(/\?$/, "");
        if (headings.length < 16 && text.length >= 8 && text.length <= 100 &&
            /^(?:how|why|what|when|who|where|can|does|is|do)\s/i.test(text) &&
            !/[<>@:/]/.test(text) && !asksForSecret(text)) headings.push(text + "?");
      });
    },
    text(chunk) { heading += chunk.text.slice(0, 120 - heading.length); },
  });
  await parser.transform(new Response(html)).arrayBuffer();
  return headings.find((q) => /^(?:who is .+ for|how (?:does|do|can) |why )/i.test(q)) ?? headings[0];
}

export type PageFetch =
  | { kind: "text"; title: string | null; text: string; etag: string | null; suggestion?: string; brand?: WebsiteBrand & {docs: string[]} }
  | { kind: "unchanged" }
  | { kind: "gone" }
  | { kind: "failed"; error: string; suggestion?: string; brand?: WebsiteBrand & {docs: string[]} };
const PAGE_TYPES = ["text/html", "text/plain", "text/markdown", "application/xhtml+xml"];
/** Reads one docs page: HTML, Markdown or plain text, at most 1 MB. */
export async function fetchPage(
  url: string,
  etag: string | null,
  dependencies: IngestDependencies = {},
  includeBrand = false,
  findSuggestion = false,
  sameHost = false,
): Promise<PageFetch> {
  try {
    const response = await fetchWebsiteAsset(
      url,
      {
        maxBytes: KNOWLEDGE_LIMITS.pageBytes,
        timeoutMs: 10_000,
        maxRedirects: 3,
        sameHost,
        allowQuery: false,
        headers: {
          accept: "text/html, text/markdown, text/plain",
          ...(etag ? { "if-none-match": etag } : {}),
        },
      },
      dependencies,
    );
    if (response.status === 304) return { kind: "unchanged" };
    if (response.status === 404 || response.status === 410) return { kind: "gone" };
    if (response.status !== 200) return { kind: "failed", error: `status-${response.status}` };
    const type = media(response.headers);
    if (!PAGE_TYPES.includes(type)) return { kind: "failed", error: "content-type" };
    const body = decode(response.body);
    const page =
      type === "text/html" || type === "application/xhtml+xml"
        ? htmlToText(body)
        : { title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null, text: body };
    if ((await Promise.all([page.title ?? "", page.text].map((text) => detectStoredSecret(text)))).some(Boolean))
      return { kind: "failed", error: "secret-refused" };
    const brand = includeBrand && (type === "text/html" || type === "application/xhtml+xml")
      ? await websiteBrand(body, response.url, page.title) : undefined;
    if (brand && await detectStoredSecret([brand.name, brand.logo].join("\n"))) return { kind: "failed", error: "secret-refused" };
    if (!page.text.trim()) return { kind: "failed", error: "empty", ...(brand ? { brand } : {}) };
    const suggestion = (includeBrand || findSuggestion) && type === "text/html" ? await suggestedQuestion(body) : undefined;
    return { ...(brand ? { brand } : {}), ...(suggestion ? { suggestion: hideAmbiguousHex(suggestion) } : {}), kind: "text", title: page.title ? hideAmbiguousHex(page.title) : null, text: hideAmbiguousHex(page.text), etag: response.headers.get("etag") };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof SafeFetchRefused ? error.reason : "unavailable",
    };
  }
}

/** Page URLs a sitemap lists on its own host, at most 200. */
export async function fetchSitemap(
  url: string,
  dependencies: IngestDependencies = {},
): Promise<string[]> {
  let response;
  try {
    response = await safeFetch(
      url,
      {
        maxBytes: KNOWLEDGE_LIMITS.pageBytes,
        timeoutMs: 10_000,
        maxRedirects: 2,
        sameHost: true,
        allowQuery: false,
        headers: { accept: "application/xml, text/xml" },
      },
      dependencies,
    );
  } catch {
    throw new KnowledgeError(502, "knowledge-unreachable", "Templ couldn't read that sitemap.");
  }
  if (response.status !== 200 || !["application/xml", "text/xml"].includes(media(response.headers)))
    throw new KnowledgeError(502, "knowledge-unreachable", "Templ couldn't read that sitemap.");
  const host = new URL(url).hostname;
  const pages: string[] = [];
  for (const match of decode(response.body).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const page = new URL(decodeEntities(match[1]));
      if (page.protocol !== "https:" || page.hostname !== host) continue;
      page.search = "";
      page.hash = "";
      if (!pages.includes(page.toString())) pages.push(page.toString());
    } catch {
      /* skip */
    }
    if (pages.length >= KNOWLEDGE_LIMITS.sitemapPages) break;
  }
  return pages;
}

/** File uploads share the docs page byte cap and source limits. */
export async function parseKnowledgeImport(filename: unknown, content: unknown): Promise<ImportRow[]> {
  return Promise.all(parseSupportImport(filename, content, "knowledge").map(async (row) => {
    const refusal = await importRowRefusal(row, "knowledge");
    if (refusal) throw new HttpError(422, IMPORT_REASON[refusal], undefined, refusal);
    return { ...row, ...(row.url ? { url: checkedPageUrl(row.url) } : {}) };
  }));
}
