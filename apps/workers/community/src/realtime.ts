import { observeCostWorkload } from "./cost-observability";
import { readStaffAuthority, type TemplStaffEnv } from "./templ-staff";
/** Realtime delivery over hibernating Durable Object WebSockets.
 *
 * The Worker issues a 60-second single-use ticket through the ordinary room
 * access path (`POST ROOM/realtime/ticket`, rewritten to a GET so anonymous
 * readers of public rooms and the `X-Access-*` lease headers behave exactly
 * as for `/channels`). The room object stores the reader's permission
 * snapshot under the ticket's SHA-256. The socket (`GET ROOM/realtime` with
 * `Upgrade: websocket`) carries no cookie or ticket in its URL; the first
 * frame `{type:"hello", ticket, after}` redeems the ticket and the snapshot
 * moves into the socket attachment, so nothing about a socket lives in
 * memory and hibernation loses nothing.
 *
 * Fan-out runs after each committed transaction (`ChannelRoom.afterCommit`).
 * A socket stops receiving role-gated channels when its snapshot's access
 * lease (at most 60 s) passes or the room's permission revision moves; it
 * gets one `reauth` frame and continues to receive public channels until a
 * `refresh` with a new ticket replaces the snapshot. Public delivery itself
 * lasts `REALTIME_PUBLIC_WINDOW_MS` from the ticket: the ticket route is the
 * only place the room's visibility and safety holds are checked, so an
 * anonymous socket, or a signed-in one past its lease, must re-pass it
 * within that window or receive nothing more until it does. No chain read
 * ever happens here: a fresh ticket is the only way to extend access. */
import type {
  ChatEvent,
  RealtimeClientFrame,
  RealtimeServerFrame,
} from "@templ/chat/events";
import {
  EVENT_RETENTION,
  MAX_EVENT_PAGE,
  REALTIME_LIMITS,
  REALTIME_PUBLIC_WINDOW_MS,
  REALTIME_TICKET_TTL_MS,
} from "@templ/chat/events";
import type {
  ChatMessage,
  ChatViewer,
  ModeratorPermission,
} from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { isAuthMethod, normalizeChatPrincipal } from "@templ/chat/principal";
import { MODERATOR_PERMISSIONS } from "@templ/chat/moderation-permissions";
import { HttpError, json, recordByHash, type Env } from "./common";
import type { AuthData } from "./auth-record";
import type { NativeRoomRecord } from "./native-rooms";
import { NATIVE_UUID } from "./native-rooms";
import { renderMessages, type StoredMessage } from "./message-store";
import {
  eventCursor,
  eventLimit,
  PERMISSION_REVISION_KEY,
  readEvents,
} from "./room-events";
import { roomPrivacy } from "./room-privacy";
import { hideEventHex } from "./support-secret-sinks";
import { widgetConfig } from "./support-widget";

/** Everything the room needs to decide delivery for one socket without
 * reading the session, the chain or the access cache again. */
export type RealtimeSnapshot = {
  principal: ChatPrincipalId | null;
  aliases: ChatPrincipalId[];
  wallet: string | null;
  isManager: boolean;
  permissions: ModeratorPermission[];
  roleIds: string[];
  /** Channels readable when the ticket was issued; at most 100 ids. */
  channelIds: string[];
  /** Team conversations this socket may receive. "team" while
   * the reader held current handling authority at issue; otherwise the
   * reader's own conversation ids. A permission or manager change bumps the
   * revision, so a revoked grant never gets one more private frame. */
  conversations?: "team" | string[];
  /** The reader is the workspace's registered AI agent: a conversation
   * whose AI is off is left out of its events. */
  agent?: true;
  /** Unix ms; at most 60 s after issue. `null` only for anonymous readers. */
  accessExpiresAt: number | null;
  /** Unix ms; public channels stop without a refresh. */
  publicExpiresAt: number;
  sessionExpiresAt: number | null;
  permissionRevision: number;
  banned: boolean;
  mutedUntil: string | null;
  ipDigest?: string;
  /** The website of a widget ticket. Set only by the
   * widget ticket route, from the widget session's scope; the socket must
   * come from the same website, as the worker stamps it at upgrade. */
  widgetOrigin?: string;
  /** A ticket minted in Templ's frame for that website;
   * it opens only a socket the frame opened. */
  widgetFrame?: true;
  /** Widget tickets: the socket receives content-free signals for its own
   * threads only. */
  nudgeOnly?: true;
};
type StoredTicket = {
  snapshot: RealtimeSnapshot;
  expiresAt: number;
  widgetSessionHash?: string;
};
/** Socket attachment (`serializeAttachment`, 16 KB cap). `s` is null while
 * the socket waits for its first `hello`. */
type Attachment = {
  v: 1;
  s: RealtimeSnapshot | null;
  cursor: string | null;
  unacked: number;
  restricted: boolean;
  /** The public window passed and the empty-channels `reauth` was sent. */
  stale?: boolean;
  ipDigest?: string;
  openedAt: number;
  /** The approved website a widget socket was opened from, stamped by the
   * worker; absent on app sockets. */
  widgetOrigin?: string;
  /** The socket was opened from Templ's frame. */
  widgetFrame?: true;
};
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
/** The conversation ids among `ids` an AI agent's socket must not receive
 * (AI off). Read from committed state when the events are delivered. */
export type AgentHiddenConversations = (
  storage: Pick<Storage, "get">,
  ids: string[],
) => Promise<Set<string>>;
type RoomView = {
  publicIds: Set<string>;
  privateRoom: boolean;
  revision: number;
};

const TICKET_PREFIX = "realtime-ticket-v1:";
const TICKET_COUNT_PREFIX = "realtime-ticket-count:";
/** The count row the last prune page ended on. The next page
 * starts after it and wraps at the end of the prefix, so every row is
 * visited within a bounded number of issues however the keys sort. */
export const TICKET_PRUNE_CURSOR_KEY = "realtime-ticket-prune-cursor-v1";
const TICKET_PRUNE_PAGE = 20;
const LIMIT_ERRORS = {
  room: "This community has too many open connections. Try again shortly.",
  network: "Too many connections from this network. Try again shortly.",
  account: "Too many connections for this account.",
} as const;
const SNAPSHOT_CHANNEL_CAP = 100;
/** Anonymous or not-yet-authorized sockets per client IP digest. */
export const ANONYMOUS_SOCKETS_PER_IP = 20;
/** A socket that sends no `hello` within the ticket lifetime is closed. */
const PENDING_TIMEOUT_MS = REALTIME_TICKET_TTL_MS;
const CATCHUP_PAGES = Math.ceil(EVENT_RETENTION.count / MAX_EVENT_PAGE);
const TICKET = /^[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ROOM_PATH = /^(\/rooms\/[0-9a-f-]{36})(\/realtime(?:\/ticket)?)$/;
export const CLOSE = {
  /** Ticket missing, expired, used, or the signed session ended. */
  unauthorized: 4401,
  /** A refresh ticket that belongs to another account. */
  forbidden: 4403,
  policy: 1008,
  tooLarge: 1009,
  tryLater: 1013,
} as const;
const TICKET_ERROR = "This connection ticket is invalid. Ask for a new one.";

const encoder = new TextEncoder();
async function sha256Hex(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const DIGEST_KEY = /^[0-9a-f]{64}$/;
let digestKey: { hex: string; key: Promise<CryptoKey> } | undefined;
const hexBytes = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
/** HMAC-SHA-256 of the client address under the CLIENT_DIGEST_KEY Worker
 * secret, stable across releases. The Worker attaches it on ticket, upgrade
 * and room requests; the raw address never reaches the room object. Without
 * a valid key it is null and callers omit the header, which fails closed:
 * guest opens are refused and anonymous sockets share one bucket. */
export async function clientIpDigest(
  request: Request,
  env: Pick<Env, "CLIENT_DIGEST_KEY">,
): Promise<string | null> {
  const hex = env.CLIENT_DIGEST_KEY;
  if (!hex || !DIGEST_KEY.test(hex)) return null;
  if (digestKey?.hex !== hex)
    digestKey = {
      hex,
      key: crypto.subtle.importKey(
        "raw",
        hexBytes(hex),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  const mac = await crypto.subtle.sign(
    "HMAC",
    await digestKey.key,
    encoder.encode(
      `templ-client-ip-v1\n${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    ),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function digestHeader(headers: Headers) {
  const value = headers.get("X-Client-IP-Digest");
  return value && DIGEST.test(value) ? value : null;
}

function send(ws: WebSocket, frame: RealtimeServerFrame) {
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}
function close(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing.
  }
}
function attachment(ws: WebSocket): Attachment | null {
  try {
    const value = ws.deserializeAttachment() as Attachment | null;
    return value &&
      value.v === 1 &&
      Number.isSafeInteger(value.openedAt) &&
      value.openedAt >= 0 &&
      (value.cursor === null ||
        (typeof value.cursor === "string" && /^\d+$/.test(value.cursor))) &&
      Number.isSafeInteger(value.unacked) &&
      value.unacked >= 0 &&
      value.unacked <= REALTIME_LIMITS.unackedEvents &&
      typeof value.restricted === "boolean" &&
      (value.stale === undefined || typeof value.stale === "boolean") &&
      (value.ipDigest === undefined || DIGEST.test(value.ipDigest)) &&
      (value.widgetOrigin === undefined || widgetOrigin(value.widgetOrigin)) &&
      (value.widgetFrame === undefined ||
        (value.widgetFrame === true && value.widgetOrigin !== undefined)) &&
      (value.s === null || currentSnapshot(value.s))
      ? value
      : null;
  } catch {
    return null;
  }
}
function currentSnapshot(value: unknown): value is RealtimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<RealtimeSnapshot>;
  return (
    (snapshot.principal === null ||
      normalizeChatPrincipal(snapshot.principal) === snapshot.principal) &&
    Array.isArray(snapshot.aliases) &&
    snapshot.aliases.length <= 2 &&
    snapshot.aliases.every(
      (alias) => normalizeChatPrincipal(alias) === alias,
    ) &&
    (snapshot.wallet === null ||
      (typeof snapshot.wallet === "string" &&
        /^0x[0-9a-f]{40}$/.test(snapshot.wallet))) &&
    typeof snapshot.isManager === "boolean" &&
    Array.isArray(snapshot.permissions) &&
    snapshot.permissions.every((permission) =>
      MODERATOR_PERMISSIONS.includes(permission),
    ) &&
    Array.isArray(snapshot.roleIds) &&
    snapshot.roleIds.every((id) => typeof id === "string" && id.length <= 48) &&
    Array.isArray(snapshot.channelIds) &&
    snapshot.channelIds.length <= SNAPSHOT_CHANNEL_CAP &&
    snapshot.channelIds.every(
      (id) => typeof id === "string" && id.length <= 48,
    ) &&
    (snapshot.conversations === undefined ||
      snapshot.conversations === "team" ||
      (Array.isArray(snapshot.conversations) &&
        snapshot.conversations.length <= 4 &&
        snapshot.conversations.every(
          (id) => typeof id === "string" && /^tc-[0-9a-f]{32}$/.test(id),
        ))) &&
    (snapshot.agent === undefined || snapshot.agent === true) &&
    (snapshot.accessExpiresAt === null ||
      (Number.isSafeInteger(snapshot.accessExpiresAt) &&
        Number(snapshot.accessExpiresAt) > 0)) &&
    Number.isSafeInteger(snapshot.publicExpiresAt) &&
    Number(snapshot.publicExpiresAt) > 0 &&
    (snapshot.sessionExpiresAt === null ||
      (Number.isSafeInteger(snapshot.sessionExpiresAt) &&
        Number(snapshot.sessionExpiresAt) > 0)) &&
    Number.isSafeInteger(snapshot.permissionRevision) &&
    Number(snapshot.permissionRevision) >= 0 &&
    typeof snapshot.banned === "boolean" &&
    (snapshot.mutedUntil === null ||
      (typeof snapshot.mutedUntil === "string" &&
        Number.isFinite(Date.parse(snapshot.mutedUntil)))) &&
    (snapshot.ipDigest === undefined ||
      (typeof snapshot.ipDigest === "string" &&
        DIGEST.test(snapshot.ipDigest))) &&
    // A widget snapshot names its website, receives signals only, and never
    // holds the team scope.
    (snapshot.widgetOrigin === undefined
      ? snapshot.nudgeOnly === undefined && snapshot.widgetFrame === undefined
      : widgetOrigin(snapshot.widgetOrigin) &&
        snapshot.nudgeOnly === true &&
        snapshot.conversations !== "team" &&
        (snapshot.widgetFrame === undefined || snapshot.widgetFrame === true))
  );
}
/** A website a widget socket may carry: an HTTPS origin, or a development
 * origin on this computer, up to 200 characters. */
function widgetOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
function attach(ws: WebSocket, value: Attachment) {
  ws.serializeAttachment(value);
}
function autoResponse(state: DurableObjectState) {
  // A literal `ping` text frame answers `pong` without waking the object.
  if (
    typeof WebSocketRequestResponsePair === "function" &&
    typeof state.setWebSocketAutoResponse === "function"
  )
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
}
/** Open sockets with their attachments. Junk and stale pending sockets are
 * closed here, so no timer or alarm is needed for them. */
function liveSockets(state: DurableObjectState, now: number) {
  const live: { ws: WebSocket; a: Attachment }[] = [];
  for (const ws of state.getWebSockets()) {
    const a = attachment(ws);
    if (!a) {
      close(ws, CLOSE.unauthorized, "Send a ticket first.");
      continue;
    }
    if (!a.s && a.openedAt + PENDING_TIMEOUT_MS < now) {
      close(ws, CLOSE.unauthorized, "Send a ticket within 60 seconds.");
      continue;
    }
    live.push({ ws, a });
  }
  return live;
}

/** Room facts read after commit; the same shape decides catch-up in `hello`. */
async function roomView(storage: Storage): Promise<RoomView> {
  const native = await storage.get<NativeRoomRecord>("native-room");
  const privacy = await roomPrivacy(
    storage as DurableObjectTransaction,
    native?.room,
  );
  return {
    // Workspaces have no group channels: no channel is public to a socket.
    publicIds: new Set<string>(),
    privateRoom: privacy.visibility === "private",
    revision: (await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0,
  };
}
/** Whether the snapshot's public window is still open: the reader passed the
 * room's visibility and safety checks at the ticket route within it. */
function publicOpen(s: RealtimeSnapshot, now: number) {
  return now <= s.publicExpiresAt;
}
function restriction(
  s: RealtimeSnapshot,
  room: RoomView,
  now: number,
  open: boolean,
): "permissions-changed" | "access-expired" | null {
  if (s.permissionRevision !== room.revision) return "permissions-changed";
  if (s.accessExpiresAt !== null && now > s.accessExpiresAt)
    return "access-expired";
  if (!open) return "access-expired";
  return null;
}
/** Public channels keep flowing to a restricted socket in a public room
 * while its public window is open. A private room, or a closed window,
 * delivers nothing once access must be re-proven. */
function deliverable(
  channelId: string | undefined,
  s: RealtimeSnapshot,
  restricted: boolean,
  room: RoomView,
  open: boolean,
) {
  if (restricted && (room.privateRoom || !open)) return false;
  if (!channelId) return true;
  // A conversation is never public and never in channelIds; it
  // reaches an unrestricted socket whose snapshot names it (or "team").
  if (channelId.startsWith("tc-"))
    return (
      !restricted &&
      (s.conversations === "team" ||
        (Array.isArray(s.conversations) && s.conversations.includes(channelId)))
    );
  if (room.publicIds.has(channelId)) return true;
  return !restricted && s.channelIds.includes(channelId);
}
function continuingChannels(
  s: RealtimeSnapshot,
  room: RoomView,
  open: boolean,
) {
  return room.privateRoom || !open
    ? []
    : s.channelIds.filter((id) => room.publicIds.has(id));
}
/** The documented `limit` error frame, then the close. */
function closeOverLimit(ws: WebSocket, code: number, message: string) {
  send(ws, { type: "error", code: "limit", message });
  close(ws, code, message);
}

/** Accepts a socket in hibernation mode with an empty attachment. The caller
 * has already built the pair; rejected sockets are closed with 1013 so the
 * client sees a code, not a failed handshake. */
export function acceptRealtimeSocket(
  state: DurableObjectState,
  server: WebSocket,
  input: {
    ipDigest: string | null;
    now: number;
    widgetOrigin?: string;
    widgetFrame?: boolean;
  },
) {
  const live = liveSockets(state, input.now);
  if (live.length >= REALTIME_LIMITS.socketsPerRoom) {
    server.accept();
    closeOverLimit(server, CLOSE.tryLater, LIMIT_ERRORS.room);
    return false;
  }
  if (
    input.ipDigest &&
    live.filter(
      ({ a }) =>
        a.ipDigest === input.ipDigest && (!a.s || a.s.principal === null),
    ).length >= ANONYMOUS_SOCKETS_PER_IP
  ) {
    server.accept();
    closeOverLimit(server, CLOSE.tryLater, LIMIT_ERRORS.network);
    return false;
  }
  autoResponse(state);
  state.acceptWebSocket(server);
  attach(server, {
    v: 1,
    s: null,
    cursor: null,
    unacked: 0,
    restricted: false,
    ...(input.ipDigest ? { ipDigest: input.ipDigest } : {}),
    ...(input.widgetOrigin ? { widgetOrigin: input.widgetOrigin } : {}),
    ...(input.widgetOrigin && input.widgetFrame
      ? { widgetFrame: true as const }
      : {}),
    openedAt: input.now,
  });
  return true;
}
/** Room-object entry for the forwarded upgrade. Only the Worker sets
 * `X-Realtime-Upgrade`; every other header on this request is ignored. */
export function realtimeUpgrade(state: DurableObjectState, request: Request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(426, "Open this address as a WebSocket.");
  const pair = new WebSocketPair();
  // Only the worker's widget upgrade sets the website header, after it
  // checked the Origin against the workspace's approved list.
  const origin = request.headers.get("X-Realtime-Widget-Origin");
  if (origin !== null && !widgetOrigin(origin))
    throw new HttpError(400, "Invalid website.");
  // The worker marks an upgrade from Templ's frame.
  const frame = request.headers.get("X-Realtime-Widget-Frame");
  if (frame !== null && (frame !== "1" || origin === null))
    throw new HttpError(400, "Invalid website.");
  acceptRealtimeSocket(state, pair[1], {
    ipDigest: digestHeader(request.headers),
    now: Date.now(),
    ...(origin ? { widgetOrigin: origin } : {}),
    ...(frame ? { widgetFrame: true } : {}),
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** One bounded page of each prefix per issue: expired tickets and count
 * rows whose newest timestamp left the window, so neither keyspace grows
 * with every account or network that ever asked for a ticket. Ticket keys
 * are hashed, so their first page rotates by itself; the count page walks
 * the prefix behind a stored cursor. */
async function pruneTickets(storage: Storage, now: number) {
  const page = await storage.list<StoredTicket>({
    prefix: TICKET_PREFIX,
    limit: TICKET_PRUNE_PAGE,
  });
  for (const [key, ticket] of page)
    if (ticket.expiresAt <= now) await storage.delete(key);
  const cursor = await storage.get<string>(TICKET_PRUNE_CURSOR_KEY);
  const startAfter =
    typeof cursor === "string" && cursor.startsWith(TICKET_COUNT_PREFIX)
      ? cursor
      : undefined;
  let counts = await storage.list<number[]>({
    prefix: TICKET_COUNT_PREFIX,
    limit: TICKET_PRUNE_PAGE,
    ...(startAfter ? { startAfter } : {}),
  });
  if (counts.size === 0 && startAfter)
    counts = await storage.list<number[]>({
      prefix: TICKET_COUNT_PREFIX,
      limit: TICKET_PRUNE_PAGE,
    });
  let last: string | null = null;
  for (const [key, stamps] of counts) {
    last = key;
    if (
      !Array.isArray(stamps) ||
      !stamps.some((at) => at > now - REALTIME_TICKET_TTL_MS)
    )
      await storage.delete(key);
  }
  // A short page reached the end of the prefix: the next sweep starts over.
  if (last && counts.size === TICKET_PRUNE_PAGE)
    await storage.put(TICKET_PRUNE_CURSOR_KEY, last);
  else if (startAfter) await storage.delete(TICKET_PRUNE_CURSOR_KEY);
}
async function consumeTicket(
  storage: Storage,
  value: unknown,
  now: number,
  env: Env,
): Promise<RealtimeSnapshot | null> {
  if (typeof value !== "string" || !TICKET.test(value)) return null;
  const key = `${TICKET_PREFIX}${await sha256Hex(value)}`;
  const ticket = await storage.get<StoredTicket>(key);
  if (!ticket) return null;
  await storage.delete(key);
  if (!(ticket.expiresAt > now) || !currentSnapshot(ticket.snapshot))
    return null;
  const snapshot = ticket.snapshot;
  if (snapshot.sessionExpiresAt !== null && snapshot.sessionExpiresAt <= now)
    return null;
  if (snapshot.widgetOrigin) {
    if (!ticket.widgetSessionHash || !DIGEST.test(ticket.widgetSessionHash))
      return null;
    try {
      const response = await recordByHash(
        env,
        "session",
        ticket.widgetSessionHash,
      ).fetch(new Request("https://internal/read", { method: "POST" }));
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const session = await response.json<AuthData>();
      const room = await storage.get<NativeRoomRecord>("native-room");
      if (
        session.ended ||
        !isAuthMethod(session.authMethod) ||
        session.purpose !== "widget-session" ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt <= now ||
        !session.principalId ||
        (session.principalId !== snapshot.principal &&
          !snapshot.aliases.includes(session.principalId)) ||
        !room ||
        session.widgetScope?.room !== room.room.id ||
        session.widgetScope.origin !== snapshot.widgetOrigin ||
        Boolean(session.widgetScope.frame) !== Boolean(snapshot.widgetFrame)
      )
        return null;
      if (session.rememberEpoch !== undefined) {
        const config = await widgetConfig(env, room.room.id, {
          op: "read",
          origin: snapshot.widgetOrigin,
        });
        if (!config.ok) {
          await config.body?.cancel();
          return null;
        }
        const settings = await config.json<{
          known?: boolean;
          closed?: boolean;
          rememberEpoch?: number;
        }>();
        const epoch = settings.rememberEpoch ?? 0;
        if (
          settings.known !== true ||
          settings.closed ||
          !Number.isSafeInteger(epoch) ||
          epoch < 0 ||
          !Number.isSafeInteger(session.rememberEpoch) ||
          session.rememberEpoch < epoch
        )
          return null;
      }
    } catch {
      return null;
    }
  }
  if (!(await currentTeamSocket(storage, snapshot, env, now))) return null;
  return snapshot;
}
async function currentTeamSocket(
  storage: Pick<Storage, "get">,
  snapshot: RealtimeSnapshot,
  env: TemplStaffEnv,
  now: number,
): Promise<boolean> {
  if (snapshot.conversations !== "team" || !snapshot.principal)
    return true;
  const ids = snapshot.aliases.length ? snapshot.aliases : [snapshot.principal];
  const authority = await readStaffAuthority(storage, ids, env);
  return (
    !authority.templStaff ||
    (!snapshot.isManager &&
      authority.roleIds(Math.max(now, Date.now())).length > 0)
  );
}

function sameIdentity(current: RealtimeSnapshot, next: RealtimeSnapshot) {
  if (current.principal !== null || next.principal !== null)
    return current.principal === next.principal;
  return Boolean(current.ipDigest) && current.ipDigest === next.ipDigest;
}

/** Issued inside the ordinary request transaction after the viewer is built,
 * so the snapshot equals what `/channels` would have answered. */
export async function realtimeTicketRoute(
  storage: Storage,
  input: {
    viewer: ChatViewer;
    aliases: readonly ChatPrincipalId[];
    channelIds: string[];
    /** See RealtimeSnapshot.conversations. */
    conversations?: "team" | string[];
    /** The reader is the workspace's registered AI agent. */
    agent?: boolean;
    headers: Headers;
    sessionUnavailable: boolean;
    now: number;
    /** A widget member's ticket, bound to its website;
     * the caller passes only that member's own threads. */
    widget?: { origin: string; frame?: boolean };
  },
) {
  if (input.sessionUnavailable)
    throw new HttpError(503, "Sign-in is temporarily unavailable.");
  const { viewer, now } = input;
  const widgetSessionHash = input.widget
    ? input.headers.get("X-Support-Widget-Session")
    : null;
  if (
    input.widget &&
    (!widgetOrigin(input.widget.origin) ||
      input.conversations === "team" ||
      !viewer.principalId ||
      !widgetSessionHash ||
      !DIGEST.test(widgetSessionHash))
  )
    throw new HttpError(404, "Support action not found.");
  const principal = viewer.principalId ?? null;
  const ipDigest = digestHeader(input.headers);
  const key = `${TICKET_COUNT_PREFIX}${principal ?? ipDigest ?? "anonymous"}`;
  const recent = ((await storage.get<number[]>(key)) ?? []).filter(
    (at) => at > now - REALTIME_TICKET_TTL_MS,
  );
  if (recent.length >= REALTIME_LIMITS.ticketsPerPrincipal)
    throw new HttpError(
      429,
      "Too many connection attempts. Try again shortly.",
      Math.max(1, Math.ceil((recent[0] + REALTIME_TICKET_TTL_MS - now) / 1000)),
    );
  await storage.put(key, [...recent, now]);
  await pruneTickets(storage, now);
  const lease = Number(input.headers.get("X-Access-Expires-At"));
  const session = Number(input.headers.get("X-Session-Expires-At"));
  const snapshot: RealtimeSnapshot = {
    principal,
    aliases: [...input.aliases],
    wallet: viewer.wallet,
    isManager: viewer.isManager,
    permissions: [...viewer.permissions],
    roleIds: [...viewer.roleIds],
    channelIds: input.channelIds.slice(0, SNAPSHOT_CHANNEL_CAP),
    ...(input.conversations === undefined || !principal
      ? {}
      : {
          conversations:
            input.conversations === "team"
              ? "team"
              : input.conversations.slice(0, 4),
        }),
    ...(input.agent && principal ? { agent: true as const } : {}),
    accessExpiresAt: principal
      ? Math.min(
          now + REALTIME_TICKET_TTL_MS,
          Number.isSafeInteger(lease) && lease > 0 ? lease : Infinity,
        )
      : null,
    publicExpiresAt: now + REALTIME_PUBLIC_WINDOW_MS,
    sessionExpiresAt:
      principal && Number.isSafeInteger(session) && session > 0
        ? session
        : null,
    permissionRevision:
      (await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0,
    banned: Boolean(viewer.banned),
    mutedUntil: viewer.mutedUntil,
    ...(ipDigest ? { ipDigest } : {}),
    ...(input.widget
      ? {
          widgetOrigin: input.widget.origin,
          ...(input.widget.frame ? { widgetFrame: true as const } : {}),
          nudgeOnly: true as const,
        }
      : {}),
  };
  const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const expiresAt = now + REALTIME_TICKET_TTL_MS;
  await storage.put(`${TICKET_PREFIX}${await sha256Hex(ticket)}`, {
    snapshot,
    expiresAt,
    ...(widgetSessionHash ? { widgetSessionHash } : {}),
  } satisfies StoredTicket);
  return json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
}

/** `GET ROOM/events?after&limit`: the polling fallback and the catch-up
 * source for bots. Message events are re-rendered for this reader so
 * `reactions[].mine` and current reply state are theirs, not the author's. */
export async function eventsRoute(
  storage: Storage,
  input: {
    url: URL;
    aliases: readonly ChatPrincipalId[];
    sessionUnavailable: boolean;
    allowChannel: (channelId: string) => boolean;
    now: number;
    /** The reader holds the team scope; others never get team-only events. */
    team?: boolean;
  },
) {
  if (input.sessionUnavailable)
    throw new HttpError(503, "Sign-in is temporarily unavailable.");
  const page = await readEvents(storage, {
    after: eventCursor(input.url.searchParams.get("after")),
    limit: eventLimit(input.url.searchParams.get("limit")),
    allowChannel: input.allowChannel,
    now: input.now,
  });
  if (!input.team)
    page.events = page.events.filter((event) => event.audience !== "team");
  const byChannel = new Map<string, ChatEvent[]>();
  for (const event of page.events)
    if (
      (event.type === "message.created" || event.type === "message.edited") &&
      event.channelId &&
      event.message
    )
      byChannel.set(event.channelId, [
        ...(byChannel.get(event.channelId) ?? []),
        event,
      ]);
  for (const [channelId, events] of byChannel) {
    const rows: StoredMessage[] = events.map((event) => {
      const {
        reply: _reply,
        reactions: _reactions,
        ...row
      } = event.message as ChatMessage;
      return row;
    });
    const rendered = await renderMessages(storage, channelId, rows, {
      aliases: input.aliases,
    });
    events.forEach((event, index) => {
      event.message = rendered[index];
    });
  }
  page.events = await Promise.all(
    page.events.map((event) => hideEventHex(storage, event)),
  );
  if (!input.team) page.events = page.events.map(memberConversationSignal);
  return json(page);
}

const NONE: ReadonlySet<string> = new Set();
/** For an AI agent's socket, the conversations among the events whose AI is
 * off. Nothing is read for people's sockets. Without a resolver an agent's
 * socket gets no conversation events at all. */
async function agentHidden(
  storage: Pick<Storage, "get">,
  s: RealtimeSnapshot,
  events: ChatEvent[],
  hide: AgentHiddenConversations | undefined,
): Promise<ReadonlySet<string>> {
  if (!s.agent) return NONE;
  const ids = [
    ...new Set(
      events
        .map((event) => event.channelId)
        .filter((id): id is string => Boolean(id?.startsWith("tc-"))),
    ),
  ];
  if (!ids.length) return NONE;
  return hide ? hide(storage, ids) : new Set(ids);
}
async function catchUp(
  storage: Storage,
  ws: WebSocket,
  a: Attachment,
  s: RealtimeSnapshot,
  room: RoomView,
  after: number,
  sequence: number,
  now: number,
  hide?: AgentHiddenConversations,
) {
  const open = publicOpen(s, now);
  const restricted = restriction(s, room, now, open) !== null;
  let cursor = after;
  let delivered = 0;
  for (let pages = 0; pages < CATCHUP_PAGES; pages++) {
    const page = await readEvents(storage, {
      after: cursor,
      limit: MAX_EVENT_PAGE - delivered,
      allowChannel: (channelId) =>
        deliverable(channelId, s, restricted, room, open),
      now,
    });
    if (page.resync) {
      send(ws, { type: "resync", reason: "cursor-too-old" });
      return;
    }
    const hidden = await agentHidden(storage, s, page.events, hide);
    for (const event of page.events) {
      if (event.channelId && hidden.has(event.channelId)) continue;
      if (!visibleTo(s, event)) continue;
      if (
        !send(ws, {
          type: "event",
          event: framed(s, await hideEventHex(storage, event)),
        })
      )
        return;
      delivered++;
      a.unacked++;
      a.cursor = event.id;
    }
    if (page.nextAfter === null) return;
    cursor = Number(page.nextAfter);
    if (cursor >= sequence) return;
    if (delivered >= MAX_EVENT_PAGE) break;
  }
  // More than one page behind: the reader refetches its pages and continues
  // live from the `ready` cursor.
  send(ws, { type: "resync", reason: "cursor-too-old" });
}

async function authorize(
  state: DurableObjectState,
  ws: WebSocket,
  a: Attachment,
  frame: Extract<RealtimeClientFrame, { type: "hello" | "refresh" }>,
  env: Env,
  hide?: AgentHiddenConversations,
) {
  const now = Date.now();
  let after: number | null = null;
  if (frame.type === "hello") {
    try {
      after = eventCursor(frame.after);
    } catch {
      send(ws, {
        type: "error",
        code: "protocol",
        message: "Invalid event cursor.",
      });
      close(ws, CLOSE.policy, "Invalid event cursor.");
      return;
    }
  }
  await state.storage.transaction(async (storage) => {
    const snapshot = await consumeTicket(storage, frame.ticket, now, env);
    if (!snapshot) {
      send(ws, { type: "error", code: "ticket", message: TICKET_ERROR });
      close(ws, CLOSE.unauthorized, "Ticket is not valid.");
      return;
    }
    if (a.s && !sameIdentity(a.s, snapshot)) {
      close(ws, CLOSE.forbidden, "This ticket belongs to another account.");
      return;
    }
    // A widget ticket opens only a socket from its own website, and an app
    // ticket only an app socket.
    if (
      (snapshot.widgetOrigin ?? null) !== (a.widgetOrigin ?? null) ||
      (snapshot.widgetFrame === true) !== (a.widgetFrame === true)
    ) {
      close(ws, CLOSE.forbidden, "This ticket belongs to another site.");
      return;
    }
    if (
      snapshot.ipDigest &&
      a.ipDigest &&
      snapshot.ipDigest !== a.ipDigest &&
      !snapshot.principal
    ) {
      close(ws, CLOSE.forbidden, "This ticket was issued to another network.");
      return;
    }
    if (snapshot.principal) {
      const own = liveSockets(state, now)
        .filter(
          ({ ws: other, a: otherA }) =>
            other !== ws && otherA.s?.principal === snapshot.principal,
        )
        .sort((x, y) => x.a.openedAt - y.a.openedAt);
      while (own.length >= REALTIME_LIMITS.socketsPerPrincipal) {
        const oldest = own.shift()!;
        closeOverLimit(oldest.ws, CLOSE.policy, LIMIT_ERRORS.account);
      }
    }
    const room = await roomView(storage);
    const sequence = (await storage.get<number>("room-event-sequence")) ?? 0;
    a.s = snapshot;
    a.restricted = false;
    a.stale = false;
    a.unacked = 0;
    a.cursor = String(sequence);
    attach(ws, a);
    send(ws, {
      type: "ready",
      cursor: String(sequence),
      channels: snapshot.channelIds,
      accessExpiresAt:
        snapshot.accessExpiresAt === null
          ? null
          : new Date(snapshot.accessExpiresAt).toISOString(),
      publicExpiresAt: new Date(snapshot.publicExpiresAt).toISOString(),
      sessionExpiresAt:
        snapshot.sessionExpiresAt === null
          ? null
          : new Date(snapshot.sessionExpiresAt).toISOString(),
      permissionRevision: snapshot.permissionRevision,
    });
    if (frame.type === "hello" && after !== null) {
      await catchUp(storage, ws, a, snapshot, room, after, sequence, now, hide);
      attach(ws, a);
    }
  });
}

function parseFrame(message: string | ArrayBuffer): RealtimeClientFrame | null {
  if (typeof message !== "string") return null;
  if (
    message.length > REALTIME_LIMITS.maxFrameBytes ||
    encoder.encode(message).length > REALTIME_LIMITS.maxFrameBytes
  )
    throw new HttpError(413, "Frames must be 4,096 bytes or less.");
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "ping":
      return { type: "ping" };
    case "ack":
      return typeof frame.id === "string"
        ? { type: "ack", id: frame.id }
        : null;
    case "hello":
      return typeof frame.ticket === "string" &&
        (frame.after === undefined ||
          frame.after === null ||
          typeof frame.after === "string")
        ? {
            type: "hello",
            ticket: frame.ticket,
            after: frame.after as string | null | undefined,
          }
        : null;
    case "refresh":
      return typeof frame.ticket === "string"
        ? { type: "refresh", ticket: frame.ticket }
        : null;
    default:
      return null;
  }
}
/** `webSocketMessage` handler. Every frame is JSON text of at most 4,096
 * bytes; a larger or unreadable frame closes the socket. */
export async function realtimeMessage(
  state: DurableObjectState,
  ws: WebSocket,
  message: string | ArrayBuffer,
  env: Env,
  hide?: AgentHiddenConversations,
) {
  let frame: RealtimeClientFrame | null;
  try {
    frame = parseFrame(message);
  } catch {
    close(ws, CLOSE.tooLarge, "Frames must be 4,096 bytes or less.");
    return;
  }
  const a = attachment(ws);
  if (!a) {
    close(ws, CLOSE.unauthorized, "Send a ticket first.");
    return;
  }
  if (!a.s && a.openedAt + PENDING_TIMEOUT_MS < Date.now()) {
    close(ws, CLOSE.unauthorized, "Send a ticket within 60 seconds.");
    return;
  }
  if (!frame) {
    send(ws, { type: "error", code: "protocol", message: "Unreadable frame." });
    close(ws, CLOSE.policy, "Unreadable frame.");
    return;
  }
  if (
    a.s &&
    !(await currentTeamSocket(
      state.storage as unknown as Storage,
      a.s,
      env,
      Date.now(),
    ))
  ) {
    close(ws, CLOSE.forbidden, "Team access ended.");
    return;
  }
  switch (frame.type) {
    case "ping":
      send(ws, { type: "pong" });
      return;
    case "ack":
      if (a.s) {
        a.unacked = 0;
        attach(ws, a);
      }
      return;
    case "hello":
    case "refresh":
      await authorize(state, ws, a, frame, env, hide);
      return;
  }
}
/** Nothing is cached per socket outside its attachment, so a close needs no
 * bookkeeping; counts are always derived from the live set. */
export function realtimeClose(
  _state: DurableObjectState,
  _ws: WebSocket,
  _code: number,
  _reason: string,
  _wasClean: boolean,
) {}
export function realtimeError(
  _state: DurableObjectState,
  ws: WebSocket,
  _error: unknown,
) {
  close(ws, CLOSE.policy, "Connection error.");
}

/** Team-only events reach only sockets with the team scope; a widget socket
 * receives events of its own threads only, never room-wide ones. */
function visibleTo(s: RealtimeSnapshot, event: ChatEvent) {
  if (event.audience === "team" && s.conversations !== "team") return false;
  if (s.nudgeOnly)
    return (
      !!event.channelId &&
      Array.isArray(s.conversations) &&
      s.conversations.includes(event.channelId)
    );
  return true;
}
/** What a socket receives: a widget socket gets a signal with no content,
 * and the widget reads the thread through its checked route. */
function memberConversationSignal(event: ChatEvent): ChatEvent {
  return event.channelId?.startsWith("tc-")
    ? {
        id: event.id,
        type: "conversation.updated",
        at: event.at,
        channelId: event.channelId,
      }
    : event;
}
function framed(s: RealtimeSnapshot, event: ChatEvent): ChatEvent {
  return s.nudgeOnly
    ? {
        id: event.id,
        type: event.type,
        at: event.at,
        channelId: event.channelId,
      }
    : s.conversations === "team"
      ? event
      : memberConversationSignal(event);
}
/** Worker binding only (`POST /private/realtime/end`): closes the widget
 * sockets of one member on one website when that sign-in ends (sign-out, a
 * guest moving to a wallet). The widget asks for a new ticket, which the
 * ordinary checks then refuse or grant. */
export function endWidgetSockets(
  state: DurableObjectState,
  input: { principal: ChatPrincipalId; origin: string },
) {
  let closed = 0;
  for (const { ws, a } of liveSockets(state, Date.now()))
    if (
      a.widgetOrigin === input.origin &&
      a.s &&
      (a.s.principal === input.principal ||
        a.s.aliases.includes(input.principal))
    ) {
      close(ws, CLOSE.unauthorized, "Signed out.");
      closed++;
    }
  return closed;
}

const queues = new WeakMap<DurableObjectState, Promise<void>>();
/** `ChannelRoom.afterCommit`: fans committed events out in commit order.
 * Runs after the response; the per-object queue keeps event ids increasing
 * on every socket even when commits land back to back. */
export function realtimeAfterCommit(
  state: DurableObjectState,
  events: ChatEvent[],
  costEnv?: object,
  hide?: AgentHiddenConversations,
) {
  if (typeof state.getWebSockets !== "function") return;
  const next = (queues.get(state) ?? Promise.resolve())
    .then(() => fanOut(state, events, costEnv, hide))
    .catch(() => {
      // If the room view or fan-out failed after commit, no socket can prove
      // it received the full ordered event set. Reconnect for catch-up.
      try {
        for (const ws of state.getWebSockets())
          close(ws, CLOSE.policy, "Updates missed. Reconnect.");
      } catch {
        // The browser's slower page reconciliation remains the backstop.
      }
    });
  queues.set(state, next);
}
async function fanOut(
  state: DurableObjectState,
  events: ChatEvent[],
  costEnv?: object,
  hide?: AgentHiddenConversations,
) {
  const live = liveSockets(state, Date.now()).filter(({ a }) => a.s);
  if (!live.length) return;
  const storage = state.storage as unknown as Storage;
  // AI off: read once per batch, and only when an AI agent's socket is live.
  const agent = live.find(({ a }) => a.s!.agent);
  const hidden = agent
    ? await agentHidden(storage, agent.a.s!, events, hide)
    : NONE;
  const screened = await Promise.all(
    events.map((event) => hideEventHex(storage, event)),
  );
  await state.storage.transaction(async (current) => {
    const committed = current as unknown as Storage;
    const room = await roomView(committed);
    for (const { ws, a } of live) {
      const snapshot = a.s!;
      const authority =
        snapshot.conversations === "team" && snapshot.principal
          ? await readStaffAuthority(
              committed,
              snapshot.aliases.length ? snapshot.aliases : [snapshot.principal],
              (costEnv ?? {}) as TemplStaffEnv,
            )
          : null;
      const now = Date.now();
      if (
        authority?.templStaff &&
        (snapshot.isManager || !authority.roleIds(now).length)
      ) {
        close(ws, CLOSE.forbidden, "Team access ended.");
        continue;
      }
      // No awaited work separates the final authority check from delivery.
      // The transaction prevents a revocation from committing between them.
      deliver(ws, a, screened, room, now, snapshot.agent ? hidden : NONE);
    }
  });
  // Count fanout work, not confirmed receipt. Collection never holds the ordered delivery queue.
  if (costEnv && typeof state.waitUntil === "function")
    state.waitUntil(
      observeCostWorkload(costEnv, {
        socketDeliveries: live.length * events.length,
        socketReaders: live.length,
        ...(state.storage.sql
          ? { databaseBytes: state.storage.sql.databaseSize }
          : {}),
      }),
    );
}
function deliver(
  ws: WebSocket,
  a: Attachment,
  events: ChatEvent[],
  room: RoomView,
  now: number,
  hidden: ReadonlySet<string>,
) {
  const s = a.s!;
  if (s.sessionExpiresAt !== null && now > s.sessionExpiresAt) {
    send(ws, { type: "reauth", reason: "session-expired", channels: [] });
    close(ws, CLOSE.unauthorized, "Sign in again.");
    return;
  }
  const open = publicOpen(s, now);
  const reason = restriction(s, room, now, open);
  let changed = false;
  if (reason && !a.restricted) {
    a.restricted = true;
    a.stale = !open;
    changed = true;
    send(ws, {
      type: "reauth",
      reason,
      channels: continuingChannels(s, room, open),
    });
  } else if (reason && !open && !a.stale) {
    // The public window closed after the first reauth: say so once, then
    // deliver nothing until a refresh.
    a.stale = true;
    changed = true;
    send(ws, { type: "reauth", reason, channels: [] });
  }
  for (const event of events) {
    if (!deliverable(event.channelId, s, reason !== null, room, open)) continue;
    if (event.channelId && hidden.has(event.channelId)) continue;
    if (!visibleTo(s, event)) continue;
    if (!send(ws, { type: "event", event: framed(s, event) })) {
      close(ws, CLOSE.policy, "Updates missed. Reconnect.");
      break;
    }
    a.unacked++;
    a.cursor = event.id;
    changed = true;
    if (a.unacked > REALTIME_LIMITS.unackedEvents) {
      send(ws, { type: "resync", reason: "queue-overflow" });
      close(ws, CLOSE.policy, "Too many unacknowledged events.");
      break;
    }
  }
  if (changed) attach(ws, a);
}

/** Worker entry: `POST ROOM/realtime/ticket` and the `GET ROOM/realtime`
 * upgrade for current native rooms. Returns null for every other request. */
export async function realtimeRoute(
  request: Request,
  env: Env,
  context: {
    nativeRoom: (
      id: string,
    ) => Promise<{ room: DurableObjectStub; record: NativeRoomRecord }>;
    route: (request: Request) => Promise<Response>;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = ROOM_PATH.exec(url.pathname);
  if (!match) return null;
  const [, roomPath, action] = match;
  if (action === "/realtime/ticket") {
    if (request.method !== "POST") return null;
    // Access, session and safety checks are the ones an ordinary read gets.
    const response = await context.route(
      new Request(url, { method: "GET", headers: request.headers }),
    );
    if (!response.ok) return response;
    const issued = await response.json<{ ticket: string; expiresAt: string }>();
    return json({
      ...issued,
      socketUrl: `wss://${url.host}${roomPath}/realtime`,
    });
  }
  if (request.method !== "GET") return null;
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(426, "Open this address as a WebSocket.");
  if (request.headers.get("Origin") !== env.APP_ORIGIN)
    throw new HttpError(403, "Origin is not allowed.");
  if (
    !env.CHAT_READ_RATE_LIMITER ||
    !(
      await env.CHAT_READ_RATE_LIMITER.limit({
        key: `realtime:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
      })
    ).success
  )
    throw new HttpError(
      429,
      "Too many connection attempts. Try again shortly.",
    );
  const native = /^\/rooms\/([0-9a-f-]{36})$/.exec(roomPath)!;
  if (!NATIVE_UUID.test(native[1])) throw new HttpError(404, "Chat not found.");
  const room = (await context.nativeRoom(native[1])).room;
  // No cookie, ticket or caller header crosses into the room object.
  const digest = await clientIpDigest(request, env);
  return room.fetch(
    new Request("https://internal/realtime", {
      headers: {
        Upgrade: "websocket",
        "X-Realtime-Upgrade": "1",
        ...(digest ? { "X-Client-IP-Digest": digest } : {}),
      },
    }),
  );
}
