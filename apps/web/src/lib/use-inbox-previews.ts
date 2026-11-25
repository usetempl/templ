import { useEffect, useState, type RefObject } from "react";
import type { ChatRoomId, TeamConversation } from "@templ/chat/index";
import type { teamPresentationCache } from "./team-conversations-cache";
import { readConversationMessages } from "./team-conversations-client";

const keyFor = (row: TeamConversation) => `${row.id}:${row.revision}`;

/** Read visible excerpts after the queue paints. The thread endpoint owns
 * permissions and encrypted bodies stay in their secure viewer. */
export function useInboxPreviews(
  room: ChatRoomId,
  rows: TeamConversation[] | null,
  scroll: RefObject<HTMLDivElement | null>,
  cache: ReturnType<typeof teamPresentationCache>,
) {
  const [, render] = useState(0);
  useEffect(() => {
    const viewport = scroll.current;
    if (!rows?.length || !viewport || typeof IntersectionObserver === "undefined") return;
    const items = new Map(rows.map(row => [row.id, row]));
    const controller = new AbortController();
    const visible = new Map<Element, TeamConversation>();
    const attempted = new Set<string>();
    let reading = false;

    async function loadVisible() {
      if (reading) return;
      reading = true;
      try {
        while (!controller.signal.aborted) {
          const row = [...visible.values()].find(item =>
            !attempted.has(keyFor(item)) && cache.preview(keyFor(item)) === undefined);
          if (!row) break;
          const key = keyFor(row);
          attempted.add(key);
          try {
            const page = await readConversationMessages(room, row.id, { limit: 25 }, controller.signal);
            if (controller.signal.aborted) return;
            if (page.conversation.id !== row.id || page.conversation.viewer !== "team" || page.conversation.encryption)
              continue;
            const visitors = new Set<string>([page.conversation.member, ...(page.conversation.formerMembers ?? [])]);
            const message = page.messages.findLast(item => visitors.has(item.author));
            const excerpt = message?.text.replace(/\s+/gu, " ").trim().slice(0, 180);
            cache.rememberPreview(key, excerpt || null);
            render(value => value + 1);
          } catch {
            // The case row remains usable during a refusal or network error.
          }
        }
      } finally {
        reading = false;
      }
    }

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.inboxCase;
        const row = id && items.get(id);
        if (!row || !entry.isIntersecting) visible.delete(entry.target);
        else if (row.viewer === "team" && !row.encryption && row.lastMessageAt)
          visible.set(entry.target, row);
      }
      void loadVisible();
    }, { root: viewport, rootMargin: "120px 0px" });

    for (const element of viewport.querySelectorAll("[data-inbox-case]")) observer.observe(element);
    return () => {
      controller.abort();
      observer.disconnect();
    };
  }, [rows, room, scroll, cache]);
  return (row: TeamConversation) => row.encryption ? undefined : cache.preview(keyFor(row)) ?? undefined;
}
