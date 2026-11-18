import { HttpError, json, type Env } from "./common";
import { SearchIndex } from "./search-index";
import type { StoredMessage } from "./message-store";
import {
  markPartitionCreated,
  partitionRecoveryRoute,
} from "./storage-recovery-object";

/** Internal binding only. The HTTP worker never forwards a public route here. */
export type SupportPartitionRow = {
  key: string;
  version: number;
  hash: string;
  encoded: string | null;
};
export type SupportPartitionIdentity = {
  room: string;
  capability: string;
  partition: string;
  mode: "data" | "index";
};
export const SUPPORT_MESSAGE_PARTITION_SIZE = 512;
export const SUPPORT_INDEX_PARTITION_SIZE = 8192;
/** The Free-tier limit is 1 GB/object. Keep room for SQLite indexes and
 * transaction overhead before the provider starts rejecting writes. */
export const SUPPORT_PARTITION_MAX_BYTES = 800_000_000;
export const SUPPORT_PARTITION_PAID_MAX_BYTES = 2_000_000_000;
export const supportPartitionWriteLimitBytes = (storagePlan?: string) =>
  storagePlan === "paid"
    ? SUPPORT_PARTITION_PAID_MAX_BYTES
    : SUPPORT_PARTITION_MAX_BYTES;
const MAX_ENCODED_ROW = 300_000;
const ROW = "support-record-v1:";
const MESSAGE = /^channel-message:([a-z0-9][a-z0-9-]{0,47}):([0-9]{16})$/;
const encoder = new TextEncoder();
export function encodeSupportValue(value: unknown) {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return JSON.stringify({ bytes: btoa(binary) });
  }
  return JSON.stringify({ value });
}
export function decodeSupportValue(encoded: string) {
  const row = JSON.parse(encoded) as { bytes?: string; value?: unknown };
  return row.bytes === undefined
    ? row.value
    : Uint8Array.from(atob(row.bytes), (char) => char.charCodeAt(0));
}
export async function supportPayloadHash(encoded: string | null) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(encoded === null ? "deleted" : encoded),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class SupportPartition {
  private readonly index: SearchIndex;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Pick<Env, "DO_STORAGE_PLAN"> = {},
  ) {
    this.index = new SearchIndex(state.storage);
  }
  async fetch(request: Request) {
    // Storage recovery: bookmarks, restore and orphan deletion.
    if (new URL(request.url).pathname.startsWith("/private/recovery/"))
      return partitionRecoveryRoute(this.state, request);
    try {
      if (request.method !== "POST") throw new HttpError(404, "Not found.");
      const raw = await request.text();
      if (encoder.encode(raw).byteLength > 2_500_000)
        throw new HttpError(413, "Partition batch is too large.");
      const body = JSON.parse(raw) as SupportPartitionIdentity & {
        action: string;
        rows?: SupportPartitionRow[];
        key?: string;
        keys?: string[];
        options?: DurableObjectListOptions;
        match?: string;
        channels?: string[];
        cursor?: { createdAt: number; channelId: string; id: number } | null;
        limit?: number;
      };
      if (
        !/^[0-9a-f]{64}$/.test(body.room) ||
        !/^[0-9a-f-]{36}$/.test(body.capability) ||
        !/^[a-z0-9:-]{1,180}$/.test(body.partition) ||
        !["data", "index"].includes(body.mode)
      )
        throw new HttpError(403, "Partition access denied.");
      return await this.state.storage.transaction(async (storage) => {
        const identity =
          await storage.get<SupportPartitionIdentity>("identity");
        if (
          identity &&
          (identity.room !== body.room ||
            identity.capability !== body.capability ||
            identity.partition !== body.partition ||
            identity.mode !== body.mode)
        )
          throw new HttpError(403, "Partition access denied.");
        if (!identity && body.action !== "apply")
          return json(body.action === "get" ? { row: null } : { rows: [] });
        if (body.action === "apply") {
          if (
            !Array.isArray(body.rows) ||
            body.rows.length < 1 ||
            body.rows.length > 8
          )
            throw new HttpError(400, "Invalid partition batch.");
          const writeLimit = supportPartitionWriteLimitBytes(
            this.env.DO_STORAGE_PLAN,
          );
          if (!identity) {
            await storage.put("identity", {
              room: body.room,
              capability: body.capability,
              partition: body.partition,
              mode: body.mode,
            });
            await markPartitionCreated(storage);
          }
          const acknowledgments: {
            key: string;
            version: number;
            hash: string;
          }[] = [];
          let wrotePayload = false;
          for (const row of body.rows) {
            if (
              !row ||
              typeof row.key !== "string" ||
              row.key.length > 240 ||
              !Number.isSafeInteger(row.version) ||
              row.version < 1 ||
              !/^[0-9a-f]{64}$/.test(row.hash) ||
              !(row.encoded === null || typeof row.encoded === "string") ||
              (row.encoded !== null &&
                encoder.encode(row.encoded).byteLength > MAX_ENCODED_ROW) ||
              (await supportPayloadHash(row.encoded)) !== row.hash ||
              (body.mode === "index" && !MESSAGE.test(row.key))
            )
              throw new HttpError(400, "Invalid partition row.");
            const key = ROW + row.key;
            const previous = await storage.get<SupportPartitionRow>(key);
            if (
              previous &&
              previous.version === row.version &&
              previous.hash !== row.hash
            )
              throw new HttpError(409, "Partition revision conflict.");
            if (!previous || previous.version < row.version) {
              // Keep deletion ACKs available at the write threshold. The
              // 200 MB Free-tier reserve also covers tombstone metadata and
              // index removal while the room journal drains. A non-deletion
              // revision still cannot grow this partition.
              if (
                row.encoded !== null &&
                this.state.storage.sql.databaseSize >= writeLimit
              )
                throw new HttpError(
                  503,
                  "Support storage needs attention.",
                  30,
                  "support-storage-capacity",
                );
              // An index partition needs only revision/hash for idempotent
              // ACKs. Search keeps its own FTS rows; the authoritative body
              // lives in the data partition and is re-read by the room.
              await storage.put(
                key,
                body.mode === "index" ? { ...row, encoded: null } : row,
              );
              if (row.encoded !== null) wrotePayload = true;
              const match = MESSAGE.exec(row.key);
              if (body.mode === "index" && match) {
                if (row.encoded === null) {
                  await this.index.remove(match[1], Number(match[2]));
                } else {
                  const message = decodeSupportValue(
                    row.encoded,
                  ) as StoredMessage;
                  await this.index.upsert(match[1], message);
                }
              }
            }
            // An older retry is acknowledged as the newer durable version. It
            // never overwrites or resurrects that version.
            const stored =
              previous && previous.version > row.version ? previous : row;
            acknowledgments.push({
              key: stored.key,
              version: stored.version,
              hash: stored.hash,
            });
          }
          if (wrotePayload && this.state.storage.sql.databaseSize > writeLimit)
            throw new HttpError(
              503,
              "Support storage needs attention.",
              30,
              "support-storage-capacity",
            );
          return json({
            acknowledgments,
            bytes: this.state.storage.sql.databaseSize,
          });
        }
        if (body.action === "get") {
          if (typeof body.key !== "string")
            throw new HttpError(400, "Invalid partition key.");
          return json({ row: (await storage.get(ROW + body.key)) ?? null });
        }
        if (body.action === "get-many") {
          // Read-time reply joins use this only for rows in the room's already
          // authorized channel. Keep the batch bounded by the page join cap.
          if (
            !Array.isArray(body.keys) ||
            body.keys.length < 1 ||
            body.keys.length > 50 ||
            body.keys.some(
              (key) => typeof key !== "string" || !MESSAGE.test(key),
            )
          )
            throw new HttpError(400, "Invalid partition keys.");
          const rows = await storage.get<SupportPartitionRow>(
            body.keys.map((key) => ROW + key),
          );
          return json({ rows: [...rows.values()] });
        }
        if (body.action === "list") {
          const options = body.options ?? {};
          const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
          const rows = await storage.list<SupportPartitionRow>({
            prefix: ROW + (options.prefix ?? ""),
            ...(options.start ? { start: ROW + options.start } : {}),
            ...(options.startAfter
              ? { startAfter: ROW + options.startAfter }
              : {}),
            ...(options.end ? { end: ROW + options.end } : {}),
            reverse: options.reverse,
            limit,
          });
          return json({ rows: [...rows.values()] });
        }
        if (body.action === "search" && body.mode === "index") {
          if (
            typeof body.match !== "string" ||
            !Array.isArray(body.channels) ||
            body.channels.length > 100
          )
            throw new HttpError(400, "Invalid partition search.");
          await this.index.ensureSchema(storage);
          return json({
            rows: this.index.candidates(
              body.match,
              body.channels,
              body.cursor ?? null,
              Math.min(21, body.limit ?? 21),
            ),
          });
        }
        throw new HttpError(404, "Not found.");
      });
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Support storage is unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
      );
    }
  }
}
