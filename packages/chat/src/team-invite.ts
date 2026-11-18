/** Human team invitations. Only links return a token. */
export type TeamInviteRole = "support-member" | "support-lead" | "support-admin";
export type TeamInvitation = {
  id: string;
  roleId: TeamInviteRole;
  roleName: string;
  createdAt: string;
  expiresAt: number;
  status: "active" | "expired" | "revoked" | "used";
  /** Manager-only invitation details. Never a credential or account alias. */
  emailTargeted?: true;
  recipient?: string;
};
export type TeamInvitePreview = {
  roleId: TeamInviteRole;
  roleName: string;
  expiresAt: number;
};
