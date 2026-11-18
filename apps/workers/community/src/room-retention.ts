/** Current group history has no count-based retention quota. Group-message
 * writes stop before the provider storage ceiling; Support has its own policy. */
import { OPERATIONAL_LIMITS } from "@templ/chat/plans";
import { HttpError } from "./common";
import { reactionsKeyForMessage } from "./message-reactions";

type Storage = Pick<
  DurableObjectTransaction,
  "delete" | "get" | "list" | "put"
>;
export type MessageDeleteHook = (
  channel: string,
  id: string,
) => Promise<void> | void;

export const GROUP_STORAGE_CAPACITY_ERROR =
  "This community's storage needs attention. Existing messages remain readable while new posts wait.";
export const GROUP_STORAGE_CAPACITY_REASON = "provider-capacity";

/** Delete one group message and its derived state. Historical retention-index
 * records are deliberately left untouched; current runtime never reads them. */
export async function recordPooledMessageDeletion(
  storage: Storage,
  channel: string,
  key: string,
  onDelete?: MessageDeleteHook,
) {
  const id = key.slice(key.lastIndexOf(":") + 1).replace(/^0+/, "") || "0";
  await storage.delete(key);
  if (onDelete) await onDelete(channel, id);
  const reactions = reactionsKeyForMessage(key);
  if (reactions) await storage.delete(reactions);
  await storage.put(
    `channel-deletions:${channel}`,
    ((await storage.get<number>(`channel-deletions:${channel}`)) ?? 0) + 1,
  );
}

/** Fail closed unless the room's SQLite size was sampled immediately before
 * the transaction and remains below the provider headroom ceiling. */
export function groupStorageWriteLimitBytes(storagePlan?: string): number {
  return storagePlan === "paid"
    ? OPERATIONAL_LIMITS.groupStorageWriteLimitBytes
    : OPERATIONAL_LIMITS.groupStorageWriteLimitBytesFree;
}

export async function reserveGroupStorage(
  databaseBytes: number | undefined,
  storagePlan?: string,
): Promise<void> {
  if (!Number.isSafeInteger(databaseBytes) || (databaseBytes as number) < 0)
    throw new HttpError(
      503,
      "Community storage could not be checked. Try again.",
      30,
      GROUP_STORAGE_CAPACITY_REASON,
    );
  if ((databaseBytes as number) >= groupStorageWriteLimitBytes(storagePlan))
    throw new HttpError(
      503,
      GROUP_STORAGE_CAPACITY_ERROR,
      60,
      GROUP_STORAGE_CAPACITY_REASON,
    );
}
