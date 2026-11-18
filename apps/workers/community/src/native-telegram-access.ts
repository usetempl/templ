import type { ChatPrincipalId, ChatRole } from "@templ/chat/index";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { standardTeamRole } from "@templ/chat/team-roles";
import { aiPrincipals } from "./bots";
import type { NativeRoomRecord } from "./native-rooms";
import { readDeletionState } from "./workspace-deletion";
import { privacyStatus, roomPrivacy } from "./room-privacy";
import { aliasValues, servicePrincipals } from "./service-principals";
import { currentHumanAdmin } from "./workspace-admin";
import { requireSafetyAccess, type SafetyEnv } from "./safety";
import { templStaffAccount, type TemplStaffEnv } from "./templ-staff";
import { featureOn } from "./workspace-flags";

type Storage = Pick<DurableObjectTransaction, "get">;
export const NATIVE_TELEGRAM_KEY = "support-native-telegram-v1";
export const nativeTelegramGrantKey = (principal: string) =>
  `support-native-telegram-grant-v1:${principal}`;
export type NativeTelegramRecord = {
  schemaVersion: 1;
  workspaceId: string;
  approvalId: string;
  createdBy: ChatPrincipalId;
  creatorAliases: ChatPrincipalId[];
  approvalOwner: ChatPrincipalId;
  createdAt: number;
  approvedAt: number | null;
  installedGrant: boolean;
  relayPrincipalId: ChatPrincipalId | null;
  relayNonce?: string;
  relayRotation?: {
    previousRelayPrincipalId: string;
    previousRelayNonce?: string;
    bindingDigest: string;
    startedAt: number;
  };
  status:
    | "preparing"
    | "pairing"
    | "approving"
    | "active"
    | "disconnected"
    | "paused";
  code: string | null;
  expiresAt: number | null;
  invite: string | null;
  group: string | null;
};
export function checkedNativeTelegram(
  value: unknown,
): NativeTelegramRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as NativeTelegramRecord;
  const natural = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  try {
    servicePrincipals(row.createdBy, row.creatorAliases);
  } catch {
    return null;
  }
  if (
    row.schemaVersion !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      row.workspaceId,
    ) ||
    !/^[a-f0-9]{32}$/.test(row.approvalId) ||
    normalizeChatPrincipal(row.createdBy) !== row.createdBy ||
    normalizeChatPrincipal(row.approvalOwner) !== row.approvalOwner ||
    !Array.isArray(row.creatorAliases) ||
    !natural(row.createdAt) ||
    !(row.approvedAt === null || natural(row.approvedAt)) ||
    typeof row.installedGrant !== "boolean" ||
    !(
      row.relayPrincipalId === null ||
      /^0x[a-f0-9]{40}$/.test(row.relayPrincipalId)
    ) ||
    (row.relayPrincipalId !== null &&
      row.creatorAliases.includes(row.relayPrincipalId)) ||
    (row.relayNonce !== undefined &&
      (typeof row.relayNonce !== "string" ||
        !/^[a-f0-9]{32}$/.test(row.relayNonce) ||
        /^0{32}$/.test(row.relayNonce))) ||
    (row.relayRotation !== undefined &&
      (!row.relayRotation ||
        typeof row.relayRotation !== "object" ||
        Array.isArray(row.relayRotation) ||
        Object.keys(row.relayRotation).some(
          (key) =>
            ![
              "previousRelayPrincipalId",
              "previousRelayNonce",
              "bindingDigest",
              "startedAt",
            ].includes(key),
        ) ||
        !row.relayNonce ||
        row.approvedAt === null ||
        typeof row.relayRotation.previousRelayPrincipalId !== "string" ||
        !/^0x[a-f0-9]{40}$/.test(row.relayRotation.previousRelayPrincipalId) ||
        row.relayRotation.previousRelayPrincipalId === row.relayPrincipalId ||
        (row.relayRotation.previousRelayNonce !== undefined &&
          (typeof row.relayRotation.previousRelayNonce !== "string" ||
            !/^[a-f0-9]{32}$/.test(row.relayRotation.previousRelayNonce) ||
            /^0{32}$/.test(row.relayRotation.previousRelayNonce))) ||
        typeof row.relayRotation.bindingDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.relayRotation.bindingDigest) ||
        !natural(row.relayRotation.startedAt))) ||
    ![
      "preparing",
      "pairing",
      "approving",
      "active",
      "disconnected",
      "paused",
    ].includes(row.status) ||
    !(row.code === null || /^[A-F0-9]{12}$/.test(row.code)) ||
    !(row.expiresAt === null || natural(row.expiresAt)) ||
    !(
      row.invite === null ||
      /^https:\/\/t\.me\/usetempl_bot\?startgroup=[A-F0-9]{12}$/.test(
        row.invite,
      )
    ) ||
    !(
      row.group === null ||
      (typeof row.group === "string" &&
        row.group.length > 0 &&
        row.group.length <= 80 &&
        // eslint-disable-next-line no-control-regex -- Group labels cannot contain control characters.
        !/[\u0000-\u001f\u007f]/.test(row.group))
    )
  )
    return null;
  return row;
}

/** Stored creator authority never comes from the bridge or a client-nominated alias. */
export async function nativeTelegramCreatorCurrent(
  storage: Storage,
  row: NativeTelegramRecord,
  env: TemplStaffEnv,
): Promise<boolean> {
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (
    !native ||
    native.room.id !== row.workspaceId ||
    native.room.manager !== row.approvalOwner ||
    (await readDeletionState(storage))
  )
    return false;
  const ids = servicePrincipals(row.createdBy, row.creatorAliases);
  const settings = await storage.get<{ roles: ChatRole[] }>("chat-settings");
  if (
    !settings ||
    ids.some((id) => id === row.relayPrincipalId) ||
    (await aiPrincipals(storage, settings)).some((id) => ids.includes(id)) ||
    (await templStaffAccount(storage, ids, env)) ||
    (await aliasValues(storage, "ban:", ids)).some(Boolean)
  )
    return false;
  const roomStorage = storage as DurableObjectTransaction;
  if (
    !(
      await privacyStatus(
        roomStorage,
        await roomPrivacy(roomStorage, native.room),
        row.createdBy,
        ids.includes(native.room.manager),
        ids,
      )
    ).canRead
  )
    return false;
  if (
    !ids.includes(native.room.manager) &&
    !(await currentHumanAdmin(storage, row.createdBy, ids, env))
  )
    return false;
  await requireSafetyAccess(
    env as SafetyEnv,
    `room:${row.workspaceId}`,
    row.createdBy,
    ids,
  );
  return true;
}

/** The bridge's native Team role depends on this exact current approval. */
export async function nativeTelegramApproved(
  storage: Storage,
  env: TemplStaffEnv,
  input: {
    workspaceId: string;
    approvalId: string;
    relayPrincipalId: string;
  },
): Promise<boolean> {
  const row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  if (
    !(await featureOn(env, storage, "nativeTelegram")) ||
    !row ||
    row.workspaceId !== input.workspaceId ||
    row.approvalId !== input.approvalId ||
    row.relayPrincipalId !== input.relayPrincipalId ||
    !row.installedGrant ||
    row.approvedAt === null ||
    !["approving", "active"].includes(row.status) ||
    !(await nativeTelegramCreatorCurrent(storage, row, env))
  )
    return false;
  const marker = await storage.get<{ approvalId: string }>(
    nativeTelegramGrantKey(row.relayPrincipalId),
  );
  const held = await storage.get<string[]>(`roles:${row.relayPrincipalId}`);
  const settings = await storage.get<{ roles: ChatRole[] }>("chat-settings");
  const manual = await storage.get<
    Record<string, { mode?: string; enabled?: boolean }>
  >("native-manual-roles");
  const role = settings?.roles.find((role) => role.id === "support-member");
  if (
    marker?.approvalId !== row.approvalId ||
    !held?.includes("support-member") ||
    !role ||
    !standardTeamRole(role) ||
    manual?.[role.id]?.mode !== "manual" ||
    manual[role.id].enabled === false ||
    (await aiPrincipals(storage, settings!)).includes(row.relayPrincipalId) ||
    (await storage.get(`ban:${row.relayPrincipalId}`)) ||
    !(
      await privacyStatus(
        storage as DurableObjectTransaction,
        await roomPrivacy(storage as DurableObjectTransaction),
        row.relayPrincipalId,
        false,
        [row.relayPrincipalId],
      )
    ).canRead
  )
    return false;
  await requireSafetyAccess(
    env as SafetyEnv,
    `room:${row.workspaceId}`,
    row.relayPrincipalId,
    [row.relayPrincipalId],
  );
  return true;
}

/** A retained marker prevents a relay credential from gaining unrelated roles. */
export async function nativeTelegramRoleAuthority(
  storage: Storage,
  ids: readonly ChatPrincipalId[],
  env: TemplStaffEnv,
): Promise<boolean | null> {
  const marked = (
    await Promise.all(ids.map((id) => storage.get(nativeTelegramGrantKey(id))))
  ).some((value) => value !== undefined);
  if (!marked) return null;
  const row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  return Boolean(
    row?.relayPrincipalId &&
    ids.includes(row.relayPrincipalId) &&
    (await nativeTelegramApproved(
      storage,
      env,
      row as NativeTelegramRecord & { relayPrincipalId: string },
    )),
  );
}

/** A normal manual role change ends the connection-owned grant. */
export async function invalidateNativeTelegramGrant(
  storage: Pick<DurableObjectTransaction, "get" | "put">,
  ids: readonly ChatPrincipalId[],
) {
  const row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  if (
    row?.relayPrincipalId &&
    row.installedGrant &&
    ids.includes(row.relayPrincipalId)
  )
    await storage.put(NATIVE_TELEGRAM_KEY, {
      ...row,
      installedGrant: false,
      status: "paused",
    });
}
