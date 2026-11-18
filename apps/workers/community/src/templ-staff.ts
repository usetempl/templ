import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError } from "./common";
import { principalList } from "./principal";
import { nativeTelegramRoleAuthority } from "./native-telegram-access";
import type { WorkspaceFlagEnv } from "./workspace-flags";
import {
  activeOrderForm,
  activeProductOrderForm,
  readProductOrderForms,
} from "./product-order-forms";

type ReadStorage = Pick<DurableObjectTransaction, "get">;
export type TemplStaffEnv = WorkspaceFlagEnv & {
  TEMPL_STAFF_PRINCIPALS?: string;
};
type TemplStaffGrant = { templStaff: true; roleIds: string[] };
export const templStaffGrantKey = (principal: string) =>
  `templ-staff-v1:${principal}`;
const ordinaryRoles = new Set(["support-member", "support-lead"]);

function validTemplStaffGrant(value: unknown): value is TemplStaffGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return (
    grant.templStaff === true &&
    Array.isArray(grant.roleIds) &&
    grant.roleIds.length <= ordinaryRoles.size &&
    new Set(grant.roleIds).size === grant.roleIds.length &&
    grant.roleIds.every(
      (role) => typeof role === "string" && ordinaryRoles.has(role),
    )
  );
}

export function listedTemplStaff(
  env: TemplStaffEnv,
  principal: string,
): boolean {
  return principalList(env.TEMPL_STAFF_PRINCIPALS).includes(
    principal as ChatPrincipalId,
  );
}

/** A retained marker hides personal names and labels the account on the Team page. */
export async function isTemplStaff(
  storage: ReadStorage,
  principal: string,
): Promise<boolean> {
  return (await storage.get(templStaffGrantKey(principal))) !== undefined;
}

/** A retained marker still restricts the account when its content is invalid. */
export async function templStaffAccount(
  storage: ReadStorage,
  ids: readonly ChatPrincipalId[],
  env: TemplStaffEnv,
): Promise<boolean> {
  return (
    await Promise.all(
      ids.map(
        async (id) =>
          listedTemplStaff(env, id) ||
          (await storage.get(templStaffGrantKey(id))) !== undefined,
      ),
    )
  ).some(Boolean);
}

/** The role record and the signed deal are both required for case authority. */
export async function currentStaffRoleIds(
  storage: ReadStorage,
  principal: ChatPrincipalId | readonly ChatPrincipalId[],
  env: TemplStaffEnv,
  now: number,
): Promise<string[]> {
  return (await readStaffAuthority(storage, principal, env)).roleIds(now);
}

/** Read authority first, then evaluate its time limits immediately before use. */
export async function readStaffAuthority(
  storage: ReadStorage,
  principal: ChatPrincipalId | readonly ChatPrincipalId[],
  env: TemplStaffEnv,
): Promise<{ templStaff: boolean; roleIds: (now: number) => string[] }> {
  const ids = typeof principal === "string" ? [principal] : principal;
  const relay = await nativeTelegramRoleAuthority(storage, ids, env);
  if (relay !== null) return { templStaff: false, roleIds: () => relay ? ["support-member"] : [] };
  const rows = await Promise.all(
    ids.map(async (id) => ({
      held: (await storage.get<string[]>(`roles:${id}`)) ?? [],
      grant: await storage.get<unknown>(templStaffGrantKey(id)),
      listed: listedTemplStaff(env, id),
    })),
  );
  if (!rows.some((row) => row.grant !== undefined || row.listed))
    return {
      templStaff: false,
      roleIds: () => [...new Set(rows.flatMap((row) => row.held))],
    };
  const forms = await readProductOrderForms(storage);
  const settings = await storage.get<{
    roles?: {
      id: string;
      enabled?: boolean;
      moderationPermissions?: string[];
    }[];
  }>("chat-settings");
  const manual = await storage.get<
    Record<string, { mode?: string; enabled?: boolean }>
  >("native-manual-roles");
  const roleIds = [
    ...new Set(
      rows.flatMap(({ held, grant, listed }) => {
        if (!validTemplStaffGrant(grant) || !listed || !Array.isArray(held))
          return [];
        return held.filter((role) => {
          const configured = settings?.roles?.find((item) => item.id === role);
          const permissions = configured?.moderationPermissions;
          const allowed =
            role === "support-lead"
              ? ["handleConversations", "manageSupport"]
              : ["handleConversations"];
          return (
            ordinaryRoles.has(role) &&
            grant.roleIds.includes(role) &&
            configured?.enabled !== false &&
            manual?.[role]?.mode === "manual" &&
            manual[role]?.enabled !== false &&
            Array.isArray(permissions) &&
            permissions.includes("handleConversations") &&
            permissions.every((permission) => allowed.includes(permission))
          );
        });
      }),
    ),
  ];
  return {
    templStaff: true,
    roleIds: (now) =>
      activeOrderForm(forms, now)?.service === "done-for-you" ? roleIds : [],
  };
}

export async function updateTemplStaffGrant(
  storage: Pick<DurableObjectTransaction, "get" | "put">,
  input: {
    principal: ChatPrincipalId;
    roleId: string;
    granted: boolean;
    manager: boolean;
    templStaffConfirmed: unknown;
    now: number;
  },
  env: TemplStaffEnv,
): Promise<boolean> {
  const existing = await storage.get<unknown>(
    templStaffGrantKey(input.principal),
  );
  const listed = listedTemplStaff(env, input.principal);
  if (existing === undefined && !listed) return false;
  if (!input.manager)
    throw new HttpError(403, "Only the manager can change a Templ role.");
  if (input.granted) {
    if (!listed || !ordinaryRoles.has(input.roleId))
      throw new HttpError(
        403,
        "Choose Support member or Support lead for a Templ person.",
      );
    if (
      (await activeProductOrderForm(storage, input.now))?.service !==
      "done-for-you"
    )
      throw new HttpError(
        403,
        "A signed done-for-you order form is required for Templ people.",
      );
    if (input.templStaffConfirmed !== true)
      throw new HttpError(
        409,
        "Confirm this person's Templ access.",
        undefined,
        "templ-staff-confirmation",
      );
  }
  const roles = new Set(validTemplStaffGrant(existing) ? existing.roleIds : []);
  if (input.granted) roles.add(input.roleId);
  else roles.delete(input.roleId);
  await storage.put(templStaffGrantKey(input.principal), {
    templStaff: true,
    roleIds: [...roles],
  } satisfies TemplStaffGrant);
  return true;
}

export async function templStaffCount(
  storage: Pick<DurableObjectTransaction, "list">,
): Promise<number> {
  const grants = await storage.list<TemplStaffGrant>({
    prefix: "templ-staff-v1:",
    limit: 1024,
  });
  return [...grants].filter(
    ([key, grant]) =>
      normalizeChatPrincipal(key.slice("templ-staff-v1:".length)) &&
      grant?.templStaff === true &&
      Array.isArray(grant.roleIds) &&
      grant.roleIds.length > 0,
  ).length;
}
