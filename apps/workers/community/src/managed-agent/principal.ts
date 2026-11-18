/** The managed AI account of a workspace.
 *
 * One account id per workspace, derived from the room id, so the room, the
 * knowledge object and the settings page name the same account without
 * storing it. No wallet or sign-in maps to it: the worker creates account
 * ids at random when a wallet signs in, so no session can ever carry this
 * one. Only the workspace's own knowledge object acts as it, through the
 * room binding, and the room grants it nothing by itself: it answers only
 * after the manager adds it to the team as an AI agent (the ordinary role
 * and bot registration), and every read and write checks that access. */
import type { ChatPrincipalId } from "@templ/chat/principal";

const cache = new Map<string, ChatPrincipalId>();

/** `account:<uuid v4 shape>` from SHA-256("templ-managed-agent-v1:" + room). */
export async function managedPrincipal(room: string): Promise<ChatPrincipalId> {
  const key = room.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`templ-managed-agent-v1:${key}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id =
    `account:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ChatPrincipalId;
  if (cache.size > 256) cache.clear();
  cache.set(key, id);
  return id;
}
