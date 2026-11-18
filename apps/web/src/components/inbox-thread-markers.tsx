"use client";

import { useState } from "react";
import { IconLock } from "@tabler/icons-react";
import type { ChatMessage } from "@templ/chat/index";
import type {
  SupportActivity,
  SupportNote,
  SupportWorkflow,
} from "@templ/chat/support";
import { inboxSystemEvent, inboxTime } from "@/lib/inbox-facts";
import { MemberIdentity } from "./member-identity";
import { AgentNoteCopy, noteElementId } from "./support-workflow-panel";
import { PhoneDetailsLink } from "./phone-thread";
import styles from "./team-conversations.module.css";

type ThreadItem =
  | { kind: "message"; id: string; at: string; message: ChatMessage }
  | { kind: "note"; id: string; at: string; note: SupportNote }
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
  for (const note of new Map(
    (workflow?.notes ?? []).map((note) => [note.id, note]),
  ).values())
    items.push({ kind: "note", id: `note-${note.id}`, at: note.at, note });
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

export function InboxNote({
  note,
  replyText,
  onReply,
}: {
  note: SupportNote;
  replyText: string;
  onReply: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div
      className={styles.threadNote}
      id={noteElementId(note.id)}
      tabIndex={-1}
      data-note-id={note.id}
    >
      <div className={styles.noteMeta}>
        <span className={styles.notePrivacy}>
          <IconLock size={14} aria-hidden="true" />
          Team only
        </span>
        <MemberIdentity principalId={note.author} size="sm" />
        {note.byAgent && <span className={styles.rowFlag}>AI agent</span>}
        <time dateTime={note.at}>{inboxTime(note.at)}</time>
      </div>
      <p className={styles.text}>{note.text}</p>
      {note.byAgent && (
        <AgentNoteCopy
          note={note}
          replyText={replyText}
          confirming={confirming === note.id}
          onConfirm={setConfirming}
          onReply={onReply}
        />
      )}
    </div>
  );
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

export function SharedDetailsMarker({
  count,
  thread,
  snapshots = false,
}: {
  count: number;
  thread: string;
  snapshots?: boolean;
}) {
  return count > 0 ? (
    <PhoneDetailsLink
      target={`support-${snapshots ? "failure" : "context"}-${thread}`}
      className={styles.sharedDetails}
    >
      Shared {count} {count === 1 ? "detail" : "details"}
    </PhoneDetailsLink>
  ) : null;
}
