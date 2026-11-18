import { observeCostWorkload } from "./cost-observability";
import { HttpError, type Env } from "./common";
import { PRODUCT_STATE_KEY, readProductSupport } from "./product-entitlements";
import {
  decodeSupportValue,
  encodeSupportValue,
  supportPayloadHash,
  SUPPORT_INDEX_PARTITION_SIZE,
  SUPPORT_MESSAGE_PARTITION_SIZE,
  type SupportPartitionIdentity,
  type SupportPartitionRow,
} from "./support-partition";
import { SearchIndex } from "./search-index";
import { wakeRoomAt } from "./room-alarm";

type Storage = DurableObjectTransaction;
type StorageEnv = Pick<
  Env,
  "SUPPORT_PARTITIONS" | "GROUP_HISTORY_ARCHIVE_ENABLED"
>;
const ENABLED = "support-store-enabled-v1";
const GROUP_ENABLED = "group-store-enabled-v1";
const CAPABILITY = "support-store-capability-v1";
const VERSION = "support-store-version-v1";
const PENDING = "support-store-pending-v1:";
const PENDING_BYTES = "support-store-pending-bytes-v1";
const GROUP_PENDING_BYTES = "group-store-pending-bytes-v1";
const GROUP_CUTOFFS = "group-store-cutoffs-v1";
const GROUP_WORK = "group-store-work-v1:";
const GROUP_WORK_CURSOR = "group-store-work-cursor-v1";
const GROUP_DISCOVERY_DONE = "group-store-discovery-done-v1";
const MANIFEST = "support-store-manifest-v1:";
const SEARCH_INDEX = "support-store-search-v1:";
export const SUPPORT_SEARCH_MANIFEST = "support-store-search-order-v1:";
export const GROUP_SEARCH_MANIFEST = "group-store-search-order-v1:";
const SUPPORT_ARCHIVE_CURSOR = "support-store-migration-v1";
const SUPPORT_PREFIXES = [
  "channel-message:tc-",
  "message-history-v1:tc-",
  "message-reactions-v1:tc-",
  "support-note-v1:",
  "support-note-client-v1:",
  "support-activity-v1:",
  "support-encrypted-v1:",
];
const GROUP_PREFIXES = [
  "channel-message:",
  "message-history-v1:",
  "message-reactions-v1:",
];
/** Temporary room-local journal, not a commercial history allowance. */
export const SUPPORT_STAGING_BYTES = 64 * 1024 * 1024;
export const GROUP_STAGING_BYTES = 64 * 1024 * 1024;
/** A bounded recent window per channel stays local for fast pages and FTS.
 * It is a storage placement rule, never a retained-message count limit. */
export const GROUP_HOT_MESSAGES = 512;
export const GROUP_MIGRATION_IDS_PER_ALARM = 32;
const pad = (value: number) => String(value).padStart(16, "0");
/** Partitions whose first page a list reads ahead of the one it merges. */
const PARTITION_LOOKAHEAD = 4;
const ownCutoff = (cutoffs: Record<string, number>, channel: string) =>
  Object.hasOwn(cutoffs, channel) && Number.isSafeInteger(cutoffs[channel])
    ? cutoffs[channel]
    : 0;
type Location = {
  id: string;
  prefix: string;
  bucket: string;
  kind: "support" | "group";
};
type Manifest = Location & { count: number; minKey: string; maxKey: string };
type Pending = SupportPartitionRow & {
  encoded: null;
  deleted: boolean;
  bytes: number;
  targets: { id: string; mode: "data" | "index" }[];
};
type GroupWork = { cursor: number; through: number };
const stores = new WeakMap<object, SupportStorage>();

/** Routing is derived from immutable message/record IDs, never an account ID
 * supplied by a requester. Each message range has room for every currently
 * permitted revision and reaction; a growing thread gets further ranges. */
export function supportLocation(key: string): Location | null {
  const view = /^(support-encrypted-v1):(tc-[0-9a-f]{32}):([0-9]{8}):view:(conversation|team|ai-draft):([0-9]{16})$/.exec(key);
  if (view) {
    const bucket = pad(Math.floor(Math.max(0, Number(view[5]) - 1) / SUPPORT_MESSAGE_PARTITION_SIZE));
    return { id: `e-i:${view[2]}:${view[3]}:${view[4]}:${bucket}`, prefix: `${view[1]}:${view[2]}:${view[3]}:view:${view[4]}:`, bucket, kind: "support" };
  }
  const encrypted = /^(support-encrypted-v1):(tc-[0-9a-f]{32}):([0-9]{8}):(row|outcome):([0-9]{16}|[0-9a-f-]{36})$/.exec(key);
  if (encrypted) {
    const row = encrypted[4] === "row";
    if (row && !/^[0-9]{16}$/.test(encrypted[5]) || !row && !/^[0-9a-f-]{36}$/.test(encrypted[5])) return null;
    const bucket = row ? pad(Math.floor(Math.max(0, Number(encrypted[5]) - 1) / SUPPORT_MESSAGE_PARTITION_SIZE)) : "0";
    return { id: `e-${row ? "m" : "r"}:${encrypted[2]}:${encrypted[3]}:${bucket}`,
      prefix: `${encrypted[1]}:${encrypted[2]}:${encrypted[3]}:${encrypted[4]}:`, bucket, kind: "support" };
  }
  const numeric =
    /^(channel-message|message-history-v1|message-reactions-v1|support-search-location-v1|support-note-v1|support-activity-v1):(tc-[0-9a-f]{32}):([0-9]{8,16})(?::[0-9a-f-]{36})?$/.exec(
      key,
    );
  if (numeric) {
    const size = SUPPORT_MESSAGE_PARTITION_SIZE;
    const bucket = pad(Math.floor(Math.max(0, Number(numeric[3]) - 1) / size));
    const family =
      numeric[1] === "support-note-v1"
        ? "n"
        : numeric[1] === "support-activity-v1"
          ? "a"
          : "m";
    return {
      id: `${family}:${numeric[2]}:${bucket}`,
      prefix: `${numeric[1]}:${numeric[2]}:`,
      bucket,
      kind: "support",
    };
  }
  const noteRetry =
    /^(support-note-client-v1):(tc-[0-9a-f]{32}):(.{1,80})$/.exec(key);
  if (noteRetry)
    return {
      id: `r:${noteRetry[2]}`,
      prefix: `${noteRetry[1]}:${noteRetry[2]}:`,
      bucket: "0",
      kind: "support",
    };
  return null;
}
/** Free group rows use the same bounded range protocol as Support, with
 * separate destination names and search indexes. Team conversations never
 * enter this namespace. */
export function groupLocation(key: string): Location | null {
  const numeric =
    /^(channel-message|message-history-v1|message-reactions-v1|group-search-location-v1):([a-z0-9][a-z0-9-]{0,47}):([0-9]{16})$/.exec(
      key,
    );
  if (!numeric || /^tc-[0-9a-f]{32}$/.test(numeric[2])) return null;
  const bucket = pad(
    Math.floor(
      (Math.max(1, Number(numeric[3])) - 1) / SUPPORT_MESSAGE_PARTITION_SIZE,
    ),
  );
  return {
    id: `g:${numeric[2]}:${bucket}`,
    prefix: `${numeric[1]}:${numeric[2]}:`,
    bucket,
    kind: "group",
  };
}
const manifestKey = (location: Location) =>
  MANIFEST + location.prefix + location.bucket;
const missing = (kind: Location["kind"] = "support") =>
  new HttpError(
    503,
    kind === "group"
      ? "Chat history is temporarily unavailable. Try again shortly."
      : "Support history is temporarily unavailable. Try again shortly.",
    30,
    `${kind}-storage-unavailable`,
  );
const matches = (key: string, options: DurableObjectListOptions) =>
  (!options.prefix || key.startsWith(options.prefix)) &&
  (!options.start || key >= options.start) &&
  (!options.startAfter || key > options.startAfter) &&
  (!options.end || key < options.end);

export class SupportStorage {
  readonly storage: Storage;
  private readonly cache = new Map<string, unknown>();
  constructor(
    readonly local: Storage,
    readonly env: StorageEnv,
    readonly room: string,
    readonly capability: string,
    readonly supportEnabled = true,
    readonly groupEnabled = false,
    readonly groupCutoffs: Record<string, number> = {},
  ) {
    const overrides = {
      get: this.get.bind(this),
      put: this.put.bind(this),
      delete: this.delete.bind(this),
      list: this.list.bind(this),
    };
    this.storage = new Proxy(local, {
      get(target, key) {
        if (key in overrides) return overrides[key as keyof typeof overrides];
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    stores.set(this.storage, this);
  }
  private location(key: string) {
    const group = this.groupEnabled ? groupLocation(key) : null;
    const groupId = group ? Number(key.slice(key.lastIndexOf(":") + 1)) : 0;
    return (
      (this.supportEnabled ? supportLocation(key) : null) ??
      (group && groupId <= ownCutoff(this.groupCutoffs, group.id.split(":")[1])
        ? group
        : null)
    );
  }
  get hasGroupArchive() {
    return Object.values(this.groupCutoffs).some((cutoff) => cutoff > 0);
  }
  async request<T>(
    id: string,
    mode: "data" | "index",
    body: object,
  ): Promise<T> {
    if (!this.env.SUPPORT_PARTITIONS)
      throw missing(id.startsWith("g:") ? "group" : "support");
    const identity: SupportPartitionIdentity = {
      room: this.room,
      capability: this.capability,
      partition: id,
      mode,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.env.SUPPORT_PARTITIONS.get(
        this.env.SUPPORT_PARTITIONS.idFromName(`${this.room}:${id}`),
      ).fetch("https://support-partition.internal/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ ...identity, ...body }),
      });
      if (!response.ok)
        throw missing(id.startsWith("g:") ? "group" : "support");
      return await response.json<T>();
    } catch {
      throw missing(id.startsWith("g:") ? "group" : "support");
    } finally {
      clearTimeout(timeout);
    }
  }
  async get<T>(
    key: string | string[],
  ): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const rows = new Map<string, T>();
      const remote = new Map<string, { location: Location; keys: string[] }>();
      await Promise.all(
        [...new Set(key)].map(async (item) => {
          const location = this.location(item);
          if (!location) {
            const value = await this.local.get<T>(item);
            if (value !== undefined) rows.set(item, value);
            return;
          }
          if (this.cache.has(item)) {
            const value = this.cache.get(item) as T | undefined;
            if (value !== undefined) rows.set(item, value);
            return;
          }
          const pending = await this.local.get<Pending>(PENDING + item);
          const local = pending?.deleted
            ? undefined
            : await this.local.get<T>(item);
          if (pending || local !== undefined) {
            this.cache.set(item, local);
            if (local !== undefined) rows.set(item, local);
            return;
          }
          if (!(await this.local.get(manifestKey(location)))) {
            this.cache.set(item, undefined);
            return;
          }
          const group = remote.get(location.id) ?? { location, keys: [] };
          group.keys.push(item);
          remote.set(location.id, group);
        }),
      );
      await Promise.all(
        [...remote.values()].map(async ({ location, keys }) => {
          // The common cold-reply case is one bounded request per 512-message
          // partition. Other key families keep the ordinary single-row path.
          for (let offset = 0; offset < keys.length; offset += 50) {
            const batch = keys.slice(offset, offset + 50);
            if (batch.every((item) => /^channel-message:/.test(item))) {
              const result = await this.request<{
                rows: SupportPartitionRow[];
              }>(location.id, "data", { action: "get-many", keys: batch });
              const found = new Map(result.rows.map((row) => [row.key, row]));
              for (const item of batch) {
                const encoded = found.get(item)?.encoded;
                const value =
                  encoded == null
                    ? undefined
                    : (decodeSupportValue(encoded) as T);
                this.cache.set(item, value);
                if (value !== undefined) rows.set(item, value);
              }
            } else {
              await Promise.all(
                batch.map(async (item) => {
                  const value = await this.get<T>(item);
                  if (value !== undefined) rows.set(item, value as T);
                }),
              );
            }
          }
        }),
      );
      return rows;
    }
    const location = this.location(key);
    if (!location) return this.local.get<T>(key);
    if (this.cache.has(key)) return this.cache.get(key) as T | undefined;
    const pending = await this.local.get<Pending>(PENDING + key);
    const local = pending?.deleted ? undefined : await this.local.get<T>(key);
    if (pending || local !== undefined) {
      this.cache.set(key, local);
      return local;
    }
    if (!(await this.local.get(manifestKey(location)))) {
      this.cache.set(key, undefined);
      return undefined;
    }
    const { row } = await this.request<{ row: SupportPartitionRow | null }>(
      location.id,
      "data",
      { action: "get", key },
    );
    const value =
      row?.encoded == null ? undefined : (decodeSupportValue(row.encoded) as T);
    this.cache.set(key, value);
    return value;
  }
  async put(
    key: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> {
    if (typeof key !== "string") {
      for (const [name, row] of Object.entries(key)) await this.put(name, row);
      return;
    }
    if (!this.location(key)) {
      await this.local.put(key, value);
      return;
    }
    await this.stage(key, value, false);
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let count = 0;
      for (const item of key) count += Number(await this.delete(item));
      return count;
    }
    if (!this.location(key)) return this.local.delete(key);
    const found = (await this.get(key)) !== undefined;
    if (found) await this.stage(key, undefined, true);
    return found;
  }
  private async stage(key: string, value: unknown, deleted: boolean) {
    const location = this.location(key)!;
    const previousValue = await this.get(key);
    const encoded = deleted ? null : encodeSupportValue(value);
    // Count the durable journal metadata too, including deletion jobs. An
    // unavailable destination must not permit an unbounded tombstone queue.
    const bytes =
      (encoded === null ? 0 : new TextEncoder().encode(encoded).byteLength) +
      1024;
    const prior = await this.local.get<Pending>(PENDING + key);
    const pendingBytesKey =
      location.kind === "group" ? GROUP_PENDING_BYTES : PENDING_BYTES;
    const stagingLimit =
      location.kind === "group" ? GROUP_STAGING_BYTES : SUPPORT_STAGING_BYTES;
    const used = (await this.local.get<number>(pendingBytesKey)) ?? 0;
    if (used - (prior?.bytes ?? 0) + bytes > stagingLimit)
      throw new HttpError(
        503,
        location.kind === "group"
          ? "Chat storage is catching up. Try again shortly."
          : "Support storage is catching up. Try again shortly.",
        30,
        `${location.kind}-storage-busy`,
      );
    const targets: Pending["targets"] = [{ id: location.id, mode: "data" }];
    const message =
      /^channel-message:([a-z0-9][a-z0-9-]{0,47}):([0-9]{16})$/.exec(key);
    if (message) {
      const lookup = `${location.kind}-search-location-v1:${message[1]}:${message[2]}`;
      let index = (await this.get<number>(lookup)) as number | undefined;
      const newIndexEntry = index === undefined && !deleted;
      if (index === undefined && !deleted) {
        const sequenceKey = `${location.kind}-store-search-sequence-v1`;
        const ordinal = ((await this.local.get<number>(sequenceKey)) ?? 0) + 1;
        await this.local.put(sequenceKey, ordinal);
        index = Math.floor((ordinal - 1) / SUPPORT_INDEX_PARTITION_SIZE);
        await this.stage(lookup, index, false);
      }
      if (index !== undefined) {
        const id = `${location.kind === "group" ? "g-s" : "s"}:${pad(index)}`;
        targets.push({ id, mode: "index" });
        const indexKey =
          (location.kind === "group"
            ? "group-store-search-v1:"
            : SEARCH_INDEX) + pad(index);
        const searchManifest =
          location.kind === "group"
            ? GROUP_SEARCH_MANIFEST
            : SUPPORT_SEARCH_MANIFEST;
        const priorIndex = await this.local.get<{
          id: string;
          count: number;
          minCreatedAt: number;
          maxCreatedAt: number;
        }>(indexKey);
        const count = Math.max(
          0,
          (priorIndex?.count ?? 0) +
            (newIndexEntry
              ? 1
              : deleted && previousValue !== undefined
                ? -1
                : 0),
        );
        if (priorIndex)
          await this.local.delete(
            `${searchManifest}${pad(priorIndex.maxCreatedAt)}:${pad(index)}`,
          );
        if (count) {
          const at =
            Date.parse(
              String(
                (value as { createdAt?: string } | undefined)?.createdAt ?? "",
              ),
            ) || 0;
          const manifest = {
            id,
            count,
            minCreatedAt: priorIndex
              ? Math.min(priorIndex.minCreatedAt, at || priorIndex.minCreatedAt)
              : at,
            maxCreatedAt: Math.max(priorIndex?.maxCreatedAt ?? 0, at),
          };
          await this.local.put(indexKey, manifest);
          await this.local.put(
            `${searchManifest}${pad(manifest.maxCreatedAt)}:${pad(index)}`,
            manifest,
          );
        } else await this.local.delete(indexKey);
      }
    }
    const version = ((await this.local.get<number>(VERSION)) ?? 0) + 1;
    if (
      ((await this.local.get<number>(pendingBytesKey)) ?? 0) -
        (prior?.bytes ?? 0) +
        bytes >
      stagingLimit
    )
      throw new HttpError(
        503,
        location.kind === "group"
          ? "Chat storage is catching up. Try again shortly."
          : "Support storage is catching up. Try again shortly.",
        30,
        `${location.kind}-storage-busy`,
      );
    const manifest = await this.local.get<Manifest>(manifestKey(location));
    const untrackedLocal = !prior && (await this.local.get(key)) !== undefined;
    const count = Math.max(
      0,
      (manifest?.count ?? 0) +
        (deleted
          ? untrackedLocal
            ? 0
            : -1
          : previousValue === undefined || untrackedLocal
            ? 1
            : 0),
    );
    if (count)
      await this.local.put(manifestKey(location), {
        ...location,
        count,
        minKey: manifest && manifest.minKey < key ? manifest.minKey : key,
        maxKey: manifest && manifest.maxKey > key ? manifest.maxKey : key,
      } satisfies Manifest);
    else await this.local.delete(manifestKey(location));
    await this.local.put(VERSION, version);
    // Re-read after staging the search locator, which reserves its own bytes.
    await this.local.put(
      pendingBytesKey,
      ((await this.local.get<number>(pendingBytesKey)) ?? 0) -
        (prior?.bytes ?? 0) +
        bytes,
    );
    await this.local.put(PENDING + key, {
      key,
      version,
      hash: await supportPayloadHash(encoded),
      encoded: null,
      deleted,
      bytes,
      targets,
    } satisfies Pending);
    if (deleted) await this.local.delete(key);
    else await this.local.put(key, value);
    // Commit the wake-up with the journal so a process stop before the HTTP
    // finalizer cannot leave an accepted write waiting for a daily alarm.
    await wakeRoomAt(this.local, Date.now() + 1_000);
    this.cache.set(key, deleted ? undefined : value);
  }
  async list<T>(
    options: DurableObjectListOptions = {},
  ): Promise<Map<string, T>> {
    const local = await this.local.list<T>(options);
    const prefix = options.prefix ?? "";
    // A full newest-first page above the cold boundary cannot contain an
    // archived row. Ordinary chat pages stay on the room object; older
    // cursors still merge the partition manifests below.
    const groupMessage = /^channel-message:([a-z0-9][a-z0-9-]{0,47}):$/.exec(
      prefix,
    );
    if (
      this.groupEnabled &&
      groupMessage &&
      options.reverse &&
      local.size >= (options.limit ?? 1000) &&
      [...local.keys()].at(-1)! >
        `channel-message:${groupMessage[1]}:${pad(ownCutoff(this.groupCutoffs, groupMessage[1]))}`
    )
      return local;
    if (
      prefix &&
      ![...SUPPORT_PREFIXES, ...GROUP_PREFIXES].some(
        (entry) => prefix.startsWith(entry) || entry.startsWith(prefix),
      ) &&
      !prefix.startsWith("support-search-location-v1:") &&
      !prefix.startsWith("group-search-location-v1:")
    )
      return local;
    const result = new Map(local);
    const limit = options.limit ?? 1000;
    let manifestCursor: string | undefined;
    let done = false;
    while (!done) {
      const manifests = await this.local.list<Manifest>({
        prefix: MANIFEST + prefix,
        reverse: options.reverse,
        limit: 32,
        ...(manifestCursor
          ? options.reverse
            ? { end: manifestCursor }
            : { startAfter: manifestCursor }
          : {}),
      });
      if (!manifests.size) break;
      const pageSize = Math.min(100, limit);
      const page = (manifest: Manifest, cursor?: string) =>
        this.request<{ rows: SupportPartitionRow[] }>(manifest.id, "data", {
          action: "list",
          options: {
            ...options,
            prefix: manifest.prefix,
            limit: pageSize,
            ...(cursor
              ? options.reverse
                ? { end: cursor }
                : { startAfter: cursor }
              : {}),
          },
        });
      const inRange = (manifest: Manifest) =>
        !(
          (options.end && manifest.minKey >= options.end) ||
          (options.start && manifest.maxKey < options.start) ||
          (options.startAfter && manifest.maxKey <= options.startAfter)
        );
      // The first pages of the next few partitions load together; each is
      // still merged in order, and one the page limit makes unnecessary is
      // never used.
      const ranged = [...manifests.values()].filter(inRange);
      const firstPages = new Map<
        Manifest,
        Promise<{ rows: SupportPartitionRow[] }>
      >();
      const prime = (from: number) => {
        for (const manifest of ranged.slice(from, from + PARTITION_LOOKAHEAD))
          if (!firstPages.has(manifest))
            firstPages.set(manifest, page(manifest));
        for (const read of firstPages.values()) read.catch(() => {});
      };
      for (const [manifestName, manifest] of manifests) {
        manifestCursor = manifestName;
        if (!inRange(manifest)) continue;
        prime(ranged.indexOf(manifest));
        let cursor: string | undefined;
        while (true) {
          const rows = cursor
            ? await page(manifest, cursor)
            : await firstPages.get(manifest)!;
          for (const row of rows.rows) {
            if (
              row.encoded !== null &&
              matches(row.key, options) &&
              !(await this.local.get(PENDING + row.key))
            )
              result.set(row.key, decodeSupportValue(row.encoded) as T);
          }
          cursor = rows.rows.at(-1)?.key;
          if (!cursor || rows.rows.length < pageSize) break;
          if (result.size >= limit) {
            const keys = [...result.keys()].sort();
            const boundary = options.reverse
              ? keys.at(-limit)!
              : keys[limit - 1];
            if (options.reverse ? cursor <= boundary : cursor >= boundary)
              break;
          }
        }
        // Manifests and record keys share lexical range ordering. Stop once the
        // next range cannot precede a full page, including local staged rows.
        if (result.size >= limit) {
          const keys = [...result.keys()].sort();
          const boundary = options.reverse ? keys.at(-limit)! : keys[limit - 1];
          if (
            options.reverse
              ? boundary >= manifest.minKey
              : boundary <= manifest.maxKey
          ) {
            done = true;
            break;
          }
        }
      }
      if (manifests.size < 32) break;
    }
    return new Map(
      [...result]
        .sort(([a], [b]) =>
          options.reverse ? b.localeCompare(a) : a.localeCompare(b),
        )
        .slice(0, limit),
    );
  }
}

export const supportStoreFor = (storage: object) => stores.get(storage);
export const supportStorageEnabled = (storage: Pick<Storage, "get">) =>
  Promise.all([
    storage.get<boolean>(ENABLED),
    storage.get<boolean>(GROUP_ENABLED),
  ]).then(([support, group]) => support === true || group === true);
export async function supportStoragePending(
  storage: Pick<Storage, "get" | "list">,
) {
  const support = (await storage.get<boolean>(ENABLED)) === true;
  const group = (await storage.get<boolean>(GROUP_ENABLED)) === true;
  if (!support && !group) return false;
  const supportCursor = support
    ? await storage.get<{ prefix: number }>(SUPPORT_ARCHIVE_CURSOR)
    : null;
  return (
    (support &&
      (!supportCursor || supportCursor.prefix < SUPPORT_PREFIXES.length)) ||
    (group && !(await storage.get<boolean>(GROUP_DISCOVERY_DONE))) ||
    (group &&
      (await storage.list({ prefix: GROUP_WORK, limit: 1 })).size > 0) ||
    (await storage.list({ prefix: PENDING, limit: 1 })).size > 0
  );
}
export async function supportStorage(
  local: Storage,
  env: StorageEnv,
  room: string,
  activate = true,
): Promise<Storage> {
  let enabled = (await local.get<boolean>(ENABLED)) === true;
  let groupEnabled = (await local.get<boolean>(GROUP_ENABLED)) === true;
  // Existing rooms keep their latest 512 messages per channel hot. Migration
  // copies older local rows before removing any original.
  if (
    !groupEnabled &&
    activate &&
    env.GROUP_HISTORY_ARCHIVE_ENABLED === "true" &&
    env.SUPPORT_PARTITIONS
  ) {
    await local.put(GROUP_CUTOFFS, {});
    await local.delete(GROUP_DISCOVERY_DONE);
    groupEnabled = true;
    await local.put(GROUP_ENABLED, true);
  }
  if (!enabled && activate && (await local.get(PRODUCT_STATE_KEY))) {
    const product = await readProductSupport(local, Date.now());
    if (product.funded) {
      if (!env.SUPPORT_PARTITIONS) throw missing();
      enabled = true;
      await local.put(ENABLED, true);
    }
  }
  if (!enabled && !groupEnabled) return local;
  if (!env.SUPPORT_PARTITIONS)
    throw missing(groupEnabled ? "group" : "support");
  let capability = await local.get<string>(CAPABILITY);
  if (!capability) {
    capability = crypto.randomUUID();
    await local.put(CAPABILITY, capability);
  }
  const groupCutoffs = groupEnabled
    ? ((await local.get<Record<string, number>>(GROUP_CUTOFFS)) ?? {})
    : {};
  return new SupportStorage(
    local,
    env,
    room,
    capability,
    enabled,
    groupEnabled,
    groupCutoffs,
  ).storage;
}

/** Discover only active group channels. The settings record is bounded by the
 * 100-channel product limit; old Support conversations and deleted channels
 * cannot hide an active channel behind an arbitrary sequence-list page. */
export async function discoverGroupStorage(
  state: DurableObjectState,
): Promise<boolean> {
  if (
    !(await state.storage.get<boolean>(GROUP_ENABLED)) ||
    (await state.storage.get<boolean>(GROUP_DISCOVERY_DONE))
  )
    return false;
  return state.storage.transaction(async (local) => {
    const settings = await local.get<{ channels?: { id: string }[] }>(
      "chat-settings",
    );
    const channels = settings?.channels ?? [{ id: "general" }];
    const cutoffs =
      (await local.get<Record<string, number>>(GROUP_CUTOFFS)) ?? {};
    for (const { id: channel } of channels.slice(0, 100)) {
      if (
        !/^[a-z0-9][a-z0-9-]{0,47}$/.test(channel) ||
        channel.startsWith("tc-")
      )
        continue;
      const sequence = await local.get<number>(`channel-sequence:${channel}`);
      if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) continue;
      const cutoff = Math.max(0, (sequence as number) - GROUP_HOT_MESSAGES);
      if (cutoff <= ownCutoff(cutoffs, channel)) continue;
      const prior = ownCutoff(cutoffs, channel);
      cutoffs[channel] = cutoff;
      const work = await local.get<GroupWork>(GROUP_WORK + channel);
      await local.put(GROUP_WORK + channel, {
        cursor: work?.cursor ?? prior,
        through: cutoff,
      } satisfies GroupWork);
    }
    await local.put(GROUP_CUTOFFS, cutoffs);
    await local.put(GROUP_DISCOVERY_DONE, true);
    return (await local.list({ prefix: GROUP_WORK, limit: 1 })).size > 0;
  });
}

/** Only invoked outside the user transaction. Every copy is durable before a
 * compare-and-swap removes the local payload. Lost responses leave it queued. */
export async function flushSupportStorage(
  state: DurableObjectState,
  env: StorageEnv,
): Promise<boolean> {
  if (!(await supportStorageEnabled(state.storage))) return false;
  const capability = await state.storage.get<string>(CAPABILITY);
  if (!capability || !env.SUPPORT_PARTITIONS) return true;
  const supportEnabled = (await state.storage.get<boolean>(ENABLED)) === true;
  const groupEnabled =
    (await state.storage.get<boolean>(GROUP_ENABLED)) === true;
  const client = new SupportStorage(
    state.storage as unknown as Storage,
    env,
    state.id.toString(),
    capability,
    supportEnabled,
    groupEnabled,
  );
  const pending = await state.storage.list<Pending>({
    prefix: PENDING,
    limit: 128,
  });
  const workload = { archiveCopies: 0, archiveBytes: 0, archiveFailures: 0 };
  try {
    for (const [pendingKey, entry] of pending) {
      const value = entry.deleted
        ? undefined
        : await state.storage.get(entry.key);
      const encoded = entry.deleted ? null : encodeSupportValue(value);
      if ((await supportPayloadHash(encoded)) !== entry.hash) continue;
      try {
        for (const target of entry.targets) {
          workload.archiveCopies++;
          workload.archiveBytes +=
            encoded === null ? 0 : new TextEncoder().encode(encoded).byteLength;
          const acknowledgment = await client.request<{
            acknowledgments: Pick<
              SupportPartitionRow,
              "key" | "version" | "hash"
            >[];
          }>(target.id, target.mode, {
            action: "apply",
            rows: [
              {
                key: entry.key,
                version: entry.version,
                hash: entry.hash,
                encoded,
              },
            ],
          });
          const saved = acknowledgment.acknowledgments[0];
          if (
            !saved ||
            saved.key !== entry.key ||
            saved.version !== entry.version ||
            saved.hash !== entry.hash
          )
            throw missing();
        }
        await state.storage.transaction(async (storage) => {
          const current = await storage.get<Pending>(pendingKey);
          if (
            !current ||
            current.version !== entry.version ||
            current.hash !== entry.hash
          )
            return;
          await storage.delete([entry.key, pendingKey]);
          const pendingBytesKey = groupLocation(entry.key)
            ? GROUP_PENDING_BYTES
            : PENDING_BYTES;
          await storage.put(
            pendingBytesKey,
            Math.max(
              0,
              ((await storage.get<number>(pendingBytesKey)) ?? 0) - entry.bytes,
            ),
          );
          const message =
            /^channel-message:([a-z0-9][a-z0-9-]{0,47}):([0-9]{16})$/.exec(
              entry.key,
            );
          if (message)
            await new SearchIndex(state.storage).remove(
              message[1],
              Number(message[2]),
            );
        });
      } catch {
        workload.archiveFailures++;
        return true;
      }
    }
    return pending.size > 0;
  } finally {
    if (workload.archiveCopies || workload.archiveFailures)
      await observeCostWorkload(env, async () => ({
        ...workload,
        pendingArchiveBytes:
          ((await state.storage.get<number>(PENDING_BYTES)) ?? 0) +
          ((await state.storage.get<number>(GROUP_PENDING_BYTES)) ?? 0),
      }));
  }
}

/** Archives the Support rows a workspace wrote in its own object before its
 * first verified top-up or grant turned on the partition store. */
export async function archiveSupportTrialHistory(
  state: DurableObjectState,
  env: StorageEnv,
) {
  if (!(await state.storage.get(ENABLED))) return false;
  return state.storage.transaction(async (local) => {
    const cursor = (await local.get<{ prefix: number; after?: string }>(
      SUPPORT_ARCHIVE_CURSOR,
    )) ?? { prefix: 0 };
    if (cursor.prefix >= SUPPORT_PREFIXES.length) return false;
    const storage = await supportStorage(
      local,
      env,
      state.id.toString(),
      false,
    );
    const rows = await local.list({
      prefix: SUPPORT_PREFIXES[cursor.prefix],
      ...(cursor.after ? { startAfter: cursor.after } : {}),
      limit: 20,
    });
    for (const [key, value] of rows)
      if (supportLocation(key) && !(await local.get(PENDING + key)))
        await storage.put(key, value);
    if (rows.size < 20)
      await local.put(SUPPORT_ARCHIVE_CURSOR, { prefix: cursor.prefix + 1 });
    else
      await local.put(SUPPORT_ARCHIVE_CURSOR, {
        ...cursor,
        after: [...rows.keys()].at(-1),
      });
    return true;
  });
}

/** Move rows outside each channel's hot window. Range scans skip deleted ID
 * gaps, and the rotating work cursor prevents a busy channel from starving
 * another. Original rows stay local until data and search copies are ACKed. */
export async function migrateGroupStorage(
  state: DurableObjectState,
  env: StorageEnv,
) {
  if (!(await state.storage.get(GROUP_ENABLED))) return false;
  return state.storage.transaction(async (local) => {
    // Delivery is the bottleneck, not local copying. Never create a new cold
    // page while the prior journal still holds a full migration batch.
    if ((await local.list({ prefix: PENDING, limit: 32 })).size >= 32)
      return true;
    const lastWork = await local.get<string>(GROUP_WORK_CURSOR);
    let works = await local.list<GroupWork>({
      prefix: GROUP_WORK,
      ...(lastWork ? { startAfter: lastWork } : {}),
      limit: 1,
    });
    if (!works.size)
      works = await local.list<GroupWork>({ prefix: GROUP_WORK, limit: 1 });
    if (!works.size) return false;
    const chosen = works.entries().next().value!;
    const [workKey, work] = chosen;
    const channel = workKey.slice(GROUP_WORK.length);
    const records = new Map<string, unknown>();
    for (const family of GROUP_PREFIXES) {
      const prefix = `${family}${channel}:`;
      const page = await local.list({
        prefix,
        startAfter: prefix + pad(work.cursor),
        end: prefix + pad(work.through + 1),
        limit: GROUP_MIGRATION_IDS_PER_ALARM,
      });
      for (const entry of page) records.set(...entry);
    }
    const ids = [
      ...new Set(
        [...records.keys()].map((key) =>
          Number(key.slice(key.lastIndexOf(":") + 1)),
        ),
      ),
    ]
      .sort((a, b) => a - b)
      .slice(0, GROUP_MIGRATION_IDS_PER_ALARM);
    const lastId = ids.at(-1) ?? work.through;
    if (ids.length) {
      const storage = await supportStorage(
        local,
        env,
        state.id.toString(),
        false,
      );
      for (const [key, value] of records)
        if (
          Number(key.slice(key.lastIndexOf(":") + 1)) <= lastId &&
          !(await local.get(PENDING + key))
        )
          await storage.put(key, value);
    }
    if (lastId >= work.through) await local.delete(workKey);
    else await local.put(workKey, { ...work, cursor: lastId });
    await local.put(GROUP_WORK_CURSOR, workKey);
    return (await local.list({ prefix: GROUP_WORK, limit: 1 })).size > 0;
  });
}
