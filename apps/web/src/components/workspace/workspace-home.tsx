"use client";

import { hasSupportKnowledge } from "@templ/chat/workspace-flags";

import { useEffect, useState } from "react";
import {
  IconArrowRight,
  IconBook,
  IconCheck,
  IconInbox,
  IconMessageCircle,
} from "@tabler/icons-react";
import {
  SUPPORT_REPORT_WINDOWS,
  type SupportReport,
  type SupportReportWindow,
} from "@templ/chat/support";
import {
  balanceLabel,
  isBillingView,
  planSummary,
  supportClosed,
  supportClosedMessage,
} from "@/lib/product-offer";
import { formatUsd } from "@/lib/product-format";
import { SITE } from "@/lib/release-public";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { trackEvent } from "@/lib/analytics";
import { CommunityApiError } from "@/lib/community-client";
import { copy as t } from "@/lib/copy";
import {
  REPORT_LABELS,
  REPORT_WINDOW_LABELS,
  TURNED_AWAY,
  NEEDS_YOU,
  aiHandlingLine,
  formatReplyTime,
  needsYouHeadline,
  nothingNeedsYou,
  oldestWaitLine,
  reportNotes,
  turnedAway,
  turnedAwayWeek,
} from "@/lib/copy/insights";
import {
  readSupportRefusals,
  readSupportReport,
  type SupportRefusalsRead,
} from "@/lib/support-insights-client";
import { writeSupportInboxState } from "@/lib/support-local-state";
import { TemplMark } from "@/components/brand/templ-mark";
import { agentOfflineLine, useInboxCounts } from "@/components/inbox-views";
import {
  Badge,
  Callout,
  Card,
  CopyInline,
  Meter,
  Skeleton,
  Stat,
} from "@/components/ui/ui";
import { InboxAlertsNudge } from "./inbox-alerts";
import { HostedChatSetup } from "./hosted-chat-setup";
import { AppApprovalRequestButton } from "@/components/app-approval-request";
import type { WorkspaceContext, WorkspaceTab } from "./support-workspace";
import {
  readWorkspaceSetup,
  takeWorkspaceSetup,
  type SetupRead,
  type WorkspaceSetup,
} from "./workspace-reads";
import styles from "./workspace.module.css";

type Setup = Omit<WorkspaceSetup, "failed"> & {
  scope: string;
  /** "setup" when the reads as a whole failed. */
  failed?: (SetupRead | "setup")[];
};

/** What each failed setup read leaves unknown. */
const SETUP_READ_NAMES: Record<SetupRead | "setup", string> = {
  install: "the install check",
  requests: "your case list",
  priorities: "your contract picks",
  team: "your team list",
  widget: "your widget settings",
  setup: "your setup details",
};
const listNames = (names: string[]) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export function WorkspaceHome({
  context,
  installCheck = context.state?.features?.installCheck === true,
}: {
  context: WorkspaceContext;
  installCheck?: boolean;
}) {

  const { room, workspace, manager, billing, go, revision, account } = context;
  const lead =
    context.state?.viewer?.permissions?.includes("manageSupport") === true;
  const priorityFeed = context.state?.features?.priorityFeed === true;
  const product = context.state?.product;
  const standard =
    product && isBillingView(product) ? product.standardPlan : undefined;
  const approvedUsage =
    product &&
    isBillingView(product) &&
    (standard?.status === "paid" ||
      product.mode === "exempt" ||
      (!!product.usageBilling?.agreement &&
        ["active", "credit-limit"].includes(
          product.usageBilling?.status ?? "",
        )));
  const scope = `${room}:${account ?? "signed-out"}:${revision}:${manager}:${installCheck}:${priorityFeed}`;
  // A retry reads again from loading; the last attempt's answers never
  // show as current. A new scope starts again from the page's prefetch.
  const [retried, setRetried] = useState<{ scope: string; count: number }>();
  const attempt = retried?.scope === scope ? retried.count : 0;
  const retrySetup = () => setRetried({ scope, count: attempt + 1 });
  const readKey = `${scope}:${attempt}`;
  const [setup, setSetup] = useState<Setup>();
  const current = setup?.scope === readKey ? setup : undefined;
  useEffect(() => {
    const controller = new AbortController();
    // The workspace page may have started these with its own reads.
    const reads =
      (attempt === 0
        ? takeWorkspaceSetup(
            room,
            account,
            revision,
            manager,
            installCheck,
            priorityFeed,
          )
        : undefined) ??
      readWorkspaceSetup(
        room,
        manager,
        controller.signal,
        installCheck,
        priorityFeed,
      );
    void reads.then(
      (results) => {
        if (!controller.signal.aborted)
          setSetup({ scope: readKey, ...results });
      },
      () => {
        if (!controller.signal.aborted)
          setSetup({
            scope: readKey,
            reportError: true,
            failed: manager ? ["setup"] : undefined,
          });
      },
    );
    return () => controller.abort();
  }, [
    room,
    account,
    revision,
    manager,
    readKey,
    attempt,
    installCheck,
    priorityFeed,
  ]);
  const failedReads = current?.failed ?? [];
  const staff = current?.staff;

  const steps: {
    done: boolean | undefined;
    title: string;
    body: string;
    action: string;
    tab: WorkspaceTab;
    /** Counted when a manager opens a step that is not done yet. */
    event:
      | "setup_snippet_clicked"
      | "setup_team_clicked"
      | "setup_priorities_clicked";
    optional?: boolean;
  }[] = [
    {
      done: current?.hostedPage || (installCheck ? current?.installChecked : current?.hasRequests),
      title: "Choose where people ask for help",
      body: "Embed the widget in your app, share a standalone chat link, or use both. Cases reach this inbox.",
      action: "Set up support",
      tab: "widget",
      event: "setup_snippet_clicked",
    },
    ...(priorityFeed
      ? [
          {
            done: current?.priorityContractsPicked,
            title: "Pick your contracts",
            body: "Choose contracts from your app profile for wallet position checks in Priorities.",
            action: "Pick contracts",
            tab: "settings" as const,
            event: "setup_priorities_clicked" as const,
            optional: true,
          },
        ]
      : []),
    {
      // Unknown while loading or when the team list failed, never zero.
      done: staff === undefined ? undefined : staff > 0,
      title: "Invite your team",
      body: "Give teammates access to read and answer cases. You can do this later.",
      action: "Add teammate",
      tab: "team",
      event: "setup_team_clicked",
      optional: true,
    },
  ];
  const required = steps.filter((step) => !step.optional);
  const completed = required.filter((step) => step.done).length;
  const ready = completed === required.length;
  // While loading, or when a required step's read failed, Home claims
  // neither progress nor completion.
  const known = required.every((step) => step.done !== undefined);
  const unfinished = manager && known && !ready;
  const allDone = steps.every((step) => step.done === true);
  const currentStep = steps.findIndex((step) => step.done !== true);
  // The report opens on the service's default, 30 days; another period is
  // read when someone picks it.
  const [picked, setPicked] = useState<{
    scope: string;
    period: SupportReportWindow;
  }>();
  const [periodAttempt, setPeriodAttempt] = useState(0);
  const period = picked?.scope === scope ? picked.period : null;
  const periodKey = period ? `${readKey}:${period}:${periodAttempt}` : null;
  const [windowed, setWindowed] = useState<{
    key: string;
    report?: SupportReport;
    error?: string;
  }>();
  useEffect(() => {
    if (!period || !periodKey) return;
    const controller = new AbortController();
    readSupportReport(room, period, controller.signal).then(
      (report) => {
        if (!controller.signal.aborted) setWindowed({ key: periodKey, report });
      },
      () => {
        if (!controller.signal.aborted)
          setWindowed({ key: periodKey, error: REPORT_LABELS.failed });
      },
    );
    return () => controller.abort();
  }, [room, period, periodKey]);
  const shown = windowed?.key === periodKey ? windowed : undefined;
  // Undefined while loading or after a failure; null when this viewer
  // can't read reports.
  const report = period ? shown?.report : current?.report;
  const reportError = period
    ? shown?.error
    : current?.reportError
      ? REPORT_LABELS.failed
      : undefined;
  const retryReport = () =>
    period ? setPeriodAttempt((value) => value + 1) : retrySetup();

  return (
    <div className={styles.page}>
      <div className={styles.stack}>
        {manager && current?.hostedPage && <HostedChatSetup
          key={`${room}:${account}`} context={context}
          paid={Boolean(approvedUsage)} />}
        <section className={styles.welcome} aria-labelledby="home-title">
          <TemplMark className={styles.welcomeStamp} decorative />
          <h1 id="home-title">
            {unfinished ? `Let’s get ${workspace.name} ready.` : workspace.name}
          </h1>
          {manager && standard?.status === "demo" ? (
            <p>
              Test your integration here. Pay for workspace access before
              inviting customers.
            </p>
          ) : unfinished ? (
            <p>
              Choose how visitors reach your team.
            </p>
          ) : !manager || ready ? (
            <p>
              Visitors reach your team through the support entry points you set up. New cases appear in the inbox.
            </p>
          ) : !current ? (
            <Skeleton width="60%" height={20} />
          ) : null}
          {unfinished && (
            <div className={styles.progress}>
              <div>
                <Meter
                  value={completed}
                  max={required.length}
                  label="Setup progress"
                />
              </div>
              <span>
                {completed} of {required.length} done
              </span>
            </div>
          )}
          {(ready || !manager || (current && !known)) && (
            <div className={styles.row} style={{ marginTop: 20 }}>
              <button
                type="button"
                className="button"
                onClick={() => go("inbox")}
              >
                <IconInbox aria-hidden="true" /> Open inbox
              </button>
              {manager && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => go("widget")}
                >
                  Widget settings
                </button>
              )}
            </div>
          )}
        </section>

        <NeedsYouCard context={context} />

        {manager &&
          !approvedUsage &&
          (standard ? (
            <Card
              title="Free integration"
              description={`${standard.ticketsUsed} of ${standard.ticketsTotal} test tickets used. Each ticket allows ${PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies. Templ AI is off.`}
            >
              <button
                type="button"
                className="button"
                onClick={() => go("plan")}
              >
                Go live
              </button>
            </Card>
          ) : (
            <Card
              title="App access"
              description="Free limits are for testing. Request full access before you invite customers."
            >
              <AppApprovalRequestButton
                workspace={context.id}
                appUrl={current?.origins?.[0] ?? ""}
              />
            </Card>
          ))}

        {manager && hasSupportKnowledge(context.state?.features) && (
          <Card
            title="AI knowledge"
            description="Add the docs and files your support AI can use. Unclear answers go to your team."
          >
            <button
              type="button"
              className="button secondary"
              onClick={() => go("knowledge")}
            >
              Add AI sources
            </button>
          </Card>
        )}

        {manager && failedReads.length > 0 && (
          <div>
            <Callout tone="danger" role="alert">
              Couldn’t load{" "}
              {listNames(failedReads.map((name) => SETUP_READ_NAMES[name]))}.
            </Callout>
            <button
              type="button"
              className="button secondary"
              style={{ marginTop: 10 }}
              onClick={retrySetup}
            >
              {t("shell.common.tryAgain")}
            </button>
          </div>
        )}

        {manager &&
          (!current ? (
            <Card title="Setup">
              <div className={styles.stack} style={{ gap: 12 }}>
                <Skeleton height={42} />
                <Skeleton height={42} />
              </div>
            </Card>
          ) : allDone ? (
            <section
              className={styles.setupComplete}
              aria-labelledby="setup-complete"
            >
              <TemplMark className={styles.setupCompleteStamp} decorative />
              <h2 id="setup-complete">{t("shell.setup.complete")}</h2>
            </section>
          ) : (
            <Card
              title={ready || !known ? "Setup" : "Get set up"}
              description={
                ready
                  ? standard?.status === "demo"
                    ? "Your integration is ready to test."
                    : "Everything users need is in place."
                  : undefined
              }
            >
              <ol className={styles.checklist}>
                {steps.map((step, index) => (
                  <li
                    key={step.title}
                    className={styles.check}
                    data-done={step.done === true}
                    data-state={
                      step.done
                        ? "done"
                        : index === currentStep
                          ? "current"
                          : "locked"
                    }
                    aria-current={index === currentStep ? "step" : undefined}
                  >
                    <span className={styles.checkMark}>
                      {step.done ? (
                        <IconCheck aria-label="Done" />
                      ) : (
                        <span
                          aria-label={
                            index === currentStep
                              ? "Current step"
                              : "Locked step"
                          }
                        >
                          {index + 1}
                        </span>
                      )}
                    </span>
                    <div>
                      <h3>
                        {step.title} {step.optional && <Badge>Optional</Badge>}{" "}
                        {step.done === undefined && (
                          <Badge tone="warning">Not checked</Badge>
                        )}
                      </h3>
                      <p>{step.body}</p>
                    </div>
                    <span className={styles.checkAction}>
                      <button
                        type="button"
                        className={`button small ${step.done ? "quiet" : index === currentStep ? "" : "secondary"}`}
                        disabled={!step.done && index !== currentStep}
                        onClick={() => {
                          if (!step.done) trackEvent(step.event);
                          if (step.event === "setup_priorities_clicked")
                            go(step.tab, null, "priority-settings");
                          else go(step.tab);
                        }}
                      >
                        {step.done ? "Review" : step.action}
                        {!step.done && <IconArrowRight aria-hidden="true" />}
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          ))}

        {current?.report !== null && (
          <section aria-labelledby="activity-title">
            <div className={styles.rowBetween} style={{ marginBottom: 12 }}>
              <h2
                id="activity-title"
                className={styles.sectionTitle}
                style={{ margin: 0 }}
              >
                Support activity
              </h2>
              <div
                className={styles.reportWindows}
                role="group"
                aria-label={REPORT_LABELS.period}
              >
                {SUPPORT_REPORT_WINDOWS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={(period ?? "30d") === item}
                    disabled={!current}
                    onClick={() => setPicked({ scope, period: item })}
                  >
                    {REPORT_WINDOW_LABELS[item]}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.grid4}>
              {report ? (
                <>
                  <Stat
                    label={REPORT_LABELS.requests}
                    value={report.requests}
                  />
                  <Stat
                    label={REPORT_LABELS.waiting}
                    value={report.unanswered}
                  />
                  <Stat
                    label={REPORT_LABELS.resolved}
                    value={report.resolved}
                  />
                  <Stat
                    label={REPORT_LABELS.firstReply}
                    value={
                      report.medianFirstResponseMs === null
                        ? "–"
                        : formatReplyTime(report.medianFirstResponseMs)
                    }
                  />
                </>
              ) : reportError ? null : (
                [0, 1, 2, 3].map((item) => <Skeleton key={item} height={84} />)
              )}
            </div>
            {reportError && (
              <div>
                <p
                  className={styles.error}
                  role="alert"
                  style={{ marginTop: 10 }}
                >
                  {reportError}
                </p>
                <button
                  type="button"
                  className="button small secondary"
                  onClick={retryReport}
                >
                  {t("shell.common.tryAgain")}
                </button>
              </div>
            )}
            {report && (
              <ul
                className={styles.small}
                style={{ margin: "10px 0 0", paddingLeft: 18 }}
              >
                {reportNotes(report).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        {(manager || billing || lead) && <TurnedAwayCard context={context} />}

        <div className={styles.grid2}>
          <PlanSummary context={context} />
          <Card
            title="Your workspace ID"
            description="Your workspace ID is already in the install prompt. It is safe to put in your app’s code."
          >
            <div className={styles.stack} style={{ gap: 14 }}>
              <CopyInline value={context.id} label="Copy" />
              <div className={styles.row}>
                <a className={styles.inlineLink} href={`${SITE.docs}/install`}>
                  <IconBook aria-hidden="true" /> Widget guide
                </a>
                <a className={styles.inlineLink} href={`${SITE.docs}/inbox`}>
                  <IconMessageCircle aria-hidden="true" /> Working the inbox
                </a>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Who a person on the team must answer now, from the counts the
 * workspace page reads for the inbox. Nothing shows until those counts
 * arrive, or while the service has none to give. */
function NeedsYouCard({ context }: { context: WorkspaceContext }) {
  const { room, account, go } = context;
  const { counts } = useInboxCounts(room, account);
  if (!counts) return null;
  const offline = agentOfflineLine(counts);
  const waiting = counts.needsYou > 0;
  const open = () => {
    // "Open inbox" here always lands on Needs you, not on a thread.
    writeSupportInboxState(room, account, {
      filter: "needs-you",
      selected: null,
    });
    go("inbox");
  };
  return (
    <Card
      title={
        waiting
          ? needsYouHeadline(counts.needsYou, counts.more)
          : NEEDS_YOU.title
      }
      actions={
        waiting ? (
          <button type="button" className="button small" onClick={open}>
            <IconInbox aria-hidden="true" /> {NEEDS_YOU.openInbox}
          </button>
        ) : undefined
      }
    >
      <div className={styles.stack} style={{ gap: 8 }}>
        {waiting ? (
          counts.needsYouOldestSince && (
            <p className={styles.muted} style={{ margin: 0 }}>
              {oldestWaitLine(counts.needsYouOldestSince)}
            </p>
          )
        ) : (
          <p className={styles.muted} style={{ margin: 0 }}>
            {nothingNeedsYou()}
            {counts.aiHandling > 0 && ` ${aiHandlingLine(counts.aiHandling)}`}
          </p>
        )}
        {offline && (
          <p className={styles.small} role="status" style={{ margin: 0 }}>
            {offline}
          </p>
        )}
        <InboxAlertsNudge
          className={styles.stack}
          textClassName={styles.small}
        />
      </div>
    </Card>
  );
}

/** Requests the team couldn't take in the last 7 days, by reason. Shown to
 * the manager, billing staff and support leads, and only when there were
 * some. Counts only. */
function TurnedAwayCard({ context }: { context: WorkspaceContext }) {
  const { room, account, revision } = context;
  const [attempt, setAttempt] = useState(0);
  const key = `${room}:${account}:${revision}:${attempt}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    refusals: SupportRefusalsRead | null;
    error?: boolean;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    readSupportRefusals(room, 7, controller.signal).then(
      (refusals) => {
        if (!controller.signal.aborted) setLoaded({ key, refusals });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            refusals: null,
            error: !(
              reason instanceof CommunityApiError &&
              [401, 403, 404].includes(reason.status)
            ),
          });
      },
    );
    return () => controller.abort();
  }, [room, key]);
  const refusals = loaded?.key === key ? loaded.refusals : null;
  if (loaded?.key === key && loaded.error)
    return (
      <Card title={TURNED_AWAY.title}>
        <p role="alert">Turned-away counts could not load.</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      </Card>
    );
  if (!refusals) return null;
  const summary = turnedAway(refusals);
  if (summary.total === 0) return null;
  return (
    <Card title={TURNED_AWAY.title} description={turnedAwayWeek(summary)}>
      <TurnedAwayReasons summary={summary} />
    </Card>
  );
}

/** One line per reason with its count, then what Templ keeps. */
export function TurnedAwayReasons({
  summary,
}: {
  summary: ReturnType<typeof turnedAway>;
}) {
  return (
    <div className={styles.stack} style={{ gap: 10 }}>
      <ul className={styles.stack} style={{ gap: 6, margin: 0, padding: 0 }}>
        {summary.reasons.map((item) => (
          <li
            key={item.reason}
            className={`${styles.rowBetween} ${styles.muted}`}
            style={{ listStyle: "none" }}
          >
            <span>{item.label}</span>
            <strong style={{ color: "var(--fg)" }}>
              {item.count.toLocaleString("en-US")}
            </strong>
          </li>
        ))}
      </ul>
      <p className={styles.small} style={{ margin: 0 }}>
        {TURNED_AWAY.footer}
      </p>
    </div>
  );
}

function PlanSummary({ context }: { context: WorkspaceContext }) {
  const product = context.state.product;
  if (!product) return null;
  // Only billing staff see amounts and counts; everyone else sees whether
  // Support takes new requests.
  const billing = context.billing && isBillingView(product) ? product : null;
  const standard = billing?.standardPlan;
  const usage = standard ? undefined : billing?.usageBilling;
  const mode = product.mode;
  const closed = billing
    ? usage && mode === "paused"
      ? "Support is paused. Open Plan to review billing."
      : supportClosedMessage(billing)
    : supportClosed(product)
      ? "Your team can’t take new cases right now."
      : null;
  const usageNotice =
    closed ??
    (usage?.status === "credit-limit"
      ? "The credit limit is reached. Pay the amount due to take new cases. Your team can answer existing cases."
      : null);
  return (
    <Card
      title="Plan"
      actions={
        context.billing ? (
          <button
            type="button"
            className="button small secondary"
            onClick={() => context.go("plan")}
          >
            Details
          </button>
        ) : undefined
      }
    >
      <div className={styles.planLine}>
        <div className={styles.rowBetween}>
          <strong>
            {standard
              ? standard.status === "paid"
                ? `Usage amount due ${formatUsd(standard.dueCents)}`
                : `${standard.ticketsUsed} of ${standard.ticketsTotal} test tickets used`
              : usage
                ? `Amount due ${formatUsd(usage.dueCents)}`
                : billing
                  ? balanceLabel(billing.balance.balanceCents)
                  : "Support"}
          </strong>
          <Badge
            tone={
              mode === "paused" ||
              mode === "suspended" ||
              usage?.status === "credit-limit" ||
              supportClosed(product)
                ? "danger"
                : "brand"
            }
            dot
          >
            {mode === "paused"
              ? "Paused"
              : mode === "suspended"
                ? "Suspended"
                : usage?.status === "credit-limit"
                  ? "Credit limit"
                  : supportClosed(product)
                    ? "Closed"
                    : standard?.status === "demo"
                      ? "Free integration"
                      : "Active"}
          </Badge>
        </div>
        {usage ? (
          <>
            <p className={styles.muted}>
              Credit limit {formatUsd(usage.debtLimitCents)}.
            </p>
            {usageNotice && <p className={styles.muted}>{usageNotice}</p>}
          </>
        ) : billing ? (
          <p className={styles.muted}>{planSummary(billing)}</p>
        ) : (
          closed && <p className={styles.muted}>{closed}</p>
        )}
      </div>
    </Card>
  );
}
