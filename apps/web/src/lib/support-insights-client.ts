import type { ChatRoomId } from "@templ/chat/index";
import {
  SUPPORT_REPORT_WINDOWS,
  type SupportPulse,
  type SupportPulseV2,
  type SupportRefusals,
  type SupportReport,
  type SupportReportWindow,
} from "@templ/chat/support";
import { communityFetch, roomPath } from "./community-client";

/** Reads for the workspace's own numbers: the live queue counts (pulse),
 * the support report and the turned-away counts. Each route answers counts
 * and times only, and the worker checks the viewer's current access on
 * every read. */

/** The pulse fields every worker with the pulse route answers. */
type PulseBase = Pick<
  SupportPulse,
  | "schemaVersion"
  | "needsReply"
  | "needsReplyMore"
  | "oldestWaitingSince"
  | "newestWaitingSince"
  | "complete"
>;
/** The split into Needs you and AI is handling, and the agent's check-in.
 * A pulse without them still reads; see pulseCounts in inbox-attention.ts. */
type PulseSplit = Pick<
  SupportPulse,
  | "needsYou"
  | "needsYouOldestSince"
  | "needsYouNewestSince"
  | "aiHandling"
  | "agentRegistered"
  | "agentActive"
  | "agentSeenAt"
>;
export type SupportPulseRead = Omit<PulseBase, "schemaVersion"> & {
  schemaVersion: 1 | 2;
} & Partial<Pick<SupportPulseV2, "waitingOnMember" | "waitingOnMemberMore">> &
  Partial<PulseSplit> &
  Partial<Omit<SupportPulse, keyof PulseBase | keyof PulseSplit>>;

/** The manager and staff who answer chats; anyone else gets 404. */
export async function readSupportPulse(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<SupportPulseRead> {
  const pulse = await communityFetch<SupportPulseRead>(
    roomPath(room, "conversations/pulse"),
    undefined,
    signal,
  );
  if (
    !pulse ||
    typeof pulse !== "object" ||
    typeof pulse.schemaVersion !== "number" ||
    pulse.schemaVersion < 1 ||
    !Number.isSafeInteger(pulse.needsReply) ||
    pulse.needsReply < 0 ||
    typeof pulse.needsReplyMore !== "boolean" ||
    typeof pulse.complete !== "boolean"
  )
    throw new Error("The inbox counts could not be read.");
  return pulse;
}

export const isReportWindow = (value: unknown): value is SupportReportWindow =>
  SUPPORT_REPORT_WINDOWS.includes(value as SupportReportWindow);

/** The manager and support leads. The report counts requests opened in the
 * window; "Waiting for a reply" is always now. */
export async function readSupportReport(
  room: ChatRoomId,
  window: SupportReportWindow,
  signal?: AbortSignal,
): Promise<SupportReport> {
  if (!isReportWindow(window))
    throw new Error("Choose 7, 30 or 90 days, or all.");
  const { report } = await communityFetch<{ report: SupportReport }>(
    roomPath(room, `conversations/report?window=${window}`),
    undefined,
    signal,
  );
  return report;
}

export const REFUSAL_DAYS = [1, 7, 30] as const;
export type RefusalDays = (typeof REFUSAL_DAYS)[number];
export type SupportRefusalsRead = SupportRefusals & {
  /** The widget's count of opens on sites the workspace didn't approve
   * couldn't be added this time. */
  originCountsUnavailable?: boolean;
};
/** The manager, billing staff and support leads. Counts by day and reason,
 * with no person, text or address. */
export async function readSupportRefusals(
  room: ChatRoomId,
  days: RefusalDays,
  signal?: AbortSignal,
): Promise<SupportRefusalsRead> {
  if (!REFUSAL_DAYS.includes(days)) throw new Error("Choose 1, 7 or 30 days.");
  const refusals = await communityFetch<SupportRefusalsRead>(
    roomPath(room, `conversations/refusals?days=${days}`),
    undefined,
    signal,
  );
  if (
    !refusals ||
    !Array.isArray(refusals.days) ||
    refusals.days.some(
      (day) =>
        !day ||
        typeof day.day !== "string" ||
        !day.counts ||
        typeof day.counts !== "object",
    ) ||
    !refusals.totals ||
    typeof refusals.totals !== "object" ||
    Object.values(refusals.totals).some(
      (count) => !Number.isSafeInteger(count) || (count as number) < 0,
    ) ||
    typeof refusals.approximate !== "boolean"
  )
    throw new Error("The turned-away counts could not be read.");
  return refusals;
}
