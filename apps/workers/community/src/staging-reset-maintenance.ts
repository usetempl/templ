import { json, type Env } from "./common";
import { releaseIdentity } from "./release-identity";

/** This file is the entire publication-A entry point. It exports no Durable
 * Object class and never reads a binding while the eight active classes are
 * being deleted. Publication B restores src/worker.ts. */
export default {
  fetch(request: Request, env: Env): Response {
    const configured =
      env.APP_ORIGIN === "https://templ.vip" &&
      (env as Env & { STAGING_RESET_MAINTENANCE?: string })
        .STAGING_RESET_MAINTENANCE === "true" &&
      new URL(request.url).hostname === "community.templ.vip";
    const response =
      configured &&
      request.method === "GET" &&
      new URL(request.url).pathname === "/release"
        ? releaseIdentity(env)
        : json({ error: "Staging chat is being reset. Try again later." }, 503);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    if (request.headers.get("Origin") === "https://templ.vip")
      response.headers.set("Access-Control-Allow-Origin", "https://templ.vip");
    response.headers.set("Vary", "Origin");
    if (response.status === 503) response.headers.set("Retry-After", "60");
    return response;
  },
};
