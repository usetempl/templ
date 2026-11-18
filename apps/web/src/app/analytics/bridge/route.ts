import { analyticsBridge } from "@/lib/analytics-bridge";
import { SITE } from "@/lib/site-environment";

export function GET(request: Request) {
  const url = new URL(request.url);
  if (
    url.origin !== SITE.origin ||
    url.search ||
    process.env.NEXT_PUBLIC_APP_ENV !== "staging" ||
    process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID !== "G-TTRKRJ1HYL" ||
    process.env.NEXT_PUBLIC_ANALYTICS_BRIDGE_VERIFIED !== "true"
  )
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
    });
  const bridge = analyticsBridge();
  return new Response(bridge.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": bridge.csp,
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, nosnippet, noimageindex",
    },
  });
}
