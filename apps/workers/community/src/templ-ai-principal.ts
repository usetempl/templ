import hosted from "./support-agent-instances.json";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { roomKey } from "./common";
import { managedPrincipal } from "./managed-agent/principal";
import { standardMonthlySyntheticPrincipal } from "./standard-monthly-trial-access";

/** Only server-owned workspace bindings identify Templ AI. Labels and provenance grant no identity. */
export async function templAiPrincipal(
  room: string,
  aliases: readonly ChatPrincipalId[],
  synthetic?: Parameters<typeof standardMonthlySyntheticPrincipal>[2],
): Promise<ChatPrincipalId | null> {
  const managed = await managedPrincipal(room);
  if (aliases.includes(managed)) return managed;
  const workspace = roomKey(room).replace(/^room:/, "");
  const instances: {workspace: string; principal: string}[] = hosted.instances;
  for (const instance of instances) {
    const principal = normalizeChatPrincipal(instance.principal);
    if (
      instance.workspace === workspace &&
      principal &&
      aliases.includes(principal)
    )
      return principal;
  }
  return synthetic
    ? standardMonthlySyntheticPrincipal(room, aliases, synthetic)
    : null;
}
