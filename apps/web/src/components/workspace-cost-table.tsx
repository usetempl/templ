"use client";

import { Fragment, useEffect, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  WorkspaceCostDetail,
  WorkspaceCostOverview,
  WorkspaceCostRow,
} from "@templ/chat/workspace-costs";
import { costAdmin } from "@/lib/cost-admin-client";
import { useCommunityDirectory } from "@/lib/community-directory";
import styles from "./cost-dashboard.module.css";

const money = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value);
const count = (value: number | null) =>
  value === null ? "Unavailable" : new Intl.NumberFormat("en-US").format(value);
const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        timeZone: "UTC",
        timeZoneName: "short",
      })
    : "Not recorded";
const scope = {
  customer: "Customer",
  "templ-own": "Templ",
  test: "Test",
  unknown: "Unclassified",
};
const status = {
  missing: "Missing data",
  partial: "Partial",
  reconciled: "Reconciled",
};
const resourceLabels = {
  requests: "API requests",
  "rpc-attempts": "RPC attempts",
  "email-attempts": "Email attempts",
  "email-accepted": "Emails accepted",
  "retained-byte-ms": "Stored byte-time",
  "storage-read-ops": "SQL read calls",
  "storage-write-ops": "SQL write calls",
  "storage-retained-bytes": "Uploaded text bytes",
};

export function WorkspaceCostTable({
  initial,
  principal,
}: {
  initial: WorkspaceCostOverview;
  principal: ChatPrincipalId;
}) {
  const directory = useCommunityDirectory();
  const [pages, setPages] = useState<WorkspaceCostOverview[]>([initial]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<WorkspaceCostRow | null>(null);
  const current = pages[pages.length - 1];
  useEffect(() => {
    if (cursor === null) return;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      setError("Workspace costs took too long. Try again.");
      controller.abort();
    }, 15_000);
    void costAdmin(principal)
      .workspaces(initial.month, cursor, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setPages((previous) => [...previous, value]);
          setCursor(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Workspace costs could not be loaded. Try again.");
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [cursor, initial.month, principal, retry]);
  const loading = cursor !== null && !error;
  if (selected) return (
    <section aria-label="Workspace costs">
      <button type="button" className={styles.rowToggle} onClick={() => setSelected(null)}>Back to workspace costs</button>
      <h2>{selected.name || selected.workspace}</h2>
      <WorkspaceCostDetails key={selected.workspace} row={selected} principal={principal} />
    </section>
  );
  return (
    <section aria-labelledby="workspace-economics">
      <h2 id="workspace-economics">Workspace economics</h2>
      <p>
        Revenue records service earned. Payments show money received. Missing
        costs keep totals and margins unavailable.
      </p>
      <div className={styles.reconciliation}>
        <div>
          <span>Provider invoices</span>
          <strong>{money(current.reconciliation.invoiceUsd)}</strong>
        </div>
        <div>
          <span>Direct costs</span>
          <strong>
            {money(
              current.reconciliation.invoiceUsd === null
                ? null
                : current.reconciliation.directUsd,
            )}
          </strong>
        </div>
        <div>
          <span>Shared allocations</span>
          <strong>
            {money(
              current.reconciliation.invoiceUsd === null
                ? null
                : current.reconciliation.allocatedUsd,
            )}
          </strong>
        </div>
        <div>
          <span>Unattributed</span>
          <strong>
            {money(
              current.reconciliation.invoiceUsd === null
                ? null
                : current.reconciliation.unattributedUsd,
            )}
          </strong>
        </div>
        <div>
          <span>Shared, unallocated</span>
          <strong>
            {money(
              current.reconciliation.invoiceUsd === null
                ? null
                : current.reconciliation.unallocatedSharedUsd,
            )}
          </strong>
        </div>
      </div>
      <p className={styles.muted}>
        {status[current.reconciliation.status]}. Invoices use their issue month.
        Unassigned provider costs can include other projects. Workspace totals
        include assigned costs only.
      </p>
      {current.missing.length > 0 && (
        <section>
          <h3>Missing sources</h3>
          <ul>
            {current.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      {loading ? (
        <p role="status">Loading workspace costs…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : current.rows.length === 0 ? (
        <p>
          No workspaces have accounting records for this month. Usage starts
          when a connected meter records it.
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.workspaceTable}`}>
            <caption className={styles.tableCaption}>
              Monthly workspace totals in USD
            </caption>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Revenue earned</th>
                <th scope="col">Payments received</th>
                <th scope="col">AI</th>
                <th scope="col">Hosting / storage</th>
                <th scope="col">RPC / email</th>
                <th scope="col">Total cost</th>
                <th scope="col">Cost per ticket</th>
                <th scope="col">Gross margin</th>
              </tr>
            </thead>
            <tbody>
              {current.rows.map((row) => (
                <WorkspaceCostRows
                  key={row.workspace}
                  row={{
                    ...row,
                    name:
                      row.name ||
                      directory.joined.find(
                        (item) => item.nativeRoom.id === row.workspace,
                      )?.nativeRoom.name ||
                      null,
                  }}
                  onSelect={setSelected}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.controls}>
        {pages.length > 1 && (
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setCursor(null);
              setError("");
              setPages((previous) => previous.slice(0, -1));
            }}
          >
            Previous
          </button>
        )}
        {current.nextCursor && (
          <button
            type="button"
            disabled={loading || Boolean(error)}
            onClick={() => setCursor(current.nextCursor)}
          >
            Next
          </button>
        )}
        <span className={styles.muted}>Updated {time(current.asOf)}</span>
      </div>
      <p className={styles.muted}>
        Cost per ticket includes unresolved cases opened this month. Gross
        margin excludes unrecorded labor and other business expenses.
      </p>
    </section>
  );
}

function WorkspaceCostRows({
  row,
  onSelect,
}: {
  row: WorkspaceCostRow;
  onSelect: (selected: WorkspaceCostRow) => void;
}) {
  const title =
    row.name || `${row.workspace.slice(0, 8)}…${row.workspace.slice(-4)}`;
  return (
      <tr>
        <th scope="row">
          <button
            type="button"
            className={styles.rowToggle}
            onClick={() => onSelect(row)}
            title={row.workspace}
          >
            {title}
          </button>
          <span className={styles.rowMeta}>
            {scope[row.category]}. {status[row.status]}.
          </span>
        </th>
        <td>{money(row.earnedRevenueUsd)}</td>
        <td>{money(row.paymentsReceivedUsd)}</td>
        <td>{money(row.aiUsd)}</td>
        <td>{money(row.hostingStorageUsd)}</td>
        <td>{money(row.rpcEmailUsd)}</td>
        <td>{money(row.totalUsd)}</td>
        <td>{money(row.costPerTicketUsd)}</td>
        <td>
          {row.grossMarginPercent === null
            ? "Unavailable"
            : `${row.grossMarginPercent.toFixed(1)}%`}
        </td>
      </tr>
  );
}

function WorkspaceCostDetails({
  row,
  principal,
}: {
  row: WorkspaceCostRow;
  principal: ChatPrincipalId;
}) {
  const [detail, setDetail] = useState<WorkspaceCostDetail>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      setError("Workspace details took too long. Try again.");
      controller.abort();
    }, 15_000);
    void costAdmin(principal)
      .workspace(row.month, row.workspace, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Workspace details could not be loaded. Try again.");
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [principal, row.month, row.workspace, retry]);
  if (error)
    return (
      <div role="alert">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => {
            setError("");
            setDetail(undefined);
            setRetry((value) => value + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  if (!detail) return <p role="status">Loading workspace details…</p>;
  const data = detail.row;
  const missing = [...new Set([...data.missing, ...detail.resourcesMissing])];
  return (
    <div className={styles.workspaceDetail}>
      <h3>Costs and coverage</h3>
      <dl className={styles.detailTotals}>
        <div>
          <dt>Direct costs</dt>
          <dd>{money(data.directUsd)}</dd>
        </div>
        <div>
          <dt>Shared allocations</dt>
          <dd>{money(data.sharedUsd)}</dd>
        </div>
        <div>
          <dt>Known subtotal</dt>
          <dd>{money(data.knownSubtotalUsd)}</dd>
        </div>
        <div>
          <dt>Tickets opened</dt>
          <dd>{count(data.ticketsOpened)}</dd>
        </div>
        <div>
          <dt>Confirmed AI resolutions</dt>
          <dd>{count(data.confirmedAiResolutions)}</dd>
        </div>
        <div>
          <dt>Cost per AI resolution</dt>
          <dd>{money(data.costPerConfirmedAiResolutionUsd)}</dd>
        </div>
      </dl>
      <p className={styles.muted}>
        Recording start: {time(data.coverageStartedAt)}. Latest usage:{" "}
        {time(data.usageUpdatedAt)}. Revenue snapshot:{" "}
        {time(data.financeUpdatedAt)}.
      </p>
      {missing.length > 0 && (
        <div>
          <h3>Missing data</h3>
          <ul>
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {detail.financeBasis.length > 0 && (
        <section>
          <h3>Revenue basis</h3>
          <ul>
            {detail.financeBasis.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      <h3>Daily AI usage</h3>
      {detail.days.every((day) => day.resources.length === 0) ? (
        <p>
          No AI usage is recorded for this month. Historical usage is
          unavailable.
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                <th scope="col">Provider / model</th>
                <th scope="col">Calls</th>
                <th scope="col">Input tokens</th>
                <th scope="col">Cached tokens</th>
                <th scope="col">Cache-write tokens</th>
                <th scope="col">Output tokens</th>
                <th scope="col">Reasoning tokens</th>
                <th scope="col">Missing usage</th>
              </tr>
            </thead>
            <tbody>
              {detail.days.map((day) => (
                <Fragment key={day.day}>
                  {day.resources.map((resource, index) => (
                    <tr
                      key={`${resource.producer}:${resource.provider}:${resource.model}:${resource.purpose}:${index}`}
                    >
                      <th scope="row">{day.day}</th>
                      <td>
                        {resource.provider} / {resource.model}
                        <span className={styles.rowMeta}>
                          {resource.purpose}
                        </span>
                        {Object.keys(resource.consumerOutcomes).length > 0 && (
                          <section>
                            <h3>Outcomes</h3>
                            <ul>
                              {Object.entries(resource.consumerOutcomes).map(
                                ([outcome, total]) => (
                                  <li key={outcome}>
                                    {outcome}: {count(total ?? null)}
                                  </li>
                                ),
                              )}
                            </ul>
                          </section>
                        )}
                      </td>
                      <td>
                        {count(resource.invocations)}
                        <span className={styles.rowMeta}>
                          {count(resource.failed)} failed,{" "}
                          {count(resource.pending)} pending
                        </span>
                      </td>
                      <td>{count(resource.usage.inputTokens)}</td>
                      <td>{count(resource.usage.cachedInputTokens)}</td>
                      <td>{count(resource.usage.cacheWriteInputTokens)}</td>
                      <td>{count(resource.usage.outputTokens)}</td>
                      <td>{count(resource.usage.reasoningTokens)}</td>
                      <td>{count(resource.missingUsage)}</td>
                    </tr>
                  ))}
                  {day.recordingGaps > 0 && (
                    <tr>
                      <td colSpan={9}>
                        {day.day}: {count(day.recordingGaps)} recording gaps.
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Daily resource usage</h3>
      {detail.days.every((day) => day.resourceTotals.length === 0) ? (
        <p>No workspace resource observations are recorded for this month.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                <th scope="col">Resource</th>
                <th scope="col">Provider</th>
                <th scope="col">Quantity</th>
                <th scope="col">Unit</th>
              </tr>
            </thead>
            <tbody>
              {detail.days.flatMap((day) =>
                day.resourceTotals.map((resource, index) => (
                  <tr
                    key={`${day.day}:${resource.metric}:${resource.instanceId ?? ""}:${index}`}
                  >
                    <th scope="row">{day.day}</th>
                    <td>
                      {resourceLabels[resource.metric]}
                      {resource.method && (
                        <span className={styles.rowMeta}>
                          {resource.method}
                        </span>
                      )}
                    </td>
                    <td>{resource.provider}</td>
                    <td>
                      {new Intl.NumberFormat("en-US").format(
                        BigInt(resource.quantity),
                      )}
                    </td>
                    <td>{resource.unit}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      <h3>Invoice components</h3>
      {detail.invoices.length === 0 ? (
        <p>No invoice components are assigned to this workspace.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Service period</th>
                <th scope="col">Category</th>
                <th scope="col">Assignment</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {detail.invoices.map((item) => (
                <tr key={`${item.id}:${item.revision}`}>
                  <th scope="row">{item.provider}</th>
                  <td>
                    {item.periodStart.slice(0, 10)} to{" "}
                    {new Date(Date.parse(item.periodEnd) - 1)
                      .toISOString()
                      .slice(0, 10)}
                  </td>
                  <td>
                    {item.category === "hosting-storage"
                      ? "Hosting / storage"
                      : item.category === "rpc-email"
                        ? "RPC / email"
                        : item.category === "ai"
                          ? "AI"
                          : "Other"}
                  </td>
                  <td>
                    {item.assignment === "shared"
                      ? "Shared allocation"
                      : item.assignment === "direct"
                        ? "Direct"
                        : "Unattributed"}
                  </td>
                  <td>{money(Number(item.amountUsdNanos) / 1_000_000_000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
