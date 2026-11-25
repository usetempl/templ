"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { IconRefresh } from "@tabler/icons-react";
import {
  SUPPORT_LIMITS,
  SUPPORT_REPORT_WINDOWS,
  type SupportReport,
  type SupportReportWindow,
} from "@templ/chat/support";
import {
  readSupportPulse,
  readSupportReport,
  type SupportPulseRead,
} from "@/lib/support-insights-client";
import { REPORT_WINDOW_LABELS, formatReplyTime } from "@/lib/copy/insights";
import { Card, PageHeader, Skeleton, Stat } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { useWorkspaceSectionFocus } from "./workspace-sections";

const AnswerReviews = dynamic(
  () =>
    import("./workspace-quality")
      .then((module) => module.QualityPage)
      .catch(() => ReviewsUnavailable),
  { loading: () => <Skeleton height={84} /> },
);
function ReviewsUnavailable() {
  return (
    <p role="alert">
      Answer reviews could not load. Reload this page to try again.
    </p>
  );
}
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const replyTime = (value: number | null) =>
  value === null ? "No replies yet" : formatReplyTime(value);

function checkedReport(report: SupportReport, window: SupportReportWindow) {
  if (
    !report ||
    ![2, 3].includes(report.schemaVersion) ||
    report.window !== window ||
    !date(report.to) ||
    ![
      report.requests,
      report.unanswered,
      report.resolved,
      report.reopened,
    ].every(natural) ||
    ![report.medianFirstResponseMs, report.medianFirstReplyMs].every(
      (value) => value === null || natural(value),
    ) ||
    typeof report.complete !== "boolean" ||
    typeof report.truncated !== "boolean"
  )
    throw new Error("Reports could not load.");
  return report;
}

type Snapshot = {
  key: string;
  report?: SupportReport;
  pulse?: SupportPulseRead;
  error?: boolean;
};

/** Reports retain the worker's current role checks and measured time units. */
export function WorkspaceReports({ context }: { context: WorkspaceContext }) {
  const team =
    context.manager ||
    context.state.viewer.permissions.includes("handleConversations");
  if (!context.account || !team || context.state.features?.quality !== true)
    return null;
  return <Reports context={context} />;
}

function Reports({ context }: { context: WorkspaceContext }) {
  useWorkspaceSectionFocus(["answer-reviews"]);
  const lead =
    context.manager ||
    context.state.viewer.permissions.includes("manageSupport");
  const [window, setWindow] = useState<SupportReportWindow>("30d");
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const key = `${context.room}:${context.account}:${context.revision}:${lead}:${window}:${retry}`;
  const current = snapshot?.key === key ? snapshot : undefined;
  useEffect(() => {
    const controller = new AbortController();
    const load = lead
      ? readSupportReport(context.room, window, controller.signal).then(
          (report) => ({
            report: checkedReport(report, window),
          }),
        )
      : readSupportPulse(context.room, controller.signal).then((pulse) => {
          if (!date(pulse.at)) throw new Error("Reports could not load.");
          return { pulse };
        });
    void load.then(
      (data) => !controller.signal.aborted && setSnapshot({ key, ...data }),
      () => !controller.signal.aborted && setSnapshot({ key, error: true }),
    );
    return () => controller.abort();
  }, [context.room, lead, window, key]);

  const refresh = () => setRetry((value) => value + 1);
  const report = current?.report;
  const pulse = current?.pulse;
  const measuredAt = report?.to ?? pulse?.at;
  const waiting = (value: number | undefined, more?: boolean) =>
    natural(value) ? `${more ? "At least " : ""}${value}` : "Unavailable";
  return (
    <div className={styles.page}>
      <div className={styles.stack}>
        <PageHeader
          title="Reports"
          description="Review workload, reply times and answer quality."
          actions={
            <button
              type="button"
              className="button secondary"
              disabled={!current}
              onClick={refresh}
            >
              <IconRefresh aria-hidden="true" /> Refresh
            </button>
          }
        />
        <Card
          title={lead ? "Support activity" : "Live workload"}
          actions={
            lead ? (
              <div
                className={styles.reportWindows}
                role="group"
                aria-label="Report period"
              >
                {SUPPORT_REPORT_WINDOWS.map((period) => (
                  <button
                    key={period}
                    type="button"
                    aria-pressed={window === period}
                    onClick={() => setWindow(period)}
                  >
                    {period === "all"
                      ? "All retained"
                      : REPORT_WINDOW_LABELS[period]}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          {!current ? (
            <div className={styles.grid3} aria-label="Loading report">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} height={84} />
              ))}
            </div>
          ) : current.error ? (
            <div className={styles.stack}>
              <p role="alert">Reports could not load. Try again.</p>
              <div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={refresh}
                >
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={styles.grid3}>
                {report ? (
                  <>
                    <Stat label="Cases opened" value={report.requests} />
                    <Stat label="Resolved" value={report.resolved} />
                    <Stat
                      label="Waiting for reply"
                      value={report.unanswered}
                      hint="Now"
                    />
                    <Stat
                      label="First reply"
                      value={replyTime(report.medianFirstReplyMs)}
                      hint="Median, including AI"
                    />
                    <Stat
                      label="First human reply"
                      value={replyTime(report.medianFirstResponseMs)}
                      hint="Median"
                    />
                    <Stat label="Reopened" value={report.reopened} />
                  </>
                ) : (
                  <>
                    <Stat
                      label="Needs you"
                      value={waiting(pulse?.needsYou, pulse?.needsReplyMore)}
                    />
                    <Stat
                      label="AI is handling"
                      value={waiting(pulse?.aiHandling, pulse?.needsReplyMore)}
                    />
                    <Stat
                      label="Waiting on user"
                      value={waiting(
                        pulse?.waitingOnMember,
                        pulse?.waitingOnMemberMore,
                      )}
                    />
                  </>
                )}
              </div>
              {measuredAt && (
                <p className={styles.small}>
                  Updated{" "}
                  <time dateTime={measuredAt}>
                    {new Date(measuredAt).toLocaleString()}
                  </time>
                  .
                </p>
              )}
              {report ? (
                <>
                  <p className={styles.small}>
                    Cases and reply times cover cases opened in this period.
                    Spam and test cases are excluded.
                  </p>
                  <p className={styles.small}>
                    Resolved counts include team and AI status changes. Review
                    member confirmation, corrections and reopened cases before
                    treating an answer as a successful AI resolution.
                  </p>
                  <p className={styles.small}>
                    Composing time measures typing only. Total time is the
                    optional range a person records when resolving a case.
                    Customer charges do not measure delivery cost. Provider and
                    shared hosting costs need separate reconciliation.
                  </p>
                  {report.truncated && (
                    <p className={styles.small}>
                      Counts cover the newest{" "}
                      {SUPPORT_LIMITS.reportCaseScan.toLocaleString("en-US")}{" "}
                      cases.
                    </p>
                  )}
                </>
              ) : (
                <p className={styles.small}>
                  Your workspace manager or support lead can view reply times.
                </p>
              )}
              {(report?.complete === false || pulse?.complete === false) && (
                <p role="status">Templ is still counting cases.</p>
              )}
            </>
          )}
        </Card>
        <section id="answer-reviews">
          <h3>Answer reviews</h3>
            <AnswerReviews
              key={`${context.room}:${context.account}`}
              context={context}
            />
        </section>
      </div>
    </div>
  );
}
