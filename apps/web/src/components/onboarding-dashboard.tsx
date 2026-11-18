"use client";
import { useEffect, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  ONBOARDING_AUDIENCES,
  ONBOARDING_TRAFFIC,
  type OnboardingAudience,
  type OnboardingReport,
} from "@templ/chat/onboarding";
import { CommunityApiError } from "@/lib/community-client";
import { funnelAdmin } from "@/lib/funnel-admin-client";
import styles from "./cost-dashboard.module.css";

const count = (value: number) => new Intl.NumberFormat("en-US").format(value);
const eventLabel = (name: string) =>
  name.replace(/^server_/, "").replaceAll("_", " ");
export function onboardingDuration(ms: number | null) {
  if (ms === null) return "No data";
  if (ms < 1000) return "Under 1 second";
  const [divisor, unit]: [number, string] =
    ms < 60_000
      ? [1000, "second"]
      : ms < 3_600_000
        ? [60_000, "minute"]
        : ms < 86_400_000
          ? [3_600_000, "hour"]
          : [86_400_000, "day"];
  const value = Math.round(ms / divisor);
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
export function OnboardingDashboard({
  principal,
}: {
  principal: ChatPrincipalId;
}) {
  const [days, setDays] = useState(30);
  const [traffic, setTraffic] = useState<OnboardingAudience>("public");
  const [refresh, setRefresh] = useState(0);
  const key = `${days}:${traffic}:${refresh}`;
  const [result, setResult] = useState<{
    key: string;
    data?: OnboardingReport;
    error?: string;
  }>();
  const current = result?.key === key ? result : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void funnelAdmin(principal)
      .onboarding(days, traffic, controller.signal)
      .then(
        (data) => {
          if (!controller.signal.aborted) setResult({ key, data });
        },
        (error) => {
          if (!controller.signal.aborted)
            setResult({
              key,
              error:
                error instanceof CommunityApiError && error.status === 403
                  ? "This page is for Templ operators."
                  : "Onboarding counts could not load. Try again.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, days, traffic, key]);
  return (
    <section aria-labelledby="onboarding-cohorts">
      <h2 id="onboarding-cohorts">Signup journeys</h2>
      <div className={styles.controls}>
        <label>
          Signup period
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {[7, 30, 90].map((value) => (
              <option key={value} value={value}>
                Last {value} days
              </option>
            ))}
          </select>
        </label>
        <label>
          Traffic
          <select
            value={traffic}
            onChange={(event) =>
              setTraffic(event.target.value as OnboardingAudience)
            }
          >
            {Object.entries(ONBOARDING_AUDIENCES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!current}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh journeys
        </button>
      </div>
      {!current && <p role="status">Loading signup journeys…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.data && <OnboardingView data={current.data} />}
    </section>
  );
}
export function OnboardingView({ data }: { data: OnboardingReport }) {
  return (
    <>
      <p>
        Journeys started from {data.from} to {data.to} (UTC). Each journey
        counts once per step.
      </p>
      <p>
        The customer funnel includes unsigned visitors. Known operators and
        tests stay separate, including their actions before sign-in.
      </p>
      <p>
        Visitors remain unclassified until sign-in. Browser privacy signals stop new browser events.
      </p>
      {!data.complete && (
        <p role="alert">
          This report reached its reading limit. Choose a shorter period before
          comparing rates.
        </p>
      )}
      {data.collectedSince ? (
        <p>
          Collection started {new Date(data.collectedSince).toLocaleString()}.
          Earlier totals cannot reconstruct signup journeys.
        </p>
      ) : (
        <p>
          No journeys recorded yet. Counts start with the first measured
          onboarding action.
        </p>
      )}
      <dl className={styles.reconciliation}>
        {Object.entries(ONBOARDING_TRAFFIC).map(([kind, label]) => (
          <div key={kind}>
            <dt>{label}</dt>
            <dd>
              {count(data.traffic[kind as keyof typeof ONBOARDING_TRAFFIC])}
            </dd>
          </div>
        ))}
      </dl>
      <div className={styles.tableWrap}>
        <table>
          <caption className={styles.tableCaption}>
            Drop-off means no next step after 24 hours. Later completion removes
            that drop-off.
          </caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Reached</th>
              <th scope="col">Advanced</th>
              <th scope="col">Conversion</th>
              <th scope="col">Waiting</th>
              <th scope="col">Dropped off</th>
              <th scope="col">Median next step</th>
            </tr>
          </thead>
          <tbody>
            {data.stages.map((stage) => (
              <tr key={stage.name}>
                <th scope="row">
                  {stage.label}
                  {"optional" in stage && (
                    <span className={styles.rowMeta}>Optional</span>
                  )}
                  {stage.next && (
                    <span className={styles.rowMeta}>Next: {stage.next}</span>
                  )}
                </th>
                <td>{count(stage.reached)}</td>
                <td>{stage.next ? count(stage.advanced) : "–"}</td>
                <td>
                  {stage.conversion === null
                    ? "–"
                    : `${Math.round(stage.conversion * 100)}%`}
                </td>
                <td>{stage.next ? count(stage.waiting) : "–"}</td>
                <td>{stage.next ? count(stage.dropped) : "–"}</td>
                <td>{onboardingDuration(stage.medianNextMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Direct signups can skip the install prompt. Connections to existing
        workspaces stay outside signup conversion rates.
      </p>
      <details>
        <summary>Setup and payment</summary>
        <p>
          Each row measures journeys that started that action. These actions are
          optional for the core funnel.
        </p>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Started</th>
                <th scope="col">Completed</th>
                <th scope="col">Conversion</th>
                <th scope="col">Waiting</th>
                <th scope="col">Dropped off</th>
                <th scope="col">Median elapsed</th>
              </tr>
            </thead>
            <tbody>
              {data.branches.map((branch) => (
                <tr key={branch.name}>
                  <th scope="row">{branch.label}</th>
                  <td>{count(branch.reached)}</td>
                  <td>{count(branch.advanced)}</td>
                  <td>
                    {branch.conversion === null
                      ? "–"
                      : `${Math.round(branch.conversion * 100)}%`}
                  </td>
                  <td>{count(branch.waiting)}</td>
                  <td>{count(branch.dropped)}</td>
                  <td>{onboardingDuration(branch.medianNextMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>Every onboarding action</summary>
        <p>
          Actions include setup, team invitations, payment attempts and
          failures. Times use each action’s first occurrence.
        </p>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Journeys</th>
                <th scope="col">Median from start</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.name}>
                  <th scope="row">{eventLabel(event.name)}</th>
                  <td>{count(event.journeys)}</td>
                  <td>{onboardingDuration(event.medianFromStartMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>Time between actions</summary>
        {!data.transitions.length ? (
          <p>No action pairs recorded yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Journeys</th>
                  <th scope="col">Median elapsed</th>
                </tr>
              </thead>
              <tbody>
                {data.transitions.map((edge) => (
                  <tr key={`${edge.from}:${edge.to}`}>
                    <th scope="row">{eventLabel(edge.from)}</th>
                    <td>{eventLabel(edge.to)}</td>
                    <td>{count(edge.journeys)}</td>
                    <td>{onboardingDuration(edge.medianMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </>
  );
}
