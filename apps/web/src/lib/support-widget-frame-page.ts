/** Frame mode's document, answered by the web
 * worker's entry before the app runs. On Templ's frame host only
 * `GET /support-frame/v1/<workspace>?origin=<page>&build=<id>` gets a
 * document: a small page with a strict policy that loads the build's `frame`
 * chunk by its SHA-384 and may be framed only by the page it names. It sets
 * no cookie, loads no analytics and makes no call itself; the chunk inside
 * talks to the support service, which approves the page like any website.
 * Every other path on the frame host, and `/support-frame/` on any other
 * host, is an empty 404. */
import { isFrameHostOrigin, WIDGET_FRAME_PATH } from "@templ/chat/widget-frame";
import { SITE } from "./site-environment";
import {
  supportedWidgetVersions,
  type SupportWidgetVersion,
} from "./support-widget-release";

type FrameChunk = { path: string; sha384: string };
type Site = {
  origin: string;
  frame: string;
  community: string;
  docs: string;
  blog: string;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The document's largest size, asserted by its test. */
export const FRAME_PAGE_BYTES = 1_500;

const empty = () =>
  new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** A fresh 128-bit nonce, base64. */
function newNonce() {
  let text = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16)))
    text += String.fromCharCode(byte);
  return btoa(text);
}

/** The frame chunk of a build a page may still load, or null. */
function frameChunk(
  build: string,
  versions: readonly SupportWidgetVersion[],
): FrameChunk | null {
  const chunk = versions.find((item) => item.id === build)?.chunks.frame;
  return chunk &&
    /^\/support-widget\/frame-[0-9a-f]{16}\.js$/.test(chunk.path) &&
    /^[A-Za-z0-9+/]{64}$/.test(chunk.sha384)
    ? chunk
    : null;
}

/** The frame document for a request, a 404, or null when the request is
 * not the frame's to answer. */
export function supportFrameResponse(
  request: Request,
  input: {
    site?: Site;
    versions?: readonly SupportWidgetVersion[];
    nonce?: string;
  } = {},
): Response | null {
  const site = input.site ?? SITE;
  const url = new URL(request.url);
  const onFrameHost = url.hostname === new URL(site.frame).hostname;
  if (!onFrameHost)
    return url.pathname.startsWith("/support-frame/") ? empty() : null;
  if (url.origin !== site.frame) return empty();
  if (request.method !== "GET" && request.method !== "HEAD") return empty();
  const workspace = url.pathname.startsWith(WIDGET_FRAME_PATH)
    ? url.pathname.slice(WIDGET_FRAME_PATH.length)
    : "";
  const keys = [...url.searchParams.keys()];
  const origin = url.searchParams.get("origin");
  const build = url.searchParams.get("build") ?? "";
  if (
    !UUID.test(workspace) ||
    keys.length !== 2 ||
    keys.sort().join() !== "build,origin" ||
    !isFrameHostOrigin(origin) ||
    Object.values(site).includes(origin)
  )
    return empty();
  const chunk = frameChunk(build, input.versions ?? supportedWidgetVersions());
  if (!chunk) return empty();
  const nonce = input.nonce ?? newNonce();
  const api = new URL(site.community);
  const config = JSON.stringify({
    v: 1,
    workspace,
    host: origin,
    nonce,
  }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="normal"><meta name="referrer" content="no-referrer"><title>Support chat</title><style nonce="${nonce}">html,body{margin:0;background:transparent}</style>
<script type="application/json" id="templ-frame">${config}</script>
<script type="module" src="${site.origin}${chunk.path}" integrity="sha384-${chunk.sha384}" crossorigin="anonymous"></script>
</head><body><p id="templ-frame-top" hidden>Open this chat from the website that shows it.</p></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src ${site.origin}/support-widget/`,
        `connect-src ${api.origin} wss://${api.host}`,
        `frame-src ${api.origin}`,
        "img-src https: data: blob:",
        `style-src 'nonce-${nonce}'`,
        "font-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${origin}`,
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
