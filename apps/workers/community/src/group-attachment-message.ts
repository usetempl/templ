import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError, type Env } from "./common";
import {
  GROUP_ATTACHMENT_BINDING_PREFIX as PREFIX,
  type StoredGroupAttachmentBinding as Binding,
} from "./group-attachment-cleanup";
import { releaseGroupAttachment } from "./group-attachments";

// No route posts group messages or deletes group messages or channels, so
// nothing queues releases or purges. The alarm drains the stored records.
type Release = { owner: ChatPrincipalId; id: string };
const RELEASE_PREFIX = "group-attachment-release-v1:";
const PURGE_PREFIX = "group-attachment-purge-v1:";
const DISCARD_PREFIX = "group-attachment-discard-v1:";
const DISCARD_DUE = "group-attachment-discard-due-v1:";
const DISCARD_ADMISSION = "group-attachment-discard-admission-v1:";
const DISCARD_ADMISSION_DUE = "group-attachment-discard-admission-due-v1:";
const releaseKey = (id: string) => `${RELEASE_PREFIX}${id}`;
const discardKey = (channel: string, id: string) =>
  `${DISCARD_PREFIX}${channel}:${id}`;
const admissionKey = (owner: string) => `${DISCARD_ADMISSION}${owner}`;

/** Drains one bounded batch and returns when the outbox next needs to run
 * (the earliest discard expiry, a retry, or the next batch), or null. The room
 * alarm schedules it (room-alarm.ts). */
export async function flushGroupAttachmentOutbox(
  state: DurableObjectState,
  env: Env,
): Promise<number | null> {
  const now = Date.now();
  let next: number | null = null;
  const wake = (at: number) => {
    next = next === null ? at : Math.min(next, at);
  };
  const dueDiscards = await state.storage.list({
    prefix: DISCARD_DUE,
    limit: 32,
  });
  for (const due of dueDiscards.keys()) {
    const matched =
      /^group-attachment-discard-due-v1:(\d{16}):([a-z0-9-]+):([0-9a-f]{64})$/.exec(
        due,
      );
    if (!matched) throw new HttpError(503, "File cleanup is unavailable.");
    const until = Number(matched[1]);
    if (until > now) break;
    await state.storage.transaction(async (storage) => {
      const current = await storage.get<{ until: number }>(
        discardKey(matched[2], matched[3]),
      );
      if (current?.until === until)
        await storage.delete(discardKey(matched[2], matched[3]));
      await storage.delete(due);
    });
  }
  const dueAdmissions = await state.storage.list({
    prefix: DISCARD_ADMISSION_DUE,
    limit: 32,
  });
  for (const due of dueAdmissions.keys()) {
    const until = Number(
      due.slice(
        DISCARD_ADMISSION_DUE.length,
        DISCARD_ADMISSION_DUE.length + 16,
      ),
    );
    if (!Number.isSafeInteger(until))
      throw new HttpError(503, "File cleanup is unavailable.");
    if (until > now) break;
    const owner = due.slice(DISCARD_ADMISSION_DUE.length + 17);
    await state.storage.transaction(async (storage) => {
      const current = await storage.get<{ until: number }>(admissionKey(owner));
      if (current?.until === until) await storage.delete(admissionKey(owner));
      await storage.delete(due);
    });
  }
  const purges = await state.storage.list<{ after: string | null }>({
    prefix: PURGE_PREFIX,
    limit: 2,
  });
  for (const [purgeKey, cursor] of purges) {
    const channel = purgeKey.slice(PURGE_PREFIX.length);
    const rows = await state.storage.list<Binding>({
      prefix: `${PREFIX}${channel}:`,
      ...(cursor.after ? { startAfter: cursor.after } : {}),
      limit: 32,
    });
    await state.storage.transaction(async (storage) => {
      for (const [rowKey, binding] of rows) {
        if (binding.deleted) continue;
        await storage.put(rowKey, { ...binding, deleted: true });
        await storage.put(releaseKey(binding.attachment.id), {
          id: binding.attachment.id,
          owner: binding.owner,
        } satisfies Release);
      }
      const last = [...rows.keys()].at(-1);
      if (rows.size < 32 || !last) await storage.delete(purgeKey);
      else await storage.put(purgeKey, { after: last });
    });
  }
  const releases = await state.storage.list<Release>({
    prefix: RELEASE_PREFIX,
    limit: 16,
  });
  let failed = false;
  for (const [releaseKeyValue, release] of releases) {
    try {
      await releaseGroupAttachment(env, release.owner, release.id);
      await state.storage.delete(releaseKeyValue);
    } catch {
      failed = true;
    }
  }
  const morePurge =
    (await state.storage.list({ prefix: PURGE_PREFIX, limit: 1 })).size > 0;
  const moreRelease =
    (await state.storage.list({ prefix: RELEASE_PREFIX, limit: 1 })).size > 0;
  const nextDiscard = await state.storage.list({
    prefix: DISCARD_DUE,
    limit: 1,
  });
  const firstDiscard = nextDiscard.keys().next().value as string | undefined;
  if (firstDiscard) {
    const due = Number(
      firstDiscard.slice(DISCARD_DUE.length, DISCARD_DUE.length + 16),
    );
    if (!Number.isSafeInteger(due))
      throw new HttpError(503, "File cleanup is unavailable.");
    wake(due);
  }
  const nextAdmission = await state.storage.list({
    prefix: DISCARD_ADMISSION_DUE,
    limit: 1,
  });
  const firstAdmission = nextAdmission.keys().next().value as
    | string
    | undefined;
  if (firstAdmission) {
    const due = Number(
      firstAdmission.slice(
        DISCARD_ADMISSION_DUE.length,
        DISCARD_ADMISSION_DUE.length + 16,
      ),
    );
    if (!Number.isSafeInteger(due))
      throw new HttpError(503, "File cleanup is unavailable.");
    wake(due);
  }
  if (failed || morePurge || moreRelease)
    wake(Date.now() + (failed ? 60_000 : 1_000));
  return next;
}
