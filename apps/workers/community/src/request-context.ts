/** Request-local timing, deferred work and read prefetches. The context lives
 * on an env Symbol that only `withRequestContext` creates, so no request
 * header can create or read it. Nothing here is shared across requests. */
import type { ChatPrincipalId } from "@templ/chat/principal";

const CONTEXT = Symbol("request-context");

/** Fixed span names. Values are durations only: no ids, hashes, paths or
 * principals ever reach the Server-Timing header. */
export const SPAN_NAMES = [
  "limit",
  "config",
  "session",
  "session-new",
  "guest",
  "guest-new",
  "nonce",
  "native",
  "identity",
  "identity-login",
  "safety",
  "roles",
  "quota",
  "pace",
  "room",
  "settle",
  "move",
  "revoke",
  "subs",
] as const;
export type SpanName = (typeof SPAN_NAMES)[number];

/** Reads started before the step that needs them. A consumer uses a
 * prefetched result only when it matches the verified value exactly;
 * otherwise it reads again. Every entry is single use. The session,
 * identity and safety reads of a POST start only once its body has arrived,
 * so a sign-out or suspension that lands during the upload still applies. */
export type RequestPrefetch = {
  /** The session record read for this bearer or cookie token. */
  session?: { token: string; record: Promise<unknown> };
  /** A native room record read. */
  native?: { id: string; read: Promise<unknown> };
  /** An identity read keyed by the principal it was read for. */
  identity?: { principalId: ChatPrincipalId; read: Promise<unknown> };
  /** A raw safety status for one room key and one exact principal set. */
  safety?: {
    roomKey: string | null;
    principalId: ChatPrincipalId | null;
    principals: string[];
    status: Promise<unknown>;
  };
  /** The room key the current route checks next, so a session read can start
   * that room's safety status as soon as its principal set is known. */
  safetyTarget?: string;
  /** Principals the client says it holds: 1 to 8, first is the session
   * principal. Untrusted: it only chooses which reads start early. */
  hint?: ChatPrincipalId[];
};

type RequestContext = {
  spans: Map<SpanName, number>;
  failedHops: Set<SpanName>;
  deferred: (Promise<unknown> | (() => Promise<unknown>))[];
  prefetch: RequestPrefetch;
};
type ContextEnv = { [CONTEXT]?: RequestContext };

export function withRequestContext<T extends object>(env: T): T {
  return Object.assign({}, env, {
    [CONTEXT]: {
      spans: new Map(),
      failedHops: new Set(),
      deferred: [],
      prefetch: {},
    } satisfies RequestContext,
  });
}
function context(env: object) {
  return (env as ContextEnv)[CONTEXT];
}
/** The request's prefetch slots, or a detached object outside a request
 * (unit tests that call handlers directly). */
export function requestPrefetch(env: object): RequestPrefetch {
  return context(env)?.prefetch ?? {};
}
/** Marks a started read as handled so an early refusal elsewhere never
 * reports it as an unhandled rejection. Awaiting it still throws. */
export function started<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

function add(env: object, name: SpanName, ms: number) {
  const spans = context(env)?.spans;
  if (!spans || !Number.isFinite(ms) || ms < 0) return;
  spans.set(name, (spans.get(name) ?? 0) + ms);
}
function failedHop(env: object, name: SpanName) {
  if (SPAN_NAMES.includes(name)) context(env)?.failedHops.add(name);
}
/** Failed timed work observed in this request, in fixed order. A rejection
 * or a returned server error marks a hop; concurrent failures can mark more
 * than one. These labels do not establish which failure caused the response. */
export function failedRequestHops(env: object): SpanName[] {
  const failed = context(env)?.failedHops;
  return SPAN_NAMES.filter((name) => failed?.has(name));
}
/** Adds the time until `work` settles to `name`. Repeated names are summed. */
export function timed<T>(
  env: object,
  name: SpanName,
  work: Promise<T> | (() => Promise<T>),
): Promise<T> {
  const start = Date.now();
  const promise = typeof work === "function" ? work() : work;
  if (!context(env)) return promise;
  return promise
    .then(
      (value) => {
        if (value instanceof Response && value.status >= 500)
          failedHop(env, name);
        return value;
      },
      (error) => {
        failedHop(env, name);
        throw error;
      },
    )
    .finally(() => add(env, name, Date.now() - start));
}

/** Work that must not delay the response. A function starts only after the
 * response is handed back; a promise is already running and is only kept
 * alive. `createCommunityWorker().fetch` passes the queue to
 * `ctx.waitUntil`, or awaits it when there is no execution context. Outside
 * a request the work starts at once and is left to settle. */
export function defer(
  env: object,
  work: Promise<unknown> | (() => Promise<unknown>),
) {
  const queue = context(env)?.deferred;
  if (queue) {
    queue.push(work);
    return;
  }
  started(typeof work === "function" ? work() : work);
}

/** Runs the deferred queue once, after the current turn, and settles every
 * entry; one failure never stops the rest. */
export async function drainDeferred(env: object) {
  const queue = context(env)?.deferred;
  if (!queue?.length) return;
  // Start queued work on a later task, after the response has been handed
  // to the caller.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending: Promise<unknown>[] = [];
  while (queue.length) {
    const work = queue.shift()!;
    try {
      pending.push(typeof work === "function" ? work() : work);
    } catch {
      /* A synchronous throw is as final as a rejection. */
    }
  }
  await Promise.allSettled(pending);
}

/** `name;dur=<ms>, …, total;dur=<ms>` in the fixed span order. */
export function serverTiming(env: object, totalMs: number) {
  const spans = context(env)?.spans;
  const parts: string[] = [];
  for (const name of SPAN_NAMES) {
    const value = spans?.get(name);
    if (value !== undefined) parts.push(`${name};dur=${Math.round(value)}`);
  }
  parts.push(`total;dur=${Math.max(0, Math.round(totalMs))}`);
  return parts.join(", ");
}

/** The response with its Server-Timing header. A socket upgrade (101) is
 * returned untouched so it keeps its WebSocket. */
export function withServerTiming(
  env: object,
  response: Response,
  totalMs: number,
): Response {
  if (response.status === 101) return response;
  const timed = new Response(response.body, response);
  timed.headers.set("Server-Timing", serverTiming(env, totalMs));
  return timed;
}

/** The header a client names its own principals in: an untrusted choice of
 * which reads start early, never an input to a decision. */
export const PRINCIPAL_HINT_HEADER = "X-Templ-Principal-Hint";

/** A valid `X-Templ-Principal-Hint`: 1 to 8 comma-separated principals.
 * Anything else is ignored, never an error. */
export function principalHint(
  value: string | null,
  normalize: (value: unknown) => ChatPrincipalId | null,
): ChatPrincipalId[] | undefined {
  if (!value || value.length > 1024) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (!parts.length || parts.length > 8) return undefined;
  const principals: ChatPrincipalId[] = [];
  for (const part of parts) {
    const principal = normalize(part);
    if (!principal) return undefined;
    if (!principals.includes(principal)) principals.push(principal);
  }
  return principals;
}
