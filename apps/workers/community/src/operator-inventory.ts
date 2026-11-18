/** Read-only inventory of the retained group files.
 *
 * Files from group chat stay in the private media bucket under `group/`
 * until the drain in group-attachment-cleanup.ts
 * deletes them. No tool could prove the bucket holds none, so this route
 * counts them for Templ operators: how many, how many bytes, and the oldest
 * and newest upload times. It lists keys and reads object metadata only; it
 * never reads a body, returns a key or deletes anything. There is no delete
 * path here, and a purge needs its own reviewed change (RETIRED-STATE.md in
 * apps/scripts/src/release). */
import { HttpError, json, type Env } from "./common";
import { GROUP_ATTACHMENT_OBJECT_PREFIX } from "./group-attachment-cleanup";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import { sessionPrincipals, type ServiceSession } from "./service-principals";

export const GROUP_FILE_INVENTORY_PATH = "/operator/inventory/group-files";
/** Bucket list pages read per request, 1,000 keys each. */
export const GROUP_INVENTORY_PAGES = 20;
const OBJECT_KEY = new RegExp(
  `^${GROUP_ATTACHMENT_OBJECT_PREFIX}[0-9a-f]{64}$`,
);
/** R2 list cursors are opaque; this bounds what the route passes on. */
const CURSOR = /^[A-Za-z0-9+/=_-]{1,1024}$/;

export type GroupFileInventoryPage = {
  schemaVersion: 1;
  prefix: typeof GROUP_ATTACHMENT_OBJECT_PREFIX;
  objects: number;
  bytes: number;
  /** Keys under the prefix that don't name a group file id. */
  otherKeys: number;
  oldestUploaded: string | null;
  newestUploaded: string | null;
  /** Pass as `cursor` to read on; null when the listing is complete. */
  cursor: string | null;
};
type InventoryEnv = OperatorAdminEnv & Pick<Env, "MEDIA_BUCKET">;

export async function operatorInventoryRoute<S extends ServiceSession>(
  request: Request,
  env: InventoryEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GROUP_FILE_INVENTORY_PATH) return null;
  const session = await auth.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(403, "This page is for Templ operators.");
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  const start = url.searchParams.get("cursor");
  if (start !== null && !CURSOR.test(start))
    throw new HttpError(400, "Start the count again.");
  if (!env.MEDIA_BUCKET)
    throw new HttpError(503, "File storage is unavailable.");
  return json(await countGroupFiles(env.MEDIA_BUCKET, start));
}

/** Counts up to `GROUP_INVENTORY_PAGES` list pages from `cursor`. */
export async function countGroupFiles(
  bucket: Pick<R2Bucket, "list">,
  cursor: string | null,
): Promise<GroupFileInventoryPage> {
  const page: GroupFileInventoryPage = {
    schemaVersion: 1,
    prefix: GROUP_ATTACHMENT_OBJECT_PREFIX,
    objects: 0,
    bytes: 0,
    otherKeys: 0,
    oldestUploaded: null,
    newestUploaded: null,
    cursor,
  };
  let oldest = Infinity,
    newest = -Infinity;
  for (let read = 0; read < GROUP_INVENTORY_PAGES; read++) {
    let listed: R2Objects;
    try {
      listed = await bucket.list({
        prefix: GROUP_ATTACHMENT_OBJECT_PREFIX,
        limit: 1000,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
    } catch {
      throw new HttpError(503, "File storage is unavailable.");
    }
    for (const object of listed.objects) {
      if (!OBJECT_KEY.test(object.key)) {
        page.otherKeys++;
        continue;
      }
      page.objects++;
      page.bytes += Number.isSafeInteger(object.size) ? object.size : 0;
      const at = object.uploaded?.getTime?.();
      if (Number.isFinite(at)) {
        oldest = Math.min(oldest, at!);
        newest = Math.max(newest, at!);
      }
    }
    page.cursor = listed.truncated ? listed.cursor : null;
    if (!page.cursor) break;
  }
  if (Number.isFinite(oldest))
    page.oldestUploaded = new Date(oldest).toISOString();
  if (Number.isFinite(newest))
    page.newestUploaded = new Date(newest).toISOString();
  return page;
}
