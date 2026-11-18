/** The opt-in visitor check on widget guest creation.
 *
 * A workspace manager can ask new guests (visitors writing without a wallet
 * proof) to pass Cloudflare Turnstile once, before the service makes their
 * guest credential. The challenge runs in a small page this worker serves,
 * framed only by the approved website that asked, and posts its token only
 * to that website. The token is bound to the workspace and website through
 * `cData`, which the worker recomputes from the guest request, and checked
 * once at siteverify. Wallet sign-in, a guest moving to a wallet and a guest
 * resuming from its credential never read the check. It adds to the auth
 * limiter and the daily guest-thread cap; it never replaces them. Off unless
 * GUEST_TURNSTILE_ENABLED is "true" and both keys are configured. */
import { HttpError, sha256Hex } from "./common";
import type { WidgetSessionEnv } from "./widget-session-config";

export const GUEST_CHECK_ACTION = "widget-guest";
/** A Turnstile token as the widget sends it. */
export const GUEST_CHECK_TOKEN = /^[A-Za-z0-9._-]{1,2048}$/;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CHALLENGE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=templCheck";
/** Tokens live 300 s; a clock skew of 60 s is allowed into the future. */
const MAX_AGE_MS = 300_000;
const SKEW_MS = 60_000;

export const GUEST_CHECK_COPY = {
  required: "Confirm you're a person first.",
  failed: "The check didn't pass. Try again.",
  unavailable: "New visitors can't be checked right now. Try again in a minute.",
} as const;

/** "g1" and the first 32 hex of a hash of the workspace and website: 34
 * characters Turnstile carries back in siteverify's `cdata`. A check solved
 * inside Templ's frame (widget-frame.ts) hashes the frame mark too, so its
 * token starts only a frame guest and an inline token only an inline one. */
export async function guestCheckData(
  room: string,
  origin: string,
  frame = false,
) {
  return `g1${(await sha256Hex(`templ-guest-check|v1|${room}|${origin}${frame ? "|frame" : ""}`)).slice(0, 32)}`;
}

/** Responses a route marks as a page to frame: the worker keeps the CSP it
 * set and leaves out `X-Frame-Options` for them alone. */
const FRAMEABLE = new WeakSet<Response>();
export const markFrameable = (response: Response) => {
  FRAMEABLE.add(response);
  return response;
};
/** Whether the worker must pass a widget response through untouched: a
 * socket upgrade (a rebuilt 101 would lose its socket) or the check page. */
export const passThrough = (response: Response) =>
  response.status === 101 || FRAMEABLE.has(response);

const script = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

/** The check page for one approved website of one workspace. The caller
 * has already checked the website, the workspace's setting and Templ's
 * switch; nothing from the request but that checked origin reaches the
 * page. */
export async function guestCheckPage(input: {
  room: string;
  origin: string;
  siteKey: string;
  /** Templ's frame origin when the check sits inside the frame: the page
   * posts to the frame, and both the website and the frame may hold it. */
  frameOrigin?: string;
}) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const cData = await guestCheckData(
    input.room,
    input.origin,
    !!input.frameOrigin,
  );
  const target = input.frameOrigin ?? input.origin;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visitor check</title><style nonce="${nonce}">html,body{margin:0;background:transparent}</style></head><body><div id="c"></div><script nonce="${nonce}">
const origin=${script(target)};
const post=(message)=>parent.postMessage({type:"templ-check",...message},origin);
window.templCheck=()=>turnstile.render("#c",{sitekey:${script(input.siteKey)},action:${script(GUEST_CHECK_ACTION)},cData:${script(cData)},appearance:"interaction-only","refresh-expired":"manual",callback:(token)=>post({state:"passed",token}),"before-interactive-callback":()=>post({state:"interactive"}),"error-callback":()=>{post({state:"failed"});return true},"expired-callback":()=>post({state:"expired"}),"timeout-callback":()=>post({state:"failed"}),"unsupported-callback":()=>post({state:"unsupported"})});
</script><script nonce="${nonce}" src="${CHALLENGE_SCRIPT}" async></script></body></html>`;
  return markFrameable(
    new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
          "frame-src https://challenges.cloudflare.com",
          `style-src 'nonce-${nonce}'`,
          "base-uri 'none'",
          "form-action 'none'",
          `frame-ancestors ${input.origin}${input.frameOrigin ? ` ${input.frameOrigin}` : ""}`,
        ].join("; "),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, nosnippet, noimageindex",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
      },
    }),
  );
}

type Siteverify = {
  success?: unknown;
  "error-codes"?: unknown;
  hostname?: unknown;
  action?: unknown;
  cdata?: unknown;
  challenge_ts?: unknown;
};
const unavailable = () =>
  new HttpError(
    503,
    GUEST_CHECK_COPY.unavailable,
    undefined,
    "guest-check-unavailable",
  );
const refused = () =>
  new HttpError(403, GUEST_CHECK_COPY.failed, undefined, "guest-check-failed");

/** One siteverify call for one guest start. Passes only when Cloudflare
 * says success for this worker's host, the guest action, the cData of this
 * request's workspace and website, and a fresh challenge. Sends only the
 * secret and the token: no visitor address, no idempotency key. The token
 * is never stored, logged or echoed. */
export async function verifyGuestCheck(
  env: WidgetSessionEnv,
  token: string,
  input: {
    room: string;
    origin: string;
    hostname: string;
    now?: number;
    frame?: boolean;
  },
  fetcher: typeof fetch = fetch,
) {
  if (!env.TURNSTILE_SECRET_KEY) throw unavailable();
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  let answer: Siteverify;
  try {
    const response = await fetcher(SITEVERIFY, {
      method: "POST",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) throw new Error("status");
    answer = await response.json<Siteverify>();
  } catch {
    console.error(
      JSON.stringify({ "templ.error": { category: "turnstile-unavailable" } }),
    );
    throw unavailable();
  }
  const codes = Array.isArray(answer["error-codes"])
    ? answer["error-codes"].filter((code) => typeof code === "string")
    : [];
  if (
    codes.includes("missing-input-secret") ||
    codes.includes("invalid-input-secret")
  ) {
    console.error(
      JSON.stringify({
        "templ.error": { category: "turnstile-config", code: codes[0] },
      }),
    );
    throw unavailable();
  }
  if (codes.includes("internal-error")) throw unavailable();
  const now = input.now ?? Date.now();
  const at = Date.parse(
    typeof answer.challenge_ts === "string" ? answer.challenge_ts : "",
  );
  if (
    answer.success !== true ||
    answer.hostname !== input.hostname ||
    answer.action !== GUEST_CHECK_ACTION ||
    answer.cdata !==
      (await guestCheckData(input.room, input.origin, input.frame)) ||
    !Number.isFinite(at) ||
    now - at > MAX_AGE_MS ||
    at - now > SKEW_MS
  )
    throw refused();
}
