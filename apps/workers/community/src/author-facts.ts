import type {
  ChatAuthorBadge,
  ChatAuthorFacts,
  ModeratorPermission,
} from "@templ/chat/index";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { ChatBot } from "@templ/chat/bots";
import { aiPrincipalsFromSettings, aiRole } from "./bots";
import { readStorageBatch } from "./storage-batch";
import { managedPrincipal } from "./managed-agent/principal";

/** Author facts joined onto message pages. Every badge comes from
 * room authority or room settings, never from message text or a display
 * name. The self-declared profile `agent` flag is chip text the client reads
 * from `/profiles`; it is not a badge. */
type Storage = Pick<DurableObjectTransaction, "get">;
export type AuthorFactsSettings = {
  roles: {
    id: string;
    name: string;
    enabled?: boolean;
    moderationPermissions?: ModeratorPermission[];
  }[];
  bots: ChatBot[];
  botsRevision: number;
  aiPrincipals?: ChatPrincipalId[];
};
/** Distinct authors described per page; later authors are left out. */
export const MAX_AUTHOR_FACTS = 50;
export const MAX_AUTHOR_ROLE_NAMES = 4;
/** Facts for the distinct authors of a page. `viewerAliases` are the
 * requester's proven aliases: only they let one author's facts cover a linked
 * alias, since the room never sees other members' account links. */
export async function authorFacts(
  storage: Storage,
  settings: AuthorFactsSettings,
  manager: ChatPrincipalId | null,
  authors: readonly string[],
  viewerAliases: readonly ChatPrincipalId[] = [],
): Promise<Record<string, ChatAuthorFacts>> {
  const bots = new Set(aiPrincipalsFromSettings(settings));
  const facts: Record<string, ChatAuthorFacts> = {};
  const distinct = new Set<ChatPrincipalId>();
  for (const author of authors) {
    if (distinct.size >= MAX_AUTHOR_FACTS) break;
    const id = normalizeChatPrincipal(author);
    if (id && id === author) distinct.add(id);
  }
  const aliasesByAuthor = new Map<ChatPrincipalId, ChatPrincipalId[]>();
  const aliasesToRead = new Set<ChatPrincipalId>();
  for (const id of distinct) {
    const aliases = viewerAliases.includes(id) ? [...viewerAliases] : [id];
    aliasesByAuthor.set(id, aliases);
    for (const alias of aliases) aliasesToRead.add(alias);
  }
  const roleKeys = [...aliasesToRead].map((id) => `roles:${id}`);
  // The independent authority rows of a page are fetched in one bounded
  // batch instead of one read per author, while
  // badges still derive only from the same room-local records.
  const roleRows = roleKeys.length
    ? await readStorageBatch<unknown>(storage, [...roleKeys, "native-room"])
    : new Map<string, unknown>();
  // The workspace's managed AI identity also survives registration removal.
  let managed: ChatPrincipalId | null = null;
  const native = roleRows.get("native-room") as
    | { room?: { id?: unknown } }
    | undefined;
  if (typeof native?.room?.id === "string") {
    managed = await managedPrincipal(`room:${native.room.id}`);
    bots.add(managed);
  }
  for (const id of distinct) {
    const aliases = aliasesByAuthor.get(id)!;
    const badges: ChatAuthorBadge[] = [];
    const agent = aliases.some((alias) => bots.has(alias));
    if (!agent && manager && aliases.includes(manager)) badges.push("manager");
    const assigned = new Set<string>();
    for (const alias of aliases) {
      const held = roleRows.get(`roles:${alias}`);
      if (Array.isArray(held))
        for (const roleId of held)
          if (typeof roleId === "string") assigned.add(roleId);
    }
    const roleModerator = settings.roles.some(
      (role) =>
        role.enabled !== false &&
        (!agent || aiRole(role)) &&
        assigned.has(role.id) &&
        Array.isArray(role.moderationPermissions) &&
        role.moderationPermissions.length > 0,
    );
    if (roleModerator) badges.push("moderator");
    if (agent) {
      badges.push("bot");
      if (managed && aliases.includes(managed)) badges.push("managed");
    }
    const roleNames = settings.roles
      .filter((role) => assigned.has(role.id) && (!agent || aiRole(role)))
      .slice(0, MAX_AUTHOR_ROLE_NAMES)
      .map((role) => role.name);
    facts[id] = { badges, roleNames };
  }
  return facts;
}
/** The current `authors` field for a message page, including an explicit empty
 * object for an empty page. */
export async function pageAuthors(
  storage: Storage,
  settings: AuthorFactsSettings,
  manager: ChatPrincipalId | null,
  messages: readonly { author: string }[],
  viewerAliases: readonly ChatPrincipalId[] = [],
): Promise<{ authors: Record<string, ChatAuthorFacts> }> {
  return {
    authors: await authorFacts(
      storage,
      settings,
      manager,
      messages.map((message) => message.author),
      viewerAliases,
    ),
  };
}
