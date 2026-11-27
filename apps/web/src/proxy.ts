import { type NextRequest, NextResponse } from "next/server";
import { APP_ENVIRONMENT, SITE } from "./lib/site-environment";

type FeatureDirective = "connect-src" | "frame-src" | "img-src";
/** Hosts a feature adds to the app's policy, by directive. Each entry is an exact https origin. There is no script-src entry:
 * the policy uses 'strict-dynamic', which makes browsers ignore host
 * allowlists, so a feature script loads from nonced code (next/script with
 * the nonce, or inserted by a nonced script). */
const FEATURE_HOSTS: readonly Partial<Record<FeatureDirective, string[]>>[] = [
  // The visitor check's frame on Templ's own pages, when Templ's workspace
  // turns the check on. Member sockets already reach the community host.
  { "frame-src": [SITE.community, "https://secure-support.usetempl.com"] },
];
const featureHosts = (name: FeatureDirective) =>
  FEATURE_HOSTS.flatMap((entry) => entry[name] ?? []);
const directive = (name: string, ...sources: string[]) =>
  [name, ...sources].join(" ");

/** One strict policy per HTML response. Next reads the nonce from the request
 * header and applies it to its framework scripts during dynamic rendering. */
export function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    directive("script-src", "'self'", `'nonce-${nonce}'`, "'strict-dynamic'"),
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    directive(
      "img-src",
      "'self'",
      "blob:",
      "data:",
      SITE.community,
      ...featureHosts("img-src"),
    ),
    "font-src 'self' data:",
    directive(
      "connect-src",
      "'self'",
      SITE.community,
      SITE.community.replace("https:", "wss:"),
      ...(APP_ENVIRONMENT === "production" ? ["https://plausible.io/api/event"] : []),
      ...featureHosts("connect-src"),
    ),
    ...(featureHosts("frame-src").length
      ? [directive("frame-src", "'self'", ...featureHosts("frame-src"))]
      : []),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|apple-touch-icon.png|images/|analytics/bridge).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
