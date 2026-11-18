/** Manual-role permissions shared by the service and every client. */
export const MODERATOR_PERMISSIONS = [
  "mute",
  "ban",
  "deleteMessages",
  "manageRoles",
  "assignRoles",
  "handleConversations",
  "messageMembers",
  "manageSupport",
  "manageBilling",
  /** The Specialist role: reads a request only while it owns an open
   * follow-up on it, took one routed to its group, or a person on the team
   * mentioned it there. The role alone reads nothing. */
  "handleFollowUps",
  "manageWorkspace",
] as const;
export type ModeratorPermission = (typeof MODERATOR_PERMISSIONS)[number];

export const CONVERSATION_PERMISSIONS = [
  "handleConversations",
  "messageMembers",
] as const;
export type ConversationPermission = (typeof CONVERSATION_PERMISSIONS)[number];

/** The powers a grant carries, in canonical order. Any other name in a
 * stored grant grants nothing.
 * `handleFollowUps` stands alone: it needs no other permission and gives
 * none. */
export function effectivePermissions(
  granted: readonly ModeratorPermission[],
): ModeratorPermission[] {
  const set = new Set(granted);
  if (!set.has("handleConversations")) {
    set.delete("messageMembers");
    set.delete("manageSupport");
    set.delete("manageWorkspace");
  }
  return MODERATOR_PERMISSIONS.filter((permission) => set.has(permission));
}

/** Messaging and workspace administration require conversation access. */
export function consistentPermissionGrant(
  granted: readonly ModeratorPermission[],
): boolean {
  return (
    (!granted.includes("messageMembers") &&
      !granted.includes("manageSupport") &&
      !granted.includes("manageWorkspace")) ||
    granted.includes("handleConversations")
  );
}

/** Workspace admins are people with current case access and an explicit grant. */
export function canManageWorkspace(
  viewer: { isManager?: boolean; permissions?: readonly string[]; banned?: boolean },
  bot = false,
): boolean {
  return !bot && viewer.banned !== true && (viewer.isManager === true ||
    (viewer.permissions?.includes("handleConversations") === true &&
      viewer.permissions.includes("manageWorkspace")));
}
