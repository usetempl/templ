import type { ChatAuthorFacts } from "@templ/chat/index";
import { renderMessages } from "./message-store";
import type { SearchRouteInput } from "./search-index";
import { actsAs } from "./service-principals";
import { conversationMessageNames } from "./staff-display-name";
import {
  canReadConversation,
  readConversation,
  type ConversationContext,
} from "./team-conversations";

/** Search hits use the same names and member privacy as their thread. */
export function supportSearchPresentation(
  storage: DurableObjectTransaction,
  context: Pick<
    ConversationContext,
    "viewer" | "aliases" | "room" | "bots" | "isBot" | "authors"
  >,
): Pick<SearchRouteInput, "render" | "authors"> {
  const authors: Record<string, ChatAuthorFacts> = {};
  return {
    render: async (channel, rows) => {
      if (!(await canReadConversation(storage, context, channel))) return [];
      const record = await readConversation(storage, channel);
      if (!record) return [];
      const messages = await renderMessages(storage, channel, rows, {
        aliases: context.aliases,
      });
      const page = await conversationMessageNames(
        storage,
        record,
        messages,
        actsAs(context.aliases, record.member) ? "member" : "team",
        context.bots ?? [],
        await context.authors(messages),
      );
      Object.assign(authors, page.authors);
      return page.messages;
    },
    authors: async () => ({ authors }),
  };
}
