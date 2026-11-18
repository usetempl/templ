import type {
  ChatPrincipalId,
  ChatVisibility,
  NativeRoom,
} from "@templ/chat/index";
import { HttpError, json, randomToken } from "./common";
import { servicePrincipals, aliasValues } from "./service-principals";
import { PRIVATE_INVITE_ADMISSION_LIMITS } from "@templ/chat/plans";

type Storage = DurableObjectTransaction;
export type RoomPrivacy = { visibility: ChatVisibility; initialized: boolean };
export type Invitation = {
  id: string;
  createdAt: string;
  revokedAt: string | null;
};
type StoredInvitation = Invitation & { digest: string };
export const MAX_ROOM_INVITATIONS = 128;
export const MAX_ACTIVE_ROOM_INVITATIONS = 8;
const INVITE_ADMISSIONS_KEY = "private-invite-admissions-v1";
const MINUTE_MS = 60_000;
const WINDOW_MINUTES = PRIVATE_INVITE_ADMISSION_LIMITS.windowMinutes;
type InviteAdmissionWindow = {
  minutes: { minute: number; count: number }[];
};

export function visibility(value: unknown): ChatVisibility {
  if (value !== "public" && value !== "private")
    throw new HttpError(400, "Choose Public or Private.");
  return value;
}

export async function roomPrivacy(
  storage: Storage,
  native?: NativeRoom,
): Promise<RoomPrivacy> {
  const saved = await storage.get<{ visibility: ChatVisibility }>(
    "room-privacy",
  );
  if (saved) {
    if (saved.visibility !== "public" && saved.visibility !== "private")
      throw new HttpError(503, "Chat privacy could not be verified.");
    return { visibility: saved.visibility, initialized: true };
  }
  if (native) {
    if (native.visibility !== "public" && native.visibility !== "private")
      throw new HttpError(503, "Chat privacy could not be verified.");
    return { visibility: native.visibility, initialized: true };
  }
  throw new HttpError(404, "Chat not found.");
}

export async function privacyStatus(
  storage: Storage,
  policy: RoomPrivacy,
  actor: ChatPrincipalId | null,
  isManager: boolean,
  aliases?: ChatPrincipalId[],
) {
  const identities = servicePrincipals(actor, aliases);
  const isMember = Boolean(
    actor &&
    (isManager ||
      (await aliasValues(storage, "room-member:", identities)).some(Boolean)),
  );
  return {
    ...policy,
    isMember,
    canRead: policy.initialized && (policy.visibility === "public" || isMember),
  };
}

export function requireRoomAccess(
  status: Awaited<ReturnType<typeof privacyStatus>>,
) {
  if (!status.canRead) throw new HttpError(404, "Chat not found.");
}

export async function admitRoomMember(
  storage: Storage,
  actor: ChatPrincipalId,
  invitationId: string | null,
) {
  if (await storage.get(`room-member:${actor}`)) return;
  await storage.put(`room-member:${actor}`, {
    joinedAt: new Date().toISOString(),
    invitationId,
  });
}

/** The room transaction owns this counter. Minute buckets conservatively
 * retain an admission for up to one minute beyond its rolling hour. */
export async function admitPrivateInvitationMember(
  storage: Storage,
  actor: ChatPrincipalId,
  invitationId: string,
  now = Date.now(),
) {
  const saved = await storage.get<InviteAdmissionWindow>(INVITE_ADMISSIONS_KEY);
  if (
    saved !== undefined &&
    (!saved ||
      !Array.isArray(saved.minutes) ||
      saved.minutes.length > WINDOW_MINUTES + 1 ||
      saved.minutes.some(
        (item) =>
          !item ||
          !Number.isSafeInteger(item.minute) ||
          item.minute < 0 ||
          !Number.isSafeInteger(item.count) ||
          item.count < 1 ||
          item.count > PRIVATE_INVITE_ADMISSION_LIMITS.newMembersPerHour,
      ) ||
      new Set(saved.minutes.map((item) => item.minute)).size !==
        saved.minutes.length)
  )
    throw new HttpError(
      503,
      "Invitation admission is temporarily unavailable.",
    );
  const minute = Math.floor(now / MINUTE_MS);
  const minutes = (saved?.minutes ?? []).filter(
    (item) => item.minute >= minute - WINDOW_MINUTES,
  );
  if (minutes.some((item) => item.minute > minute))
    throw new HttpError(
      503,
      "Invitation admission is temporarily unavailable.",
    );
  const admitted = minutes.reduce((sum, item) => sum + item.count, 0);
  if (admitted >= PRIVATE_INVITE_ADMISSION_LIMITS.newMembersPerHour) {
    const oldest = Math.min(...minutes.map((item) => item.minute));
    const retryAfter = Math.max(
      1,
      Math.ceil(((oldest + WINDOW_MINUTES + 1) * MINUTE_MS - now) / 1_000),
    );
    throw new HttpError(
      429,
      "This chat has reached its hourly invitation limit. Try again later.",
      retryAfter,
    );
  }
  const current = minutes.find((item) => item.minute === minute);
  if (current) current.count++;
  else minutes.push({ minute, count: 1 });
  await storage.put(INVITE_ADMISSIONS_KEY, { minutes });
  await admitRoomMember(storage, actor, invitationId);
}

const unavailable = () =>
  new HttpError(404, "Invitation not found or no longer available.");
const publicInvitation = ({
  id,
  createdAt,
  revokedAt,
}: StoredInvitation): Invitation => ({ id, createdAt, revokedAt });
async function digest(secret: unknown) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    throw unavailable();
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Every operation runs in the authoritative room's transaction. Link revocation
 * affects later redemptions only; membership never substitutes for a channel role. */
export async function roomPrivacyRequest(
  storage: Storage,
  body: Record<string, unknown>,
  context: {
    policy: RoomPrivacy;
    actor: ChatPrincipalId | null;
    isManager: boolean;
    servicePrincipals?: ChatPrincipalId[];
  },
) {
  const { policy, actor, isManager } = context;
  const status = await privacyStatus(
    storage,
    policy,
    actor,
    isManager,
    context.servicePrincipals,
  );
  if (body.op === "status") return json(status);
  if (!policy.initialized) throw new HttpError(404, "Chat not found.");
  if (body.op === "invite-preview" || body.op === "invite-redeem") {
    const key = `room-invite-secret:${await digest(body.secret)}`;
    const id = await storage.get<string>(key);
    const invite = id
      ? await storage.get<StoredInvitation>(`room-invite:${id}`)
      : undefined;
    if (!invite || invite.revokedAt) throw unavailable();
    if (body.op === "invite-preview") return json({ valid: true });
    if (!actor) throw new HttpError(401, "Sign in to accept this invitation.");
    if (!status.isMember) {
      if (policy.visibility === "private")
        await admitPrivateInvitationMember(storage, actor, invite.id);
      else await admitRoomMember(storage, actor, invite.id);
    }
    return json({ ok: true, isMember: true });
  }
  if (!actor) throw new HttpError(401, "Sign in to manage invitations.");
  if (!isManager)
    throw new HttpError(403, "Only the manager can manage invitations.");
  if (body.op === "invite-list") {
    const entries = await storage.list<StoredInvitation>({
      prefix: "room-invite:",
      limit: MAX_ROOM_INVITATIONS,
    });
    return json({ invitations: [...entries.values()].map(publicInvitation) });
  }
  if (body.op === "invite-create") {
    const entries = await storage.list<StoredInvitation>({
      prefix: "room-invite:",
      limit: MAX_ROOM_INVITATIONS,
    });
    if (
      [...entries.values()].filter((value) => !value.revokedAt).length >=
      MAX_ACTIVE_ROOM_INVITATIONS
    )
      throw new HttpError(
        409,
        "This chat has reached its invitation limit. Revoke an active link first.",
      );
    if (entries.size >= MAX_ROOM_INVITATIONS) {
      const oldest = [...entries.values()]
        .filter((value) => value.revokedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) await storage.delete(`room-invite:${oldest.id}`);
    }
    const secret = randomToken();
    const invite: StoredInvitation = {
      id: crypto.randomUUID(),
      digest: await digest(secret),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    await storage.put(`room-invite:${invite.id}`, invite);
    await storage.put(`room-invite-secret:${invite.digest}`, invite.id);
    return json({ invitation: publicInvitation(invite), secret }, 201);
  }
  if (body.op === "invite-revoke") {
    if (
      typeof body.inviteId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        body.inviteId,
      )
    )
      throw unavailable();
    const key = `room-invite:${body.inviteId}`;
    const invite = await storage.get<StoredInvitation>(key);
    if (!invite) throw unavailable();
    if (!invite.revokedAt) {
      invite.revokedAt = new Date().toISOString();
      await storage.put(key, invite);
      await storage.delete(`room-invite-secret:${invite.digest}`);
    }
    return json({ ok: true });
  }
  throw new HttpError(404, "Not found.");
}
