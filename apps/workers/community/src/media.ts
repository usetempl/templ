import { HttpError, json, readBytes, siteOrigins, type Env } from "./common";
import { normalizePng } from "./image-normalize";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { principal } from "./principal";
import { SUPPORT_LIMITS, type SupportAttachment } from "@templ/chat/support";
import { NATIVE_ROOM_PILOT_LIMIT } from "./native-room-limits";
import { observeCostWorkload } from "./cost-observability";
import { groupAttachmentCleanupAlarm } from "./group-attachment-cleanup";
import { groupAttachmentQuotaRequest } from "./group-attachments";

export const MAX_MEDIA_BYTES = 96 * 1024;
export const DAILY_MEDIA_LIMIT = 10;
export const MAX_ACCOUNT_MEDIA_BYTES = 32 * 1024 * 1024;
export const MAX_ACCOUNT_MEDIA_OBJECTS = 128;
export const MAX_STAGED_MEDIA_OBJECTS = 4;
export const STAGED_MEDIA_TTL = 24 * 60 * 60_000;
export const MEDIA_BUDGET_SHARDS = 64;
export const MAX_SERVICE_MEDIA_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_SERVICE_MEDIA_OBJECTS = 131_072;
/** A paid room can retain 1 GiB of screenshots. The service admits at most
 * 5,000 rooms, so this ceiling can cover every room's published allowance.
 * The separate object ceiling bounds small-file operation and ledger costs. */
export const MAX_SERVICE_SUPPORT_BYTES =
  NATIVE_ROOM_PILOT_LIMIT * SUPPORT_LIMITS.fundedScreenshotStorageBytes;
export const MAX_SERVICE_SUPPORT_OBJECTS = NATIVE_ROOM_PILOT_LIMIT * 8_192;
export const MEDIA_OBJECT_PREFIX = "media/";
export const SUPPORT_MEDIA_OBJECT_PREFIX = "support/";
export const SUPPORT_MEDIA_COMMIT_ID_HEADER = "X-Support-Media-Commit-Id";
export const SUPPORT_MEDIA_COMMIT_BYTES_HEADER = "X-Support-Media-Commit-Bytes";
/** Types an account image object may have. Uploads are always re-encoded
 * PNG; stored JPEG and WebP objects stay readable, referable and deletable
 * under the same checks. */
const ACCOUNT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AccountImageType = (typeof ACCOUNT_IMAGE_TYPES)[number];
const MAX_ACCOUNT_IMAGE_BYTES = 256 * 1024;
const DAY = 24 * 60 * 60_000;
const HASH = /^[0-9a-f]{64}$/;
type ObjectImageType = AccountImageType;
type UploadAttempt = { time: number; bytes: number };
type MediaRecord = {
  bytes: number;
  contentHash: string;
  contentType: ObjectImageType;
  stagedUntil: number | null;
  deleting?: boolean;
};
type MediaLedger = {
  objects: Record<string, MediaRecord>;
  references: Record<string, string>;
  referenceRevisions: Record<string, string>;
};
type ServiceMediaEntry = {
  bytes: number;
  kind: "public" | "support";
  status: "reserved" | "committed" | "deleting";
  expiresAt: number | null;
  support?: {
    room: string;
    conversation: string;
    attachment: string;
    contentHash: string;
  };
};
type ServiceMediaBudget = {
  version: 2;
  bytes: number;
  objects: number;
  publicBytes: number;
  publicObjects: number;
  supportBytes: number;
  supportObjects: number;
};
const sameSupportReservation = (
  left: ServiceMediaEntry["support"],
  right: ServiceMediaEntry["support"],
) =>
  Boolean(
    left &&
    right &&
    left.room === right.room &&
    left.conversation === right.conversation &&
    left.attachment === right.attachment &&
    left.contentHash === right.contentHash,
  );
const EMPTY_LEDGER = (): MediaLedger => ({
  objects: {},
  references: {},
  referenceRevisions: {},
});
const EMPTY_BUDGET = (): ServiceMediaBudget => ({
  version: 2,
  bytes: 0,
  objects: 0,
  publicBytes: 0,
  publicObjects: 0,
  supportBytes: 0,
  supportObjects: 0,
});
const MEDIA_REFERENCE =
  /^(?:profile|room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::(?:founder|assistant))?)$/;
const SUPPORT_ROOM =
  /^room:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const SUPPORT_CONVERSATION = /^tc-[0-9a-f]{32}$/;
const SUPPORT_ATTACHMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SERVICE_RESERVATION_TTL = 15 * 60_000;
const SERVICE_RETRY_DELAY = 60_000;
const SERVICE_CLEANUP_BATCH = 32;
const MAX_SHARD_MEDIA_BYTES = MAX_SERVICE_MEDIA_BYTES / MEDIA_BUDGET_SHARDS;
const MAX_SHARD_MEDIA_OBJECTS = MAX_SERVICE_MEDIA_OBJECTS / MEDIA_BUDGET_SHARDS;
const MAX_SHARD_SUPPORT_BYTES = MAX_SERVICE_SUPPORT_BYTES / MEDIA_BUDGET_SHARDS;
const MAX_SHARD_SUPPORT_OBJECTS =
  MAX_SERVICE_SUPPORT_OBJECTS / MEDIA_BUDGET_SHARDS;
const BUDGET_ENTRY_PREFIX = "budget-entry-v2:";
const BUDGET_DUE_PREFIX = "budget-due-v2:";
const budgetEntryKey = (id: string) => `${BUDGET_ENTRY_PREFIX}${id}`;
const budgetDueKey = (id: string, expiresAt: number) =>
  `${BUDGET_DUE_PREFIX}${String(expiresAt).padStart(16, "0")}:${id}`;
function validBudget(value: ServiceMediaBudget) {
  const counts = [
    value.bytes,
    value.objects,
    value.publicBytes,
    value.publicObjects,
    value.supportBytes,
    value.supportObjects,
  ];
  return (
    value.version === 2 &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    value.bytes === value.publicBytes + value.supportBytes &&
    value.objects === value.publicObjects + value.supportObjects &&
    value.publicBytes <= MAX_SHARD_MEDIA_BYTES &&
    value.publicObjects <= MAX_SHARD_MEDIA_OBJECTS &&
    value.supportBytes <= MAX_SHARD_SUPPORT_BYTES &&
    value.supportObjects <= MAX_SHARD_SUPPORT_OBJECTS
  );
}
function budgetDueId(key: string) {
  return key.slice(key.lastIndexOf(":") + 1);
}
function budgetKindCounts(
  budget: ServiceMediaBudget,
  kind: ServiceMediaEntry["kind"],
) {
  return kind === "support"
    ? {
        bytes: budget.supportBytes,
        objects: budget.supportObjects,
        maxBytes: MAX_SHARD_SUPPORT_BYTES,
        maxObjects: MAX_SHARD_SUPPORT_OBJECTS,
      }
    : {
        bytes: budget.publicBytes,
        objects: budget.publicObjects,
        maxBytes: MAX_SHARD_MEDIA_BYTES,
        maxObjects: MAX_SHARD_MEDIA_OBJECTS,
      };
}
function changeBudget(
  budget: ServiceMediaBudget,
  entry: ServiceMediaEntry,
  sign: 1 | -1,
) {
  const bytes = entry.bytes * sign;
  budget.bytes += bytes;
  budget.objects += sign;
  if (entry.kind === "support") {
    budget.supportBytes += bytes;
    budget.supportObjects += sign;
  } else {
    budget.publicBytes += bytes;
    budget.publicObjects += sign;
  }
  if (
    budget.bytes < 0 ||
    budget.objects < 0 ||
    budget.publicBytes < 0 ||
    budget.publicObjects < 0 ||
    budget.supportBytes < 0 ||
    budget.supportObjects < 0
  )
    throw unavailable();
}
async function readBudget(storage: DurableObjectTransaction) {
  const raw = await storage.get<ServiceMediaBudget>("budget");
  if (!raw) return EMPTY_BUDGET();
  if (!validBudget(raw)) throw unavailable();
  return raw;
}
async function putBudgetEntry(
  storage: DurableObjectTransaction,
  id: string,
  previous: ServiceMediaEntry | undefined,
  next: ServiceMediaEntry | undefined,
) {
  if (previous?.expiresAt !== null && previous?.expiresAt !== undefined)
    await storage.delete(budgetDueKey(id, previous.expiresAt));
  if (next) {
    await storage.put(budgetEntryKey(id), next);
    if (next.expiresAt !== null)
      await storage.put(budgetDueKey(id, next.expiresAt), true);
  } else await storage.delete(budgetEntryKey(id));
}

async function readUpload(request: Request) {
  if (request.headers.has("Content-Encoding"))
    throw new HttpError(415, "Send the image without content encoding.");
  if (request.headers.get("Content-Type")?.trim().toLowerCase() !== "image/png")
    throw new HttpError(415, "Choose an image and crop it before uploading.");
  const bytes = await readBytes(request, MAX_MEDIA_BYTES);
  if (
    bytes.length < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    throw new HttpError(415, "Choose an image and crop it before uploading.");
  return bytes;
}
export async function mediaHash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Public ids are scoped to the canonical account as well as the content.
 * This lets one account's abandoned upload expire without deleting another
 * account's copy of the same bytes. */
export async function mediaObjectId(
  owner: ChatPrincipalId,
  contentHash: string,
) {
  if (!HASH.test(contentHash)) throw new Error("Invalid media hash.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${owner}\0${contentHash}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export type SupportMediaReference = {
  objectId: string;
  contentHash: string;
};
export type SupportMediaScope = {
  room: string;
  conversation: string;
  attachment: string;
};
function supportScope(scope: SupportMediaScope) {
  if (
    !SUPPORT_ROOM.test(scope.room) ||
    !SUPPORT_CONVERSATION.test(scope.conversation) ||
    !SUPPORT_ATTACHMENT.test(scope.attachment)
  )
    throw new HttpError(400, "Invalid screenshot reference.");
  return scope;
}
async function supportScopeHash(scope: SupportMediaScope) {
  supportScope(scope);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `support\0${scope.room}\0${scope.conversation}\0${scope.attachment}`,
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function supportMediaObjectId(scope: SupportMediaScope) {
  return supportScopeHash(scope);
}
function quotaNamespace(env: Env) {
  if (!env.MEDIA_QUOTAS) throw unavailable();
  return env.MEDIA_QUOTAS;
}
function quotaObject(env: Env, owner: ChatPrincipalId) {
  const quotas = quotaNamespace(env);
  return quotas.get(quotas.idFromName(`media-account-quota:${owner}`));
}
function objectStorage(env: Env) {
  if (!env.MEDIA_BUCKET)
    throw new HttpError(
      503,
      "Image storage is unavailable.",
      undefined,
      "media-storage-unavailable",
    );
  return env.MEDIA_BUCKET;
}
function objectKey(hash: string) {
  return `${MEDIA_OBJECT_PREFIX}${hash}`;
}
function supportObjectKey(hash: string) {
  return `${SUPPORT_MEDIA_OBJECT_PREFIX}${hash}`;
}
function hexBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}
function checksum(object: R2Object) {
  const value = object.checksums.sha256;
  return value
    ? Array.from(new Uint8Array(value), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")
    : null;
}
function storedType(object: R2Object): ObjectImageType | null {
  const value = object.httpMetadata?.contentType?.trim().toLowerCase();
  return value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp"
    ? value
    : null;
}
async function validObject(
  object: R2Object,
  id: string,
  expected?: {
    owner: ChatPrincipalId;
    contentHash: string;
    bytes: number;
    contentType: ObjectImageType;
  },
) {
  const type = storedType(object);
  let owner: ChatPrincipalId;
  try {
    owner = principal(object.customMetadata?.owner);
  } catch {
    return false;
  }
  const contentHash = checksum(object);
  return (
    object.size > 0 &&
    object.size <= MAX_ACCOUNT_IMAGE_BYTES &&
    type !== null &&
    contentHash !== null &&
    object.customMetadata?.sha256 === contentHash &&
    object.customMetadata?.mediaId === id &&
    (await mediaObjectId(owner, contentHash)) === id &&
    (!expected ||
      (owner === expected.owner &&
        contentHash === expected.contentHash &&
        object.size === expected.bytes &&
        type === expected.contentType))
  );
}
async function validSupportObject(
  object: R2Object,
  scope: SupportMediaScope,
  expected: SupportMediaReference & { bytes: number },
) {
  const id = await supportMediaObjectId(scope);
  const contentHash = checksum(object);
  return (
    expected.objectId === id &&
    HASH.test(expected.contentHash) &&
    object.size === expected.bytes &&
    object.size > 0 &&
    object.size <= SUPPORT_LIMITS.screenshotBytes &&
    storedType(object) === "image/png" &&
    contentHash === expected.contentHash &&
    object.customMetadata?.kind === "support" &&
    object.customMetadata?.supportId === id &&
    object.customMetadata?.scope === id &&
    object.customMetadata?.sha256 === expected.contentHash
  );
}
function unavailable(): HttpError {
  return new HttpError(
    503,
    "Image storage is unavailable.",
    undefined,
    "media-storage-unavailable",
  );
}
async function putObject(
  bucket: R2Bucket,
  id: string,
  owner: ChatPrincipalId,
  contentHash: string,
  bytes: Uint8Array,
  contentType: ObjectImageType,
) {
  try {
    const created = await bucket.put(objectKey(id), bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=300",
      },
      customMetadata: { mediaId: id, owner, sha256: contentHash },
      sha256: hexBytes(contentHash),
    });
    const object = created ?? (await bucket.head(objectKey(id)));
    if (
      !object ||
      !(await validObject(object, id, {
        owner,
        contentHash,
        bytes: bytes.length,
        contentType,
      }))
    )
      throw unavailable();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
async function getObject(bucket: R2Bucket, id: string) {
  try {
    const object = await bucket.get(objectKey(id));
    if (!object) return null;
    if (!(await validObject(object, id))) throw unavailable();
    return object;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
async function headObject(bucket: R2Bucket, id: string) {
  try {
    const object = await bucket.head(objectKey(id));
    if (!object) return null;
    if (!(await validObject(object, id))) throw unavailable();
    return object;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
async function putSupportObject(
  bucket: R2Bucket,
  scope: SupportMediaScope,
  bytes: Uint8Array,
  reference: SupportMediaReference,
) {
  const id = await supportMediaObjectId(scope);
  if (reference.objectId !== id) throw unavailable();
  try {
    const created = await bucket.put(supportObjectKey(id), bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "image/png", cacheControl: "no-store" },
      customMetadata: {
        kind: "support",
        supportId: id,
        scope: id,
        sha256: reference.contentHash,
      },
      sha256: hexBytes(reference.contentHash),
    });
    const object = created ?? (await bucket.head(supportObjectKey(id)));
    if (
      !object ||
      !(await validSupportObject(object, scope, {
        ...reference,
        bytes: bytes.length,
      }))
    )
      throw unavailable();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
async function getSupportObject(
  bucket: R2Bucket,
  scope: SupportMediaScope,
  reference: SupportMediaReference,
  bytes: number,
) {
  try {
    const object = await bucket.get(supportObjectKey(reference.objectId));
    if (
      !object ||
      !(await validSupportObject(object, scope, { ...reference, bytes }))
    )
      throw unavailable();
    return object;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
function missing() {
  const response = json({ error: "Image not found." }, 404, {
    "Access-Control-Allow-Origin": "*",
  });
  // A staged id can become public immediately after this response. Neither a
  // browser nor an intermediary may retain the miss and hide the new reference.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
function limited(message: string, retryAfter = 60) {
  return json({ error: message }, 429, { "Retry-After": String(retryAfter) });
}
function publicImage(
  body: ArrayBuffer | ReadableStream,
  byteLength: number,
  contentType: ObjectImageType,
  hash: string,
) {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(byteLength),
      "Content-Disposition": `inline; filename="${hash}.${contentType.split("/")[1]}"`,
      // References can be replaced and their owner-scoped object reclaimed.
      // Keep the cache shorter than the 24-hour release grace so no edge can
      // serve bytes after the object stops counting against retained storage.
      "Cache-Control": "public, max-age=300",
      ETag: `"${hash}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
      "X-Robots-Tag": "noindex, nofollow, nosnippet, noimageindex",
    },
  });
}
export async function getMedia(env: Env, hash: string) {
  if (!HASH.test(hash)) return missing();
  const bucket = objectStorage(env);
  const cache =
    typeof caches === "undefined"
      ? undefined
      : (caches as unknown as { default?: Cache }).default;
  const cacheKey = new Request(
    `${siteOrigins(env).communityOrigin}/media/${hash}`,
  );
  const metadata = await headObject(bucket, hash);
  if (!metadata) return missing();
  const owner = principal(metadata.customMetadata?.owner);
  const visibility = await quotaObject(env, owner).fetch(
    new Request("https://internal/public", {
      method: "POST",
      headers: {
        "X-Verified-Principal": owner,
        "X-Media-Id": hash,
      },
    }),
  );
  if (visibility.status === 404) return missing();
  if (!visibility.ok) throw unavailable();
  // Cache only saves the object-body read. Visibility is live account state:
  // consulting it first prevents a replaced or cleared reference from
  // remaining public through a previously cached response.
  const cached = await cache?.match(cacheKey).catch(() => undefined);
  if (cached) return cached;
  const object = await getObject(bucket, hash);
  if (!object) return missing();
  const response = publicImage(
    object.body,
    object.size,
    storedType(object)!,
    hash,
  );
  // Do not negative-cache a content-addressed key: an attacker can calculate
  // the hash of a common image before its owner uploads it. Caching that miss
  // would make the newly created object appear absent until the cache expires.
  if (response.ok) await cache?.put(cacheKey, response.clone()).catch(() => {});
  return response;
}

function mediaShardKey(env: Pick<Env, "MEDIA_SHARD_KEY">) {
  const value = env.MEDIA_SHARD_KEY?.trim();
  if (!value || !/^[0-9a-f]{64}$/.test(value)) throw unavailable();
  return hexBytes(value);
}
/** Shard placement is deliberately not derivable from the public media id.
 * A public-prefix mapping lets a Sybil precompute images for one shard and
 * deny an otherwise healthy fraction of uploads. The stable secret is a
 * deployment invariant and must not be rotated while retained media exists. */
async function mediaShard(
  env: Pick<Env, "MEDIA_BUDGET_SHARDS" | "MEDIA_SHARD_KEY">,
  id: string,
) {
  if (env.MEDIA_BUDGET_SHARDS !== String(MEDIA_BUDGET_SHARDS))
    throw unavailable();
  const key = await crypto.subtle.importKey(
    "raw",
    mediaShardKey(env),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id)),
  );
  return digest[0] % MEDIA_BUDGET_SHARDS;
}
async function serviceBudgetObject(env: Env, id: string) {
  const quotas = quotaNamespace(env);
  const shard = await mediaShard(env, id);
  return {
    shard,
    stub: quotas.get(quotas.idFromName(`media-service-budget:${shard}`)),
  };
}
function internalMediaRequest(
  path: string,
  owner: ChatPrincipalId,
  headers: Record<string, string> = {},
) {
  return new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "X-Verified-Principal": owner, ...headers },
  });
}
async function responseMessage(response: Response, fallback: string) {
  return (
    (
      await response
        .clone()
        .json<{ error?: string }>()
        .catch((): { error?: string } => ({}))
    ).error ?? fallback
  );
}
async function accountAttempt(
  env: Env,
  owner: ChatPrincipalId,
  byteLength: number,
) {
  return quotaObject(env, owner).fetch(
    internalMediaRequest("/attempt", owner, {
      "X-Media-Bytes": String(byteLength),
    }),
  );
}
async function stageAccountObject(
  env: Env,
  owner: ChatPrincipalId,
  id: string,
  contentHash: string,
  byteLength: number,
  contentType: ObjectImageType,
) {
  const response = await quotaObject(env, owner).fetch(
    internalMediaRequest("/stage", owner, {
      "X-Media-Id": id,
      "X-Content-Hash": contentHash,
      "X-Media-Bytes": String(byteLength),
      "X-Media-Type": contentType,
    }),
  );
  return {
    response,
    fresh: response.ok && response.headers.get("X-Media-Fresh") === "1",
  };
}
async function rollbackAccountObject(
  env: Env,
  owner: ChatPrincipalId,
  id: string,
) {
  await quotaObject(env, owner)
    .fetch(internalMediaRequest("/rollback", owner, { "X-Media-Id": id }))
    .catch(() => undefined);
}
async function reserveServiceObject(
  env: Env,
  id: string,
  byteLength: number,
  kind: ServiceMediaEntry["kind"] = "public",
  support?: SupportMediaScope,
  supportHash?: string,
) {
  const { shard, stub } = await serviceBudgetObject(env, id);
  const response = await stub.fetch(
    new Request("https://internal/service/reserve", {
      method: "POST",
      headers: {
        "X-Media-Id": id,
        "X-Media-Bytes": String(byteLength),
        "X-Media-Shard": String(shard),
        "X-Media-Kind": kind,
        ...(support
          ? {
              "X-Support-Room": support.room,
              "X-Support-Conversation": support.conversation,
              "X-Support-Attachment": support.attachment,
              "X-Support-Content-Hash": supportHash ?? "",
            }
          : {}),
      },
    }),
  );
  return {
    response,
    fresh: response.ok && response.headers.get("X-Media-Fresh") === "1",
  };
}
async function commitServiceObject(
  env: Env,
  id: string,
  byteLength: number,
  kind: ServiceMediaEntry["kind"] = "public",
) {
  const { shard, stub } = await serviceBudgetObject(env, id);
  return stub.fetch(
    new Request("https://internal/service/commit", {
      method: "POST",
      headers: {
        "X-Media-Id": id,
        "X-Media-Bytes": String(byteLength),
        "X-Media-Shard": String(shard),
        "X-Media-Kind": kind,
      },
    }),
  );
}
async function releaseServiceObject(
  env: Env,
  id: string,
  byteLength: number,
  kind: ServiceMediaEntry["kind"] = "public",
) {
  const { shard, stub } = await serviceBudgetObject(env, id);
  return stub.fetch(
    new Request("https://internal/service/release", {
      method: "POST",
      headers: {
        "X-Media-Id": id,
        "X-Media-Bytes": String(byteLength),
        "X-Media-Shard": String(shard),
        "X-Media-Kind": kind,
      },
    }),
  );
}

/** Stores one authenticated support screenshot under an opaque,
 * conversation-scoped key. The service reservation stays provisional until
 * the room transaction containing the attachment metadata commits. */
export async function stageSupportAttachment(
  env: Env,
  scopeValue: SupportMediaScope,
  bytes: Uint8Array,
): Promise<SupportMediaReference> {
  const scope = supportScope(scopeValue);
  if (bytes.length <= 0 || bytes.length > SUPPORT_LIMITS.screenshotBytes)
    throw new HttpError(400, "Invalid screenshot size.");
  const contentHash = await mediaHash(bytes);
  const objectId = await supportMediaObjectId(scope);
  const reserved = await reserveServiceObject(
    env,
    objectId,
    bytes.length,
    "support",
    scope,
    contentHash,
  );
  if (!reserved.response.ok)
    throw new HttpError(
      reserved.response.status,
      await responseMessage(
        reserved.response,
        "Screenshot storage is unavailable.",
      ),
      Number(reserved.response.headers.get("Retry-After")) || undefined,
    );
  const reference = { objectId, contentHash };
  // Keep an ambiguous reservation. The service-budget alarm asks the room
  // whether metadata committed before it either adopts or deletes the object.
  await putSupportObject(objectStorage(env), scope, bytes, reference);
  return reference;
}

/** Completes the global cost reservation after the room metadata transaction
 * has committed. Idempotent retries repair a lost response. */
export async function commitSupportAttachment(
  env: Env,
  objectId: string,
  byteLength: number,
) {
  if (
    !HASH.test(objectId) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > SUPPORT_LIMITS.screenshotBytes
  )
    throw unavailable();
  const response = await commitServiceObject(
    env,
    objectId,
    byteLength,
    "support",
  );
  if (!response.ok) throw unavailable();
}

/** Reads private support bytes only after the conversation route has
 * authenticated and authorized its member or current team. */
export async function readSupportAttachment(
  env: Env,
  scopeValue: SupportMediaScope,
  attachment: SupportAttachment,
  reference: SupportMediaReference,
) {
  const scope = supportScope(scopeValue);
  if (
    attachment.id !== scope.attachment ||
    attachment.contentType !== "image/png" ||
    !Number.isSafeInteger(attachment.bytes) ||
    attachment.bytes <= 0 ||
    attachment.bytes > SUPPORT_LIMITS.screenshotBytes
  )
    throw unavailable();
  return getSupportObject(
    objectStorage(env),
    scope,
    reference,
    attachment.bytes,
  );
}

/** Retention has already committed an access tombstone before calling this.
 * R2 deletion precedes service-budget release, so retries never stop counting
 * bytes that may still exist. */
export async function deleteSupportAttachment(
  env: Env,
  scopeValue: SupportMediaScope,
  attachment: SupportAttachment,
  reference: SupportMediaReference,
) {
  const scope = supportScope(scopeValue);
  if (
    attachment.id !== scope.attachment ||
    attachment.contentType !== "image/png" ||
    !Number.isSafeInteger(attachment.bytes) ||
    attachment.bytes <= 0 ||
    attachment.bytes > SUPPORT_LIMITS.screenshotBytes ||
    (await supportMediaObjectId(scope)) !== reference.objectId ||
    !HASH.test(reference.contentHash)
  )
    throw unavailable();
  const bucket = objectStorage(env);
  let object: R2Object | null;
  try {
    object = await bucket.head(supportObjectKey(reference.objectId));
    if (
      object &&
      !(await validSupportObject(object, scope, {
        ...reference,
        bytes: attachment.bytes,
      }))
    )
      throw unavailable();
    if (object) await bucket.delete(supportObjectKey(reference.objectId));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
  const released = await releaseServiceObject(
    env,
    reference.objectId,
    attachment.bytes,
    "support",
  );
  if (!released.ok) throw unavailable();
}

/** True only when this canonical account staged the public media id. */
export async function mediaOwnedBy(env: Env, ownerValue: string, id: string) {
  const owner = principal(ownerValue);
  if (!HASH.test(id)) return false;
  const response = await quotaObject(env, owner).fetch(
    internalMediaRequest("/owns", owner, { "X-Media-Id": id }),
  );
  if (response.status >= 500) throw unavailable();
  if (!response.ok) return false;
  const object = await headObject(objectStorage(env), id);
  return object?.customMetadata?.owner === owner;
}

/** Pins one account-owned object to its current profile or community icon.
 * Replacing or clearing the reference gives the prior object a 24-hour grace
 * period before the owner shard removes it from object storage. */
export async function setMediaReference(
  env: Env,
  ownerValue: string,
  reference: string,
  id: string | null,
) {
  const owner = principal(ownerValue);
  const response = await quotaObject(env, owner).fetch(
    internalMediaRequest("/reference", owner, {
      "X-Media-Reference": reference,
      ...(id ? { "X-Media-Id": id } : {}),
    }),
  );
  if (!response.ok)
    throw new HttpError(
      response.status >= 500 ? 503 : response.status,
      await responseMessage(response, "Image storage is unavailable."),
    );
  const previous = response.headers.get("X-Media-Previous");
  const revision = response.headers.get("X-Media-Revision");
  if (!revision) throw unavailable();
  return {
    previous: previous && HASH.test(previous) ? previous : null,
    revision,
  };
}

/** Restores a reference only if no newer request changed it after the caller's
 * provisional update. The opaque revision closes rollback races between two
 * concurrent profile or room changes, including two consecutive clears. */
export async function restoreMediaReference(
  env: Env,
  ownerValue: string,
  reference: string,
  attemptedId: string | null,
  previousId: string | null,
  revision: string,
) {
  const owner = principal(ownerValue);
  const response = await quotaObject(env, owner).fetch(
    internalMediaRequest("/restore-reference", owner, {
      "X-Media-Reference": reference,
      "X-Media-Revision": revision,
      ...(attemptedId ? { "X-Media-Id": attemptedId } : {}),
      ...(previousId ? { "X-Media-Previous": previousId } : {}),
    }),
  );
  if (!response.ok) throw unavailable();
}

/** Releases a prior room icon even after management moved to another account.
 * The owner is private object metadata and is never sent with the image. */
export async function releaseMediaReference(
  env: Env,
  id: string,
  reference: string,
) {
  if (!HASH.test(id)) return null;
  const object = await headObject(objectStorage(env), id);
  if (!object) return null;
  const owner = principal(object.customMetadata?.owner);
  const response = await quotaObject(env, owner).fetch(
    internalMediaRequest("/release-reference", owner, {
      "X-Media-Reference": reference,
      "X-Media-Id": id,
    }),
  );
  if (!response.ok && response.status !== 404) throw unavailable();
  if (response.headers.get("X-Media-Changed") !== "1") return null;
  const revision = response.headers.get("X-Media-Revision");
  if (!revision) throw unavailable();
  return { owner, previous: id, revision };
}

async function storeAccountObject(
  env: Env,
  owner: ChatPrincipalId,
  bytes: Uint8Array,
  contentType: ObjectImageType,
) {
  const bucket = objectStorage(env);
  const contentHash = await mediaHash(bytes);
  const id = await mediaObjectId(owner, contentHash);
  const staged = await stageAccountObject(
    env,
    owner,
    id,
    contentHash,
    bytes.length,
    contentType,
  );
  if (!staged.response.ok)
    throw new HttpError(
      staged.response.status,
      await responseMessage(staged.response, "Image storage is unavailable."),
      Number(staged.response.headers.get("Retry-After")) || undefined,
    );
  const reserved = await reserveServiceObject(env, id, bytes.length);
  if (!reserved.response.ok) {
    if (staged.fresh) await rollbackAccountObject(env, owner, id);
    throw new HttpError(
      reserved.response.status,
      await responseMessage(reserved.response, "Image storage is unavailable."),
      Number(reserved.response.headers.get("Retry-After")) || undefined,
    );
  }
  try {
    await putObject(bucket, id, owner, contentHash, bytes, contentType);
  } catch (error) {
    // A bucket write can commit and still lose its response. Keep both
    // reservations on an ambiguous write failure: an immediate retry adopts
    // the same owner-scoped object, while the budget alarm reconciles R2 and
    // the account alarm eventually removes a definite miss. Rolling back here
    // could strand stored bytes outside every cost ceiling.
    throw error;
  }
  const committed = await commitServiceObject(env, id, bytes.length);
  if (!committed.ok) throw unavailable();
  return id;
}

/** Called only after the worker verifies the session and request origin. */
export async function uploadMedia(request: Request, env: Env, wallet: string) {
  const owner = principal(wallet);
  objectStorage(env);
  const raw = await readUpload(request);
  // Account admission precedes decompression, including failed attempts.
  const admission = await accountAttempt(env, owner, raw.length);
  if (!admission.ok) return admission;
  const bytes = await normalizePng(raw, MAX_MEDIA_BYTES);
  const id = await storeAccountObject(env, owner, bytes, "image/png");
  return json({ url: `${siteOrigins(env).communityOrigin}/media/${id}` }, 201);
}

/** Per-account admission/reference ledger and one of 64 service budget shards.
 * Image bytes exist only in object storage. Account state prevents one user
 * from exhausting everyone; budget shards bound total persistent spend while
 * limiting a saturated shard's blast radius to 1/64 of media ids. */
export class MediaQuota {
  private accountCleanupInFlight: Promise<void> | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Pick<
      Env,
      | "MEDIA_BUCKET"
      | "MEDIA_BUDGET_SHARDS"
      | "MEDIA_QUOTAS"
      | "MEDIA_SHARD_KEY"
      | "ROOMS"
    >,
  ) {}

  private async scheduleAccount(ledger: MediaLedger, now = Date.now()) {
    const next = Object.values(ledger.objects)
      .filter((record) => record.stagedUntil !== null)
      .reduce(
        (earliest, record) => Math.min(earliest, record.stagedUntil!),
        Number.POSITIVE_INFINITY,
      );
    if (Number.isFinite(next))
      await this.state.storage.setAlarm(Math.max(now + 1_000, next));
  }

  private async scheduleBudget(now = Date.now()) {
    const due = await this.state.storage.list({
      prefix: BUDGET_DUE_PREFIX,
      limit: 1,
    });
    const first = due.keys().next().value as string | undefined;
    if (!first) return;
    const next = Number(
      first.slice(BUDGET_DUE_PREFIX.length, BUDGET_DUE_PREFIX.length + 16),
    );
    if (!Number.isSafeInteger(next)) throw unavailable();
    await this.state.storage.setAlarm(Math.max(now + 1_000, next));
  }

  private async cleanupAccount(now = Date.now()) {
    // The ledger's deleting flag survives a restart, but two live requests can
    // otherwise both hold the same expired row while awaiting R2. A second
    // stale delete could then remove a newly uploaded object with the same id.
    if (this.accountCleanupInFlight) return this.accountCleanupInFlight;
    const cleanup = this.runAccountCleanup(now);
    this.accountCleanupInFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.accountCleanupInFlight === cleanup)
        this.accountCleanupInFlight = null;
    }
  }

  private async runAccountCleanup(now: number) {
    const marked = await this.state.storage.transaction(async (storage) => {
      const ledger =
        (await storage.get<MediaLedger>("ledger")) ?? EMPTY_LEDGER();
      const referenced = new Set(Object.values(ledger.references));
      const ids = Object.entries(ledger.objects)
        .filter(
          ([id, record]) =>
            !referenced.has(id) &&
            record.stagedUntil !== null &&
            record.stagedUntil <= now,
        )
        .map(([id]) => id);
      for (const id of ids) ledger.objects[id].deleting = true;
      if (ids.length) await storage.put("ledger", ledger);
      return ids;
    });
    for (const id of marked) {
      const record = await this.state.storage
        .get<MediaLedger>("ledger")
        .then((ledger) => ledger?.objects[id]);
      if (!record?.deleting) continue;
      try {
        await objectStorage(this.env as Env).delete(objectKey(id));
        const released = await releaseServiceObject(
          this.env as Env,
          id,
          record.bytes,
        );
        if (!released.ok) throw unavailable();
        const ledger = await this.state.storage.transaction(async (storage) => {
          const ledger =
            (await storage.get<MediaLedger>("ledger")) ?? EMPTY_LEDGER();
          const referenced = new Set(Object.values(ledger.references));
          if (ledger.objects[id]?.deleting && !referenced.has(id))
            delete ledger.objects[id];
          await storage.put("ledger", ledger);
          return ledger;
        });
        await this.scheduleAccount(ledger, now);
      } catch {
        const ledger = await this.state.storage.transaction(async (storage) => {
          const ledger =
            (await storage.get<MediaLedger>("ledger")) ?? EMPTY_LEDGER();
          if (ledger.objects[id]) {
            // R2 deletion may already have succeeded before the budget release
            // failed. Keep the row unavailable until the idempotent cleanup
            // finishes so a concurrent reference cannot pin missing bytes.
            ledger.objects[id].deleting = true;
            ledger.objects[id].stagedUntil = now + SERVICE_RETRY_DELAY;
            await storage.put("ledger", ledger);
          }
          return ledger;
        });
        await this.scheduleAccount(ledger, now);
      }
    }
  }

  private async cleanupBudget(now = Date.now()) {
    // Convert the current staging aggregate atomically before reading its due
    // index. A conversion failure keeps all existing reservations counted.
    await this.state.storage.transaction((storage) => readBudget(storage));
    const due = await this.state.storage.list({
      prefix: BUDGET_DUE_PREFIX,
      limit: SERVICE_CLEANUP_BATCH,
    });
    for (const key of due.keys()) {
      const id = budgetDueId(key);
      const entry = await this.state.storage.get<ServiceMediaEntry>(
        budgetEntryKey(id),
      );
      if (
        !entry ||
        entry.expiresAt === null ||
        budgetDueKey(id, entry.expiresAt) !== key
      ) {
        await this.state.storage.delete(key);
        continue;
      }
      if (entry.expiresAt > now) break;
      if (entry.kind === "support") {
        const marked = await this.state.storage.transaction(async (storage) => {
          const current = await storage.get<ServiceMediaEntry>(
            budgetEntryKey(id),
          );
          if (
            !current ||
            current.kind !== "support" ||
            current.bytes !== entry.bytes ||
            current.status === "committed" ||
            current.expiresAt === null ||
            current.expiresAt > now ||
            !sameSupportReservation(current.support, entry.support)
          )
            return null;
          const next: ServiceMediaEntry = {
            ...current,
            status: "deleting",
            expiresAt: now + SERVICE_RETRY_DELAY,
          };
          await putBudgetEntry(storage, id, current, next);
          return next;
        });
        if (!marked?.support) continue;
        const scope = {
          room: marked.support.room,
          conversation: marked.support.conversation,
          attachment: marked.support.attachment,
        };
        let referenced: boolean | null = null;
        let validStoredObject: boolean | null = null;
        try {
          const roomId = SUPPORT_ROOM.exec(scope.room)?.[1];
          if (!roomId) throw unavailable();
          const response = await this.env.ROOMS.get(
            this.env.ROOMS.idFromName(`native-room:${roomId}`),
          ).fetch(
            new Request("https://internal/private/support-media-reference", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...scope,
                objectId: id,
                contentHash: marked.support.contentHash,
                bytes: marked.bytes,
              }),
            }),
          );
          if (!response.ok) throw unavailable();
          const answer = await response.json<{ referenced?: unknown }>();
          if (typeof answer.referenced !== "boolean") throw unavailable();
          referenced = answer.referenced;
          const object = await objectStorage(this.env as Env).head(
            supportObjectKey(id),
          );
          validStoredObject = object
            ? await validSupportObject(object, scope, {
                objectId: id,
                contentHash: marked.support.contentHash,
                bytes: marked.bytes,
              })
            : false;
          if (object && (!referenced || !validStoredObject))
            await objectStorage(this.env as Env).delete(supportObjectKey(id));
        } catch {
          referenced = null;
          validStoredObject = null;
          // Neither a missing room answer nor a bucket outage releases bytes.
        }
        await this.state.storage.transaction(async (storage) => {
          const budget = await readBudget(storage);
          const current = await storage.get<ServiceMediaEntry>(
            budgetEntryKey(id),
          );
          if (
            !current ||
            current.kind !== "support" ||
            current.status !== "deleting" ||
            current.bytes !== marked.bytes ||
            !sameSupportReservation(current.support, marked.support)
          )
            return;
          if (referenced === true && validStoredObject === true) {
            await putBudgetEntry(storage, id, current, {
              ...current,
              status: "committed",
              expiresAt: null,
            });
          } else if (referenced === false) {
            await putBudgetEntry(storage, id, current, undefined);
            changeBudget(budget, current, -1);
            await storage.put("budget", budget);
          } else {
            // A referenced-but-missing object may be repaired by an exact
            // retry; an uncertain result must retain its cost reservation.
            await putBudgetEntry(storage, id, current, {
              ...current,
              status: "reserved",
              expiresAt: now + SERVICE_RETRY_DELAY,
            });
          }
        });
        continue;
      }
      let exists: boolean | null = null;
      try {
        exists =
          (await headObject(objectStorage(this.env as Env), id)) !== null;
      } catch {
        // A storage outage retains the reservation for reconciliation.
      }
      await this.state.storage.transaction(async (storage) => {
        const budget = await readBudget(storage);
        const current = await storage.get<ServiceMediaEntry>(
          budgetEntryKey(id),
        );
        // The R2 read is outside the transaction. Do not apply it after a
        // concurrent reserve renewed the row or changed its status.
        if (
          !current ||
          current.kind !== "public" ||
          current.status !== "reserved" ||
          current.bytes !== entry.bytes ||
          current.expiresAt === null ||
          current.expiresAt > now
        )
          return;
        if (exists === true) {
          await putBudgetEntry(storage, id, current, {
            ...current,
            status: "committed",
            expiresAt: null,
          });
        } else if (exists === false) {
          await putBudgetEntry(storage, id, current, undefined);
          changeBudget(budget, current, -1);
          await storage.put("budget", budget);
        } else
          await putBudgetEntry(storage, id, current, {
            ...current,
            expiresAt: now + SERVICE_RETRY_DELAY,
          });
      });
    }
    await this.scheduleBudget(now);
  }

  async alarm() {
    const kind = await this.state.storage.get<string>("kind");
    if (kind === "account") await this.cleanupAccount();
    else if (kind === "budget") await this.cleanupBudget();
    else await groupAttachmentCleanupAlarm(this.state, this.env as Env);
  }

  async fetch(request: Request) {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/group/"))
        return groupAttachmentQuotaRequest(
          this.state,
          this.env as Env,
          request,
        );
      const now = Date.now();
      if (request.method !== "POST")
        return json({ error: "Method not allowed." }, 405);
      if (path.startsWith("/service/")) {
        const id = request.headers.get("X-Media-Id") ?? "";
        const shard = Number(request.headers.get("X-Media-Shard"));
        const byteLength = Number(request.headers.get("X-Media-Bytes"));
        const mediaKind = request.headers.get("X-Media-Kind");
        if (
          !HASH.test(id) ||
          (mediaKind !== "public" && mediaKind !== "support") ||
          !Number.isSafeInteger(shard) ||
          shard !== (await mediaShard(this.env, id)) ||
          !Number.isSafeInteger(byteLength) ||
          byteLength <= 0 ||
          byteLength >
            (mediaKind === "support"
              ? SUPPORT_LIMITS.screenshotBytes
              : MAX_ACCOUNT_IMAGE_BYTES)
        )
          throw new HttpError(400, "Invalid image reservation.");
        let support: ServiceMediaEntry["support"];
        if (mediaKind === "support" && path === "/service/reserve") {
          const scope = supportScope({
            room: request.headers.get("X-Support-Room") ?? "",
            conversation: request.headers.get("X-Support-Conversation") ?? "",
            attachment: request.headers.get("X-Support-Attachment") ?? "",
          });
          const contentHash =
            request.headers.get("X-Support-Content-Hash") ?? "";
          if (
            !HASH.test(contentHash) ||
            (await supportMediaObjectId(scope)) !== id
          )
            throw new HttpError(400, "Invalid screenshot reservation.");
          support = { ...scope, contentHash };
        }
        if (path === "/service/reserve") await this.cleanupBudget(now);
        const result = await this.state.storage.transaction(async (storage) => {
          const kind = await storage.get<string>("kind");
          const boundShard = await storage.get<number>("shard");
          if (
            (kind && kind !== "budget") ||
            (boundShard !== undefined && boundShard !== shard)
          )
            throw unavailable();
          if (!kind) {
            await storage.put("kind", "budget");
            await storage.put("shard", shard);
          }
          const budget = await readBudget(storage);
          const existing = await storage.get<ServiceMediaEntry>(
            budgetEntryKey(id),
          );
          if (path === "/service/reserve") {
            if (existing) {
              if (
                existing.bytes !== byteLength ||
                existing.kind !== mediaKind ||
                (mediaKind === "support" &&
                  !sameSupportReservation(existing.support, support)) ||
                existing.status === "deleting"
              )
                throw unavailable();
              if (existing.status === "reserved")
                await putBudgetEntry(storage, id, existing, {
                  ...existing,
                  expiresAt: now + SERVICE_RESERVATION_TTL,
                });
              return { response: json({ ok: true }), budget };
            }
            const counts = budgetKindCounts(budget, mediaKind);
            if (
              counts.bytes + byteLength > counts.maxBytes ||
              counts.objects + 1 > counts.maxObjects
            )
              return {
                response: limited(
                  "Image storage capacity is temporarily full.",
                  3600,
                ),
                budget,
              };
            const next: ServiceMediaEntry = {
              bytes: byteLength,
              kind: mediaKind,
              status: "reserved",
              expiresAt: now + SERVICE_RESERVATION_TTL,
              ...(support ? { support } : {}),
            };
            await putBudgetEntry(storage, id, undefined, next);
            changeBudget(budget, next, 1);
            await storage.put("budget", budget);
            const response = json({ ok: true });
            response.headers.set("X-Media-Fresh", "1");
            return { response, budget };
          }
          if (path === "/service/commit") {
            if (
              !existing ||
              existing.bytes !== byteLength ||
              existing.kind !== mediaKind ||
              existing.status === "deleting"
            )
              throw unavailable();
            await putBudgetEntry(storage, id, existing, {
              ...existing,
              status: "committed",
              expiresAt: null,
            });
            return { response: json({ ok: true }), budget };
          }
          if (path === "/service/release") {
            if (existing) {
              if (existing.bytes !== byteLength || existing.kind !== mediaKind)
                throw unavailable();
              await putBudgetEntry(storage, id, existing, undefined);
              changeBudget(budget, existing, -1);
              await storage.put("budget", budget);
            }
            return { response: json({ ok: true }), budget };
          }
          return { response: json({ error: "Not found." }, 404), budget };
        });
        await this.scheduleBudget(now);
        if (typeof this.state.waitUntil === "function")
          this.state.waitUntil(
            observeCostWorkload(this.env, {
              mediaShardBytes: result.budget.bytes,
              mediaShardObjects: result.budget.objects,
            }),
          );
        return result.response;
      }

      const owner = principal(request.headers.get("X-Verified-Principal"));
      if (
        [
          "/stage",
          "/reference",
          "/restore-reference",
          "/release-reference",
        ].includes(path)
      )
        await this.cleanupAccount(now);
      const result = await this.state.storage.transaction(async (storage) => {
        const kind = await storage.get<string>("kind");
        const boundOwner = await storage.get<string>("owner");
        if (
          (kind && kind !== "account") ||
          (boundOwner && boundOwner !== owner)
        )
          throw unavailable();
        if (!kind) {
          await storage.put("kind", "account");
          await storage.put("owner", owner);
        }
        if (path === "/attempt") {
          const byteLength = Number(request.headers.get("X-Media-Bytes"));
          if (
            !Number.isSafeInteger(byteLength) ||
            byteLength <= 0 ||
            byteLength > MAX_ACCOUNT_IMAGE_BYTES
          )
            throw new HttpError(400, "Invalid image size.");
          const recent = (
            (await storage.get<UploadAttempt[]>("attempts")) ?? []
          ).filter((entry) => entry.time > now - DAY);
          if (recent.length >= DAILY_MEDIA_LIMIT)
            return limited(
              "You can upload 10 images in 24 hours. Try again later.",
              Math.max(1, Math.ceil((recent[0].time + DAY - now) / 1000)),
            );
          await storage.put("attempts", [
            ...recent,
            { time: now, bytes: byteLength },
          ]);
          return json({ ok: true });
        }
        const id = request.headers.get("X-Media-Id") ?? "";
        // Clearing a reference intentionally has no media id. Every other
        // account-ledger operation addresses one exact owner-scoped object.
        if (
          !["/reference", "/restore-reference"].includes(path) &&
          !HASH.test(id)
        )
          throw new HttpError(400, "Invalid image id.");
        const ledger =
          (await storage.get<MediaLedger>("ledger")) ?? EMPTY_LEDGER();
        if (path === "/owns")
          return ledger.objects[id] && !ledger.objects[id].deleting
            ? json({ ok: true })
            : json({ error: "Image not found." }, 404);
        if (path === "/public")
          return ledger.objects[id] &&
            !ledger.objects[id].deleting &&
            Object.values(ledger.references).includes(id)
            ? json({ ok: true })
            : json({ error: "Image not found." }, 404);
        if (path === "/rollback") {
          const referenced = new Set(Object.values(ledger.references));
          if (ledger.objects[id] && !referenced.has(id)) {
            delete ledger.objects[id];
            await storage.put("ledger", ledger);
          }
          return json({ ok: true });
        }
        if (path === "/stage") {
          const contentHash = request.headers.get("X-Content-Hash") ?? "";
          const byteLength = Number(request.headers.get("X-Media-Bytes"));
          const contentType = request.headers.get("X-Media-Type") ?? "";
          if (
            !HASH.test(contentHash) ||
            (await mediaObjectId(owner, contentHash)) !== id ||
            !Number.isSafeInteger(byteLength) ||
            byteLength <= 0 ||
            byteLength > MAX_ACCOUNT_IMAGE_BYTES ||
            !ACCOUNT_IMAGE_TYPES.includes(contentType as AccountImageType)
          )
            throw new HttpError(400, "Invalid image reservation.");
          const existing = ledger.objects[id];
          if (existing) {
            if (
              existing.deleting ||
              existing.bytes !== byteLength ||
              existing.contentHash !== contentHash ||
              existing.contentType !== contentType
            )
              throw unavailable();
            if (!Object.values(ledger.references).includes(id))
              existing.stagedUntil = now + STAGED_MEDIA_TTL;
            await storage.put("ledger", ledger);
            return { response: json({ ok: true }), ledger };
          }
          const records = Object.values(ledger.objects);
          const staged = records.filter(
            (record) => record.stagedUntil !== null,
          ).length;
          const totalBytes = records.reduce(
            (sum, record) => sum + record.bytes,
            0,
          );
          if (
            records.length >= MAX_ACCOUNT_MEDIA_OBJECTS ||
            totalBytes + byteLength > MAX_ACCOUNT_MEDIA_BYTES
          )
            return limited(
              "This account's image storage allowance is full.",
              3600,
            );
          if (staged >= MAX_STAGED_MEDIA_OBJECTS)
            return limited(
              "Use or replace a pending image before uploading another.",
              3600,
            );
          ledger.objects[id] = {
            bytes: byteLength,
            contentHash,
            contentType: contentType as ObjectImageType,
            stagedUntil: now + STAGED_MEDIA_TTL,
          };
          await storage.put("ledger", ledger);
          const response = json({ ok: true });
          response.headers.set("X-Media-Fresh", "1");
          return { response, ledger };
        }
        if (path === "/reference") {
          const reference = request.headers.get("X-Media-Reference") ?? "";
          if (!MEDIA_REFERENCE.test(reference))
            throw new HttpError(400, "Invalid image reference.");
          const nextId = request.headers.get("X-Media-Id");
          if (
            nextId &&
            (!HASH.test(nextId) ||
              !ledger.objects[nextId] ||
              ledger.objects[nextId].deleting)
          )
            throw new HttpError(400, "Upload an image first.");
          const previous = ledger.references[reference];
          if (nextId) {
            ledger.references[reference] = nextId;
            ledger.objects[nextId].stagedUntil = null;
          } else delete ledger.references[reference];
          if (
            previous &&
            previous !== nextId &&
            !Object.values(ledger.references).includes(previous) &&
            ledger.objects[previous]
          )
            ledger.objects[previous].stagedUntil = now + STAGED_MEDIA_TTL;
          const revision = crypto.randomUUID();
          ledger.referenceRevisions[reference] = revision;
          await storage.put("ledger", ledger);
          const response = json({ ok: true });
          if (previous) response.headers.set("X-Media-Previous", previous);
          response.headers.set("X-Media-Revision", revision);
          return { response, ledger };
        }
        if (path === "/restore-reference") {
          const reference = request.headers.get("X-Media-Reference") ?? "";
          const revision = request.headers.get("X-Media-Revision") ?? "";
          const attempted = request.headers.get("X-Media-Id");
          const previous = request.headers.get("X-Media-Previous");
          if (
            !MEDIA_REFERENCE.test(reference) ||
            !revision ||
            (attempted !== null && !HASH.test(attempted)) ||
            (previous !== null &&
              (!HASH.test(previous) ||
                !ledger.objects[previous] ||
                ledger.objects[previous].deleting))
          )
            throw new HttpError(400, "Invalid image reference.");
          const current = ledger.references[reference] ?? null;
          if (
            ledger.referenceRevisions[reference] === revision &&
            current === attempted
          ) {
            if (previous) {
              ledger.references[reference] = previous;
              ledger.objects[previous].stagedUntil = null;
            } else delete ledger.references[reference];
            if (
              attempted &&
              attempted !== previous &&
              ledger.objects[attempted] &&
              !Object.values(ledger.references).includes(attempted)
            )
              ledger.objects[attempted].stagedUntil = now + STAGED_MEDIA_TTL;
            ledger.referenceRevisions[reference] = crypto.randomUUID();
            await storage.put("ledger", ledger);
          }
          return { response: json({ ok: true }), ledger };
        }
        if (path === "/release-reference") {
          const reference = request.headers.get("X-Media-Reference") ?? "";
          if (!MEDIA_REFERENCE.test(reference))
            throw new HttpError(400, "Invalid image reference.");
          if (ledger.references[reference] === id) {
            delete ledger.references[reference];
            if (
              ledger.objects[id] &&
              !Object.values(ledger.references).includes(id)
            )
              ledger.objects[id].stagedUntil = now + STAGED_MEDIA_TTL;
            const revision = crypto.randomUUID();
            ledger.referenceRevisions[reference] = revision;
            await storage.put("ledger", ledger);
            const response = json({ ok: true });
            response.headers.set("X-Media-Changed", "1");
            response.headers.set("X-Media-Revision", revision);
            return { response, ledger };
          }
          return { response: json({ ok: true }), ledger };
        }
        return { response: json({ error: "Not found." }, 404), ledger };
      });
      if ("ledger" in result) await this.scheduleAccount(result.ledger, now);
      return result instanceof Response ? result : result.response;
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Image storage is unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
      );
    }
  }
}
