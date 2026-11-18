import { hideAmbiguousHex } from "@templ/chat/support-safety-hex";
import type { ChatEvent } from "@templ/chat/events";
import { readStoredSupportContext } from "@templ/chat/support-context";
type ReadStorage = Pick<DurableObjectStorage, "get">;
/** Only hashes in the member's typed context are disclosed outside the inbox. */
export async function sharedTransactionHashes(storage: ReadStorage, thread: string): Promise<string[]> {
  const workflow = await storage.get<{ context?: unknown }>(`support-workflow-v1:${thread}`);
  if (!workflow?.context) return [];
  try {
    const context = readStoredSupportContext(workflow.context);
    return context && context !== "unreadable" ? context.transactions?.map((tx) => tx.hash) ?? [] : [];
  } catch { return []; }
}
const TEXT_FIELDS = new Set(["text", "description", "summary", "title", "body", "instruction", "note", "preview", "name", "displayName", "memberLine", "question", "answer", "excerpt", "message", "value", "label", "sourceLabel", "publicLabel", "page", "url", "code", "period", "connector", "appVersion", "device", "place", "unit", "hash", "signature"]);
/** Payload structure, ids and source hashes stay intact; every free-text field is screened. */
export function hideAmbiguousPayload<T>(value: T, sharedHashes: readonly string[] = [], key = ""): T {
  if (typeof value === "string") return (TEXT_FIELDS.has(key) ? hideAmbiguousHex(value, sharedHashes) : value) as T;
  if (Array.isArray(value)) return value.map((entry) => hideAmbiguousPayload(entry, sharedHashes, key)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, hideAmbiguousPayload(entry, sharedHashes, name)])) as T;
  return value;
}
export async function hideEventHex(storage: ReadStorage, event: ChatEvent): Promise<ChatEvent> {
  return hideAmbiguousPayload(event, event.channelId ? await sharedTransactionHashes(storage, event.channelId) : []);
}
/** A search presentation whose rendered results hide ambiguous hex. */
export function hexHiddenSearch<Rows, P extends { render(channel: string, rows: Rows): Promise<unknown[]> }>(storage: ReadStorage, presentation: P): P {
  return {
    ...presentation,
    render: async (channel: string, rows: Rows) =>
      hideAmbiguousPayload(await presentation.render(channel, rows), await sharedTransactionHashes(storage, channel)),
  };
}
