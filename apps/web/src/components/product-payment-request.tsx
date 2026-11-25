"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { getChatChain } from "@templ/chat/chains";
import type { ProductPaymentIntent } from "@templ/chat/product-payment";
import { formatStandardAiRate } from "@templ/chat/standard-usage";
import { trackEvent } from "@/lib/analytics";
import { productPaymentAmount } from "@/lib/product-payment-amount";
import { formatUsd } from "@/lib/product-format";
import styles from "./product-payment-request.module.css";

export const paymentNetworkName = (network: ProductPaymentIntent["chainId"]) =>
  network === "solana" ? "Solana" : getChatChain(network).name;
function paymentRequestState(request: ProductPaymentIntent, now = Date.now()) {
  if (request.status === "credited")
    return request.settlement === "standard-prepaid"
      ? "Payment verified"
      : "Credited";
  if (request.verificationReviewRequired)
    return "This transfer needs a payment review. Do not send it again.";
  if (request.status === "expired" || Date.parse(request.expiresAt) <= now)
    return "Expired";
  if (request.status === "replaced") return "Replaced";
  if (
    (request.confirmation?.kind === "evm" &&
      request.confirmation.remainingBlocks === "0") ||
    (request.confirmation?.kind === "solana" &&
      request.confirmation.commitment === "finalized")
  )
    return "Transfer finalized. Verifying payment.";
  if (request.status === "seen")
    return "Transfer found. Waiting for network finality.";
  if (request.submittedTx) return "Transfer submitted. Checking the network.";
  return "Waiting for your transfer";
}
function CopyValue({
  label,
  value,
  copy = value,
}: {
  label: string;
  value: string;
  copy?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className={styles.value}>{value}</span>
        <button
          type="button"
          className={styles.copy}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            setFailed(false);
            void (async () => {
              try {
                await navigator.clipboard.writeText(copy);
                setCopied(true);
                trackEvent("payment_detail_copied");
              } catch {
                setFailed(true);
                trackEvent("payment_failed");
                console.warn("TEMPL_SUPPORT_FAILURE", {
                  route: "payment",
                  step: "copy",
                  cause: "copy-failed",
                });
              }
            })();
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {failed && <span role="alert"> Copy failed.</span>}
      </dd>
    </>
  );
}
export function ProductPaymentRequestDetails({
  request,
  onCheck,
  busy = false,
  checkoutAction,
  recoveryActions,
  recoveryRequired = false,
}: {
  request: ProductPaymentIntent;
  onCheck?: () => void;
  busy?: boolean;
  checkoutAction?: ReactNode;
  recoveryActions?: ReactNode;
  recoveryRequired?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const next = request.verificationReviewRequired
    ? Infinity
    : Math.min(
        Date.parse(request.expiresAt),
        (request.checkAgainAt ?? 0) > now ? request.checkAgainAt! : Infinity,
      );
  useEffect(() => {
    if (!Number.isFinite(next) || next <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), next - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [next]);
  const state = paymentRequestState(request, now);
  const amount = productPaymentAmount(request);
  const closed =
    !["open", "seen"].includes(request.status) || state === "Expired";
  const confirmation = request.confirmation;
  const finalized =
    request.status === "credited" ||
    (confirmation?.kind === "evm"
      ? confirmation.remainingBlocks === "0"
      : confirmation?.commitment === "finalized");
  const completedSteps =
    request.status === "credited"
      ? 4
      : finalized
        ? 3
        : confirmation || request.status === "seen"
          ? 2
          : request.submittedTx
            ? 1
            : 0;
  const reviewing =
    !closed &&
    !request.verificationReviewRequired &&
    !request.submittedTx &&
    completedSteps === 0;
  const network = paymentNetworkName(request.chainId);
  const transactionUrl = request.submittedTx
    ? `${request.kind === "solana" ? "https://explorer.solana.com" : getChatChain(request.chainId).explorer}/tx/${request.submittedTx}`
    : null;
  const finalityMinutes = Math.max(
    1,
    Math.ceil(request.expectedFinalitySeconds / 60),
  );
  const finalityEstimate =
    request.expectedFinalitySeconds < 60
      ? `${request.expectedFinalitySeconds} seconds`
      : `${finalityMinutes} ${finalityMinutes === 1 ? "minute" : "minutes"}`;
  const checkAgain = onCheck &&
    !closed &&
    !request.verificationReviewRequired && (
      <>
        <button
          type="button"
          className={styles.check}
          disabled={busy || (request.checkAgainAt ?? 0) > now}
          onClick={onCheck}
        >
          Check again
        </button>
        {(request.checkAgainAt ?? 0) > now && (
          <p className={styles.note}>
            Check again at{" "}
            {new Date(request.checkAgainAt!).toLocaleTimeString()}.
          </p>
        )}
      </>
    );
  return (
    <section aria-label="Payment request" className={styles.request}>
      {request.orderFormId && (
        <>
          <h3>Payment request from Templ</h3>
          <p>
            Order form: {request.orderFormId}
            {request.orderFormRevision
              ? `, revision ${request.orderFormRevision}`
              : ""}
          </p>
        </>
      )}
      {(!reviewing || recoveryActions === undefined) && (
        <p
          role="status"
          className={styles.status}
          data-verified={request.status === "credited"}
        >
          {state}
        </p>
      )}
      <div className={styles.amount}>
        <span>
          {request.standard?.purpose === "annual" ? "Annual access" : request.standard?.purpose === "period"
            ? "Monthly access"
            : request.standard?.purpose === "credit"
              ? "Prepaid credit"
              : "Payment amount"}
        </span>
        <strong>
          {formatUnits(BigInt(amount.amountRaw), request.asset.decimals)}{" "}
          {request.asset.symbol}
        </strong>
        <span>On {network}</span>
        {request.standard?.purpose === "credit" && (
          <span>Pays recorded charges first. The rest stays as credit. This does not renew monthly access.</span>
        )}
      </div>
      {request.kind === "solana" && !closed && !request.submittedTx && (
        <p className={styles.note}>
          A new recipient token account needs a rent deposit in SOL. Your wallet
          shows it before you confirm.
        </p>
      )}
      {recoveryRequired && (
        <p role="status">
          The wallet response is unknown. Check your wallet history and enter
          the transfer in Payment details.
        </p>
      )}
      {checkoutAction}
      {completedSteps > 0 && (!closed || request.status === "credited") && (
        <div className={styles.progress}>
          <ol className={styles.stages} aria-label="Payment progress">
            {[
              "Sent",
              request.kind === "solana" ? "Confirmed" : "Included",
              "Finalized",
              request.settlement === "standard-prepaid"
                ? "Verified"
                : "Credited",
            ].map((label, index) => (
              <li
                key={label}
                data-complete={index < completedSteps}
                aria-current={index === completedSteps ? "step" : undefined}
                aria-label={`${label}: ${index < completedSteps ? "complete" : index === completedSteps ? "in progress" : "pending"}`}
              >
                <span aria-hidden="true">
                  {index < completedSteps ? "✓" : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          {!finalized && !request.verificationReviewRequired && (
            <div className={styles.explanation}>
              <p>
                {request.status === "seen"
                  ? `Your transfer reached ${network}. We’re waiting for network finality.`
                  : `Your transaction was submitted. We’re checking for its transfer on ${network}.`}
              </p>
              <p className={styles.note}>
                Allow about {finalityEstimate} for finality. Network delays can
                take longer.
                {request.chainId === 8453 &&
                  " Base also waits for Ethereum to finalize its transaction data."}
              </p>
            </div>
          )}
          {finalized &&
            request.status !== "credited" &&
            !request.verificationReviewRequired && (
              <p className={styles.note}>
                We’re checking both providers before saving your receipt.
              </p>
            )}
          {confirmation?.kind === "evm" && (
            <>
              <dl className={styles.finality}>
                <dt>Your transfer block</dt>
                <dd>
                  {BigInt(confirmation.transactionBlock).toLocaleString()}
                </dd>
                {confirmation.finalizedBlock !== null && (
                  <>
                    <dt>Finalized through</dt>
                    <dd>
                      {BigInt(confirmation.finalizedBlock).toLocaleString()}
                    </dd>
                  </>
                )}
              </dl>
              {confirmation.remainingBlocks !== null && !finalized && (
                <p className={styles.note}>
                  Finality is{" "}
                  {BigInt(confirmation.remainingBlocks).toLocaleString()} blocks
                  behind your transfer.
                </p>
              )}
            </>
          )}
          {confirmation?.kind === "solana" && (
            <p className={styles.note}>
              Slot {BigInt(confirmation.slot).toLocaleString()}.{" "}
              {confirmation.commitment === "finalized"
                ? "Finalized on Solana."
                : "Confirmed on Solana. Waiting for finality."}
            </p>
          )}
          {confirmation && (
            <p className={styles.note}>
              Last network check:{" "}
              {new Date(confirmation.checkedAt).toLocaleTimeString()}.
            </p>
          )}
          {!closed &&
            !request.verificationReviewRequired &&
            (request.nextCheckAt ?? 0) > now && (
              <p className={styles.note}>
                Next automatic check:{" "}
                {new Date(request.nextCheckAt!).toLocaleTimeString()}.
              </p>
            )}
          {transactionUrl && (
            <a href={transactionUrl} target="_blank" rel="noopener noreferrer">
              View transaction
            </a>
          )}
        </div>
      )}
      {request.verificationReviewRequired && request.status !== "credited" && (
        <p className={styles.note}>
          Chat with Templ to review this payment. Keep this request’s
          transaction details.
        </p>
      )}
      {request.submittedTx &&
        !closed &&
        !request.verificationReviewRequired && (
          <p className={styles.note}>
            We check automatically. You can close this page and return to Plan
            &amp; usage. Do not send another transfer.
          </p>
        )}
      <details className={styles.details} open={recoveryRequired || undefined}>
        <summary>Payment details</summary>
        <dl className={styles.values}>
          <CopyValue
            label="Network"
            value={paymentNetworkName(request.chainId)}
          />
          <CopyValue label="Recipient" value={request.recipient} />
          {request.orderFormId && (
            <>
              <CopyValue
                label="Invoice amount"
                value={formatUsd(request.usdCents)}
              />
              <CopyValue
                label="Credited"
                value={formatUsd(request.creditedCents ?? 0)}
              />
              <CopyValue
                label="Amount left"
                value={formatUsd(amount.usdCents)}
              />
            </>
          )}
        </dl>
        <dl className={styles.values}>
          <CopyValue
            label="Token"
            value={`${request.asset.label} (${request.asset.address})`}
            copy={request.asset.address}
          />
          <CopyValue
            label="Exact amount"
            value={`${formatUnits(BigInt(amount.amountRaw), request.asset.decimals)} ${request.asset.symbol}`}
          />
          <CopyValue label="Payer" value={request.payer} />
          {request.submittedTx && (
            <CopyValue label="Transaction" value={request.submittedTx} />
          )}
        </dl>
        {request.standard && (
          <div className={styles.terms}>
            <strong>Plan terms</strong>
            <p>
              {request.standard.purpose !== "credit"
                ? `${request.standard.purpose === "annual" ? "Twelve months from verified activation. Each month includes" : "One month from verified activation. Includes"} ${request.standard.includedAnsweredCases} answered cases and ${formatUsd(request.standard.includedAiCreditCents)} in AI credit.`
                : "Pays this workspace’s recorded charges first. Any remainder stays as prepaid credit. This does not renew monthly access."}
            </p>
            {request.standard.purpose !== "credit" ? (
              <p>
                Extra answered cases cost{" "}
                {formatUsd(request.standard.additionalAnsweredCaseCents)} each.
                AI use costs {formatStandardAiRate(request.standard)}× the
                GPT-6.1 Sol standard API rates recorded for this period.
              </p>
            ) : (
              <p>Your workspace’s accepted terms set case and AI prices.</p>
            )}
            <p>No automatic renewal.</p>
          </div>
        )}
        <div className={styles.footer}>
          {!closed && (
            <span>Expires {new Date(request.expiresAt).toLocaleString()}</span>
          )}
          <Link href="/terms">Payment terms</Link>
        </div>
        {reviewing && checkAgain}
        {recoveryActions}
      </details>
      {!reviewing && checkAgain}
    </section>
  );
}
