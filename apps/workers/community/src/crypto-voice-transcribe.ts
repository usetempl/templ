/** One admitted voice note at the worker: hold its cost in the desk's month
 * and under Templ's operating cap, call the model once, book the cost, check
 * the words and answer `{ text }`. The recording and its words stay in this
 * request's memory. Nothing is logged but a fixed failure name, and the
 * gateway is told to keep no log and no cache entry. */
import { spendMonth } from "@templ/chat/managed-agent";
import { OPERATIONAL_LIMITS } from "@templ/chat/plans";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { HttpError, json } from "./common";
import {
  CRYPTO_VOICE_NOTE,
  cryptoVoiceBinding,
  type CryptoVoiceEnv,
} from "./crypto-voice-notes";
import { cryptoVoiceBase64 } from "./crypto-voice-wav";
import {
  cryptoVoiceCents,
  type CryptoVoiceRefusal,
  type CryptoVoiceResult,
} from "./managed-agent/crypto-voice-ledger";
import { TEMPL_SPEND_OBJECT } from "./managed-agent/knowledge-hooks";
import { templCapCents } from "./managed-agent/room";
import { refusePhrase } from "./secret-guard";
import { knowledgeStub, type KnowledgeEnv } from "./support-knowledge-client";

const DESK_ROOM = "room:" + CRYPTO_SUPPORT_WORKSPACE;
export const CRYPTO_VOICE_MODEL = "@cf/openai/whisper-large-v3-turbo";
const CALL_MS = 30_000;
const MIN_VOICED_SECONDS = 0.3;
const UNAVAILABLE =
  "Voice notes are unavailable right now. Type your question instead.";
const REFUSALS: Record<CryptoVoiceRefusal, [status: number, text: string]> = {
  "voice-note-in-progress": [409, "This voice note is already being transcribed."],
  "voice-note-used": [409, "This voice note was already sent. Record a new one."],
  "voice-note-limit": [429, "You can send two voice notes per minute. Try again shortly."],
  "voice-note-daily-limit": [429, "You’ve reached today’s voice note limit. Type your question instead."],
  "voice-note-network-limit": [429, "This network is sending many voice notes. Try again later."],
  "voice-note-budget": [503, UNAVAILABLE],
};

type VoiceEnv = CryptoVoiceEnv &
  KnowledgeEnv & {
    AI?: Pick<Ai, "run">;
    MANAGED_AGENT_GATEWAY_ID?: string;
    MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
  };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const spoken = (segment: Record<string, unknown>) =>
  typeof segment.text === "string" &&
  !(typeof segment.no_speech_prob === "number" && segment.no_speech_prob > 0.6) &&
  !(typeof segment.avg_logprob === "number" && segment.avg_logprob < -1) &&
  !(typeof segment.compression_ratio === "number" && segment.compression_ratio > 2.4);

export function cryptoVoiceTranscript(raw: unknown): { text: string } | "silent" | "failed" {
  const result = record(raw);
  if (typeof result.text !== "string") return "failed";
  const voiced = record(result.transcription_info).duration_after_vad;
  const segments = Array.isArray(result.segments) ? result.segments.map(record) : null;
  if (typeof voiced !== "number" && !segments) return "failed";
  if (typeof voiced === "number" && !(voiced >= MIN_VOICED_SECONDS)) return "silent";
  const words = segments
    ? segments.filter(spoken).map((segment) => segment.text as string).join(" ")
    : result.text;
  const text = words
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => char === "\u200c" || char === "\u200d" ? char : " ")
    .replace(/\s+/g, " ").trim();
  const plain = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return plain ? { text } : "silent";
}

async function ledger(
  env: KnowledgeEnv,
  body: Record<string, unknown>,
): Promise<CryptoVoiceResult> {
  const response = await knowledgeStub(env, DESK_ROOM).fetch(
    "https://knowledge.internal/managed/voice",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: DESK_ROOM, ...body }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("crypto-voice-ledger");
  }
  return (await response.json()) as CryptoVoiceResult;
}

/** Templ's spend meter (`managed-spend:v1`), the one every managed call holds against. */
async function operatingMeter(
  env: KnowledgeEnv,
  body: Record<string, unknown>,
): Promise<boolean> {
  const namespace = env.SUPPORT_KNOWLEDGE;
  if (!namespace) return false;
  const response = await namespace
    .get(namespace.idFromName(TEMPL_SPEND_OBJECT))
    .fetch("https://knowledge.internal/managed/spend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("crypto-voice-meter");
  }
  return ((await response.json()) as { ok?: boolean }).ok === true;
}

/** `admission` is the room's answer for this request's checked upload. */
export async function transcribeCryptoVoiceNote(
  env: VoiceEnv,
  admission: Response,
): Promise<Response> {
  if (!admission.ok) return admission;
  const note = env[CRYPTO_VOICE_NOTE];
  const binding = cryptoVoiceBinding(env);
  const admitted = await admission.json<{
    admitted?: unknown;
    principals?: unknown;
    network?: unknown;
  }>();
  if (!note || !binding || admitted.admitted !== true)
    throw new HttpError(404, "Support action not found.");
  const entry = {
    clientId: note.clientId,
    seconds: note.seconds,
    principals: admitted.principals,
    network: admitted.network ?? null,
  };
  const unavailable = () =>
    new HttpError(503, UNAVAILABLE, undefined, "voice-note-unavailable");
  let held: CryptoVoiceResult;
  try {
    held = await ledger(env, { op: "reserve", ...entry });
  } catch {
    throw unavailable();
  }
  if (!held.ok) {
    const [status, text] = REFUSALS[held.reason] ?? [503, UNAVAILABLE];
    return json(
      { error: text, reason: held.reason },
      status,
      held.retryAfter ? { "Retry-After": String(held.retryAfter) } : {},
    );
  }
  // Templ's operating cap across every workspace holds the same cost, as it
  // does for the desk's answers. It fails closed, before any model call.
  const cents = cryptoVoiceCents(note.seconds);
  const operating = { month: spendMonth(Date.now()), id: crypto.randomUUID(), cents };
  const capped = await operatingMeter(env, {
    op: "reserve",
    ...operating,
    cap: templCapCents(env),
  }).catch(() => false);
  if (!capped) {
    await ledger(env, { op: "release", ...entry }).catch(() => undefined);
    throw new HttpError(503, UNAVAILABLE, undefined, "voice-note-budget");
  }
  // From here the cost is booked whatever the model answers. A booking that
  // cannot be confirmed now is booked in full when its hold runs out.
  let raw: unknown = null;
  try {
    raw = await binding.ai.run(
      CRYPTO_VOICE_MODEL,
      {
        audio: cryptoVoiceBase64(note.bytes),
        task: "transcribe",
        vad_filter: true,
        condition_on_previous_text: false,
      },
      {
        signal: AbortSignal.timeout(CALL_MS),
        gateway: {
          id: binding.gatewayId,
          collectLog: false,
          skipCache: true,
          requestTimeoutMs: CALL_MS,
          retries: { maxAttempts: 1 },
        },
      },
    );
  } catch {
    console.error("TEMPL_CRYPTO_VOICE_FAILURE");
  }
  await ledger(env, { op: "settle", ...entry }).catch(() => undefined);
  await operatingMeter(env, { op: "settle", ...operating }).catch(() => undefined);
  const transcript = cryptoVoiceTranscript(raw);
  if (transcript === "failed")
    throw new HttpError(
      503,
      "Templ could not transcribe this voice note. Try again or type your question.",
      undefined,
      "voice-note-unavailable",
    );
  if (transcript === "silent")
    throw new HttpError(
      422,
      "Templ could not hear any words. Record it again or type your question.",
      undefined,
      "voice-note-silent",
    );
  const { text } = transcript;
  // Speech arrives with capitals and commas a typed phrase would not have.
  await refusePhrase(text, "sent");
  await refusePhrase(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), "sent");
  if (new TextEncoder().encode(text).length > OPERATIONAL_LIMITS.messageMaxBytes)
    throw new HttpError(
      422,
      "This voice note is too long to send. Record a shorter one.",
      undefined,
      "voice-note-too-long",
    );
  return json({ text });
}
