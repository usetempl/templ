import type { WorkspaceFlagEnv } from "./workspace-flags";
import { isAddress, zeroAddress, type Address } from "viem";
import { DEFAULT_CHAT_AUTH_CHAIN_ID } from "@templ/chat/chains";
import { timed, type SpanName } from "./request-context";

export interface Env extends WorkspaceFlagEnv {
  SUPPORT_PREVIEW_ANSWER_REPORTS_ENABLED?: string;
  NATIVE_TELEGRAM_BRIDGE_ENABLED?: string;
  NATIVE_TELEGRAM_BRIDGE?: import("@templ/chat/support-telegram").NativeTelegramBridge;
  AI?: Ai;
  MANAGED_AGENT_GATEWAY_ID?: string;
  SUPPORT_PRIORITY_CAPTURE_ENABLED?: string;
  SUPPORT_PRIORITY_CAPTURE_SCOPES?: string;
  RELEASE_IDENTITY?: string;
  /** Exact reviewed source/version seal for the fixed noncash monthly trial. Absent denies it. */
  STANDARD_MONTHLY_TRIAL_AUTHORIZATION?: string;
  RELEASE_ACTIVATION_ENABLED?: string;
  /** Dedicated CI release-activation HMAC key; never an account credential. */
  RELEASE_ACTIVATION_KEY?: string;
  CF_VERSION_METADATA?: { id: string; timestamp?: string; tag?: string };
  APP_ORIGIN: string;
  /** Public canonical principals who approve signed order forms. */
  FOUNDER_PRINCIPALS?: string;
  /** Public canonical principals for Templ people invited by workspace managers. */
  TEMPL_STAFF_PRINCIPALS?: string;
  /** The workspace that accepts Templ's own support and lead requests. */
  TEMPL_SUPPORT_WORKSPACE?: string;
  /** Public verification pin for the isolated, separately qualified Own
   * support endpoint. This can never configure a customer's key authority. */
  OWN_SUPPORT_ENCRYPTION_ROOT?: string;
  ROBINHOOD_AUTH_RPC_URL?: string;
  ROBINHOOD_CONFIRMATION_RPC_URL?: string;
  ROOM_SUBSCRIPTIONS?: DurableObjectNamespace;
  /** Member-to-team conversation creation and writes. */
  CONVERSATIONS_ENABLED?: string;
  /** Paid staff claims; ordinary support does not depend on this flag. */
  SUPPORT_WORKFLOW_ENABLED?: string;
  SUPPORT_NOTIFICATIONS_ENABLED?: string;
  /** Passwordless account sign-in stays off until its hosted access proof passes. */
  EMAIL_SIGN_IN_ENABLED?: string;
  BITCOIN_ACCOUNT_SIGN_IN_ENABLED?: string;
  SUPPORT_HOSTED_PAGE_ENABLED?: string;
  /** "Check my install": its routes and preview cases answer only when "true". */
  SUPPORT_INSTALL_CHECK_ENABLED?: string;
  /** Stable public Demo ID and namespace for disposable install fixtures. */
  EXAMPLE_VAULT_WORKSPACE?: string;
  SUPPORT_DOMAIN_VERIFY_ENABLED?: string;
  /** Optional verified-source lookups for the read-only decoder on chains
   * Sourcify does not cover. A Worker secret. */
  ETHERSCAN_API_KEY?: string;
  FEEDBACK_STORE?: DurableObjectNamespace;
  AUTH_RECORDS: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
  PRODUCT_PAYMENT_LEDGER?: DurableObjectNamespace;
  PRODUCT_PAYMENT_SCANNERS?: DurableObjectNamespace;
  /** Private history partitions; only the room object uses this binding. */
  SUPPORT_PARTITIONS?: DurableObjectNamespace;
  /** New group-history rollover stays off until its hosted storage trial passes. */
  GROUP_HISTORY_ARCHIVE_ENABLED?: string;
  /** The Cloudflare Workers storage tier. Missing or unknown means Free. */
  DO_STORAGE_PLAN?: string;
  /** Owner-scoped image bytes. Only referenced objects are public. The Worker
   * has no credential fallback: reads and writes fail closed until bound. */
  MEDIA_BUCKET?: R2Bucket;
  /** Reviewed shard count. Runtime media writes fail closed on any mismatch. */
  MEDIA_BUDGET_SHARDS?: string;
  /** 64 lowercase hex characters; a Worker secret, stable across releases.
   * It keys the one-way hash of a client address that caps guest requests
   * and anonymous sockets. Rotating it resets those counts once. */
  CLIENT_DIGEST_KEY?: string;
  /** 32-byte hex HMAC key for public-media budget placement and scoped group-file IDs.
   * Keep it stable while media is retained; rotation needs a separate data plan. */
  MEDIA_SHARD_KEY?: string;
  /** Short-window image upload admission counters; never stores image bytes. */
  MEDIA_QUOTAS: DurableObjectNamespace;
  AUTH_RATE_LIMITER: RateLimit;
  CONNECT_POLL_RATE_LIMITER: RateLimit;
  CHAT_READ_RATE_LIMITER: RateLimit;
  CHAT_RATE_LIMITER: RateLimit;
  MEDIA_RATE_LIMITER: RateLimit;
}
/** Part of Durable Object names (subscriptions, the RPC budget, the ABI
 * catalog). Frozen: changing it orphans stored state. It has nothing to do
 * with sign-in. */
export const STORAGE_SCOPE_CHAIN_ID = 4663;
/** /health proves that both providers of this chain agree: the app's own
 * sign-in network. */
export const HEALTH_CHAIN_ID = DEFAULT_CHAT_AUTH_CHAIN_ID;
/** ERC-1271 sign-in stays on the chain where contract-wallet principals were
 * proven. */
export { SMART_WALLET_AUTH_CHAIN_ID } from "@templ/chat/chains";
export const NONCE_TTL = 5 * 60_000;
/** An unused guest wallet proof can be attached to its first case for thirty minutes. */
export const WALLET_SHARE_RECEIPT_TTL = 30 * 60_000;
export const SESSION_TTL = 30 * 24 * 60 * 60_000;
export const SESSION_RENEW_AFTER = 24 * 60 * 60_000;
export const SESSION_COOKIE = "__Host-templ_session";
export const NONCE_COOKIE = "__Host-templ_nonce";
export const APP_ORIGINS = [
  "https://templ.vip",
  "https://usetempl.com",
] as const;
export type AppOrigin = (typeof APP_ORIGINS)[number];
export class HttpError extends Error {
  /** A stable machine-readable reason a client may branch on (for example
   * "unavailable-period", "history-capacity", "stopped"); never a secret. */
  public reason?: string;
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
    reason?: string,
  ) {
    super(message);
    if (reason) this.reason = reason;
  }
}
/** The JSON body every HttpError becomes: the message plus its reason when set. */
export function errorBody(error: unknown, fallback: string) {
  if (error instanceof HttpError)
    return error.reason
      ? {
          error: error.message,
          reason: error.reason,
          ...(["unsafe-ask", "secret-refused"].includes(error.reason)
            ? { code: error.reason }
            : {}),
        }
      : { error: error.message };
  return { error: fallback };
}
export function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  const response = new Response(JSON.stringify(value), { status, headers });
  response.headers.set("Content-Type", "application/json; charset=utf-8");
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
/** Selects the app and community hosts as one environment. A Worker with a
 * typo, path or unrecognised host fails closed instead of mixing staging and
 * production cookies, links or public media. */
type SiteOrigins = Readonly<{
  origin: URL;
  appOrigin: AppOrigin;
  communityOrigin: string;
}>;
/** Parsed once per isolate for each allowed value; the answer depends only on
 * `APP_ORIGIN`. Callers read these values and never change them. */
const sites = new Map<AppOrigin, SiteOrigins>();
export function siteOrigins(env: Pick<Env, "APP_ORIGIN">): SiteOrigins {
  if (!(APP_ORIGINS as readonly string[]).includes(env.APP_ORIGIN))
    throw new HttpError(503, "Community is not configured.");
  const appOrigin = env.APP_ORIGIN as AppOrigin;
  let site = sites.get(appOrigin);
  if (!site) {
    const origin = new URL(appOrigin);
    site = Object.freeze({
      origin,
      appOrigin,
      communityOrigin: `https://community.${origin.hostname}`,
    });
    sites.set(appOrigin, site);
  }
  return site;
}
export function config(env: Env) {
  const { origin } = siteOrigins(env);
  return {
    namespace: origin.hostname,
    origin,
  };
}
export function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value) || value === zeroAddress)
    throw new HttpError(400, "Invalid wallet.");
  return value.toLowerCase() as Address;
}
const CURRENT_ROOM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Canonical identifier for current native communities. Contract-address
 * rooms were never released and are not accepted by current routes. */
export function roomKey(value: unknown): `room:${string}` {
  if (
    typeof value !== "string" ||
    !value.startsWith("room:") ||
    !CURRENT_ROOM_ID.test(value.slice(5).toLowerCase())
  )
    throw new HttpError(400, "Invalid community room.");
  return `room:${value.slice(5).toLowerCase()}`;
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export function readCookie(request: Request, name: string) {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}
/** "remember" holds remembered widget sign-in families (widget-remember.ts). */
export type AuthRecordKind = "nonce" | "session" | "guest" | "remember";
/** The internal header that names one hashed record inside a shard. Only the
 * worker sets it; Durable Objects are not publicly addressable. */
export const AUTH_RECORD_HEADER = "X-Auth-Record";
export async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
function recordSpan(kind: AuthRecordKind, path: string): SpanName {
  if (kind === "nonce") return "nonce";
  if (path === "/revoke") return "revoke";
  if (kind === "guest") return path === "/create" ? "guest-new" : "guest";
  return path === "/create" ? "session-new" : "session";
}
/** One hashed challenge, session or guest record. The call shape is a stub's
 * `fetch`; the record lives under its hash in one of its kind's 16
 * long-lived shard objects, chosen by the hash's first hex digit, so a new
 * token never pays for a new object. */
export async function record(
  env: Env,
  kind: AuthRecordKind,
  token: string,
): Promise<{ fetch(request: Request): Promise<Response> }> {
  return recordByHash(env, kind, await sha256Hex(token));
}
/** The same record named by its hash, for a record whose token the caller
 * never holds (a guest's widget sessions, ended when the guest moves). */
export function recordByHash(
  env: Env,
  kind: AuthRecordKind,
  hash: string,
): { fetch(request: Request): Promise<Response> } {
  const cfg = config(env);
  const shard = env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${cfg.namespace}:auth-shard:v1:${kind}:${hash[0]}`,
    ),
  );
  return {
    fetch(request: Request) {
      const headers = new Headers(request.headers);
      headers.set(AUTH_RECORD_HEADER, hash);
      return timed(
        env,
        recordSpan(kind, new URL(request.url).pathname),
        shard.fetch(new Request(request, { headers })),
      );
    },
  };
}
/** A per-token object that holds one record. Read only to carry a guest
 * credential into its shard. */
export async function legacyRecord(
  env: Env,
  kind: AuthRecordKind,
  token: string,
) {
  const cfg = config(env);
  const stub = env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${cfg.namespace}:${kind}:${await sha256Hex(token)}`,
    ),
  );
  return {
    fetch: (request: Request) =>
      timed(env, kind === "guest" ? "guest" : "session", stub.fetch(request)),
  };
}
/** Bound streamed bytes, including requests without Content-Length. */
export async function readJson(
  request: Request,
  maxBytes = 12_288,
  /** A larger bounded parser may retain a smaller limit for ordinary bodies. */
  valueLimit?: (body: Record<string, unknown>) => number,
): Promise<Record<string, unknown>> {
  if (
    !(request.headers.get("Content-Type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Use application/json.");
  const bytes = await readBytes(request, maxBytes);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
  if (valueLimit && bytes.byteLength > valueLimit(body))
    throw new HttpError(413, "Request is too large.");
  return body;
}

export async function readBytes(request: Request | Response, maxBytes: number) {
  if (Number(request.headers.get("Content-Length")) > maxBytes)
    throw new HttpError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A request body is required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
