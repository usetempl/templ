import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError, type Env } from "./common";

/** Group files kept in private R2 and their MediaQuota ledgers: one account
 * ledger per uploader and 64 service budget shards. The alarms here delete
 * staged files no message holds and return their budget. They read stored
 * ledgers only, so they keep working without the upload routes in
 * group-attachments.ts.
 *
 * Before it deletes a staged file, the account alarm asks the file's room
 * whether a stored message still holds it: `POST
 * /private/group-media-reference`, which the room answers with
 * `groupMediaReferenced` below. That read uses the room's stored bindings
 * alone and stays as long as stored group messages do. */
/** Server-owned metadata for one stored group file, as stored messages and
 * ledgers carry it. */
export type RetiredGroupAttachment = {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
};
/** Stored group files: these limits exist only so stored files keep
 * draining. No route accepts a new file. */
export const RETIRED_GROUP_FILE_LIMITS = {
  filesPerMessage: 4,
  fileBytes: 10 * 1024 * 1024,
  accountDailyBytes: 250 * 1024 * 1024,
  accountDailyFiles: 100,
  accountRetainedBytes: 2 * 1024 * 1024 * 1024,
  accountRetainedFiles: 1_024,
  accountStagedFiles: 8,
  accountDailyDiscards: 128,
  roomDailyDiscards: 32_768,
  serviceRetainedBytes: 8 * 1024 * 1024 * 1024 * 1024,
  serviceRetainedFiles: 1_048_576,
  serviceDailyIngressBytes: 256 * 1024 * 1024 * 1024,
  serviceDailyIngressFiles: 32_768,
  stagedHours: 24,
} as const;
export const GROUP_ATTACHMENT_ID = /^[0-9a-f]{64}$/;
export const GROUP_ATTACHMENT_OBJECT_PREFIX = "group/";
export const ROOM =
  /^room:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export const SHARDS = 64;
const DAY = 86_400_000;
const RETRY_MS = 60_000;
export const ACCOUNT_KEY = "group-account-v1";
export const BUDGET_KEY = "group-budget-v1";
const BUDGET_ROW = "group-budget-entry-v1:";
const BUDGET_DUE = "group-budget-due-v1:";
/** Binds an account ledger to its uploader and a budget ledger to its shard. */
export const ACCOUNT_OWNER_KEY = "group-account-owner-v1";
export const BUDGET_SHARD_KEY = "group-budget-shard-v1";

export type GroupAttachmentScope = {
  room: string;
  channel: string;
  owner: ChatPrincipalId;
};
export type GroupAttachmentRecord = GroupAttachmentScope &
  RetiredGroupAttachment & {
    contentHash: string;
    stagedUntil: number | null;
    leaseUntil: number;
    uploadLeaseUntil?: number;
    deleting: boolean;
    revoked: boolean;
    reservationToken?: string;
  };
export type AccountLedger = {
  attempts: { at: number; bytes: number }[];
  discardAttempts?: { id: string; at: number }[];
  entries: Record<string, GroupAttachmentRecord>;
  discards?: Record<string, number>;
};
export type BudgetEntry = {
  bytes: number;
  status: "reserved" | "committed";
  due: number | null;
};
export type Budget = { bytes: number; files: number };
export const emptyLedger = (): AccountLedger => ({
  attempts: [],
  discardAttempts: [],
  entries: {},
  discards: {},
});
export const emptyBudget = (): Budget => ({ bytes: 0, files: 0 });
export const objectKey = (id: string) =>
  `${GROUP_ATTACHMENT_OBJECT_PREFIX}${id}`;
export const rowKey = (id: string) => `${BUDGET_ROW}${id}`;
export const dueKey = (id: string, due: number) =>
  `${BUDGET_DUE}${String(due).padStart(16, "0")}:${id}`;
export const bucket = (env: Env) => {
  if (!env.MEDIA_BUCKET) throw unavailable();
  return env.MEDIA_BUCKET;
};
export const unavailable = () =>
  new HttpError(503, "File storage is unavailable.");
export const bytesHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export const hexBytes = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
export function secret(env: Env) {
  const value = env.MEDIA_SHARD_KEY?.trim();
  if (
    !value ||
    !GROUP_ATTACHMENT_ID.test(value) ||
    env.MEDIA_BUDGET_SHARDS !== String(SHARDS)
  )
    throw unavailable();
  return hexBytes(value);
}
export async function shard(env: Env, id: string) {
  // The scoped id is a 256-bit HMAC output. Its first byte is uniform and
  // immutable, so budget ownership survives a later signing-key rotation.
  secret(env);
  if (!GROUP_ATTACHMENT_ID.test(id)) throw unavailable();
  return Number.parseInt(id.slice(0, 2), 16) % SHARDS;
}
export function quota(env: Env, name: string) {
  if (!env.MEDIA_QUOTAS) throw unavailable();
  return env.MEDIA_QUOTAS.get(env.MEDIA_QUOTAS.idFromName(name));
}
const budget = async (env: Env, id: string) => {
  const number = await shard(env, id);
  return { number, stub: quota(env, `group-budget:${number}`) };
};
export async function post(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
) {
  const response = await stub.fetch(
    new Request(`https://internal/group/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    const answer = await response
      .clone()
      .json<{ error?: string }>()
      .catch((): { error?: string } => ({}));
    const message = answer.error;
    throw new HttpError(
      response.status,
      message ?? "File storage is unavailable.",
      Number(response.headers.get("Retry-After")) || undefined,
    );
  }
  return response;
}
export async function postBudget(
  env: Env,
  path: string,
  id: string,
  bytes: number,
) {
  const { number, stub } = await budget(env, id);
  return post(stub, `budget/${path}`, { id, bytes, shard: number });
}
function objectHash(object: R2Object) {
  const sha = object.checksums.sha256;
  return sha ? bytesHex(new Uint8Array(sha)) : null;
}
export function validObject(object: R2Object, record: GroupAttachmentRecord) {
  const data = object.customMetadata;
  return (
    object.size === record.bytes &&
    object.size > 0 &&
    object.size <= RETIRED_GROUP_FILE_LIMITS.fileBytes &&
    object.httpMetadata?.contentType === "application/octet-stream" &&
    objectHash(object) === record.contentHash &&
    data?.id === record.id &&
    data?.room === record.room &&
    data?.channel === record.channel &&
    data?.owner === record.owner &&
    data?.name === record.name &&
    data?.fileType === record.contentType &&
    data?.sha256 === record.contentHash
  );
}
export async function head(env: Env, id: string) {
  try {
    return await bucket(env).head(objectKey(id));
  } catch {
    throw unavailable();
  }
}
export async function scheduleAccount(
  state: DurableObjectState,
  ledger: AccountLedger,
) {
  const due = [
    ...Object.values(ledger.entries).map((entry) =>
      entry.stagedUntil === null
        ? Infinity
        : Math.max(
            entry.stagedUntil,
            entry.leaseUntil,
            entry.uploadLeaseUntil ?? 0,
          ),
    ),
    ...Object.values(ledger.discards ?? {}),
    ...(ledger.discardAttempts ?? []).map((attempt) => attempt.at + DAY),
  ].reduce((min, at) => Math.min(min, at), Infinity);
  if (Number.isFinite(due))
    await state.storage.setAlarm(Math.max(Date.now() + 1_000, due));
}
export async function scheduleBudget(state: DurableObjectState) {
  const due = await state.storage.list({ prefix: BUDGET_DUE, limit: 1 });
  const first = due.keys().next().value as string | undefined;
  if (first) {
    const at = Number(first.slice(BUDGET_DUE.length, BUDGET_DUE.length + 16));
    if (!Number.isSafeInteger(at)) throw unavailable();
    await state.storage.setAlarm(Math.max(Date.now() + 1_000, at));
  }
}
/** What a room keeps under `group-attachment-v1:<channel>:<id>` when a
 * message holds a staged file. Deleting the message marks it deleted. */
export type StoredGroupAttachmentBinding = {
  owner: ChatPrincipalId;
  messageId: string;
  attachment: RetiredGroupAttachment;
  deleted: boolean;
};
export const GROUP_ATTACHMENT_BINDING_PREFIX = "group-attachment-v1:";
export const groupAttachmentBindingKey = (channel: string, id: string) =>
  `${GROUP_ATTACHMENT_BINDING_PREFIX}${channel}:${id}`;
/** The room side of the cleanup check: true while a stored message in this
 * channel holds the file for its uploader. */
export async function groupMediaReferenced(
  storage: Pick<DurableObjectStorage, "get">,
  value: { channel: string; id: string; owner: string },
) {
  if (!GROUP_ATTACHMENT_ID.test(value.id)) return false;
  const binding = await storage.get<StoredGroupAttachmentBinding>(
    groupAttachmentBindingKey(value.channel, value.id),
  );
  return Boolean(binding && !binding.deleted && binding.owner === value.owner);
}
async function accountAlarm(state: DurableObjectState, env: Env) {
  const now = Date.now();
  const ledger =
    (await state.storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger();
  const due = Object.values(ledger.entries)
    .filter(
      (entry) =>
        entry.stagedUntil !== null &&
        Math.max(
          entry.stagedUntil,
          entry.leaseUntil,
          entry.uploadLeaseUntil ?? 0,
        ) <= now,
    )
    .slice(0, 8);
  for (const entry of due) {
    const marked = await state.storage.transaction(async (storage) => {
      const current =
        (await storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger();
      const candidate = current.entries[entry.id];
      if (
        !candidate ||
        candidate.stagedUntil === null ||
        candidate.leaseUntil > now ||
        (candidate.uploadLeaseUntil ?? 0) > now ||
        candidate.stagedUntil > now
      )
        return false;
      candidate.deleting = true;
      candidate.stagedUntil = now + RETRY_MS;
      await storage.put(ACCOUNT_KEY, current);
      return true;
    });
    if (!marked) continue;
    try {
      const roomId = ROOM.exec(entry.room)?.[1];
      if (!roomId) throw unavailable();
      const response = await env.ROOMS.get(
        env.ROOMS.idFromName(`native-room:${roomId}`),
      ).fetch(
        new Request("https://internal/private/group-media-reference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: entry.room,
            channel: entry.channel,
            id: entry.id,
            owner: entry.owner,
          }),
        }),
      );
      if (!response.ok) throw unavailable();
      const { referenced } = await response.json<{ referenced?: unknown }>();
      if (typeof referenced !== "boolean") throw unavailable();
      const object = await head(env, entry.id);
      if (object && !validObject(object, entry)) throw unavailable();
      if (!referenced) {
        if (object) await bucket(env).delete(objectKey(entry.id));
        await postBudget(env, "release", entry.id, entry.bytes);
      }
      await state.storage.transaction(async (storage) => {
        const current =
          (await storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger();
        const candidate = current.entries[entry.id];
        if (!candidate?.deleting) return;
        if (referenced && object && !candidate.revoked) {
          candidate.deleting = false;
          candidate.stagedUntil = null;
        } else if (referenced) {
          candidate.deleting = false;
          candidate.stagedUntil = Date.now() + RETRY_MS;
        } else delete current.entries[entry.id];
        await storage.put(ACCOUNT_KEY, current);
      });
    } catch {
      await state.storage.transaction(async (storage) => {
        const current =
          (await storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger();
        const candidate = current.entries[entry.id];
        if (candidate?.deleting) {
          candidate.stagedUntil = Date.now() + RETRY_MS;
          await storage.put(ACCOUNT_KEY, current);
        }
      });
    }
  }
  await state.storage.transaction(async (storage) => {
    const current =
      (await storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger();
    const pending = current.discards ?? {};
    const retained = Object.fromEntries(
      Object.entries(pending).filter(([, until]) => until > Date.now()),
    );
    const attempts = current.discardAttempts ?? [];
    const recent = attempts.filter((attempt) => attempt.at > Date.now() - DAY);
    if (
      Object.keys(retained).length !== Object.keys(pending).length ||
      recent.length !== attempts.length
    ) {
      current.discards = retained;
      current.discardAttempts = recent;
      await storage.put(ACCOUNT_KEY, current);
    }
  });
  await scheduleAccount(
    state,
    (await state.storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger(),
  );
}
async function budgetAlarm(state: DurableObjectState, env: Env) {
  const due = await state.storage.list({ prefix: BUDGET_DUE, limit: 32 });
  const now = Date.now();
  for (const dueKeyValue of due.keys()) {
    const id = dueKeyValue.slice(dueKeyValue.lastIndexOf(":") + 1);
    const entry = await state.storage.get<BudgetEntry>(rowKey(id));
    if (!entry || entry.due === null || dueKey(id, entry.due) !== dueKeyValue) {
      await state.storage.delete(dueKeyValue);
      continue;
    }
    if (entry.due > now) break;
    let exists: boolean | null = null;
    try {
      exists = Boolean(await head(env, id));
    } catch {
      /* Keep cost reserved on outage. */
    }
    await state.storage.transaction(async (storage) => {
      const current = await storage.get<BudgetEntry>(rowKey(id));
      if (
        !current ||
        current.status !== "reserved" ||
        current.due !== entry.due
      )
        return;
      await storage.delete(dueKeyValue);
      if (exists === true)
        await storage.put(rowKey(id), {
          ...current,
          status: "committed",
          due: null,
        });
      else if (exists === false) {
        const count = (await storage.get<Budget>(BUDGET_KEY)) ?? emptyBudget();
        count.bytes -= current.bytes;
        count.files--;
        if (count.bytes < 0 || count.files < 0) throw unavailable();
        await storage.delete(rowKey(id));
        await storage.put(BUDGET_KEY, count);
      } else {
        const next = now + RETRY_MS;
        await storage.put(rowKey(id), { ...current, due: next });
        await storage.put(dueKey(id, next), true);
      }
    });
  }
  await scheduleBudget(state);
}
/** MediaQuota alarm for a group ledger object. */
export async function groupAttachmentCleanupAlarm(
  state: DurableObjectState,
  env: Env,
) {
  const owner = await state.storage.get<string>(ACCOUNT_OWNER_KEY);
  if (owner) return accountAlarm(state, env);
  const shard = await state.storage.get<number>(BUDGET_SHARD_KEY);
  if (shard !== undefined) return budgetAlarm(state, env);
}
