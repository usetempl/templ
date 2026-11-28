import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { HttpError, json } from "./common";
import type { CryptoVoiceNote } from "./crypto-voice-wav";
import { sponsoredSupport } from "./product-prepaid";
import { newCaseEncryptionView } from "./support-encryption";
import type { ConversationContext } from "./team-conversations";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";

/** Voice notes on the public crypto desk's own hosted page. The page uploads
 * one short recording and gets its words back. Templ keeps neither: the words
 * enter a chat only when the visitor sends them as an ordinary message.
 *
 * The widget route checks the session and the upload, the room admits the
 * visitor under its own flag, sponsorship and access records, and the desk's
 * knowledge object holds the cost (managed-agent/crypto-voice-ledger.ts).
 * Frames, embeds, app sessions, encrypted chats and every other workspace get
 * the unknown-route answer. */

const DESK_ORIGIN = "https://usetempl.com";
const DESK_ROOM = "room:" + CRYPTO_SUPPORT_WORKSPACE;
export const CRYPTO_VOICE_WIDGET_PATH = "/voice/transcribe";
export const CRYPTO_VOICE_ROOM_PATH = "/conversations/voice-notes";
/** Set by the worker's room route for a checked upload; never read from a caller. */
export const CRYPTO_VOICE_HEADER = "X-Support-Voice-Note";
/** The checked upload, carried beside the widget scope and never serialized. */
export const CRYPTO_VOICE_NOTE = Symbol("crypto-voice-note");
export type CryptoVoiceEnv = { [CRYPTO_VOICE_NOTE]?: CryptoVoiceNote };
type BindingEnv = { AI?: Pick<Ai, "run">; MANAGED_AGENT_GATEWAY_ID?: string };

export function cryptoVoiceBinding(env: BindingEnv) {
  return env.AI && /^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")
    ? { ai: env.AI, gatewayId: env.MANAGED_AGENT_GATEWAY_ID! }
    : null;
}

export function cryptoVoiceNotesOn(
  env: WorkspaceFlagEnv & BindingEnv,
  room: string,
  origin: string,
) {
  return Boolean(CRYPTO_SUPPORT_WORKSPACE) && room === CRYPTO_SUPPORT_WORKSPACE && origin === DESK_ORIGIN &&
    env.APP_ORIGIN === origin && cryptoVoiceBinding(env) !== null &&
    featureOn(env, undefined, "cryptoVoiceNotes");
}

/** The room's answer for one checked upload: the identities the visitor acts
 * as, for the ledger's limits. It reads the room's own records and writes
 * nothing. The worker replaces this answer before anything reaches a browser. */
export async function cryptoVoiceAdmission(
  storage: Pick<DurableObjectTransaction, "get">,
  context: Pick<
    ConversationContext,
    "method" | "room" | "isBot" | "appOrigin" | "headers" | "mediaEnv" | "viewer" | "aliases"
  >,
): Promise<Response> {
  const { headers, viewer } = context;
  if (
    context.method !== "POST" ||
    context.room !== DESK_ROOM ||
    context.isBot ||
    !viewer.principalId ||
    context.appOrigin !== DESK_ORIGIN ||
    headers.get(CRYPTO_VOICE_HEADER) !== "1" ||
    headers.get("X-Support-Widget") !== "member" ||
    headers.get("X-Support-Entry") !== "hosted" ||
    headers.get("X-Support-Widget-Frame") !== null ||
    headers.get("X-Support-Widget-Origin") !== DESK_ORIGIN ||
    !(await featureOn(context.mediaEnv, storage, "cryptoVoiceNotes")) ||
    !(await sponsoredSupport(storage)) ||
    (await newCaseEncryptionView(storage))
  )
    throw new HttpError(404, "Support action not found.");
  if (viewer.banned)
    throw new HttpError(403, "You are banned from posting in this chat.");
  if (viewer.mutedUntil)
    throw new HttpError(403, "You are muted in this chat.");
  return json({
    admitted: true,
    principals: context.aliases,
    network: headers.get("X-Client-IP-Digest"),
  });
}
