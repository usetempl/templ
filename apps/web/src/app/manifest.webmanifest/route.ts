import { inboxManifest } from "@/lib/inbox-manifest";

export const dynamic = "force-static";

/** The inbox manifest. Not the app/manifest.ts convention: that would link
 * it from every page, landing included. */
export function GET() {
  return new Response(JSON.stringify(inboxManifest()), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
