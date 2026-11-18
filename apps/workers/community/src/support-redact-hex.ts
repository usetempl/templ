import { ambiguousHexValues, hideAmbiguousHex } from "@templ/chat/support-safety-hex";
import { HttpError, json } from "./common";
import { canReadConversation, type ConversationContext } from "./team-conversations";
import { historyKey, messageKey, type MessageHistory, type StoredMessage } from "./message-store";
import { sharedTransactionHashes } from "./support-secret-sinks";

type Storage = Pick<DurableObjectTransaction, "get" | "put" | "list" | "delete">;
/** A current support lead removes ambiguous hex from the message and every revision. */
export async function redactHexRoute(storage: Storage, context: ConversationContext): Promise<Response | null> {
  const match = /^\/conversations\/(tc-[0-9a-f]{32})\/messages\/([1-9][0-9]{0,14})\/redact$/.exec(context.pathname);
  if (!match) return null;
  const [, thread, messageId] = match;
  const viewer = context.viewer;
  if (context.method !== "POST" || !viewer.principalId || context.isBot ||
    context.headers.get("X-Support-Widget") === "member" ||
    !(viewer.isManager || viewer.permissions.includes("manageSupport")) ||
    !(await canReadConversation(storage, context, thread)))
    throw new HttpError(404, "Support action not found.");
  const key = messageKey(thread, Number(messageId));
  const message = await storage.get<StoredMessage>(key);
  if (!message) throw new HttpError(404, "Message not found.");
  const shared = await sharedTransactionHashes(storage, thread);
  const history = await storage.get<MessageHistory>(historyKey(thread, Number(messageId)));
  const count = ambiguousHexValues(message.text, shared).length;
  const revisions = history?.revisions.map((revision) => ({ ...revision, text: hideAmbiguousHex(revision.text, shared) }));
  const historyChanged = revisions?.some((revision, index) => revision.text !== history!.revisions[index].text) ?? false;
  if (!count && !historyChanged) return json({ redacted: false });
  const next = { ...message, text: hideAmbiguousHex(message.text, shared), revision: (message.revision ?? 1) + 1, editedAt: new Date(context.now).toISOString() };
  await storage.put(key, next);
  if (history && revisions) await storage.put(historyKey(thread, Number(messageId)), { ...history, revisions });
  await context.searchIndex.upsert(thread, next);
  context.pendingAudit.push({ actor: viewer.principalId, action: "support.hex.redacted", channelId: thread, messageId, after: { count, historyChanged } });
  context.pending.push({ type: "message.edited", channelId: thread, message: next });
  return json({ redacted: true });
}
