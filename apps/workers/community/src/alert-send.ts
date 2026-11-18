/** Provider adapters for alert delivery. Each call sends one request with
 * manual redirects (a redirect is a failure), a 10 second timeout, a body
 * of at most 16 KB and the `Templ-Alerts/1` user agent, then classifies the
 * answer: delivered, retry (with the provider's wait, at most an hour),
 * failed, or paused when the provider says the channel no longer takes
 * posts. Telegram calls are limited to getMe, getChat and sendMessage:
 * Templ only posts and never reads a group. */
import { SUPPORT_ALERT_LIMITS } from "@templ/chat/support-alerts";
import { safeFetch, SafeFetchRefused } from "./safe-fetch";
import type { AlertTarget } from "./alert-destinations";
import { standardWebhookSignature } from "./alert-crypto";

export const ALERT_USER_AGENT = "Templ-Alerts/1";
const TIMEOUT_MS = 10_000;
const ERROR_BYTES = 4_096;
/** A successful Bot API answer: getChat returns the chat's full info, with
 * its pinned message and description, well past an error body's size. */
const TELEGRAM_OK_BYTES = 65_536;
const MAX_RETRY_AFTER_MS = 3_600_000;
const TELEGRAM_API = "https://api.telegram.org";
/** The only Bot API methods Templ calls. */
export const TELEGRAM_METHODS = ["getMe", "getChat", "sendMessage"] as const;
export type TelegramMethod = (typeof TELEGRAM_METHODS)[number];

export type SendDeps = {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  workersDevSubdomain?: string;
};
export type SendResult =
  | { outcome: "delivered"; status: number; ms: number }
  | {
      outcome: "retry";
      status: number | null;
      reason: string;
      retryAfterMs?: number;
      ms: number;
    }
  | { outcome: "failed"; status: number | null; reason: string; ms: number }
  | { outcome: "paused"; status: number | null; reason: "provider-disabled"; ms: number };

const encoder = new TextEncoder();
function retryAfter(header: string | null, seconds?: unknown): number | undefined {
  const fromBody = typeof seconds === "number" && seconds >= 0 ? seconds * 1000 : NaN;
  const fromHeader = header && /^[0-9]{1,6}$/.test(header) ? Number(header) * 1000 : NaN;
  const value = Number.isFinite(fromBody) ? fromBody : fromHeader;
  return Number.isFinite(value) ? Math.min(MAX_RETRY_AFTER_MS, value) : undefined;
}
/** A JSON object read from at most `cap` bytes of the body; null when the
 * body is larger, unreadable or not an object. The rest is never read. */
async function boundedJson(response: Response, cap: number): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const errorJson = (response: Response) => boundedJson(response, ERROR_BYTES);

/** One request to a fixed provider host (Slack, Discord, Telegram). The
 * host was checked when the destination was saved; nothing here follows a
 * redirect. */
async function providerPost(
  url: string,
  body: string,
  deps: SendDeps,
): Promise<{ response: Response | null; ms: number; reason?: string }> {
  const started = Date.now();
  if (encoder.encode(body).length > SUPPORT_ALERT_LIMITS.webhookPayloadBytes)
    return { response: null, ms: 0, reason: "too-large" };
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", "user-agent": ALERT_USER_AGENT },
      body,
    });
    return { response, ms: Date.now() - started };
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { response: null, ms: Date.now() - started, reason: timeout ? "timeout" : "network" };
  }
}

/** Slack or Discord incoming webhook. */
export async function sendChatWebhook(
  kind: "slack" | "discord",
  url: string,
  body: Record<string, unknown>,
  deps: SendDeps = {},
): Promise<SendResult> {
  const { response, ms, reason } = await providerPost(url, JSON.stringify(body), deps);
  if (!response)
    return reason === "too-large"
      ? { outcome: "failed", status: null, reason, ms }
      : { outcome: "retry", status: null, reason: reason ?? "network", ms };
  const status = response.status;
  if (status >= 300 && status < 400) {
    await response.body?.cancel();
    return { outcome: "failed", status, reason: "redirect", ms };
  }
  if (status === 200 || (kind === "discord" && status === 204)) {
    await response.body?.cancel();
    return { outcome: "delivered", status, ms };
  }
  if (status === 429) {
    const parsed = kind === "discord" ? await errorJson(response) : null;
    if (kind !== "discord") await response.body?.cancel();
    return {
      outcome: "retry",
      status,
      reason: "rate-limited",
      retryAfterMs: retryAfter(response.headers.get("retry-after"), parsed?.retry_after),
      ms,
    };
  }
  await response.body?.cancel();
  if (status >= 500) return { outcome: "retry", status, reason: "server-error", ms };
  const disabled = kind === "slack" ? [403, 404, 410] : [401, 403, 404];
  if (disabled.includes(status))
    return { outcome: "paused", status, reason: "provider-disabled", ms };
  return { outcome: "failed", status, reason: "rejected", ms };
}

export type TelegramAnswer = {
  ok: boolean;
  status: number | null;
  result?: Record<string, unknown>;
  description?: string;
  retryAfterMs?: number;
  reason?: string;
  ms: number;
};
/** One Bot API call. The token is only in the path; nothing logs it. */
export async function telegramCall(
  token: string,
  method: TelegramMethod,
  params: Record<string, unknown>,
  deps: SendDeps = {},
): Promise<TelegramAnswer> {
  if (!TELEGRAM_METHODS.includes(method)) throw new Error("telegram method");
  const { response, ms, reason } = await providerPost(
    `${TELEGRAM_API}/bot${token}/${method}`,
    JSON.stringify(params),
    deps,
  );
  if (!response) return { ok: false, status: null, reason: reason ?? "network", ms };
  const status = response.status;
  if (status >= 300 && status < 400) {
    await response.body?.cancel();
    return { ok: false, status, reason: "redirect", ms };
  }
  const parsed = await boundedJson(response, status === 200 ? TELEGRAM_OK_BYTES : ERROR_BYTES);
  const parameters = parsed?.parameters as { retry_after?: unknown } | undefined;
  return {
    ok: parsed?.ok === true && status === 200,
    status,
    ...(parsed?.result && typeof parsed.result === "object"
      ? { result: parsed.result as Record<string, unknown> }
      : {}),
    ...(typeof parsed?.description === "string"
      ? { description: parsed.description.slice(0, 200) }
      : {}),
    ...(status === 429
      ? { retryAfterMs: retryAfter(response.headers.get("retry-after"), parameters?.retry_after) }
      : {}),
    ms,
  };
}
export function classifyTelegram(answer: TelegramAnswer): SendResult {
  const { status, ms } = answer;
  if (answer.ok) return { outcome: "delivered", status: status ?? 200, ms };
  if (status === null) return { outcome: "retry", status, reason: answer.reason ?? "network", ms };
  if (answer.reason === "redirect") return { outcome: "failed", status, reason: "redirect", ms };
  if (status === 429)
    return { outcome: "retry", status, reason: "rate-limited", retryAfterMs: answer.retryAfterMs, ms };
  if (status >= 500) return { outcome: "retry", status, reason: "server-error", ms };
  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && /chat not found/i.test(answer.description ?? ""))
  )
    return { outcome: "paused", status, reason: "provider-disabled", ms };
  return { outcome: "failed", status, reason: "rejected", ms };
}
export async function sendTelegram(
  target: Extract<AlertTarget, { kind: "telegram" }>,
  body: Record<string, unknown>,
  deps: SendDeps = {},
): Promise<SendResult> {
  return classifyTelegram(
    await telegramCall(
      target.token,
      "sendMessage",
      {
        chat_id: target.chatId,
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
        ...body,
      },
      deps,
    ),
  );
}

/** Standard Webhooks headers for one attempt. Every active secret signs,
 * so a receiver rotating its secret accepts either. */
export async function webhookHeaders(
  secrets: readonly { value: string; notAfter?: number }[],
  id: string,
  timestamp: number,
  body: string,
  now: number,
): Promise<Record<string, string>> {
  const active = secrets.filter((secret) => !secret.notAfter || secret.notAfter > now);
  const signatures = await Promise.all(
    active.map((secret) => standardWebhookSignature(secret.value, id, timestamp, body)),
  );
  return {
    "content-type": "application/json",
    "user-agent": ALERT_USER_AGENT,
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
  };
}
const WEBHOOK_RETRY = [408, 409, 425, 429];
/** A signed POST to the team's own server, through safe-fetch. */
export async function sendWebhook(
  target: Extract<AlertTarget, { kind: "webhook" }>,
  message: { id: string; body: string; now: number },
  deps: SendDeps = {},
): Promise<SendResult> {
  const started = Date.now();
  if (encoder.encode(message.body).length > SUPPORT_ALERT_LIMITS.webhookPayloadBytes)
    return { outcome: "failed", status: null, reason: "too-large", ms: 0 };
  const timestamp = Math.floor(message.now / 1000);
  try {
    const result = await safeFetch(
      target.url,
      {
        method: "POST",
        headers: await webhookHeaders(target.secrets, message.id, timestamp, message.body, message.now),
        body: message.body,
        maxBytes: ERROR_BYTES,
        timeoutMs: TIMEOUT_MS,
        maxRedirects: 0,
        allowQuery: true,
        discardBody: true,
        workersDevSubdomain: deps.workersDevSubdomain,
      },
      { fetch: deps.fetch, resolve: deps.resolve },
    );
    const ms = Date.now() - started;
    const status = result.status;
    if (status >= 200 && status < 300) return { outcome: "delivered", status, ms };
    if (status === 429 || WEBHOOK_RETRY.includes(status) || status >= 500)
      return {
        outcome: "retry",
        status,
        reason: status === 429 ? "rate-limited" : status >= 500 ? "server-error" : "busy",
        retryAfterMs: retryAfter(result.headers.get("retry-after")),
        ms,
      };
    if (status === 410) return { outcome: "paused", status, reason: "provider-disabled", ms };
    return { outcome: "failed", status, reason: "rejected", ms };
  } catch (error) {
    const ms = Date.now() - started;
    if (error instanceof SafeFetchRefused) {
      if (error.reason === "timeout" || error.reason === "unavailable")
        return { outcome: "retry", status: null, reason: error.reason, ms };
      return { outcome: "failed", status: null, reason: error.reason, ms };
    }
    return { outcome: "retry", status: null, reason: "network", ms };
  }
}
