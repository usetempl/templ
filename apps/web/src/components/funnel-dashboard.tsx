"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  FUNNEL_POLICY,
  FUNNEL_STEPS,
  type FunnelReport,
  type FunnelSignInMethod,
  type FunnelStep,
} from "@templ/chat/funnel";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import { funnelAdmin } from "@/lib/funnel-admin-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import styles from "./cost-dashboard.module.css";
import { OnboardingDashboard } from "./onboarding-dashboard";

const METHODS: Record<FunnelSignInMethod, string> = {
  wallet: "EVM wallet",
  solana: "Solana wallet",
  email: "Email",
};
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);

/** Operator view of the onboarding counts the worker keeps. */
export function FunnelDashboardPanel() {
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
      <h1>Onboarding funnel</h1>
      <p>
        How many teams reach each setup step, and why attempts fail. Only Templ
        operators can see this page.
      </p>
      {auth.restoring ? (
        <p role="status">Checking sign-in…</p>
      ) : !principal ? (
        <div>
          <p>Sign in with a Templ operator account.</p>
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
        <div key={`${principal}:${revision}`}>
          <OnboardingDashboard principal={principal} />
          <details>
            <summary>Historical totals</summary>
            <p>
              These totals mix traffic types and milestone dates. Use signup
              journeys for conversion rates.
            </p>
            <Funnel principal={principal} />
          </details>
        </div>
      )}
    </main>
  );
}
function Funnel({ principal }: { principal: ChatPrincipalId }) {
  const [days, setDays] = useState<number>(30);
  const [refresh, setRefresh] = useState(0);
  const key = `${days}:${refresh}`;
  const [result, setResult] = useState<{
    key: string;
    data?: FunnelReport;
    error?: string;
  }>();
  const current = result?.key === key ? result : undefined;
  const loading = !current;
  const data = current?.data;
  const error = current?.error;
  useEffect(() => {
    const controller = new AbortController();
    void funnelAdmin(principal)
      .read(days, controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setResult({ key, data: value });
        },
        (reason) => {
          if (!controller.signal.aborted)
            setResult({
              key,
              error:
                reason instanceof CommunityApiError && reason.status === 403
                  ? "This page is for Templ operators."
                  : "Onboarding counts could not be loaded. Try again.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, days, key]);
  return (
    <>
      <div className={styles.controls}>
        <label>
          Period
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {FUNNEL_POLICY.windows.map((value) => (
              <option key={value} value={value}>
                Last {value} days
              </option>
            ))}
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
      {loading && <p role="status">Loading onboarding counts…</p>}
      {error && <p role="alert">{error}</p>}
      {data && <FunnelView data={data} />}
    </>
  );
}
export function FunnelView({ data }: { data: FunnelReport }) {
  const created =
    data.steps.find((step) => step.step === "workspace_created")?.done ?? 0;
  const steps = Object.keys(FUNNEL_STEPS) as FunnelStep[];
  return (
    <>
      <section aria-labelledby="funnel-steps">
        <h2 id="funnel-steps">
          {data.from} to {data.to} (UTC)
        </h2>
        {!data.available && (
          <p role="alert">
            The counts could not be read, so every step shows zero. Try again.
          </p>
        )}
        <p>
          Templ counts every install prompt copy and sign-in. Other steps count
          once per workspace, on the day they first happen. Those workspaces may
          predate this period. An operator grant doesn’t count as a payment.
        </p>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Count</th>
                <th>Of workspaces created</th>
                <th>Failed attempts</th>
              </tr>
            </thead>
            <tbody>
              {data.steps.map((step) => (
                <tr key={step.step}>
                  <th scope="row">{step.label}</th>
                  <td>{count(step.done)}</td>
                  <td>
                    {step.scope === "workspace" &&
                    step.step !== "workspace_created" &&
                    created > 0
                      ? `${Math.round((step.done / created) * 100)}%`
                      : "–"}
                  </td>
                  <td>
                    {step.failed.length
                      ? step.failed
                          .map(
                            (entry) => `${entry.label}: ${count(entry.count)}`,
                          )
                          .join(", ")
                      : "None"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Sign-ins by method:{" "}
          {data.signIns.length
            ? data.signIns
                .map(
                  (entry) => `${METHODS[entry.method]} ${count(entry.count)}`,
                )
                .join(", ")
            : "none yet"}
          .
        </p>
      </section>
      <details>
        <summary>By day</summary>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                {steps.map((step) => (
                  <th key={step}>{FUNNEL_STEPS[step].label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.days.map((day) => (
                <tr key={day.day}>
                  <th scope="row">{day.day}</th>
                  {steps.map((step) => (
                    <td key={step}>{count(day.done[step] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
