import type {
  ChatPrincipalId,
  ChatRole,
  ChatRoleTerms,
} from "@templ/chat/index";
import { SUPPORT_TEAM_ROLES, standardTeamRole } from "@templ/chat/team-roles";
import type { TeamInvitation, TeamInviteRole } from "@templ/chat/team-invite";
import { markWorkspaceStep } from "./funnel-metrics";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { HttpError, json, randomToken, sha256Hex } from "./common";
import type { PendingAudit } from "./room-audit";
import {
  AUTHENTICATED_AT_HEADER,
  AUTH_METHOD_HEADER,
  requireTeamInvitationAuth,
  requireWorkspaceAdminHeaders,
} from "./privileged-auth";
import type { AuthMethod } from "@templ/chat/principal";
import { aliasValues, servicePrincipals } from "./service-principals";
import { currentHumanAdmin } from "./workspace-admin";
import { requireSafetyAccess, type SafetyEnv } from "./safety";
import { templStaffAccount, type TemplStaffEnv } from "./templ-staff";
import {
  admitPrivateInvitationMember,
  admitRoomMember,
  privacyStatus,
  type RoomPrivacy,
} from "./room-privacy";

type Storage = DurableObjectTransaction;
type ManualRole = Extract<ChatRoleTerms, { mode: "manual" }>;
type StoredInvite = Omit<TeamInvitation, "status"> & {
  digest: string;
  manager: ChatPrincipalId;
  roleRevision: number;
  permissions: string[];
  revokedAt: string | null;
  usedBy: ChatPrincipalId | null;
  emailKey?: string;
  requestId?: string;
  createdBy?: ChatPrincipalId;
  creatorAliases?: ChatPrincipalId[];
};
const PREFIX = "team-invite-v1:";
const ADMIN_PREFIX = "team-admin-invite-v1:";
const HASH_PREFIX = "team-invite-hash-v1:";
export const TEAM_INVITE_LIMIT = 128;
export const TEAM_INVITE_ACTIVE_LIMIT = 8;
export const TEAM_INVITE_EMAIL_KEY_HEADER = "X-Verified-Team-Email-Key";
const ROLE_PERMISSIONS = {
  "support-member": SUPPORT_TEAM_ROLES["support-member"].permissions,
  "support-lead": SUPPORT_TEAM_ROLES["support-lead"].permissions,
  "support-admin": SUPPORT_TEAM_ROLES["support-admin"].permissions,
} as const;
const unavailable = () =>
  new HttpError(
    404,
    "This team link is no longer available. Ask the workspace manager for a new link.",
  );
function storedInvite(value: unknown, id?: string): StoredInvite {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  const invite = value as StoredInvite;
  const createdAt =
    typeof invite.createdAt === "string" ? Date.parse(invite.createdAt) : NaN;
  const timestamp = (at: unknown) =>
    typeof at === "string" &&
    Number.isFinite(Date.parse(at)) &&
    new Date(Date.parse(at)).toISOString() === at;
  if (invite.createdBy !== undefined) {
    try { servicePrincipals(invite.createdBy, invite.creatorAliases); }
    catch { throw unavailable(); }
  } else if (invite.creatorAliases !== undefined) throw unavailable();
  if (
    (invite.createdBy !== undefined && (normalizeChatPrincipal(invite.createdBy) !== invite.createdBy ||
      !Array.isArray(invite.creatorAliases))) ||
    typeof invite.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      invite.id,
    ) ||
    (id !== undefined && invite.id !== id) ||
    !Object.hasOwn(ROLE_PERMISSIONS, invite.roleId) ||
    typeof invite.roleName !== "string" ||
    !invite.roleName.trim() ||
    !timestamp(invite.createdAt) ||
    !Number.isSafeInteger(invite.expiresAt) ||
    invite.expiresAt <= createdAt ||
    invite.expiresAt > createdAt + 168 * 3_600_000 ||
    typeof invite.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(invite.digest) ||
    typeof invite.manager !== "string" ||
    normalizeChatPrincipal(invite.manager) !== invite.manager ||
    !Number.isSafeInteger(invite.roleRevision) ||
    invite.roleRevision < 1 ||
    !Array.isArray(invite.permissions) ||
    invite.permissions.some((permission) => typeof permission !== "string") ||
    !(invite.revokedAt === null || timestamp(invite.revokedAt)) ||
    !(
      invite.usedBy === null ||
      normalizeChatPrincipal(invite.usedBy) === invite.usedBy
    )
  )
    throw unavailable();
  if (
    (invite.emailKey !== undefined ||
      invite.requestId !== undefined ||
      invite.emailTargeted !== undefined ||
      invite.recipient !== undefined) &&
    (typeof invite.emailKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(invite.emailKey) ||
      typeof invite.requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        invite.requestId,
      ) ||
      invite.emailTargeted !== true ||
      typeof invite.recipient !== "string" ||
      invite.recipient.length > 254 ||
      !/^.[*]{3}@[^@]+$/.test(invite.recipient))
  )
    throw unavailable();
  return invite;
}
function publicInvite(invite: StoredInvite, now: number): TeamInvitation {
  storedInvite(invite);
  return {
    id: invite.id,
    roleId: invite.roleId,
    roleName: invite.roleName,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    ...(invite.emailTargeted
      ? { emailTargeted: true as const, recipient: invite.recipient }
      : {}),
    status: invite.revokedAt
      ? "revoked"
      : invite.usedBy
        ? "used"
        : invite.expiresAt <= now
          ? "expired"
          : "active",
  };
}
const inviteKey = (invite: StoredInvite) =>
  `${invite.roleId === "support-admin" || (invite.createdBy && invite.createdBy !== invite.manager) ? ADMIN_PREFIX : PREFIX}${invite.id}`;
async function readInvite(storage: Storage, id: string): Promise<StoredInvite> {
  const [owner, delegated] = await Promise.all([
    storage.get<unknown>(PREFIX + id), storage.get<unknown>(ADMIN_PREFIX + id),
  ]);
  if (owner !== undefined && delegated !== undefined) throw unavailable();
  const invite = storedInvite(owner ?? delegated, id);
  if (inviteKey(invite) !== `${owner !== undefined ? PREFIX : ADMIN_PREFIX}${id}`) throw unavailable();
  return invite;
}
async function listInvites(storage: Storage): Promise<Map<string, StoredInvite>> {
  const sources = await Promise.all([PREFIX, ADMIN_PREFIX].map(prefix =>
    storage.list<unknown>({ prefix, limit: TEAM_INVITE_LIMIT })));
  const entries = new Map<string, StoredInvite>();
  for (const source of sources) for (const [key, value] of source) {
    const invite = storedInvite(value);
    if (key !== inviteKey(invite) || entries.has(invite.id)) throw unavailable();
    entries.set(invite.id, invite);
  }
  return entries;
}
function checkedRole(context: TeamInviteContext, roleId: unknown) {
  if (typeof roleId !== "string" || !Object.hasOwn(ROLE_PERMISSIONS, roleId))
    throw new HttpError(400, "Choose Team, Support lead or Admin.");
  const id = roleId as TeamInviteRole;
  const role = context.roles.find((entry) => entry.id === id);
  const terms = context.manualRoles[id];
  const expected = ROLE_PERMISSIONS[id];
  const permissions = role?.moderationPermissions ?? [];
  if (
    !role ||
    !terms ||
    terms.mode !== "manual" ||
    terms.enabled === false ||
    permissions.length !== expected.length ||
    !expected.every((permission) => permissions.includes(permission))
  )
    throw new HttpError(
      409,
      "This team role changed. Ask the manager to check its powers before making a new link.",
    );
  return { role, terms, permissions: [...permissions].sort() };
}
async function tokenDigest(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw unavailable();
  return sha256Hex(value);
}
export type TeamInviteContext = {
  actor: ChatPrincipalId | null;
  aliases: ChatPrincipalId[];
  manager: ChatPrincipalId;
  isManager: boolean;
  admin?: boolean;
  roles: Pick<ChatRole, "id" | "name" | "moderationPermissions">[];
  manualRoles: Record<string, ManualRole>;
  bots: ChatPrincipalId[];
  policy: RoomPrivacy;
  headers: Headers;
  env: TemplStaffEnv;
  pendingAudit: PendingAudit[];
  reserveRoomGrowth: () => Promise<void>;
  onAssigned: (roleId: TeamInviteRole) => void;
};

/** Called inside the authoritative room transaction, before membership access.
 * Consuming the hash, admission, role grant and audit commit together. */
export async function teamInviteRequest(
  storage: Storage,
  body: Record<string, unknown>,
  context: TeamInviteContext,
  now = Date.now(),
) {
  const { actor, aliases, pendingAudit } = context;
  if (!actor) throw new HttpError(401, "Sign in to use this team link.");
  if (!context.policy.initialized) throw unavailable();
  const emailAccepting = body.op === "accept-email";
  const accepting =
    body.op === "check" || body.op === "accept" || emailAccepting;
  if (!accepting && !context.admin && !context.isManager)
    throw new HttpError(
      403,
      "Only workspace admins can manage team links.",
    );
  if (body.op === "list") {
    const entries = await listInvites(storage);
    return json({
      invitations: [...entries.values()].map((invite) =>
        publicInvite(invite, now),
      ),
    });
  }
  if (accepting)
    requireTeamInvitationAuth(
      {
        authenticatedAt: Number(context.headers.get(AUTHENTICATED_AT_HEADER)),
        authMethod: context.headers.get(AUTH_METHOD_HEADER) as AuthMethod,
      },
      body.confirmed,
      now,
    );
  else requireWorkspaceAdminHeaders(context.headers, context.isManager, body.confirmed, now);
  if (await templStaffAccount(storage, aliases, context.env))
    throw new HttpError(
      403,
      "Team links cannot grant Templ staff access. Ask the manager to add that account directly.",
    );
  if (body.op === "create") {
    const { role, terms, permissions } = checkedRole(context, body.roleId);
    const hours = body.expiresInHours;
    if (
      !Number.isInteger(hours) ||
      (hours as number) < 1 ||
      (hours as number) > 168
    )
      throw new HttpError(400, "Choose an expiry from 1 to 168 hours.");
    const entries = await listInvites(storage);
    const targeted = body.emailKey !== undefined;
    if (targeted) {
      if (
        typeof body.emailKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.emailKey) ||
        typeof body.requestId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          body.requestId,
        ) ||
        typeof body.recipient !== "string" ||
        body.recipient.length > 254 ||
        !/^.[*]{3}@[^@]+$/.test(body.recipient)
      )
        throw new HttpError(400, "Check the invitation email.");
      const previous = [...entries.values()].find(
        (invite) => invite.requestId === body.requestId,
      );
      if (previous) {
        storedInvite(previous);
        if (
          previous.manager !== context.manager ||
          (previous.createdBy ?? previous.manager) !== (context.isManager ? context.manager : actor) ||
          previous.emailKey !== body.emailKey ||
          previous.recipient !== body.recipient ||
          previous.roleId !== role.id ||
          previous.roleRevision !== terms.revision ||
          previous.roleName !== role.name ||
          JSON.stringify(previous.permissions) !==
            JSON.stringify(permissions) ||
          previous.expiresAt - Date.parse(previous.createdAt) !==
            (hours as number) * 3_600_000 ||
          publicInvite(previous, now).status !== "active"
        )
          throw new HttpError(
            409,
            "This invitation changed. Create a new invitation.",
          );
        return json({ invitation: publicInvite(previous, now) }, 201);
      }
    } else if (body.requestId !== undefined || body.recipient !== undefined)
      throw new HttpError(400, "Choose only the team link settings.");
    if (
      [...entries.values()].filter(
        (invite) => publicInvite(invite, now).status === "active",
      ).length >= TEAM_INVITE_ACTIVE_LIMIT
    )
      throw new HttpError(
        409,
        "Revoke an active team link before making another.",
      );
    await context.reserveRoomGrowth();
    while (entries.size >= TEAM_INVITE_LIMIT) {
      const oldest = [...entries.values()]
        .filter((invite) => publicInvite(invite, now).status !== "active")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!oldest)
        throw new HttpError(
          409,
          "Revoke an active team link before making another.",
        );
      await storage.delete(inviteKey(oldest));
      await storage.delete(HASH_PREFIX + oldest.digest);
      entries.delete(oldest.id);
    }
    const token = randomToken();
    const invite: StoredInvite = {
      id: crypto.randomUUID(),
      roleId: role.id as TeamInviteRole,
      roleName: role.name,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + (hours as number) * 3_600_000,
      digest: await sha256Hex(token),
      manager: context.manager,
      createdBy: context.isManager ? context.manager : actor,
      creatorAliases: context.isManager ? [context.manager] : aliases,
      roleRevision: terms.revision,
      permissions,
      revokedAt: null,
      usedBy: null,
      ...(targeted
        ? {
            emailTargeted: true as const,
            emailKey: body.emailKey as string,
            recipient: body.recipient as string,
            requestId: body.requestId as string,
          }
        : {}),
    };
    await storage.put({
      [inviteKey(invite)]: invite,
      ...(!targeted ? { [HASH_PREFIX + invite.digest]: invite.id } : {}),
    });
    pendingAudit.push({
      actor,
      action: "team-invite.create",
      after: {
        inviteId: invite.id,
        roleId: invite.roleId,
        expiresAt: invite.expiresAt,
      },
    });
    await markWorkspaceStep(storage, "team_invite_created", now);
    return json(
      {
        invitation: publicInvite(invite, now),
        ...(!targeted ? { token } : {}),
      },
      201,
    );
  }
  if (body.op === "revoke") {
    if (
      typeof body.inviteId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.inviteId)
    )
      throw unavailable();
    const invite = await readInvite(storage, body.inviteId);
    if (!invite.revokedAt) {
      invite.revokedAt = new Date(now).toISOString();
      await storage.put(inviteKey(invite), invite);
      await storage.delete(HASH_PREFIX + invite.digest);
      pendingAudit.push({
        actor,
        action: "team-invite.revoke",
        after: { inviteId: invite.id, roleId: invite.roleId },
      });
    }
    return json({ ok: true });
  }
  if (accepting) {
    const digest = emailAccepting ? null : await tokenDigest(body.token);
    const id = emailAccepting
      ? typeof body.inviteId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          body.inviteId,
        )
        ? body.inviteId
        : undefined
      : await storage.get<string>(HASH_PREFIX + digest);
    if (!id) throw unavailable();
    const invite = await readInvite(storage, id);
    const repeatedEmail = emailAccepting && invite.usedBy === actor;
    if (invite.createdBy && invite.createdBy !== context.manager) {
      if (!(await currentHumanAdmin(storage, invite.createdBy, invite.creatorAliases, context.env)))
        throw unavailable();
      // The caller already passed room Safety. Recheck the delegated creator's identities.
      try {
        await requireSafetyAccess(context.env as SafetyEnv, null, invite.createdBy,
          servicePrincipals(invite.createdBy, invite.creatorAliases));
      } catch (error) {
        if (error instanceof HttpError && error.status === 403 && !emailAccepting) throw unavailable();
        throw error;
      }
    }
    if (
      invite.manager !== context.manager ||
      invite.revokedAt ||
      invite.expiresAt <= now ||
      (invite.usedBy !== null && !repeatedEmail) ||
      (emailAccepting
        ? !invite.emailTargeted ||
          !actor.startsWith("account:") ||
          context.headers.get(AUTH_METHOD_HEADER) !== "email" ||
          context.headers.get(TEAM_INVITE_EMAIL_KEY_HEADER) !== invite.emailKey
        : invite.emailTargeted || invite.digest !== digest)
    )
      throw unavailable();
    if (await templStaffAccount(storage, [context.manager], context.env))
      throw unavailable();
    const { role, terms, permissions } = checkedRole(context, invite.roleId);
    if (
      terms.revision !== invite.roleRevision ||
      role.name !== invite.roleName ||
      JSON.stringify(permissions) !== JSON.stringify(invite.permissions)
    )
      throw unavailable();
    if (
      aliases.includes(context.manager) ||
      context.bots.some((id) => aliases.includes(id))
    )
      throw new HttpError(
        403,
        "Use a teammate's account. Team links cannot change manager or AI agent access.",
      );
    if ((await aliasValues(storage, "ban:", aliases)).some(Boolean))
      throw new HttpError(403, "This account cannot join the workspace.");
    const held = (
      await aliasValues<string[]>(storage, "roles:", aliases)
    ).flatMap((value) => value ?? []);
    // Unknown assignments may carry powers, so a link never removes or combines them.
    const adminPromotion = invite.roleId === "support-admin" && held.every((id) =>
      ["support-member", "support-lead", "support-admin"].includes(id) &&
      context.roles.some((role) => role.id === id && standardTeamRole(role)) &&
      context.manualRoles[id]?.mode === "manual" && context.manualRoles[id]?.enabled !== false);
    if (held.some((id) => id !== invite.roleId) && !adminPromotion)
      throw new HttpError(
        409,
        "This account already has another role. Ask the manager to change its access directly.",
      );
    const preview = {
      roleId: invite.roleId,
      roleName: invite.roleName,
      expiresAt: invite.expiresAt,
    };
    if (body.op === "check") return json(preview);
    if (repeatedEmail) return json({ ok: true, ...preview });
    await context.reserveRoomGrowth();
    const membership = await privacyStatus(
      storage,
      context.policy,
      actor,
      false,
      aliases,
    );
    if (!membership.isMember) {
      if (context.policy.visibility === "private")
        await admitPrivateInvitationMember(storage, actor, invite.id, now);
      else await admitRoomMember(storage, actor, invite.id);
    }
    await storage.put(`roles:${actor}`, [invite.roleId]);
    invite.usedBy = actor;
    await storage.put(inviteKey(invite), invite);
    if (digest !== null) await storage.delete(HASH_PREFIX + digest);
    await markWorkspaceStep(storage, "team_invite_accepted", now);
    pendingAudit.push(
      {
        actor,
        action: "team-invite.redeem",
        after: { inviteId: invite.id, roleId: invite.roleId },
      },
      {
        actor,
        action: "role.assign",
        target: actor,
        after: { roleId: invite.roleId, granted: true, inviteId: invite.id },
      },
    );
    context.onAssigned(invite.roleId);
    return json({ ok: true, ...preview });
  }
  throw new HttpError(404, "Not found.");
}
