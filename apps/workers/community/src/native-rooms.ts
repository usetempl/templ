import { requireConnectDeadline } from "./connect-deadline";
import { revokeEncryptionPrincipal } from "./support-encryption-access";
import { finalizeStorageManagerTransfer, type StorageBillingEnv } from "./brain-storage-billing";
import type { WorkspaceFeatures } from "@templ/chat/workspace-flags";
import { requireWalletAuth } from "./privileged-auth";
import type { AuthMethod } from "@templ/chat/principal";
import {
  trialOperatorPrincipal,
  type OperatorAdminEnv,
} from "./operator-admin";
import {
  deletionCatalogRequest,
  deletionReadField,
  refuseManagerChangeWhileClosing,
} from "./workspace-deletion";
import {
  consistentPermissionGrant,
  MODERATOR_PERMISSIONS,
  type ChatRole,
  type ModeratorPermission,
  type NativeRoom,
} from "@templ/chat/index";
import { keccak256, toHex } from "viem";
import { HttpError, json } from "./common";
import { requestPrefetch, started, timed } from "./request-context";
import { principal } from "./principal";
import { visibility, admitRoomMember } from "./room-privacy";
import { initializeProducts, readProductState, productFunded, productMode, standardPlanForState } from "./product-entitlements";
import { markWorkspaceStep } from "./funnel-metrics";
import { WORKSPACE_ONBOARDING } from "./onboarding-metrics";
import {
  JOURNEY_ID,
  ONBOARDING_TRAFFIC,
  ONBOARDING_POLICY,
} from "@templ/chat/onboarding";
import { accentColor } from "./room-appearance";
import { profileMediaHash } from "@templ/chat/profiles";
import type { WorkspaceSupportProfiles } from "@templ/chat/support";
import { isSupportContactRole, readSupportProfiles, saveSupportProfile } from "./support-contact-profiles";
import { servicePrincipals, actsAs } from "./service-principals";
import { NATIVE_ROOM_PILOT_LIMIT } from "./native-room-limits";
import { aiPrincipals, botsFromSettings, requireHumanManager } from "./bots";
import { readAiDefault } from "./support-ai-mode";
import { supportSettings } from "./support-workflow";
import { workspaceFeatureSnapshot } from "./workspace-feature-values";

export const WORKSPACE_FEATURES_HEADER = "X-Templ-Workspace-Features";

export const NATIVE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const NATIVE_CATALOG = "native-room-catalog:v1";
export const NATIVE_CREATIONS_PER_DAY = 200;
export const NATIVE_ROOMS_PER_CREATOR = 1000;
export const NATIVE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
export const RESERVED_NATIVE_SLUGS = new Set([
  "admin",
  "agents",
  // The member reply-email page.
  "alerts",
  "api",
  "billing",
  "chat",
  "community",
  // Reserved so a /contact link never opens a workspace.
  "contact",
  "create",
  "connect",
  // The Data Processing Agreement page.
  "dpa",
  "explore",
  "feedback",
  "preview",
  "privacy",
  "rooms",
  "safety",
  "settings",
  // The public status page.
  "status",
  "terms",
]);
/** The staff roles a new workspace starts with. */
export type NativeSetup = {
  roles: {
    id: string;
    name: string;
    mode: "manual";
    moderationPermissions?: ModeratorPermission[];
  }[];
};
export type NativeCreation = {
  room: NativeRoom;
  setup: NativeSetup;
  requestHash: string;
  trialOperator?: `0x${string}`;
};
export type NativeRoomRecord = NativeCreation & {
  revision: number;
  selfServeSupportSetup?: true;
  trialAiOnboarding?: true;
  trialCreator?: `0x${string}`;
  supportProfiles?: WorkspaceSupportProfiles;
  supportResponderConfigured?: boolean;
  aiReplyExpected?: boolean;
};
export const NATIVE_ROOM_SCHEMA_ERROR = "Workspace metadata is unavailable.";
/** The creator uses a wallet session to grant a trial operator its marker. */
export function requireTrialWorkspaceCreation(
  body: Record<string, unknown>,
  env: OperatorAdminEnv,
  session: { authenticatedAt?: number; authMethod?: AuthMethod },
) {
  if (body.trialOperator === undefined) return;
  if (!trialOperatorPrincipal(env, body.trialOperator))
    throw new HttpError(400, "Choose the listed trial operator.");
  requireWalletAuth(session, true);
}
/** Validate stored metadata before projecting the workspace's public fields.
 * Extra fields grant no authority. Every response uses `publicNativeRoom`. */
function currentRoom(value: unknown): value is NativeRoom {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const room = value as Record<string, unknown>;
  return (
    (room.visibility === "public" || room.visibility === "private") &&
    (room.listed === undefined || typeof room.listed === "boolean") &&
    !Object.prototype.hasOwnProperty.call(room, "accessContract") &&
    (room.accessContracts === undefined || Array.isArray(room.accessContracts))
  );
}
/** Public workspace metadata contains only these fields. */
export function publicNativeRoom(room: NativeRoom): NativeRoom {
  return {
    id: room.id,
    slug: room.slug,
    ...(room.hostedName === true ? { hostedName: true } : {}),
    name: room.name,
    image: room.image,
    creator: room.creator,
    manager: room.manager,
    pendingManager: room.pendingManager,
    visibility: room.visibility,
    ...(room.accentColor === undefined
      ? {}
      : { accentColor: room.accentColor }),
    createdAt: room.createdAt,
  };
}
const recordView = (record: NativeRoomRecord): NativeRoomRecord => ({
  ...record,
  room: publicNativeRoom(record.room),
});
function requireCurrentRoom(value: unknown): NativeRoom {
  if (!currentRoom(value)) throw new HttpError(503, NATIVE_ROOM_SCHEMA_ERROR);
  return value;
}
const roleId = /^[a-z0-9][a-z0-9-]{0,47}$/;
const invalid = (message: string) => new HttpError(400, message);
export function nativeRoomId(value: unknown): string {
  if (typeof value !== "string" || !NATIVE_UUID.test(value))
    throw invalid("Invalid workspace ID.");
  return value;
}
export function nativeSlug(value: unknown): string {
  if (typeof value !== "string") throw invalid("Choose a workspace slug.");
  const slug = value.trim().toLowerCase();
  if (!NATIVE_SLUG_PATTERN.test(slug) || RESERVED_NATIVE_SLUGS.has(slug))
    throw invalid("Use 3 to 32 lowercase letters, numbers or hyphens.");
  return slug;
}
const appRoutes = new Set(["analytics","availability","chief","example","flex","help","inbox","og","reply","support-entry","team-invite","trust","install","pricing"]);
/** Hosted names must resolve to the public chat, including names reserved by static Next routes. */
export function hostedName(value: unknown): string {
  const slug = nativeSlug(value);
  if (slug.length < 3 || appRoutes.has(slug))
    throw invalid("Choose another name with 3 to 32 letters, numbers or hyphens.");
  return slug;
}

type NameHold = { id: string; expiresAt: number };
async function nameHold(storage: DurableObjectTransaction, slug: string) {
  const hold = await storage.get<NameHold>(`native-name-hold-v1:${slug}`);
  return hold && hold.expiresAt > Date.now() ? hold : null;
}
export function nativeName(value: unknown, max = 80) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw invalid(`Use a name of 1 to ${max} characters.`);
  return value.trim();
}
export function nativeSetup(value: unknown): NativeSetup {
  if (value === undefined) return { roles: [] };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("Choose staff roles.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.roles) || input.roles.length > 32)
    throw invalid("Start with up to 32 staff roles.");
  if (Object.keys(input).some((key) => key !== "roles"))
    throw invalid("Send only staff roles for setup.");
  const roles = input.roles.map((value): NativeSetup["roles"][number] => {
    if (
      !value ||
      typeof value !== "object" ||
      value.mode !== "manual" ||
      typeof value.id !== "string" ||
      !roleId.test(value.id) ||
      ["token", "amountRaw", "priceRaw", "minBalanceRaw"].some(
        (field) => value[field] != null,
      )
    )
      throw invalid("Start with staff roles only.");
    const moderationPermissions = value.moderationPermissions;
    if (
      moderationPermissions !== undefined &&
      (!Array.isArray(moderationPermissions) ||
        moderationPermissions.length > MODERATOR_PERMISSIONS.length ||
        moderationPermissions.some(
          (permission) =>
            !MODERATOR_PERMISSIONS.includes(permission as ModeratorPermission),
        ) ||
        !consistentPermissionGrant(
          moderationPermissions as ModeratorPermission[],
        ))
    )
      throw invalid("Choose valid moderation powers.");
    return {
      id: value.id,
      name: nativeName(value.name, 48),
      mode: "manual",
      ...(moderationPermissions?.length
        ? {
            moderationPermissions: [
              ...new Set(moderationPermissions),
            ] as ModeratorPermission[],
          }
        : {}),
    };
  });
  if (new Set(roles.map((role) => role.id)).size !== roles.length)
    throw invalid("Role IDs must be unique.");
  return { roles };
}
export function nativeCreation(
  body: Record<string, unknown>,
  wallet: string,
  communityOrigin?: string,
): Omit<NativeCreation, "room"> & { room: Omit<NativeRoom, "createdAt"> } {
  const id = nativeRoomId(body.id),
    creator = principal(wallet);
  const name = nativeName(body.name),
    setup = nativeSetup(body.setup);
  let trialOperator: `0x${string}` | undefined;
  if (body.trialOperator !== undefined) {
    const operator = principal(body.trialOperator);
    if (!/^0x[0-9a-f]{40}$/.test(operator))
      throw invalid("Choose the trial operator wallet.");
    trialOperator = operator as `0x${string}`;
  }
  const selectedVisibility = visibility(body.visibility);
  let image: string | null = null;
  if (body.image != null) {
    if (selectedVisibility === "private")
      throw invalid("Private workspaces cannot use image uploads.");
    if (typeof body.image !== "string" || body.image.length > 2048)
      throw invalid("Choose a valid workspace image.");
    let url: URL;
    try {
      url = new URL(body.image);
    } catch {
      throw invalid("Choose a valid workspace image.");
    }
    if (!profileMediaHash(body.image, communityOrigin))
      throw invalid("Choose a valid workspace image.");
    image = url.href;
  }
  const room = {
    id,
    slug: null,
    name,
    image,
    creator,
    manager: creator,
    pendingManager: null,
    visibility: selectedVisibility,
    ...(body.accentColor === undefined
      ? {}
      : { accentColor: accentColor(body.accentColor) }),
  };
  return {
    room,
    setup,
    ...(trialOperator === undefined ? {} : { trialOperator }),
    requestHash: keccak256(
      toHex(
        JSON.stringify({
          room,
          setup,
          ...(trialOperator === undefined ? {} : { trialOperator }),
        }),
      ),
    ),
  };
}
export function nativeManualRole(
  id: string,
  enabled = true,
  revision = 1,
): Omit<ChatRole, "name"> {
  return { id, mode: "manual", revision, enabled };
}

/** Global bounded index/reservations. A room's own DO remains authoritative for
 * ownership and applies it atomically with messages/moderation. */
/** JSON with sorted keys, so two projections compare by content, not by the
 * order their fields were written in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item as Record<string, unknown>)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}

export async function nativeCatalogRequest(
  storage: DurableObjectTransaction,
  body: Record<string, unknown>,
  communityOrigin?: string,
) {
  if (body.op === "trial-capacity") {
    const aliases = servicePrincipals(
      principal(body.principalId),
      body.servicePrincipals,
    );
    const now = Date.now();
    let createdTotal = 0;
    let createdLast24Hours = 0;
    for (const id of aliases) {
      const count = await storage.get<number>(`native-count:${id}`);
      const times = await storage.get<number[]>(`native-rate:${id}`);
      if (
        (count !== undefined &&
          (!Number.isSafeInteger(count) ||
            count < 0 ||
            count > NATIVE_ROOM_PILOT_LIMIT)) ||
        (times !== undefined &&
          (!Array.isArray(times) ||
            times.length > NATIVE_ROOM_PILOT_LIMIT ||
            times.some(
              (time) => !Number.isSafeInteger(time) || time < 0 || time > now,
            ))) ||
        (count === undefined && times !== undefined) ||
        (count !== undefined && count > 0 && times === undefined) ||
        (times?.length ?? 0) > (count ?? 0)
      )
        throw invalid("Workspace capacity is unavailable.");
      createdTotal += count ?? 0;
      createdLast24Hours += (times ?? []).filter(
        (time) => time > now - 86_400_000,
      ).length;
    }
    return json({
      createdTotal,
      createdLast24Hours,
      totalLimit: NATIVE_ROOMS_PER_CREATOR,
      dailyLimit: NATIVE_CREATIONS_PER_DAY,
    });
  }
  // Workspace deletion: its catalog records, and a deleted id is never
  // reserved again.
  const deletion = await deletionCatalogRequest(storage, body);
  if (deletion) return deletion;
  if (body.op === "managed-list") {
    const aliases = servicePrincipals(
      principal(body.principalId),
      body.servicePrincipals,
    );
    const cursor = body.cursor;
    if (
      cursor != null &&
      (typeof cursor !== "string" ||
        !/^native-index:[0-9a-f-]{36}$/.test(cursor))
    )
      throw invalid("Invalid workspace list cursor.");
    const rows = await storage.list<NativeRoom>({
      prefix: "native-index:",
      limit: 100,
      ...(cursor ? { startAfter: cursor as string } : {}),
    });
    const workspaces = [...rows.values()]
      .filter((room) => actsAs(aliases, requireCurrentRoom(room).manager))
      .map((room) => ({ id: room.id, name: room.name }));
    return json({
      workspaces,
      cursor: rows.size === 100 ? [...rows.keys()].at(-1) : null,
    });
  }
  if (body.op === "name-availability") {
    const slug = hostedName(body.slug);
    return json({ available: !(await storage.get(`native-slug:${slug}`)) && !(await nameHold(storage, slug)) });
  }
  if (body.op === "read-name-hold") {
    const id = nativeRoomId(body.id);
    const slug = await storage.get<string>(`native-room-name-hold-v1:${id}`);
    const hold = slug ? await nameHold(storage, slug) : null;
    return json({ hold: hold?.id === id ? { slug, expiresAt: hold.expiresAt } : null });
  }
  if (body.op === "hold-name") {
    const id = nativeRoomId(body.id);
    const slug = hostedName(body.slug);
    const room = await storage.get<NativeRoom>(`native-index:${id}`);
    if (!room || requireCurrentRoom(room).manager !== principal(body.manager))
      throw new HttpError(403, "Only the workspace owner can reserve its hosted name.");
    const owner = await storage.get<string>(`native-slug:${slug}`);
    const hold = await nameHold(storage, slug);
    if ((owner && owner !== id) || (hold && hold.id !== id))
      throw new HttpError(409, "Another team has this name. Choose another.");
    const previous = await storage.get<string>(`native-room-name-hold-v1:${id}`);
    if (previous && previous !== slug && (await nameHold(storage, previous))?.id === id)
      await storage.delete(`native-name-hold-v1:${previous}`);
    // Match the one-day lifetime of a self-serve payment intent.
    const expiresAt = hold?.expiresAt ?? Date.now() + 86_400_000;
    await storage.put(`native-name-hold-v1:${slug}`, { id, expiresAt });
    await storage.put(`native-room-name-hold-v1:${id}`, slug);
    return json({ slug, expiresAt });
  }
  if (body.op === "resolve-slug") {
    const slug = nativeSlug(body.slug);
    const id = await storage.get<string>(`native-slug:${slug}`);
    if (!id) throw new HttpError(404, "Chat not found.");
    const room = await storage.get<NativeRoom>(`native-index:${id}`);
    if (!room || requireCurrentRoom(room).slug !== slug)
      throw new HttpError(404, "Chat not found.");
    return json({ id, ...(room.hostedName === true ? { hostedName: true } : {}) });
  }
  if (body.op === "claim-slug") {
    const id = nativeRoomId(body.id);
    const slug = nativeSlug(body.slug);
    const indexed = await storage.get<NativeRoom>(`native-index:${id}`);
    if (
      indexed &&
      requireCurrentRoom(indexed).manager !== principal(body.manager)
    )
      throw new HttpError(403, "Only the manager can claim a slug.");
    const existing = await storage.get<string>(`native-slug:${slug}`);
    const hold = await nameHold(storage, slug);
    if ((existing && existing !== id) || (hold && hold.id !== id))
      throw new HttpError(409, "That slug is already taken.");
    await storage.put(`native-slug:${slug}`, id);
    return json({ ok: true, created: !existing });
  }
  if (body.op === "release-slug") {
    const id = nativeRoomId(body.id);
    const slug = nativeSlug(body.slug);
    const indexed = await storage.get<NativeRoom>(`native-index:${id}`);
    if (indexed?.slug !== slug && (await storage.get<string>(`native-slug:${slug}`)) === id)
      await storage.delete(`native-slug:${slug}`);
    return json({ ok: true });
  }
  const id = nativeRoomId(body.id);
  const key = `native-reservation:${id}`;
  const existing = await storage.get<NativeCreation>(key);
  if (existing) requireCurrentRoom(existing.room);
  if (body.op === "reserve") {
    const actor = principal(body.principalId);
    const aliases = servicePrincipals(actor, body.servicePrincipals);
    const proposed = nativeCreation(
      body.input as Record<string, unknown>,
      existing && actsAs(aliases, existing.room.creator)
        ? existing.room.creator
        : actor,
      communityOrigin,
    );
    if (proposed.room.id !== id) throw invalid("Chat ID does not match.");
    if (existing) {
      if (
        existing.room.creator !== proposed.room.creator ||
        existing.requestHash !== proposed.requestHash
      )
        throw new HttpError(
          409,
          "This workspace ID is in use. Retry the same request.",
        );
      return json(existing);
    }
    const count = (await storage.get<number>("native-count")) ?? 0;
    const creatorCount = (
      await Promise.all(
        aliases.map((id) => storage.get<number>(`native-count:${id}`)),
      )
    ).reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const ownCount =
      (await storage.get<number>(`native-count:${proposed.room.creator}`)) ?? 0;
    const now = Date.now();
    const ownRecent = (
      (await storage.get<number[]>(`native-rate:${proposed.room.creator}`)) ??
      []
    ).filter((time) => time > now - 86_400_000);
    const recent = (
      await Promise.all(
        aliases.map((id) => storage.get<number[]>(`native-rate:${id}`)),
      )
    )
      .flatMap((times) => times ?? [])
      .filter((time) => time > now - 86_400_000);
    if (count >= NATIVE_ROOM_PILOT_LIMIT)
      throw new HttpError(
        429,
        "New workspaces are at capacity. Try again later.",
        3600,
      );
    if (creatorCount >= NATIVE_ROOMS_PER_CREATOR)
      throw new HttpError(
        429,
        `This account has reached its limit of ${NATIVE_ROOMS_PER_CREATOR} workspaces.`,
        86400,
      );
    if (recent.length >= NATIVE_CREATIONS_PER_DAY)
      throw new HttpError(
        429,
        `You can create up to ${NATIVE_CREATIONS_PER_DAY} workspaces a day.`,
        86400,
      );
    const creation: NativeCreation = {
      ...proposed,
      room: { ...proposed.room, createdAt: new Date(now).toISOString() },
    };
    requireConnectDeadline(body.approvalExpiresAt);
    await storage.put(key, creation);
    await storage.put("native-count", count + 1);
    await storage.put(`native-count:${proposed.room.creator}`, ownCount + 1);
    await storage.put(`native-rate:${proposed.room.creator}`, [
      ...ownRecent,
      now,
    ]);
    return json(creation, 201);
  }
  if (!existing) throw new HttpError(404, "Chat not found.");
  if (body.op === "read") {
    const room = await storage.get<NativeRoom>(`native-index:${id}`);
    if (!room) throw new HttpError(404, "Chat not found.");
    return json(publicNativeRoom(requireCurrentRoom(room)));
  }
  if (body.op === "index") {
    const incoming = body.room as NativeRoom;
    const revision = body.revision;
    if (
      !currentRoom(incoming) ||
      incoming.id !== id ||
      incoming.creator !== existing.room.creator ||
      incoming.createdAt !== existing.room.createdAt ||
      incoming.visibility !== existing.room.visibility ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 1
    )
      throw invalid("Chat metadata does not match its creation.");
    const previousRevision =
      (await storage.get<number>(`native-index-revision:${id}`)) ?? 0;
    if (Number(revision) < previousRevision)
      return json({ ok: true, superseded: true });
    const previousValue = await storage.get<NativeRoom>(`native-index:${id}`);
    const previous = previousValue
      ? requireCurrentRoom(previousValue)
      : undefined;
    const previousSlug = previous?.slug ?? null;
    const nextSlug = incoming.slug ?? null;
    if (nextSlug) {
      const owner = await storage.get<string>(`native-slug:${nextSlug}`);
      if (owner && owner !== id)
        throw new HttpError(409, "That slug is already taken.");
      await storage.put(`native-slug:${nextSlug}`, id);
    }
    if (previousSlug && previousSlug !== nextSlug) {
      if ((await storage.get<string>(`native-slug:${previousSlug}`)) === id)
        await storage.delete(`native-slug:${previousSlug}`);
    }
    // Compare only the public workspace projection at the same revision.
    const room = publicNativeRoom(incoming);
    if (Number(revision) === previousRevision) {
      if (
        previous &&
        canonicalJson(publicNativeRoom(previous)) !== canonicalJson(room)
      )
        throw new HttpError(
          409,
          "Workspace metadata differs at the same revision.",
        );
      return json({ ok: true });
    }
    await storage.put(`native-index:${id}`, room);
    await storage.put(`native-index-revision:${id}`, Number(revision));
    return json({ ok: true });
  }
  throw new HttpError(404, "Not found.");
}

/** The object of one native room. */
export function nativeRoomStub(
  env: { ROOMS: DurableObjectNamespace },
  id: string,
) {
  return env.ROOMS.get(env.ROOMS.idFromName(`native-room:${nativeRoomId(id)}`));
}
/** A native room's record, read before every room route. */
async function readNativeRoom(
  env: { ROOMS: DurableObjectNamespace },
  id: string,
  visitorReplyPolicy = false,
): Promise<{
  room: DurableObjectStub;
  record: NativeRoomRecord;
  features?: WorkspaceFeatures;
}> {
  const room = nativeRoomStub(env, id);
  const response = await timed(
    env,
    "native",
    room.fetch(
      new Request("https://internal/private/native/read", {
        method: "POST",
        headers: visitorReplyPolicy ? { "X-Widget-Reply-Policy": "1" } : {},
      }),
    ),
  );
  if (!response.ok)
    throw new HttpError(
      response.status === 404 ? 404 : 503,
      response.status === 404
        ? "Chat not found."
        : "Chat is temporarily unavailable.",
    );
  const values = response.headers.get(WORKSPACE_FEATURES_HEADER);
  return {
    room,
    record: await response.json<NativeRoomRecord>(),
    ...(values
      ? { features: workspaceFeatureSnapshot(JSON.parse(values)) }
      : {}),
  };
}
/** Starts the room read now; the route's next `nativeRecord` for the same
 * room uses it once. */
export function prefetchNativeRoom(
  env: { ROOMS: DurableObjectNamespace },
  id: string,
) {
  const key = nativeRoomId(id);
  requestPrefetch(env).native = {
    id: key,
    read: started(readNativeRoom(env, key)),
  };
}
/** The room's record: the read this request already started for the same
 * room, or a new one. */
export function nativeRecord(
  env: { ROOMS: DurableObjectNamespace },
  id: string,
  visitorReplyPolicy = false,
): Promise<{
  room: DurableObjectStub;
  record: NativeRoomRecord;
  features?: WorkspaceFeatures;
}> {
  const key = nativeRoomId(id);
  if (visitorReplyPolicy) return readNativeRoom(env, key, true);
  const prefetch = requestPrefetch(env);
  const early = prefetch.native;
  if (early && early.id === key) {
    delete prefetch.native;
    return early.read as Promise<{
      room: DurableObjectStub;
      record: NativeRoomRecord;
      features?: WorkspaceFeatures;
    }>;
  }
  return readNativeRoom(env, key);
}

export async function nativeControlRequest(
  storage: DurableObjectTransaction,
  op: string,
  body: Record<string, unknown>,
  communityOrigin?: string,
  billingEnv: StorageBillingEnv = {},
  adminProfile = false,
) {
  const existing = await storage.get<NativeRoomRecord>("native-room");
  if (existing) requireCurrentRoom(existing.room);
  if (op === "create") {
    const value = body.creation as NativeCreation;
    requireCurrentRoom(value?.room);
    const normalized = nativeCreation(
      {
        ...value?.room,
        setup: value?.setup,
        trialOperator: value?.trialOperator,
      },
      principal(value?.room?.creator),
      communityOrigin,
    );
    if (
      normalized.requestHash !== value.requestHash ||
      !Number.isFinite(Date.parse(value.room.createdAt))
    )
      throw invalid("Chat creation does not match its reservation.");
    if (existing) {
      if (existing.requestHash !== value.requestHash)
        throw new HttpError(
          409,
          "This workspace already exists with different settings.",
        );
      return json(recordView(existing));
    }
    const record: NativeRoomRecord = {
      ...value,
      revision: 1,
      selfServeSupportSetup: true,
      trialAiOnboarding: true,
    };
    requireConnectDeadline(body.approvalExpiresAt);
    await storage.put("native-room", record);
    await storage.put("room-privacy", {
      visibility: value.room.visibility,
    });
    if (value.room.visibility === "private")
      await admitRoomMember(storage, value.room.manager, null);
    await storage.put("chat-settings", {
      channels: [],
      roles: value.setup.roles.map(({ id, name, moderationPermissions }) => ({
        id,
        name,
        enabled: true,
        ...(moderationPermissions?.length ? { moderationPermissions } : {}),
      })),
      bots: [],
      botsRevision: 0,
    });
    await storage.put(
      "native-manual-roles",
      Object.fromEntries(
        value.setup.roles.map(({ id }) => [id, nativeManualRole(id)]),
      ),
    );
    await initializeProducts(storage, {
      creator: value.room.creator,
      room: `room:${value.room.id}`,
      nowMs: Date.parse(value.room.createdAt),
      starterAvailable: true,
    });
    const onboarding = body.onboarding as
      | { journey?: unknown; traffic?: unknown }
      | undefined;
    if (
      onboarding &&
      typeof onboarding.journey === "string" &&
      JOURNEY_ID.test(onboarding.journey) &&
      typeof onboarding.traffic === "string" &&
      Object.hasOwn(ONBOARDING_TRAFFIC, onboarding.traffic)
    )
      await storage.put(WORKSPACE_ONBOARDING, {
        journey: onboarding.journey,
        traffic: value.trialOperator ? "test" : onboarding.traffic,
        expiresAt: Date.now() + ONBOARDING_POLICY.retentionDays * 86_400_000,
      });
    await markWorkspaceStep(storage, "workspace_created", Date.now());
    return json(recordView(record), 201);
  }
  if (!existing) throw new HttpError(404, "Chat not found.");
  const settings = await storage.get<object>("chat-settings");
  if (!settings) throw new HttpError(503, "AI agent settings are unavailable.");
  const agents = await aiPrincipals(
    storage,
    settings,
    `room:${existing.room.id}`,
  );
  requireHumanManager(agents, existing.room.manager);
  // This runs before every public room route. A workspace set to be
  // deleted carries its deletion state, and the worker refuses the route.
  if (op === "read") {
    const supportProfiles = await readSupportProfiles(storage);
    return json({
      ...recordView(existing),
      ...(body.visitorReplyPolicy === true ? {
        aiReplyExpected: supportProfiles?.assistantEnabled !== false &&
          botsFromSettings(settings).length > 0 &&
          readAiDefault(await supportSettings(storage)) === "answers",
      } : {}),
      ...(supportProfiles ? {
        supportProfiles,
        supportResponderConfigured: botsFromSettings(settings).length > 0,
      } : {}),
      ...(await deletionReadField(storage)),
    });
  }
  const actor = principal(body.principalId);
  const aliases = servicePrincipals(actor, body.servicePrincipals);
  if (aliases.some((id) => agents.includes(id)))
    throw new HttpError(
      403,
      "An AI agent cannot hold human workspace authority.",
    );
  if (op === "manager" || op === "accept-manager") {
    await refuseManagerChangeWhileClosing(storage);
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod:
          body.authMethod as import("@templ/chat/principal").AuthMethod,
      },
      body.confirmed,
    );
    if (op === "manager") {
      if (!actsAs(aliases, existing.room.manager))
        throw new HttpError(
          403,
          "Only the manager can transfer this workspace.",
        );
      const next = body.next === null ? null : principal(body.next);
      if (actsAs(aliases, next)) throw invalid("Choose another manager.");
      const provided = body.nextServicePrincipals;
      const nextAliases = next
        ? servicePrincipals(
            Array.isArray(provided) && provided.length
              ? principal(provided[0])
              : next,
            provided ?? [next],
          )
        : [];
      if (next && !nextAliases.includes(next))
        throw invalid("Invalid target account.");
      if (nextAliases.some((id) => agents.includes(id)))
        throw new HttpError(
          403,
          "An AI agent cannot be the workspace manager.",
        );
      existing.room.pendingManager = next;
    } else {
      if (!actsAs(aliases, existing.room.pendingManager))
        throw new HttpError(403, "This transfer belongs to another user.");
      await finalizeStorageManagerTransfer(storage, billingEnv, Date.now());
      if (existing.room.visibility === "private") {
        await admitRoomMember(storage, existing.room.manager, null);
        await admitRoomMember(storage, actor, null);
      }
      await revokeEncryptionPrincipal(storage, existing.room.manager);
      existing.room.manager = actor;
      existing.room.pendingManager = null;
    }
    existing.revision++;
    await storage.put("native-room", existing);
    return json(recordView(existing));
  }
  if (op === "slug") {
    const actor = principal(body.principalId);
    const aliases = servicePrincipals(actor, body.servicePrincipals);
    if (!actsAs(aliases, existing.room.manager))
      throw new HttpError(
        403,
        "Only the manager can change this workspace slug.",
      );
    const next = body.slug === null ? null : nativeSlug(body.slug);
    let paidHostedName = false;
    if (next) {
      const product = await readProductState(storage, Date.now());
      const standard = standardPlanForState(product);
      paidHostedName = body.hostedName === true && standard?.status === "paid";
      if (body.hostedName === true) {
        const mode = productMode(product);
        if (mode === "suspended" || mode === "paused")
          throw new HttpError(403, "Restore workspace access before claiming a hosted name.");
        if (standard && standard.status !== "paid" && mode !== "exempt")
          throw new HttpError(403, "Confirm payment for your workspace plan before claiming a hosted name.");
      }
      if (!productFunded(product))
        throw new HttpError(
          403,
          "Add balance to this workspace to claim a custom link.",
        );
    }
    const serveGuests = Boolean(next && (body.hostedName === true || (existing.room.slug === next && existing.room.hostedName)));
    if ((existing.room.slug ?? null) === next && Boolean(existing.room.hostedName) === serveGuests)
      return json(recordView(existing));
    existing.room.slug = next;
    if (serveGuests) existing.room.hostedName = true;
    else delete existing.room.hostedName;
    existing.revision++;
    await storage.put("native-room", existing);
    if (paidHostedName) await markWorkspaceStep(storage, "hosted_name_claimed", Date.now());
    return json(recordView(existing));
  }
  if (op === "profile") {
    // Public workspace icons use validated hosted media URLs.
    // Private workspaces cannot use icons.
    if (!actsAs(aliases, existing.room.manager) && !adminProfile)
      throw new HttpError(
        403,
        "Only workspace admins can change the name or icon.",
      );
    if (body.contactRole !== undefined) {
      if (!isSupportContactRole(body.contactRole))
        throw invalid("Choose the founder or the AI assistant.");
      const supportProfiles = await saveSupportProfile(storage, body.contactRole, body, communityOrigin);
      return json({ supportProfiles });
    }
    const name =
      body.name === undefined ? existing.room.name : nativeName(body.name);
    let image = existing.room.image;
    if (body.image !== undefined) {
      if (body.image === null) image = null;
      else {
        if (existing.room.visibility === "private")
          throw invalid("Private workspaces cannot use image uploads.");
        if (
          typeof body.image !== "string" ||
          !profileMediaHash(body.image, communityOrigin)
        )
          throw invalid("Choose a valid workspace image.");
        image = new URL(body.image).href;
      }
    }
    if (name === existing.room.name && image === existing.room.image)
      return json(recordView(existing));
    existing.room.name = name;
    existing.room.image = image;
    existing.revision++;
    await storage.put("native-room", existing);
    return json(recordView(existing));
  }
  throw new HttpError(404, "Not found.");
}
