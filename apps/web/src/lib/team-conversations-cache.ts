import type {
  ChatRoomId,
  TeamConversation,
  TeamConversationMessages,
  TeamConversationStatus,
} from "@templ/chat/index";
import type { PriorityFeed } from "@templ/chat/support-priority";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { BoundedCache } from "./bounded-cache";
import {
  privateChatCacheScope,
  isChatCacheScopeCurrent,
  isPrivateChatCacheScopeCurrent,
  registerPrivateChatCache,
  clearPrivateChatCaches,
} from "./chat-cache-scope";

export function teamQueueCacheKey(
  filter: string,
  filters: Partial<
    Record<
      "member" | "assignee" | "tag" | "category" | "after" | "before",
      string
    >
  > = {},
) {
  return `${filter}:${JSON.stringify(
    Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  )}`;
}
type QueuePage = {
  priorityFeed?: PriorityFeed;
  rows: TeamConversation[];
  nextCursor?: string | null;
  pages: number;
};
const statuses = new BoundedCache<TeamConversationStatus>(12, 60_000);
const queues = new BoundedCache<QueuePage>(24, 60_000);
const threads = new BoundedCache<TeamConversationMessages>(24, 60_000);
const previews = new BoundedCache<{ excerpt: string | null; refreshAt: number }>(100, 60_000);
for (const cache of [statuses, queues, threads, previews])
  registerPrivateChatCache(cache);
export function teamPresentationCache(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  revision: number,
) {
  const captured = privateChatCacheScope(room, account);
  const key = captured ? `${captured}:${revision}` : undefined;
  const current = () => isPrivateChatCacheScopeCurrent(room, account, captured);
  return {
    status: () => (current() ? statuses.get(key!) : undefined),
    rememberStatus: (value: TeamConversationStatus) => {
      if (current()) statuses.set(key!, value);
    },
    queue: (query: string) =>
      current() ? queues.get(`${key}:${query}`) : undefined,
    forgetQueues: () => {
      if (current()) queues.deletePrefix(`${key}:`);
    },
    rememberQueue: (query: string, value: QueuePage) => {
      if (!current()) return;
      if (
        value.rows.length > 500 ||
        (value.priorityFeed?.cases.length ?? 0) > 500
      )
        queues.delete(`${key}:${query}`);
      else queues.set(`${key}:${query}`, value);
    },
    thread: (id: string) =>
      current() ? threads.get(`${key}:${id}`) : undefined,
    preview: (id: string) =>
      current() ? previews.get(`${key}:${id}`)?.excerpt : undefined,
    previewDue: (id: string) => current() && Date.now() >= (previews.get(`${key}:${id}`)?.refreshAt ?? 0),
    forgetPreview: (id: string) => {
      if (current()) previews.delete(`${key}:${id}`);
    },
    rememberPreview: (id: string, value: string | null) => {
      // Allow one inbox poll to refresh a visible excerpt before it expires.
      if (current()) previews.set(`${key}:${id}`, { excerpt: value, refreshAt: Date.now() + 45_000 });
    },
    rememberThread: (id: string, value: TeamConversationMessages) => {
      if (!current()) return;
      const messages = value.messages.slice(-200);
      const authors = Object.fromEntries(
        Object.entries(value.authors ?? {}).filter(([author]) =>
          messages.some((message) => message.author === author),
        ),
      );
      threads.set(`${key}:${id}`, {
        ...value,
        messages,
        authors,
        nextBefore:
          messages.length < value.messages.length
            ? (messages[0]?.id ?? null)
            : value.nextBefore,
      });
    },
    forgetThread: (id: string) => {
      if (key) threads.delete(`${key}:${id}`);
    },
    clear: () => {
      if (isChatCacheScopeCurrent(room, account, captured))
        clearPrivateChatCaches();
    },
  };
}
