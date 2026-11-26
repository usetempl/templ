import {
  checkPublicHttpsUrl,
  safeFetch,
  type SafeFetchDependencies,
  type SafeFetchOptions,
} from "./safe-fetch";
import { HttpError, readBytes } from "./common";

export type WebsiteBrand = { name: string; accent: string; logo: string };
const fallbackAccent = "#99ff00";

const templHomepage = "https://usetempl.com/";
const templIcons = [
  templHomepage + "favicon.svg",
  templHomepage + "apple-touch-icon.png",
];
const templPublicPages = [templHomepage, "https://docs.usetempl.com/"];
const templAssets = [...templPublicPages, ...templIcons];

/** Only these fixed, public files can be read on Templ domains. Never follow redirects. */
export async function fetchWebsiteAsset(
  url: string,
  options: SafeFetchOptions,
  dependencies: SafeFetchDependencies = {},
) {
  const asset = templAssets.find((known) => known === url);
  if (!asset) return safeFetch(url, options, dependencies);
  const response = await (dependencies.fetch ?? fetch)(asset, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      accept: options.headers?.accept || "image/*",
      ...(options.headers?.["if-none-match"]
        ? { "if-none-match": options.headers["if-none-match"] }
        : {}),
    },
  });
  const body =
    response.status === 200
      ? await readBytes(response, options.maxBytes)
      : new Uint8Array();
  if (response.status !== 200) await response.body?.cancel();
  return {
    url: asset,
    status: response.status,
    headers: response.headers,
    body,
  };
}

export function websiteUrl(input: unknown) {
  if (typeof input !== "string" || !input.trim())
    throw new HttpError(400, "Enter your website.");
  const value = input.trim();
  try {
    if (value.length > 2048) throw new Error();
    const url = new URL(
      /^[a-z][\w+.-]*:/i.test(value) ? value : "https://" + value,
    );
    if (url.protocol === "http:") url.protocol = "https:";
    url.hash = "";
    url.search = "";
    if (url.href === templHomepage || url.href === "https://www.usetempl.com/")
      return templHomepage;
    if (templPublicPages.includes(url.href)) return url.href;
    return checkPublicHttpsUrl(url.href).href;
  } catch {
    throw new HttpError(400, "Enter a public website, like example.com.");
  }
}

export function defaultBrand(site: string): WebsiteBrand {
  const url = new URL(site);
  return {
    name: url.hostname.replace(/^www\./, "").slice(0, 80),
    accent: fallbackAccent,
    logo: "",
  };
}

export function publicIcon(value: string, base: string) {
  try {
    const candidate = new URL(value, base);
    candidate.search = "";
    candidate.hash = "";
    if (templIcons.includes(candidate.href)) return candidate.href;
    const url = checkPublicHttpsUrl(candidate.href, {
      allowQuery: false,
    });
    return url.href;
  } catch {
    return "";
  }
}

/** Parse metadata with the runtime HTML parser. Never render the imported markup. */
export async function websiteBrand(
  html: string,
  site: string,
  title: string | null,
) {
  const brand = defaultBrand(site);
  let siteName = "",
    appName = "",
    icon = "",
    touchIcon = "",
    headerLogo = "";
  const docs: { url: string; priority: number }[] = [];
  const home = new URL(site);
  const homeHost = home.hostname.replace(/^www\./, "");
  const docHosts = ["docs", "help", "support", "learn", "guides"].map(prefix => prefix + "." + homeHost);
  let anchorText = "";

  function considerDoc(target: URL, label: string) {
    const ownSite = target.hostname.replace(/^www\./, "") === homeHost;
    const docHost = docHosts.includes(target.hostname);
    const namedDocs = /^(?:(?:read|view|visit|open|explore) (?:the )?)?(?:(?:developer|product|api) )?(?:docs|documentation|help cent(?:er|re)|knowledge base|user guides?|faq)s?$/i.test(label.trim());
    const docsProvider = /\.(?:gitbook\.io|readme\.io|mintlify\.app)$/.test(target.hostname);
    if (!ownSite && !docHost && !(docsProvider && namedDocs)) return;
    const path = target.pathname.replace(/\/$/, "");
    const root = /(?:^|\/)(?:docs|documentation|guides?|help|learn|faq|knowledge-base)$/i.test(path);
    const article = /(?:^|\/)(?:docs|documentation|guides?|help|learn|overview|introduction|getting-started|faq|about)(?:\/|$)/i.test(path);
    const priority = namedDocs || root || (docHost && !path) ? 1 : article || docHost ? 2 : 0;
    if (!priority) return;
    try {
      const url = websiteUrl(target.href);
      if (url === home.href) return;
      const previous = docs.find(doc => doc.url === url);
      if (previous) previous.priority = Math.min(previous.priority, priority);
      else docs.push({ url, priority });
      docs.sort((a, b) => a.priority - b.priority);
      docs.splice(2);
    } catch {
      // The same public URL rules apply to discovered and manually entered pages.
    }
  }
  let theme = "",
    tile = "",
    mask = "",
    css = "";
  const head = new HTMLRewriter()
    .on("img[src]", {
      element(tag) {
        if (headerLogo) return;
        const alt = tag.getAttribute("alt") || "";
        const classes = tag.getAttribute("class") || "";
        if (/(?:^|[\s_-])logo(?:$|[\s_-])/i.test(alt + " " + classes))
          headerLogo = publicIcon(tag.getAttribute("src") || "", site);
      },
    })
    .on("a[href]", {
      element(tag) {
        anchorText = "";
        const href = tag.getAttribute("href")?.trim();
        if (!href || href.startsWith("#")) return;
        let target: URL;
        try {
          target = new URL(href, site);
        } catch {
          return;
        }
        if (target.protocol !== "https:" || target.search || target.username || target.password || target.port) return;
        target.hash = "";
        considerDoc(target, tag.getAttribute("aria-label") || tag.getAttribute("title") || "");
        tag.onEndTag(() => considerDoc(target, anchorText.replace(/\s+/g, " ")));
      },
      text(chunk) {
        if (anchorText.length < 120) anchorText += chunk.text.slice(0, 120 - anchorText.length);
      },
    })
    .on("head meta", {
      element(tag) {
        const key = (
          tag.getAttribute("property") ||
          tag.getAttribute("name") ||
          ""
        ).toLowerCase();
        const value = tag.getAttribute("content")?.trim();
        if (!value) return;
        if (key === "og:site_name" && !siteName) siteName = value;
        if (key === "application-name" && !appName) appName = value;
        if (
          key === "theme-color" &&
          !tag.getAttribute("media")?.includes("dark")
        )
          theme ||= value;
        if (key === "msapplication-tilecolor") tile ||= value;
      },
    })
    .on("head style", {
      text(chunk) {
        if (css.length < 65_536)
          css += chunk.text.slice(0, 65_536 - css.length);
      },
    })
    .on("head link[rel][href]", {
      element(tag) {
        const rel = (tag.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        const href = tag.getAttribute("href");
        if (!href) return;
        if (rel.includes("mask-icon")) mask ||= tag.getAttribute("color") || "";
        if (!touchIcon && rel.includes("apple-touch-icon"))
          touchIcon = publicIcon(href, site);
        if (!icon && rel.includes("icon")) icon = publicIcon(href, site);
      },
    });
  await head.transform(new Response(html)).arrayBuffer();
  const cssAccent =
    /--(?:color-brand|brand-color|color-primary|primary-color|accent-color|brand|primary)\s*:\s*(#[a-f\d]{3,6})\b/i.exec(
      css,
    )?.[1];
  const brandSurface = [...css.matchAll(/([^{}]{1,256})\{([^{}]{1,2048})\}/g)]
    .filter((rule) =>
      /\.(?:logo-container|brand-mark|brand-background|btn-primary|button-primary|nav-btn-active)\b/i.test(
        rule[1],
      ),
    )
    .map(
      (rule) =>
        /(?:^|;)\s*background(?:-color)?\s*:\s*(#[a-f\d]{6})\b/i.exec(
          rule[2],
        )?.[1],
    )
    .find(Boolean);
  const backgrounds = [
    ...css.matchAll(
      /(?:^|[}])\s*(?:html|body|:root)(?:\s*,\s*(?:html|body|:root))*\s*\{([^{}]+)\}/gi,
    ),
  ]
    .map(
      (rule) =>
        /(?:^|;)\s*background(?:-color)?\s*:\s*(#[a-f\d]{6})\b/i.exec(
          rule[1],
        )?.[1],
    )
    .filter((hex) => {
      if (!hex) return false;
      const channels = [1, 3, 5].map((i) =>
        Number.parseInt(hex.slice(i, i + 2), 16),
      );
      return Math.max(...channels) - Math.min(...channels) >= 28;
    });
  const color = [
    cssAccent,
    brandSurface,
    theme,
    mask,
    tile,
    ...backgrounds,
  ].find((value) => value && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value));
  if (site === templHomepage) brand.accent = fallbackAccent;
  else if (color)
    brand.accent =
      color.length === 4
        ? "#" + [...color.slice(1)].map((c) => c + c).join("")
        : color;
  const titleParts = (title || "").split(/\s+[-–—|]\s+/);
  const shortTitle =
    titleParts.length === 2 &&
    /^(?:lend|borrow|home|docs|dashboard|overview|app|log in|sign in)$/i.test(
      titleParts[1],
    )
      ? titleParts[0]
      : title;
  const name = (siteName || appName || shortTitle || brand.name)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return {
    ...brand,
    name: name || brand.name,
    logo: touchIcon || headerLogo || icon || new URL("/favicon.ico", site).href,
    docs: docs.map(doc => doc.url),
  };
}

/** Return an image for an img element under the dashboard's existing image policy.
 * The visitor's browser never needs to contact the imported site. */
export async function previewIcon(url: string) {
  if (!url) return "";
  try {
    const file = await fetchWebsiteAsset(url, {
      maxBytes: 80 * 1024,
      timeoutMs: 3_000,
      maxRedirects: 2,
      allowQuery: false,
    });
    if (file.status !== 200 || !file.body.length) return "";
    const bytes = file.body;
    const signature = [...bytes.subarray(0, 8)].join(",");
    let type = "";
    if (signature === "137,80,78,71,13,10,26,10") type = "image/png";
    else if (signature.startsWith("255,216,255,")) type = "image/jpeg";
    else if (signature.startsWith("0,0,1,0,")) type = "image/x-icon";
    else if (signature.startsWith("71,73,70,56,")) type = "image/gif";
    else if (
      file.headers.get("content-type")?.split(";")[0] === "image/svg+xml" &&
      /<svg[\s>]/i.test(new TextDecoder().decode(bytes)) &&
      !/<!(?:DOCTYPE|ENTITY)|<script|<foreignObject|\son\w+\s*=/i.test(
        new TextDecoder().decode(bytes),
      )
    )
      type = "image/svg+xml";
    else if (
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
    )
      type = "image/webp";
    if (!type) return "";
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return "data:" + type + ";base64," + btoa(binary);
  } catch {
    return "";
  }
}
