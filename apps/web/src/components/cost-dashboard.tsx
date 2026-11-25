"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  COST_METRICS,
  COST_RATE_SOURCES,
  WEB2_COST_POLICY,
  type CostDashboard,
  type CostMetric,
} from "@templ/chat/web2-costs";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import { costAdmin } from "@/lib/cost-admin-client";
import { WorkspaceCostTable } from "./workspace-cost-table";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import styles from "./cost-dashboard.module.css";
const usd = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value);
const number = (value: number | null | undefined) =>
  value == null
    ? "Not observed"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
        value,
      );
const stamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "No observations yet";
const statuses = {
  incomplete: "Budget status is incomplete",
  "below-target": "Recorded cost is below the monthly target",
  "over-target": "Cost has reached the monthly target",
  "over-ceiling": "Cost has reached the monthly ceiling",
};

export function CostDashboardPanel() {
  const auth = useChatAuth();
  const principal = auth.session?.principalId;
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const [signInError, setSignInError] = useState("");
  return (
    <main className={styles.page}>
      <h1>Operating costs</h1>
      <p>
        Web infrastructure has a {usd(WEB2_COST_POLICY.monthlyTargetUsd)}{" "}
        monthly target and a {usd(WEB2_COST_POLICY.monthlyCeilingUsd)} ceiling.
        Gas, token transfers and product purchases are outside this budget.
      </p>
      {auth.restoring ? (
        <p role="status">Checking sign-in…</p>
      ) : !principal ? (
        <div>
          <p>
            Sign in with a Templ operator account to see costs and workload.
          </p>
          <button
            type="button"
            onClick={() => {
              setSignInError("");
              void auth.signIn().catch((error) => {
                if (!isChatSignInCanceled(error))
                  setSignInError("Sign-in did not finish. Try again.");
              });
            }}
          >
            Sign in
          </button>
          {signInError && <p role="alert">{signInError}</p>}
        </div>
      ) : (
        <Costs key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}
function Costs({ principal }: { principal: ChatPrincipalId }) {
  const today = new Date();
  const currentMonth = today.toISOString().slice(0, 7);
  const previous = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<CostDashboard>();
  const [loadedRefresh, setLoadedRefresh] = useState(-1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      setError("Cost information took too long. Try again.");
      setLoading(false);
      controller.abort();
    }, 15_000);
    setLoading(true);
    setError("");
    setData(undefined);
    void costAdmin(principal)
      .read(month, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setLoadedRefresh(refresh);
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setData(undefined);
        setError(
          reason instanceof CommunityApiError && reason.status === 403
            ? "This page is for Templ operators."
            : "Cost information could not be loaded. Try again.",
        );
      })
      .finally(() => {
        clearTimeout(deadline);
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [principal, month, refresh]);
  const currentData =
    data?.month === month && loadedRefresh === refresh ? data : undefined;
  return (
    <>
      <div className={styles.controls}>
        <label>
          Month (UTC)
          <select
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          >
            <option value={currentMonth}>{currentMonth}</option>
            <option value={previous}>{previous}</option>
          </select>
        </label>
        <button
          type="button"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </button>
      </div>
      {loading && <p role="status">Loading cost information…</p>}
      {error && <p role="alert">{error}</p>}
      {currentData?.workspaceCosts && (
        <WorkspaceCostTable
          key={`${principal}:${month}:${refresh}`}
          initial={currentData.workspaceCosts}
          principal={principal}
        />
      )}
      {currentData && <CostView data={currentData} />}
    </>
  );
}
export function CostView({ data }: { data: CostDashboard }) {
  const storageLimit = data.storageWriteLimitBytes;
  const size = (bytes: number) =>
    bytes >= 1_000_000_000
      ? `${number(bytes / 1_000_000_000)} GB`
      : `${number(bytes / 1_000_000)} MB`;
  const observationsStale =
    data.month === data.generatedAt.slice(0, 7) &&
    (data.lastObservedAt === null ||
      Date.parse(data.generatedAt) - Date.parse(data.lastObservedAt) >
        24 * 60 * 60 * 1000);
  const attention = [
    data.values.rpcBlockedAttempts?.observed
      ? "RPC budget refusals were observed. Check provider errors and repeated verification work before changing a budget."
      : "",
    data.values.archiveFailures?.observed
      ? "Some support archive copies failed. Check that the backlog drains and accepted writes remain readable."
      : "",
    data.values.emailUnknown?.observed
      ? "Some email responses were uncertain. Inspect sender diagnostics without retrying under a new delivery identity."
      : "",
    data.values.databaseBytes &&
    storageLimit &&
    data.values.databaseBytes.observed >= storageLimit * 0.75
      ? `A room is past ${size(storageLimit * 0.75)}. Check history rollover before posts reach its ${size(storageLimit)} write limit.`
      : "",
  ].filter(Boolean);
  return (
    <>
      <section aria-labelledby="cost-summary">
        <h2 id="cost-summary">{statuses[data.budgetStatus]}</h2>
        <p>
          {data.budgetBasis === "partial-estimate"
            ? "Status uses the partial usage estimate."
            : data.budgetBasis === "invoice"
              ? "Status uses the recorded invoice amount."
              : "Cost coverage is not available."}
        </p>
        <div className={styles.summary}>
          <div>
            <h3>Budget invoice total</h3>
            <strong>{usd(data.invoice?.totalUsd ?? null)}</strong>
            <p>
              {data.invoice
                ? `${data.invoice.coverage === "all-web2" ? "All web infrastructure" : "Partial coverage"}, ${data.invoice.source === "provider-feed" ? "from a provider feed" : "entered by an operator"}. As of ${stamp(data.invoice.asOf)}.`
                : data.workspaceCosts
                  ? "No invoice total is assigned to this budget. Provider account invoices are listed above."
                  : "No invoice or provider billing feed is connected."}
            </p>
          </div>
          <div>
            <h3>Partial usage estimate</h3>
            <strong>{usd(data.estimatedSubtotalUsd)}</strong>
            <p>
              Sampled API, RPC and email usage at the rates below, plus the
              listed monthly fixed costs. This is not a provider bill.
            </p>
          </div>
        </div>
        <p>
          A partial estimate cannot establish that total spending is below
          budget. This view does not upgrade plans, authorize payments or stop
          case messages.
        </p>
        {data.collection === "unavailable" && (
          <p role="alert">
            Some usage collectors are unavailable. The observations below may be
            incomplete.
          </p>
        )}
        {observationsStale && (
          <p role="status">
            {data.lastObservedAt === null
              ? "No usage observations have been recorded for this month."
              : "No new usage observations have been recorded in the past 24 hours."}{" "}
            Traffic may be quiet, or collection may have failed. A successful
            refresh only confirms that stored observations could be read.
          </p>
        )}
        <p>
          First observation: {stamp(data.firstObservedAt)}. Last observation:{" "}
          {stamp(data.lastObservedAt)}. View updated: {stamp(data.generatedAt)}.
        </p>
        <p>
          Window: {stamp(data.windowStart)} to {stamp(data.windowEnd)}. Daily
          buckets use UTC and are kept for {data.policy.retentionDays} days.
        </p>
      </section>
      <section aria-labelledby="cost-breakdown">
        <h2 id="cost-breakdown">Estimated cost breakdown</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Workload</th>
                <th>Estimated units</th>
                <th>USD per million</th>
                <th>Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {data.estimates.map((row) => (
                <tr key={row.metric}>
                  <th>{COST_METRICS[row.metric].label}</th>
                  <td>{number(data.values[row.metric]?.estimated)}</td>
                  <td>
                    {data.rates?.usdPerMillion[row.metric] === undefined
                      ? "Unavailable"
                      : new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 6,
                        }).format(data.rates.usdPerMillion[row.metric]!)}
                  </td>
                  <td>{usd(row.usd)}</td>
                </tr>
              ))}
              <tr>
                <th>Monthly fixed costs</th>
                <td colSpan={2}>
                  {data.rates?.referenceVersion
                    ? "Workers paid-plan reference"
                    : "Operator configuration"}
                </td>
                <td>{usd(data.rates?.monthlyFixedUsd ?? null)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          {data.rates?.referenceVersion
            ? `Public reference rates, version ${data.rates.referenceVersion}.`
            : data.rates
              ? `Operator rates updated ${stamp(data.rates.updatedAt)}.`
              : "Pricing configuration is unavailable."}{" "}
          Estimates exclude provider allowances and volume discounts. RPC units
          are admission weights and may differ from billed units; email retries
          may be deduplicated by the provider.
        </p>
        {data.rates?.referenceVersion && (
          <p>
            Sources:{" "}
            {COST_RATE_SOURCES.map((source, index) => (
              <span key={source.url}>
                {index > 0 ? ", " : ""}
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.label}
                </a>
              </span>
            ))}
            . These rates do not identify Templ’s provider plans. Extra
            subscriptions and throughput capacity are excluded.
          </p>
        )}
        <p>
          Total stored bytes, database billing rows, CPU time, web/docs/blog
          hosting, CI and other provider charges are not measured here. Add them
          to invoice reporting and review fixed costs separately. Alerts appear
          on this dashboard only; no budget emails or push alerts are sent.
        </p>
      </section>
      <section aria-labelledby="cost-workload">
        <h2 id="cost-workload">Observed workload</h2>
        <p>
          {data.sampleRate.min === null
            ? "No sampled observations are available."
            : `Recorded batches used sample rates from ${number(data.sampleRate.min * 100)}% to ${number((data.sampleRate.max ?? data.sampleRate.min) * 100)}%.`}{" "}
          Extrapolated counts are estimates. Largest observed values are
          individual room or media-shard snapshots, not totals. Collection is
          best effort; failed telemetry writes are not retried.
        </p>
        <p>
          RPC budget object requests count only the authorization budget path.
          Media shard readings show the busiest sampled shard, not total R2
          storage. Check Cloudflare billing for database rows, object operations
          and storage before deciding the whole month is below budget.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Observed</th>
                <th>Extrapolated</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(COST_METRICS) as CostMetric[]).map((metric) => (
                <tr key={metric}>
                  <th>{COST_METRICS[metric].label}</th>
                  <td>
                    {number(data.values[metric]?.observed)}{" "}
                    {data.values[metric] ? COST_METRICS[metric].unit : ""}
                  </td>
                  <td>
                    {COST_METRICS[metric].kind === "maximum"
                      ? "Not extrapolated"
                      : number(data.values[metric]?.estimated)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {attention.length > 0 && (
        <section>
          <h2>Investigate next</h2>
          <ul>
            {attention.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>Daily API and verification activity</h3>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th>Observed API requests</th>
                <th>Observed primary RPC units</th>
                <th>Observed email attempts</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((day) => (
                <tr key={day.day}>
                  <th>{day.day}</th>
                  <td>{number(day.values.requests?.observed)}</td>
                  <td>{number(day.values.rpcPrimaryComputeUnits?.observed)}</td>
                  <td>{number(day.values.emailAttempts?.observed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
