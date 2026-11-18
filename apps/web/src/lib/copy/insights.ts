import {
  SUPPORT_LIMITS,
  SUPPORT_REFUSAL_REASONS,
  type SupportRefusalReason,
  type SupportRefusals,
  type SupportReportWindow,
} from "@templ/chat/support";
import { waitAge } from "@/lib/inbox-turn";
import { copy as t } from "./index";

/** Words for a workspace's own numbers on Home, Plan and the inbox tools:
 * the report, the requests that need a person now and the requests the team
 * turned away. Staff-facing. Counts and times only; none of these lines
 * names a person, a wallet or a message. */

export const REPORT_WINDOW_LABELS: Record<SupportReportWindow, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All",
};
export const REPORT_LABELS = {
  period: "Report period",
  requests: "Cases",
  requests30: "Cases (30 days)",
  waiting: "Waiting for a reply",
  resolved: "Resolved",
  reopened: "Reopened",
  firstReply: "First reply by a person (median)",
  noPersonReply: "No reply from a person yet",
  failed: "The report for this period couldn’t load. Try again.",
} as const;
/** Home's notes under the report, one point per line. */
export function reportNotes(report: {
  truncated: boolean;
  complete: boolean;
}): string[] {
  return [
    "Cases, resolved and reply times cover cases opened in this period.",
    "Waiting for a reply shows what is waiting now.",
    "A reply from your AI agent ends the wait. Reply times count people only.",
    "The report leaves out spam, test accounts and your team’s own test cases.",
    ...(report.truncated
      ? [
          `The report counts only the newest ${SUPPORT_LIMITS.reportCaseScan.toLocaleString("en-US")} cases in this period.`,
        ]
      : []),
    ...(report.complete
      ? []
      : ["Templ is still counting cases."]),
  ];
}
/** "Under a minute", "14 min", "2.5 h", "3 days". */
export function formatReplyTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Why a request was turned away, in the order the service lists them. */
export const REFUSAL_REASON_LABELS: Record<SupportRefusalReason, string> = {
  paused: "Support paused until balance is added",
  suspended: "Workspace suspended by Templ",
  "credit-limit": "Usage credit limit reached",
  "demo-limit": "Free ticket limit reached",
  "open-limit": "Open case limit reached",
  "record-limit": "Stored case limit reached",
  "daily-limit": "Daily new-case limit reached",
  "member-limit": "One person opened too many cases",
  "guest-limit": "Too many new guest cases from one network",
  "message-limit": "Message limit reached",
  "storage-busy": "Storage was catching up",
  "origin-not-approved": "Widget opened on a site you haven’t approved",
};
export const TURNED_AWAY = {
  title: "Turned away",
  planTitle: "Turned away in the last 30 days",
  footer:
    "Counts only. Templ doesn’t keep who was turned away or what they wrote.",
} as const;
const approx = (count: number, approximate: boolean, start: boolean) =>
  approximate
    ? `${start ? "About" : "about"} ${count.toLocaleString("en-US")}`
    : count.toLocaleString("en-US");
const countOf = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
const sum = (counts: Partial<Record<SupportRefusalReason, number>>) =>
  SUPPORT_REFUSAL_REASONS.reduce(
    (total, reason) => total + countOf(counts[reason]),
    0,
  );
/** The day in UTC, as the service names its day records. */
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
/** Totals and one line per reason with a count, in the service's order. */
export function turnedAway(refusals: SupportRefusals, now = Date.now()) {
  const today = refusals.days.find((day) => day.day === utcDay(now));
  const total = sum(refusals.totals);
  return {
    total,
    today: today ? sum(today.counts) : 0,
    todayApproximate: today?.approximate === true,
    approximate: refusals.approximate,
    reasons: SUPPORT_REFUSAL_REASONS.flatMap((reason) =>
      countOf(refusals.totals[reason])
        ? [
            {
              reason,
              label: REFUSAL_REASON_LABELS[reason],
              count: countOf(refusals.totals[reason]),
            },
          ]
        : [],
    ),
  };
}
/** "2 today, 9 in the last 7 days", with "About" on counts that may hold
 * a retry twice. */
export function turnedAwayWeek(summary: ReturnType<typeof turnedAway>) {
  return `${approx(summary.today, summary.todayApproximate, true)} today, ${approx(summary.total, summary.approximate, false)} in the last 7 days`;
}
/** "9 requests", or "About 9 requests". */
export function turnedAwayTotal(summary: ReturnType<typeof turnedAway>) {
  return `${approx(summary.total, summary.approximate, true)} ${summary.total === 1 ? "case" : "cases"}`;
}

/** Cases that need a reply from a person. */
export const NEEDS_YOU = {
  title: "Needs you",
  openInbox: "Open inbox",
} as const;
/** "Nothing needs you.", the inbox's own words. */
export const nothingNeedsYou = () => t("room.inbox.emptyNeedsYou");
/** "1 request needs you", "3+ requests need you". */
export function needsYouHeadline(count: number, more: boolean) {
  const n = `${count.toLocaleString("en-US")}${more ? "+" : ""}`;
  return count === 1 && !more
    ? `${n} case needs you`
    : `${n} cases need you`;
}
/** "The oldest has waited 22 min." */
export function oldestWaitLine(since: string, now = Date.now()) {
  const age = waitAge(since, now);
  return age === "<1 min"
    ? "The oldest has waited under a minute."
    : `The oldest has waited ${age}.`;
}
/** "The AI agent is handling 2 requests.", as the inbox says it. */
export function aiHandlingLine(count: number) {
  return t(count === 1 ? "room.inbox.aiBusyOne" : "room.inbox.aiBusyMany", {
    n: count.toLocaleString("en-US"),
  });
}
/** Browser alerts come from an open Templ tab; nothing arrives with Templ
 * closed. */
export const ALERT_NUDGE =
  "Keep Templ open in a tab to get a browser alert when a case needs you.";
