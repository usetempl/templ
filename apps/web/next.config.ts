import type { NextConfig } from "next";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { assetHashes } from "./scripts/asset-hashes.mjs";
import {
  PRIVATE_PAGE_PATTERN,
  searchIndexingEnabled,
} from "./scripts/search-indexing.mjs";
import { readReleaseManifest, webBuildEnv } from "./scripts/release-public.mjs";

const indexing = searchIndexingEnabled(
  process.env.NEXT_PUBLIC_APP_ENV ?? "staging",
  readReleaseManifest(),
);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // /api/status publishes the served agent module hashes.
  // The release manifest reaches code only as its public projection.
  env: { ...assetHashes(), ...webBuildEnv() },
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/support-widget.js",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
      },
      {
        // Versioned widget builds never change once published.
        source: "/support-widget/:file*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          ...(!indexing
            ? [
                {
                  key: "X-Robots-Tag",
                  value: "noindex, nofollow, nosnippet, noimageindex",
                },
              ]
            : []),
          {
            key: "Link",
            value: '</llms.txt>; rel="describedby"; type="text/markdown"',
          },
          { key: "X-Content-Type-Options", value: "nosniff" },

          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=()",
          },
        ],
      },
      ...(CRYPTO_SUPPORT_WORKSPACE ? ["/crypto", "/eth", "/ethereum", `/help/${CRYPTO_SUPPORT_WORKSPACE}`] : []).map(source => ({
        source,
        missing: ["tab", "support", "invite"].map(key => ({ type: "query" as const, key })),
        headers: [{
          key: "Permissions-Policy",
          value: "geolocation=(), microphone=(self), camera=()",
        }],
      })),
      ...(indexing
        ? [
            {
              source: PRIVATE_PAGE_PATTERN,
              headers: [
                {
                  key: "X-Robots-Tag",
                  value: "noindex, nofollow, nosnippet, noimageindex",
                },
              ],
            },
          ]
        : []),
      {
        // The bridge supplies its own strict sandbox policy. Every other path stays non-frameable.
        source: "/:path((?!analytics/bridge$).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
  async redirects() {
    return [
      ...["/rooms/:id", "/room/:id"].map((source) => ({
        source,
        destination: "/inbox/:id",
        permanent: true,
      })),
      {
        source: "/images/templ-social.png",
        destination: "/images/templ-chat.png",
        permanent: false,
      },
      ...["/en", "/pt-br", "/es"].map((source) => ({
        source,
        destination: "/",
        permanent: false,
      })),
    ];
  },
};
export default nextConfig;
if (process.env.NODE_ENV === "development") void initOpenNextCloudflareForDev();
