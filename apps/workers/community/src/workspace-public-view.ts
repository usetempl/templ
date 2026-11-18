import type { ChatState, ChatViewer, NativeRoom } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { publicNativeRoom } from "./native-rooms";

/** Existing Web and SDK readers require principal-shaped metadata fields.
 * The fixed redaction ID is display metadata, never workspace authority.
 * Stored ownership and authenticated permission checks keep their real IDs. */
export const WITHHELD_WORKSPACE_PRINCIPAL =
  "account:00000000-0000-4000-8000-000000000000";

export function workspaceIdentitiesVisible(viewer: ChatViewer | undefined) {
  return Boolean(
    viewer?.principalId &&
    !viewer.banned &&
    (viewer.isManager || viewer.permissions.includes("handleConversations")),
  );
}

export function workspaceMetadataView(
  room: NativeRoom,
  state: Pick<ChatState, "viewer" | "manager" | "pendingManager">,
  aliases: readonly ChatPrincipalId[],
): NativeRoom {
  const metadata = publicNativeRoom(room);
  if (workspaceIdentitiesVisible(state.viewer))
    return {
      ...metadata,
      manager:
        (state.manager as ChatPrincipalId | undefined) ?? metadata.manager,
      pendingManager:
        (state.pendingManager as ChatPrincipalId | null | undefined) ?? null,
    };
  return {
    ...metadata,
    creator: WITHHELD_WORKSPACE_PRINCIPAL,
    manager: WITHHELD_WORKSPACE_PRINCIPAL,
    pendingManager:
      state.viewer.principalId &&
      state.pendingManager &&
      aliases.includes(state.pendingManager as ChatPrincipalId)
        ? (state.pendingManager as ChatPrincipalId)
        : null,
  };
}

/** Staff roles and bot registrations stay with the team, including in public workspaces. */
export function workspaceStateView(
  state: ChatState,
  aliases: readonly ChatPrincipalId[],
): ChatState {
  if (workspaceIdentitiesVisible(state.viewer)) return state;
  const {
    manager: _manager,
    pendingManager,
    roles: _roles,
    bots: _bots,
    ...rest
  } = state;
  return {
    ...rest,
    roles: [],
    bots: [],
    pendingManager:
      state.viewer.principalId &&
      pendingManager &&
      aliases.includes(pendingManager as ChatPrincipalId)
        ? pendingManager
        : null,
  };
}
