/** A fixed-workspace adapter. It never accepts an upstream URL or forwards
 * browser cookies to widget requests. Key approval is a separate operation. */
import {
  EncryptionProtocolError,
  OWN_SUPPORT_ENDPOINT,
  parseCase,
  object,
  type E2eeCase,
  type OwnSupportEncryptionProfile,
} from "@templ/e2ee/protocol";
import { verifyEncryptionProfile } from "@templ/e2ee/verify";
import type { OwnNativeAuthority } from "@templ/e2ee/own-authority";
import {OwnNativeUnavailable, nativeRoute} from "./diagnostics";

const API = "https://api.usetempl.com";
const APP = "https://usetempl.com";
const SESSION = "__Host-templ_session";
const NONCE = "__Host-templ_nonce";
export type NativeChannel = "member" | "team";
export type NativeRequest = <T>(path: string, body?: object) => Promise<T>;
function refuse(): never {
  throw new EncryptionProtocolError("encryption-scope-changed");
}
export function caseBase(value: E2eeCase) {
  const scope = parseCase(value);
  if (
    scope.workspace !== OWN_SUPPORT_ENDPOINT.workspace ||
    scope.environment !== "production"
  )
    refuse();
  return `/conversations/${scope.conversation}/encryption/${scope.caseSeq}`;
}
function cookies(request: Request) {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((value) => value.trim());
  const result: string[] = [];
  for (const name of [SESSION, NONCE]) {
    const found = values.filter((value) => value.startsWith(`${name}=`));
    if (
      found.length > 1 ||
      found.some(
        (value) => !new RegExp(`^${name}=[A-Za-z0-9._-]{0,256}$`).test(value),
      )
    )
      refuse();
    if (found[0]) result.push(found[0]);
  }
  return result.join("; ");
}
export function nativeHeaders(request: Request, channel: NativeChannel) {
  const headers = new Headers({ Accept: "application/json" });
  if (channel === "member") {
    headers.set("Origin", OWN_SUPPORT_ENDPOINT.clientOrigin);
    const bearer = request.headers.get("Authorization");
    if (bearer) {
      if (!/^Bearer [A-Za-z0-9._-]{16,8192}$/.test(bearer)) refuse();
      headers.set("Authorization", bearer);
    }
  } else if (channel === "team") {
    if (request.headers.has("Authorization")) refuse();
    headers.set("Origin", APP);
    const cookie = cookies(request);
    if (cookie) headers.set("Cookie", cookie);
  } else refuse();
  // Preserve the actual network source for native rate limits; never accept
  // a caller's X-Forwarded-For or arbitrary forwarding headers.
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("CF-Connecting-IP", ip);
  return headers;
}
export async function boundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  if (
    !response.body ||
    !/application\/json/i.test(response.headers.get("Content-Type") ?? "")
  )
    refuse();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) {
        await reader.cancel();
        return refuse();
      }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } finally {
    reader.releaseLock();
  }
}
export function nativeSupportRequest(
  request: Request,
  channel: NativeChannel,
  fetcher: typeof fetch = fetch,
): NativeRequest {
  const base =
    channel === "member"
      ? `/widget/${OWN_SUPPORT_ENDPOINT.workspace}`
      : `/rooms/${OWN_SUPPORT_ENDPOINT.workspace}`;
  return async <T>(path: string, body?: object) => {
    // Internal callers construct all paths from checked cases, never URLs.
    if (
      !path.startsWith("/conversations") ||
      path.includes("..") ||
      path.includes("%") ||
      path.includes("#")
    )
      refuse();
    const headers = nativeHeaders(request, channel);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {response = await fetcher(`${API}${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      // Workers implements manual, but throws before sending for error mode.
      // Never follow a redirect with a native session or guest credential.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });} catch (error) {
      throw new OwnNativeUnavailable(nativeRoute(path), error instanceof DOMException &&
        ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : "network");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OwnNativeUnavailable(nativeRoute(path), "http", response.status);
    }
    try {return (await boundedJson(response, 4 * 1024 * 1024)) as T;}
    catch {throw new OwnNativeUnavailable(nativeRoute(path), "response-format", response.status);}
  };
}
export async function nativeEnrollment(
  request: NativeRequest,
  ref: E2eeCase,
  expected: OwnSupportEncryptionProfile,
): Promise<OwnNativeAuthority> {
  const descriptor = object(await request(caseBase(ref)), [
    "v",
    "mode",
    "case",
    "profile",
    "policyRevision",
    "capabilities",
    "authorizationGrant",
    "enrollment",
  ]);
  const profile = await verifyEncryptionProfile(
    descriptor.profile,
    expected.rootKey,
  );
  const scope = parseCase(descriptor.case);
  if (
    descriptor.v !== 1 ||
    descriptor.mode !== "encrypted" ||
    profile.signature !== expected.signature ||
    caseBase(scope) !== caseBase(ref)
  )
    refuse();
  const native = object(descriptor.enrollment, [
    "principal",
    "kind",
    "authorizationGrant",
    "provisional",
    "wallets",
  ]);
  if (
    typeof native.principal !== "string" ||
    !/^[\w:-]{1,128}$/.test(native.principal) ||
    !["member", "team", "ai"].includes(String(native.kind)) ||
    typeof native.authorizationGrant !== "string" ||
    !/^[a-f0-9]{64}$/.test(native.authorizationGrant) ||
    native.authorizationGrant !== descriptor.authorizationGrant ||
    typeof native.provisional !== "boolean" ||
    !Array.isArray(native.wallets) ||
    native.wallets.length > 32 ||
    native.wallets.some(
      (value) =>
        typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value),
    )
  )
    refuse();
  return { case: scope, ...native } as OwnNativeAuthority;
}

/** Only these exact public routes can be proxied by the isolated client. */
export async function proxyNative(
  request: Request,
  channel: NativeChannel,
  path: string,
  fetcher: typeof fetch = fetch,
) {
  const target = new URL(path, API);
  if (
    target.origin !== API ||
    path !== target.pathname + target.search ||
    target.hash ||
    path.includes("%") ||
    path.includes("..")
  )
    refuse();
  const auth =
    channel === "team" &&
    /^\/auth\/(nonce|verify|session|logout)$/.test(target.pathname);
  const publicMember =
    channel === "member" &&
    ["/auth/policy", "/auth/guest", "/auth/guest-link", "/auth/logout", "/auth/nonce", "/auth/verify"].includes(target.pathname);
  const guestEmail = channel === "member" && /^\/conversations\/tc-[a-f0-9]{32}\/guest-email$/.test(target.pathname);
  const workflow = /^\/conversations\/tc-[a-f0-9]{32}\/workflow$/.test(target.pathname);
  const setup = channel === "team" && target.pathname === "/conversations/encryption/setup";
  const stop = channel === "team" && target.pathname === "/conversations/encryption" && request.method === "POST";
  const encryption =
    /^\/conversations\/tc-[a-f0-9]{32}\/encryption\/[1-9][0-9]{0,7}(?:\/(?:directory|history|outcome|enroll|fence|revoke|ai-context|control|contact))?$/.test(
      target.pathname,
    );
  const writes = /^\/conversations\/(?:ask|tc-[a-f0-9]{32}\/messages)$/.test(
    target.pathname,
  );
  const other = [
    "/conversations",
    "/conversations/encryption",
    "/conversations/encryption/prepare",
  ].includes(target.pathname);
  if (
    (!auth && !publicMember && !encryption && !writes && !other && !guestEmail && !workflow && !setup) ||
    !["GET", "POST"].includes(request.method)
  )
    refuse();
  const post = request.method === "POST";
  const contact = target.pathname.endsWith("/contact");
  if (contact && channel !== "member") refuse();
  if (
    (auth && post !== (target.pathname !== "/auth/session")) ||
    (publicMember && post !== (target.pathname !== "/auth/policy")) ||
    (writes && !post) ||
    (workflow && !post) ||
    (other && !stop && post !== target.pathname.endsWith("/prepare")) ||
    (encryption && !contact && post !== /\/(enroll|fence|revoke)$/.test(target.pathname))
  )
    refuse();
  const queryKeys = [...target.searchParams.keys()];
  const allowedQueries = target.pathname.endsWith("/directory")
    ? ["audience"]
    : target.pathname.endsWith("/history")
      ? ["audience", "after", "limit"]
      : target.pathname.endsWith("/outcome")
        ? ["id"]
        : target.pathname === "/conversations"
          ? ["filter", "cursor", ...(channel === "member" ? ["view"] : [])]
          : [];
  if (
    queryKeys.some((key) => !allowedQueries.includes(key)) ||
    new Set(queryKeys).size !== queryKeys.length
  )
    refuse();
  if (target.pathname === "/conversations" && (
    (target.searchParams.has("filter") && !["open", "resolved", "all", "archived"].includes(target.searchParams.get("filter")!)) ||
    (target.searchParams.has("view") && target.searchParams.get("view") !== "member") ||
    (target.searchParams.has("cursor") && !/^tc-[a-f0-9]{32}$/.test(target.searchParams.get("cursor")!))
  )) refuse();
  const headers = nativeHeaders(request, channel);
  let body: object | undefined;
  if (post) {
    body = (await boundedJson(
      new Response(request.body, { headers: request.headers }),
      40_000,
    )) as object;
    if (writes)
      object(
        body,
        ["encryptedRecord", "validationReceipt"],
        ["reservation", "confirmed", ...(channel === "team" ? ["expectedPrincipalId"] : [])],
      );
    if (setup) object(body, ["authorization", "confirmed", "expectedPrincipalId"]);
    if (contact) object(body, ["email", "clientId", "messageId", "expectedRevision", "confirmed"]);
    if (stop) {
      const value = object(body, ["on", "revision", "profile", "signature", "confirmed", "expectedPrincipalId"]);
      if (value.on !== false || value.confirmed !== true) refuse();
    }
    if (target.pathname === "/auth/guest-link") object(body, ["thread", "token"]);
    if (channel === "member" && target.pathname === "/auth/nonce") object(body, ["address"], ["chainId", "network"]);
    if (channel === "member" && target.pathname === "/auth/verify") object(body, ["message", "nonce", "expiresAt", "signature"]);
    if (channel === "member" && target.pathname === "/auth/logout") {
      const value = object(body, [], ["forget"]);
      if (value.forget !== undefined && value.forget !== true) refuse();
    }
    if (workflow) {
      const value = body as Record<string, unknown>;
      if (channel === "member") {
        object(body, ["action", "expectedCaseSeq"]);
        if (value.action !== "ask-person") refuse();
      } else {
        object(body, ["action", "mode", "expectedCaseSeq", "expectedPrincipalId"], ["takeOver"]);
        if (value.action !== "ai-mode" || !["off", "drafts", "answers"].includes(String(value.mode)) ||
            value.takeOver !== undefined && value.takeOver !== true) refuse();
      }
      if (!Number.isSafeInteger(value.expectedCaseSeq) || Number(value.expectedCaseSeq) < 1) refuse();
    }
    if (guestEmail) {
      const value = body as Record<string, unknown>;
      if (value.enabled === false) object(body, ["enabled"]);
      else {
        object(body, ["email", "path"]);
        if (value.path !== "/") refuse();
      }
    }
    if (channel === "team" && !auth) {
      const principal = (body as Record<string, unknown>).expectedPrincipalId;
      if (typeof principal !== "string" || !/^[\w:-]{1,128}$/.test(principal)) refuse();
    }
    if (auth)
      object(
        body,
        target.pathname.endsWith("/nonce")
          ? ["address", "chainId"]
          : target.pathname.endsWith("/verify")
            ? ["message", "signature"]
            : [],
      );
    headers.set("Content-Type", "application/json");
  }
  const base = auth
    ? ""
    : channel === "member"
      ? `/widget/${OWN_SUPPORT_ENDPOINT.workspace}`
      : `/rooms/${OWN_SUPPORT_ENDPOINT.workspace}`;
  // The previous API must refuse wallet transfer, including when a new edge
  // still reaches an old room object. Never fall back to legacy linking.
  const upstreamPath = channel === "member" && ["/auth/nonce", "/auth/verify"].includes(path)
    ? path.replace("/auth/", "/auth/own-encrypted/") : path;
  const response = await fetcher(`${API}${base}${upstreamPath}`, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return refuse();
  }
  const result = await boundedJson(response, 4 * 1024 * 1024);
  const outgoing = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  if (auth) {
    for (const value of response.headers.getSetCookie()) {
      if (
        ![SESSION, NONCE].some((name) => value.startsWith(`${name}=`)) ||
        !/;\s*Secure(?:;|$)/i.test(value) ||
        !/;\s*HttpOnly(?:;|$)/i.test(value) ||
        /;\s*Domain=/i.test(value)
      )
        refuse();
      outgoing.append("Set-Cookie", value);
    }
  }
  const retry = response.headers.get("Retry-After");
  if (retry && /^\d{1,5}$/.test(retry)) outgoing.set("Retry-After", retry);
  return new Response(JSON.stringify(result), {
    status: response.status,
    headers: outgoing,
  });
}
