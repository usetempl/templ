import { agentApiStatus } from "@/lib/agent-api";
import { renderAgentsGuide } from "@/lib/agents-guide";
import { SITE } from "@/lib/site-environment";

export async function GET() {
  const { getRelease } = await import("@/lib/config");
  const RELEASE = await getRelease();
  const pythonVerified = agentApiStatus(RELEASE, SITE.docs).python.verified;
  return new Response(
    renderAgentsGuide({
      supportWidgetSolanaVerified: RELEASE.supportWidgetSolanaVerified,
      pythonVerified,
    }),
    {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    },
  );
}
