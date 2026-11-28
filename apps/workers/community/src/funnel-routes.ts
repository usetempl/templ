import {
  FUNNEL_POLICY,
  SITE_FUNNEL_PATHS,
  funnelCause,
  funnelDayOf,
  funnelReport,
  type FunnelDay,
  type FunnelEvent,
  type FunnelSignInMethod,
  type FunnelStep,
} from "@templ/chat/funnel";
import { HttpError, json } from "./common";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  FUNNEL_INSTANCE,
  sendFunnelEvents,
  type FunnelEnv,
} from "./funnel-metrics";
import { sessionPrincipals, type ServiceSession } from "./service-principals";

const DAY = 86_400_000;

/** Requests whose outcome is a funnel step. Sign-ins and prompt copies
 * (`counted`) count when they succeed and when they are refused. Workspace
 * steps count their success inside the workspace (once, see
 * `markWorkspaceStep`); here only refusals count. A member request counts
 * its refusals on the app and the widget route. */
type FunnelRoute = {
  method: "GET" | "POST";
  path: RegExp;
  step: FunnelStep;
  signIn?: FunnelSignInMethod;
  counted?: true;
};
const FUNNEL_ROUTES: readonly FunnelRoute[] = [
  {
    method: "POST",
    path: /^\/connect\/start$/,
    step: "connect_started",
    counted: true,
  },
  {
    method: "GET",
    path: /^\/connect\/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
    step: "connect_opened",
    counted: true,
  },
  {
    method: "POST",
    path: /^\/connect\/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\/approve$/,
    step: "connect_approved",
    counted: true,
  },
  {
    method: "POST",
    path: /^\/connect\/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\/deny$/,
    step: "connect_denied",
    counted: true,
  },
  ...Object.entries(SITE_FUNNEL_PATHS).map(([step, path]) => ({
    method: "POST" as const,
    path: new RegExp(`^${path}$`),
    step: step as keyof typeof SITE_FUNNEL_PATHS,
    counted: true as const,
  })),
  {
    method: "POST",
    path: /^\/widget\/[^/]+\/conversations\/tc-[0-9a-f]{32}\/guest-email$/,
    step: "guest_email_changed",
    counted: true,
  },
  {
    method: "POST",
    path: /^\/alerts\/guest\/confirm$/,
    step: "guest_email_confirmed",
    counted: true,
  },
  {
    method: "POST",
    path: /^\/widget\/[^/]+\/auth\/guest-link$/,
    step: "guest_link_resumed",
    counted: true,
  },
  {
    method: "POST",
    path: /^\/auth\/verify$/,
    step: "signed_in",
    signIn: "wallet",
  },
  {
    method: "POST",
    path: /^\/auth\/solana\/verify$/,
    step: "signed_in",
    signIn: "solana",
  },
  {
    method: "POST",
    path: /^\/auth\/bitcoin\/verify$/,
    step: "signed_in",
    signIn: "bitcoin",
  },
  {
    method: "POST",
    path: /^\/auth\/email\/login\/verify$/,
    step: "signed_in",
    signIn: "email",
  },
  { method: "POST", path: /^\/rooms$/, step: "workspace_created" },
  {
    method: "POST",
    path: /^\/rooms\/[^/]+\/widget$/,
    step: "widget_site_approved",
  },
  {
    method: "POST",
    path: /^\/(?:rooms|widget)\/[^/]+\/conversations\/ask$/,
    step: "first_request",
  },
  {
    method: "POST",
    path: /^\/rooms\/[^/]+\/product\/(?:crypto\/prepare|card\/setup)$/,
    step: "checkout_started",
  },
  {
    method: "POST",
    path: /^\/rooms\/[^/]+\/product\/crypto\/receipt$/,
    step: "payment_credited",
  },
];

const OBSERVATION = Symbol("funnel-observation");
type Observation = { admitted: boolean };
type ObservedEnv = { [OBSERVATION]?: Observation };
/** Request-local, like the cost observation: no request header can create
 * or admit it. */
export function withFunnelObservation<T extends object>(env: T): T {
  return Object.assign({}, env, {
    [OBSERVATION]: { admitted: false } satisfies Observation,
  });
}
/** The request passed its origin check and its rate limiter. Only such a
 * request counts, so a refused origin or a limiter 429 never reaches the
 * counts. */
export function admitFunnelRequest(env: object) {
  const observation = (env as ObservedEnv)[OBSERVATION];
  if (observation) observation.admitted = true;
}

/** Sign-ins and refusals added up in one worker instance. The first one
 * goes out at once; the rest wait until `FUNNEL_POLICY.sendGapMs` after the
 * previous send and go out together as counts, so request volume never
 * becomes one metrics write per request. Counts held when an instance is
 * evicted are lost; the counts are a measure, not a ledger. */
export class FunnelTally {
  private pending = new Map<string, FunnelEvent & { count: number }>();
  private sending: Promise<void> | null = null;
  private lastSentAt = -Infinity;
  /** Resolves once the event has been sent, or given up on. */
  add(env: FunnelEnv, event: FunnelEvent): Promise<void> {
    const key = tallyKey(event);
    const entry = this.pending.get(key);
    if (entry) entry.count = Math.min(entry.count + 1, FUNNEL_POLICY.maxCount);
    else this.pending.set(key, { ...event, count: 1 });
    this.sending ??= this.drain(env);
    return this.sending;
  }
  private async drain(env: FunnelEnv) {
    try {
      while (this.pending.size) {
        const wait = this.lastSentAt + FUNNEL_POLICY.sendGapMs - Date.now();
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
        const batch = [...this.pending.values()].slice(
          0,
          FUNNEL_POLICY.maxBatch,
        );
        for (const event of batch) this.pending.delete(tallyKey(event));
        this.lastSentAt = Date.now();
        // A failed send drops these counts rather than retrying for ever.
        await sendFunnelEvents(env, batch);
      }
    } finally {
      this.sending = null;
    }
  }
}
const tallyKey = (event: FunnelEvent) =>
  [event.step, event.outcome, event.cause ?? "", event.method ?? ""].join("|");
const instanceTally = new FunnelTally();

async function refusalReason(response: Response) {
  try {
    const body = await response.json<{ reason?: unknown }>();
    return body?.reason;
  } catch {
    return undefined;
  }
}

/** Counts the outcome of a finished request that `admitFunnelRequest`
 * admitted, after the response is sent. Call it before the response body is
 * read: a refusal is cloned for its reason code. */
export function finishFunnelObservation(
  env: FunnelEnv & OperatorAdminEnv,
  request: Request,
  response: Response | undefined,
  context: Pick<ExecutionContext, "waitUntil">,
  tally: FunnelTally = instanceTally,
) {
  if (!response || !(env as ObservedEnv)[OBSERVATION]?.admitted) return;
  const path = new URL(request.url).pathname;
  const route = FUNNEL_ROUTES.find(
    (candidate) =>
      candidate.method === request.method && candidate.path.test(path),
  );
  if (!route) return;
  const method = route.signIn ? { method: route.signIn } : {};
  if (response.status >= 400) {
    const copy = response.clone();
    context.waitUntil(
      refusalReason(copy).then((reason) => {
        if (reason === "product-payment-confirming") return;
        return tally.add(env, {
          step: route.step,
          outcome: "failed",
          cause: funnelCause(response.status, reason),
          ...method,
        });
      }),
    );
    return;
  }
  if ((route.signIn || route.counted) && response.ok)
    context.waitUntil(
      tally.add(env, { step: route.step, outcome: "done", ...method }),
    );
}

/** Site actions count after the origin check and rate limiter. Requests
 * carry only a fixed path, without visitor details or credentials. */
export async function siteFunnelRoute(request: Request): Promise<Response | null> {
  if (
    !(Object.values(SITE_FUNNEL_PATHS) as string[]).includes(
      new URL(request.url).pathname,
    )
  )
    return null;
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const length = request.headers.get("Content-Length");
  if (
    (length !== null && length !== "0") ||
    request.headers.has("Content-Type")
  )
    throw new HttpError(400, "This count takes no body.");
  if (request.body) {
    const reader = request.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    if (!first.done) throw new HttpError(400, "This count takes no body.");
  }
  return new Response(null, { status: 204 });
}

/** `GET /operator/funnel?days=7|30|90`: the counts for Templ operators. */
export async function operatorFunnelRoute<S extends ServiceSession>(
  request: Request,
  env: OperatorAdminEnv & FunnelEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/operator/funnel") return null;
  const session = await auth.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(403, "This page is for Templ operators.");
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  const days = Number(url.searchParams.get("days") ?? "30");
  if (!(FUNNEL_POLICY.windows as readonly number[]).includes(days))
    throw new HttpError(400, "Choose 7, 30 or 90 days.");
  const now = Date.now();
  const from = funnelDayOf(now - (days - 1) * DAY),
    to = funnelDayOf(now);
  let stored: FunnelDay[] = [];
  let available = false;
  if (env.COST_METRICS)
    try {
      const response = await env.COST_METRICS.get(
        env.COST_METRICS.idFromName(FUNNEL_INSTANCE),
      ).fetch(
        new Request(`https://internal/funnel/snapshot?from=${from}&to=${to}`, {
          signal: AbortSignal.timeout(2000),
        }),
      );
      if (response.ok) {
        stored = (await response.json<{ days: FunnelDay[] }>()).days;
        available = true;
      }
    } catch {
      /* The report says the counts are unavailable. */
    }
  return json(funnelReport({ from, to, available, days: stored }));
}
