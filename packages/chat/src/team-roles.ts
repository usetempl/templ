import type { ModeratorPermission } from "./moderation-permissions";

/** Known staff roles share one definition across service, UI and invitations. */
export const SUPPORT_TEAM_ROLES = {
  "support-member": { name: "Team", permissions: ["handleConversations"] },
  "support-lead": { name: "Support lead", permissions: ["handleConversations", "manageSupport"] },
  "support-admin": { name: "Admin", permissions: ["handleConversations", "manageSupport", "manageWorkspace"] },
  "ai-agent": { name: "AI support", permissions: ["handleConversations"] },
} as const satisfies Record<string, { name: string; permissions: readonly ModeratorPermission[] }>;

/** An Admin can manage these exact bundles, never arbitrary role definitions. */
export function standardTeamRole(role: {
  id: string; name: string; enabled?: boolean; moderationPermissions?: readonly string[];
}): boolean {
  if (!Object.prototype.hasOwnProperty.call(SUPPORT_TEAM_ROLES, role.id)) return false;
  const wanted = SUPPORT_TEAM_ROLES[role.id as keyof typeof SUPPORT_TEAM_ROLES];
  const permissions = role.moderationPermissions ?? [];
  return Boolean(wanted) && role.enabled !== false &&
    permissions.length === wanted.permissions.length &&
    wanted.permissions.every((permission) => permissions.includes(permission));
}
