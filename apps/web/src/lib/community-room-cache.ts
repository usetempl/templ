import type { Address } from "viem";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRoomId, NativeRoom } from "@templ/chat/index";
import { nativeRoomPattern } from "./chat-room-id";

export type CommunityIdentityRead = {
  address: ChatRoomId;
  tokenAddress: Address;
  creator: ChatPrincipalId;
  name: string;
  symbol: string;
  image?: string;
  nativeRoom: NativeRoom;
};

const nativeId = (room: ChatRoomId) =>
  room.startsWith("room:") && nativeRoomPattern.test(room.slice(5))
    ? room.slice(5)
    : null;

export function communityCacheScope(room: ChatRoomId) {
  return nativeId(room) ? `native:${room}` : undefined;
}
