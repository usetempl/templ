import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  PriorityFeed,
  PrioritySettings,
} from "@templ/chat/support-priority";
import type { ProfileContract } from "@templ/chat/protocol-profile";
import { chatMutation } from "./chat-api";
import { communityFetch, roomPath } from "./community-client";

export const readPriorities = (room: ChatRoomId, signal?: AbortSignal) =>
  communityFetch<PriorityFeed>(
    roomPath(room, "conversations/priorities"),
    undefined,
    signal,
  );

export const readPrioritySettings = (room: ChatRoomId, signal?: AbortSignal) =>
  communityFetch<{ settings: PrioritySettings; contracts: ProfileContract[] }>(
    roomPath(room, "conversations/priority-settings"),
    undefined,
    signal,
  );

export const savePrioritySettings = (
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  settings: PrioritySettings,
) =>
  chatMutation<{ settings: PrioritySettings }>(
    account,
    roomPath(room, "conversations/priority-settings"),
    settings,
  );
