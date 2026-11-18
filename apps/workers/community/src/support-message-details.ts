import type { ChatMessage } from "@templ/chat/index";
import { parseSupportContextInput } from "@templ/chat/support-context";
import { messageKey } from "./message-store";

export type SharedMessageDetails = {
  sharedDetails: number;
  sharedDetailKeys: string[];
};

/** Field keys make retries and context updates count each shared row once. */
export function sharedMessageDetails(input: unknown): SharedMessageDetails {
  const parsed = parseSupportContextInput(input);
  const keys = new Set<string>();
  const appKeys = (prefix: string, app: object | undefined) => {
    for (const field of Object.keys(app ?? {}))
      if (field !== "sdk") keys.add(`${prefix}${field}`);
  };
  if (parsed.description) keys.add("description");
  if (parsed.network) keys.add("network");
  for (const tx of parsed.transactions) keys.add(`transaction:${tx.hash}`);
  appKeys("app:", parsed.app);
  for (const snapshot of parsed.snapshots ?? []) {
    const prefix = `snapshot:${snapshot.id}:`;
    if (snapshot.wallet.address) keys.add(`${prefix}wallet`);
    if (snapshot.network) keys.add(`${prefix}network`);
    if (snapshot.failure) keys.add(`${prefix}failure`);
    appKeys(`${prefix}app:`, snapshot.app);
  }
  return { sharedDetails: keys.size, sharedDetailKeys: [...keys] };
}

/** The API carries the count; field keys stay with the stored message. */
export function publicMessageDetails(message: ChatMessage): ChatMessage {
  const { sharedDetailKeys: _keys, ...publicMessage } = message as ChatMessage &
    Partial<SharedMessageDetails>;
  return publicMessage;
}

/** A context write follows its member message. Bind the marker to that
 * stored message, even when a team reply arrived between the two writes. */
export async function markSharedMessageDetails(
  storage: Pick<DurableObjectTransaction, "list" | "put">,
  thread: string,
  memberMessageAt: number | null,
  memberAliases: readonly string[],
  input: unknown,
): Promise<void> {
  const details = sharedMessageDetails(input);
  if (!details.sharedDetails || memberMessageAt === null) return;
  const rows = await storage.list<ChatMessage & Partial<SharedMessageDetails>>({
    prefix: `channel-message:${thread}:`,
    reverse: true,
    limit: 100,
  });
  for (const row of rows.values()) {
    const at = Date.parse(row.createdAt);
    if (at < memberMessageAt) return;
    if (
      at !== memberMessageAt ||
      !memberAliases.includes(row.author) ||
      "deletedAt" in row
    )
      continue;
    const fields = new Set([
      ...(row.sharedDetailKeys ?? []),
      ...details.sharedDetailKeys,
    ]);
    await storage.put(messageKey(thread, Number(row.id)), {
      ...row,
      sharedDetails: fields.size,
      sharedDetailKeys: [...fields],
    });
    return;
  }
}
