import type { ChatRole } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { standardTeamRole } from "@templ/chat/team-roles";
import { aiPrincipals } from "./bots";
import { currentStaffRoleIds, type TemplStaffEnv } from "./templ-staff";
import { aliasValues, servicePrincipals } from "./service-principals";
import { privacyStatus, roomPrivacy } from "./room-privacy";
import { readDeletionState } from "./workspace-deletion";
import type { NativeRoomRecord } from "./native-rooms";

/** Stored delegated approvals expire with their creator's current human Admin grant. */
export async function currentHumanAdmin(
  storage: Pick<DurableObjectTransaction, "get">,
  principal: ChatPrincipalId,
  aliases: unknown,
  env: TemplStaffEnv,
): Promise<boolean> {
  const identities = servicePrincipals(principal, aliases);
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native || await readDeletionState(storage)) return false;
  const accessStorage = storage as DurableObjectTransaction;
  if (!(await privacyStatus(accessStorage, await roomPrivacy(accessStorage, native.room), principal, false, identities)).canRead ||
      (await aliasValues(storage, "ban:", identities)).some(Boolean)) return false;
  const settings = await storage.get<{ roles: ChatRole[] }>("chat-settings");
  if (!settings) return false;
  const agents = await aiPrincipals(storage, settings);
  if (identities.some(id => agents.includes(id))) return false;
  const terms = await storage.get<Record<string, { mode: string; enabled?: boolean }>>("native-manual-roles");
  const role = settings.roles.find(row => row.id === "support-admin");
  return Boolean(role && standardTeamRole(role) && terms?.[role.id]?.mode === "manual" &&
    terms[role.id].enabled !== false && (await currentStaffRoleIds(storage, identities, env, Date.now())).includes(role.id));
}
