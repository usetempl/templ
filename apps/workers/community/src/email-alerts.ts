import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  claimAlertEmail,
  emailSignInIdentity,
  identityStore,
  type AccountIdentity,
} from "./account-identity";
import { principal } from "./principal";
import type { LinkedSession } from "./linked-wallets";
import {
  cookie,
  HttpError,
  json,
  readCookie,
  readJson,
  type Env,
} from "./common";
import {
  callLedger,
  deliverEmail,
  deliveryLimits,
  emailUnavailable,
  keyed,
  limited,
  normalizeEmail,
  reserveDelivery,
  resendConfig,
  type EmailEnv,
} from "./email-delivery";
import { resendSenderConfigured } from "./email-delivery";

/** Email sign-in and alert-address proof use separate one-time challenges.
 * An alert address never adopts a wallet or joins two accounts. Both uses
 * share the sender, secrets and daily send ledger in email-delivery.ts. */
export type EmailLinkContext = {
  principalId: ChatPrincipalId;
  sessionKey: string;
  revision: number;
};
export type EmailSignInContext = { sessionKey: string };
type EmailPurpose = "alert-link" | "email-sign-in";
type EmailSignInEnv = EmailEnv & { EMAIL_SIGN_IN_ENABLED?: string };
export const EMAIL_SIGN_IN_CHALLENGE_COOKIE = "__Host-templ_email_signin";
export const EMAIL_CHALLENGE_COOKIE = "__Host-templ_email_challenge";
export const EMAIL_CODE_TTL = 5 * 60_000;
export const EMAIL_LIMITS = {
  resendMs: 60_000,
  attempts: 5,
  attemptWindowMs: 15 * 60_000,
  emailPerHour: 5,
  emailPerDay: 10,
  ipPerHour: 20,
} as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;

/** Support alerts are on and the sender is complete: only then is an
 * address worth verifying. */
function alertConfig(env: EmailEnv) {
  if (
    env.SUPPORT_NOTIFICATIONS_ENABLED !== "true" ||
    !env.AUTH_RECORDS ||
    !env.APP_ORIGIN ||
    !resendSenderConfigured(env as Env)
  )
    throw emailUnavailable();
  return resendConfig(env);
}
export function emailAlertsAvailable(env: EmailEnv) {
  try {
    alertConfig(env);
    return true;
  } catch {
    return false;
  }
}

function signInConfig(env: EmailSignInEnv) {
  if (
    env.EMAIL_SIGN_IN_ENABLED !== "true" ||
    !env.AUTH_RECORDS ||
    !env.APP_ORIGIN
  )
    throw emailUnavailable();
  return resendConfig(env);
}
export function emailSignInAvailable(env: EmailSignInEnv) {
  try {
    signInConfig(env);
    return true;
  } catch {
    return false;
  }
}
export function emailSignInChallengeCookieClear() {
  return cookie(EMAIL_SIGN_IN_CHALLENGE_COOKIE, "", 0);
}
function requireOrigin(request: Request, env: EmailEnv) {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== env.APP_ORIGIN
  )
    throw new HttpError(403, "Use the Templ app to verify your email.");
}
export function emailChallengeCookieClear() {
  return cookie(EMAIL_CHALLENGE_COOKIE, "", 0);
}

/** Sends a purpose-bound one-time code for email sign-in. */
export function startEmailSignIn(
  request: Request,
  env: EmailSignInEnv,
  signIn: EmailSignInContext,
  fetcher: typeof fetch = fetch,
) {
  return startEmailChallenge(
    request,
    env,
    "email-sign-in",
    undefined,
    signIn,
    fetcher,
  );
}
/** Consumes the sign-in code before the worker issues a fresh session. */
export async function verifyEmailSignIn(
  request: Request,
  env: EmailSignInEnv,
  signIn: EmailSignInContext,
) {
  return (
    await verifyEmailChallenge(request, env, "email-sign-in", undefined, signIn)
  ).json<AccountIdentity>();
}
/** `POST /auth/email/link/start {email, requestId}`. The same requestId
 * recovers the same challenge without sending another email, even after a
 * lost response. */
export function startEmailLink(
  request: Request,
  env: EmailEnv,
  link: EmailLinkContext,
  fetcher: typeof fetch = fetch,
) {
  return startEmailChallenge(
    request,
    env,
    "alert-link",
    link,
    undefined,
    fetcher,
  );
}
async function startEmailChallenge(
  request: Request,
  env: EmailSignInEnv,
  purpose: EmailPurpose,
  link: EmailLinkContext | undefined,
  signIn: EmailSignInContext | undefined,
  fetcher: typeof fetch,
) {
  requireOrigin(request, env);
  const cfg = purpose === "alert-link" ? alertConfig(env) : signInConfig(env);
  if (
    purpose === "email-sign-in" &&
    (!signIn || !digest.test(signIn.sessionKey))
  )
    throw new HttpError(400, "Invalid email sign-in request.");
  const body = await readJson(request, 1024);
  const email = normalizeEmail(body.email);
  if (typeof body.requestId !== "string" || !uuid.test(body.requestId))
    throw new HttpError(400, "Start a new verification request.");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const emailKey = await keyed(cfg.secret, `email:${email}`);
  const requestKey = await keyed(
    cfg.secret,
    purpose === "alert-link"
      ? `request:${emailKey}:${body.requestId}:${link!.principalId}:${link!.sessionKey}:${link!.revision}`
      : `request:email-sign-in:${emailKey}:${body.requestId}:${signIn!.sessionKey}`,
  );
  const token = await keyed(cfg.secret, `challenge:${requestKey}:${emailKey}`);
  const challengeKey = await keyed(cfg.secret, `cookie:${token}`);
  const codeSeed = await keyed(cfg.secret, `code-value:${token}`);
  const code = (BigInt(`0x${codeSeed.slice(0, 16)}`) % 1_000_000n)
    .toString()
    .padStart(6, "0");
  const codeHash = await keyed(cfg.secret, `code:${token}:${code}`);
  const ipKey = await keyed(cfg.secret, `ip:${ip}`);
  const held =
    purpose === "email-sign-in"
      ? readCookie(request, EMAIL_SIGN_IN_CHALLENGE_COOKIE)
      : null;
  const reserved = await (
    await callLedger(env, "start", {
      emailKey,
      ipKey,
      requestKey,
      challengeKey,
      codeHash,
      purpose,
      ...(link ? { link } : { signIn }),
      ...(held
        ? { heldChallengeKey: await keyed(cfg.secret, `cookie:${held}`) }
        : {}),
      deliveryLimits: cfg.limits,
    })
  ).json<{
    send: boolean;
    resumed?: true;
    expiresAt: number;
    resendAfter: number;
  }>();
  if (reserved.send) {
    // Reservation includes unknown/failed sends. Never retry or refund an ambiguous provider call.
    const delivery = await deliverEmail(env, fetcher, {
      to: email,
      idempotencyKey: `${purpose === "alert-link" ? "templ-alert-email" : "templ-email-sign-in"}/${requestKey}`,
      subject:
        purpose === "alert-link"
          ? "Verify your email for Templ"
          : "Sign in to Templ",
      text: `Your Templ verification code is ${code}.\n\n${purpose === "alert-link" ? "Enter it in Templ to get support alerts at this address." : "Enter it in Templ to sign in with this email."} It expires in 5 minutes. If you did not ask for this code, ignore this email.`,
    });
    await callLedger(env, "sent", {
      requestKey,
      purpose,
      outcome: delivery.outcome,
    });
    if (delivery.outcome === "failed") throw emailUnavailable();
  }
  return json(
    {
      ok: true,
      expiresAt: reserved.expiresAt,
      resendAfter: reserved.resendAfter,
    },
    202,
    {
      "Set-Cookie": cookie(
        purpose === "alert-link"
          ? EMAIL_CHALLENGE_COOKIE
          : EMAIL_SIGN_IN_CHALLENGE_COOKIE,
        reserved.resumed && held ? held : token,
        Math.max(0, Math.floor((reserved.expiresAt - Date.now()) / 1000)),
      ),
    },
  );
}

/** `POST /auth/email/link/verify {email, code}`: consumes the code and sets
 * the alert address on the session's account. The session is unchanged. */
export async function verifyEmailLink(
  request: Request,
  env: EmailEnv,
  link: EmailLinkContext,
) {
  return (
    await verifyEmailChallenge(request, env, "alert-link", link, undefined)
  ).json<AlertEmailView>();
}
async function verifyEmailChallenge(
  request: Request,
  env: EmailSignInEnv,
  purpose: EmailPurpose,
  link: EmailLinkContext | undefined,
  signIn: EmailSignInContext | undefined,
) {
  requireOrigin(request, env);
  const cfg = purpose === "alert-link" ? alertConfig(env) : signInConfig(env);
  if (
    purpose === "email-sign-in" &&
    (!signIn || !digest.test(signIn.sessionKey))
  )
    throw new HttpError(400, "Invalid email sign-in request.");
  const token = readCookie(
    request,
    purpose === "alert-link"
      ? EMAIL_CHALLENGE_COOKIE
      : EMAIL_SIGN_IN_CHALLENGE_COOKIE,
  );
  const body = await readJson(request, 1024);
  const email = normalizeEmail(body.email);
  if (!token || typeof body.code !== "string" || !/^[0-9]{6}$/.test(body.code))
    throw new HttpError(
      401,
      "That code is invalid or expired. Request a new code.",
    );
  const challengeKey = await keyed(cfg.secret, `cookie:${token}`);
  const codeHash = await keyed(cfg.secret, `code:${token}:${body.code}`);
  const emailKey = await keyed(cfg.secret, `email:${email}`);
  return callLedger(env, "verify", {
    challengeKey,
    codeHash,
    emailKey,
    email,
    purpose,
    ...(link ? { link } : { signIn }),
  });
}

/** What the account page shows: whether an address is verified, masked. */
export type AlertEmailView = {
  principalId: ChatPrincipalId;
  emailVerified: boolean;
  emailMasked: string | null;
};
export const maskEmail = (email: string | null) =>
  email ? `${email.slice(0, 1)}***@${email.split("@")[1]}` : null;
function alertEmailView(identity: AccountIdentity): AlertEmailView {
  const verified = !!identity.email && !!identity.emailVerifiedAt;
  return {
    principalId: identity.principalId,
    emailVerified: verified,
    emailMasked: verified ? maskEmail(identity.email) : null,
  };
}

/** `POST /auth/email/remove {}` drops the account's alert address. It is not
 * a way to sign in, so no other method is needed first. */
export async function emailRemoveRoute<
  S extends Pick<LinkedSession, "principalId">,
>(
  request: Request,
  env: Env,
  auth: {
    session: () => Promise<S>;
    guard: (body: Record<string, unknown>, session: S) => void;
  },
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/auth/email/remove" ||
    request.method !== "POST"
  )
    return null;
  const session = await auth.session();
  auth.guard(await readJson(request, 1024), session);
  const identity = await identityCall(env, {
    op: "alert-email-remove",
    principalId: session.principalId,
  });
  return json(alertEmailView(identity));
}
/** Identity call that keeps the object's own 404/409 messages. */
async function identityCall(env: Env, body: Record<string, unknown>) {
  let response: Response;
  try {
    response = await identityStore(env).fetch(
      new Request("https://internal/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    throw new HttpError(503, "Account details are temporarily unavailable.");
  }
  if (!response.ok) {
    const error = (
      await response
        .json<{ error?: string }>()
        .catch((): { error?: string } => ({}))
    ).error;
    if ([400, 404, 409].includes(response.status) && error)
      throw new HttpError(response.status, error);
    throw new HttpError(503, "Account details are temporarily unavailable.");
  }
  return response.json<AccountIdentity>();
}

type Send = {
  emailKey: string;
  ipKey: string;
  requestKey: string;
  challengeKey: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  outcome: "pending" | "sent" | "unknown" | "failed";
  consumed?: boolean;
  /** Untagged historical codes never verify. */
  purpose?: EmailPurpose;
  link?: EmailLinkContext;
  signIn?: EmailSignInContext;
};
type Attempts = { startedAt: number; count: number };
type EmailLedger = { sends: Send[]; attempts: Record<string, Attempts> };
type StoredEmailLedger = EmailLedger & { partCount?: number };
async function loadEmailLedger(storage: Pick<DurableObjectTransaction, "get">) {
  const value = await storage.get<StoredEmailLedger>("email-ledger");
  if (!value?.partCount) return value;
  if (
    !Number.isSafeInteger(value.partCount) ||
    value.partCount < 0 ||
    value.partCount > 10
  )
    throw emailUnavailable();
  const sends: Send[] = [];
  for (let i = 0; i < value.partCount; i++) {
    const part = await storage.get<Send[]>(`email-ledger-part:${i}`);
    if (!Array.isArray(part) || part.length > 100) throw emailUnavailable();
    sends.push(...part);
  }
  return { ...value, sends };
}
async function saveEmailLedger(
  storage: DurableObjectTransaction,
  data: EmailLedger,
) {
  if (data.sends.length > 1000 || Object.keys(data.attempts).length > 1000)
    throw emailUnavailable();
  const old =
    (await storage.get<StoredEmailLedger>("email-ledger"))?.partCount ?? 0;
  const parts =
    data.sends.length > 100 ? Math.ceil(data.sends.length / 100) : 0;
  for (let i = 0; i < parts; i++)
    await storage.put(
      `email-ledger-part:${i}`,
      data.sends.slice(i * 100, (i + 1) * 100),
    );
  for (let i = parts; i < old; i++)
    await storage.delete(`email-ledger-part:${i}`);
  await storage.put(
    "email-ledger",
    parts ? { ...data, sends: [], partCount: parts } : data,
  );
}
function freshLedger(value: EmailLedger | undefined, now: number): EmailLedger {
  return {
    sends: (value?.sends ?? []).filter((send) => send.createdAt > now - DAY),
    attempts: Object.fromEntries(
      Object.entries(value?.attempts ?? {}).filter(
        ([, attempt]) => attempt.startedAt > now - EMAIL_LIMITS.attemptWindowMs,
      ),
    ),
  };
}
function equalDigest(left: string, right: string) {
  let difference = left.length ^ right.length;
  for (let i = 0; i < 64; i++)
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}

/** Internal AuthRecord routes for verification codes. Each code send is
 * reserved in the shared daily ledger (email-delivery.ts) inside the same
 * transaction, and a verified code sets the address in that transaction. */
export async function emailRecordRequest(
  request: Request,
  state: DurableObjectState,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    !["/email/start", "/email/sent", "/email/verify"].includes(path) ||
    request.method !== "POST"
  )
    return null;
  const body = await readJson(request, 2048);
  const field = (name: string) => {
    const value = body[name];
    if (typeof value !== "string" || !digest.test(value))
      throw new HttpError(400, "Invalid verification request.");
    return value;
  };
  const now = Date.now();
  const requestedLimits = body.deliveryLimits as
    | { total?: unknown; support?: unknown }
    | undefined;
  const limits = deliveryLimits({
    EMAIL_DAILY_LIMIT: requestedLimits?.total,
    FEEDBACK_EMAIL_DAILY_LIMIT: requestedLimits?.support,
  });
  const purpose = body.purpose ?? "alert-link";
  if (purpose !== "alert-link" && purpose !== "email-sign-in")
    throw new HttpError(400, "Invalid email-code purpose.");
  let link: EmailLinkContext | undefined;
  let signIn: EmailSignInContext | undefined;
  if (path !== "/email/sent" && purpose === "email-sign-in") {
    const value = body.signIn as Record<string, unknown> | undefined;
    if (
      !value ||
      typeof value.sessionKey !== "string" ||
      !digest.test(value.sessionKey) ||
      body.link !== undefined
    )
      throw new HttpError(400, "Invalid email sign-in request.");
    signIn = { sessionKey: value.sessionKey };
  }
  if (path !== "/email/sent" && purpose === "alert-link") {
    if (body.signIn !== undefined)
      throw new HttpError(400, "Invalid email-link request.");
    const value = body.link as Record<string, unknown> | undefined;
    if (
      !value ||
      typeof value.sessionKey !== "string" ||
      !digest.test(value.sessionKey) ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0
    )
      throw new HttpError(400, "Invalid email-link request.");
    link = {
      principalId: principal(value.principalId),
      sessionKey: value.sessionKey,
      revision: Number(value.revision),
    };
  }
  return state.storage.transaction(async (storage) => {
    const data = freshLedger(await loadEmailLedger(storage), now);
    if (path === "/email/start") {
      const emailKey = field("emailKey"),
        ipKey = field("ipKey"),
        requestKey = field("requestKey"),
        challengeKey = field("challengeKey"),
        codeHash = field("codeHash"),
        held =
          body.heldChallengeKey === undefined
            ? undefined
            : field("heldChallengeKey");
      const previous = data.sends.find(
        (send) => send.requestKey === requestKey,
      );
      if (previous) {
        if (
          previous.emailKey !== emailKey ||
          previous.challengeKey !== challengeKey ||
          previous.codeHash !== codeHash ||
          previous.purpose !== purpose ||
          JSON.stringify(previous.signIn) !== JSON.stringify(signIn) ||
          JSON.stringify(previous.link) !== JSON.stringify(link) ||
          previous.expiresAt <= now ||
          previous.consumed
        )
          return json({ error: "Request a new code." }, 409);
        if (previous.outcome === "failed")
          return json({ error: "Email unavailable." }, 503);
        return json({
          send: false,
          expiresAt: previous.expiresAt,
          resendAfter: previous.createdAt + EMAIL_LIMITS.resendMs,
        });
      }
      const attempts = data.attempts[emailKey];
      if (attempts && attempts.count >= EMAIL_LIMITS.attempts)
        return limited(attempts.startedAt + EMAIL_LIMITS.attemptWindowMs, now);
      const mine = data.sends.filter((send) => send.emailKey === emailKey);
      const last = mine.at(-1);
      if (last && last.createdAt + EMAIL_LIMITS.resendMs > now) {
        if (
          purpose === "email-sign-in" && last.purpose === purpose &&
          held && equalDigest(held, last.challengeKey) &&
          last.signIn?.sessionKey === signIn!.sessionKey &&
          !last.consumed &&
          last.expiresAt > now &&
          last.outcome !== "failed"
        )
          return json({
            send: false,
            resumed: true,
            expiresAt: last.expiresAt,
            resendAfter: last.createdAt + EMAIL_LIMITS.resendMs,
          });
        return limited(last.createdAt + EMAIL_LIMITS.resendMs, now);
      }
      const hourly = mine.filter((send) => send.createdAt > now - HOUR);
      const ipHourly = data.sends.filter(
        (send) => send.ipKey === ipKey && send.createdAt > now - HOUR,
      );
      if (mine.length >= EMAIL_LIMITS.emailPerDay)
        return limited(mine[0].createdAt + DAY, now);
      if (hourly.length >= EMAIL_LIMITS.emailPerHour)
        return limited(hourly[0].createdAt + HOUR, now);
      if (ipHourly.length >= EMAIL_LIMITS.ipPerHour)
        return limited(ipHourly[0].createdAt + HOUR, now);
      if (data.sends.length >= limits.total)
        return limited(data.sends[0].createdAt + DAY, now);
      const refused = await reserveDelivery(
        storage,
        requestKey,
        purpose === "email-sign-in" ? "sign-in" : "code",
        now,
        limits,
      );
      if (refused) return refused;
      // A fresh code invalidates earlier codes but does not reset the guessing window.
      for (const send of mine)
        if (send.purpose === purpose) send.consumed = true;
      const expiresAt = now + EMAIL_CODE_TTL;
      data.sends.push({
        emailKey,
        ipKey,
        requestKey,
        challengeKey,
        codeHash,
        createdAt: now,
        expiresAt,
        outcome: "pending",
        purpose,
        ...(link ? { link } : { signIn }),
      });
      await saveEmailLedger(storage, data);
      await storage.setAlarm(now + HOUR);
      return json({
        send: true,
        expiresAt,
        resendAfter: now + EMAIL_LIMITS.resendMs,
      });
    }
    if (path === "/email/sent") {
      const requestKey = field("requestKey");
      if (!["sent", "failed", "unknown"].includes(String(body.outcome)))
        throw new HttpError(400, "Invalid verification request.");
      const entry = data.sends.find((send) => send.requestKey === requestKey);
      if (!entry || entry.purpose !== purpose)
        return json({ error: "Request expired." }, 409);
      if (entry.outcome === "pending")
        entry.outcome = body.outcome as Send["outcome"];
      await saveEmailLedger(storage, data);
      return json({ ok: true });
    }
    // POST /email/verify
    const challengeKey = field("challengeKey"),
      codeHash = field("codeHash"),
      emailKey = field("emailKey");
    const entry = data.sends.find((send) => send.challengeKey === challengeKey);
    if (
      !entry ||
      entry.purpose !== purpose ||
      (purpose === "alert-link" ? !entry.link : !entry.signIn) ||
      entry.consumed ||
      entry.expiresAt <= now ||
      entry.outcome === "failed"
    )
      return json({ error: "Invalid or expired code." }, 401);
    const attempts = data.attempts[entry.emailKey] ?? {
      count: 0,
      startedAt: now,
    };
    if (attempts.count >= EMAIL_LIMITS.attempts)
      return limited(attempts.startedAt + EMAIL_LIMITS.attemptWindowMs, now);
    // Return a Response rather than throwing, so the transaction commits failed attempts.
    attempts.count++;
    data.attempts[entry.emailKey] = attempts;
    const valid =
      equalDigest(entry.codeHash, codeHash) &&
      equalDigest(entry.emailKey, emailKey) &&
      JSON.stringify(entry.link) === JSON.stringify(link) &&
      JSON.stringify(entry.signIn) === JSON.stringify(signIn);
    if (valid) entry.consumed = true;
    await saveEmailLedger(storage, data);
    if (!valid) return json({ error: "Invalid or expired code." }, 401);
    if (purpose === "email-sign-in")
      return json(
        await emailSignInIdentity(
          storage,
          { emailKey: entry.emailKey, email: normalizeEmail(body.email) },
          now,
        ),
      );
    const account = await claimAlertEmail(
      storage,
      {
        emailKey: entry.emailKey,
        email: normalizeEmail(body.email),
        principalId: entry.link!.principalId,
      },
      now,
    );
    return json(alertEmailView(account));
  });
}

export async function expireEmailLedger(storage: DurableObjectStorage) {
  await storage.transaction(async (transaction) => {
    const value = await loadEmailLedger(transaction);
    if (!value) return;
    const now = Date.now(),
      data = freshLedger(value, now);
    if (data.sends.length || Object.keys(data.attempts).length) {
      await saveEmailLedger(transaction, data);
      await transaction.setAlarm(now + HOUR);
    } else {
      await saveEmailLedger(transaction, data);
      await transaction.delete("email-ledger");
    }
  });
  // Stable opaque accounts outlive individual challenges; no code remains on an identity.
}
