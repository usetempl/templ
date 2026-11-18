import type { ChatRoomId } from "@templ/chat/index";
import type { RealtimeServerFrame, RealtimeTicket } from "@templ/chat/events";
import {
  communityFetch,
  roomPath,
  COMMUNITY_API,
  CommunityApiError,
} from "./community-client";

/** Payment state uses the room's ticket-authenticated event stream. */
export function watchProductPayments(room: ChatRoomId, changed: () => void) {
  const controller = new AbortController();
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | null = null;
  let backoff = 1_000;
  let connecting = false;
  const reconnect = () => {
    if (controller.signal.aborted || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  async function connect() {
    if (
      connecting ||
      controller.signal.aborted ||
      typeof WebSocket === "undefined"
    )
      return;
    connecting = true;
    try {
      const ticket = await communityFetch<RealtimeTicket>(
        roomPath(room, "realtime/ticket"),
        {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const url = new URL(ticket.socketUrl);
      const expected = new URL(COMMUNITY_API);
      if (
        url.protocol !== "wss:" ||
        url.host !== expected.host ||
        url.pathname !== roomPath(room, "realtime") ||
        url.search ||
        url.hash
      )
        throw new Error("The event stream could not be verified.");
      const opened = new WebSocket(ticket.socketUrl);
      socket = opened;
      opened.onopen = () =>
        opened.send(
          JSON.stringify({
            type: "hello",
            ticket: ticket.ticket,
            after: cursor,
          }),
        );
      opened.onmessage = (message) => {
        if (
          controller.signal.aborted ||
          socket !== opened ||
          typeof message.data !== "string"
        )
          return;
        let frame: RealtimeServerFrame;
        try {
          frame = JSON.parse(message.data);
        } catch {
          opened.close(1002);
          return;
        }
        if (frame.type === "ready") {
          backoff = 1_000;
          cursor = frame.cursor;
          changed();
        } else if (frame.type === "event") {
          cursor = frame.event.id;
          opened.send(JSON.stringify({ type: "ack", id: cursor }));
          if (frame.event.type === "room.updated") changed();
        } else if (frame.type === "resync") {
          cursor = null;
          changed();
          opened.close(1000);
        } else if (frame.type === "reauth") opened.close(1000);
      };
      opened.onclose = (event) => {
        if ([4401, 4403].includes(event.code)) controller.abort();
        else reconnect();
      };
      opened.onerror = () => opened.close();
    } catch (reason) {
      if (
        reason instanceof CommunityApiError &&
        [401, 403, 410].includes(reason.status)
      )
        controller.abort();
      else reconnect();
    } finally {
      connecting = false;
    }
  }
  void connect();
  return () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    socket?.close(1000);
  };
}
