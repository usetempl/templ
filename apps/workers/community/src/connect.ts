import {
  HttpError,
  json,
  randomToken,
  readJson,
  sha256Hex,
  siteOrigins,
  type Env,
} from "./common";
import { nativeName, nativeRoomId } from "./native-rooms";
import { principal } from "./principal";
import { widgetOrigins } from "./support-widget";

export const CONNECT_TTL = 15 * 60_000;
export const CONNECT_POLL_INTERVAL = 5;
const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECORD_PREFIX = "connect-record:";
const POLL_PREFIX = "connect-poll:";
const EXPIRY_PREFIX = "connect-expiry:";
const MARKER = "connect-store-v1";
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "setAlarm" | "getAlarm"
>;
export type ConnectRequest = {
  code: string;
  appName?: string;
  origins: string[];
  pollHash: string;
  expiresAt: number;
  status: "pending" | "confirming" | "approved" | "denied";
  principalId?: string;
  sessionHash?: string;
  workspaceId?: string;
  nextPollAt: number;
  interval: number;
};
export function connectCode(value: unknown): string {
  if (typeof value !== "string" || !CODE.test(value))
    throw new HttpError(400, "Use the code from your install link.");
  return value;
}
export function connectUrl(env: Pick<Env, "APP_ORIGIN">, code: string) {
  return `${siteOrigins(env).appOrigin}/connect/${connectCode(code)}`;
}
export function connectInput(body: Record<string, unknown>) {
  const origins = widgetOrigins(body.origins);
  if (!origins.length) throw new HttpError(400, "Add your app's HTTPS origin.");
  if (Object.keys(body).some((key) => !["origins", "appName"].includes(key)))
    throw new HttpError(400, "Send only the app name and origins.");
  return {
    origins,
    ...(body.appName === undefined
      ? {}
      : { appName: nativeName(body.appName) }),
  };
}
export function requireConnectEnabled(env: Env) {
  if (env.SUPPORT_CONNECT_ENABLED !== "true")
    throw new HttpError(404, "App connection is not available.");
}
export type ConnectLimitDecision = {
  key: string;
  success: boolean;
  at: number;
};
async function connectBucket(
  limiter: RateLimit | undefined,
  key: string,
  observe?: (decision: ConnectLimitDecision) => void,
) {
  const success = !!limiter && (await limiter.limit({ key })).success;
  observe?.({ key, success, at: Date.now() });
  if (!success)
    throw new HttpError(
      429,
      "Too many connection requests. Try again later.",
      60,
    );
}
function connectIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
export async function connectLimit(
  request: Request,
  env: Env,
  action: string,
  observe?: (decision: ConnectLimitDecision) => void,
) {
  requireConnectEnabled(env);
  await connectBucket(
    env.AUTH_RATE_LIMITER,
    `connect:${action}:ip:${connectIp(request)}`,
    observe,
  );
  await connectBucket(
    env.AUTH_RATE_LIMITER,
    `connect:${action}:global`,
    observe,
  );
}
export async function connectRequest(env: Env, body: Record<string, unknown>) {
  const response = await env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${siteOrigins(env).origin.hostname}:connect:v1`,
    ),
  ).fetch(
    new Request("https://internal/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    const result = await response.json<{ error?: string }>();
    throw new HttpError(
      response.status,
      result.error ?? "App connection failed. Start again.",
      response.status === 429
        ? Number(response.headers.get("Retry-After")) || 5
        : undefined,
    );
  }
  return response.json<
    Omit<ConnectRequest, "status"> & {
      status: ConnectRequest["status"] | "expired";
    }
  >();
}
export async function startConnect(body: Record<string, unknown>, env: Env) {
  const input = connectInput(body);
  const pollToken = randomToken();
  const pollHash = await sha256Hex(pollToken);
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const symbols = [...bytes].map((byte) => ALPHABET[byte & 31]).join("");
    const code = `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
    try {
      const saved = await connectRequest(env, {
        op: "create",
        ...input,
        code,
        pollHash,
      });
      return json(
        {
          code,
          connectUrl: connectUrl(env, code),
          pollToken,
          expiresAt: saved.expiresAt,
          interval: CONNECT_POLL_INTERVAL,
        },
        201,
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
  }
  throw new HttpError(503, "Could not start app connection. Try again.");
}
export async function pollConnect(
  body: Record<string, unknown>,
  env: Env,
  request: Request,
) {
  requireConnectEnabled(env);
  if (
    typeof body.pollToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.pollToken) ||
    Object.keys(body).some((key) => key !== "pollToken")
  ) {
    await connectLimit(request, env, "poll-invalid");
    throw new HttpError(400, "Use the poll token from your install tool.");
  }
  const pollHash = await sha256Hex(body.pollToken);
  // The configured auth budget bounds starts and each token's polls.
  // The registry also limits each token to one poll every 5 seconds.
  // Dedicated 7,200/minute IP and global guards bound successful polls.
  // Lookup work has its own global ceiling. Invalid tokens use the auth
  // IP/global budgets instead of the successful-poll quota.
  await connectBucket(
    env.CONNECT_POLL_RATE_LIMITER,
    `connect:poll:ip:${connectIp(request)}`,
  );
  await connectBucket(env.AUTH_RATE_LIMITER, `connect:poll:token:${pollHash}`);
  await connectBucket(
    env.CONNECT_POLL_RATE_LIMITER,
    "connect:poll:lookup:global",
  );
  const result = await connectRequest(env, {
    op: "poll",
    pollHash,
  });
  if (result.status === "expired")
    await connectLimit(request, env, "poll-invalid");
  else
    await connectBucket(env.CONNECT_POLL_RATE_LIMITER, "connect:poll:global");
  return json({
    status: result.status === "confirming" ? "pending" : result.status,
    interval: result.interval,
    ...(result.status === "approved"
      ? { workspaceId: result.workspaceId }
      : {}),
  });
}
const recordKey = (code: string) => `${RECORD_PREFIX}${code}`;
const expiryKey = (row: ConnectRequest) =>
  `${EXPIRY_PREFIX}${String(row.expiresAt).padStart(13, "0")}:${row.code}`;
function pending(row: ConnectRequest) {
  if (row.expiresAt <= Date.now())
    throw new HttpError(
      410,
      "This install link expired. Start again in your coding tool.",
    );
  if (row.status !== "pending")
    throw new HttpError(
      409,
      "This install link was already used. Start again in your coding tool.",
    );
}
function bound(row: ConnectRequest, body: Record<string, unknown>) {
  if (
    row.principalId !== principal(body.principalId) ||
    row.sessionHash !== body.sessionHash
  )
    throw new HttpError(
      403,
      "Sign in with the wallet that opened this connection.",
    );
}
export async function connectTrialSnapshot(
  storage: Pick<Storage, "get">,
  body: Record<string, unknown>,
) {
  const row = await storage.get<ConnectRequest>(
    recordKey(connectCode(body.code)),
  );
  if (!row) throw new HttpError(404, "Connection not found.");
  pending(row);
  bound(row, body);
  return { code: row.code, pollHash: row.pollHash, status: row.status };
}
/** Only the worker reaches this registry. A poll secret is hashed before any
 * Durable Object request; the registry never receives or stores it. */
export async function connectRecordRequest(
  request: Request,
  state: DurableObjectState,
) {
  if (new URL(request.url).pathname !== "/connect" || request.method !== "POST")
    return null;
  const body = await readJson(request, 4096);
  return state.storage.transaction(async (storage) => {
    if (body.op === "create") {
      const code = connectCode(body.code);
      if (
        typeof body.pollHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.pollHash)
      )
        throw new HttpError(400, "Invalid connection request.");
      if (
        (await storage.get(recordKey(code))) ||
        (await storage.get(`${POLL_PREFIX}${body.pollHash}`))
      )
        throw new HttpError(409, "Code is already used.");
      const row: ConnectRequest = {
        code,
        ...connectInput({
          origins: body.origins,
          ...(body.appName === undefined ? {} : { appName: body.appName }),
        }),
        pollHash: body.pollHash,
        expiresAt: Date.now() + CONNECT_TTL,
        status: "pending",
        nextPollAt: Date.now() + CONNECT_POLL_INTERVAL * 1000,
        interval: CONNECT_POLL_INTERVAL,
      };
      await storage.put(MARKER, true);
      await storage.put(recordKey(code), row);
      await storage.put(`${POLL_PREFIX}${row.pollHash}`, code);
      await storage.put(expiryKey(row), code);
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > row.expiresAt)
        await storage.setAlarm(row.expiresAt);
      return json(row, 201);
    }
    if (body.op === "poll") {
      const code = await storage.get<string>(`${POLL_PREFIX}${body.pollHash}`);
      const row = code
        ? await storage.get<ConnectRequest>(recordKey(code))
        : undefined;
      // Unknown and swept tokens have the same response. No request details leak.
      if (!row || row.expiresAt <= Date.now())
        return json({ status: "expired", interval: CONNECT_POLL_INTERVAL });
      if (row.nextPollAt > Date.now()) {
        row.interval = Math.min(30, row.interval + CONNECT_POLL_INTERVAL);
        row.nextPollAt = Date.now() + row.interval * 1000;
        await storage.put(recordKey(row.code), row);
        return json(
          { error: "Wait before checking this connection again." },
          429,
          { "Retry-After": String(row.interval) },
        );
      }
      row.nextPollAt = Date.now() + row.interval * 1000;
      await storage.put(recordKey(row.code), row);
      return json({
        status: row.status,
        interval: row.interval,
        ...(row.status === "approved" ? { workspaceId: row.workspaceId } : {}),
      });
    }
    const code = connectCode(body.code);
    const row = await storage.get<ConnectRequest>(recordKey(code));
    if (!row)
      throw new HttpError(
        404,
        "This install link was not found. Start again in your coding tool.",
      );
    if (body.op === "read") {
      pending(row);
      return json(row);
    }
    if (body.op === "claim") {
      pending(row);
      const actor = principal(body.principalId);
      if (
        typeof body.sessionHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.sessionHash)
      )
        throw new HttpError(400, "Invalid connection sign-in.");
      if (
        row.principalId &&
        (row.principalId !== actor || row.sessionHash !== body.sessionHash)
      )
        throw new HttpError(
          403,
          "This connection belongs to another wallet sign-in. Start again.",
        );
      row.principalId = actor;
      row.sessionHash = body.sessionHash;
    } else if (["bound", "confirm", "deny"].includes(String(body.op))) {
      pending(row);
      bound(row, body);
      if (body.op === "bound") return json(row);
      if (body.op === "confirm") {
        row.status = "confirming";
        row.workspaceId = nativeRoomId(body.workspaceId);
      } else row.status = "denied";
    } else if (body.op === "finish") {
      if (row.expiresAt <= Date.now())
        throw new HttpError(
          410,
          "This install link expired. Start again in your coding tool.",
        );
      bound(row, body);
      if (row.status !== "confirming" || row.workspaceId !== body.workspaceId)
        throw new HttpError(409, "This install link was already used.");
      row.status = body.approved === true ? "approved" : "denied";
    } else throw new HttpError(400, "Invalid connection action.");
    await storage.put(recordKey(code), row);
    return json(row);
  });
}
export async function expireConnectRequests(storage: Storage) {
  if (!(await storage.get(MARKER))) return false;
  const rows = await storage.list<string>({
    prefix: EXPIRY_PREFIX,
    limit: 500,
  });
  const now = Date.now();
  for (const [key, code] of rows) {
    const row = await storage.get<ConnectRequest>(recordKey(code));
    if (row && row.expiresAt > now) {
      await storage.setAlarm(row.expiresAt);
      return true;
    }
    if (row) await storage.delete(`${POLL_PREFIX}${row.pollHash}`);
    await storage.delete(recordKey(code));
    await storage.delete(key);
  }
  if (rows.size === 500) await storage.setAlarm(now + 1);
  return true;
}
