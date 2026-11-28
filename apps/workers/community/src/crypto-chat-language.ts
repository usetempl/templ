import { isCryptoLanguage } from "@templ/chat/crypto-languages";
import type { ChatMessage } from "@templ/chat/index";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { HttpError } from "./common";
import type { ConversationContext } from "./team-conversations";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";

/** The chat language a visitor chose on the public crypto desk's hosted page.
 * A member's send carries an allowlisted code; the room keeps one record per
 * thread for the member's latest message in the current case, and the runner
 * reads it bound to that message. The code is the only value stored. Staff
 * views, exports, alerts and other workspaces never read it. */

const DESK_ORIGIN = "https://usetempl.com";
const DESK_ROOM = "room:" + CRYPTO_SUPPORT_WORKSPACE;
export const CRYPTO_CHAT_LANGUAGE_PREFIX = "crypto-chat-language-v1:";
type Stored = { v: 1; case: number; message: string; code: string };
type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;
export type CryptoChatLanguageState = {
  latest: { id: string; revision: number };
  code: string | null;
};

/** The public widget policy offers the choice only on the desk's own hosted page. */
export function cryptoChatLanguageOn(env: WorkspaceFlagEnv, room: string, origin: string) {
  return room === CRYPTO_SUPPORT_WORKSPACE && origin === DESK_ORIGIN &&
    env.APP_ORIGIN === origin && featureOn(env, undefined, "cryptoChatLanguage");
}

/** A member send's choice, checked before anything is written. Undefined
 * leaves the record alone, null clears it for this turn and a code records it.
 * Other workspaces, frames, embeds and app sessions ignore the field. */
export async function cryptoChatLanguageInput(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "room" | "isBot" | "appOrigin" | "headers" | "mediaEnv">,
  value: unknown,
): Promise<string | null | undefined> {
  if (
    context.room !== DESK_ROOM ||
    context.isBot ||
    context.appOrigin !== DESK_ORIGIN ||
    context.headers.get("X-Support-Widget") !== "member" ||
    context.headers.get("X-Support-Entry") !== "hosted" ||
    context.headers.get("X-Support-Widget-Frame") !== null ||
    context.headers.get("X-Support-Widget-Origin") !== DESK_ORIGIN ||
    !(await featureOn(context.mediaEnv, storage, "cryptoChatLanguage"))
  )
    return undefined;
  if (value === undefined) return null;
  if (!isCryptoLanguage(value))
    throw new HttpError(400, "Choose a listed language.", undefined, "chat-language");
  return value;
}

/** Runs in the message's own write. A retried send returns before this, so
 * the first accepted choice stays with its message. */
export async function saveCryptoChatLanguage(
  storage: Pick<Storage, "put" | "delete">,
  thread: string,
  seq: number,
  message: string,
  code: string | null,
) {
  const key = CRYPTO_CHAT_LANGUAGE_PREFIX + thread;
  if (code === null || !Number.isSafeInteger(seq) || seq < 1) await storage.delete(key);
  else await storage.put(key, { v: 1, case: seq, message, code } satisfies Stored);
}

/** What the runner reads for the thread's newest message: the stored code only
 * while that message is the one it was sent with, in the current case. */
export async function cryptoChatLanguageState(
  storage: Storage,
  context: Pick<ConversationContext, "room" | "appOrigin" | "mediaEnv">,
  thread: string,
  seq: number,
): Promise<CryptoChatLanguageState | null> {
  if (context.room !== DESK_ROOM || context.appOrigin !== DESK_ORIGIN || !seq ||
      !(await featureOn(context.mediaEnv, storage, "cryptoChatLanguage")))
    return null;
  const [latest] = (await storage.list<ChatMessage>({
    prefix: `channel-message:${thread}:`,
    reverse: true,
    limit: 1,
  })).values();
  if (!latest) return null;
  const stored = await storage.get<Stored>(CRYPTO_CHAT_LANGUAGE_PREFIX + thread);
  return {
    latest: { id: latest.id, revision: latest.revision ?? 1 },
    code: stored?.v === 1 && stored.case === seq && stored.message === latest.id && isCryptoLanguage(stored.code)
      ? stored.code
      : null,
  };
}

export async function deleteThreadCryptoChatLanguage(storage: Pick<Storage, "delete">, room: string, thread: string) {
  if (room === DESK_ROOM) await storage.delete(CRYPTO_CHAT_LANGUAGE_PREFIX + thread);
}
