import { checkPublicHttpsUrl, safeFetch } from "./safe-fetch";
import { HttpError } from "./common";

export type WebsiteBrand = { name: string; accent: string; logo: string };
const fallbackAccent = "#99ff00";

export function websiteUrl(input: unknown) {
  if (typeof input !== "string" || !input.trim())
    throw new HttpError(400, "Enter your website.");
  const value = input.trim();
  try {
    const url = checkPublicHttpsUrl(
      /^[a-z][\w+.-]*:/i.test(value) ? value : "https://" + value,
      { allowQuery: true },
    );
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    throw new HttpError(400, "Enter a public HTTPS website.");
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
    const url = checkPublicHttpsUrl(new URL(value, base).href, {
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
    touchIcon = "";
  let theme = "",
    tile = "",
    mask = "",
    css = "";
  const head = new HTMLRewriter()
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
  const color = [theme, cssAccent, mask, tile].find(
    (value) => value && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value),
  );
  if (color)
    brand.accent =
      color.length === 4
        ? "#" + [...color.slice(1)].map((c) => c + c).join("")
        : color;
  const name = (siteName || appName || title || brand.name)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return {
    ...brand,
    name: name || brand.name,
    logo: touchIcon || icon || new URL("/favicon.ico", site).href,
  };
}

/** Return an image for an img element under the dashboard's existing image policy.
 * The visitor's browser never needs to contact the imported site. */
export async function previewIcon(url: string) {
  if (!url) return "";
  try {
    const file = await safeFetch(url, {
      maxBytes: 48_000,
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
    return type
      ? "data:" + type + ";base64," + btoa(String.fromCharCode(...bytes))
      : "";
  } catch {
    return "";
  }
}
