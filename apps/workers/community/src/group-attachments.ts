import type { ChatPrincipalId } from "@templ/chat/principal";
import { principal } from "./principal";
import { HttpError, json, type Env } from "./common";
import {
  ACCOUNT_KEY,
  ACCOUNT_OWNER_KEY,
  BUDGET_KEY,
  BUDGET_SHARD_KEY,
  dueKey,
  emptyBudget,
  emptyLedger,
  GROUP_ATTACHMENT_ID,
  post,
  quota,
  RETIRED_GROUP_FILE_LIMITS,
  ROOM,
  rowKey,
  scheduleAccount,
  scheduleBudget,
  shard,
  SHARDS,
  unavailable,
  type AccountLedger,
  type Budget,
  type BudgetEntry,
  type GroupAttachmentRecord,
} from "./group-attachment-cleanup";

/** Stored group files: the MediaQuota ledgers that count them. No route
 * accepts or serves a group file; these ledger routes let the drain in
 * group-attachment-cleanup.ts release stored files. */

const DAY = 86_400_000;
/** The file types a stored group file can carry. */
const GROUP_ATTACHMENT_CONTENT_TYPES = [
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
type GroupAttachmentType = (typeof GROUP_ATTACHMENT_CONTENT_TYPES)[number];
const CHANNEL = /^[a-z0-9-]{1,64}$/;
const STAGED_MS = RETIRED_GROUP_FILE_LIMITS.stagedHours * 3_600_000;
const RESERVATION_MS = 15 * 60_000;
const BUDGET_INGRESS = "group-budget-ingress-v1";
type IngressAttempt = { at: number; bytes: number };
const limited = (message: string) =>
  json({ error: message }, 429, { "Retry-After": "3600" });
const knownType = (value: unknown): value is GroupAttachmentType =>
  GROUP_ATTACHMENT_CONTENT_TYPES.includes(value as GroupAttachmentType);
function fileName(value: unknown) {
  if (typeof value !== "string")
    throw new HttpError(400, "Choose a file name.");
  const name = value.normalize("NFC").trim();
  if (
    !name ||
    [...name].length > 120 ||
    new TextEncoder().encode(name).length > 240 ||
    name === "." ||
    name === ".." ||
    // eslint-disable-next-line no-control-regex
    /[\\/\u0000-\u001f\u007f]|\p{Bidi_Control}/u.test(name)
  )
    throw new HttpError(
      400,
      "Choose a file name up to 120 characters without slashes or hidden direction marks.",
    );
  return name;
}
function exact(a: GroupAttachmentRecord, b: GroupAttachmentRecord) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.bytes === b.bytes &&
    a.contentType === b.contentType &&
    a.contentHash === b.contentHash &&
    a.owner === b.owner &&
    a.room === b.room &&
    a.channel === b.channel
  );
}
/** Returns a deleted message's file to its uploader's ledger. The room's
 * cleanup outbox calls it for stored group files. */
export async function releaseGroupAttachment(
  env: Env,
  owner: ChatPrincipalId,
  id: string,
) {
  await post(quota(env, `group-account:${principal(owner)}`), "account/release", {
    id,
  });
}

// MediaQuota ledger routes ------------------------------------------------------
function parseBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Invalid file request.");
  return value as Record<string, unknown>;
}
async function accountRequest(
  state: DurableObjectState,
  env: Env,
  path: string,
  body: Record<string, unknown>,
) {
  const now = Date.now();
  const answer = await state.storage.transaction(async (storage) => {
    const ledger =
      (await storage.get<AccountLedger>(ACCOUNT_KEY)) ?? emptyLedger();
    ledger.discards ??= {};
    const id = body.id;
    if (
      path !== "commit" &&
      (typeof id !== "string" || !GROUP_ATTACHMENT_ID.test(id))
    )
      throw new HttpError(400, "Invalid file request.");
    const existing = typeof id === "string" ? ledger.entries[id] : undefined;
    let reservationToken: string | undefined;
    if (path === "check-discard") {
      if (
        !ROOM.test(body.room as string) ||
        !CHANNEL.test(body.channel as string) ||
        principal(body.owner) !== body.owner ||
        (await storage.get<string>(ACCOUNT_OWNER_KEY)) !== body.owner ||
        !(
          (existing &&
            existing.owner === body.owner &&
            existing.room === body.room &&
            existing.channel === body.channel &&
            existing.stagedUntil !== null) ||
          (ledger.discards[id as string] ?? 0) > now
        )
      )
        throw new HttpError(404, "File not found.");
      return json({ ok: true });
    } else if (path === "admit-discard") {
      const owner = principal(body.owner);
      const boundOwner = await storage.get<string>(ACCOUNT_OWNER_KEY);
      if (boundOwner && boundOwner !== owner)
        throw new HttpError(404, "File not found.");
      ledger.discardAttempts = (ledger.discardAttempts ?? []).filter(
        (attempt) => attempt.at > now - DAY,
      );
      if (!ledger.discardAttempts.some((attempt) => attempt.id === id)) {
        if (
          ledger.discardAttempts.length >=
          RETIRED_GROUP_FILE_LIMITS.accountDailyDiscards
        )
          return limited("Too many file removals today. Try again later.");
        ledger.discardAttempts.push({ id: id as string, at: now });
      }
      if (!boundOwner) await storage.put(ACCOUNT_OWNER_KEY, owner);
    } else if (path === "reserve") {
      const input = body as GroupAttachmentRecord;
      if (
        !ROOM.test(input.room) ||
        !CHANNEL.test(input.channel) ||
        !GROUP_ATTACHMENT_ID.test(input.contentHash) ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes > RETIRED_GROUP_FILE_LIMITS.fileBytes ||
        !knownType(input.contentType) ||
        fileName(input.name) !== input.name ||
        principal(input.owner) !== input.owner
      )
        throw new HttpError(400, "Invalid file request.");
      if ((ledger.discards[input.id] ?? 0) > now)
        throw new HttpError(410, "This file was removed. Choose it again.");
      const owner = await storage.get<string>(ACCOUNT_OWNER_KEY);
      if (owner && owner !== input.owner) throw unavailable();
      if (existing) {
        if (!exact(existing, input) || existing.deleting || existing.revoked)
          throw new HttpError(409, "Choose this file again.");
        if (existing.stagedUntil === null)
          throw new HttpError(409, "This file is already in a message.");
        // One writer per scoped id: replacing the token while another R2 put
        // is in flight could let an alarm delete before that put completes.
        if ((existing.uploadLeaseUntil ?? 0) > now)
          throw new HttpError(409, "This file is still uploading.");
        existing.stagedUntil = now + STAGED_MS;
        existing.uploadLeaseUntil = now + RESERVATION_MS;
        existing.reservationToken = crypto.randomUUID().replaceAll("-", "");
        reservationToken = existing.reservationToken;
      } else {
        ledger.attempts = ledger.attempts.filter(
          (attempt) => attempt.at > now - DAY,
        );
        const entries = Object.values(ledger.entries);
        if (
          entries.length >= RETIRED_GROUP_FILE_LIMITS.accountRetainedFiles ||
          entries.reduce((sum, entry) => sum + entry.bytes, 0) + input.bytes >
            RETIRED_GROUP_FILE_LIMITS.accountRetainedBytes
        )
          return limited(
            "This account's file storage is full. Delete old files to add more.",
          );
        if (
          entries.filter(
            (entry) => entry.stagedUntil !== null && !entry.revoked,
          ).length >= RETIRED_GROUP_FILE_LIMITS.accountStagedFiles
        )
          return limited(
            "Send or remove a pending file before adding another.",
          );
        if (
          ledger.attempts.length >= RETIRED_GROUP_FILE_LIMITS.accountDailyFiles ||
          ledger.attempts.reduce((sum, attempt) => sum + attempt.bytes, 0) +
            input.bytes >
            RETIRED_GROUP_FILE_LIMITS.accountDailyBytes
        )
          return limited("This account's daily file upload limit is reached.");
        ledger.entries[input.id] = {
          ...input,
          stagedUntil: now + STAGED_MS,
          leaseUntil: 0,
          uploadLeaseUntil: now + RESERVATION_MS,
          deleting: false,
          revoked: false,
          reservationToken: crypto.randomUUID().replaceAll("-", ""),
        };
        reservationToken = ledger.entries[input.id].reservationToken;
        ledger.attempts.push({ at: now, bytes: input.bytes });
      }
      if (!owner) await storage.put(ACCOUNT_OWNER_KEY, input.owner);
    } else if (path === "cancel") {
      if (
        existing &&
        existing.reservationToken === body.reservationToken &&
        existing.stagedUntil !== null &&
        !existing.deleting
      ) {
        existing.stagedUntil = now;
        existing.uploadLeaseUntil = 0;
      }
    } else if (path === "finalize") {
      if (
        !existing ||
        existing.reservationToken !== body.reservationToken ||
        existing.deleting
      )
        throw new HttpError(409, "Choose this file again.");
      existing.uploadLeaseUntil = 0;
      if (existing.revoked || (ledger.discards[id as string] ?? 0) > now) {
        existing.stagedUntil = now;
        await storage.put(ACCOUNT_KEY, ledger);
        return {
          ledger,
          reservationToken,
          error: new HttpError(410, "This file was removed. Choose it again."),
        };
      }
    } else if (path === "discard") {
      if (
        !ROOM.test(body.room as string) ||
        !CHANNEL.test(body.channel as string) ||
        principal(body.owner) !== body.owner
      )
        throw new HttpError(400, "Invalid file request.");
      const boundOwner = await storage.get<string>(ACCOUNT_OWNER_KEY);
      if (boundOwner && boundOwner !== body.owner)
        throw new HttpError(404, "File not found.");
      if (
        existing &&
        (existing.owner !== body.owner ||
          existing.room !== body.room ||
          existing.channel !== body.channel)
      )
        throw new HttpError(404, "File not found.");
      if (existing?.stagedUntil === null)
        throw new HttpError(409, "This file is already in a message.");
      ledger.discards[id as string] = now + STAGED_MS;
      if (!boundOwner)
        await storage.put(ACCOUNT_OWNER_KEY, body.owner as string);
      if (existing) {
        existing.revoked = true;
        existing.stagedUntil = now;
        existing.leaseUntil = 0;
      }
    } else if (path === "claim") {
      const input = parseBody(body.record) as GroupAttachmentRecord;
      if (
        !existing ||
        !exact(existing, input) ||
        existing.deleting ||
        existing.revoked ||
        (existing.stagedUntil !== null && existing.stagedUntil <= now)
      )
        throw new HttpError(404, "File not found.");
      existing.leaseUntil = now + 60_000;
    } else if (path === "commit" || path === "release") {
      const ids = path === "release" ? [id] : body.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > RETIRED_GROUP_FILE_LIMITS.filesPerMessage ||
        ids.some(
          (candidate) =>
            typeof candidate !== "string" ||
            !GROUP_ATTACHMENT_ID.test(candidate),
        )
      )
        throw new HttpError(400, "Invalid file request.");
      for (const candidate of ids) {
        const entry = ledger.entries[candidate];
        if (!entry) throw unavailable();
        if (path === "commit" && entry.revoked) continue;
        entry.stagedUntil = path === "commit" ? null : now;
        if (path === "release") entry.revoked = true;
        entry.leaseUntil = 0;
      }
    } else throw new HttpError(404, "Not found.");
    await storage.put(ACCOUNT_KEY, ledger);
    return { ledger, reservationToken };
  });
  if (answer instanceof Response) return answer;
  await scheduleAccount(state, answer.ledger);
  if ("error" in answer && answer.error) throw answer.error;
  return json({
    ok: true,
    ...(answer.reservationToken
      ? { reservationToken: answer.reservationToken }
      : {}),
  });
}
async function budgetRequest(
  state: DurableObjectState,
  env: Env,
  path: string,
  body: Record<string, unknown>,
) {
  const id = body.id,
    bytes = body.bytes,
    number = body.shard;
  if (
    typeof id !== "string" ||
    !GROUP_ATTACHMENT_ID.test(id) ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 1 ||
    (bytes as number) > RETIRED_GROUP_FILE_LIMITS.fileBytes ||
    number !== (await shard(env, id))
  )
    throw new HttpError(400, "Invalid file request.");
  const now = Date.now();
  const answer = await state.storage.transaction(async (storage) => {
    const bound = await storage.get<number>(BUDGET_SHARD_KEY);
    if (bound !== undefined && bound !== number) throw unavailable();
    if (bound === undefined) await storage.put(BUDGET_SHARD_KEY, number);
    const count = (await storage.get<Budget>(BUDGET_KEY)) ?? emptyBudget();
    const entry = await storage.get<BudgetEntry>(rowKey(id));
    if (path === "reserve") {
      if (entry) {
        if (entry.bytes !== bytes) throw unavailable();
        if (entry.status === "reserved") {
          await storage.delete(dueKey(id, entry.due!));
          entry.due = now + RESERVATION_MS;
          await storage.put(rowKey(id), entry);
          await storage.put(dueKey(id, entry.due), true);
        }
      } else {
        const ingress = (
          (await storage.get<IngressAttempt[]>(BUDGET_INGRESS)) ?? []
        ).filter((attempt) => attempt.at > now - DAY);
        if (
          count.bytes + (bytes as number) >
            RETIRED_GROUP_FILE_LIMITS.serviceRetainedBytes / SHARDS ||
          count.files + 1 >
            RETIRED_GROUP_FILE_LIMITS.serviceRetainedFiles / SHARDS
        )
          return limited("File storage is temporarily full.");
        if (
          ingress.length >=
            RETIRED_GROUP_FILE_LIMITS.serviceDailyIngressFiles / SHARDS ||
          ingress.reduce((sum, attempt) => sum + attempt.bytes, 0) +
            (bytes as number) >
            RETIRED_GROUP_FILE_LIMITS.serviceDailyIngressBytes / SHARDS
        )
          return limited(
            "Today's file upload budget is full. Try again later.",
          );
        const created: BudgetEntry = {
          bytes: bytes as number,
          status: "reserved",
          due: now + RESERVATION_MS,
        };
        await storage.put(rowKey(id), created);
        await storage.put(dueKey(id, created.due!), true);
        count.bytes += bytes as number;
        count.files++;
        await storage.put(BUDGET_KEY, count);
        ingress.push({ at: now, bytes: bytes as number });
        await storage.put(BUDGET_INGRESS, ingress);
      }
    } else if (path === "commit") {
      if (!entry || entry.bytes !== bytes) throw unavailable();
      if (entry.due !== null) await storage.delete(dueKey(id, entry.due));
      await storage.put(rowKey(id), {
        ...entry,
        status: "committed",
        due: null,
      });
    } else if (path === "release") {
      if (entry) {
        if (entry.bytes !== bytes) throw unavailable();
        if (entry.due !== null) await storage.delete(dueKey(id, entry.due));
        await storage.delete(rowKey(id));
        count.bytes -= entry.bytes;
        count.files--;
        if (count.bytes < 0 || count.files < 0) throw unavailable();
        await storage.put(BUDGET_KEY, count);
      }
    } else throw new HttpError(404, "Not found.");
    return count;
  });
  if (answer instanceof Response) return answer;
  await scheduleBudget(state);
  return json({ ok: true });
}
/** Runs only inside the MediaQuota DO namespace; no network route dispatches here. */
export async function groupAttachmentQuotaRequest(
  state: DurableObjectState,
  env: Env,
  request: Request,
) {
  try {
    if (request.method !== "POST")
      return json({ error: "Method not allowed." }, 405);
    const path = new URL(request.url).pathname;
    const body = parseBody(await request.json());
    const accountPath =
      /^\/group\/account\/(reserve|cancel|finalize|check-discard|admit-discard|discard|claim|commit|release)$/.exec(
        path,
      );
    if (accountPath)
      return await accountRequest(state, env, accountPath[1], body);
    const budgetPath = /^\/group\/budget\/(reserve|commit|release)$/.exec(path);
    if (budgetPath) return await budgetRequest(state, env, budgetPath[1], body);
    return json({ error: "Not found." }, 404);
  } catch (error) {
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "File storage is unavailable.",
      },
      error instanceof HttpError ? error.status : 503,
    );
  }
}
