import type { ChatPrincipalId } from "@templ/chat/principal";

type DebtApproval = { id: string; approvedOn: string; approvedBy: ChatPrincipalId; reason: string };

/** The public snapshot has no workspace-specific billing approvals. */
export function customerDebtApproval(_workspace: string): DebtApproval | null {
  return null;
}

export function customerBillingManagedByTempl(_room: string): boolean {
  return false;
}
