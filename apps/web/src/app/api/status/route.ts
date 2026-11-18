import { getReleaseConfiguration } from "@/lib/config";
import { publicReleaseStatus } from "@/lib/public-release";
export async function GET() {
  const configuration = await getReleaseConfiguration();
  return Response.json(
    configuration.unavailable
      ? { error: "Release is unavailable." }
      : publicReleaseStatus(configuration.release),
    {
      status: configuration.unavailable ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
