import type { PendingEvent } from "./room-events";
import { SUPPORT_LIMITS, type SupportCase } from "@templ/chat/support";
import { applyCaseEvent, checkedCase } from "./support-cases";
import { setOpenIndex } from "./support-open-index";
import { wakeRoomAt } from "./room-alarm";
import type { SupportRecord } from "./support-workflow";
import type { TeamConversationRecord } from "./team-conversations";

const PREFIX = "support-abandon-due-v1:";
const POINTER = "support-abandon-thread-v1:";
export const ABANDON_BATCH = 50;
const DAY = 86_400_000;
type Storage = DurableObjectTransaction;
const dueKey = (at: number, thread: string) =>
  `${PREFIX}${String(at).padStart(16, "0")}:${thread}`;

/** One durable deadline per thread; replaying a case change writes the same key. */
export async function updateAbandonDue(storage: Storage, c: SupportCase) {
  const pointer = `${POINTER}${c.thread}`;
  const previous = await storage.get<string>(pointer);
  const at =
    c.resolvedAt === null &&
    c.abandonedAt == null &&
    c.lastReplyAt !== null &&
    (c.lastMessageBy === "team" ||
      (c.lastMessageBy === undefined && c.lastReplyAt > c.lastMemberAt)) &&
    !c.excluded.includes("spam")
      ? Math.max(
          c.lastMemberAt + SUPPORT_LIMITS.caseAbandonDays * DAY,
          c.lastReplyAt,
        )
      : null;
  const next = at === null ? null : dueKey(at, c.thread);
  if (previous && previous !== next) await storage.delete(previous);
  if (next) {
    await storage.put(next, { thread: c.thread, seq: c.seq, at });
    await storage.put(pointer, next);
    await wakeRoomAt(storage, at!);
  } else await storage.delete(pointer);
}

export async function clearAbandonDue(storage: Storage, thread: string) {
  const pointer = `${POINTER}${thread}`;
  const key = await storage.get<string>(pointer);
  if (key) await storage.delete(key);
  await storage.delete(pointer);
}

/** Bounded, re-entrant alarm work. Each record transition and deadline removal is atomic. */
export async function abandonDueCases(
  storage: Storage,
  now: number,
  events: PendingEvent[] = [],
) {
  const rows = await storage.list<{ thread: string; seq: number; at: number }>({
    prefix: PREFIX,
    limit: ABANDON_BATCH,
  });
  for (const [key, due] of rows) {
    if (due.at > now) return due.at;
    const record = await storage.get<TeamConversationRecord>(
      `conversation-v1:${due.thread}`,
    );
    const data = await storage.get<SupportRecord>(
      `support-workflow-v1:${due.thread}`,
    );
    const c = checkedCase(
      await storage.get(
        `support-case-v1:${due.thread}:${String(due.seq).padStart(8, "0")}`,
      ),
      due.thread,
      due.seq,
    );
    if (
      record &&
      !record.deleting &&
      data &&
      c &&
      data.caseSeq === c.seq &&
      record.state === "open" &&
      ["open", "waiting"].includes(data.state) &&
      c.resolvedAt === null &&
      c.abandonedAt == null &&
      c.lastReplyAt !== null &&
      (c.lastMessageBy === "team" ||
        (c.lastMessageBy === undefined && c.lastReplyAt > c.lastMemberAt)) &&
      now >= c.lastMemberAt + SUPPORT_LIMITS.caseAbandonDays * DAY
    ) {
      const previous = data.state;
      data.state = "abandoned";
      record.state = "resolved";
      record.resolvedBy = null;
      record.handoff = null;
      record.revision++;
      await storage.put(`conversation-v1:${record.id}`, record);
      await setOpenIndex(storage, record);
      const counts = await storage.get<{
        schemaVersion: 1;
        records: number;
        open: number;
      }>("conversation-state-v1");
      if (counts)
        await storage.put("conversation-state-v1", {
          ...counts,
          open: Math.max(0, counts.open - 1),
        });
      await applyCaseEvent(storage, record, data, {
        kind: "status",
        previous,
        state: "abandoned",
        by: "person",
        at: now,
        stopped: record.stopped,
      });
      events.push({
        type: "conversation.updated",
        channelId: record.id,
        conversationRevision: record.revision,
      });
    }
    await storage.delete(key);
    if ((await storage.get(`${POINTER}${due.thread}`)) === key)
      await storage.delete(`${POINTER}${due.thread}`);
  }
  const next = await storage.list<{ at: number }>({ prefix: PREFIX, limit: 1 });
  const value = next.values().next().value;
  return value ? Math.max(now + 1, value.at) : null;
}
