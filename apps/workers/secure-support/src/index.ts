import {
  EncryptionProtocolError,
  OWN_SUPPORT_ENDPOINT,
  decoded,
  object,
  parseCase,
  type OwnSupportEncryptionProfile,
} from "@templ/e2ee/protocol";
import { sha256, verifyEncryptionProfile } from "@templ/e2ee/verify";
import { CustomerContentRefusal } from "@templ/e2ee/customer";
import { OwnDeviceApprovalRequired } from "@templ/e2ee/own-authority";
import type { CustomerKeyBackup } from "@templ/e2ee/backup";
import {
  r2AuthorityStore,
  restoreOwnVault,
  type NativeAuthorityControl,
} from "./authority-journal";
import {
  boundedJson,
  nativeEnrollment,
  nativeSupportRequest,
  proxyNative,
  type NativeChannel,
} from "./native-api";
import { ownOperation, type OwnOperation } from "./endpoint";
import {exportOwnSetupState} from "./setup-state";
import {ownKeyFailure, type OwnKeyPhase} from "./diagnostics";

export type Env = {
  /** Public signed profile, pinned as deployment configuration. */
  PROFILE: string;
  ROOT_KEY: string;
  SOURCE_SHA: string;
  /** Public keys of the independently approved Own AI endpoint. */
  AI_ENCRYPTION_KEY?: string;
  AI_SIGNING_KEY?: string;
  AI_VERIFIER_KEY?: string;
  AUTHORITY: R2Bucket;
  NATIVE_AUTHORITY: NativeAuthorityControl;
  /** Independent secret bindings. Neither appears in the public profile. */
  KEY_BACKUP_WRAPPING_KEY: string;
  AUTHORITY_WRAPPING_KEY: string;
  REQUEST_LIMIT: RateLimit;
  ASSETS: Fetcher;
};
const security = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://api.usetempl.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...security },
  });
}
/** Only durations from this successful authenticated request leave the key
 * service. Never attach requests, case details or authority state. */
function keyTimings() {
  const spans = new Map<string, number>();
  return {
    async time<T>(name: "native-case" | "checkpoint" | "r2-read" | "r2-commit" | "key-restore", run: () => Promise<T>) {
      const start = Date.now();
      try { return await run(); }
      finally { spans.set(name, (spans.get(name) ?? 0) + Math.max(0, Date.now() - start)); }
    },
    header: () => [...spans].map(([name, ms]) => `own-${name};dur=${ms}`).join(", "),
  };
}
async function wrappingKey(value: string) {
  const bytes = decoded(value, 32);
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}
async function profile(env: Env): Promise<OwnSupportEncryptionProfile> {
  if (!env.PROFILE || env.PROFILE.length > 4096 || !env.ROOT_KEY)
    throw new EncryptionProtocolError();
  const value = await verifyEncryptionProfile(
    JSON.parse(env.PROFILE),
    env.ROOT_KEY,
  );
  if (value.custody !== "templ-own-support")
    throw new EncryptionProtocolError();
  return value;
}
/** This factory keeps outbound HTTP testable without replacing authentication
 * or cryptography in local endpoint tests. Production uses the normal fetch. */
export function secureSupportWorker(fetcher: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let keyOperation: string | undefined, phase: OwnKeyPhase = "profile";
      try {
        const url = new URL(request.url);
        if (
          url.origin !== OWN_SUPPORT_ENDPOINT.serviceOrigin ||
          url.username ||
          url.password ||
          url.hash
        )
          return json({ error: "Not found." }, 404);
        if (request.method === "GET" && url.pathname === "/profile")
          return json(await profile(env));
        if (
          request.method === "GET" &&
          ["/", "/widget", "/inbox-case", "/client.js", "/client.css", "/geist.woff2", "/geist-mono.woff2", "/templ-wordmark.svg", "/templ-square.svg", "/asset-manifest.json"].includes(url.pathname)
        ) {
          const framed = url.pathname === "/widget" || url.pathname === "/inbox-case";
          const asset = await env.ASSETS.fetch(framed ? new Request(new URL("/", url), request) : request);
          const headers = new Headers(asset.headers);
          for (const [key, value] of Object.entries(security))
            headers.set(key, value);
          if (framed && asset.status === 200) {
            const parents = url.pathname === "/inbox-case"
              ? "https://usetempl.com"
              : "https://usetempl.com https://docs.usetempl.com https://blog.usetempl.com";
            headers.set("Content-Security-Policy", security["Content-Security-Policy"].replace("frame-ancestors 'none'", `frame-ancestors ${parents}`));
            headers.delete("X-Frame-Options");
          }
          return new Response(asset.body, { status: asset.status, headers });
        }
        // Cookies alone never authorize a cross-origin request. GETs use a
        // non-simple header; every mutation additionally needs exact Origin.
        if (
          request.headers.get("X-Templ-Secure") !== "1" ||
          (request.method !== "GET" &&
            request.headers.get("Origin") !==
              OWN_SUPPORT_ENDPOINT.clientOrigin) ||
          ![null, "same-origin"].includes(request.headers.get("Sec-Fetch-Site"))
        )
          return json(
            { error: "Open Templ encrypted support to continue." },
            403,
          );
        const ip = request.headers.get("CF-Connecting-IP");
        if (
          !ip ||
          !(
            await env.REQUEST_LIMIT.limit({
              key: await sha256(new TextEncoder().encode(ip)),
            })
          ).success
        )
          return json({ error: "Please wait before trying again." }, 429);
        if (request.method === "GET" && url.pathname === "/health" && !url.search) {
          const current = await profile(env);
          if (!/^[a-f0-9]{40}$/.test(env.SOURCE_SHA)) throw new EncryptionProtocolError();
          const [checkpoint, authority, backup] = await Promise.all([
            env.NATIVE_AUTHORITY.read(), env.AUTHORITY.head("own-authority/current-v1"),
            env.AUTHORITY.head("own-keys/backup-v1.json"),
          ]);
          const ready = Boolean(authority && backup && env.KEY_BACKUP_WRAPPING_KEY && env.AUTHORITY_WRAPPING_KEY);
          return json({v: 1, service: "templ-own-secure-support", sourceHead: env.SOURCE_SHA,
            workspace: current.workspace, rootKeySha256: await sha256(new TextEncoder().encode(current.rootKey)),
            ready, authorityAnchored: checkpoint.authority !== null}, ready ? 200 : 503);
        }
        if (request.method === "GET" && url.pathname === "/setup/team/state" && !url.search) {
          const currentProfile = await profile(env);
          // Native manager authorization precedes opening either vault. The
          // helper repeats it around the current journal/native checkpoint.
          const native = nativeSupportRequest(request, "team", fetcher);
          await native("/conversations/encryption/setup");
          return json(await exportOwnSetupState({profile: currentProfile, request: native,
            backup: async () => {
              const encrypted = await env.AUTHORITY.get("own-keys/backup-v1.json");
              if (!encrypted || encrypted.size > 16_384) throw new EncryptionProtocolError();
              return JSON.parse(await encrypted.text()) as CustomerKeyBackup;
            },
            backupWrappingKey: await wrappingKey(env.KEY_BACKUP_WRAPPING_KEY),
            authorityWrappingKey: await wrappingKey(env.AUTHORITY_WRAPPING_KEY),
            store: r2AuthorityStore(env.AUTHORITY), native: env.NATIVE_AUTHORITY}));
        }
        const proxied = /^\/native\/(member|team)(\/.*)$/.exec(url.pathname);
        if (proxied) {
          const response = await proxyNative(
            request,
            proxied[1] as NativeChannel,
            proxied[2] + url.search,
            fetcher,
          );
          const headers = new Headers(response.headers);
          for (const [key, value] of Object.entries(security))
            headers.set(key, value);
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        }
        const match =
          /^\/keys\/(member|team)\/(challenge|enroll|revoke-device|validate|recover)$/.exec(
            url.pathname,
          );
        if (!match || request.method !== "POST" || url.search)
          return json({ error: "Not found." }, 404);
        keyOperation = match[2];
        const body = object(
          await boundedJson(
            new Response(request.body, { headers: request.headers }),
            40_000,
          ),
          ["case", "value"],
        );
        const currentProfile = await profile(env);
        const timing = keyTimings();
        const requestNative = nativeSupportRequest(
          request,
          match[1] as NativeChannel,
          fetcher,
        );
        const native = <T>(path: string, body?: object) =>
          timing.time("native-case", () => requestNative<T>(path, body));
        // Refuse an unauthenticated caller before opening the key vault.
        phase = "native-authorization";
        await nativeEnrollment(native, parseCase(body.case), currentProfile);
        phase = "vault-load";
        const [backup, backupWrappingKey, authorityWrappingKey] = await Promise.all([
          timing.time("r2-read", async () => {
            const encrypted = await env.AUTHORITY.get("own-keys/backup-v1.json");
            if (!encrypted || encrypted.size > 16_384) throw new EncryptionProtocolError();
            return JSON.parse(await encrypted.text()) as CustomerKeyBackup;
          }),
          wrappingKey(env.KEY_BACKUP_WRAPPING_KEY),
          wrappingKey(env.AUTHORITY_WRAPPING_KEY),
        ]);
        const store = r2AuthorityStore(env.AUTHORITY);
        phase = "vault-restore";
        const { keys, journal, snapshot } = await timing.time("key-restore", () => restoreOwnVault({
          profile: currentProfile,
          backup,
          backupWrappingKey,
          authorityWrappingKey,
          store: {
            read: () => timing.time("r2-read", () => store.read()),
            replace: (bytes, etag) => timing.time("r2-commit", () => store.replace(bytes, etag)),
          },
          native: {
            read: () => timing.time("checkpoint", () => env.NATIVE_AUTHORITY.read()),
            advance: value => timing.time("checkpoint", () => env.NATIVE_AUTHORITY.advance(value)),
            revokeDevice: value => timing.time("checkpoint", () => env.NATIVE_AUTHORITY.revokeDevice(value)),
          },
        }));
        const response = json(
          await ownOperation({
            operation: match[2] as OwnOperation,
            body,
            profile: currentProfile,
            keys,
            journal,
            restoredSnapshot: snapshot,
            native,
            phase: value => {phase = value;},
            ...(env.AI_ENCRYPTION_KEY && env.AI_SIGNING_KEY ? {approvedAi: {
              encryptionKey: env.AI_ENCRYPTION_KEY, signingKey: env.AI_SIGNING_KEY,
            }} : {}),
            ...(env.AI_VERIFIER_KEY ? {aiVerifierKey: env.AI_VERIFIER_KEY} : {}),
          }),
        );
        response.headers.set("Server-Timing", timing.header());
        return response;
      } catch (error) {
        // No exception text, bodies, credentials, device IDs or plaintext in
        // logs or error responses. Recognized content refusals stay useful.
        if (error instanceof CustomerContentRefusal)
          return json({ error: error.message, reason: error.reason }, 400);
        if (error instanceof OwnDeviceApprovalRequired)
          return json({error: error.message, reason: "device-approval-required"}, 403);
        if (keyOperation) console.error(JSON.stringify(ownKeyFailure(keyOperation, phase, error)));
        return json(
          {
            error:
              "Encrypted support is unavailable. Your draft stays on this device.",
            reason: "encryption-unavailable",
          },
          503,
        );
      }
    },
  };
}
export default secureSupportWorker();
