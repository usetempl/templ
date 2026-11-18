import { json, readJson, type Env } from "./common";
import { releaseIdentity } from "./release-identity";
import { safetyAdmin, safetyRequest, type SafetyEnv } from "./safety";

const MESSAGE = "Staging chat is paused for a reset. Try again later.";
const REPORT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function unavailable() {
  return json({ error: MESSAGE }, 503, { "Retry-After": "60" });
}

/** The existing eight bindings stay attached while staging is frozen. Their
 * scheduled alarms and direct fetches cannot mutate the old data. */
class FrozenObject {
  fetch(): Response {
    return unavailable();
  }
  alarm(): void {}
}

export { FrozenObject as AuthRecord };
export { FrozenObject as CommunityRoom };
// Cloudflare tracks this class until the reset's delete migration.
export { FrozenObject as MediaStore };
export { FrozenObject as SubscriptionList };
export { FrozenObject as FeedbackStore };
export { FrozenObject as SupportPartition };
export { FrozenObject as CostMetrics };
export { FrozenObject as MediaQuota };

/** A separate implementation of the existing SafetyStore class name exposes
 * only the report cursor scan. It never schedules an alarm or writes storage. */
export class SafetyStore {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/safety"
    )
      return unavailable();
    try {
      const body = await readJson(request, 1_000);
      if (
        body.op !== "list" ||
        Object.keys(body).some((key) => key !== "op" && key !== "cursor") ||
        (body.cursor !== null &&
          body.cursor !== undefined &&
          (typeof body.cursor !== "string" || !REPORT_ID.test(body.cursor)))
      )
        return unavailable();
      const reports = [
        ...(
          await this.state.storage.list<{
            id: string;
          }>({
            prefix: "report:",
            limit: 51,
            ...(body.cursor ? { startAfter: `report:${body.cursor}` } : {}),
          })
        ).values(),
      ];
      const protectedIndexes = {
        suspensions:
          (await this.state.storage.list({ prefix: "suspension:", limit: 1 }))
            .size > 0,
        heldMessages:
          (await this.state.storage.list({ prefix: "held-message:", limit: 1 }))
            .size > 0,
        heldFileChannels:
          (
            await this.state.storage.list({
              prefix: "held-file-channel:",
              limit: 1,
            })
          ).size > 0,
      };
      return json({
        reports: reports.slice(0, 50),
        nextCursor: reports.length > 50 ? reports[49].id : null,
        protectedIndexes,
      });
    } catch {
      return unavailable();
    }
  }

  alarm(): void {}
}

function responseHeaders(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, nosnippet, noimageindex");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set("Vary", "Origin");
  if (response.status === 503 && !headers.has("Retry-After"))
    headers.set("Retry-After", "60");
  if (request.headers.get("Origin") === "https://templ.vip") {
    headers.set("Access-Control-Allow-Origin", "https://templ.vip");
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** This entry point is staging-only. No auth, chat, media or support route is
 * reachable while the old storage is being inventoried. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const configured =
      url.origin === "https://community.templ.vip" &&
      env.APP_ORIGIN === "https://templ.vip" &&
      (env as Env & { STAGING_RESET_FREEZE?: string }).STAGING_RESET_FREEZE ===
        "true";
    let response = unavailable();
    if (configured && request.method === "GET" && url.pathname === "/release")
      response = releaseIdentity(env);
    else if (
      configured &&
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
            (typeof body.cursor === "string" && REPORT_ID.test(body.cursor)))
        ) {
          const result = await safetyRequest(env as SafetyEnv, body);
          if (result.status === 200) response = result;
        }
      } catch {
        // The freeze response does not reveal token or storage state.
      }
    }
    return responseHeaders(response, request);
  },
};
