import { getRelease } from "@/lib/config";
import { renderLlmsText } from "@/lib/llms-text";
import { publicReleaseStatus } from "@/lib/public-release";

export async function GET() {
  const release = await getRelease();
  return new Response(renderLlmsText(publicReleaseStatus(release), release), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
