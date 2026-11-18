import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
  type ChatVisibility,
} from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
  subscribeCommunitySession,
} from "./community-auth";
import type { NativeRoom } from "@templ/chat/index";
import { profileMediaHash } from "@templ/chat/profiles";
import { communityFetch } from "./community-client";
import { anonymousChatFetch } from "./chat-api";
import { SITE } from "./site-environment";

const rooms = new Map<string, NativeRoom>();
export const isNativeRoomId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id,
  );
export const isNativeRoomSlug = (slug: string) =>
  /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(slug);
export const nativeRoomHref = (room: Pick<NativeRoom, "id">) =>
  `/inbox/${room.id}`;
export type NativeRoomSetup = {
  roles: { id: string; name: string; mode: "manual" }[];
};
export type NativeRoomDraft = {
  id: string;
  name: string;
  image?: string;
  expectedPrincipalId: ChatPrincipalId;
  visibility: ChatVisibility;
  accentColor?: string;
  setup: NativeRoomSetup;
};

export function checkedNativeRoom(raw: unknown): NativeRoom {
  const value =
    raw && typeof raw === "object" && "room" in raw ? raw.room : raw;
  if (!value || typeof value !== "object")
    throw new Error("Could not read this workspace.");
  const room = value as NativeRoom;
  if (
    !isNativeRoomId(room.id) ||
    (room.slug !== undefined &&
      room.slug !== null &&
      (!isNativeRoomSlug(room.slug) ||
        room.slug !== room.slug.toLowerCase())) ||
    typeof room.name !== "string" ||
    !room.name.trim() ||
    room.name.length > 80 ||
    !normalizeChatPrincipal(room.creator) ||
    !normalizeChatPrincipal(room.manager) ||
    (room.visibility !== "public" && room.visibility !== "private") ||
    // A workspace is never listed or bound to a contract.
    ["listed", "accessContracts", "accessContract"].some((key) =>
      Object.prototype.hasOwnProperty.call(room, key),
    ) ||
    (room.pendingManager !== null &&
      !normalizeChatPrincipal(room.pendingManager)) ||
    typeof room.createdAt !== "string" ||
    !Number.isFinite(Date.parse(room.createdAt)) ||
    (room.image !== null && !profileMediaHash(room.image, SITE.community))
  )
    throw new Error("Could not verify this workspace's details.");
  return room;
}

const scope = () =>
  `${peekCommunitySession()?.principalId ?? "guest"}:${communitySessionRevision()}`;
subscribeCommunitySession(() => rooms.clear());
/** Room metadata is scoped to the current identity, including private chat names. */
export function rememberNativeRoom(room: NativeRoom) {
  const checked = checkedNativeRoom(room);
  rooms.delete(`${scope()}:${checked.id}`);
  rooms.set(`${scope()}:${checked.id}`, checked);
  while (rooms.size > 32) rooms.delete(rooms.keys().next().value!);
}
/** @public A cache a test observes: the room metadata remembered for the
 * current identity. */
export const peekNativeRoom = (id: string) => rooms.get(`${scope()}:${id}`);

export async function readNativeRoom(id: string, signal?: AbortSignal) {
  const started = scope();
  const room = await readNativeRoomWithCookie(id, signal);
  if (started !== scope()) throw new Error("The signed-in account changed.");
  rememberNativeRoom(room);
  return room;
}

/** The signed read without the identity scope, for a read started while
 * sign-in restores. Nothing is remembered: the caller keeps the room only
 * once the restored account matches the one the worker answered for. */
export async function readNativeRoomWithCookie(
  id: string,
  signal?: AbortSignal,
) {
  if (!isNativeRoomId(id)) throw new Error("Invalid chat link.");
  const room = checkedNativeRoom(
    await communityFetch(`/rooms/${id}`, undefined, signal),
  );
  if (room.id !== id)
    throw new Error("The service returned a different workspace.");
  return room;
}

/** Public display metadata may load without waiting for a wallet session.
 * This never caches private metadata or substitutes for the signed read. */
export async function readPublicNativeRoom(id: string, signal?: AbortSignal) {
  if (!isNativeRoomId(id)) throw new Error("Invalid chat link.");
  const started = scope();
  const room = checkedNativeRoom(
    await anonymousChatFetch<unknown>(`/rooms/${id}`, signal),
  );
  if (started !== scope()) throw new Error("The signed-in account changed.");
  if (room.id !== id) throw new Error("The service returned a different chat.");
  return room.visibility === "public" ? room : undefined;
}

export async function resolveNativeSlug(slug: string, signal?: AbortSignal) {
  const normalized = slug.trim().toLowerCase();
  if (!isNativeRoomSlug(normalized)) throw new Error("Invalid workspace link.");
  const result = await communityFetch<{ id: string }>(
    `/slugs/${encodeURIComponent(normalized)}`,
    undefined,
    signal,
  );
  if (!isNativeRoomId(result.id))
    throw new Error("Could not find this workspace.");
  return result.id;
}

export async function createNativeRoom(
  draft: NativeRoomDraft,
): Promise<NativeRoom & { followed?: boolean }> {
  const started = scope();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const room = checkedNativeRoom(
      await communityFetch("/rooms", draft, controller.signal),
    );
    if (
      started !== scope() ||
      room.id !== draft.id ||
      room.visibility !== draft.visibility ||
      room.creator.toLowerCase() !== draft.expectedPrincipalId.toLowerCase()
    )
      throw new Error("The service returned a different chat.");
    rememberNativeRoom(room);
    return room;
  } finally {
    clearTimeout(timeout);
  }
}
