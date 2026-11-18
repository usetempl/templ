import type { ChatAuthorFacts, ChatMessage } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { hasHiddenCharacters } from "@templ/chat/profiles";
import { HttpError, json } from "./common";
import { readStorageBatch } from "./storage-batch";
import {
  templStaffGrantKey,
  listedTemplStaff,
  type TemplStaffEnv,
} from "./templ-staff";
import { publicMessageDetails } from "./support-message-details";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
const key = (principal: string) => `support-team-name-v1:${principal}`;

export function normalizeTeamName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new HttpError(
      400,
      "Use 1 to 32 characters, or leave the name empty.",
    );
  const text = value.normalize("NFKC");
  if (hasHiddenCharacters(text))
    throw new HttpError(400, "Remove hidden characters from the name.");
  const name = text.trim().replace(/\s+/gu, " ");
  if (!name) return null;
  if ([...name].length > 32)
    throw new HttpError(
      400,
      "Use 1 to 32 characters, or leave the name empty.",
    );
  if (
    /@|(?:[a-z][a-z\d+.-]*:\/\/)|\bwww\.|\b[\p{L}\d-]+\.[\p{L}]{2,}(?:\b|\/)/iu.test(
      name,
    ) ||
    /0x[0-9a-f]+/i.test(name) ||
    /(?:^|\s)[1-9A-HJ-NP-Za-km-z]{32,44}(?:$|\s)/.test(name)
  )
    throw new HttpError(400, "Use a name without links, handles or wallets.");
  return name;
}

export async function readTeamName(
  storage: Pick<Storage, "get">,
  principal: string,
) {
  const value = await storage.get<unknown>(key(principal));
  try {
    return value === undefined ? null : normalizeTeamName(value);
  } catch {
    return null;
  }
}

export async function staffDisplayNameRoute(
  storage: Storage,
  context: ConversationContext,
  team: boolean,
): Promise<Response | null> {
  if (context.pathname !== "/conversations/team-name") return null;
  const actor = context.viewer.principalId;
  if (!actor || !team || context.isBot)
    throw new HttpError(403, "Only a person on the team can set their name.");
  if (context.method === "GET")
    return json({ teamName: await readTeamName(storage, actor) });
  if (context.method !== "POST") return null;
  if (
    Object.keys(context.body).some(
      (field) =>
        !["teamName", "expectedPrincipalId", "confirmed"].includes(field),
    )
  )
    throw new HttpError(400, "You can change only your own name.");
  const teamName = normalizeTeamName(context.body.teamName);
  const limiter = context.mediaEnv.CHAT_RATE_LIMITER;
  if (!limiter || !(await limiter.limit({ key: `team-name:${actor}` })).success)
    throw new HttpError(429, "Too many name changes. Try again shortly.");
  if (teamName === null) await storage.delete(key(actor));
  else await storage.put(key(actor), teamName);
  return json({ teamName });
}

/** Names describe replies. They are never read by an access check. */
export async function conversationMessageNames(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
  messages: ChatMessage[],
  role: "member" | "team",
  bots: readonly ChatPrincipalId[],
  facts: { authors?: Record<string, ChatAuthorFacts> },
  env: TemplStaffEnv = {},
): Promise<{
  messages: ChatMessage[];
  authors?: Record<string, ChatAuthorFacts>;
}> {
  const members = new Set<string>([
    record.member,
    ...(record.formerMembers ?? []),
  ]);
  const botIds = new Set<string>(bots);
  const authors = new Set(
    messages.flatMap((message) => [
      message.author,
      ...(message.reply?.author ? [message.reply.author] : []),
    ]),
  );
  const humans = [...authors].filter(
    (author) => !members.has(author) && !botIds.has(author),
  );
  const rows = await readStorageBatch<unknown>(
    storage,
    humans.flatMap((author) => [key(author), templStaffGrantKey(author)]),
  );
  const templ = new Set(
    humans.filter(
      (author) =>
        listedTemplStaff(env, author) ||
        rows.get(templStaffGrantKey(author)) !== undefined,
    ),
  );
  const names = new Map(
    humans.map((author) => {
      try {
        return [
          author,
          normalizeTeamName(rows.get(key(author)) ?? null),
        ] as const;
      } catch {
        return [author, null] as const;
      }
    }),
  );
  const shownAuthor = (author: string) =>
    members.has(author) ? author : botIds.has(author) ? "ai-agent" : "team";
  return {
    messages: messages.map((message) => {
      const { teamName: _storedName, ...publicMessage } =
        publicMessageDetails(message);
      return {
        ...publicMessage,
        ...(role === "member" && templ.has(message.author)
          ? {}
          : names.has(message.author)
            ? { teamName: names.get(message.author)! }
            : {}),
        ...(role === "member"
          ? {
              author: shownAuthor(message.author),
              ...(message.reply?.author
                ? {
                    reply: {
                      ...message.reply,
                      author: shownAuthor(message.reply.author),
                    },
                  }
                : {}),
            }
          : {}),
      };
    }),
    ...(role === "team"
      ? {
          authors: Object.fromEntries(
            [...new Set([...Object.keys(facts.authors ?? {}), ...templ])].map(
              (author) => [
                author,
                {
                  ...(facts.authors?.[author] ?? { badges: [], roleNames: [] }),
                  ...(templ.has(author) ? { templStaff: true as const } : {}),
                },
              ],
            ),
          ),
        }
      : {
          authors: {
            ...(messages.some((message) => botIds.has(message.author))
              ? { "ai-agent": { badges: ["bot" as const], roleNames: [] } }
              : {}),
          },
        }),
  };
}
