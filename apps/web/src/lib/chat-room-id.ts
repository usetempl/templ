import type { ChatRoomId } from "@templ/chat/index";

export const nativeRoomPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function nativeRoomKey(id: string): `room:${string}` {
  if (!nativeRoomPattern.test(id)) throw new Error("Invalid chat link.");
  return `room:${id.toLowerCase()}`;
}
export function normalizeChatRoomId(id: string): ChatRoomId {
  if (!id.startsWith("room:")) throw new Error("Invalid chat link.");
  return nativeRoomKey(id.slice(5));
}
export function chatHref(id: ChatRoomId) {
  const normalized = normalizeChatRoomId(id);
  const room = normalized.slice(5);
  return `/inbox/${room}`;
}
