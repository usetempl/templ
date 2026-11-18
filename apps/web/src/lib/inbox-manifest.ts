import type { MetadataRoute } from "next";

/** Where the manifest is served. Only the inbox and workspace pages link it,
 * so the landing and other public pages never offer to install Templ. */
export const INBOX_MANIFEST_PATH = "/manifest.webmanifest";

/** The installable staff inbox: Add to Home Screen opens the workspace list
 * full screen. */
export function inboxManifest(): MetadataRoute.Manifest {
  return {
    id: "/inbox",
    name: "Templ",
    short_name: "Templ",
    description: "Your team’s support inbox.",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    background_color: "#0d0d0d",
    theme_color: "#0d0d0d",
    icons: [
      { src: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/app-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
