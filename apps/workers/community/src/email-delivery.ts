import { observeCostWorkload } from "./cost-observability";
import { normalizeEmailValue } from "./email-normalize";
import { HttpError, json, readJson, type Env } from "./common";

/** The Resend sender, its secrets and the daily send allowance every Templ
 * email shares. */
export interface EmailEnv extends Env {
  RESEND_API_KEY?: string;
  /** Bare address on a verified sending domain; display name is fixed below. */
  EMAIL_FROM?: string;
  /** Independent 32-byte hex secret. Keep stable: it keys the private email index. */
  EMAIL_AUTH_SECRET?: string;
  EMAIL_DAILY_LIMIT?: string;
  FEEDBACK_EMAIL_DAILY_LIMIT?: string;
}
const DAY = 24 * 3_600_000;
const digest = /^[0-9a-f]{64}$/;
/** The only provider response field ever kept: an opaque message id used to poll delivery status. */
export const PROVIDER_MESSAGE_ID = /^[0-9a-f-]{36}$/;
export type EmailDeliveryOutcome = "sent" | "failed" | "unknown";
export type EmailDelivery = {
  outcome: EmailDeliveryOutcome;
  providerMessageId: string | null;
  /** Provider HTTP status when a response arrived; null on abort or network failure. */
  status: number | null;
};
export const emailUnavailable = () =>
  new HttpError(503, "Email is unavailable right now. Try again later.");

export function normalizeEmail(value: unknown) {
  const email = normalizeEmailValue(value);
  if (email === null) throw new HttpError(400, "Enter a valid email address.");
  return email;
}
export function deliveryLimits(value: {
  EMAIL_DAILY_LIMIT?: unknown;
  FEEDBACK_EMAIL_DAILY_LIMIT?: unknown;
}) {
  const total = Number(value.EMAIL_DAILY_LIMIT ?? 100),
    support = Number(value.FEEDBACK_EMAIL_DAILY_LIMIT ?? 60);
  if (
    !Number.isSafeInteger(total) ||
    total < 100 ||
    total > 1000 ||
    !Number.isSafeInteger(support) ||
    support < 0 ||
    support > Math.floor(total * 0.6)
  )
    throw emailUnavailable();
  return { total, support };
}
const senderAddress = (from: string | undefined) =>
  from === "Templ <alerts@usetempl.com>" ? "alerts@usetempl.com" : from;

/** Sender configuration shared by alert-address codes and every notification. */
export function resendConfig(env: EmailEnv) {
  try {
    const from = senderAddress(env.EMAIL_FROM);
    if (
      !/^re_[A-Za-z0-9_-]{10,200}$/.test(env.RESEND_API_KEY ?? "") ||
      !digest.test(env.EMAIL_AUTH_SECRET ?? "") ||
      !from ||
      normalizeEmail(from) !== from
    )
      throw emailUnavailable();
    return {
      key: env.RESEND_API_KEY!,
      secret: env.EMAIL_AUTH_SECRET!,
      from,
      limits: deliveryLimits(env),
    };
  } catch {
    throw emailUnavailable();
  }
}
/** Sender secrets alone, without any feature flag; each
 * notification checks its own flag. */
export function resendSenderConfigured(env: EmailEnv) {
  try {
    resendConfig(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * One provider call. Reservation and accounting happen before it; the caller
 * never retries or refunds an ambiguous result. The response body is read only
 * to extract an opaque message id; nothing else from it is kept, logged or surfaced.
 */
export async function deliverEmail(
  env: EmailEnv,
  fetcher: typeof fetch,
  message: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
    /** Sender fixed when a durable job was queued, so retries keep an identical payload. */
    from?: string;
    /** Extra mail headers, such as List-Unsubscribe on member reply email. */
    headers?: Record<string, string>;
  },
  observeAttempt?: (outcome: EmailDeliveryOutcome) => void,
): Promise<EmailDelivery> {
  const cfg = resendConfig(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let attempted = false;
  let outcome: EmailDeliveryOutcome = "unknown",
    id: string | null = null,
    status: number | null = null;
  try {
    // The Workers runtime accepts only "follow" or "manual"; a redirect is
    // an unexpected answer from the provider and counts as a failed send.
    attempted = true;
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: `Templ <${senderAddress(message.from ?? cfg.from)}>`,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
      }),
    });
    status = response.status;
    outcome = response.ok ? "sent" : "failed";
    // Provider bodies can echo the recipient or credentials; keep only a well-formed id.
    if (response.ok)
      try {
        const raw = await response.text();
        const parsed: unknown = raw.length <= 4096 ? JSON.parse(raw) : null;
        const value =
          parsed && typeof parsed === "object"
            ? (parsed as { id?: unknown }).id
            : undefined;
        if (typeof value === "string" && PROVIDER_MESSAGE_ID.test(value))
          id = value;
      } catch {
        /* An unreadable body is still an accepted send. */
      }
    else await response.body?.cancel();
  } catch {
    /* The email may have been accepted before the connection failed. */
  } finally {
    clearTimeout(timer);
    if (attempted) try { observeAttempt?.(outcome); } catch { /* Accounting cannot change delivery. */ }
  }
  await observeCostWorkload(
    env,
    {
      emailAttempts: 1,
      ...(outcome === "sent"
        ? { emailAccepted: 1 }
        : outcome === "failed"
          ? { emailFailed: 1 }
          : { emailUnknown: 1 }),
    },
    1,
  );
  return { outcome, providerMessageId: id, status };
}
export async function keyed(secret: string, value: string) {
  const raw = Uint8Array.from(secret.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function ledger(env: EmailEnv) {
  // Independent of factory changes; the email->opaque-account mapping must remain stable.
  return env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(`email-auth:v1:${env.APP_ORIGIN}`),
  );
}
/** One call to the send ledger in the AuthRecord object. */
export async function callLedger(
  env: EmailEnv,
  op: string,
  body: Record<string, unknown>,
) {
  const response = await ledger(env).fetch(
    new Request(`https://internal/email/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    const retry = Number(response.headers.get("Retry-After"));
    if (response.status === 429)
      throw new HttpError(
        429,
        "Too many attempts. Try again later.",
        Number.isFinite(retry) && retry > 0 ? retry : 60,
      );
    if (response.status === 401)
      throw new HttpError(
        401,
        "That code is invalid or expired. Request a new code.",
      );
    if (response.status === 409) {
      // The ledger names the conflict: another account's address, an
      // address already set, or a changed request.
      const error = (
        await response
          .json<{ error?: unknown }>()
          .catch((): { error?: unknown } => ({}))
      ).error;
      throw new HttpError(
        409,
        typeof error === "string" && error.length <= 200
          ? error
          : "Request a new code.",
      );
    }
    throw emailUnavailable();
  }
  return response;
}

/** Support reply alerts and feedback replies reserve their send in the same
 * daily ledger as verification codes. */
async function reserveNotificationEmail(
  env: EmailEnv,
  scope: "support-delivery" | "feedback-delivery",
  notificationId: string,
) {
  const cfg = resendConfig(env);
  const requestKey = await keyed(cfg.secret, `${scope}:${notificationId}`);
  return callLedger(env, "delivery", {
    requestKey,
    deliveryLimits: cfg.limits,
  });
}
export const reserveSupportEmail = (env: EmailEnv, notificationId: string) =>
  reserveNotificationEmail(env, "support-delivery", notificationId);
export const reserveFeedbackEmail = (env: EmailEnv, notificationId: string) =>
  reserveNotificationEmail(env, "feedback-delivery", notificationId);
/** A day's reservation: a verification code or a notification. */
type Delivery = {
  key: string;
  kind: "code" | "sign-in" | "feedback";
  at: number;
};
export function limited(until: number, now: number) {
  return json({ error: "Too many attempts. Try again later." }, 429, {
    "Retry-After": String(Math.max(1, Math.ceil((until - now) / 1000))),
  });
}
/** Reserves one of the day's sends. Returns a 429 response when the day is
 * full, null once the send is reserved or was already reserved. */
export async function reserveDelivery(
  storage: DurableObjectTransaction,
  requestKey: string,
  kind: Delivery["kind"],
  now: number,
  limits: { total: number; support: number },
) {
  const current = (
    (await storage.get<Delivery[]>("email-deliveries")) ?? []
  ).filter((entry) => entry.at > now - DAY);
  const existing = current.find((entry) => entry.key === requestKey);
  if (existing) {
    if (existing.kind !== kind)
      throw new HttpError(409, "Email request changed.");
    return null;
  }
  if (current.length >= limits.total) return limited(current[0].at + DAY, now);
  const signIns = current.filter((entry) => entry.kind === "sign-in");
  if (kind === "sign-in" && signIns.length >= Math.floor(limits.total * 0.3))
    return limited((signIns[0]?.at ?? now) + DAY, now);
  // Public sign-in codes leave capacity for notices and alert-address codes.
  // Notices still use at most the existing 60% share.
  const notifications = current.filter((entry) => entry.kind === "feedback");
  if (kind === "feedback" && notifications.length >= limits.support)
    return limited((notifications[0]?.at ?? now) + DAY, now);
  await storage.put("email-deliveries", [
    ...current,
    { key: requestKey, kind, at: now } satisfies Delivery,
  ]);
  return null;
}

/** Internal AuthRecord route `POST /email/delivery`: one notification send
 * reserved in the same daily ledger that caps every send. */
export async function emailDeliveryRecordRequest(
  request: Request,
  state: DurableObjectState,
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/email/delivery" ||
    request.method !== "POST"
  )
    return null;
  const body = await readJson(request, 2048);
  const requestedLimits = body.deliveryLimits as
    | { total?: unknown; support?: unknown }
    | undefined;
  const limits = deliveryLimits({
    EMAIL_DAILY_LIMIT: requestedLimits?.total,
    FEEDBACK_EMAIL_DAILY_LIMIT: requestedLimits?.support,
  });
  const requestKey = body.requestKey;
  if (typeof requestKey !== "string" || !digest.test(requestKey))
    throw new HttpError(400, "Invalid delivery request.");
  const now = Date.now();
  return state.storage.transaction(async (storage) => {
    const refused = await reserveDelivery(
      storage,
      requestKey,
      "feedback",
      now,
      limits,
    );
    return refused ?? json({ ok: true });
  });
}
