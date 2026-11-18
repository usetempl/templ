import { HttpError } from "./common";
import { teamTextRefusal } from "./secret-guard";
import type { TeamTextRefusal } from "@templ/chat/support-safety";
import { canReadConversation, type ConversationContext } from "./team-conversations";
import { managedPrincipal } from "./managed-agent/principal";
/** The managed runner reports a local refusal using fixed metadata only. */
export async function teamRefusalRoute(storage: Pick<DurableObjectTransaction, "get" | "list">, context: ConversationContext): Promise<void> {
  const match = /^\/conversations\/(tc-[0-9a-f]{32})\/safety-refusal$/.exec(context.pathname);
  if (!match) return;
  if (context.method !== "POST" || !context.isBot || context.viewer.principalId !== await managedPrincipal(context.room) ||
      !(await canReadConversation(storage, context, match[1]))) throw new HttpError(404, "Support action not found.");
  const kind = context.body.kind;
  if (!["asks for a secret", "asks for a credential", "transaction instruction", "signing instruction"].includes(String(kind)))
    throw new HttpError(400, "Choose a refusal kind.");
  throw teamTextRefusal(kind as TeamTextRefusal);
}
