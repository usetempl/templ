import { expect } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { base58Encode } from "@templ/chat/solana";
import { encodeWidgetSolanaSignature } from "@templ/chat/widget-wallet";
import { NONCE_COOKIE, SESSION_COOKIE } from "../src/common";

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
export const { build } = runtimeRequire("esbuild");
export type Actor = { principalId: string; cookie: string; ip: string };
export function uuid(at = Date.now()) {
  const random = crypto.randomUUID();
  const time = at.toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}
export async function data<T = Record<string, any>>(
  response: Response,
  status = 200,
) {
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result as T;
}
function cookie(response: Response, name: string) {
  const value = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${name}=`));
  expect(value).toBeTruthy();
  return value!.split(";")[0];
}

/** Headers `apps/web/public/_headers` gives `path`, read from the file so the
 * tests serve what production serves. A block's pattern ends in `*` or
 * matches the path exactly. */
function publishedHeaders(headersFile: string, path: string) {
  const headers: Record<string, string> = {};
  let matched = false;
  for (const line of headersFile.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      matched = pattern.endsWith("*")
        ? path.startsWith(pattern.slice(0, -1))
        : path === pattern;
      continue;
    }
    if (!matched) continue;
    const at = line.indexOf(":");
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** The public widget as templ.vip serves it: `/support-widget.js`, every
 * versioned build `/support-widget/<id>.js` and the chunks a build loads
 * beside it (`/support-widget/<name>-<id>.js`), with the production headers.
 * Any other request goes to `fallback` (normally the harness worker). A
 * missing file is a 404, as it would be on the host. */
export function widgetAssetFetcher(
  readSource: (path: string) => string,
  fallback: typeof fetch,
  origin = "https://templ.vip",
): typeof fetch {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assetPath = new RegExp(
    `^${escaped}(/support-widget(?:/(?:[a-z]+-)?[0-9a-f]{16})?\\.js)$`,
  );
  const headersFile = readSource("apps/web/public/_headers");
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const asset = assetPath.exec(url)?.[1];
    if (!asset) return fallback(input, init);
    let body: string;
    try {
      body = readSource(`apps/web/public${asset}`);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    return new Response(body, {
      headers: publishedHeaders(headersFile, asset),
    });
  }) as typeof fetch;
}

/** Production Workerd entry, persisted SQLite objects, and real SIWS accounts.
 * Optional entry source is for explicit historical/verified-ledger fixtures in
 * a subclass constructor; test fetch handlers and session overrides aren't used.
 * Full historical snapshots name source roots so missing blobs cannot fall
 * through to current modules. An explicit empty restart selects current code. */
export async function workerdHarness(
  entrySource: string,
  sourceOverrides: Record<string, string> = {},
  recordedSourceRoots: readonly string[] = [],
) {
  if (recordedSourceRoots.length && !Object.keys(sourceOverrides).length)
    throw new Error("Historical runtime source was not recorded: empty snapshot");
  const compile = (overrides = sourceOverrides) => build({
    stdin: {
      resolveDir: resolve(import.meta.dirname, "../src"),
      contents:
        (/export\s*\{[^}]*\bSupportPartition\b/.test(entrySource)
          ? entrySource
          : entrySource + '\nexport { SupportPartition } from "./worker";\n') +
        '\nexport { ProductPaymentLedger, ProductPaymentScanner } from "./worker";\n',
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
    write: false,
    logLevel: "silent",
    plugins: Object.keys(overrides).length
      ? [
          {
            name: "recorded-production-source",
            setup(builder: any) {
              // A full historical snapshot may contain files removed from the
              // current checkout. Resolve those exact blobs without reading a
              // replacement module from the current source tree.
              builder.onResolve({ filter: /^\./ }, (args: { path: string; resolveDir: string }) => {
                if (!recordedSourceRoots.length) return undefined;
                const path = resolve(args.resolveDir, args.path);
                const recorded = [path, `${path}.ts`, `${path}.mjs`, `${path}.json`, resolve(path, "index.ts"), resolve(path, "index.mjs")]
                  .find((candidate) => Object.hasOwn(overrides, candidate));
                return recorded ? { path: recorded } : undefined;
              });
              builder.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, (args: { path: string }) => {
                const contents = overrides[args.path];
                if (contents === undefined && recordedSourceRoots.some((root) => args.path.startsWith(root + sep)))
                  throw new Error(`Historical runtime source was not recorded: ${args.path}`);
                return contents === undefined
                  ? undefined
                  : { contents, loader: args.path.endsWith(".json") ? "json" : /\.[cm]?ts$/.test(args.path) ? "ts" : "js" };
              });
            },
          },
        ]
      : [],
  });
  let bundle = await compile();
  const persistence = mkdtempSync(resolve(tmpdir(), "templ-workerd-"));
  const options = {
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-04-26",
    compatibilityFlags: ["nodejs_compat"],
    durableObjectsPersist: persistence,
    r2Buckets: ["MEDIA_BUCKET"],
    outboundService: undefined as
      | undefined
      | ((request: Request) => Promise<Response>),
    durableObjects: Object.fromEntries(
      [
        ["ROOMS", "CommunityRoom"],
        ["AUTH_RECORDS", "AuthRecord"],
        ["ROOM_SUBSCRIPTIONS", "SubscriptionList"],
        ["MEDIA_QUOTAS", "MediaQuota"],
        ["SAFETY_STORE", "SafetyStore"],
        ["FEEDBACK_STORE", "FeedbackStore"],
        ["SUPPORT_PARTITIONS", "SupportPartition"],
        ["PRODUCT_PAYMENT_LEDGER", "ProductPaymentLedger"],
        ["PRODUCT_PAYMENT_SCANNERS", "ProductPaymentScanner"],
        // Bound only when the entry exports the operator metrics object.
        ...(/\bCostMetrics\b/.test(entrySource)
          ? [["COST_METRICS", "CostMetrics"]]
          : []),
        // Bound only when the entry exports the workspace knowledge object.
        ...(/\bSupportKnowledge\b/.test(entrySource)
          ? [["SUPPORT_KNOWLEDGE", "SupportKnowledge"]]
          : []),
      ].map(([name, className]) => [name, { className, useSQLite: true }]),
    ),
    bindings: {
      APP_ORIGIN: "https://templ.vip",
      RELEASED_FEATURES: "[]",
      SUPPORT_WIDGET_SOLANA_ENABLED: "true",
      SUPPORT_AI_DRAFTS_ENABLED: "true",
      SUPPORT_QUALITY_ENABLED: "true",
      SUPPORT_PROTOCOL_PROFILE_ENABLED: "true",
      AGENT_API_ENABLED: "true",
      SUPPORT_WIDGET_FRAME_ENABLED: "true",
      CONVERSATIONS_ENABLED: "true",
      MEDIA_BUDGET_SHARDS: "64",
      MEDIA_SHARD_KEY: "11".repeat(32),
      CLIENT_DIGEST_KEY: "22".repeat(32),
    } as Record<string, unknown>,
    ratelimits: {
      AUTH_RATE_LIMITER: {
        namespace_id: "1001",
        simple: { limit: 20, period: 60 },
      },
      CHAT_READ_RATE_LIMITER: {
        namespace_id: "1002",
        simple: { limit: 360, period: 60 },
      },
      CHAT_RATE_LIMITER: {
        namespace_id: "1003",
        simple: { limit: 600, period: 60 },
      },
      MEDIA_RATE_LIMITER: {
        namespace_id: "1004",
        simple: { limit: 3, period: 60 },
      },
    },
  };
  const start = () =>
    new Miniflare({
      ...convertV4MiniflareOptions(options),
      // Miniflare 5 uses one persistence root for Durable Objects and R2.
      // The v4 compatibility converter intentionally does not infer it from
      // the former per-plugin option.
      resourcePersistencePath: persistence,
    });
  let runtime = start();
  // Workerd starts before the caller's first test, which would otherwise
  // spend its time on a slow runner's process startup.
  await runtime.ready;
  let nextIp = 10;
  const accountKeys = new Map<string, CryptoKeyPair>();
  async function call(
    path: string,
    actor?: Actor,
    body?: object,
    extraHeaders?: Record<string, string>,
  ) {
    return runtime.dispatchFetch(`https://community.templ.vip${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: String(options.bindings.APP_ORIGIN),
        "Content-Type": "application/json",
        "CF-Connecting-IP": actor?.ip ?? "198.51.100.1",
        ...(actor ? { Cookie: actor.cookie } : {}),
        ...extraHeaders,
      },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify({
              expectedPrincipalId: actor?.principalId,
              ...body,
            }),
          }),
    }) as Promise<Response>;
  }
  return {
    call,
    authRateLimitPeriodMs:
      options.ratelimits.AUTH_RATE_LIMITER.simple.period * 1_000,
    get authRateLimit() {
      return { ...options.ratelimits.AUTH_RATE_LIMITER.simple };
    },
    /** SDK requests retain their real request body, headers and session cookies. */
    fetch: ((input, init) =>
      runtime.dispatchFetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          "CF-Connecting-IP": "198.51.100.200",
        },
      })) as typeof fetch,
    /** The same as `fetch`, sent from the client address `ip()` returns. */
    fetchFrom(ip: () => string) {
      return ((input, init) =>
        runtime.dispatchFetch(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            "CF-Connecting-IP": ip(),
          },
      })) as typeof fetch;
    },
    /** Models a full auth window passing in a local paced trial. A fresh
     * test-only limiter namespace preserves the client IP, daily quotas,
     * sessions and persisted objects. Hosted trials wait the real minute. */
    async advanceAuthWindow() {
      options.ratelimits.AUTH_RATE_LIMITER.namespace_id = String(
        Number(options.ratelimits.AUTH_RATE_LIMITER.namespace_id) + 10_000,
      );
      await runtime.setOptions({
        ...convertV4MiniflareOptions(options),
        resourcePersistencePath: persistence,
      });
      await runtime.ready;
    },
    get sourceDigest() {
      return createHash("sha256").update(bundle.outputFiles[0].text).digest("hex");
    },
    async walletAddress(actor: Actor) {
      const keys = accountKeys.get(actor.principalId);
      if (!keys) throw new Error("Sign in with a wallet first.");
      return base58Encode(
        new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
      );
    },
    async signIn(existing?: Actor, ip?: string): Promise<Actor> {
      const keys = existing
        ? accountKeys.get(existing.principalId)!
        : await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
            "sign",
            "verify",
          ]);
      const address = base58Encode(
        new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
      );
      const pending = {
        principalId: "",
        cookie: "",
        ip: ip ?? `198.51.100.${nextIp++}`,
      };
      const challenge = await call("/auth/solana/nonce", pending, { address });
      const { message } = await data(challenge);
      pending.cookie = cookie(challenge, NONCE_COOKIE);
      const signature = encodeWidgetSolanaSignature(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            keys.privateKey,
            new TextEncoder().encode(message),
          ),
        ),
      );
      const response = await call("/auth/solana/verify", pending, {
        message,
        signature,
      });
      const session = await data(response);
      expect(session.principalId).toMatch(/^account:/);
      if (existing) expect(session.principalId).toBe(existing.principalId);
      accountKeys.set(session.principalId, keys);
      return {
        ...pending,
        principalId: session.principalId,
        cookie: cookie(response, SESSION_COOKIE),
      };
    },
    /** Signs the account's own SIWS proof for this workspace and origin. */
    async widgetSession(actor: Actor, workspace: string, origin: string) {
      const keys = accountKeys.get(actor.principalId);
      if (!keys)
        throw new Error("The widget member must have a signed-in account.");
      const address = base58Encode(
        new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
      );
      const headers = { Origin: origin, "CF-Connecting-IP": actor.ip };
      const challenge = await data(
        await call(
          `/widget/${workspace}/auth/nonce`,
          undefined,
          {
            network: "solana",
            address,
          },
          headers,
        ),
      );
      const signature = encodeWidgetSolanaSignature(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            keys.privateKey,
            new TextEncoder().encode(challenge.message),
          ),
        ),
      );
      const session = await data(
        await call(
          `/widget/${workspace}/auth/verify`,
          undefined,
          {
            nonce: challenge.nonce,
            message: challenge.message,
            signature,
          },
          headers,
        ),
      );
      expect(session.principalId).toBe(actor.principalId);
      return {
        call: (path: string, body?: object) =>
          call(
            `/widget/${workspace}${path}`,
            undefined,
            body === undefined
              ? undefined
              : { expectedPrincipalId: actor.principalId, ...body },
            { ...headers, Authorization: `Bearer ${session.token}` },
          ),
      };
    },
    /** A fresh app account with the interface the hosted trials give their
     * actors (`login()`, then `request(path, body?)` answering
     * `{ status, data, retryAfterSeconds }`), signed in from its own client
     * address. */
    trialActor() {
      let account: Actor | undefined;
      let needsFreshLogin = false;
      const actor = {
        principalId: null as string | null,
        login: async () => {
          if (!account || needsFreshLogin) {
            account = await this.signIn(account, account?.ip);
            needsFreshLogin = false;
          }
          actor.principalId = account.principalId;
        },
        request: async (path: string, body?: object) => {
          const response = await call(path, account, body);
          if (
            path === "/auth/logout" &&
            body !== undefined &&
            response.status === 200
          )
            needsFreshLogin = true;
          const text = await response.text();
          const retryAfter = Number(response.headers.get("Retry-After"));
          return {
            status: response.status,
            data: text ? JSON.parse(text) : null,
            retryAfterSeconds: retryAfter > 0 ? retryAfter : null,
          };
        },
        widget: async (room: string, origin: string) => {
          await actor.login();
          const match = /^\/rooms\/([0-9a-f-]+)$/.exec(room);
          if (!match)
            throw new Error("The widget requires a workspace room path.");
          const session = await this.widgetSession(account!, match[1], origin);
          return {
            request: async (path: string, body?: object) => {
              if (!path.startsWith(`${room}/`))
                throw new Error(
                  "The widget request must stay in its workspace.",
                );
              const response = await session.call(
                path.slice(room.length),
                body,
              );
              const text = await response.text();
              const retryAfter = Number(response.headers.get("Retry-After"));
              return {
                status: response.status,
                data: text ? JSON.parse(text) : null,
                retryAfterSeconds: retryAfter > 0 ? retryAfter : null,
              };
            },
          };
        },
      };
      return actor;
    },
    async objectId(roomId: string) {
      const namespace = await runtime.getDurableObjectNamespace("ROOMS");
      return namespace.idFromName(`native-room:${roomId}`).toString();
    },
    /** Test-only direct access to the real object's private binding API. This
     * never exposes these paths through the public worker or bypasses its ACL. */
    async objectRequest(
      name: string,
      path: string,
      body?: object,
      headers: Record<string, string> = {},
    ) {
      const namespace = await runtime.getDurableObjectNamespace("ROOMS");
      return namespace
        .get(namespace.idFromName(name))
        .fetch(`https://internal${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }) as Promise<Response>;
    },
    /** Runs the entry's scheduled handler once, as the cron trigger would. */
    async scheduled(cron: string, scheduledTime: number) {
      return (await runtime.getWorker()).scheduled({
        cron,
        scheduledTime: new Date(scheduledTime),
      });
    },
    async restart(
      bindings: Record<string, unknown>,
      outboundService?: (request: Request) => Promise<Response>,
      recordedSources?: Record<string, string>,
    ) {
      if (recordedSources) {
        bundle = await compile(recordedSources);
        options.script = bundle.outputFiles[0].text;
      }
      for (const [name, value] of Object.entries(bindings)) {
        if (value === undefined) delete options.bindings[name];
        else options.bindings[name] = value;
      }
      if (options.bindings.APP_ORIGIN === "https://usetempl.com") {
        const auth =
          /name = "AUTH_RATE_LIMITER"\s+namespace_id = "\d+"\s+\[env\.production\.ratelimits\.simple\]\s+limit = (\d+)\s+period = (\d+)/.exec(
            readFileSync(
              resolve(import.meta.dirname, "../wrangler.production.toml"),
              "utf8",
            ),
          );
        expect(auth).not.toBeNull();
        options.ratelimits.AUTH_RATE_LIMITER.simple = {
          limit: Number(auth![1]),
          period: Number(auth![2]),
        };
      } else {
        options.ratelimits.AUTH_RATE_LIMITER.simple = { limit: 20, period: 60 };
      }
      if (outboundService) options.outboundService = outboundService;
      await runtime.dispose();
      runtime = start();
      await runtime.ready;
    },
    async dispose() {
      await runtime.dispose();
      rmSync(persistence, { recursive: true, force: true });
    },
  };
}
