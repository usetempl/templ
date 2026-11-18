"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { DEFAULT_CHAT_AUTH_CHAIN_ID, getChatChain } from "@templ/chat/chains";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import { healthAdmin, type OperatorHealth } from "@/lib/health-admin-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import styles from "./cost-dashboard.module.css";

type Checks = OperatorHealth["checks"];
type Canary = NonNullable<OperatorHealth["canary"]>;
const STATUS: Record<OperatorHealth["status"], string> = {
  ok: "Working",
  degraded: "Slow or partly down",
  down: "Down",
};
const WORKING: Record<Checks["storage"], string> = {
  ok: "Working",
  failed: "Failed",
};
const TEMPL: Record<Checks["templSupport"], string> = {
  active: "Taking cases",
  setup: "Not started",
  paused: "Paused until a top-up",
  suspended: "Suspended by an operator",
  missing: "Workspace not found",
  unreadable: "Plan could not be read",
  "not-configured": "Not set up",
};
const CANARY: Record<Checks["canary"], string> = {
  ok: "Passing",
  failing: "Failing",
  stale: "No run in the last 12 minutes",
  "needs-setup": "Needs setup",
  off: "Off",
};
const SETUP: Record<Canary["setup"], string> = {
  ok: "Ready",
  off: "Off. No canary key is set.",
  "needs-listing":
    "Add the canary account under Settings > Test accounts in Templ's workspace.",
  misconfigured: "The canary key and account don't match.",
};
const STAGE: Record<NonNullable<Canary["lastFailure"]>["stage"], string> = {
  config: "Configuration",
  probe: "Health probe",
  preflight: "Browser preflight",
  policy: "Access setting",
  nonce: "Sign-in challenge",
  challenge: "Challenge check",
  verify: "Wallet sign-in",
  "room-health": "Workspace check",
  join: "Join",
  status: "Case lookup",
  write: "Test message",
  "read-back": "Read back",
  logout: "Sign out",
};
const HOOK: Record<OperatorHealth["alertHook"], string> = {
  configured: "connected",
  "not-configured": "not set up",
  invalid: "address rejected",
};
const OUTCOME: Record<NonNullable<Canary["alert"]["lastOutcome"]>, string> = {
  sent: "sent",
  failed: "failed",
  "not-configured": "not sent, no heartbeat set up",
  invalid: "not sent, address rejected",
};
const SURFACE: Record<string, string> = { widget: "Widget", app: "App" };
const ROUTE: Record<string, string> = {
  preflight: "Browser preflight",
  "auth-policy": "Access setting",
  "auth-guest": "Guest session",
  "auth-nonce": "Wallet sign-in",
  "auth-verify": "Wallet sign-in",
  "auth-logout": "Sign out",
  list: "Inbox list",
  status: "Case lookup",
  join: "Join",
  ask: "New case",
  pulse: "Inbox summary",
  "team-tools": "Team settings and reports",
  thread: "Read case",
  "messages-read": "Read case",
  "messages-write": "Reply",
  "message-edit": "Edit or delete a message",
  "workflow-read": "Read details",
  "workflow-write": "Share details or confirm",
  resolve: "Resolve",
  stop: "Stop",
  claim: "Claim",
  release: "Release",
  typing: "Typing",
  export: "Export",
  other: "Other",
};
const BUILD: Record<string, string> = {
  legacy: "Widget without a version",
  dev: "Development build",
  other: "Other",
};
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);
/** UTC minutes, the same for every operator. */
const when = (value: number | string | null) =>
  value === null
    ? "Never"
    : `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Operator view of Templ's support path. */
export function HealthDashboardPanel() {
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
      <h1>Support health</h1>
      <p>Only Templ operators can see this page.</p>
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
        <Health key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}
function Health({ principal }: { principal: ChatPrincipalId }) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    key: number;
    data?: OperatorHealth;
    error?: string;
  }>();
  const current = result?.key === refresh ? result : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void healthAdmin(principal)
      .read(controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted)
            setResult({ key: refresh, data: value });
        },
        (reason) => {
          if (!controller.signal.aborted)
            setResult({
              key: refresh,
              error:
                reason instanceof CommunityApiError && reason.status === 403
                  ? "This page is for Templ operators."
                  : "Support health could not be loaded. Try again.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, refresh]);
  return (
    <>
      <div className={styles.controls}>
        <button
          type="button"
          disabled={!current}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </button>
      </div>
      {!current && <p role="status">Loading support health…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.data && <HealthView data={current.data} />}
    </>
  );
}

function Counts({
  label,
  id,
  rows,
}: {
  label: string;
  id: string;
  rows: Record<string, number>;
}) {
  const entries = Object.entries(rows).sort(([, a], [, b]) => b - a);
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{label}</h2>
      {entries.length ? (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th colSpan={2}>Where</th>
                <th>Status</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, value]) => {
                const [surface, route, status] = key.split("|");
                return (
                  <tr key={key}>
                    <th scope="row">{SURFACE[surface] ?? "Other"}</th>
                    <td>{ROUTE[route] ?? "Other"}</td>
                    <td>{status === "0" ? "–" : status}</td>
                    <td>{count(value)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p>None.</p>
      )}
    </section>
  );
}

export function HealthView({ data }: { data: OperatorHealth }) {
  const chain = getChatChain(DEFAULT_CHAT_AUTH_CHAIN_ID).name;
  const canary = data.canary;
  const failure = canary?.lastFailure;
  const builds = Object.entries(data.widgetBuilds.counts).sort(
    ([, a], [, b]) => b - a,
  );
  return (
    <>
      <section aria-labelledby="health-status">
        <h2 id="health-status">{STATUS[data.status]}</h2>
        <p>
          {data.schedule
            ? "Templ checks the support path every five minutes."
            : "The five-minute canary is off. These checks ran when the page loaded."}{" "}
          Checked {when(data.checkedAt)}.
        </p>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Storage</th>
                <td>{WORKING[data.checks.storage]}</td>
              </tr>
              <tr>
                <th scope="row">Chain reads ({chain})</th>
                <td>{WORKING[data.checks.chain]}</td>
              </tr>
              <tr>
                <th scope="row">Templ&apos;s own support</th>
                <td>{TEMPL[data.checks.templSupport]}</td>
              </tr>
              <tr>
                <th scope="row">Canary</th>
                <td>{CANARY[data.checks.canary]}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="health-canary">
        <h2 id="health-canary">Canary</h2>
        {canary ? (
          <dl>
            <dt>Setup</dt>
            <dd>{SETUP[canary.setup]}</dd>
            <dt>Last check</dt>
            <dd>{when(canary.lastRunAt)}</dd>
            <dt>Last message check</dt>
            <dd>{when(canary.lastFullOkAt)}</dd>
            <dt>Failures in a row</dt>
            <dd>{count(canary.consecutiveFailures)}</dd>
            {failure && (
              <>
                <dt>Last failure</dt>
                <dd>
                  {STAGE[failure.stage]},{" "}
                  {failure.status ? `status ${failure.status}` : "no response"},{" "}
                  {when(failure.at)}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p>No canary run is recorded yet.</p>
        )}
        <p>Better Stack heartbeat: {HOOK[data.alertHook]}</p>
        {canary && (
          <p>
            Last alert:{" "}
            {canary.alert.lastSentAt === null
              ? "none"
              : `${when(canary.alert.lastSentAt)}, ${
                  canary.alert.lastOutcome
                    ? OUTCOME[canary.alert.lastOutcome]
                    : "outcome not recorded"
                }`}
          </p>
        )}
      </section>
      <Counts
        id="health-errors-hour"
        label="Server errors this hour (UTC)"
        rows={data.failures.lastHour}
      />
      <Counts
        id="health-errors-day"
        label="Server errors in the last 24 hours"
        rows={data.failures.last24h}
      />
      <section aria-labelledby="health-builds">
        <h2 id="health-builds">
          Widget versions opening sessions, last {data.widgetBuilds.days} days
        </h2>
        {builds.length ? (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Sessions</th>
                </tr>
              </thead>
              <tbody>
                {builds.map(([build, value]) => (
                  <tr key={build}>
                    <th scope="row">{BUILD[build] ?? build}</th>
                    <td>{count(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>None.</p>
        )}
      </section>
    </>
  );
}
