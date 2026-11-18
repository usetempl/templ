import { readBytes } from "./common";
import { logVersionId, type VersionEnv } from "./ops-log";
import { failedRequestHops } from "./request-context";
import {
  BUILD_OVERFLOW,
  FAILURE_OVERFLOW,
  OPS_INSTANCE,
  OPS_POLICY,
  type OpsHealthEnv,
  type SupportRouteClass,
  type SupportSurface,
} from "./ops-health";

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const WIDGET_PATH = new RegExp(`^/widget/${UUID}(/.*)?$`);
const APP_PATH = new RegExp(`^/rooms/${UUID}(/conversations(?:/.*)?)$`);
const TEAM_TOOLS = new Set([
  "settings",
  "saved-replies",
  "report",
  "preferences",
  "refusals",
  "start",
]);
const THREAD =
  /^\/conversations\/tc-[0-9a-f]{32}(?:\/([a-z]+)(\/[1-9][0-9]{0,14}\/(?:edit|delete|reactions))?)?$/;
const THREAD_ACTIONS = new Set([
  "resolve",
  "stop",
  "claim",
  "release",
  "typing",
  "export",
]);

/** Classifies a support path with fixed labels. `path` is what follows
 * `/widget/<id>` or `/rooms/<id>`. */
export function supportRouteClass(
  method: string,
  path: string,
): SupportRouteClass {
  if (method === "OPTIONS") return "preflight";
  const auth = /^\/auth\/(policy|guest|nonce|verify|logout)$/.exec(path);
  if (auth) return `auth-${auth[1]}` as SupportRouteClass;
  if (path === "/conversations") return method === "GET" ? "list" : "other";
  const thread = THREAD.exec(path);
  if (!thread) {
    const named = /^\/conversations\/([a-z-]+)$/.exec(path)?.[1];
    if (named) {
      if (["status", "join", "ask", "pulse"].includes(named))
        return named as SupportRouteClass;
      return TEAM_TOOLS.has(named) ? "team-tools" : "other";
    }
    return "other";
  }
  const [, sub, edit] = thread;
  if (!sub) return method === "GET" ? "thread" : "other";
  if (edit) return sub === "messages" ? "message-edit" : "other";
  if (sub === "messages")
    return method === "GET" ? "messages-read" : "messages-write";
  if (sub === "workflow")
    return method === "GET" ? "workflow-read" : "workflow-write";
  return THREAD_ACTIONS.has(sub) ? (sub as SupportRouteClass) : "other";
}

/** The widget and app support surfaces; null for every other path. */
export function supportFailureRoute(
  method: string,
  pathname: string,
): { surface: SupportSurface; route: SupportRouteClass } | null {
  const widget = WIDGET_PATH.exec(pathname);
  if (widget)
    return {
      surface: "widget",
      route: supportRouteClass(method, widget[1] ?? ""),
    };
  const app = APP_PATH.exec(pathname);
  if (app) return { surface: "app", route: supportRouteClass(method, app[1]) };
  return null;
}

/** Published widget builds send the first 16 hex characters of their source hash
 * in `X-Templ-Widget`. Keep this reviewed list equal to entries with `publishedAt`
 * in apps/web/src/lib/support-widget-versions.json, including superseded builds.
 * Add the matching source hash prefix when recording a publication.
 * Unknown ids share `other`, so callers cannot fill the daily build slots.
 * REVOKED_WIDGET_BUILDS separately controls access. */
export const PUBLISHED_WIDGET_BUILDS: readonly string[] = [
  "0ac28073639b4ce8",
  "4a8ce504b4bc440a",
  "69515fc68e01c1d7",
  "940f5dd77f590908",
  "9de667667affb7b4",
  "a28801129d0c9d5c",
  "b6fa50a60a72c25b",
  "c40fc98cb2669d8c",
  "d28ed2865ebb6166",
  "d9ae3ae08eff8374",
  "de850d85f5ee8bd5",
  "ea9547b45f5730d4",
  "fd411dff564c501a",
  "fe12fcde9d0c0127",
];

/** The widget build a guest or wallet sign-in came from. A header that is
 * absent is a build older than the header; `dev` is the in-page demo; any
 * other value, including an id Templ did not publish, is "other". */
export function widgetBuild(
  request: Request,
  published: readonly string[] = PUBLISHED_WIDGET_BUILDS,
) {
  const header = request.headers.get("X-Templ-Widget");
  if (header === null) return "legacy";
  if (header === "dev") return "dev";
  return /^[0-9a-f]{16}$/.test(header) && published.includes(header)
    ? header
    : "other";
}

async function failureReason(response: Response) {
  try {
    const bytes = await readBytes(response, 16_384);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const reason =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { reason?: unknown }).reason
        : undefined;
    return typeof reason === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(reason)
      ? reason
      : "none";
  } catch {
    return "none";
  }
}

async function sendCounts(
  env: Pick<OpsHealthEnv, "COST_METRICS">,
  path: "/ops/failures" | "/ops/builds",
  counts: Record<string, number>,
) {
  if (!env.COST_METRICS) return;
  try {
    const response = await env.COST_METRICS.get(
      env.COST_METRICS.idFromName(OPS_INSTANCE),
    ).fetch(
      new Request(`https://internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counts }),
        signal: AbortSignal.timeout(2000),
      }),
    );
    await response.body?.cancel();
  } catch {
    /* A lost count never changes a response. */
  }
}

export const SUPPORT_FAILURE_POLICY = { sendGapMs: 10_000 } as const;
/** Failure and widget-build counts added up in one worker instance. The
 * first batch goes out at once; later ones wait until ten seconds after the
 * previous send. Counts held when an instance is evicted are lost; they are a
 * measure, not a ledger. */
export class SupportFailureTally {
  private failures = new Map<string, number>();
  private builds = new Map<string, number>();
  private sending: Promise<void> | null = null;
  private lastSentAt = -Infinity;
  addFailure(env: Pick<OpsHealthEnv, "COST_METRICS">, key: string) {
    return this.add(
      env,
      this.failures,
      key,
      OPS_POLICY.failureKeys,
      FAILURE_OVERFLOW,
    );
  }
  addBuild(env: Pick<OpsHealthEnv, "COST_METRICS">, build: string) {
    return this.add(
      env,
      this.builds,
      build,
      OPS_POLICY.buildKeys,
      BUILD_OVERFLOW,
    );
  }
  /** Holds at most `maxKeys` keys, like the ops buckets: a new key that does
   * not fit is added to the overflow key. */
  private add(
    env: Pick<OpsHealthEnv, "COST_METRICS">,
    target: Map<string, number>,
    raw: string,
    maxKeys: number,
    overflow: string,
  ): Promise<void> {
    const regular = target.size - (target.has(overflow) ? 1 : 0);
    const key =
      target.has(raw) || raw === overflow || regular < maxKeys - 1
        ? raw
        : overflow;
    target.set(key, Math.min((target.get(key) ?? 0) + 1, OPS_POLICY.maxCount));
    this.sending ??= this.drain(env);
    return this.sending;
  }
  private async drain(env: Pick<OpsHealthEnv, "COST_METRICS">) {
    try {
      while (this.failures.size || this.builds.size) {
        const wait =
          this.lastSentAt + SUPPORT_FAILURE_POLICY.sendGapMs - Date.now();
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
        const failures = take(this.failures, OPS_POLICY.failureKeys);
        const builds = take(this.builds, OPS_POLICY.buildKeys);
        this.lastSentAt = Date.now();
        await Promise.all([
          Object.keys(failures).length
            ? sendCounts(env, "/ops/failures", failures)
            : undefined,
          Object.keys(builds).length
            ? sendCounts(env, "/ops/builds", builds)
            : undefined,
        ]);
      }
    } finally {
      this.sending = null;
    }
  }
}
function take(source: Map<string, number>, limit: number) {
  const batch: Record<string, number> = {};
  for (const [key, count] of [...source].slice(0, limit)) {
    batch[key] = count;
    source.delete(key);
  }
  return batch;
}
const instanceTally = new SupportFailureTally();

/** After a request: a support response of 500 or more writes one
 * `TEMPL_SUPPORT_FAILURE` line with fixed labels and the deployed version id,
 * and adds to the hourly counts; a widget guest or wallet sign-in that succeeded adds its widget
 * build to the daily counts. No path, query, workspace, principal, IP,
 * message text or error text is logged. Call it before the response body is
 * read: a failure is cloned for its reason code. */
export function finishSupportFailureObservation(
  env: Pick<OpsHealthEnv, "COST_METRICS"> & VersionEnv,
  request: Request,
  response: Response | undefined,
  context: Pick<ExecutionContext, "waitUntil">,
  tally: SupportFailureTally = instanceTally,
) {
  const matched = supportFailureRoute(
    request.method,
    new URL(request.url).pathname,
  );
  if (!matched) return;
  const { surface, route } = matched;
  const status = response?.status ?? 500;
  if (status >= 500) {
    const copy = response?.clone();
    // Snapshot before deferred cleanup settles. Only server-local timed
    // work can supply these fixed labels; request headers cannot set them.
    const failedHops = status === 503 ? failedRequestHops(env) : undefined;
    context.waitUntil(
      (copy ? failureReason(copy) : Promise.resolve("none")).then((reason) => {
        console.error(
          "TEMPL_SUPPORT_FAILURE",
          JSON.stringify({
            schemaVersion: 1,
            versionId: logVersionId(env),
            surface,
            route,
            status,
            reason,
            ...(failedHops === undefined ? {} : { failedHops }),
          }),
        );
        return tally.addFailure(env, `${surface}|${route}|${status}`);
      }),
    );
    return;
  }
  if (
    surface === "widget" &&
    (route === "auth-guest" || route === "auth-verify") &&
    status >= 200 &&
    status < 300
  )
    context.waitUntil(tally.addBuild(env, widgetBuild(request)));
}
