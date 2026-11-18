import type { TeamConversationFilter } from "@templ/chat/index";

/** Inbox views a link may open, for example an alert's
 * `?team=1&view=needs-you`. `wallet-handoff.ts` forwards the same list. */
export const LINKED_INBOX_VIEWS = [
  "needs-you",
  "ai-handling",
  "needs-reply",
  "needs-person",
] as const satisfies readonly TeamConversationFilter[];
export type LinkedInboxView = (typeof LINKED_INBOX_VIEWS)[number];

/** The view this page's link asks for, or null. */
export function readLinkedInboxView(): LinkedInboxView | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("view");
  return (LINKED_INBOX_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as LinkedInboxView)
    : null;
}

/** Once the person picks another view, the link's view no longer applies. */
export function clearLinkedInboxView() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("view")) return;
  url.searchParams.delete("view");
  window.history.replaceState(window.history.state, "", url);
}
