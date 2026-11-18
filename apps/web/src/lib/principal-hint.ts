import type { ChatSession } from "@templ/chat/principal";

/** Names the signed-in account so the worker can start its reads for it
 * early. The worker never trusts it: every request is still authorized from
 * its cookie, and a hint that does not match is ignored. */
export const PRINCIPAL_HINT_HEADER = "X-Templ-Principal-Hint";

let rememberedSession: () => ChatSession | undefined = () => undefined;
/** community-auth registers the session it remembers. Kept apart from both
 * modules so neither imports the other. */
export function setPrincipalHintSession(read: () => ChatSession | undefined) {
  rememberedSession = read;
}

/** The session principal first, then its service principals, at most 8. */
export function principalHint(
  session: ChatSession | undefined = rememberedSession(),
): string | undefined {
  if (!session) return undefined;
  return [...new Set([session.principalId, ...session.servicePrincipals])]
    .slice(0, 8)
    .join(",");
}
