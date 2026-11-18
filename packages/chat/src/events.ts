import type { ChatMessage, ChatReaction } from "./index";

/** Room event log entries. Ids are a room-monotonic decimal sequence; compare with BigInt. */
export type ChatEventType =
  | "message.created"
  | "message.edited"
  | "message.deleted"
  | "message.reacted"
  | "role.updated"
  | "room.updated"
  /** A team conversation opened, resolved, reopened or changed its
   * stop preference. `channelId` is the conversation id; it reaches only the fixed
   * member and the current team, like every message event inside it. */
  | "conversation.updated";
export type ChatEvent = {
  /** Room-monotonic decimal sequence; compare with BigInt. */
  id: string;
  type: ChatEventType;
  at: string;
  /** Absent for room-wide events (`room.updated`, `role.updated`). */
  channelId?: string;
  /** created/edited: the full current row including reply and reactions. */
  message?: ChatMessage;
  /** deleted/reacted */
  messageId?: string;
  /** reacted: counts only, `mine` is always false in the log. */
  reactions?: ChatReaction[];
  /** role.updated */
  roleId?: string;
  /** conversation.updated: the new revision. A member's signal for a new or
   * edited message carries none. Readers refetch the conversation. */
  conversationRevision?: number;
  /** An event only the current team may receive (an AI mode change, a
   * follow-up, a draft, a case frame, labels, an escalation, alert state).
   * No member socket, member event page or catch-up ever delivers it. A
   * change the member can see leaves it off. */
  audience?: "team";
};
/** `nextAfter` is the cursor for the next request. It is null only when the log
 * holds nothing after `after`; otherwise request again with it, even when this
 * page is empty, because rows for channels the reader cannot open are skipped
 * without appearing here. `resync` means the reader's cursor predates the oldest
 * retained event, so the reader refetches its pages before continuing. */
export type ChatEventPage = {
  events: ChatEvent[];
  nextAfter: string | null;
  oldestRetained: string | null;
  resync: boolean;
};
export const MAX_EVENT_PAGE = 200;
export const EVENT_RETENTION = { count: 2000, ms: 24 * 60 * 60_000 } as const;
/** `POST ROOM/realtime/ticket {}` answers this for anyone who may read the
 * room (anonymous readers of public rooms included; the request carries the
 * same session cookie, access and safety checks as `GET ROOM/channels`).
 * The ticket is 64 hex characters, valid for `REALTIME_TICKET_TTL_MS`, single
 * use, bound to the account (or the anonymous client's network) and to this
 * room. It travels only inside the first socket frame, never in a URL, a
 * header or a log line. `socketUrl` is `wss://<community host>ROOM/realtime`;
 * open it with `Origin` set to the app origin and no cookie is needed.
 * 429 "Too many connection attempts. Try again shortly." after ten tickets
 * per minute for one account or network. */
export type RealtimeTicket = {
  ticket: string;
  expiresAt: string;
  socketUrl: string;
};
/** Frames the client sends. Each is one JSON text frame of at most
 * `REALTIME_LIMITS.maxFrameBytes`; a larger frame closes the socket with
 * 1009, an unreadable one with 1008.
 * - `hello` must be the first frame, within 60 s of opening. `after` is the
 *   last event id the client has seen; the server then streams the missing
 *   events (one page of `MAX_EVENT_PAGE`) after `ready`, or answers
 *   `resync` when the cursor is older than the retained log or more than a
 *   page behind. Omit `after` to start from `ready.cursor`.
 * - `refresh` swaps in a new ticket for the same account (or the same
 *   anonymous network) after a `reauth` frame; another identity closes the
 *   socket with 4403. The client fills any gap with `GET ROOM/events`.
 * - `ack` resets the unacknowledged count; without acks the server sends
 *   `resync {reason:"queue-overflow"}` and closes with 1008 after
 *   `REALTIME_LIMITS.unackedEvents` deliveries.
 * - `ping` gets `pong`. A literal `ping` text frame (not JSON) is answered
 *   `pong` without waking the room. */
export type RealtimeClientFrame =
  | { type: "hello"; ticket: string; after?: string | null }
  | { type: "refresh"; ticket: string }
  | { type: "ack"; id: string }
  | { type: "ping" };
/** Frames the server sends, always JSON text.
 * - `ready` follows a redeemed `hello` or `refresh`: `cursor` is the room's
 *   current event id, `channels` the channel ids this socket receives,
 *   `accessExpiresAt` when role-gated delivery stops without a refresh
 *   (at most 60 s ahead; null for anonymous readers), `publicExpiresAt` when
 *   public-channel delivery stops without a refresh (`REALTIME_PUBLIC_WINDOW_MS`
 *   after the ticket was issued; the ticket route is the room's visibility and
 *   safety check, so every socket re-passes it within that window),
 *   `sessionExpiresAt` when the socket closes with 4401, `permissionRevision`
 *   the room's permission revision the snapshot was taken at.
 * - `event` carries one `ChatEvent` in id order. Message events keep the row
 *   as rendered at commit time.
 * - `reauth` is sent when the access lease passed, the room's roles,
 *   channels, moderation roles, privacy or manager changed, or the session ended.
 *   `channels` lists the public channels still delivered meanwhile (empty in
 *   a private room or when the session ended, which also closes the socket
 *   with 4401). It is sent again with empty `channels` once `publicExpiresAt`
 *   passes; from then on nothing is delivered until a `refresh`. Fetch a new
 *   ticket and send `refresh`.
 * - `resync` means the client refetches its pages and continues from the
 *   latest `ready.cursor` (`cursor-too-old`) or must reconnect
 *   (`queue-overflow`, followed by close 1008).
 * - `error` precedes a close: `ticket` (close 4401; the ticket was missing,
 *   used or expired), `protocol` (close 1008), `limit` (close 1008 for the
 *   per-account cap, 1013 for the room or network cap).
 * Close codes: 1008 policy, 1009 frame too large, 1013 room or network
 * connection cap (try later), 4401 authorization needed, 4403 wrong account. */
export type RealtimeServerFrame =
  | {
      type: "ready";
      cursor: string;
      channels: string[];
      accessExpiresAt: string | null;
      publicExpiresAt: string;
      sessionExpiresAt: string | null;
      permissionRevision: number;
    }
  | { type: "event"; event: ChatEvent }
  | {
      type: "reauth";
      reason: "access-expired" | "permissions-changed" | "session-expired";
      /** Public channels still delivered while the reader refreshes its ticket. */
      channels: string[];
    }
  | { type: "resync"; reason: "cursor-too-old" | "queue-overflow" }
  | { type: "error"; code: "ticket" | "limit" | "protocol"; message: string }
  | { type: "pong" };
export const REALTIME_TICKET_TTL_MS = 60_000;
/** How long a socket keeps receiving public channels after its ticket was
 * issued. Anonymous readers and signed-in readers past their access lease
 * both need a fresh ticket (a fresh visibility and safety check) by then. */
export const REALTIME_PUBLIC_WINDOW_MS = 10 * 60_000;
export const REALTIME_LIMITS = {
  socketsPerRoom: 1000,
  socketsPerPrincipal: 8,
  ticketsPerPrincipal: 10,
  unackedEvents: 500,
  maxFrameBytes: 4096,
} as const;
