"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { TeamConversationFilter } from "@templ/chat/index";
import { PRIORITY_COPY } from "@templ/chat/support-priority";
import { copy as t, type MessageKey } from "@/lib/copy";
import {
  readAiHandlingShown,
  readInboxCounts,
  subscribeInboxCounts,
  type InboxCounts,
} from "@/lib/inbox-counts";
import styles from "./team-conversations.module.css";

/** Every view has a label for selection, saved views and links. */
const LABEL_KEYS: Record<TeamConversationFilter, MessageKey> = {
  "needs-you": "room.inbox.needsYou",
  "ai-handling": "room.inbox.aiHandling",
  "waiting-on-member": "room.inbox.waitingOnMember",
  resolved: "room.inbox.resolved",
  abandoned: "room.inbox.abandoned",
  archived: "room.inbox.archived",
  mine: "room.inbox.mine",
  unassigned: "room.inbox.unassigned",
  open: "room.inbox.open",
  spam: "room.inbox.spam",
  all: "room.inbox.all",
  "needs-reply": "room.inbox.needsReply",
  "needs-person": "room.inbox.needsPerson",
  waiting: "room.inbox.waiting",
};
export const inboxViewLabel = (view: TeamConversationFilter) =>
  t(LABEL_KEYS[view]);
/** The primary views once the service can report turns. */
export const TURN_VIEWS = [
  "needs-you",
  "ai-handling",
  "waiting-on-member",
  "resolved",
] as const satisfies readonly TeamConversationFilter[];
const OTHER_VIEWS = [
  "mine",
  "unassigned",
  "open",
  "needs-reply",
  "needs-person",
  "spam",
  "abandoned",
  "archived",
  "all",
] as const satisfies readonly TeamConversationFilter[];
/** Views supported before the service can report turns. */
const EARLIER_VIEWS = [
  "unassigned",
  "mine",
  "open",
  "waiting",
  "resolved",
  "spam",
  "all",
] as const satisfies readonly TeamConversationFilter[];
/** Views only a service with the case ledger and turns can answer. */
const READY_ONLY: readonly TeamConversationFilter[] = [
  "needs-you",
  "ai-handling",
  "waiting-on-member",
  "needs-reply",
  "needs-person",
];
export const needsReadyViews = (view: TeamConversationFilter) =>
  READY_ONLY.includes(view);

/** The number a view shows, or null for views without live counts,
 * never zero. "+" when the service read only part of the waits, so there
 * may be more. */
export function viewCount(
  view: TeamConversationFilter,
  counts: InboxCounts | null,
): string | null {
  if (!counts) return null;
  const n =
    view === "needs-you"
      ? counts.needsYou
      : view === "ai-handling"
        ? counts.aiHandling
        : view === "waiting-on-member"
          ? counts.waitingOnMember
          : null;
  if (!n) return null;
  const more =
    view === "waiting-on-member" ? counts.waitingOnMemberMore : counts.more;
  return `${n}${more ? "+" : ""}`;
}
function countName(view: TeamConversationFilter, count: string | null) {
  const label = inboxViewLabel(view);
  if (count === null) return label;
  return t(count === "1" ? "room.inbox.countOne" : "room.inbox.countMany", {
    view: label,
    n: count,
  });
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayClock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
/** "3:40 PM" today, else "Sep 27, 3:40 PM". */
export function checkInTime(value: string, now = Date.now()) {
  const date = new Date(value);
  return date.toDateString() === new Date(now).toDateString()
    ? clock.format(date)
    : dayClock.format(date);
}
/** The line above the views while an AI agent that checked in since Templ
 * last restarted has gone quiet and requests wait. It names the time Templ
 * saw it, and nothing when Templ has no time to name. */
export function agentOfflineLine(
  counts: InboxCounts | null,
  now = Date.now(),
): string | null {
  if (
    !counts?.agentRegistered ||
    counts.agentActive ||
    counts.agentSeenAt === null ||
    !Number.isFinite(Date.parse(counts.agentSeenAt)) ||
    counts.needsYou + counts.aiHandling === 0
  )
    return null;
  return t("room.inbox.agentOffline", {
    time: checkInTime(counts.agentSeenAt, now),
  });
}

/** The inbox counts and whether AI is handling shows, for this workspace
 * and account, as this browser tab last saw them. */
export function useInboxCounts(room: string, account: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeInboxCounts(room, account, listener),
    [room, account],
  );
  const counts = useSyncExternalStore(
    subscribe,
    () => readInboxCounts(room, account),
    () => null,
  );
  const aiShown = useSyncExternalStore(
    subscribe,
    () => readAiHandlingShown(room, account),
    () => false,
  );
  return { counts, aiShown };
}

export function InboxViews({
  value,
  ready,
  counts,
  showAiHandling,
  onChange,
  priorities,
}: {
  value: TeamConversationFilter;
  /** The service says its views are ready. */
  ready: boolean;
  counts: InboxCounts | null;
  showAiHandling: boolean;
  onChange: (view: TeamConversationFilter) => void;
  priorities?: { selected: boolean; onSelect: () => void };
}) {
  const views: readonly TeamConversationFilter[] = ready
    ? [
        ...TURN_VIEWS.filter(
          (view) =>
            (view !== "ai-handling" || showAiHandling || value === view) &&
            (view !== "waiting-on-member" || value !== "waiting"),
        ),
        ...OTHER_VIEWS,
        ...(value === "waiting" ? [value] : []),
      ]
    : EARLIER_VIEWS;
  return (
    <div className={styles.views}>
      <label className={styles.viewSelector}>
        <span className={styles.srOnly}>Inbox view</span>
        <select
          aria-label="Inbox view"
          className={styles.viewSelect}
          value={priorities?.selected ? "priorities" : value}
          onChange={(event) => {
            if (event.target.value === "priorities") priorities?.onSelect();
            else onChange(event.target.value as TeamConversationFilter);
          }}
        >
          {priorities && (
            <option value="priorities">{PRIORITY_COPY.title}</option>
          )}
          {views.map((view) => (
            <option key={view} value={view}>
              {countName(view, ready ? viewCount(view, counts) : null)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
