import type { ChatPrincipalId, ChatRole } from "@templ/chat/index";
import type {
  NativeTelegramBridge,
  NativeTelegramView,
  NativeTelegramGrant,
} from "@templ/chat/support-telegram";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { standardTeamRole, SUPPORT_TEAM_ROLES } from "@templ/chat/team-roles";
import { HttpError, json, randomToken, sha256Hex, type Env } from "./common";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import { actsAs } from "./service-principals";
import {
  admitPrivateInvitationMember,
  admitRoomMember,
  roomPrivacy,
} from "./room-privacy";
import { currentHumanAdmin } from "./workspace-admin";
import { nativeManualRole } from "./native-rooms";
import { aiPrincipals } from "./bots";
import { templStaffAccount } from "./templ-staff";
import { wakeRoomAt } from "./room-alarm";
import { appendAudit } from "./room-audit";
import { featureOn } from "./workspace-flags";
import {
  NATIVE_TELEGRAM_KEY,
  checkedNativeTelegram,
  nativeTelegramApproved,
  nativeTelegramCreatorCurrent,
  nativeTelegramGrantKey,
  type NativeTelegramRecord,
} from "./native-telegram-access";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
type NativeEnv = Env & { NATIVE_TELEGRAM_BRIDGE?: NativeTelegramBridge };
const OUTBOX = "support-native-telegram-outbox-v1:";
const FAILED = "support-native-telegram-failed-v1:";
const QUEUE_LIMIT = 1_000;
type Job = {
  op: "prepare" | "approve" | "disconnect" | "handoff" | "rotate-relay";
  scope: {
    workspaceId: string;
    approvalId: string;
    relayPrincipalId: string | null;
    relayNonce?: string;
  };
  rotation?: NativeTelegramRecord["relayRotation"];
  eventId: string;
  conversationId?: string;
  handoffAt?: number;
  attempts: number;
  dueAt: number;
  expiresAt: number;
};
const unavailable = () =>
  new HttpError(503, "Telegram support is unavailable. Try again.");
const noAccess = () => new HttpError(404, "Support tools not found.");
const enabled = async (env: NativeEnv, storage: Storage) =>
  Boolean(env.NATIVE_TELEGRAM_BRIDGE) &&
  (await featureOn(env, storage, "nativeTelegram"));
async function enqueue(
  storage: Storage,
  row: NativeTelegramRecord,
  op: Job["op"],
  now: number,
  handoff?: { conversationId: string; at: number },
) {
  const eventId = await sha256Hex(
    `${row.approvalId}:${row.relayPrincipalId ?? ""}:${row.relayNonce ?? ""}:${op}:${handoff?.conversationId ?? ""}:${handoff?.at ?? ""}`,
  );
  const key = OUTBOX + eventId;
  if (await storage.get(key)) return;
  if (
    (await storage.list({ prefix: OUTBOX, limit: QUEUE_LIMIT })).size >=
    QUEUE_LIMIT
  )
    throw unavailable();
  await storage.put(key, {
    op,
    scope: {
      workspaceId: row.workspaceId,
      approvalId: row.approvalId,
      relayPrincipalId: row.relayPrincipalId,
      ...(row.relayNonce ? { relayNonce: row.relayNonce } : {}),
    },
    ...((op === "rotate-relay" || op === "disconnect") && row.relayRotation
      ? { rotation: row.relayRotation }
      : {}),
    eventId,
    ...(handoff
      ? { conversationId: handoff.conversationId, handoffAt: handoff.at }
      : {}),
    attempts: 0,
    dueAt: now,
    expiresAt:
      op === "handoff"
        ? now + 6 * 3_600_000
        : op === "disconnect" || op === "rotate-relay"
          ? now + 86_400_000
          : row.expiresAt!,
  } satisfies Job);
  await wakeRoomAt(storage, now + 1_000);
}
async function viewerAllowed(storage: Storage, context: ConversationContext) {
  if (
    !context.viewer.principalId ||
    context.isBot ||
    context.viewer.banned ||
    (!context.viewer.isManager &&
      !(await currentHumanAdmin(
        storage,
        context.viewer.principalId,
        context.aliases,
        context.mediaEnv,
      )))
  )
    throw noAccess();
}
async function view(
  storage: Storage,
  env: NativeEnv,
  now: number,
): Promise<NativeTelegramView> {
  const row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  const result: NativeTelegramView = {
    available: await enabled(env, storage),
    status: "disconnected",
    approvalId: null,
    code: null,
    expiresAt: null,
    invite: null,
    group: null,
  };
  if (!row || row.status === "disconnected") return result;
  const current = await nativeTelegramCreatorCurrent(storage, row, env);
  const expired =
    row.approvedAt === null && row.expiresAt !== null && row.expiresAt <= now;
  const approved =
    row.relayPrincipalId !== null &&
    (await nativeTelegramApproved(
      storage,
      env,
      row as NativeTelegramRecord & { relayPrincipalId: string },
    ));
  result.status =
    !current ||
    expired ||
    !result.available ||
    (row.approvedAt !== null && !approved)
      ? "paused"
      : row.status;
  result.approvalId = row.approvalId;
  if (result.status !== "paused") {
    result.code = row.approvedAt === null ? row.code : null;
    result.expiresAt = row.approvedAt === null ? row.expiresAt : null;
    result.invite = row.approvedAt === null ? row.invite : null;
    result.group = row.group;
    if (row.relayPrincipalId && !row.relayRotation) {
      // This RPC reads bridge pairing storage only; it cannot call back into the room.
      const status = await env.NATIVE_TELEGRAM_BRIDGE!.status({
        workspaceId: row.workspaceId,
        approvalId: row.approvalId,
        relayPrincipalId: row.relayPrincipalId,
        ...(row.relayNonce ? { relayNonce: row.relayNonce } : {}),
      });
      if (status.relayPrincipalId !== row.relayPrincipalId) throw unavailable();
      result.group = group(status.group);
      if (row.approvedAt !== null && status.linked && approved)
        result.status = "active";
    }
  }
  return result;
}
function group(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 80 ||
    // eslint-disable-next-line no-control-regex -- Group labels cannot contain control characters.
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw unavailable();
  return value;
}

/** Only native Owner/Admin authentication can approve the relay's Team access. */
export async function nativeTelegramRoute(
  storage: Storage,
  context: ConversationContext,
): Promise<Response | null> {
  if (context.pathname !== "/conversations/telegram") return null;
  await viewerAllowed(storage, context);
  const env = context.mediaEnv as NativeEnv;
  if (context.method === "GET")
    return json(await view(storage, env, context.now));
  if (context.method !== "POST") throw noAccess();
  const body = context.body;
  if (!(await enabled(env, storage))) throw unavailable();
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "op",
          "approvalId",
          "confirmed",
          "expectedPrincipalId",
          ...(body.op === "rotate-relay" ? ["expectedRelayPrincipalId"] : []),
        ].includes(key),
    ) ||
    !["prepare", "approve", "disconnect", "rotate-relay"].includes(
      body.op as string,
    )
  )
    throw new HttpError(400, "Choose a Telegram connection action.");
  requireWorkspaceAdminHeaders(
    context.headers,
    context.viewer.isManager,
    body.confirmed,
    context.now,
  );
  if (
    typeof body.expectedPrincipalId !== "string" ||
    !actsAs(context.aliases, body.expectedPrincipalId as ChatPrincipalId)
  )
    throw new HttpError(
      403,
      "Sign in again with the account you reviewed this change with.",
    );
  let row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  if (body.op === "prepare") {
    if (row && row.status !== "disconnected")
      throw new HttpError(409, "Disconnect the existing connection first.");
    row = {
      schemaVersion: 1,
      workspaceId: context.room.slice(5),
      approvalId: randomToken().slice(0, 32),
      createdBy: context.viewer.principalId!,
      creatorAliases: [...context.aliases],
      approvalOwner: context.manager!,
      createdAt: context.now,
      approvedAt: null,
      installedGrant: false,
      relayPrincipalId: null,
      status: "preparing",
      code: null,
      expiresAt: context.now + 86_400_000,
      invite: null,
      group: null,
    };
  } else {
    if (!row || body.approvalId !== row.approvalId)
      throw new HttpError(
        409,
        "Refresh the Telegram connection before changing it.",
      );
    if (body.op === "rotate-relay") {
      if (
        !row.relayPrincipalId ||
        body.expectedRelayPrincipalId !== row.relayPrincipalId ||
        row.status !== "paused" ||
        row.installedGrant ||
        row.approvedAt === null ||
        !row.group ||
        row.relayRotation ||
        !(await nativeTelegramCreatorCurrent(storage, row, env)) ||
        (
          await storage.get<{ approvalId: string }>(
            nativeTelegramGrantKey(row.relayPrincipalId),
          )
        )?.approvalId !== row.approvalId ||
        (await storage.get<string[]>(`roles:${row.relayPrincipalId}`))?.length
      )
        throw new HttpError(
          409,
          "Refresh the paused Telegram connection before replacing its bot identity.",
        );
      const before = row;
      const relayNonce = randomToken().slice(0, 32);
      const prepared = await env.NATIVE_TELEGRAM_BRIDGE!.prepareRelayRotation({
        workspaceId: row.workspaceId,
        approvalId: row.approvalId,
        relayPrincipalId: row.relayPrincipalId,
        ...(row.relayNonce ? { relayNonce: row.relayNonce } : {}),
        nextRelayNonce: relayNonce,
      });
      row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
      if (
        !row ||
        JSON.stringify(row) !== JSON.stringify(before) ||
        !(await nativeTelegramCreatorCurrent(storage, row, env)) ||
        (
          await storage.get<{ approvalId: string }>(
            nativeTelegramGrantKey(before.relayPrincipalId!),
          )
        )?.approvalId !== before.approvalId ||
        (await storage.get<string[]>(`roles:${before.relayPrincipalId}`))
          ?.length
      )
        throw new HttpError(
          409,
          "Refresh the Telegram connection before changing it.",
        );
      const principal = normalizeChatPrincipal(prepared.relayPrincipalId);
      if (
        !principal ||
        !/^0x[a-f0-9]{40}$/.test(principal) ||
        principal === before.relayPrincipalId ||
        group(prepared.group) !== row.group ||
        !/^[a-f0-9]{64}$/.test(prepared.bindingDigest) ||
        row.creatorAliases.includes(principal) ||
        principal === context.manager ||
        (await storage.get<string[]>(`roles:${principal}`))?.length ||
        (await storage.get(nativeTelegramGrantKey(principal))) ||
        (await storage.get(`ban:${principal}`)) ||
        (await templStaffAccount(storage, [principal], env)) ||
        (
          await aiPrincipals(
            storage,
            (await storage.get<{ roles: ChatRole[] }>("chat-settings")) ?? {
              roles: [],
            },
          )
        ).includes(principal)
      )
        throw new HttpError(
          409,
          "This bot identity cannot receive workspace access.",
        );
      const settings = await storage.get<{ roles: ChatRole[] }>(
        "chat-settings",
      );
      const role = settings?.roles.find((role) => role.id === "support-member");
      const manual = await storage.get<
        Record<string, { mode?: string; enabled?: boolean }>
      >("native-manual-roles");
      if (
        !role ||
        !standardTeamRole(role) ||
        manual?.[role.id]?.mode !== "manual" ||
        manual[role.id].enabled === false
      )
        throw new HttpError(409, "Ask the owner to check the Team role.");
      const privacy = await roomPrivacy(storage);
      if (privacy.visibility === "private")
        await admitPrivateInvitationMember(
          storage,
          principal,
          row.approvalId,
          context.now,
        );
      else await admitRoomMember(storage, principal, row.approvalId);
      await storage.put(`roles:${principal}`, ["support-member"]);
      await storage.put(nativeTelegramGrantKey(principal), {
        approvalId: row.approvalId,
      });
      row = {
        ...row,
        relayPrincipalId: principal,
        relayNonce,
        installedGrant: true,
        status: "approving",
        relayRotation: {
          previousRelayPrincipalId: before.relayPrincipalId!,
          ...(before.relayNonce
            ? { previousRelayNonce: before.relayNonce }
            : {}),
          bindingDigest: prepared.bindingDigest,
          startedAt: context.now,
        },
      };
      context.pending.push({ type: "role.updated", roleId: "support-member" });
      context.pendingAudit.push({
        actor: context.viewer.principalId!,
        action: "role.assign",
        target: principal,
        after: { roleId: "support-member", granted: true },
      });
    } else if (body.op === "approve") {
      if (
        !row.relayPrincipalId ||
        row.status !== "pairing" ||
        row.expiresAt === null ||
        row.expiresAt <= context.now ||
        !(await nativeTelegramCreatorCurrent(storage, row, env))
      )
        throw new HttpError(409, "Prepare a new Telegram connection.");
      const paired = await env.NATIVE_TELEGRAM_BRIDGE!.status({
        workspaceId: row.workspaceId,
        approvalId: row.approvalId,
        relayPrincipalId: row.relayPrincipalId,
        ...(row.relayNonce ? { relayNonce: row.relayNonce } : {}),
      });
      if (
        paired.relayPrincipalId !== row.relayPrincipalId ||
        !group(paired.group)
      )
        throw new HttpError(
          409,
          "Add Templ to your group before approving it.",
        );
      const settings = await storage.get<{ roles: ChatRole[] }>(
        "chat-settings",
      );
      const role = settings?.roles.find((role) => role.id === "support-member");
      const manual = await storage.get<
        Record<string, { mode?: string; enabled?: boolean }>
      >("native-manual-roles");
      const createTeam = Boolean(
        settings && !role && !Object.hasOwn(manual ?? {}, "support-member"),
      );
      if (
        !createTeam &&
        (!role ||
          !standardTeamRole(role) ||
          manual?.[role.id]?.mode !== "manual" ||
          manual[role.id].enabled === false)
      )
        throw new HttpError(409, "Ask the owner to check the Team role.");
      if (createTeam) {
        if (settings!.roles.length >= 64)
          throw new HttpError(409, "This chat has reached its role limit.");
        // Restoring a definition must not restore somebody else's stale grant.
        const grants = await storage.list<unknown>({
          prefix: "roles:",
          limit: 1025,
        });
        if (
          grants.size > 1024 ||
          [...grants.values()].some(
            (held) =>
              !Array.isArray(held) ||
              held.some((id) => typeof id !== "string") ||
              held.includes("support-member"),
          )
        )
          throw new HttpError(409, "Ask the owner to check the Team role.");
      }
      if (
        (await storage.get<string[]>(`roles:${row.relayPrincipalId}`))
          ?.length ||
        (await aiPrincipals(storage, settings!)).includes(
          row.relayPrincipalId,
        ) ||
        (await templStaffAccount(storage, [row.relayPrincipalId], env)) ||
        row.relayPrincipalId === context.manager
      )
        throw new HttpError(409, "This relay already has workspace access.");
      if (createTeam) {
        const metadata = {
          id: "support-member",
          name: SUPPORT_TEAM_ROLES["support-member"].name,
          moderationPermissions: [
            ...SUPPORT_TEAM_ROLES["support-member"].permissions,
          ],
        };
        const terms = nativeManualRole(metadata.id);
        await storage.put("native-manual-roles", {
          ...manual,
          [metadata.id]: terms,
        });
        await storage.put("chat-settings", {
          ...settings,
          roles: [...settings!.roles, metadata],
        });
        context.pendingAudit.push({
          actor: context.viewer.principalId!,
          action: "role.save",
          target: metadata.id,
          before: null,
          after: { ...metadata, mode: terms.mode, enabled: terms.enabled },
        });
      }
      const privacy = await roomPrivacy(storage);
      if (privacy.visibility === "private")
        await admitPrivateInvitationMember(
          storage,
          row.relayPrincipalId,
          row.approvalId,
          context.now,
        );
      else await admitRoomMember(storage, row.relayPrincipalId, row.approvalId);
      await storage.put(`roles:${row.relayPrincipalId}`, ["support-member"]);
      await storage.put(nativeTelegramGrantKey(row.relayPrincipalId), {
        approvalId: row.approvalId,
      });
      row = {
        ...row,
        createdBy: context.viewer.principalId!,
        creatorAliases: [...context.aliases],
        group: group(paired.group),
        approvedAt: context.now,
        installedGrant: true,
        status: "approving",
      };
      context.pending.push({ type: "role.updated", roleId: "support-member" });
      context.pendingAudit.push({
        actor: context.viewer.principalId!,
        action: "role.assign",
        target: row.relayPrincipalId,
        after: { roleId: "support-member", granted: true },
      });
    } else {
      if (
        row.relayPrincipalId &&
        row.installedGrant &&
        (
          await storage.get<{ approvalId: string }>(
            nativeTelegramGrantKey(row.relayPrincipalId),
          )
        )?.approvalId === row.approvalId
      ) {
        const held =
          (await storage.get<string[]>(`roles:${row.relayPrincipalId}`)) ?? [];
        await storage.put(
          `roles:${row.relayPrincipalId}`,
          held.filter((role) => role !== "support-member"),
        );
        context.pending.push({
          type: "role.updated",
          roleId: "support-member",
        });
        context.pendingAudit.push({
          actor: context.viewer.principalId!,
          action: "role.assign",
          target: row.relayPrincipalId,
          after: { roleId: "support-member", granted: false },
        });
      }
      row = {
        ...row,
        status: "disconnected",
        installedGrant: false,
        code: null,
        invite: null,
      };
    }
  }
  await storage.put(NATIVE_TELEGRAM_KEY, row);
  if (
    body.op === "rotate-relay" &&
    !(await nativeTelegramApproved(
      storage,
      env,
      row as NativeTelegramRecord & { relayPrincipalId: string },
    ))
  )
    throw new HttpError(
      409,
      "This bot identity cannot receive workspace access.",
    );
  await enqueue(storage, row, body.op as Job["op"], context.now);
  context.pendingAudit.push({
    actor: context.viewer.principalId!,
    action: "support.settings",
    after: { op: `telegram.${body.op}`, approvalId: row.approvalId },
  });
  return json({
    available: true,
    status: row.status,
    approvalId: row.approvalId,
    code: row.approvedAt === null ? row.code : null,
    expiresAt: row.approvedAt === null ? row.expiresAt : null,
    invite: row.approvedAt === null ? row.invite : null,
    group: row.group,
  } satisfies NativeTelegramView);
}

/** IDs only, written in the same transaction as the native handoff. */
export async function enqueueNativeTelegramHandoff(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  const row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  if (
    !row?.relayPrincipalId ||
    !record.handoff ||
    !(await enabled(context.mediaEnv as NativeEnv, storage)) ||
    !(await nativeTelegramApproved(
      storage,
      context.mediaEnv,
      row as NativeTelegramRecord & { relayPrincipalId: string },
    ))
  )
    return;
  await enqueue(storage, row, "handoff", context.now, {
    conversationId: record.id,
    at: record.handoff.at,
  });
}

/** One bounded committed outbox batch; each attempt is persisted before the fixed service call. */
export async function nativeTelegramAlarm(
  state: DurableObjectState,
  env: NativeEnv,
  now: number,
): Promise<number | null> {
  const jobs = await state.storage.list<Job>({
    prefix: OUTBOX,
    limit: QUEUE_LIMIT,
  });
  let next = Infinity;
  for (const [key] of [...jobs]
    .filter(([, job]) => job.dueAt <= now)
    .sort((a, b) => a[1].dueAt - b[1].dueAt)
    .slice(0, 10)) {
    const job = await state.storage.transaction(async (storage) => {
      const pending = await storage.get<Job>(key);
      if (!pending || pending.dueAt > now) return null;
      const current = checkedNativeTelegram(
        await storage.get(NATIVE_TELEGRAM_KEY),
      );
      const sameApproval =
        current?.approvalId === pending.scope.approvalId &&
        current.workspaceId === pending.scope.workspaceId;
      const same =
        sameApproval &&
        current.relayPrincipalId === pending.scope.relayPrincipalId &&
        current.relayNonce === pending.scope.relayNonce;
      if (sameApproval && !same) {
        await storage.delete(key);
        return null;
      }
      if (pending.expiresAt <= now || pending.attempts >= 8) {
        await storage.put(FAILED + pending.eventId, {
          ...pending,
          failedAt: now,
        });
        await storage.delete(key);
        const row = checkedNativeTelegram(
          await storage.get(NATIVE_TELEGRAM_KEY),
        );
        if (same && row) {
          if (row.status !== "disconnected")
            await storage.put(NATIVE_TELEGRAM_KEY, {
              ...row,
              status: "paused",
            });
          await appendAudit(
            storage,
            {
              actor: row.createdBy,
              action: "support.settings",
              after: { op: "telegram.failed", approvalId: row.approvalId },
            },
            now,
          );
        }
        return null;
      }
      if (!(await enabled(env, storage))) return null;
      const authorized =
        same &&
        current &&
        (pending.op === "prepare"
          ? current.status === "preparing" &&
            (await nativeTelegramCreatorCurrent(storage, current, env))
          : current.relayPrincipalId &&
            (await nativeTelegramApproved(
              storage,
              env,
              current as NativeTelegramRecord & { relayPrincipalId: string },
            )));
      if (pending.op !== "disconnect" && !authorized) {
        await storage.delete(key);
        return null;
      }
      if (pending.op === "handoff") {
        const conversation = await storage.get<TeamConversationRecord>(
          `conversation-v1:${pending.conversationId}`,
        );
        if (
          !conversation ||
          conversation.room !== `room:${pending.scope.workspaceId}` ||
          conversation.deleting ||
          conversation.stopped ||
          conversation.handoff?.at !== pending.handoffAt
        ) {
          await storage.delete(key);
          return null;
        }
      }
      const leased = {
        ...pending,
        attempts: pending.attempts + 1,
        dueAt:
          now +
          Math.min(3_600_000, 30_000 * 2 ** Math.min(pending.attempts, 7)),
      };
      await storage.put(key, leased);
      return leased;
    });
    if (!job) continue;
    try {
      const bridge = env.NATIVE_TELEGRAM_BRIDGE!;
      const preparation = {
        workspaceId: job.scope.workspaceId,
        approvalId: job.scope.approvalId,
      };
      const scoped: NativeTelegramGrant = {
        ...job.scope,
        relayPrincipalId: job.scope.relayPrincipalId!,
      };
      if (job.op === "disconnect" && !job.scope.relayPrincipalId) {
        // An interrupted prepare may have committed remotely before its local response.
        const prepared = await bridge.prepare(preparation);
        const principal = normalizeChatPrincipal(prepared.relayPrincipalId);
        if (!principal || !/^0x[a-f0-9]{40}$/.test(principal))
          throw unavailable();
        scoped.relayPrincipalId = principal;
      }
      const result =
        job.op === "prepare"
          ? await bridge.prepare(preparation)
          : job.op === "rotate-relay"
            ? await bridge.rotateRelay({
                ...scoped,
                previousRelayPrincipalId:
                  job.rotation!.previousRelayPrincipalId,
                ...(job.rotation!.previousRelayNonce
                  ? { previousRelayNonce: job.rotation!.previousRelayNonce }
                  : {}),
                bindingDigest: job.rotation!.bindingDigest,
              })
            : job.op === "approve"
              ? await bridge.approve(scoped)
              : job.op === "disconnect"
                ? await bridge.disconnect({
                    ...scoped,
                    ...(job.rotation
                      ? {
                          previousRelayPrincipalId:
                            job.rotation.previousRelayPrincipalId,
                          ...(job.rotation.previousRelayNonce
                            ? {
                                previousRelayNonce:
                                  job.rotation.previousRelayNonce,
                              }
                            : {}),
                          bindingDigest: job.rotation.bindingDigest,
                        }
                      : {}),
                  })
                : await bridge.handoff({
                    ...scoped,
                    conversationId: job.conversationId!,
                    eventId: job.eventId,
                    handoffAt: new Date(job.handoffAt!).toISOString(),
                  });
      await state.storage.transaction(async (storage) => {
        const pending = await storage.get<Job>(key);
        if (!pending || pending.attempts !== job.attempts) return;
        const row = checkedNativeTelegram(
          await storage.get(NATIVE_TELEGRAM_KEY),
        );
        if (
          row?.approvalId === job.scope.approvalId &&
          row.workspaceId === job.scope.workspaceId &&
          row.relayPrincipalId === job.scope.relayPrincipalId &&
          row.relayNonce === job.scope.relayNonce &&
          (await nativeTelegramCreatorCurrent(storage, row, env))
        ) {
          if (job.op === "prepare" && row.status === "preparing") {
            const prepared = result as Awaited<
              ReturnType<NativeTelegramBridge["prepare"]>
            >;
            const principal = normalizeChatPrincipal(prepared.relayPrincipalId);
            if (
              !principal ||
              !/^0x[a-f0-9]{40}$/.test(principal) ||
              row.creatorAliases.includes(principal) ||
              principal === row.approvalOwner ||
              !/^[A-F0-9]{12}$/.test(prepared.code) ||
              !Number.isSafeInteger(prepared.expiresAt) ||
              prepared.expiresAt <= Date.now() ||
              prepared.expiresAt > Date.now() + 86_400_000
            )
              throw unavailable();
            const updated = checkedNativeTelegram({
              ...row,
              relayPrincipalId: principal,
              code: prepared.code,
              expiresAt: Math.min(row.expiresAt!, prepared.expiresAt),
              invite: prepared.invite,
              status: "pairing",
            });
            if (!updated) throw unavailable();
            await storage.put(NATIVE_TELEGRAM_KEY, updated);
          } else if (job.op === "approve" || job.op === "rotate-relay") {
            const status = result as Awaited<
              ReturnType<NativeTelegramBridge["approve"]>
            >;
            if (
              status.relayPrincipalId !== row.relayPrincipalId ||
              !status.linked ||
              !group(status.group) ||
              !row.relayPrincipalId ||
              !(await nativeTelegramApproved(
                storage,
                env,
                row as NativeTelegramRecord & { relayPrincipalId: string },
              ))
            )
              throw unavailable();
            const updated = {
              ...row,
              status: "active" as const,
              group: group(status.group),
            };
            delete updated.relayRotation;
            await storage.put(NATIVE_TELEGRAM_KEY, updated);
          }
        }
        if (
          job.op === "handoff" &&
          (result as { queued?: boolean }).queued !== true
        )
          throw unavailable();
        await storage.delete(key);
      });
    } catch {
      console.error(
        JSON.stringify({
          event: "TEMPL_SUPPORT_FAILURE",
          route: "native-telegram",
          reason: "delivery",
        }),
      );
    }
  }
  const remaining = await state.storage.list<Job>({
    prefix: OUTBOX,
    limit: QUEUE_LIMIT,
  });
  for (const job of remaining.values())
    next = Math.min(
      next,
      job.expiresAt,
      job.dueAt > now ? job.dueAt : now + 60_000,
    );
  return Number.isFinite(next) ? next : null;
}
