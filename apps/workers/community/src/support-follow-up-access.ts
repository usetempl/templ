/** Who holds a staff permission now, read from the room's own role records.
 *
 * The follow-up alarm, routing checks and notification delivery run without
 * a request context, so they read roles the way delivery already does: an
 * enabled manual role in `native-manual-roles` whose settings entry carries
 * the permission, assigned under `roles:<principal>`. AI agents never
 * count as specialists or as people to remind. Reads only; grants nothing. */
import type { ModeratorPermission } from "@templ/chat/moderation-permissions";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { NativeRoomRecord } from "./native-rooms";
import { aiPrincipals, aiRole, BOT_SETTINGS_ERROR } from "./bots";
import { HttpError } from "./common";
import {
  currentStaffRoleIds,
  templStaffAccount,
  type TemplStaffEnv,
} from "./templ-staff";

type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;
type RoleSettings = {
  roles?: {
    id: string;
    enabled?: boolean;
    moderationPermissions?: ModeratorPermission[];
  }[];
};
type ManualRoles = Record<string, { mode?: string; enabled?: boolean }>;
/** Most holders one scan returns. */
export const HOLDER_SCAN_LIMIT = 100;

async function roleTable(storage: ReadStorage) {
  const settings = await storage.get<RoleSettings>("chat-settings");
  if (!settings) throw new HttpError(503, BOT_SETTINGS_ERROR);
  const manual = (await storage.get<ManualRoles>("native-manual-roles")) ?? {};
  const bots = new Set(await aiPrincipals(storage, settings));
  const grants = (permission: ModeratorPermission, agent = false) =>
    new Set(
      (settings.roles ?? [])
        .filter(
          (role) =>
            role.enabled !== false &&
            manual[role.id]?.mode === "manual" &&
            manual[role.id]?.enabled !== false &&
            (!agent || aiRole(role)) &&
            role.moderationPermissions?.includes(permission),
        )
        .map((role) => role.id),
    );
  return { bots, grants };
}
export async function roomManager(
  storage: Pick<DurableObjectStorage, "get">,
  env: TemplStaffEnv,
): Promise<ChatPrincipalId | null> {
  const native = await storage.get<NativeRoomRecord>("native-room");
  const manager = normalizeChatPrincipal(native?.room.manager);
  if (!manager) return null;
  return !(await isRegisteredBot(storage, manager)) &&
    !(await templStaffAccount(storage, [manager], env))
    ? manager
    : null;
}
/** Whether `principal` holds `permission` through an enabled manual role
 * now. The manager holds every staff permission except the Specialist role,
 * which is only ever an explicit grant. */
export async function holdsNow(
  storage: ReadStorage,
  principal: ChatPrincipalId,
  permission: ModeratorPermission,
  env: TemplStaffEnv = {},
  now = Date.now(),
): Promise<boolean> {
  const { bots, grants } = await roleTable(storage);
  if (permission === "handleFollowUps" && bots.has(principal)) return false;
  if (
    permission !== "handleFollowUps" &&
    principal === (await roomManager(storage, env))
  )
    return true;
  const roles = grants(permission, bots.has(principal));
  const held = await currentStaffRoleIds(storage, principal, env, now);
  return Array.isArray(held) && held.some((id) => roles.has(id));
}
/** Current holders of `permission` (the manager first for staff powers),
 * at most HOLDER_SCAN_LIMIT, AI agents left out. */
export async function holdersNow(
  storage: ReadStorage,
  permission: ModeratorPermission,
  env: TemplStaffEnv = {},
  now = Date.now(),
): Promise<ChatPrincipalId[]> {
  const { bots, grants } = await roleTable(storage);
  const roles = grants(permission);
  const found = new Set<ChatPrincipalId>();
  const manager = await roomManager(storage, env);
  if (manager && permission !== "handleFollowUps") found.add(manager);
  if (roles.size) {
    const rows = await storage.list<string[]>({
      prefix: "roles:",
      limit: 10_000,
    });
    for (const [key] of rows) {
      if (found.size >= HOLDER_SCAN_LIMIT) break;
      const id = normalizeChatPrincipal(key.slice("roles:".length));
      if (!id || bots.has(id)) continue;
      const held = await currentStaffRoleIds(storage, id, env, now);
      if (held.some((role) => roles.has(role))) found.add(id);
    }
  }
  return [...found];
}
/** The manager and support leads (`manageSupport` with conversation
 * access): who hears about escalations. */
export async function supportLeads(
  storage: ReadStorage,
  env: TemplStaffEnv = {},
  now = Date.now(),
): Promise<ChatPrincipalId[]> {
  const leads = new Set<ChatPrincipalId>();
  const manager = await roomManager(storage, env);
  if (manager) leads.add(manager);
  const handlers = new Set(await holdersNow(storage, "handleConversations", env, now));
  for (const id of await holdersNow(storage, "manageSupport", env, now))
    if (handlers.has(id)) leads.add(id);
  return [...leads];
}
export async function isRegisteredBot(
  storage: Pick<DurableObjectStorage, "get">,
  principal: ChatPrincipalId,
): Promise<boolean> {
  const settings = await storage.get<RoleSettings>("chat-settings");
  if (!settings) throw new HttpError(503, BOT_SETTINGS_ERROR);
  return (await aiPrincipals(storage, settings)).includes(principal);
}
