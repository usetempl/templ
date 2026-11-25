"use client";

import { formatStandardAiRate } from "@templ/chat/standard-usage";

import { Fragment, useEffect, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import { getChatChain, isChatChainId } from "@templ/chat/chains";
import { usageEntryLabel } from "@templ/chat/usage-billing";
import type { ProductStatement } from "@templ/chat/product-catalog";
import type { ProductPaymentReceipt } from "@templ/chat/product-payment";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { readProductReceipts, readStatement } from "@/lib/product-client";
import { formatUsd } from "@/lib/product-format";
import { balanceLabel, contributionBillingLabel } from "@/lib/product-offer";
import styles from "./product-statement-document.module.css";

const REASONS: Record<ProductStatement["credits"][number]["reason"], string> = {
  spam: "spam",
  test: "own test",
  duplicate: "same user, same problem",
  "not-resolved": "not resolved",
  other: "other",
};
/** "Base" from "8453", "Solana" from "solana". */
function networkName(chain: string) {
  if (chain === "solana" || chain === "sol") return "Solana";
  const id = Number(chain);
  return isChatChainId(id) ? getChatChain(id).name : chain;
}
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1),
  );
const day = (at: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(Date.parse(at));
const reviewTime = (at: number) =>
  `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at)} UTC`;
function nanoDollars(value: string) {
  const nanos = BigInt(value);
  const whole = (nanos / 1_000_000_000n).toLocaleString("en-US");
  const fraction = (nanos % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `$${whole}${fraction ? `.${fraction}` : ""}`;
}

type SignedRead = { kind: "statement"; month: string } | { kind: "receipts" };
/** Loads a billing read once the viewer is signed in; the worker answers
 * only the manager and billing managers. */
function useSignedRead<T>(room: ChatRoomId, what: SignedRead) {
  const auth = useChatAuth();
  const account = auth.session?.principalId;
  const [result, setResult] = useState<{
    key: string;
    value?: T;
    error?: string;
  }>();
  const month = what.kind === "statement" ? what.month : null;
  const full = `${room}:${what.kind}:${month}:${account}`;
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    const read =
      month === null
        ? readProductReceipts(room, controller.signal)
        : readStatement(room, month, controller.signal);
    (read as Promise<T>).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ key: full, value });
      },
      (reason) => {
        if (!controller.signal.aborted)
          setResult({
            key: full,
            error:
              reason instanceof Error
                ? reason.message
                : "This page could not load.",
          });
      },
    );
    return () => controller.abort();
  }, [full, account, room, month]);
  return { auth, account, current: result?.key === full ? result : undefined };
}

function SignIn({ auth }: { auth: ReturnType<typeof useChatAuth> }) {
  const [error, setError] = useState("");
  return (
    <div className={styles.status}>
      <p>
        Sign in as the workspace’s manager or a billing manager to see this
        page.
      </p>
      <button
        type="button"
        className={styles.print}
        disabled={auth.restoring}
        onClick={() => {
          setError("");
          void auth.signIn().catch((reason) => {
            if (!isChatSignInCanceled(reason))
              setError("Sign-in failed. Try again.");
          });
        }}
      >
        Sign in
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** A month's statement as a printable page. */
export function StatementDocument({
  room,
  month,
}: {
  room: ChatRoomId;
  month: string;
}) {
  const { auth, account, current } = useSignedRead<ProductStatement>(room, {
    kind: "statement",
    month,
  });
  if (!account) return <SignIn auth={auth} />;
  if (!current)
    return (
      <p role="status" className={styles.status}>
        Loading the statement…
      </p>
    );
  if (current.error || !current.value)
    return (
      <p role="alert" className={styles.status}>
        {current.error}
      </p>
    );
  const statement = current.value;
  const billed = statement.steps.reduce((sum, step) => sum + step.cents, 0);
  const credited =
    statement.credits.reduce((sum, credit) => sum + credit.cents, 0) +
    statement.incidents.reduce((sum, incident) => sum + incident.cents, 0);
  return (
    <article className={styles.document}>
      <header className={styles.head}>
        <div>
          <h1>Statement, {monthLabel(statement.month)}</h1>
          <p className={styles.issuer}>{statement.issuer}</p>
        </div>
        <button
          type="button"
          className={styles.print}
          onClick={() => window.print()}
        >
          Print
        </button>
      </header>
      {statement.standard && (
        <section aria-label="Monthly plan">
          <h2>Monthly plan</h2>
          <p>
            Payments here were recorded manually. Founder-approved access
            records no received money.
          </p>
          {statement.standard.periods.map((period) => (
            <Fragment key={period.id}>
              <p>
                {day(new Date(period.startsAt).toISOString())} to{" "}
                {day(new Date(period.endsAt).toISOString())}:{" "}
                {period.usage ? (
                  <>
                    {period.annual ? `${formatUsd(period.annual.totalCents)} paid annually. Month ${period.annual.month + 1} of 12.` : `${formatUsd(period.workspaceMonthlyCents)} per workspace per month.`} {period.usage.includedAnsweredCases} answered cases
                    included. Additional answered cases cost{" "}
                    {formatUsd(period.usage.additionalAnsweredCaseCents)} each.
                  </>
                ) : (
                  <>
                    {period.includedAiResolutions} confirmed AI resolutions
                    included. Additional resolutions cost{" "}
                    {formatUsd(period.additionalAiResolutionCents)} each.
                  </>
                )}
              </p>
              {period.usage && (
                <p>
                  AI credit: {formatUsd(period.usage.includedAiCreditCents)}. AI
                  use costs {formatStandardAiRate(period.usage)}× GPT-6.1 Sol’s
                  standard API rates ({period.usage.aiRateCardVersion}). This
                  includes use covered by the credit.
                  {period.usage.aiReviewedThrough === null &&
                    " Usage totals await review."}
                </p>
              )}
            </Fragment>
          ))}
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th>Reference</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {statement.standard.references.map((row) => (
                <tr key={row.referenceSha256}>
                  <td>{day(new Date(row.recordedAt).toISOString())}</td>
                  <td>
                    {row.kind === "debt-paid"
                      ? "Usage payment"
                      : row.cents === 0
                        ? "Founder-approved access"
                        : "Monthly access payment"}
                  </td>
                  <td className={styles.mono}>{row.referenceSha256}</td>
                  <td>{formatUsd(row.cents)}</td>
                </tr>
              ))}
              {(statement.standard.cashPayments ?? []).map((row) => (
                <tr key={row.referenceId}>
                  <td>{day(new Date(row.recordedAt).toISOString())}</td>
                  <td>Usage paid from credit</td>
                  <td className={styles.mono}>{row.referenceId}</td>
                  <td>{formatUsd(row.cents)}</td>
                </tr>
              ))}
              {statement.standard.cases.map((row) => (
                <tr key={row.ref}>
                  <td>
                    {day(
                      new Date(row.countedAt ?? row.confirmedAt!).toISOString(),
                    )}
                  </td>
                  <td>
                    {row.status === "counted"
                      ? "AI resolution"
                      : row.status === "pending"
                        ? "Awaiting finalization"
                        : "Not counted"}
                  </td>
                  <td className={styles.mono}>{row.ref}</td>
                  <td>{formatUsd(row.chargedCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(statement.standard.usageReviews?.length ?? 0) > 0 && (
            <>
              <h3>Usage reviews</h3>
              <p>
                These totals are cumulative for each monthly period. Do not add
                successive reviews together. A review records no payment. Base
                AI use is the amount before the period’s multiplier.
              </p>
              <table
                className={styles.table}
                aria-label="Reviewed monthly usage"
              >
                <thead>
                  <tr>
                    <th scope="col">Recorded</th>
                    <th scope="col">Reference</th>
                    <th scope="col">Answered cases</th>
                    <th scope="col">Cumulative charges</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.standard.usageReviews!.map((row) => {
                    const period = statement.standard!.periods.find(
                      (value) => value.id === row.period,
                    );
                    return (
                      <Fragment key={row.referenceSha256}>
                        <tr>
                          <td>{day(new Date(row.recordedAt).toISOString())}</td>
                          <td className={styles.mono}>{row.referenceSha256}</td>
                          <td>{row.answeredCases.toLocaleString("en-US")}</td>
                          <td>{formatUsd(row.chargedCents)}</td>
                        </tr>
                        <tr>
                          <td colSpan={4}>
                            <dl className={styles.details}>
                              <dt>Monthly period</dt>
                              <dd>
                                {period
                                  ? `${day(new Date(period.startsAt).toISOString())} to ${day(new Date(period.endsAt).toISOString())}`
                                  : row.period}
                              </dd>
                              <dt>Reviewed through</dt>
                              <dd>{reviewTime(row.reviewedThrough)}</dd>
                              <dt>Base AI use</dt>
                              <dd className={styles.mono}>
                                {nanoDollars(row.providerAiUsageUsdNanos)}
                              </dd>
                              <dt>Retail AI use</dt>
                              <dd className={styles.mono}>
                                {nanoDollars(row.aiUsageUsdNanos)} before credit
                              </dd>
                              <dt>Cumulative case charges</dt>
                              <dd>{formatUsd(row.answeredCaseChargedCents)}</dd>
                              <dt>Cumulative AI charges</dt>
                              <dd>{formatUsd(row.aiUsageChargedCents)}</dd>
                            </dl>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {statement.standard.truncated && (
            <p>
              This statement is partial. It shows the first 5,000 retained
              entries of each kind.
            </p>
          )}
        </section>
      )}
      {statement.usage && (
        <section aria-label="Usage billing">
          <h2>Usage billing</h2>
          <dl className={styles.totals}>
            <div>
              <dt>Opening amount due</dt>
              <dd>{formatUsd(statement.usage.openingCents)}</dd>
            </div>
            <div>
              <dt>Charges</dt>
              <dd>{formatUsd(statement.usage.chargedCents)}</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd>{formatUsd(statement.usage.paidCents)}</dd>
            </div>
            <div>
              <dt>Credits</dt>
              <dd>
                {formatUsd(
                  statement.usage.disputedCents + statement.usage.forgivenCents,
                )}
              </dd>
            </div>
            <div>
              <dt>Closing amount due</dt>
              <dd>{formatUsd(statement.usage.closingCents)}</dd>
            </div>
          </dl>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th>Case or payment</th>
                <th>Agreement</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {statement.usage.rows.map((row) => (
                <tr key={row.id}>
                  <td>{day(new Date(row.at).toISOString())}</td>
                  <td>{usageEntryLabel(row)}</td>
                  <td className={styles.mono}>
                    {row.ref ?? row.paymentId ?? row.referenceSha256 ?? "–"}
                  </td>
                  <td>
                    {row.formId
                      ? `${row.formId}, revision ${row.formRevision}`
                      : "–"}
                  </td>
                  <td>{formatUsd(row.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {statement.usage.truncated && (
            <p>
              This statement shows the first 5,000 entries. The Plan tab has all
              entries.
            </p>
          )}
        </section>
      )}
      {statement.manual && (
        <section aria-label="Manual billing">
          <h2>Manual billing</h2>
          <dl className={styles.totals}>
            <div>
              <dt>Opening amount due</dt>
              <dd>{formatUsd(statement.manual.openingCents)}</dd>
            </div>
            <div>
              <dt>Closing amount due</dt>
              <dd>{formatUsd(statement.manual.closingCents)}</dd>
            </div>
          </dl>
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Agreement</th>
                <th>Entry</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {statement.manual.rows.map((row) => (
                <tr key={`${row.kind}:${row.ref}`}>
                  <td>{row.ref}</td>
                  <td>
                    {row.agreement.id}, price revision{" "}
                    {row.agreement.effectiveRevision}
                  </td>
                  <td>{row.kind === "charge" ? "Charge" : "Dispute credit"}</td>
                  <td>{formatUsd(row.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {statement.manual.truncated && (
            <p>
              This month has more manual entries than this statement can show.
            </p>
          )}
        </section>
      )}
      <dl className={styles.totals}>
        <div>
          <dt>Opening balance</dt>
          <dd>{balanceLabel(statement.openingCents)}</dd>
        </div>
        <div>
          <dt>Top-ups</dt>
          <dd>
            {formatUsd(
              statement.topUps.reduce(
                (sum, top) => sum + top.usdCents + top.bonusCents,
                0,
              ),
            )}
          </dd>
        </div>
        <div>
          <dt>Resolved cases billed</dt>
          <dd>{formatUsd(billed)}</dd>
        </div>
        <div>
          <dt>Credits</dt>
          <dd>{formatUsd(credited)}</dd>
        </div>
        <div>
          <dt>Closing balance</dt>
          <dd>{balanceLabel(statement.closingCents)}</dd>
        </div>
      </dl>
      <section aria-labelledby="statement-topups">
        <h2 id="statement-topups">Top-ups</h2>
        {statement.topUps.length === 0 ? (
          <p>None this month.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Paid</th>
                <th scope="col">Network</th>
                <th scope="col">Paid from</th>
                <th scope="col">Transaction</th>
                <th scope="col">Amount</th>
                <th scope="col">Credit</th>
              </tr>
            </thead>
            <tbody>
              {statement.topUps.map((top) => (
                <Fragment
                  key={`${top.txHash}:${top.logIndex ?? top.instructionIndex}`}
                >
                  <tr>
                    <td>{day(top.paidAt)}</td>
                    <td>{networkName(top.chain)}</td>
                    <td className={styles.mono}>{top.payer}</td>
                    <td className={styles.mono}>{top.txHash}</td>
                    <td>{formatUsd(top.usdCents)}</td>
                    <td>{formatUsd(top.bonusCents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={6}>
                      <dl className={styles.details}>
                        <dt>Rail</dt>
                        <dd>{top.rail}</dd>
                        <dt>Token</dt>
                        <dd>{top.token}</dd>
                        <dt>Recipient</dt>
                        <dd className={styles.mono}>{top.recipient}</dd>
                        <dt>Transfer index</dt>
                        <dd>{top.logIndex ?? top.instructionIndex}</dd>
                        <dt>Request</dt>
                        <dd>{top.requestId}</dd>
                        <dt>Credited</dt>
                        <dd>{top.creditedAt ? day(top.creditedAt) : ""}</dd>
                        {top.orderFormId && (
                          <>
                            <dt>Order form</dt>
                            <dd>
                              {top.orderFormTitle
                                ? `${top.orderFormTitle}, ${top.orderFormId}`
                                : top.orderFormId}
                              {top.orderFormRevision
                                ? `, revision ${top.orderFormRevision}`
                                : ""}
                            </dd>
                          </>
                        )}
                      </dl>
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="statement-cases">
        <h2 id="statement-cases">Resolved cases</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Price</th>
              <th scope="col">Cases</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {statement.steps.map((step) => (
              <tr key={step.priceCents}>
                <td>{formatUsd(step.priceCents)}</td>
                <td>{step.cases.toLocaleString("en-US")}</td>
                <td>{formatUsd(step.cents)}</td>
              </tr>
            ))}
            <tr>
              <td>Free</td>
              <td>{statement.free.toLocaleString("en-US")}</td>
              <td>{formatUsd(0)}</td>
            </tr>
            <tr>
              <td>From credit</td>
              <td>{statement.grant.toLocaleString("en-US")}</td>
              <td>{formatUsd(0)}</td>
            </tr>
          </tbody>
        </table>
        {statement.truncated && (
          <p>
            This month had more charges than one statement lists; the totals
            above cover the ones listed.
          </p>
        )}
      </section>
      <section aria-labelledby="statement-prices">
        <h2 id="statement-prices">Charge prices</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Charge</th>
              <th scope="col">Price source</th>
              <th scope="col">Reason</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {statement.charges.map((charge) => (
              <tr key={charge.ref}>
                <td className={styles.mono}>{charge.ref}</td>
                <td>
                  {charge.pilot
                    ? `${charge.pilot.title}, order form ${charge.pilot.id}, revision ${charge.pilot.revision}`
                    : charge.priceSource.kind === "order-form"
                      ? `Order form ${charge.priceSource.id}, revision ${charge.priceSource.revision}`
                      : `Public price ${charge.priceSource.version}`}
                </td>
                <td>
                  {charge.billingReason === "no Templ contribution"
                    ? "Not billed: no Templ step"
                    : contributionBillingLabel(charge.contributions)}
                  {charge.capReason && <p>{charge.capReason}</p>}
                </td>
                <td>{formatUsd(charge.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {statement.pilotCredits.length > 0 && (
        <section aria-labelledby="statement-pilot-credit">
          <h2 id="statement-pilot-credit">Upfront credit applied</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Charge</th>
                <th scope="col">Pilot</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {statement.pilotCredits.map((credit) => (
                <tr key={credit.ref}>
                  <td className={styles.mono}>{credit.ref}</td>
                  <td>
                    {credit.pilot.title}, order form {credit.pilot.id}, revision{" "}
                    {credit.pilot.revision}
                  </td>
                  <td>{formatUsd(credit.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {statement.credits.length + statement.incidents.length > 0 && (
        <section aria-labelledby="statement-credits">
          <h2 id="statement-credits">Credits</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Charge</th>
                <th scope="col">Reason</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {statement.credits.map((credit) => (
                <tr key={credit.ref}>
                  <td className={styles.mono}>{credit.ref}</td>
                  <td>{REASONS[credit.reason]}</td>
                  <td>{formatUsd(credit.cents)}</td>
                </tr>
              ))}
              {statement.incidents.map((incident) => (
                <tr key={incident.at}>
                  <td>{day(incident.at)}</td>
                  <td>Credit from Templ</td>
                  <td>{formatUsd(incident.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}

/** One top-up's receipt as a printable page. */
export function ReceiptDocument({
  room,
  tx,
}: {
  room: ChatRoomId;
  tx: string;
}) {
  const { auth, account, current } = useSignedRead<{
    receipts: ProductPaymentReceipt[];
  }>(room, { kind: "receipts" });
  if (!account) return <SignIn auth={auth} />;
  if (!current)
    return (
      <p role="status" className={styles.status}>
        Loading the receipt…
      </p>
    );
  if (current.error || !current.value)
    return (
      <p role="alert" className={styles.status}>
        {current.error}
      </p>
    );
  const receipt: ProductPaymentReceipt | undefined =
    current.value.receipts.find(
      (entry) => entry.txHash.toLowerCase() === tx.toLowerCase(),
    );
  if (!receipt)
    return (
      <p role="alert" className={styles.status}>
        This workspace has no receipt for that payment.
      </p>
    );
  const network =
    receipt.chainId === "solana"
      ? "Solana"
      : getChatChain(receipt.chainId).name;
  return (
    <article className={styles.document}>
      <header className={styles.head}>
        <div>
          <h1>Receipt</h1>
          <p className={styles.issuer}>Issued by Templ.</p>
        </div>
        <button
          type="button"
          className={styles.print}
          onClick={() => window.print()}
        >
          Print
        </button>
      </header>
      <dl className={styles.totals}>
        <div>
          <dt>Paid</dt>
          <dd>{day(receipt.paidAt)}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{formatUsd(receipt.usdCents)}</dd>
        </div>
        <div>
          <dt>{receipt.settlement ? "Applied to debt" : "Credit added"}</dt>
          <dd>
            {formatUsd(
              receipt.settlement ? receipt.usdCents : receipt.bonusCents,
            )}
          </dd>
        </div>
        <div>
          <dt>{receipt.settlement ? "Amount due after" : "Balance after"}</dt>
          <dd>
            {balanceLabel(
              receipt.settlement
                ? Math.max(0, -receipt.balanceAfterCents)
                : receipt.balanceAfterCents,
            )}
          </dd>
        </div>
      </dl>
      <dl className={styles.details}>
        <dt>Network</dt>
        <dd>
          {receipt.asset.symbol} on {network}
        </dd>
        <dt>Rail</dt>
        <dd>{receipt.rail}</dd>
        <dt>Recipient</dt>
        <dd className={styles.mono}>{receipt.recipient}</dd>
        <dt>Transfer index</dt>
        <dd>{receipt.logIndex ?? receipt.instructionIndex}</dd>
        <dt>Request</dt>
        <dd>{receipt.requestId}</dd>
        {receipt.orderFormId && (
          <>
            <dt>Order form</dt>
            <dd>{receipt.orderFormId}</dd>
          </>
        )}
        <dt>Credited</dt>
        <dd>{day(receipt.creditedAt)}</dd>
        <dt>Paid from</dt>
        <dd className={styles.mono}>{receipt.payer}</dd>
        <dt>Transaction</dt>
        <dd className={styles.mono}>
          <a
            href={`${receipt.chainId === "solana" ? "https://explorer.solana.com" : getChatChain(receipt.chainId).explorer}/tx/${receipt.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {receipt.txHash}
          </a>
        </dd>
      </dl>
    </article>
  );
}
