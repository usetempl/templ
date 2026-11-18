import { HttpError, json } from "./common";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "list" | "delete"
>;
const INDEX = "product-billing-workspace-v1:";
const ARCHIVE = "product-billing-tracking-archive-v1:";
const META = "product-billing-tracking-v1";
const OPERATION = "product-billing-tracking-operation-v1:";
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Meta = { revision: number; names: Record<string, string> };
export const BILLING_TRACKING_START = "product-billing-tracking-start-v1";

export async function billingTrackingMeta(
  storage: Pick<Storage, "get">,
): Promise<Meta> {
  return (await storage.get<Meta>(META)) ?? { revision: 0, names: {} };
}
export async function billingTrackingRegister(
  storage: Storage,
  workspace: string,
) {
  if (await storage.get(ARCHIVE + workspace)) return;
  const key = INDEX + workspace;
  if (await storage.get(key)) return;
  const meta = await billingTrackingMeta(storage);
  await storage.put(key, Date.now());
  await storage.put(META, { ...meta, revision: meta.revision + 1 });
}

/** Runs inside the billing index transaction. Archives retain the original index entry. */
export async function updateBillingTracking(
  storage: Storage,
  body: Record<string, unknown>,
) {
  const {
    operationId,
    expectedRevision,
    archive,
    restore,
    names,
    operator,
    reason,
  } = body;
  const validIds = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((id) => typeof id === "string" && WORKSPACE.test(id)) &&
    new Set(value).size === value.length;
  if (
    typeof operationId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(operationId) ||
    !Number.isSafeInteger(expectedRevision) ||
    !validIds(archive) ||
    !validIds(restore) ||
    archive.some((id) => restore.includes(id)) ||
    !names ||
    typeof names !== "object" ||
    Array.isArray(names) ||
    typeof operator !== "string" ||
    !operator ||
    typeof reason !== "string" ||
    reason.trim().length < 3 ||
    reason.length > 280
  )
    throw new HttpError(400, "Choose valid billing tracking changes.");
  const labels = names as Record<string, unknown>;
  if (
    Object.keys(labels).length > 100 ||
    Object.entries(labels).some(
      ([id, name]) =>
        !WORKSPACE.test(id) ||
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 80 ||
        archive.includes(id),
    )
  )
    throw new HttpError(400, "Choose valid workspace names.");
  const payload = JSON.stringify({
    expectedRevision,
    archive,
    restore,
    names,
    operator,
    reason,
  });
  const key = OPERATION + operationId;
  const existing = await storage.get<{ payload: string; result: unknown }>(key);
  if (existing) {
    if (existing.payload !== payload)
      throw new HttpError(
        409,
        "This tracking action already has different changes.",
      );
    return json(existing.result);
  }
  const meta = await billingTrackingMeta(storage);
  if (meta.revision !== expectedRevision)
    throw new HttpError(
      409,
      "The billing list changed. Reload it before continuing.",
    );
  const at = Date.now();
  for (const workspace of archive) {
    const listedAt = await storage.get<number>(INDEX + workspace);
    if (listedAt === undefined)
      throw new HttpError(409, "A workspace left the billing list. Reload it.");
    await storage.put(ARCHIVE + workspace, {
      listedAt,
      archivedAt: at,
      operator,
      reason,
      operationId,
    });
    await storage.delete(INDEX + workspace);
  }
  for (const workspace of restore) {
    const saved = await storage.get<{ listedAt: number }>(ARCHIVE + workspace);
    if (!saved)
      throw new HttpError(409, "This workspace has no archived billing entry.");
    await storage.put(INDEX + workspace, saved.listedAt);
    await storage.delete(ARCHIVE + workspace);
  }
  for (const id of Object.keys(labels))
    if ((await storage.get(INDEX + id)) === undefined)
      throw new HttpError(409, "Name a workspace in the billing list.");
  const next: Meta = {
    revision: meta.revision + 1,
    names: { ...meta.names, ...labels } as Record<string, string>,
  };
  await storage.put(META, next);
  const result = {
    revision: next.revision,
    archived: archive.length,
    restored: restore.length,
    at,
  };
  await storage.put(key, { payload, result });
  return json(result);
}
