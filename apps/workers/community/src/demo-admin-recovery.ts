import type { ChatPrincipalId } from "@templ/chat/index";
import type { ChatRole } from "@templ/chat/index";
import type { ChatRoleTerms } from "@templ/chat/index";
import type { NativeRoomRecord } from "./native-rooms";
import type { SafetyEnv } from "./safety";
import type { TemplStaffEnv } from "./templ-staff";
import type { PendingAudit } from "./room-audit";

/** Private hosted recovery grants are absent from this snapshot. */
export async function recoverDemoAdmin(
  _storage: DurableObjectTransaction,
  _input: {
    native: NativeRoomRecord;
    actor: ChatPrincipalId | null;
    aliases: ChatPrincipalId[];
    roles: (Pick<ChatRole, "id" | "name" | "moderationPermissions"> & {
      enabled?: boolean;
    })[];
    manual: Record<string, ChatRoleTerms>;
    agents: ChatPrincipalId[];
    env: Partial<SafetyEnv> & TemplStaffEnv;
    reserveGrowth: () => Promise<void>;
  },
): Promise<PendingAudit | null> {
  return null;
}
