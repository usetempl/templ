"use client";

import type { ChatMessage } from "@templ/chat/index";
import type {
  SupportActivity,
  SupportWorkflow,
} from "@templ/chat/support";
import { inboxSystemEvent, inboxTime } from "@/lib/inbox-facts";
import styles from "./team-conversations.module.css";

type ThreadItem =
  | { kind: "message"; id: string; at: string; message: ChatMessage }
  | { kind: "event"; id: string; at: string; activity: SupportActivity };

/** The staff timeline combines only data from the staff workflow read. */
export function inboxThreadItems(
  messages: ChatMessage[],
  workflow: SupportWorkflow | null,
  members: readonly string[] = [],
): ThreadItem[] {
  const items: ThreadItem[] = messages.map((message) => ({
    kind: "message",
    id: `message-${message.id}`,
    at: message.createdAt,
    message,
  }));
  for (const activity of workflow?.activity ?? [])
    if (inboxSystemEvent(activity, members))
      items.push({
        kind: "event",
        id: `event-${activity.id}`,
        at: activity.at,
        activity,
      });
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function InboxSystemLine({
  activity,
  members,
}: {
  activity: SupportActivity;
  members?: readonly string[];
}) {
  const label = inboxSystemEvent(activity, members);
  const time = inboxTime(activity.at);
  const when = time.includes(",") ? "on" : "at";
  return label ? (
    <p className={styles.system} data-event-id={activity.id}>
      {label} {when} <time dateTime={activity.at}>{time}</time>
    </p>
  ) : null;
}
