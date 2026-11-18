import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { chatMutation } from "./chat-api";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "./community-client";

export type WorkspaceDeletion = {
  state: "none" | "scheduled" | "deleting";
  requestedAt?: number;
  dueAt?: number;
  canCancel: boolean;
  blocker?: "templ-workspace" | "manager-transfer-pending";
};

/** The manager's view of a deletion. */
export function readWorkspaceDeletion(room: ChatRoomId, signal?: AbortSignal) {
  return communityFetch<WorkspaceDeletion>(
    roomPath(room, "deletion"),
    undefined,
    signal,
  );
}
/** Asks to delete the workspace with a valid wallet session.
 * `strong-auth-required` opens sign-in when wallet proof is missing. */
export function requestWorkspaceDeletion(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  name: string,
) {
  return chatMutation<{ state: "scheduled"; dueAt: number }>(
    account,
    roomPath(room, "deletion"),
    { name, confirmed: true },
  );
}
export function cancelWorkspaceDeletion(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
) {
  return chatMutation<{ state: "none" }>(
    account,
    roomPath(room, "deletion/cancel"),
    { confirmed: true },
  );
}

/** The manager's words for each refusal. */
const REASONS: Record<string, string> = {
  "manager-only": "Only the workspace manager can delete it.",
  "templ-workspace": "Templ's own support workspace can't be deleted.",
  "manager-transfer-pending": "Finish or cancel the manager transfer first.",
  "deletion-scheduled": "This workspace is already set to be deleted.",
  "name-mismatch": "Type the workspace name exactly as it appears.",
  "deletion-started": "Deletion has started and can't be cancelled.",
  "workspace-deleting":
    "This workspace is being deleted. Only the manager can open it.",
  "workspace-closed": "This support chat is closed.",
  "workspace-deleted": "This workspace was deleted.",
};
export function deletionError(reason: unknown): string {
  if (reason instanceof CommunityApiError) {
    const code = (reason.details as { reason?: unknown } | undefined)?.reason;
    if (typeof code === "string" && REASONS[code]) return REASONS[code];
    return reason.message;
  }
  return reason instanceof Error
    ? reason.message
    : "The workspace could not be changed. Try again.";
}
/** True when the service refused a room route because the workspace is
 * being deleted. */
export function workspaceDeleting(reason: unknown) {
  return (
    reason instanceof CommunityApiError &&
    reason.status === 410 &&
    (reason.details as { reason?: unknown } | undefined)?.reason ===
      "workspace-deleting"
  );
}
/** "Tuesday, 6 October 2026". */
export const deletionDate = (value: number) =>
  new Date(value).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
