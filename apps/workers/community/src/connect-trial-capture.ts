import type { Address } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { isSupportSiweChainId } from "@templ/chat/chains";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import {
  readServingReleaseIdentity,
  type ServingReleaseIdentity,
} from "@templ/chat/support-install-fixture";
import type { AuthData } from "./auth-record";
import {
  HttpError,
  json,
  randomToken,
  readBytes,
  readCookie,
  readJson,
  recordByHash,
  SESSION_COOKIE,
  sha256Hex,
  siteOrigins,
  type Env,
} from "./common";
import { connectTrialSnapshot, type ConnectLimitDecision } from "./connect";
import { verifySessionAuthority } from "./chain";
import { sessionIdentity, walletSignsIn } from "./linked-wallets";
import {
  NATIVE_CATALOG,
  NATIVE_CREATIONS_PER_DAY,
  NATIVE_ROOMS_PER_CREATOR,
  nativeRoomId,
} from "./native-rooms";
import { requireWalletAuth } from "./privileged-auth";
import { releaseIdentity } from "./release-identity";
import { requireSafetyAccess } from "./safety";
import { servicePrincipals, sessionPrincipals } from "./service-principals";
import { connectTrialContext } from "./workspace-flags";

export const CONNECT_CAPTURE_HEADER = "X-Templ-Connect-Trial";
export const CONNECT_CAPTURE_TTL = 30 * 60_000;
export const CONNECT_CAPTURE_REQUESTS = 128;
const PREFIX = "connect-trial-capture:";
const USED = "connect-trial-capture-used:";
const EXPIRY = "connect-trial-capture-expiry:";
const INTERNAL = "/connect-trial-capture";
const HEX = /^[0-9a-f]{64}$/;
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "setAlarm" | "getAlarm"
>;
export type ConnectCaptureScope = {
  schemaVersion: 1;
  environment: "production";
  anchor: string;
  worker: ServingReleaseIdentity;
  web: ServingReleaseIdentity;
};
export type ConnectCaptureTrace = {
  phase: "ip" | "global" | "functional";
  ordinal: number;
  at: number;
  colo: string;
  ipDigest: string;
  decisions: {
    scope: "ip" | "global";
    keySha256: string;
    success: boolean;
    at: number;
  }[];
  status: number;
  refusal?: { error: string };
};
type Capture = {
  scope: ConnectCaptureScope;
  tokenHash: string;
  issuerSession: string;
  issuer: string;
  salt: string;
  expiresAt: number;
  createdAt: number;
  anchorUntil: number;
  traces: ConnectCaptureTrace[];
  preflights: {
    colo: string;
    ipDigest: string;
    worker: ServingReleaseIdentity;
  }[];
  inventory: {
    createdTotal: number;
    createdLast24Hours: number;
    totalLimit: typeof NATIVE_ROOMS_PER_CREATOR;
    dailyLimit: typeof NATIVE_CREATIONS_PER_DAY;
  };
  registrySnapshot?: { code: string; pollHash: string; status: string };
  invalid?: true;
};
const unavailable = () =>
  new HttpError(404, "Connect trial capture is unavailable.");
function exact(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  )
    throw unavailable();
  return value as Record<string, unknown>;
}
export function readConnectCaptureScope(value: unknown): ConnectCaptureScope {
  const scope = exact(value, [
    "schemaVersion",
    "environment",
    "anchor",
    "worker",
    "web",
  ]);
  if (scope.schemaVersion !== 1 || scope.environment !== "production")
    throw unavailable();
  return {
    schemaVersion: 1,
    environment: "production",
    anchor: nativeRoomId(scope.anchor),
    worker: readServingReleaseIdentity(scope.worker, "community"),
    web: readServingReleaseIdentity(scope.web, "web"),
  };
}
async function workerIdentity(env: Env) {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.SUPPORT_CONNECT_ENABLED !== "true"
  )
    throw unavailable();
  const response = releaseIdentity(env);
  if (!response.ok) throw unavailable();
  return readServingReleaseIdentity(await response.json(), "community");
}
async function currentPair(env: Env, scope: ConnectCaptureScope) {
  const worker = await workerIdentity(env);
  const response = await fetch("https://usetempl.com/api/release", {
    redirect: "manual",
    headers: { "Cache-Control": "no-store" },
    cf: { cacheTtl: 0 },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw unavailable();
  }
  let web: ServingReleaseIdentity;
  try {
    web = readServingReleaseIdentity(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          await readBytes(response, 65_536),
        ),
      ),
      "web",
    );
  } catch {
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  if (
    JSON.stringify({ worker, web }) !==
    JSON.stringify({ worker: scope.worker, web: scope.web })
  )
    throw unavailable();
}
async function sessionRecord(env: Env, hash: string) {
  if (!HEX.test(hash)) throw unavailable();
  const response = await recordByHash(env, "session", hash).fetch(
    new Request("https://internal/read", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw unavailable();
  }
  const data = await response.json<AuthData>();
  const now = Date.now();
  if (
    data.widgetScope ||
    data.contractChain !== undefined ||
    data.authMethod !== "wallet" ||
    !data.principalId ||
    !data.address ||
    !data.authorization ||
    data.nonce ||
    data.message ||
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= now ||
    !Number.isSafeInteger(data.authorizationExpiresAt) ||
    data.authorizationExpiresAt! < data.expiresAt ||
    !Number.isSafeInteger(data.authenticatedAt) ||
    data.authenticatedAt! <= 0 ||
    data.authenticatedAt! > now ||
    !Number.isSafeInteger(data.walletRevision) ||
    data.walletRevision! < 0
  )
    throw unavailable();
  const principal = normalizeChatPrincipal(data.principalId);
  if (!principal || !/^0x[0-9a-f]{40}$/.test(data.address)) throw unavailable();
  servicePrincipals(principal, data.servicePrincipals);
  const proof = parseSiweMessage(data.authorization.message);
  const at = data.authenticatedAt!;
  if (
    proof.domain !== "usetempl.com" ||
    proof.scheme !== "https" ||
    proof.uri !== env.APP_ORIGIN ||
    proof.address?.toLowerCase() !== data.address ||
    proof.version !== "1" ||
    !isSupportSiweChainId(proof.chainId) ||
    !proof.nonce ||
    !HEX.test(proof.nonce) ||
    !proof.issuedAt ||
    !proof.expirationTime ||
    !Number.isFinite(proof.issuedAt.getTime()) ||
    !Number.isFinite(proof.expirationTime.getTime()) ||
    proof.issuedAt.getTime() > at ||
    proof.expirationTime.getTime() < at ||
    proof.statement !==
      (data.connectCode
        ? "Connect this app to your Templ workspace."
        : "Sign in to your Templ chat.") ||
    JSON.stringify(proof.resources ?? []) !==
      JSON.stringify(
        data.connectCode
          ? [`${env.APP_ORIGIN}/connect/${data.connectCode}`]
          : [],
      )
  )
    throw unavailable();
  return data;
}
async function issuer(env: Env, hash: string) {
  const data = await sessionRecord(env, hash);
  const read = await sessionIdentity(env, data.principalId!);
  if (
    !(await verifySessionAuthority(
      env,
      data.address as Address,
      data.authorization,
    )) ||
    (read.identity.principalId.startsWith("account:") &&
      !walletSignsIn(read.linked, data.address as Address))
  )
    throw unavailable();
  return {
    ...read.identity,
    authenticatedAt: data.authenticatedAt,
    authMethod: data.authMethod,
    connectCode: data.connectCode,
  };
}
async function authority(
  env: Env,
  scope: ConnectCaptureScope,
  hash: string,
  expected?: string,
) {
  if (
    JSON.stringify(await workerIdentity(env)) !== JSON.stringify(scope.worker)
  )
    throw unavailable();
  const current = await issuer(env, hash);
  if (expected !== undefined && current.principalId !== expected)
    throw unavailable();
  await requireSafetyAccess(
    env,
    `room:${scope.anchor}`,
    current.principalId,
    sessionPrincipals(current),
  );
  const anchor = await connectTrialContext(env, scope.anchor, current);
  const latest = await issuer(env, hash);
  if (
    latest.principalId !== current.principalId ||
    !sessionPrincipals(latest).includes(anchor.manager) ||
    !sessionPrincipals(latest).includes(anchor.trialOperator)
  )
    throw unavailable();
  await requireSafetyAccess(
    env,
    `room:${scope.anchor}`,
    latest.principalId,
    sessionPrincipals(latest),
  );
  const finalAnchor = await connectTrialContext(env, scope.anchor, latest);
  if (
    finalAnchor.manager !== anchor.manager ||
    finalAnchor.trialOperator !== anchor.trialOperator
  )
    throw unavailable();
  return { current: latest, anchor: finalAnchor };
}
async function capacity(env: Env, current: Awaited<ReturnType<typeof issuer>>) {
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(NATIVE_CATALOG),
  ).fetch(
    new Request("https://internal/private/native-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "trial-capacity",
        principalId: current.principalId,
        servicePrincipals: sessionPrincipals(current),
      }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!response.ok) throw unavailable();
  const result = exact(await response.json(), [
    "createdTotal",
    "createdLast24Hours",
    "totalLimit",
    "dailyLimit",
  ]);
  if (
    !Number.isSafeInteger(result.createdTotal) ||
    !Number.isSafeInteger(result.createdLast24Hours) ||
    Number(result.createdTotal) < 0 ||
    Number(result.createdLast24Hours) < 0 ||
    Number(result.createdLast24Hours) > Number(result.createdTotal) ||
    result.totalLimit !== NATIVE_ROOMS_PER_CREATOR ||
    result.dailyLimit !== NATIVE_CREATIONS_PER_DAY
  )
    throw unavailable();
  return result as Capture["inventory"];
}
function credential(request: Request, trace = false) {
  const parts = (request.headers.get(CONNECT_CAPTURE_HEADER) ?? "").split(".");
  if (parts.length !== (trace ? 4 : 2) || !HEX.test(parts[1] ?? ""))
    throw unavailable();
  const anchor = nativeRoomId(parts[0]);
  if (
    trace &&
    (!["ip", "global", "functional"].includes(parts[2]) ||
      !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(parts[3]))
  )
    throw unavailable();
  return {
    anchor,
    token: parts[1],
    phase: parts[2] as ConnectCaptureTrace["phase"],
    ordinal: Number(parts[3]),
  };
}
async function registry(env: Env, body: Record<string, unknown>) {
  const response = await env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${siteOrigins(env).origin.hostname}:connect:v1`,
    ),
  ).fetch(
    new Request(`https://internal${INTERNAL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw unavailable();
  }
  return response;
}
function ingress(request: Request) {
  const colo = request.cf?.colo;
  const ip = request.headers.get("CF-Connecting-IP");
  if (
    typeof colo !== "string" ||
    !/^[A-Z]{3}$/.test(colo) ||
    !ip ||
    ip === "unknown" ||
    ip.length > 45 ||
    !/^[0-9a-fA-F:.]+$/.test(ip)
  )
    throw unavailable();
  return { colo, ip };
}
async function ipDigest(salt: string, ip: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ip),
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Tagged starts retain the native decisions after the ordinary request completes. */
export async function observeConnectTrialStart(
  request: Request,
  env: Env,
  decisions: ConnectLimitDecision[],
  status: number,
  refusal?: { error: string },
) {
  if (!request.headers.has(CONNECT_CAPTURE_HEADER)) return;
  try {
    const { anchor, token, phase, ordinal } = credential(request, true);
    const observed = ingress(request);
    const tokenHash = await sha256Hex(token);
    const read = await registry(env, { op: "salt", anchor, tokenHash });
    const { salt } = await read.json<{ salt: string }>();
    const trace: ConnectCaptureTrace = {
      phase,
      ordinal,
      at: Date.now(),
      colo: observed.colo,
      ipDigest: await ipDigest(salt, observed.ip),
      decisions: await Promise.all(
        decisions.map(async (decision, index) => ({
          scope: index === 0 ? ("ip" as const) : ("global" as const),
          keySha256: await sha256Hex(decision.key),
          success: decision.success,
          at: decision.at,
        })),
      ),
      status,
      ...(refusal ? { refusal } : {}),
    };
    await registry(env, { op: "append", anchor, tokenHash, trace });
  } catch {
    // A missing trace refuses proof. Ordinary Connect responses keep their status.
  }
}
/** Only a listed trial signer can register or read one fresh anchor's capture. */
export async function connectTrialCaptureRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const managed =
    /^\/rooms\/([0-9a-f-]{36})\/connect-trial-capture(?:\/(revoke))?$/.exec(
      path,
    );
  const snapshot =
    /^\/connect\/([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\/trial-snapshot$/.exec(
      path,
    );
  if (!managed && !snapshot && path !== "/connect/trial-capture/preflight")
    return null;
  await workerIdentity(env);
  if (path === "/connect/trial-capture/preflight") {
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed.");
    if (
      request.headers.has("Cookie") ||
      request.headers.has("Authorization") ||
      (request.headers.has("Origin") &&
        request.headers.get("Origin") !== env.APP_ORIGIN)
    )
      throw unavailable();
    const { anchor, token } = credential(request);
    const observed = ingress(request);
    const tokenHash = await sha256Hex(token);
    const response = await registry(env, { op: "salt", anchor, tokenHash });
    const { salt } = await response.json<{ salt: string }>();
    return registry(env, {
      op: "preflight",
      anchor,
      tokenHash,
      colo: observed.colo,
      ipDigest: await ipDigest(salt, observed.ip),
    });
  }
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || request.headers.get("Origin") !== env.APP_ORIGIN)
    throw unavailable();
  const sessionHash = await sha256Hex(token);
  if (snapshot) {
    if (request.method !== "GET")
      throw new HttpError(405, "Method not allowed.");
    const { anchor, token: captureToken } = credential(request);
    return registry(env, {
      op: "snapshot",
      anchor,
      tokenHash: await sha256Hex(captureToken),
      code: snapshot[1],
      ownerSession: sessionHash,
    });
  }
  const anchor = nativeRoomId(managed![1]);
  if (request.method === "POST" && !managed![2]) {
    const body = await readJson(request, 4096);
    exact(body, ["scope", "expectedPrincipalId", "confirmed"]);
    const scope = readConnectCaptureScope(body.scope);
    if (scope.anchor !== anchor) throw unavailable();
    const initial = await authority(
      env,
      scope,
      sessionHash,
      String(body.expectedPrincipalId),
    );
    requireWalletAuth(initial.current, body.confirmed);
    await currentPair(env, scope);
    const captureToken = randomToken();
    return registry(env, {
      op: "create",
      scope,
      issuerSession: sessionHash,
      expectedPrincipalId: body.expectedPrincipalId,
      tokenHash: await sha256Hex(captureToken),
      token: captureToken,
    });
  }
  if (
    (request.method === "GET" && !managed![2]) ||
    (request.method === "POST" && managed![2] === "revoke")
  ) {
    const { anchor: bound, token: captureToken } = credential(request);
    if (anchor !== bound) throw unavailable();
    return registry(env, {
      op: managed![2] ? "revoke" : "export",
      anchor,
      tokenHash: await sha256Hex(captureToken),
      ownerSession: sessionHash,
    });
  }
  throw new HttpError(405, "Method not allowed.");
}
/** The existing Connect registry stores only bounded synthetic capture rows. */
export async function connectCaptureRecordRequest(
  request: Request,
  state: DurableObjectState,
  env: Env,
) {
  if (new URL(request.url).pathname !== INTERNAL || request.method !== "POST")
    return null;
  const body = await readJson(request, 32_768);
  const scope =
    body.op === "create" ? readConnectCaptureScope(body.scope) : undefined;
  const anchor = scope?.anchor ?? nativeRoomId(body.anchor);
  const key = `${PREFIX}${anchor}`;
  const initial = await state.storage.get<Capture>(key);
  if (
    body.op !== "create" &&
    (!initial ||
      initial.invalid ||
      initial.expiresAt <= Date.now() ||
      initial.tokenHash !== body.tokenHash)
  )
    throw unavailable();
  const hash = scope ? String(body.issuerSession) : initial!.issuerSession;
  const actualScope = scope ?? initial!.scope;
  if (body.op === "export") await currentPair(env, actualScope);
  const access = await authority(
    env,
    actualScope,
    hash,
    scope ? String(body.expectedPrincipalId) : initial!.issuer,
  );
  const inventory = ["create", "export"].includes(String(body.op))
    ? await capacity(env, access.current)
    : undefined;
  if (
    ["export", "revoke"].includes(String(body.op)) &&
    body.ownerSession !== hash
  )
    throw unavailable();
  let owner: Awaited<ReturnType<typeof issuer>> | undefined;
  if (body.op === "snapshot") {
    owner = await issuer(env, String(body.ownerSession));
    if (
      owner.connectCode !== body.code ||
      owner.principalId !== access.current.principalId
    )
      throw unavailable();
  }
  return state.storage.transaction(async (storage) => {
    if (body.op === "snapshot")
      await sessionRecord(env, String(body.ownerSession));
    const final = await authority(
      env,
      actualScope,
      hash,
      access.current.principalId,
    );
    const latest = await sessionRecord(env, hash);
    const now = Date.now();
    if (
      latest.authenticatedAt !== access.current.authenticatedAt ||
      latest.expiresAt <= now ||
      env.SUPPORT_CONNECT_ENABLED !== "true" ||
      Date.parse(final.anchor.until) <= Date.now()
    )
      throw unavailable();
    if (body.op === "create") {
      requireWalletAuth(access.current, true, now);
      if (
        (await storage.get(key)) ||
        (await storage.get(`${USED}${anchor}`)) ||
        typeof body.tokenHash !== "string" ||
        !HEX.test(body.tokenHash) ||
        typeof body.token !== "string" ||
        (await sha256Hex(body.token)) !== body.tokenHash
      )
        throw unavailable();
      const anchorUntil = Math.min(
        Date.parse(final.anchor.createdAt) + 60 * 60_000,
        Date.parse(final.anchor.until),
      );
      const expiresAt = Math.min(now + CONNECT_CAPTURE_TTL, anchorUntil);
      const capture: Capture = {
        scope: actualScope,
        tokenHash: body.tokenHash,
        issuerSession: hash,
        issuer: access.current.principalId,
        salt: randomToken(),
        expiresAt,
        createdAt: now,
        anchorUntil,
        inventory: inventory!,
        traces: [],
        preflights: [],
      };
      await storage.put(key, capture);
      await storage.put(`${USED}${anchor}`, anchorUntil);
      await storage.put(
        `${EXPIRY}${String(expiresAt).padStart(13, "0")}:${anchor}`,
        anchor,
      );
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > expiresAt)
        await storage.setAlarm(expiresAt);
      return json(
        { token: body.token, scope: actualScope, expiresAt, inventory },
        201,
      );
    }
    const row = await storage.get<Capture>(key);
    if (
      !row ||
      row.invalid ||
      row.expiresAt <= now ||
      row.tokenHash !== body.tokenHash ||
      JSON.stringify(row.scope) !== JSON.stringify(actualScope)
    )
      throw unavailable();
    if (body.op === "salt") return json({ salt: row.salt });
    if (body.op === "revoke") {
      row.invalid = true;
      await storage.put(key, row);
      return json({ revoked: true });
    }
    if (body.op === "preflight") {
      if (
        row.preflights.length >= 2 ||
        row.traces.length ||
        typeof body.colo !== "string" ||
        !/^[A-Z]{3}$/.test(body.colo) ||
        typeof body.ipDigest !== "string" ||
        !HEX.test(body.ipDigest)
      )
        throw unavailable();
      const preflight = {
        colo: body.colo,
        ipDigest: body.ipDigest,
        worker: actualScope.worker,
      };
      row.preflights.push(preflight);
      await storage.put(key, row);
      return json(preflight);
    }
    if (body.op === "append") {
      const trace = body.trace as ConnectCaptureTrace;
      try {
        exact(trace, [
          "phase",
          "ordinal",
          "at",
          "colo",
          "ipDigest",
          "decisions",
          "status",
          ...(trace?.refusal ? ["refusal"] : []),
        ]);
        for (const decision of trace.decisions)
          exact(decision, ["scope", "keySha256", "success", "at"]);
        if (trace.refusal) exact(trace.refusal, ["error"]);
      } catch {
        row.invalid = true;
        await storage.put(key, row);
        return json({ invalid: true });
      }
      if (
        row.preflights.length !== 2 ||
        row.preflights[0].colo !== row.preflights[1].colo ||
        row.preflights[0].ipDigest === row.preflights[1].ipDigest ||
        row.traces.length >= CONNECT_CAPTURE_REQUESTS ||
        !trace ||
        !["ip", "global", "functional"].includes(trace.phase) ||
        !Number.isSafeInteger(trace.ordinal) ||
        trace.ordinal < 1 ||
        trace.ordinal > CONNECT_CAPTURE_REQUESTS ||
        !Number.isSafeInteger(trace.at) ||
        trace.at < row.createdAt ||
        trace.at > now ||
        trace.colo !== row.preflights[0].colo ||
        !row.preflights.some((p) => p.ipDigest === trace.ipDigest) ||
        row.traces.some(
          (t) => t.phase === trace.phase && t.ordinal === trace.ordinal,
        ) ||
        !Array.isArray(trace.decisions) ||
        trace.decisions.length < 1 ||
        trace.decisions.length > 2 ||
        trace.decisions.some(
          (d, i) =>
            d.scope !== (i === 0 ? "ip" : "global") ||
            !HEX.test(d.keySha256) ||
            typeof d.success !== "boolean" ||
            !Number.isSafeInteger(d.at) ||
            d.at < row.createdAt ||
            d.at > trace.at,
        ) ||
        (trace.decisions.length === 1 && trace.decisions[0].success) ||
        ![201, 400, 429].includes(trace.status) ||
        (trace.refusal !== undefined &&
          (trace.status !== 429 ||
            trace.refusal.error !==
              "Too many connection requests. Try again later.")) ||
        (trace.status === 429 && trace.decisions.every((d) => d.success)) ||
        (trace.decisions.some((d) => !d.success) &&
          (trace.status !== 429 ||
            trace.refusal?.error !==
              "Too many connection requests. Try again later."))
      ) {
        row.invalid = true;
        await storage.put(key, row);
        return json({ invalid: true });
      }
      row.traces.push(trace);
      await storage.put(key, row);
      return json({ recorded: true });
    }
    if (body.op === "snapshot") {
      if (row.registrySnapshot) throw unavailable();
      row.registrySnapshot = await connectTrialSnapshot(storage, {
        code: body.code,
        principalId: owner!.principalId,
        sessionHash: body.ownerSession,
      });
      await storage.put(key, row);
      return json(row.registrySnapshot);
    }
    if (body.op === "export")
      return json({
        schemaVersion: 1,
        scope: row.scope,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        capturedAt: new Date(now).toISOString(),
        inventoryBefore: row.inventory,
        inventoryAfter: inventory,
        preflights: row.preflights,
        traces: row.traces,
        registrySnapshot: row.registrySnapshot,
      });
    throw unavailable();
  });
}
export async function expireConnectCaptures(storage: Storage) {
  const now = Date.now();
  const due = await storage.list<string>({
    prefix: EXPIRY,
    end: `${EXPIRY}${String(now + 1).padStart(13, "0")}`,
    limit: 128,
  });
  let next = Infinity;
  for (const [key, anchor] of due) {
    await storage.delete(`${PREFIX}${anchor}`);
    await storage.delete(key);
    const usedUntil = await storage.get<number>(`${USED}${anchor}`);
    if (usedUntil !== undefined && usedUntil > now) {
      next = Math.min(next, usedUntil);
      await storage.put(
        `${EXPIRY}${String(usedUntil).padStart(13, "0")}:${anchor}`,
        anchor,
      );
    } else await storage.delete(`${USED}${anchor}`);
  }
  const pending = await storage.list<string>({ prefix: EXPIRY, limit: 1 });
  const first = [...pending.keys()][0];
  if (first !== undefined)
    next = Math.min(
      next,
      Number(first.slice(EXPIRY.length, EXPIRY.length + 13)),
    );
  if (due.size === 128) next = Math.min(next, now + 1);
  if (Number.isFinite(next)) {
    if (next <= now) next = now + 1;
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm <= now || alarm > next)
      await storage.setAlarm(next);
  }
}
