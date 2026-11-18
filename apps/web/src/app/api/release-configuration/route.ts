import { getReleaseConfiguration } from "@/lib/config";

/** The same public, source-bound configuration already sent in page HTML. */
export async function GET() {
  const configuration = await getReleaseConfiguration();
  return Response.json(
    configuration.unavailable ? { error: "Release is unavailable." } : configuration,
    {
      status: configuration.unavailable ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
