"use client";

import { AdminStandardPlan } from "./admin-standard-plan";
import { AdminUsageBilling } from "./admin-usage-billing";
import { AdminSoftwareOrderForm } from "./admin-software-order-form";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  formatBalanceCents,
  formatUsdCents,
} from "@templ/chat/resolution-copy";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import {
  billingAdmin,
  type BillingAction,
  type BillingDetail,
  type BillingWorkspace,
} from "@/lib/billing-admin-client";
import { formatDay } from "@/lib/product-format";
import styles from "./admin-billing.module.css";
import { stripeInvoiceStatus } from "@/lib/stripe-billing-client";
import { Badge } from "@/components/ui/ui";
import { ProductPilotSummary } from "./product-pilot-summary";
import { AdminPilotOrderForm } from "./admin-pilot-order-form";

const MODE: Record<NonNullable<BillingWorkspace["mode"]>, string> = {
  free: "Free start",
  funded: "Funded",
  exempt: "Exempt",
  paused: "Paused",
  suspended: "Suspended",
};
const money = (cents: number | undefined) =>
  cents === undefined ? "–" : formatBalanceCents(cents);

/** `/admin/billing`: resolved-case billing across workspaces for Templ
 * operators. Totals, flags and monitors only; no thread text, thread or
 * case number. Every action needs a reason and is audited. */
export function AdminBillingPanel() {
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
      <header className={styles.header}>
        <h1>Billing</h1>
        <p>
          Workspace balances, access and payment records. Templ operators only.
        </p>
      </header>
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
        <Billing key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}

function InputTokenProbe({ principal }: { principal: ChatPrincipalId }) {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => () => active.current?.abort(), []);
  async function check() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult("");
    setError("");
    try {
      const value = await billingAdmin(principal).probeInputTokens(
        controller.signal,
      );
      if (!controller.signal.aborted)
        setResult(
          value.supported === true &&
            Number.isSafeInteger(value.inputTokens) &&
            Number(value.inputTokens) > 0
            ? `Token counting supported. Input tokens: ${value.inputTokens!.toLocaleString()}.`
            : `Token counting unavailable. The full-context hold remains. Reason: ${value.reason ?? "unknown"}.${value.status ? ` HTTP ${value.status}.` : ""}${value.errorName ? ` Error type: ${value.errorName}.` : ""}`,
        );
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Token counting could not be checked.",
        );
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className={styles.diagnosticBody}>
      <p>
        Counts a fixed input without generating an answer or changing billing.
      </p>
      <button
        type="button"
        className="button small secondary"
        disabled={busy}
        onClick={() => void check()}
      >
        {busy ? "Checking…" : "Check token counting"}
      </button>
      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function AiConnectionProbe({ principal }: { principal: ChatPrincipalId }) {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => () => active.current?.abort(), []);
  async function check() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult("");
    setError("");
    try {
      const value = await billingAdmin(principal).probeAiConnection(
        controller.signal,
      );
      if (!controller.signal.aborted)
        setResult(
          value.connected
            ? "AI connection works. GPT-6.1 Sol returned complete Standard usage."
            : `AI connection check failed. Reason: ${value.reason}. Model: ${value.model}. Tier: ${value.tier}. Usage complete: ${value.usageComplete ? "yes" : "no"}.`,
        );
    } catch {
      if (!controller.signal.aborted)
        setError("AI connection could not be checked.");
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className={styles.diagnosticBody}>
      <p>Sends one fixed test request. Its cost uses Templ’s AI budget.</p>
      <button
        type="button"
        className="button small secondary"
        disabled={busy}
        onClick={() => void check()}
      >
        {busy ? "Checking…" : "Check AI connection"}
      </button>
      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function Billing({ principal }: { principal: ChatPrincipalId }) {
  const [page, setPage] = useState({
    after: null as string | null,
    request: 0,
  });
  const [result, setResult] = useState<{
    principal: ChatPrincipalId;
    request: number;
    rows?: BillingWorkspace[];
    next?: string | null;
    inputTokenProbeAvailable?: boolean;
    error?: string;
  }>();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (open) return;
    const controller = new AbortController();
    void billingAdmin(principal)
      .list(page.after, controller.signal)
      .then(
        (nextPage) => {
          if (!controller.signal.aborted)
            setResult((previous) => ({
              principal,
              request: page.request,
              rows: [
                ...new Map(
                  [
                    ...(page.after && previous?.principal === principal
                      ? (previous.rows ?? [])
                      : []),
                    ...nextPage.workspaces,
                  ].map((row) => [row.workspace, row]),
                ).values(),
              ],
              next: nextPage.next,
              inputTokenProbeAvailable:
                nextPage.inputTokenProbeAvailable === true,
            }));
        },
        (reason) => {
          const denied =
            reason instanceof CommunityApiError &&
            [403, 404].includes(reason.status);
          if (!controller.signal.aborted)
            setResult((previous) => ({
              ...(!denied && page.after && previous?.principal === principal
                ? previous
                : {}),
              principal,
              request: page.request,
              error: denied
                ? "This page is for Templ operators."
                : "Billing could not be loaded. Try again.",
            }));
        },
      );
    return () => controller.abort();
  }, [principal, page, open]);
  const current = result?.principal === principal ? result : undefined;
  const loading = current?.request !== page.request;
  if (open)
    return (
      <Workspace
        principal={principal}
        workspace={open}
        onBack={() => {
          setOpen(null);
          setPage((value) => ({ after: null, request: value.request + 1 }));
        }}
      />
    );
  if (!current || (loading && page.after === null))
    return <p role="status">Loading billing…</p>;
  if (current.error && !current.rows)
    return <p role="alert">{current.error}</p>;
  const rows = current.rows ?? [];
  const review = rows.filter((row) => row.reviewSuggested);
  const unpaid = rows.filter((row) => row.cardOutreach);
  const neverFunded = rows.filter(
    (row) => row.everFunded === false && (row.balanceCents ?? 0) < 0,
  );
  return (
    <>
      <dl className={styles.summary} aria-label="Billing overview">
        <div>
          <dt>Workspaces</dt>
          <dd>{rows.length}</dd>
        </div>
        <div>
          <dt>To review</dt>
          <dd>{review.length}</dd>
        </div>
        <div>
          <dt>Never funded, below zero</dt>
          <dd>{neverFunded.length}</dd>
        </div>
        <div>
          <dt>Unpaid card invoices</dt>
          <dd>{unpaid.length}</dd>
        </div>
      </dl>
      <div className={styles.sectionHeader}>
        <h2>Workspaces</h2>
        <p>Select a workspace to view its billing and access.</p>
      </div>
      <div className={styles.tableWrap}>
        <table>
          <caption className={styles.visuallyHidden}>
            Workspace billing summary
          </caption>
          <thead>
            <tr>
              <th scope="col">Workspace</th>
              <th scope="col">Templ people</th>
              <th scope="col">Order form</th>
              <th scope="col">Mode</th>
              <th scope="col">Invoice</th>
              <th scope="col">Balance</th>
              <th scope="col">This month</th>
              <th scope="col">Cash this month</th>
              <th scope="col">Open disputes</th>
              <th scope="col">Unmatched</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={11}>No workspaces to show.</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.workspace}>
                <th scope="row">
                  <button
                    className={styles.workspaceLink}
                    type="button"
                    onClick={() => setOpen(row.workspace)}
                  >
                    {row.name || row.workspace.slice(0, 8)}
                  </button>
                  {row.trackingStartedAt && (
                    <div>
                      <small>
                        Tracking since {formatDay(row.trackingStartedAt)}
                      </small>
                    </div>
                  )}
                </th>
                {row.unavailable ? (
                  <td colSpan={10}>Not answering</td>
                ) : (
                  <>
                    <td>{row.templStaffCount ?? 0}</td>
                    <td>
                      {row.orderForm
                        ? `${row.orderForm.id}, revision ${row.orderForm.revision}, ${row.orderForm.service}, ends ${formatDay(row.orderForm.endsAt)}`
                        : "None"}
                    </td>
                    <td>{row.mode ? MODE[row.mode] : "–"}</td>
                    <td>
                      {row.usageBilling
                        ? "Usage billing"
                        : row.manualBilling
                          ? "Manual billing"
                          : row.cardOutreach
                            ? "Needs payment"
                            : row.billingMethod === "card"
                              ? "Card billing"
                              : "Stablecoin prepaid"}
                    </td>
                    <td>
                      {row.usageBilling
                        ? `${money(row.usageBilling.dueCents)} due`
                        : money(row.balanceCents)}
                    </td>
                    <td>
                      {row.usageBilling
                        ? `${money(row.usageBilling.chargedCents)} charged in total`
                        : row.manualBilling
                          ? `${row.manualBilling.month.cases} posted, ${formatUsdCents(row.manualBilling.month.chargedCents)}`
                          : row.month
                            ? `${row.month.cases} cases, ${formatUsdCents(row.month.cents)}`
                            : "–"}
                    </td>
                    <td>
                      {row.cashCents === undefined
                        ? "–"
                        : formatUsdCents(row.cashCents)}
                    </td>
                    <td>{row.disputes ?? 0}</td>
                    <td>{row.unmatched ?? 0}</td>
                    <td>
                      {[
                        row.reviewSuggested && "review",
                        row.cardOutreach && "contact billing managers",
                        row.monitors?.spamFlag && "spam share",
                        row.everFunded === false &&
                          (row.balanceCents ?? 0) < 0 &&
                          "never funded",
                        row.topUpWhileSuspended && "top-up while suspended",
                      ]
                        .filter(Boolean)
                        .join(", ") || "–"}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current.error && <p role="alert">{current.error}</p>}
      {current.next && (
        <button
          type="button"
          disabled={loading}
          onClick={() =>
            setPage({ after: current.next ?? null, request: page.request + 1 })
          }
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
      {current.inputTokenProbeAvailable === true && (
        <details className={styles.diagnostics}>
          <summary>Diagnostics</summary>
          <AiConnectionProbe principal={principal} />
          <InputTokenProbe principal={principal} />
        </details>
      )}
    </>
  );
}

function Workspace({
  principal,
  workspace,
  onBack,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  onBack: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: number;
    detail?: BillingDetail;
    error?: string;
  }>();
  const [reason, setReason] = useState("");
  const [cents, setCents] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void billingAdmin(principal)
      .detail(workspace, controller.signal)
      .then(
        (detail) => {
          if (!controller.signal.aborted) setLoaded({ key: refresh, detail });
        },
        () => {
          if (!controller.signal.aborted)
            setLoaded({
              key: refresh,
              error: "The workspace could not be loaded.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, workspace, refresh]);
  const current = loaded?.key === refresh ? loaded : undefined;
  const ready = reason.trim().length >= 3;
  const act = (input: BillingAction, done: string) => {
    setBusy(true);
    setNote("");
    void billingAdmin(principal)
      .act(workspace, { ...input, reason: reason.trim() })
      .then(
        () => {
          setNote(done);
          setReason("");
          setCents("");
          setRefresh((value) => value + 1);
        },
        (error) =>
          setNote(
            error instanceof Error
              ? error.message
              : "That didn't go through. Try again.",
          ),
      )
      .finally(() => setBusy(false));
  };
  const detail = current?.detail;
  const credit = /^\d{1,7}$/.test(cents.trim()) ? Number(cents) : 0;
  return (
    <section className={styles.workspace} aria-labelledby="billing-workspace">
      <header className={styles.workspaceHeader}>
        <button type="button" onClick={onBack}>
          Back to workspaces
        </button>
        <div>
          <h2 id="billing-workspace">{detail?.name || "Workspace billing"}</h2>
          <code className={styles.workspaceId}>{workspace}</code>
        </div>
      </header>
      {!current ? (
        <p role="status">Loading…</p>
      ) : !detail ? (
        <p role="alert">{current.error}</p>
      ) : (
        <>
          {detail.cardOutreach && (
            <p role="status">
              Invoice needs payment. Contact the billing managers. Support keeps
              running.
            </p>
          )}
          <dl
            className={styles.accountSummary}
            aria-label="Workspace billing details"
          >
            <div>
              <dt>Mode</dt>
              <dd>{detail.mode ? MODE[detail.mode] : "–"}</dd>
            </div>
            <div>
              <dt>Payment method</dt>
              <dd>
                {detail.manualBilling
                  ? "Manual billing"
                  : detail.billingMethod === "card"
                    ? "Monthly card invoice"
                    : "Stablecoin prepaid"}
              </dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>{money(detail.balanceCents)}</dd>
              <span>Pending: {money(detail.pendingCents)}</span>
            </div>
            {detail.manualBilling && (
              <div>
                <dt>Amount due</dt>
                <dd>{money(detail.manualBilling.dueCents)}</dd>
                <span>
                  Pending estimate: {money(detail.manualBilling.pendingCents)}
                </span>
              </div>
            )}
            <div>
              <dt>Ever funded</dt>
              <dd>{detail.everFunded ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Refundable on closure</dt>
              <dd>{money(detail.refundableCents)}</dd>
            </div>
            {detail.cardBilling?.latestInvoice && (
              <div>
                <dt>Last invoice</dt>
                <dd>
                  <code>{detail.cardBilling.latestInvoice.id}</code>
                </dd>
                <Badge tone="neutral">
                  {stripeInvoiceStatus(detail.cardBilling.latestInvoice.status)}
                </Badge>
              </div>
            )}
          </dl>
          <details className={styles.disclosure}>
            <summary>Case monitors</summary>
            <dl className={styles.monitorGrid}>
              <div>
                <dt>Answered in 30 days</dt>
                <dd>{detail.monitors?.answered ?? 0}</dd>
              </div>
              <div>
                <dt>Spam</dt>
                <dd>{detail.monitors?.spamPercent ?? 0}%</dd>
              </div>
              <div>
                <dt>Never resolved</dt>
                <dd>{detail.monitors?.neverResolvedPercent ?? 0}%</dd>
              </div>
              <div>
                <dt>Spam marks on confirmed cases</dt>
                <dd>{detail.monitors?.spamOnConfirmed ?? 0}</dd>
              </div>
              <div>
                <dt>Team reopens before final</dt>
                <dd>{detail.monitors?.teamReopenedBeforeFinal ?? 0}</dd>
              </div>
            </dl>
          </details>
          {detail.pilot && (
            <section aria-label="Pilot">
              <h3>Pilot</h3>
              <ProductPilotSummary pilot={detail.pilot} />
            </section>
          )}
          {detail.pendingPilot && (
            <section aria-label="Pilot revision">
              <h3>Pilot revision</h3>
              <ProductPilotSummary pilot={detail.pendingPilot} />
            </section>
          )}
          {detail.standardPlan && (
            <AdminStandardPlan
              key={`${workspace}:${refresh}`}
              principal={principal}
              workspace={workspace}
              plan={detail.standardPlan}
              debtPeriods={detail.standardDebtPeriods}
              reviewablePeriods={detail.standardRecords?.periods}
              retainedAccess={detail.mode !== "free"}
              onChanged={(message) => {
                setNote(message);
                setRefresh((value) => value + 1);
              }}
            />
          )}
          {detail.usageBilling && (
            <AdminUsageBilling
              principal={principal}
              workspace={workspace}
              usage={detail.usageBilling}
              onChanged={(message) => {
                setNote(message);
                setRefresh((value) => value + 1);
              }}
            />
          )}
          <AdminSoftwareOrderForm
            principal={principal}
            workspace={workspace}
            onChanged={(message) => {
              setNote(message);
              setRefresh((value) => value + 1);
            }}
          />
          {detail.pilotEnabled && (
            <AdminPilotOrderForm
              principal={principal}
              workspace={workspace}
              pilot={detail.pendingPilot ?? detail.pilot}
              onChanged={(message) => {
                setNote(message);
                setRefresh((value) => value + 1);
              }}
            />
          )}
          <section
            className={styles.panel}
            aria-labelledby="billing-adjustments"
          >
            <div className={styles.sectionHeader}>
              <h3 id="billing-adjustments">Adjustments and access</h3>
              <p>The reason below is recorded with each change.</p>
            </div>
            <label>
              Reason
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={280}
              />
            </label>
            <div className={styles.controls}>
              {detail.suspended ? (
                <button
                  type="button"
                  disabled={!ready || busy}
                  onClick={() =>
                    act({ action: "unsuspend" }, "Suspension lifted.")
                  }
                >
                  Lift suspension
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!ready || busy}
                  onClick={() =>
                    act({ action: "suspend" }, "Workspace suspended.")
                  }
                >
                  Suspend
                </button>
              )}
              {detail.mode === "paused" && (
                <button
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => act({ action: "resume" }, "Pause lifted.")}
                >
                  Lift the pause
                </button>
              )}
              <label>
                Incident credit (cents)
                <input
                  inputMode="numeric"
                  value={cents}
                  onChange={(event) => setCents(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!ready || busy || credit < 1}
                onClick={() =>
                  act(
                    { action: "incident-credit", cents: credit },
                    "Credit added.",
                  )
                }
              >
                Add credit
              </button>
            </div>
          </section>
          {note && (
            <p className={styles.notice} role="status">
              {note}
            </p>
          )}
          <section className={styles.panel} aria-labelledby="billing-disputes">
            <h3 id="billing-disputes">Open disputes</h3>
            {detail.disputes.length === 0 ? (
              <p>None.</p>
            ) : (
              <ul>
                {detail.disputes.map((dispute) => (
                  <li key={dispute.ref}>
                    <div>
                      <code>{dispute.ref}</code>: {dispute.reason},{" "}
                      {formatUsdCents(dispute.priceCents)},{" "}
                      {dispute.at.slice(0, 10)}
                    </div>
                    {dispute.text && <div>“{dispute.text}”</div>}
                    {dispute.corpus && (
                      <div>
                        Case row:{" "}
                        <code>{`/operator/corpus?workspace=${dispute.corpus.workspace}&ref=${dispute.corpus.ref}&purpose=resolution-audit`}</code>
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={!ready || busy}
                      onClick={() =>
                        act(
                          { action: "dispute", ref: dispute.ref, accept: true },
                          "Credited.",
                        )
                      }
                    >
                      Credit it
                    </button>{" "}
                    <button
                      type="button"
                      disabled={!ready || busy}
                      onClick={() =>
                        act(
                          {
                            action: "dispute",
                            ref: dispute.ref,
                            accept: false,
                          },
                          "Kept.",
                        )
                      }
                    >
                      Keep the charge
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={styles.panel} aria-labelledby="billing-unmatched">
            <h3 id="billing-unmatched">Unmatched payments</h3>
            {detail.unmatched.filter((row) => row.status === "open").length ===
            0 ? (
              <p>None open.</p>
            ) : (
              <ul>
                {detail.unmatched
                  .filter((row) => row.status === "open")
                  .map((row) => (
                    <li key={row.paymentId}>
                      <code>{row.txHash}</code> on{" "}
                      {row.chainId === "solana"
                        ? "Solana"
                        : `chain ${row.chainId}`}
                      , request {formatUsdCents(row.usdCents)}, {row.reason}{" "}
                      <button
                        type="button"
                        disabled={!ready || busy || credit < 1}
                        onClick={() =>
                          act(
                            {
                              action: "unmatched",
                              paymentId: row.paymentId,
                              answer: "credit",
                              usdCents: credit,
                            },
                            "Credited once.",
                          )
                        }
                      >
                        Credit the amount above
                      </button>{" "}
                      <button
                        type="button"
                        disabled={!ready || busy}
                        onClick={() =>
                          act(
                            {
                              action: "unmatched",
                              paymentId: row.paymentId,
                              answer: "return",
                            },
                            "Marked as sent back.",
                          )
                        }
                      >
                        Mark sent back
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
