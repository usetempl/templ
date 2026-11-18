import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
import { normalizeChatPrincipal, type ChatPrincipalId } from "@templ/chat/principal";
import type { ChatViewer } from "@templ/chat/index";
import { SUPPORT_LIMITS } from "@templ/chat/support";
import { HttpError, json } from "./common";
import { wakeRoomAt } from "./room-alarm";
import { AWAITING_PREFIX } from "./support-cases";
import {
  currentStaffRoleIds,
  templStaffAccount,
  type TemplStaffEnv,
} from "./templ-staff";

/** Text-free push alerts for staff who installed the inbox.
 *
 * A push carries no payload at all: no message text, no member, no
 * workspace name and no request id. The push service learns only that
 * something happened. The service worker (`apps/web/public/inbox-sw.js`)
 * shows a fixed line and opens the workspace it was registered for, where
 * sign-in and current access decide what the person sees.
 *
 * - Staff subscribe per workspace (`POST /conversations/push`); a widget
 *   session never reaches the route and a member without team access gets
 *   404. Only the endpoint URL is kept (a payload-free push needs no
 *   encryption keys), under each of the viewer's principals that is staff.
 * - The support notification outbox queues one job per recipient
 *   (`queueStaffPush`); the room alarm sends at most one push per recipient
 *   per minute, after checking again that the recipient is still staff.
 * - A new request the AI agent is answering alerts no one yet. Its job waits
 *   until the AI reply window ends and is sent only if the request is still
 *   waiting then without a handoff (a handoff sends its own alert).
 * - Removed staff lose their subscriptions at the next send and at the
 *   daily sweep, so a device stops getting alerts within a day of removal.
 * - Off unless `SUPPORT_PUSH_ENABLED = "true"` with a well-formed VAPID pair
 *   (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`); while off, queued jobs are
 *   dropped and nothing is sent. */

export type StaffPushEnv = WorkspaceFlagEnv & TemplStaffEnv & {
  SUPPORT_PUSH_ENABLED?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  APP_ORIGIN?: string;
};
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;

export const STAFF_PUSH_LIMITS = Object.freeze({
  subscriptionsPerPrincipal: 5,
  subscriptionsPerRoom: 500,
  jobsPerRun: 10,
  cooldownMs: 60_000,
  ttlSeconds: 3_600,
  timeoutMs: 10_000,
  endpointMaxLength: 1_024,
});
const SUB = "staff-push-sub-v1:";
const JOB = "staff-push-job-v1:";
const LAST = "staff-push-last-v1:";
const COUNT = "staff-push-count-v1";
/** `staff-push-wait-v1:<due pad 16>:<tc-id>:<principal>` → `{ since }`: a
 * request the AI agent is answering, due when its reply window ends. */
const WAIT = "staff-push-wait-v1:";
const WAIT_KEY = /^staff-push-wait-v1:([0-9]{16}):(tc-[0-9a-f]{32}):(.+)$/;
const SWEEP = "staff-push-sweep-v1";
const DAY = 86_400_000;
const pad16 = (value: number) => String(value).padStart(16, "0");

/** Push services that browsers use. An endpoint on any other host is
 * refused, so a subscription can't turn the worker into a request relay. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)?push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const text = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export type StaffPushConfig = {
  publicKey: string;
  jwk: JsonWebKey;
  subject: string;
};
/** The push configuration, or null while pushes are off or the key pair is
 * malformed. The public key is an uncompressed P-256 point (65 bytes, 0x04
 * first); the private key is the 32-byte scalar. */
export function staffPushConfig(env: StaffPushEnv): StaffPushConfig | null {
  if (!featureOn(env, undefined, "installableInbox")) return null;
  const origin = env.APP_ORIGIN ?? "";
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) return null;
  const publicKey = env.VAPID_PUBLIC_KEY ?? "";
  const point = fromBase64url(publicKey);
  const scalar = fromBase64url(env.VAPID_PRIVATE_KEY ?? "");
  if (!point || point.length !== 65 || point[0] !== 4) return null;
  if (!scalar || scalar.length !== 32) return null;
  return {
    publicKey,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: base64url(point.slice(1, 33)),
      y: base64url(point.slice(33)),
      d: base64url(scalar),
      ext: false,
    },
    subject: origin,
  };
}

/** A browser push endpoint on a known push service, or null. */
export function checkedPushEndpoint(value: unknown): URL | null {
  if (
    typeof value !== "string" ||
    value.length > STAFF_PUSH_LIMITS.endpointMaxLength
  )
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.length < 2 ||
    url.href !== value ||
    !PUSH_HOSTS.some((host) => host.test(url.hostname))
  )
    return null;
  return url;
}

async function endpointKey(endpoint: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const subPrefix = (principal: string) => `${SUB}${principal}:`;
type Subscription = { endpoint: string; createdAt: number };

/** The `Authorization` header of a VAPID request (RFC 8292): a 12-hour ES256
 * token for the push service's origin, and the public key. */
export async function vapidAuthorization(
  config: StaffPushConfig,
  endpoint: URL,
  now: number,
): Promise<string> {
  const encode = (value: unknown) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: endpoint.origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: config.subject,
  })}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    config.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(unsigned),
    ),
  );
  return `vapid t=${unsigned}.${base64url(signature)}, k=${config.publicKey}`;
}

/** The one push request: no body, so nothing about the request, the member
 * or the workspace leaves Templ. The Topic header collapses pushes that
 * wait at the push service. */
export async function pushRequest(
  config: StaffPushConfig,
  endpoint: URL,
  now: number,
): Promise<Request> {
  return new Request(endpoint.href, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: await vapidAuthorization(config, endpoint, now),
      TTL: String(STAFF_PUSH_LIMITS.ttlSeconds),
      Urgency: "high",
      Topic: "templ-inbox",
      "Content-Length": "0",
    },
  });
}

/** Whether a principal is support staff in this workspace right now: the
 * manager, or an enabled manual role with `handleConversations`. Billing,
 * assignments and display names confer nothing. */
export async function staffNow(
  storage: Pick<Storage, "get">,
  principal: string,
  env: TemplStaffEnv = {},
  now = Date.now(),
): Promise<boolean> {
  const id = normalizeChatPrincipal(principal);
  if (!id) return false;
  const native = await storage.get<{ room: { manager: string } }>(
    "native-room",
  );
  if (!native) return false;
  if (
    native.room.manager === id &&
    !(await templStaffAccount(storage, [id], env))
  )
    return true;
  const assigned = await currentStaffRoleIds(storage, id, env, now);
  if (!assigned.length) return false;
  const settings = await storage.get<{
    roles: {
      id: string;
      enabled?: boolean;
      moderationPermissions?: string[];
    }[];
  }>("chat-settings");
  const manual =
    (await storage.get<Record<string, { mode?: string; enabled?: boolean }>>(
      "native-manual-roles",
    )) ?? {};
  return assigned.some(
    (id) =>
      manual[id]?.mode === "manual" &&
      manual[id]?.enabled !== false &&
      (settings?.roles ?? []).some(
        (role) =>
          role.id === id &&
          role.enabled !== false &&
          role.moderationPermissions?.includes("handleConversations"),
      ),
  );
}

async function dropCount(storage: Storage, removed: number) {
  if (removed < 1) return;
  await storage.put(
    COUNT,
    Math.max(0, ((await storage.get<number>(COUNT)) ?? 0) - removed),
  );
}

async function removeSubscriptions(storage: Storage, principal: string) {
  await storage.delete(`${LAST}${principal}`);
  const keys = [
    ...(
      await storage.list({
        prefix: subPrefix(principal),
        limit: STAFF_PUSH_LIMITS.subscriptionsPerPrincipal * 2,
      })
    ).keys(),
  ];
  if (!keys.length) return;
  await storage.delete(keys);
  await dropCount(storage, keys.length);
}

export type StaffPushRouteContext = {
  method: string;
  pathname: string;
  body: Record<string, unknown>;
  viewer: Pick<ChatViewer, "principalId">;
  aliases: readonly ChatPrincipalId[];
  /** The viewer's team access (conversationAuthority(viewer).team). */
  team: boolean;
  env: StaffPushEnv;
  now: number;
};

/** `GET /conversations/push`: whether pushes work here, the VAPID public
 * key and whether this person has a subscription. `POST` with
 * `{ action: "subscribe" | "unsubscribe", endpoint }`. Team only; everyone
 * else gets 404, as for other team routes. */
export async function staffPushRoute(
  storage: Storage,
  context: StaffPushRouteContext,
): Promise<Response | null> {
  if (context.pathname !== "/conversations/push") return null;
  if (!context.team || !context.viewer.principalId)
    throw new HttpError(404, "Not found.");
  // The same rule the sender checks again before every push.
  const principals: string[] = [];
  for (const alias of context.aliases)
    if (await staffNow(storage, alias, context.env, context.now)) principals.push(alias);
  if (!principals.length) throw new HttpError(404, "Not found.");
  const config = staffPushConfig(context.env);
  if (context.method === "GET") {
    let subscribed = false;
    for (const principal of principals)
      if ((await storage.list({ prefix: subPrefix(principal), limit: 1 })).size)
        subscribed = true;
    return json({
      available: Boolean(config),
      publicKey: config?.publicKey ?? null,
      subscribed,
    });
  }
  if (context.method !== "POST") throw new HttpError(405, "Use GET or POST.");
  const action = context.body.action;
  if (action === "unsubscribe") {
    const endpoint = context.body.endpoint;
    if (endpoint === undefined)
      for (const principal of principals)
        await removeSubscriptions(storage, principal);
    else {
      const url = checkedPushEndpoint(endpoint);
      if (!url) throw new HttpError(400, "That isn't a push address.");
      const key = await endpointKey(url.href);
      for (const principal of principals) {
        const existing = `${subPrefix(principal)}${key}`;
        if (await storage.get(existing)) {
          await storage.delete(existing);
          await dropCount(storage, 1);
        }
      }
    }
    return json({ subscribed: false });
  }
  if (action !== "subscribe")
    throw new HttpError(400, "Choose subscribe or unsubscribe.");
  if (!config)
    throw Object.assign(
      new HttpError(503, "Push alerts are off for this service."),
      { reason: "push-unavailable" },
    );
  const url = checkedPushEndpoint(context.body.endpoint);
  if (!url) throw new HttpError(400, "That isn't a push address.");
  const key = await endpointKey(url.href);
  for (const principal of principals) {
    const own = await storage.list<Subscription>({
      prefix: subPrefix(principal),
      limit: STAFF_PUSH_LIMITS.subscriptionsPerPrincipal * 2,
    });
    const target = `${subPrefix(principal)}${key}`;
    if (own.has(target)) continue;
    let count = (await storage.get<number>(COUNT)) ?? 0;
    // A sixth browser replaces this person's oldest one.
    if (own.size >= STAFF_PUSH_LIMITS.subscriptionsPerPrincipal) {
      const oldest = [...own].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0][0];
      await storage.delete(oldest);
      count = Math.max(0, count - 1);
    }
    if (count >= STAFF_PUSH_LIMITS.subscriptionsPerRoom)
      throw new HttpError(
        409,
        "This workspace has too many alert subscriptions.",
      );
    await storage.put(target, {
      endpoint: url.href,
      createdAt: context.now,
    } satisfies Subscription);
    await storage.put(COUNT, count + 1);
  }
  return json({ subscribed: true });
}

/** A request the AI agent is answering: which thread and when its wait
 * started. Its alert waits for the end of the AI reply window. */
export type StaffPushHold = { thread: string; since: number };

/** Puts a send job unless one waits already; true when it put one. */
async function putJob(storage: Storage, recipient: string, now: number) {
  const job = `${JOB}${recipient}`;
  if (await storage.get(job)) return false;
  await storage.put(job, { createdAt: now });
  return true;
}

/** Queues a push for one staff recipient if they have a subscription. The
 * job holds only the time: which request changed is never stored in it.
 * `hold` is read only for a recipient with a subscription; when it says the
 * AI agent is answering the request, the push waits until the AI reply
 * window ends and goes out only if the request still needs a person then. */
export async function queueStaffPush(
  storage: Storage,
  recipient: string,
  now: number,
  readHold?: () => Promise<StaffPushHold | null>,
) {
  if (!(await storage.list({ prefix: subPrefix(recipient), limit: 1 })).size)
    return;
  const hold = readHold ? await readHold() : null;
  if (!hold) {
    if (await putJob(storage, recipient, now))
      await wakeRoomAt(storage, now + 1_000);
    return;
  }
  const due = Math.max(
    now + 1_000,
    hold.since + SUPPORT_LIMITS.aiReplyGraceMs + 1_000,
  );
  // The same wait keeps its start, so later messages reuse this key.
  await storage.put(`${WAIT}${pad16(due)}:${hold.thread}:${recipient}`, {
    since: hold.since,
  });
  await wakeRoomAt(storage, due);
}

/** Moves AI-window jobs that are due into the send queue when their request
 * still waits for a reply with no handoff open; the same run sends them.
 * Returns the next due time. */
async function releaseWaits(storage: Storage, now: number) {
  const waits = await storage.list<{ since?: number }>({
    prefix: WAIT,
    limit: STAFF_PUSH_LIMITS.jobsPerRun,
  });
  for (const [key, value] of waits) {
    const match = WAIT_KEY.exec(key);
    if (match && Number(match[1]) > now) return Number(match[1]);
    await storage.delete(key);
    if (!match || !Number.isSafeInteger(value?.since)) continue;
    // The AI agent or a person replied, or it was resolved: the row is gone.
    const row = await storage.get<{ handoff?: boolean }>(
      `${AWAITING_PREFIX}${pad16(value.since!)}:${match[2]}`,
    );
    if (row && row.handoff !== true) await putJob(storage, match[3], now);
  }
  return waits.size >= STAFF_PUSH_LIMITS.jobsPerRun ? now + 1_000 : null;
}

/** Once a day, drops the subscriptions of anyone who is no longer staff, so
 * a removed person's devices stop being kept. Returns the next sweep. */
async function sweepFormerStaff(storage: Storage, env: TemplStaffEnv, now: number) {
  const last = await storage.get<number>(SWEEP);
  if (last !== undefined && now - last < DAY) return last + DAY;
  const subscriptions = await storage.list({
    prefix: SUB,
    limit: STAFF_PUSH_LIMITS.subscriptionsPerRoom + 1,
  });
  if (!subscriptions.size) return null;
  // Keys end in ":" and a 32-character endpoint digest.
  const principals = new Set(
    [...subscriptions.keys()].map((key) => key.slice(SUB.length, -33)),
  );
  for (const principal of principals)
    if (!(await staffNow(storage, principal, env, now)))
      await removeSubscriptions(storage, principal);
  await storage.put(SWEEP, now);
  return now + DAY;
}

/** Room alarm consumer: sends queued pushes, at most `jobsPerRun` recipients
 * per run and one push per recipient per minute. Returns when it next
 * needs to run, or null. */
export async function staffPushAlarm(
  storage: Storage,
  env: StaffPushEnv,
  now: number,
  send: (request: Request) => Promise<Response> = (request) =>
    fetch(request, {
      signal: AbortSignal.timeout(STAFF_PUSH_LIMITS.timeoutMs),
    }),
): Promise<number | null> {
  let next = Math.min(
    (await releaseWaits(storage, now)) ?? Infinity,
    (await sweepFormerStaff(storage, env, now)) ?? Infinity,
  );
  const jobs = await storage.list<{ createdAt: number }>({
    prefix: JOB,
    limit: STAFF_PUSH_LIMITS.jobsPerRun,
  });
  const config = staffPushConfig(env);
  for (const [key] of jobs) {
    const recipient = key.slice(JOB.length);
    if (!config) {
      await storage.delete(key);
      continue;
    }
    if (!(await staffNow(storage, recipient, env, now))) {
      // Access ended: no push, and this browser's subscription goes too.
      await removeSubscriptions(storage, recipient);
      await storage.delete(key);
      continue;
    }
    const last = await storage.get<number>(`${LAST}${recipient}`);
    if (last !== undefined && now - last < STAFF_PUSH_LIMITS.cooldownMs) {
      next = Math.min(next, last + STAFF_PUSH_LIMITS.cooldownMs);
      continue;
    }
    const subscriptions = await storage.list<Subscription>({
      prefix: subPrefix(recipient),
      limit: STAFF_PUSH_LIMITS.subscriptionsPerPrincipal * 2,
    });
    for (const [subKey, subscription] of subscriptions) {
      const endpoint = checkedPushEndpoint(subscription.endpoint);
      if (!endpoint) {
        await storage.delete(subKey);
        await dropCount(storage, 1);
        continue;
      }
      try {
        const response = await send(await pushRequest(config, endpoint, now));
        await response.body?.cancel();
        // The browser dropped this subscription.
        if (response.status === 404 || response.status === 410) {
          await storage.delete(subKey);
          await dropCount(storage, 1);
        }
      } catch {
        // A push service that times out or refuses loses this alert only;
        // the inbox stays the source of truth.
      }
    }
    await storage.put(`${LAST}${recipient}`, now);
    await storage.delete(key);
  }
  if (jobs.size >= STAFF_PUSH_LIMITS.jobsPerRun)
    next = Math.min(next, now + 1_000);
  return next === Infinity ? null : next;
}
