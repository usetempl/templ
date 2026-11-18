import { admitFunnelRequest } from "./funnel-routes";
/** Reply email for signed members, from the widget to a Templ page:
 *
 * 1. In the widget, a signed member asks for a ticket
 *    (`POST /rooms/<id>/conversations/alert-ticket`, support-alerts.ts) and
 *    opens `https://<app>/alerts#t=<workspace>.<ticket>` in a new tab.
 * 2. The page posts the ticket here from the app origin. The room consumes
 *    it once and a 15-minute grant cookie is set. The grant reads no thread
 *    and is refused everywhere else: it can only set or verify the account's
 *    alert address and turn that one workspace's reply emails on or off.
 * 3. Each reply email carries a one-click unsubscribe link for that
 *    workspace (List-Unsubscribe). The room keeps only the token's hash.
 *
 * The address stays on the account. It is never shown to the team, and
 * never enters a team view, export, webhook, alert or audit entry. */
import { guestFollowUpPrivate } from "./guest-follow-up";
import { workspaceFeatureEnvFor } from "./workspace-flags";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import type { MemberAlertView } from "@templ/chat/support-alerts";
import { HttpError, json, readCookie, readJson, type Env } from "./common";
import { identityRequest } from "./account-identity";
import {
  emailChallengeCookieClear,
  maskEmail,
  startEmailLink,
  verifyEmailLink,
} from "./email-alerts";
import type { EmailEnv } from "./email-delivery";
import { sha256Hex } from "./alert-crypto";
import { GRANT_PREFIX, TICKET_OF_PREFIX, TICKET_PREFIX } from "./alert-outbox";
import {
  UNSUBSCRIBE_PREFIX,
  supportNotificationsConfigured,
} from "./support-notifications";

export const ALERT_GRANT_COOKIE = "__Host-templ_alert_grant";
export const GRANT_MS = 15 * 60_000;
const WORKSPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const expired = () =>
  new HttpError(
    401,
    "This link expired. Open the chat and choose Email me when the team replies again.",
    undefined,
    "alert-grant-expired",
  );

/* ---------------------------------------------------------------------- */
/* Room side: `/private/support/alerts/<op>`, reached only from the worker. */
/* ---------------------------------------------------------------------- */

type Room = { storage: DurableObjectStorage };
type Grant = { principal: ChatPrincipalId; expiresAt: number };
async function currentGrant(storage: Pick<DurableObjectTransaction, "get">, hash: unknown, now: number) {
  if (typeof hash !== "string" || !HASH.test(hash)) throw expired();
  const grant = await storage.get<Grant>(`${GRANT_PREFIX}${hash}`);
  // An expired grant is removed when the next ticket is redeemed.
  if (!grant || !normalizeChatPrincipal(grant.principal) || !(grant.expiresAt > now)) throw expired();
  return grant;
}
async function preference(storage: Pick<DurableObjectTransaction, "get">, principal: string) {
  return (await storage.get<{ enabled: boolean }>(`support-alert-preference-v1:${principal}`))?.enabled === true;
}

export async function memberAlertsPrivateRoute(state: Room, request: Request, env: Env): Promise<Response> {
  const op = new URL(request.url).pathname.slice("/private/support/alerts/".length);
  const body = await readJson(request, 1_024);
  const now = Date.now();
  try {
    return await state.storage.transaction(async (storage) => {
      const native = await storage.get<{ room?: { id?: string; name?: string } }>("native-room");
      if (!native?.room?.id) throw new HttpError(404, "Workspace not found.");
      const guest = await guestFollowUpPrivate(storage, op, body, now, env);
      if (guest) return guest;
      if (op === "redeem") {
        if (typeof body.ticketHash !== "string" || !HASH.test(body.ticketHash) || typeof body.grantHash !== "string" || !HASH.test(body.grantHash))
          throw expired();
        const key = `${TICKET_PREFIX}${body.ticketHash}`;
        const ticket = await storage.get<Grant>(key);
        // Single use: the ticket goes whether or not it was still good, so
        // the refusal is returned, never thrown (a throw would roll back).
        if (ticket) {
          await storage.delete(key);
          const pointer = `${TICKET_OF_PREFIX}${ticket.principal}`;
          if ((await storage.get(pointer)) === body.ticketHash) await storage.delete(pointer);
        }
        if (!ticket || !(ticket.expiresAt > now) || !normalizeChatPrincipal(ticket.principal)) {
          const error = expired();
          return json({ error: error.message, reason: error.reason }, error.status);
        }
        await storage.put(`${GRANT_PREFIX}${body.grantHash}`, {
          principal: ticket.principal,
          expiresAt: now + GRANT_MS,
        } satisfies Grant);
        // Old grants go as new ones come.
        const old = await storage.list<Grant>({ prefix: GRANT_PREFIX, limit: 50 });
        const stale = [...old].filter(([, grant]) => !(grant?.expiresAt > now)).map(([k]) => k);
        if (stale.length) await storage.delete(stale);
        return json({
          principal: ticket.principal,
          workspaceName: native.room.name ?? "",
          enabled: await preference(storage, ticket.principal),
        });
      }
      if (op === "grant") {
        const grant = await currentGrant(storage, body.grantHash, now);
        return json({
          principal: grant.principal,
          workspaceName: native.room.name ?? "",
          enabled: await preference(storage, grant.principal),
        });
      }
      if (op === "preference") {
        const grant = await currentGrant(storage, body.grantHash, now);
        if (typeof body.enabled !== "boolean") throw new HttpError(400, "Choose on or off.");
        await storage.put(`support-alert-preference-v1:${grant.principal}`, { enabled: body.enabled });
        return json({ enabled: body.enabled });
      }
      if (op === "unsubscribe") {
        // The same answer whether or not the token matched.
        if (typeof body.tokenHash === "string" && HASH.test(body.tokenHash)) {
          const entry = await storage.get<{ principal?: string }>(`${UNSUBSCRIBE_PREFIX}${body.tokenHash}`);
          const principal = normalizeChatPrincipal(entry?.principal);
          if (principal) {
            const account = await identityRequest(env, { op: "read", principalId: principal }).catch(() => {
              throw new HttpError(503, "Account details are temporarily unavailable.");
            });
            const canonical = normalizeChatPrincipal(account.principalId);
            if (!canonical || !Array.isArray(account.servicePrincipals) || account.servicePrincipals[0] !== canonical || !account.servicePrincipals.includes(principal))
              throw new HttpError(503, "Account details are temporarily unavailable.");
            await storage.put(`support-alert-preference-v1:${canonical}`, { enabled: false });
          }
        }
        return json({ ok: true });
      }
      throw new HttpError(404, "Not found.");
    });
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message, ...(error.reason ? { reason: error.reason } : {}) }, error.status);
    throw error;
  }
}

/* ---------------------------------------------------------------------- */
/* Worker edge: `/alerts/member/*` from the app origin, `/alerts/unsubscribe`. */
/* ---------------------------------------------------------------------- */

type MemberAlertEnv = Env & Partial<EmailEnv>;
async function memberAlertEnvFor(env: MemberAlertEnv, workspace: string) {
  const scoped = await workspaceFeatureEnvFor(env, workspace);
  if (!supportNotificationsConfigured(scoped)) throw new HttpError(404, "Not found.");
  return scoped;
}
async function room(env: MemberAlertEnv, workspace: string, op: string, body: Record<string, unknown>) {
  const response = await env.ROOMS.get(env.ROOMS.idFromName(`native-room:${workspace}`)).fetch(
    new Request(`https://internal/private/support/alerts/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new HttpError(
      response.status === 404 ? 401 : response.status,
      typeof data.error === "string" ? data.error : "This link expired.",
      undefined,
      typeof data.reason === "string" ? data.reason : undefined,
    );
  return data;
}
function requireAppOrigin(request: Request, env: MemberAlertEnv) {
  if (request.headers.get("Origin") !== env.APP_ORIGIN)
    throw new HttpError(403, "Use the Templ app to manage reply emails.");
}
async function limited(request: Request, env: MemberAlertEnv) {
  const limiter = env.AUTH_RATE_LIMITER;
  if (
    !limiter ||
    !(await limiter.limit({ key: `alerts:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` })).success
  )
    throw new HttpError(429, "Too many tries. Wait a minute and try again.", 60);
}
async function view(env: MemberAlertEnv, grant: Record<string, unknown>): Promise<MemberAlertView> {
  const principal = normalizeChatPrincipal(grant.principal);
  if (!principal) throw expired();
  const account = await identityRequest(env, { op: "read", principalId: principal });
  const verified = !!account.email && !!account.emailVerifiedAt;
  return {
    workspaceName: typeof grant.workspaceName === "string" ? grant.workspaceName : "",
    emailVerified: verified,
    emailMasked: verified ? maskEmail(account.email) : null,
    enabled: grant.enabled === true,
  };
}
const grantCookie = (value: string, maxAge: number) =>
  `${ALERT_GRANT_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
function workspaceOf(value: unknown) {
  if (typeof value !== "string" || !WORKSPACE.test(value)) throw expired();
  return value;
}
async function grantFor(request: Request, env: MemberAlertEnv, workspace: string) {
  const grant = readCookie(request, ALERT_GRANT_COOKIE);
  if (!grant) throw expired();
  const grantHash = await sha256Hex(grant);
  return { grant, grantHash, data: await room(env, workspace, "grant", { grantHash }) };
}

const EMAIL_PAGE = (main: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Templ reply emails</title><style>body{font-family:system-ui,sans-serif;background:#0b0b0b;color:#f2f2f2;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px}button{font:inherit;background:#00ff00;color:#000;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}</style></head><body><main>${main}</main></body></html>`;
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const UNSUBSCRIBE_PAGE = (done: boolean) =>
  EMAIL_PAGE(
    done
      ? "<h1>Reply emails are off</h1><p>You won't get emails when this team replies. Turn them on again from the chat.</p>"
      : '<h1>Stop reply emails?</h1><p>You will stop getting an email when this team replies.</p><form method="post"><button type="submit">Turn off</button></form>',
  );
const GUEST_CONFIRM_PAGE = (done: boolean) =>
  EMAIL_PAGE(
    done
      ? "<h1>Email notices are on</h1><p>We'll email you when the team replies. You can close this page.</p>"
      : '<h1>Get an email when the team replies?</h1><p>Only turn this on if you asked for it in the support chat.</p><form method="post"><button type="submit">Turn on email notices</button></form>',
  );

/** `/alerts/unsubscribe`, `/alerts/guest/confirm` and
 * `/alerts/guest/unsubscribe`, or null. It runs
 * before the worker's Origin check: an email client opens the page with no
 * Origin, and a mail provider's one-click POST sends none. A GET only shows a
 * button; only a POST changes anything. */
export async function memberUnsubscribeRoute(
  request: Request,
  env: MemberAlertEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/alerts/guest/confirm") {
    const workspace = workspaceOf(url.searchParams.get("w"));
    const thread = url.searchParams.get("thread"), token = url.searchParams.get("t");
    if (!thread || !/^tc-[0-9a-f]{32}$/.test(thread) || !token || !HASH.test(token)) throw new HttpError(404, "Not found.");
    if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "Method not allowed.");
    if (request.method === "POST") await limited(request, env);
    env = await memberAlertEnvFor(env, workspace);
    // A mail scanner that opens the link only sees the button; the POST turns
    // notices on.
    if (request.method === "GET") return new Response(GUEST_CONFIRM_PAGE(false), { headers: PAGE_HEADERS });
    admitFunnelRequest(env);
    await room(env, workspace, "guest-confirm", { thread, tokenHash: await sha256Hex(token) });
    return new Response(GUEST_CONFIRM_PAGE(true), { headers: PAGE_HEADERS });
  }
  if (url.pathname === "/alerts/guest/unsubscribe") {
    const workspace = workspaceOf(url.searchParams.get("w"));
    const thread = url.searchParams.get("thread"), token = url.searchParams.get("t");
    if (!thread || !/^tc-[0-9a-f]{32}$/.test(thread) || !token || !HASH.test(token)) throw new HttpError(404, "Not found.");
    if (request.method === "GET") return new Response(UNSUBSCRIBE_PAGE(false), { headers: PAGE_HEADERS });
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
    await limited(request, env);
    await room(env, workspace, "guest-unsubscribe", { thread, tokenHash: await sha256Hex(token) });
    return new Response(UNSUBSCRIBE_PAGE(true), { headers: PAGE_HEADERS });
  }
  if (url.pathname !== "/alerts/unsubscribe") return null;
  const workspace = url.searchParams.get("w") ?? "";
  const token = url.searchParams.get("t") ?? "";
  if (!WORKSPACE.test(workspace) || !HASH.test(token)) throw new HttpError(404, "Not found.");
  if (request.method === "GET") return new Response(UNSUBSCRIBE_PAGE(false), { headers: PAGE_HEADERS });
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
  await limited(request, env);
  await room(env, workspace, "unsubscribe", { tokenHash: await sha256Hex(token) });
  return new Response(UNSUBSCRIBE_PAGE(true), { headers: PAGE_HEADERS });
}

/** `/alerts/member/*` from the app origin, or null. */
export async function memberAlertRoute(request: Request, env: MemberAlertEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/alerts/member")) return null;
  requireAppOrigin(request, env);
  await limited(request, env);
  if (url.pathname === "/alerts/member/redeem" && request.method === "POST") {
    const body = await readJson(request, 1_024);
    const workspace = workspaceOf(body.workspace);
    env = await memberAlertEnvFor(env, workspace);
    if (typeof body.ticket !== "string" || !TICKET.test(body.ticket)) throw expired();
    const grant = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const data = await room(env, workspace, "redeem", {
      ticketHash: await sha256Hex(body.ticket),
      grantHash: await sha256Hex(grant),
    });
    return json(await view(env, data), 200, { "Set-Cookie": grantCookie(grant, GRANT_MS / 1000) });
  }
  if (url.pathname === "/alerts/member" && request.method === "GET") {
    const workspace = workspaceOf(url.searchParams.get("w"));
    env = await memberAlertEnvFor(env, workspace);
    return json(await view(env, (await grantFor(request, env, workspace)).data));
  }
  if (url.pathname === "/alerts/member/preference" && request.method === "POST") {
    const body = await readJson(request, 1_024);
    const workspace = workspaceOf(body.workspace);
    env = await memberAlertEnvFor(env, workspace);
    const { grantHash, data } = await grantFor(request, env, workspace);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "Choose on or off.");
    const account = await view(env, data);
    if (body.enabled && !account.emailVerified)
      throw new HttpError(409, "Add and confirm an email address first.", undefined, "email-required");
    await room(env, workspace, "preference", { grantHash, enabled: body.enabled });
    return json({ ...account, enabled: body.enabled });
  }
  if (
    (url.pathname === "/alerts/member/email/start" || url.pathname === "/alerts/member/email/verify") &&
    request.method === "POST"
  ) {
    const workspace = workspaceOf(url.searchParams.get("w"));
    env = await memberAlertEnvFor(env, workspace);
    const { grantHash, data } = await grantFor(request, env, workspace);
    const principal = normalizeChatPrincipal(data.principal);
    if (!principal) throw expired();
    // The same ledger limits as the account page, bound to this grant.
    const link = { principalId: principal, sessionKey: grantHash, revision: 0 };
    if (url.pathname.endsWith("/start")) return startEmailLink(request, env as EmailEnv, link);
    return json(await verifyEmailLink(request, env as EmailEnv, link), 200, {
      "Set-Cookie": emailChallengeCookieClear(),
    });
  }
  throw new HttpError(404, "Not found.");
}
