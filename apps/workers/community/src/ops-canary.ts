import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { DEFAULT_CHAT_AUTH_CHAIN_ID } from "@templ/chat/chains";
import { WIDGET_SIGN_IN_STATEMENT } from "@templ/chat/widget-wallet";
import { NONCE_TTL, siteOrigins } from "./common";
import { canaryOrigin } from "./support-canary";
import { uuidv7 } from "./uuidv7";
import {
  alertHookState,
  healthStatus,
  inspectSupportHealth,
  opsCall,
  readRoomHealth,
  type AlertOutcome,
  type CanaryKind,
  type CanaryReport,
  type CanarySetup,
  type CanaryStage,
  type HealthDeps,
  type HealthInspection,
  type OpsHealthEnv,
} from "./ops-health";

/** The widget's sign-in statement, shared with `support-widget.ts`. The
 * canary signs a challenge only when it carries exactly this text. */
export const CANARY_STATEMENT = WIDGET_SIGN_IN_STATEMENT;
const HOUR = 3_600_000;
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const THREAD = /^tc-[0-9a-f]{32}$/;

export type CanaryDeps = Pick<HealthDeps, "verifiedChain"> & {
  /** The worker's own inner fetch: no funnel or cost observation. */
  fetch: (request: Request) => Promise<Response>;
  scheduledTime: number;
  /** Outbound request to the heartbeat; the global fetch by default. */
  heartbeat?: (url: string, init: RequestInit) => Promise<Response>;
};

/** The first run of each UTC hour signs in and writes; the others only read. */
export function canaryKind(scheduledTime: number): CanaryKind {
  return new Date(scheduledTime).getUTCMinutes() < 5 ? "full" : "light";
}

/** True only for the widget's own sign-in text for this canary: domain,
 * URI, default chain, nonce, statement and workspace resource exactly as
 * expected for the Worker's own app origin, expiring within five minutes,
 * with no other field. */
export function validateCanaryChallenge(
  message: unknown,
  expected: {
    address: string;
    workspace: string;
    nonce: string;
    /** The app origin (`canaryOrigin(env)`). */
    origin: string;
    now?: number;
  },
): boolean {
  if (typeof message !== "string" || message.length > 4096) return false;
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    return false;
  }
  const now = expected.now ?? Date.now();
  const expires = parsed.expirationTime?.getTime() ?? Number.NaN;
  const issued = parsed.issuedAt?.getTime() ?? Number.NaN;
  let origin: URL;
  try {
    origin = new URL(expected.origin);
  } catch {
    return false;
  }
  if (
    parsed.scheme !== "https" ||
    parsed.domain !== origin.host ||
    parsed.uri !== origin.origin ||
    parsed.version !== "1" ||
    parsed.chainId !== DEFAULT_CHAT_AUTH_CHAIN_ID ||
    parsed.nonce !== expected.nonce ||
    parsed.statement !== CANARY_STATEMENT ||
    parsed.address?.toLowerCase() !== expected.address ||
    parsed.resources?.length !== 1 ||
    parsed.resources[0] !== `${origin.origin}/rooms/${expected.workspace}` ||
    parsed.notBefore !== undefined ||
    parsed.requestId !== undefined ||
    !(expires > now) ||
    expires > now + NONCE_TTL + 5_000 ||
    !(issued <= now + 60_000) ||
    issued < now - NONCE_TTL
  )
    return false;
  // Nothing may hide outside the parsed fields.
  try {
    return (
      createSiweMessage(parsed as Parameters<typeof createSiweMessage>[0]) ===
      message
    );
  } catch {
    return false;
  }
}

class CanaryStop extends Error {
  constructor(
    readonly stage: CanaryStage,
    readonly status: number,
    readonly setup?: CanarySetup,
  ) {
    super(stage);
  }
}
type Reply = { status: number; headers: Headers; body: unknown };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function widgetClient(
  deps: CanaryDeps,
  site: { appOrigin: string; communityOrigin: string },
  workspace: string,
) {
  let token: string | null = null;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    const headers = new Headers({ Origin: site.appOrigin });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await deps.fetch(
      new Request(`${site.communityOrigin}/widget/${workspace}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    let parsed: unknown = null;
    if (
      (response.headers.get("Content-Type") ?? "").includes("application/json")
    )
      parsed = await response.json().catch(() => null);
    else await response.body?.cancel();
    return { status: response.status, headers: response.headers, body: parsed };
  };
  return {
    call,
    /** Sends and turns a missing answer or an unexpected status into a stop
     * at `stage`. */
    async expect(
      stage: CanaryStage,
      statuses: number[],
      method: string,
      path: string,
      body?: unknown,
    ) {
      let reply: Reply;
      try {
        reply = await call(method, path, body);
      } catch {
        throw new CanaryStop(stage, 0);
      }
      if (!statuses.includes(reply.status))
        throw new CanaryStop(stage, reply.status);
      return reply;
    },
    signIn(value: string | null) {
      token = value;
    },
    get signedIn() {
      return token !== null;
    },
  };
}

function canaryConfig(env: OpsHealthEnv) {
  const workspace = env.TEMPL_SUPPORT_WORKSPACE ?? "";
  const address = env.SUPPORT_CANARY_ACCOUNT ?? "";
  const key = env.SUPPORT_CANARY_KEY ?? "";
  if (
    !UUIDV7.test(workspace) ||
    !/^0x[0-9a-f]{40}$/.test(address) ||
    !/^0x[0-9a-fA-F]{64}$/.test(key)
  )
    return null;
  try {
    if (privateKeyToAccount(key as Hex).address.toLowerCase() !== address)
      return null;
  } catch {
    return null;
  }
  return { workspace, address, key: key as Hex };
}

async function check(
  env: OpsHealthEnv,
  deps: CanaryDeps,
  kind: CanaryKind,
  inspection: HealthInspection,
): Promise<CanaryReport> {
  if (!env.SUPPORT_CANARY_ACCOUNT) {
    // No canary: the heartbeat follows the probe alone.
    const ok =
      healthStatus({ ...inspection.body.checks, canary: "off" }) !== "down";
    return ok
      ? { kind, ok, setup: "off" }
      : { kind, ok, stage: "probe", status: 0, setup: "off" };
  }
  const config = canaryConfig(env);
  if (!config)
    return {
      kind,
      ok: false,
      stage: "config",
      status: 0,
      setup: "misconfigured",
    };
  // Only report setup after checking it. The ops transaction preserves the
  // current value when this run has no new listing or configuration result.
  let setup: CanarySetup | undefined;
  if (inspection.body.checks.storage === "failed")
    return { kind, ok: false, stage: "probe", status: 0 };
  const site = siteOrigins(env);
  const client = widgetClient(deps, site, config.workspace);
  let stage: CanaryStage = "preflight";
  try {
    const preflight = await client.expect(
      "preflight",
      [204],
      "OPTIONS",
      "/conversations/status",
    );
    if (preflight.headers.get("Access-Control-Allow-Origin") !== site.appOrigin)
      throw new CanaryStop("preflight", preflight.status);
    stage = "policy";
    await client.expect("policy", [200], "GET", "/auth/policy");
    stage = "room-health";
    if (!["active", "full"].includes(inspection.body.checks.templSupport))
      throw new CanaryStop("room-health", 0);
    if (kind === "light") return { kind, ok: true };

    stage = "nonce";
    const issued = record(
      (
        await client.expect("nonce", [200], "POST", "/auth/nonce", {
          address: config.address,
          chainId: DEFAULT_CHAT_AUTH_CHAIN_ID,
        })
      ).body,
    );
    stage = "challenge";
    const message = issued.message;
    if (
      typeof issued.nonce !== "string" ||
      typeof message !== "string" ||
      !validateCanaryChallenge(message, {
        address: config.address,
        workspace: config.workspace,
        nonce: issued.nonce,
        origin: site.appOrigin,
        now: Date.now(),
      })
    )
      throw new CanaryStop("challenge", 0);
    stage = "verify";
    const signature = await privateKeyToAccount(config.key).signMessage({
      message,
    });
    const verified = await client.expect(
      "verify",
      [200],
      "POST",
      "/auth/verify",
      {
        message,
        signature,
        nonce: issued.nonce,
      },
    );
    const session = record(verified.body);
    if (
      typeof session.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(session.token)
    )
      throw new CanaryStop("verify", verified.status);
    client.signIn(session.token);
    try {
      // A wallet that resolves to another account is not this canary.
      if (session.principalId !== config.address)
        throw new CanaryStop("verify", verified.status, "misconfigured");
      stage = "room-health";
      const health = await readRoomHealth(
        env,
        config.workspace,
        config.address,
      );
      if (
        !health.room ||
        health.room.workspace !== "found" ||
        health.room.product !== "active"
      )
        throw new CanaryStop("room-health", health.status);
      if (!health.room.canaryListed) {
        // Membership only, never a request: no message is written until a
        // manager lists the canary as a test account.
        setup = "needs-listing";
        stage = "join";
        await client.expect("join", [200], "POST", "/conversations/join", {});
      } else {
        stage = "status";
        const status = record(
          (await client.expect("status", [200], "GET", "/conversations/status"))
            .body,
        );
        const mine =
          typeof status.mine === "string" && THREAD.test(status.mine)
            ? status.mine
            : null;
        stage = "write";
        const clientId = uuidv7(Date.now());
        const hour = new Date(
          Math.floor(deps.scheduledTime / HOUR) * HOUR,
        ).toISOString();
        const text = `Templ canary check ${hour}`;
        const send = () =>
          client
            .call(
              "POST",
              mine ? `/conversations/${mine}/messages` : "/conversations/ask",
              { text, clientId },
            )
            .catch(() => null);
        let written = await send();
        // One retry with the same message id; the room keeps one copy.
        if (!written || written.status >= 500) written = await send();
        if (!written || written.status < 200 || written.status >= 300)
          throw new CanaryStop("write", written?.status ?? 0);
        const thread = mine ?? record(record(written.body).conversation).id;
        if (typeof thread !== "string" || !THREAD.test(thread))
          throw new CanaryStop("write", written.status);
        stage = "read-back";
        const page = record(
          (
            await client.expect(
              "read-back",
              [200],
              "GET",
              `/conversations/${thread}/messages?limit=5`,
            )
          ).body,
        );
        const now = Date.now();
        const found =
          Array.isArray(page.messages) &&
          page.messages.some((entry) => {
            const message = record(entry);
            const at =
              typeof message.createdAt === "string"
                ? Date.parse(message.createdAt)
                : Number.NaN;
            return (
              message.clientId === clientId && Math.abs(now - at) <= 120_000
            );
          });
        if (!found) throw new CanaryStop("read-back", 200);
        setup = "ok";
      }
      stage = "logout";
      await client.expect("logout", [200], "POST", "/auth/logout");
      client.signIn(null);
      return { kind, ok: true, setup };
    } finally {
      // Never leave a canary session behind after a failure.
      if (client.signedIn)
        await client.call("POST", "/auth/logout").catch(() => undefined);
    }
  } catch (error) {
    const stop = error instanceof CanaryStop ? error : new CanaryStop(stage, 0);
    return {
      kind,
      ok: false,
      stage: stop.stage,
      status: stop.status,
      ...((stop.setup ?? setup) === undefined
        ? {}
        : { setup: stop.setup ?? setup }),
    };
  }
}

/** Posts the Better Stack heartbeat. The address is checked against the
 * heartbeat pattern first and is never logged, stored or returned. */
export async function sendHeartbeat(
  env: Pick<OpsHealthEnv, "OPS_HEARTBEAT_URL">,
  notify: "success" | "fail",
  report: CanaryReport,
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init),
): Promise<AlertOutcome> {
  const hook = alertHookState(env);
  if (hook !== "configured") return hook;
  const url = env.OPS_HEARTBEAT_URL!;
  try {
    const response = await send(notify === "success" ? url : `${url}/fail`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      ...(notify === "fail"
        ? {
            headers: { "Content-Type": "text/plain" },
            body: `${report.kind}:${report.stage}:${report.status}`,
          }
        : {}),
    });
    await response.body?.cancel();
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** One scheduled run, on the Worker's own origin. It never throws: every
 * outcome is recorded in the ops object, and the heartbeat follows its
 * decision. An unknown origin records nothing and sends no heartbeat. */
export async function runSupportCanary(
  env: OpsHealthEnv,
  deps: CanaryDeps,
): Promise<CanaryReport | null> {
  try {
    // Throws for an unknown origin: caught below, nothing recorded.
    canaryOrigin(env);
    const kind = canaryKind(deps.scheduledTime);
    const inspection = await inspectSupportHealth(env, deps, Date.now());
    const report = await check(env, deps, kind, inspection);
    const answer = await opsCall<{ notify?: unknown }>(
      env,
      "/ops/canary",
      report,
      2_000,
    );
    const notify =
      answer?.notify === "success" || answer?.notify === "fail"
        ? answer.notify
        : null;
    if (notify) {
      const outcome = await sendHeartbeat(env, notify, report, deps.heartbeat);
      // Only a failure alert is recorded; success pings show in Better Stack.
      if (notify === "fail")
        await opsCall(env, "/ops/alert", { outcome }, 2_000);
    }
    return report;
  } catch {
    return null;
  }
}
