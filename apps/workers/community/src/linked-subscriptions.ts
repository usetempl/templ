import type { ChatNativeSubscription } from "@templ/chat/index";
import { HttpError, json, STORAGE_SCOPE_CHAIN_ID, type Env } from "./common";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
type Subscription = ChatNativeSubscription;
const id = (entry: Subscription) => `room:${entry.room.id}`;

/** Two bounded original lists retain their entries. Pagination uses the same
 * ordered room key on both, so a merged page never skips the shorter list. */
export function linkedSubscriptions(env: Env, session: ServiceSession) {
  const actors = sessionPrincipals(session).map((principal) =>
    env.ROOM_SUBSCRIPTIONS!.get(
      env.ROOM_SUBSCRIPTIONS!.idFromName(
        `${STORAGE_SCOPE_CHAIN_ID}:${principal}`,
      ),
    ),
  );
  return {
    async fetch(request: Request): Promise<Response> {
      if (actors.length === 1) return actors[0].fetch(request);
      const url = new URL(request.url);
      if (request.method === "POST") {
        const body = await request.clone().json<{
          subscribed?: boolean;
          roomId?: string;
          automatic?: boolean;
        }>();
        if (body.subscribed === false) {
          const results = await Promise.all(
            actors.map((actor) => actor.fetch(request.clone())),
          );
          return results.find((response) => !response.ok) ?? results[0];
        }
        const snapshots = await Promise.all(
          actors.map(async (actor) => {
            const result = await actor.fetch(
              new Request(
                `https://internal/private/subscription-keys?roomId=${encodeURIComponent(body.roomId ?? "")}`,
              ),
            );
            if (!result.ok)
              throw new HttpError(
                503,
                "Your chat list is temporarily unavailable.",
              );
            return result.json<{ keys: string[]; optedOut?: boolean }>();
          }),
        );
        if (!body.roomId) throw new HttpError(400, "Choose a community room.");
        const key = `room:${body.roomId}`;
        if (
          body.automatic === true &&
          snapshots.some((snapshot) => snapshot.optedOut === true)
        )
          return json({ ok: true });
        const optIn = async () => {
          if (body.automatic === true) return;
          const results = await Promise.all(
            actors.map((actor) =>
              actor.fetch(
                new Request("https://internal/private/follow-opt-in", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ roomId: body.roomId }),
                }),
              ),
            ),
          );
          if (results.some((result) => !result.ok))
            throw new HttpError(
              503,
              "Your chat list is temporarily unavailable.",
            );
        };
        if (snapshots.some((snapshot) => snapshot.keys.includes(key))) {
          await optIn();
          return json({ ok: true });
        }
        const headers = new Headers(request.headers);
        headers.set(
          "X-Linked-Subscription-Keys",
          JSON.stringify(snapshots[1].keys),
        );
        const result = await actors[0].fetch(new Request(request, { headers }));
        if (result.ok) await optIn();
        return result;
      }
      const responses = await Promise.all(
        actors.map((actor) => actor.fetch(request.clone())),
      );
      const failure = responses.find((response) => !response.ok);
      if (failure) return failure;
      if (url.pathname === "/subscriptions/hidden") {
        const pages = await Promise.all(
          responses.map((response) =>
            response.json<{ roomIds: string[]; nextCursor: string | null }>(),
          ),
        );
        const ids = [...new Set(pages.flatMap((page) => page.roomIds))].sort();
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const roomIds = ids.slice(0, limit);
        return json({
          roomIds,
          nextCursor:
            ids.length > limit || pages.some((page) => page.nextCursor)
              ? roomIds.length
                ? `room:${roomIds.at(-1)!}`
                : null
              : null,
        });
      }
      if (url.pathname !== "/subscriptions") {
        const statuses = await Promise.all(
          responses.map((response) =>
            response.json<{ subscribed: boolean; optedOut?: boolean }>(),
          ),
        );
        return json({
          subscribed:
            !statuses.some((value) => value.optedOut) &&
            statuses.some((value) => value.subscribed),
        });
      }
      const pages = await Promise.all(
        responses.map((response) =>
          response.json<{
            subscriptions: Subscription[];
            nextCursor: string | null;
          }>(),
        ),
      );
      const unique = new Map<string, Subscription>();
      for (const page of pages)
        for (const entry of page.subscriptions)
          if (!unique.has(id(entry))) unique.set(id(entry), entry);
      const all = [...unique].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const page = all.slice(0, limit);
      const hidden = new Set<string>();
      if (page.length) {
        const hiddenPages = await Promise.all(
          actors.map(async (actor) => {
            const response = await actor.fetch(
              new Request(
                `https://internal/private/subscription-keys?roomIds=${encodeURIComponent(page.map(([, entry]) => entry.room.id).join(","))}`,
              ),
            );
            if (!response.ok)
              throw new HttpError(503, "Your workspace list could not load.");
            return response.json<{ roomIds: string[] }>();
          }),
        );
        for (const result of hiddenPages)
          for (const roomId of result.roomIds) hidden.add(roomId);
      }
      return json({
        subscriptions: page
          .filter(([, entry]) => !hidden.has(entry.room.id))
          .map(([, entry]) => entry),
        nextCursor:
          all.length > limit || pages.some((page) => page.nextCursor)
            ? (page.at(-1)?.[0] ?? null)
            : null,
      });
    },
  };
}
