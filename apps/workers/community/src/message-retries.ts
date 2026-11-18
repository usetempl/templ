import { HttpError } from "./common";
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
export const messageClientPrefix = "message-client:";
export const MESSAGE_RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export type MessageClientRecord = {
  messageId: number;
  textHash: string;
  replyTo?: string;
  /** A new-case retry is indexed by the previous case and its message ID. */
  newConversationId?: string;
};
export function messageClientId(value: unknown, now: number) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      value,
    )
  )
    throw new HttpError(400, "Invalid message ID.");
  const clientId = value.toLowerCase();
  const timestampHex = clientId.slice(0, 8) + clientId.slice(9, 13);
  const timestamp = Number.parseInt(timestampHex, 16);
  if (timestamp > now + 60_000)
    throw new HttpError(400, "The message time is ahead of the server.");
  if (timestamp <= now - MESSAGE_RETRY_WINDOW_MS)
    throw new HttpError(410, "This message expired. Send it as a new message.");
  return { clientId, timestampHex };
}
export async function messageTextHash(text: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** Deleted message bodies are not copied into retry records. UUID time rejects
 * expired retries even after bounded, lazy removal of their deduplication rows. */
export async function pruneMessageClients(storage: Storage, now: number) {
  const before = Math.max(0, now - MESSAGE_RETRY_WINDOW_MS + 1)
    .toString(16)
    .padStart(12, "0");
  const expired = await storage.list<MessageClientRecord>({
    prefix: messageClientPrefix,
    end: `${messageClientPrefix}${before}:`,
    limit: 32,
  });
  let count = (await storage.get<number>("message-client-count")) ?? 0;
  for (const key of expired.keys()) await storage.delete(key);
  count = Math.max(0, count - expired.size);
  if (expired.size) await storage.put("message-client-count", count);
  return count;
}
