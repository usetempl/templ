import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { SITE } from "@/lib/site-environment";

export type NameHold = { slug: string; expiresAt: number };
export const offersHostedNames = ["usetempl.com", "templ.vip"].includes(new URL(SITE.origin).hostname);

export async function recoverHostedName(room: ChatRoomId, account: ChatPrincipalId, paid: boolean, signal: AbortSignal) {
  const path = roomPath(room, "slug");
  const { hold } = await communityFetch<{ hold: NameHold | null }>(path, undefined, signal);
  signal.throwIfAborted();
  if (!paid || !hold) return { hold, claimed: null };
  const result = await chatMutation<{ slug?: string; hostedName?: boolean }>(
    account, path, { slug: hold.slug, hostedName: true }, undefined, signal,
  );
  signal.throwIfAborted();
  if (result.slug !== hold.slug || !result.hostedName) throw new Error("Your name could not be confirmed.");
  return { hold, claimed: result.slug };
}
