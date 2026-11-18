/** The storage recovery routes every restorable object shares: bookmarks,
 * restore, abort, and a support partition's own routes. Kept apart from the
 * room's reconcile so the partition class loads nothing else. */
import { HttpError, json, readJson } from "./common";

/** The storage calls a restore uses (`@cloudflare/workers-types`). */
export type RecoveryStorage = DurableObjectStorage;
export type RecoveryObjectState = {
  storage: RecoveryStorage;
  abort(reason?: string): void;
  id?: { toString(): string };
};
/** When a support partition was first written. Partitions made before this
 * key existed have none. */
export const PARTITION_CREATED_KEY = "recovery-created-at-v1";
type Bookmarks = Pick<
  RecoveryStorage,
  "getCurrentBookmark" | "getBookmarkForTime" | "onNextSessionRestoreBookmark"
>;
export function bookmarkApi(storage: RecoveryStorage): Bookmarks {
  if (
    typeof storage.getCurrentBookmark !== "function" ||
    typeof storage.getBookmarkForTime !== "function" ||
    typeof storage.onNextSessionRestoreBookmark !== "function"
  )
    throw new HttpError(503, "Point-in-time recovery is unavailable.");
  return storage;
}
export const bookmarkText = (value: unknown) => {
  if (typeof value !== "string" || !value || value.length > 1000)
    throw new HttpError(400, "Invalid bookmark.");
  return value;
};
export const atTime = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new HttpError(400, "Invalid recovery time.");
  return value as number;
};

/** Errors as JSON with their status, like every other private route. */
export async function answered(
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError)
      return json(
        error.reason
          ? { error: error.message, reason: error.reason }
          : { error: error.message },
        error.status,
      );
    throw error;
  }
}

/** A support partition's `/private/recovery/*` routes. The caller names the
 * partition exactly as the room does; a partition that was never written
 * answers `exists: false`. */
export function partitionRecoveryRoute(
  state: RecoveryObjectState,
  request: Request,
): Promise<Response> {
  return answered(() => partitionRoute(state, request));
}
async function partitionRoute(
  state: RecoveryObjectState,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Not found." }, 404);
  const path = new URL(request.url).pathname.slice("/private/recovery/".length);
  const body = await readJson(request, 8_192);
  const identity = await state.storage.get<{
    room: string;
    capability: string;
    partition: string;
    mode: string;
  }>("identity");
  if (!identity) return json({ exists: false });
  if (
    identity.room !== body.room ||
    identity.capability !== body.capability ||
    identity.partition !== body.partition ||
    identity.mode !== body.mode
  )
    throw new HttpError(403, "Partition access denied.");
  switch (path) {
    case "bookmark": {
      const at = atTime(body.at);
      const api = bookmarkApi(state.storage);
      let target: string | null = null;
      try {
        target = await api.getBookmarkForTime(at);
      } catch {
        target = null;
      }
      return json({
        exists: true,
        target,
        current: await api.getCurrentBookmark(),
        createdAt:
          (await state.storage.get<number>(PARTITION_CREATED_KEY)) ?? null,
      });
    }
    case "current":
      return json({
        exists: true,
        current: await bookmarkApi(state.storage).getCurrentBookmark(),
      });
    case "restore":
      return json({
        exists: true,
        undo: await bookmarkApi(state.storage).onNextSessionRestoreBookmark(
          bookmarkText(body.bookmark),
        ),
      });
    case "abort":
      state.abort("storage recovery");
      return json({ aborted: true }, 202);
    case "delete-orphan":
      // Written only after the restore point: nothing at T to keep.
      await state.storage.deleteAll();
      return json({ exists: false, deleted: true });
    default:
      return json({ error: "Not found." }, 404);
  }
}

/** Called once, when a partition is first written. */
export async function markPartitionCreated(
  storage: Pick<DurableObjectTransaction, "put">,
  now = Date.now(),
) {
  await storage.put(PARTITION_CREATED_KEY, now);
}
