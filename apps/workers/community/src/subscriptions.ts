import type { ChatNativeSubscription, NativeRoom } from "@templ/chat/index";
import { HttpError, json, readJson } from "./common";
import { nativeRoomId, NATIVE_UUID } from "./native-rooms";
import { principal } from "./principal";
type Subscription = ChatNativeSubscription;
const cursorValid = (value: string) =>
  value.startsWith("room:") && NATIVE_UUID.test(value.slice(5));
const OPT_OUT = "subscription-opt-out:room:";
const subscriptionId = (entry: Subscription) => `room:${entry.room.id}`;
/** One bounded subscription registry per signed-in principal; independent of factory changes. */
export class SubscriptionList {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if (
        url.pathname === "/private/subscription-keys" &&
        request.method === "GET" &&
        url.searchParams.has("roomIds")
      ) {
        const ids = url.searchParams.get("roomIds")!.split(",");
        if (!ids.length || ids.length > 50)
          throw new HttpError(400, "Invalid workspace list.");
        const unique = [...new Set(ids.map(nativeRoomId))];
        const hidden = await Promise.all(
          unique.map(async (id) =>
            (await this.state.storage.get(OPT_OUT + id)) ? id : null,
          ),
        );
        return json({ roomIds: hidden.filter((id) => id !== null) });
      }
      if (
        url.pathname === "/private/subscription-keys" &&
        request.method === "GET"
      )
        return json({
          optedOut:
            url.searchParams.has("roomId") &&
            Boolean(
              await this.state.storage.get(
                OPT_OUT + nativeRoomId(url.searchParams.get("roomId")),
              ),
            ),
          keys: [
            ...(
              await this.state.storage.list({
                prefix: "subscription:",
                limit: 201,
              })
            ).keys(),
          ].map((key) => key.slice("subscription:".length)),
        });
      if (
        url.pathname === "/private/follow-opt-in" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        await this.state.storage.delete(OPT_OUT + nativeRoomId(body.roomId));
        return json({ ok: true });
      }
      const nativeStatus = /^\/subscriptions\/rooms\/([0-9a-f-]+)$/.exec(
        url.pathname,
      );
      if (nativeStatus && request.method === "GET") {
        const id = nativeRoomId(nativeStatus[1]);
        return json({
          subscribed: Boolean(
            await this.state.storage.get(`subscription:room:${id}`),
          ),
          optedOut: Boolean(await this.state.storage.get(OPT_OUT + id)),
        });
      }
      if (request.method === "GET") {
        const cursor = url.searchParams.get("cursor");
        const limitString = url.searchParams.get("limit") ?? "50";
        if (
          !/^[1-9][0-9]?$/.test(limitString) ||
          Number(limitString) > 50 ||
          (cursor && !cursorValid(cursor))
        )
          throw new HttpError(400, "Invalid subscription pagination.");
        const limit = Number(limitString);
        if (url.pathname === "/subscriptions/hidden") {
          const entries = await this.state.storage.list({
            prefix: OPT_OUT,
            limit: limit + 1,
            ...(cursor ? { startAfter: OPT_OUT + cursor.slice(5) } : {}),
          });
          const roomIds = [...entries.keys()]
            .slice(0, limit)
            .map((key) => nativeRoomId(key.slice(OPT_OUT.length)));
          return json({
            roomIds,
            nextCursor: entries.size > limit ? `room:${roomIds.at(-1)!}` : null,
          });
        }
        const entries = await this.state.storage.list<Subscription>({
          prefix: "subscription:",
          limit: limit + 1,
          ...(cursor ? { startAfter: `subscription:${cursor}` } : {}),
        });
        const subscriptions = [...entries.values()].slice(0, limit);
        return json({
          subscriptions,
          nextCursor:
            entries.size > limit ? subscriptionId(subscriptions.at(-1)!) : null,
        });
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const nativeId = nativeRoomId(body.roomId);
        if (typeof body.subscribed !== "boolean")
          throw new HttpError(400, "Choose whether to follow this chat.");
        // Whether the list changed, so the caller can keep a room's favorite
        // count without double-counting a repeated request.
        let changed = false;
        await this.state.storage.transaction(async (storage) => {
          const key = `subscription:room:${nativeId}`;
          const optOutKey = OPT_OUT + nativeId;
          if (!body.subscribed) {
            changed = await storage.delete(key);
            // Only a followed workspace can add a stored opt-out.
            if (changed) await storage.put(optOutKey, true);
            return;
          }
          if (body.automatic === true && (await storage.get(optOutKey))) return;
          if (body.automatic !== true) await storage.delete(optOutKey);
          if (await storage.get(key)) return;
          changed = true;
          const linked: unknown = JSON.parse(
            request.headers.get("X-Linked-Subscription-Keys") ?? "[]",
          );
          if (
            !Array.isArray(linked) ||
            linked.length > 200 ||
            linked.some(
              (value) => typeof value !== "string" || !cursorValid(value),
            )
          )
            throw new HttpError(400, "Invalid linked chat list.");
          const currentKeys = [
            ...(
              await storage.list({ prefix: "subscription:", limit: 201 })
            ).keys(),
          ].map((id) => id.slice("subscription:".length));
          if (new Set([...currentKeys, ...linked]).size >= 200)
            throw new HttpError(409, "You can follow up to 200 chats.");
          const room = body.room as NativeRoom;
          if (
            room?.id !== nativeId ||
            typeof room.name !== "string" ||
            !room.name ||
            room.name.length > 80
          )
            throw new HttpError(400, "Chat metadata does not match.");
          principal(room.creator);
          principal(room.manager);
          await storage.put(key, {
            kind: "native",
            room,
            subscribedAt: new Date().toISOString(),
          } satisfies ChatNativeSubscription);
        });
        // The body stays `{ ok: true }` for every client; the change signal
        // rides a header the public worker reads and drops.
        const response = json({ ok: true });
        response.headers.set("X-Subscription-Changed", changed ? "1" : "0");
        return response;
      }
      return json({ error: "Method not allowed." }, 405);
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Chat list is temporarily unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
      );
    }
  }
}
