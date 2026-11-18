"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { IconBell, IconBellOff } from "@tabler/icons-react";
import { ALERT_NUDGE } from "@/lib/copy/insights";
import { readEscalation, readMemberSeen } from "@/lib/alerts-client";
import { seenByMember } from "@/lib/copy/alerts";
import { setEscalationTarget, waitAge } from "@/lib/inbox-turn";
import {
  inboxAlertState,
  onInboxAlertsFailed,
  setInboxAlerts,
  subscribeInboxAlerts,
  type InboxAlertState,
} from "@/lib/inbox-attention";
import styles from "./rail.module.css";

/** Whether this browser shows inbox alerts, the same for every control in
 * this tab: turning them on from Home also shows On in the rail. */
export function useInboxAlertState(): InboxAlertState {
  return useSyncExternalStore(
    subscribeInboxAlerts,
    () => inboxAlertState(),
    () => "unsupported",
  );
}

/** Why alerts aren't on after someone asked for them. */
export function alertsExplanation(state: InboxAlertState): string | null {
  return state === "blocked"
    ? "This browser blocks alerts from Templ. Allow notifications for this site in the browser’s settings, then try again."
    : state === "unsupported"
      ? "This browser can’t show alerts from Templ."
      : state === "off"
        ? "Alerts stay off until the browser allows them."
        : null;
}

/** "Alert me in this browser": the rail control. It and the nudge are the
 * only places that ask the browser for notification permission, and only
 * on a click. */
export function InboxAlertsToggle() {
  const state = useInboxAlertState();
  useEscalationTarget();
  const [busy, setBusy] = useState(false);
  const [explained, setExplained] = useState(false);
  // A browser that turns out unable to show an alert stops saying On and
  // says why.
  useEffect(() => onInboxAlertsFailed(() => setExplained(true)), []);
  if (state === "unsupported")
    return explained ? (
      <div className={styles.navGroup}>
        <p className={styles.railNote} role="status">
          {alertsExplanation(state)}
        </p>
      </div>
    ) : null;
  const on = state === "on";
  async function toggle() {
    if (busy) return;
    if (state === "blocked") {
      setExplained(true);
      return;
    }
    setBusy(true);
    const next = await setInboxAlerts(!on);
    setExplained(
      next === "blocked" || next === "unsupported" || (!on && next === "off"),
    );
    setBusy(false);
  }
  return (
    <div className={styles.navGroup}>
      <button
        type="button"
        className={styles.navItem}
        aria-pressed={on}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {on ? (
          <IconBell aria-hidden="true" />
        ) : (
          <IconBellOff aria-hidden="true" />
        )}
        <span className={styles.navText}>Alert me in this browser</span>
        {on && (
          <span className={styles.navBadge} aria-hidden="true">
            On
          </span>
        )}
      </button>
      {explained && state !== "on" && (
        <p className={styles.railNote} role="status">
          {alertsExplanation(state)}
        </p>
      )}
    </div>
  );
}

/** Offers browser alerts where they are off and this browser can show
 * them. It says alerts need Templ open in a tab, because they come from
 * this page. Gone once they are on. */
export function InboxAlertsNudge({
  className,
  textClassName,
}: {
  className?: string;
  textClassName?: string;
}) {
  const state = useInboxAlertState();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<InboxAlertState | null>(null);
  if (state === "on" || (state !== "off" && asked === null)) return null;
  const explanation = asked && alertsExplanation(state);
  return (
    <div className={className}>
      <p className={textClassName}>{ALERT_NUDGE}</p>
      {state === "off" && (
        <button
          type="button"
          className="button small secondary"
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void setInboxAlerts(true).then((next) => {
              setAsked(next);
              setBusy(false);
            });
          }}
        >
          <IconBell aria-hidden="true" /> Alert me in this browser
        </button>
      )}
      {explanation && (
        <p className={textClassName} role="status">
          {explanation}
        </p>
      )}
    </div>
  );
}

const WORKSPACE_PATH = /^\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/;
/** Loads the workspace's escalation target once per workspace page, so
 * rows past it read "Past your 30 min target". People outside the team get
 * a 404 and no chip. */
export function useEscalationTarget() {
  const room =
    typeof window === "undefined" ? null : (WORKSPACE_PATH.exec(window.location.pathname)?.[1] ?? null);
  useEffect(() => {
    if (!room) return;
    const controller = new AbortController();
    readEscalation(`room:${room}` as never, controller.signal)
      .then((data) => setEscalationTarget(data?.escalateAfterMinutes ?? null))
      .catch(() => setEscalationTarget(null));
    return () => controller.abort();
  }, [room]);
}

/** "Seen by the member 3 min ago" under the newest team reply, for people
 * on the team. Shows nothing until the member has opened that reply. */
export function SeenByMember({
  room,
  thread,
  lastTeamReplyAt,
}: {
  room: `room:${string}`;
  thread: string;
  lastTeamReplyAt: string | null;
}) {
  const [seen, setSeen] = useState<{ at: string; readAt: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readMemberSeen(room, thread, controller.signal)
      .then((data) =>
        setSeen(data?.memberSeenAt ? { at: data.memberSeenAt, readAt: Date.now() } : null),
      )
      .catch(() => setSeen(null));
    return () => controller.abort();
  }, [room, thread, lastTeamReplyAt]);
  if (!seen || !lastTeamReplyAt || Date.parse(seen.at) < Date.parse(lastTeamReplyAt)) return null;
  const age = waitAge(seen.at, seen.readAt);
  return (
    <p className={styles.railNote} role="status">
      {seenByMember(age === "<1 min" ? "just now" : `${age} ago`)}
    </p>
  );
}
