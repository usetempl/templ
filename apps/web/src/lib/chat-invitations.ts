import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { communityFetch, roomPath } from "./community-client";
import { chatMutation } from "./chat-api";
const secretPattern = /^[A-Za-z0-9_-]{32,128}$/;
export function takeChatInvitation(
  location: Pick<Location, "hash" | "pathname" | "search">,
  replace: (path: string) => void,
) {
  const values = new URLSearchParams(location.hash.slice(1));
  if (!values.has("invite")) return undefined;
  const secret = values.get("invite") ?? "";
  replace(`${location.pathname}${location.search}`);
  return secretPattern.test(secret) ? secret : "";
}
export async function previewInvitation(room: ChatRoomId, secret: string) {
  if (!secretPattern.test(secret))
    throw new Error("Invitation not found or no longer available.");
  const value = await communityFetch<{ valid: boolean }>(
    roomPath(room, "invites/preview"),
    { secret },
  );
  if (value.valid !== true)
    throw new Error("Invitation not found or no longer available.");
}
export async function acceptInvitation(
  room: ChatRoomId,
  principal: ChatPrincipalId,
  secret: string,
  assertCurrent: () => void,
) {
  const value = await chatMutation<{ ok: boolean; isMember: boolean }>(
    principal,
    roomPath(room, "invites/accept"),
    { secret },
    assertCurrent,
  );
  assertCurrent();
  if (!value.ok || !value.isMember)
    throw new Error("Could not join this chat. Try again.");
}
