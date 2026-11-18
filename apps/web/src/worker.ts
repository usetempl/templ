// OpenNext builds this module before Wrangler bundles the deployment entry.
import worker from "../.open-next/worker.js";
import { fetchWithLlmsDiscovery } from "./lib/llms-discovery";
import { supportFrameResponse } from "./lib/support-widget-frame-page";

// Keep OpenNext's own Durable Object exports available.
export * from "../.open-next/worker.js";
export { RpcProviderBudget } from "./lib/server/rpc-provider-budget";

const templWorker = {
  ...worker,
  async fetch(
    request: Request,
    env: Parameters<typeof worker.fetch>[1],
    ctx: Parameters<typeof worker.fetch>[2],
  ) {
    // The widget's frame document never reaches the app (frame mode).
    const frame = supportFrameResponse(request);
    if (frame) return frame;
    return fetchWithLlmsDiscovery(request, (upstreamRequest) =>
      worker.fetch(upstreamRequest, env, ctx),
    );
  },
};

export default templWorker;
