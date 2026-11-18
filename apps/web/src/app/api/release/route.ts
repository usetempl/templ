import { webReleaseIdentity } from "@/lib/web-release-identity";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export async function GET() {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const identity = webReleaseIdentity(env);
    return Response.json(identity, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
