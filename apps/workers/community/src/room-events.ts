import type { ChatEvent, ChatEventPage } from "@templ/chat/events";
import { EVENT_RETENTION, MAX_EVENT_PAGE } from "@templ/chat/events";
import { HttpError } from "./common";

/** Bounded, room-wide event log kept inside the room object. Entries are
 * appended in the same transaction as the mutation they describe and pruned
 * lazily in small pages so no request pays for a full sweep. */
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
export type PendingEvent = Omit<ChatEvent, "id" | "at">;
const PREFIX = "room-event-v1:";
const SEQUENCE_KEY = "room-event-sequence";
const FLOOR_KEY = "room-event-floor";
/** Bumped in the same transaction as any channel, role or room
 * event so realtime sockets holding an older snapshot are asked to re-prove
 * access before the next restricted delivery. Message events never bump it. */
export const PERMISSION_REVISION_KEY = "realtime-permission-revision";
const affectsPermissions = (event: PendingEvent) =>
  !event.type.startsWith("message.");
/** Deletes per append call; keeps every mutation bounded. */
const PRUNE_PAGE = 50;
/** Rows scanned per read call; keeps a reader of few channels bounded. */
const SCAN_LIMIT = MAX_EVENT_PAGE;
const CURSOR = /^(0|[1-9][0-9]{0,15})$/;
export const eventKey = (sequence: number) =>
  `${PREFIX}${String(sequence).padStart(16, "0")}`;
export function eventCursor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CURSOR.test(value))
    throw new HttpError(400, "Invalid event cursor.");
  return Number(value);
}
export function eventLimit(value: unknown): number {
  if (value === undefined || value === null || value === "")
    return MAX_EVENT_PAGE;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value))
    throw new HttpError(400, "Invalid event page size.");
  return Math.min(Number(value), MAX_EVENT_PAGE);
}
export async function appendEvents(
  storage: Storage,
  events: PendingEvent[],
  now: number,
): Promise<ChatEvent[]> {
  if (!events.length) return [];
  let sequence = (await storage.get<number>(SEQUENCE_KEY)) ?? 0;
  const at = new Date(now).toISOString();
  const stored: ChatEvent[] = events.map((event) => ({
    ...event,
    id: String(++sequence),
    at,
  }));
  await storage.put({
    ...Object.fromEntries(
      stored.map((event) => [eventKey(Number(event.id)), event]),
    ),
    [SEQUENCE_KEY]: sequence,
    ...(events.some(affectsPermissions)
      ? {
          [PERMISSION_REVISION_KEY]:
            ((await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0) + 1,
        }
      : {}),
  });
  await pruneEvents(storage, sequence, now);
  return stored;
}
async function pruneEvents(storage: Storage, sequence: number, now: number) {
  const floor = (await storage.get<number>(FLOOR_KEY)) ?? 1;
  const countFloor = Math.max(floor, sequence - EVENT_RETENTION.count + 1);
  const oldest = await storage.get<ChatEvent>(eventKey(floor));
  if (
    oldest &&
    countFloor === floor &&
    Date.parse(oldest.at) > now - EVENT_RETENTION.ms
  )
    return;
  const page = await storage.list<ChatEvent>({
    prefix: PREFIX,
    startAfter: eventKey(floor - 1),
    limit: PRUNE_PAGE,
  });
  let nextFloor = floor;
  for (const [key, event] of page) {
    const id = Number(event.id);
    if (id < countFloor || Date.parse(event.at) <= now - EVENT_RETENTION.ms) {
      await storage.delete(key);
      nextFloor = id + 1;
      continue;
    }
    nextFloor = id;
    break;
  }
  if (page.size === 0) nextFloor = sequence + 1;
  if (nextFloor !== floor) await storage.put(FLOOR_KEY, nextFloor);
}
/** Rows for channels the reader cannot open are skipped without appearing in
 * the page or counting toward `limit`; `nextAfter` still advances past them. */
export async function readEvents(
  storage: Storage,
  options: {
    after: number | null;
    limit: number;
    allowChannel: (channelId: string) => boolean;
    now?: number;
  },
): Promise<ChatEventPage> {
  const limit = Math.max(1, Math.min(options.limit, MAX_EVENT_PAGE));
  const sequence = (await storage.get<number>(SEQUENCE_KEY)) ?? 0;
  const floor = (await storage.get<number>(FLOOR_KEY)) ?? 1;
  const oldestRetained = sequence >= floor ? String(floor) : null;
  const after = options.after;
  const resync =
    after === null ? floor > 1 : after + 1 < floor || after > sequence;
  let cursor = Math.max(after ?? 0, floor - 1);
  if (after !== null && after > sequence) cursor = floor - 1;
  const events: ChatEvent[] = [];
  let scanned = 0;
  let last: number | null = null;
  while (events.length < limit && scanned < SCAN_LIMIT && cursor < sequence) {
    const page = await storage.list<ChatEvent>({
      prefix: PREFIX,
      startAfter: eventKey(cursor),
      limit: Math.min(100, SCAN_LIMIT - scanned),
    });
    if (page.size === 0) break;
    for (const event of page.values()) {
      scanned++;
      last = Number(event.id);
      cursor = last;
      if (!event.channelId || options.allowChannel(event.channelId))
        events.push(event);
      if (events.length >= limit) break;
    }
  }
  return {
    events,
    nextAfter: last === null ? null : String(last),
    oldestRetained,
    resync,
  };
}
