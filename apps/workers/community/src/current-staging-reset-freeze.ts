import { json, readJson, type Env } from "./common";
import { safetyAdmin, safetyRequest, type SafetyEnv } from "./safety";
export { SafetyStore } from "./staging-reset-freeze";

const MESSAGE = "Staging is paused for a reset. Try again later.";
const unavailable = () => json({ error: MESSAGE }, 503);

class FrozenObject {
  fetch(): Response {
    return unavailable();
  }
  alarm(): void {}
}

export { FrozenObject as AuthRecord };
export { FrozenObject as CommunityRoom };
export { FrozenObject as SubscriptionList };
export { FrozenObject as FeedbackStore };
export { FrozenObject as SupportPartition };
export { FrozenObject as CostMetrics };
export { FrozenObject as MediaQuota };
export { FrozenObject as SupportKnowledge };
export { FrozenObject as ProductPaymentLedger };
export { FrozenObject as ProductPaymentScanner };
export { FrozenObject as RpcProviderBudget };

type FreezeEnv = Env & {
  RESET_SOURCE_COMMIT?: string;
  RESET_SERVICE?: string;
};

export default {
  async fetch(request: Request, env: FreezeEnv): Promise<Response> {
    const url = new URL(request.url);
    const service = env.RESET_SERVICE;
    const configured =
      env.APP_ORIGIN === "https://templ.vip" &&
      ((service === "community" &&
        url.origin === "https://community.templ.vip") ||
        (service === "web" && url.origin === "https://templ.vip")) &&
      /^[0-9a-f]{40}$/.test(env.RESET_SOURCE_COMMIT ?? "");
    let response = unavailable();
    if (configured && request.method === "GET" && url.pathname === "/release") {
      response = json({
        environment: "staging",
        mode: "full-reset-freeze",
        service,
        sourceCommit: env.RESET_SOURCE_COMMIT,
        versionId: env.CF_VERSION_METADATA?.id,
      });
    } else if (
      configured &&
      service === "community" &&
      request.method === "POST" &&
      url.pathname === "/safety/admin" &&
      request.headers.get("Origin") === "https://templ.vip"
    ) {
      try {
        await safetyAdmin(request, env as SafetyEnv);
        const body = await readJson(request, 1_000);
        if (
          body.op === "list" &&
          Object.keys(body).every((key) => key === "op" || key === "cursor") &&
          (body.cursor == null ||
            (typeof body.cursor === "string" &&
              /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
                body.cursor,
              )))
        )
          response = await safetyRequest(env as SafetyEnv, body);
      } catch {
        response = unavailable();
      }
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Vary", "Origin");
    if (request.headers.get("Origin") === "https://templ.vip")
      headers.set("Access-Control-Allow-Origin", "https://templ.vip");
    if (response.status === 503) headers.set("Retry-After", "60");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
