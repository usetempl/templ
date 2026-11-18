"use client";

import { useRef, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  StandardPlanView,
  StandardPlanPeriod,
} from "@templ/chat/standard-plan";
import { PRODUCT_STANDARD_PRICES } from "@templ/chat/plans";
import {
  standardUsageCharges,
  formatStandardAiRate,
  applyStandardAiRateUsdNanos,
} from "@templ/chat/standard-usage";
import { billingAdmin, type BillingAction } from "@/lib/billing-admin-client";
import { formatDay, formatUsd } from "@/lib/product-format";
import styles from "./admin-billing.module.css";
import { AdminPrepaidPolicy } from "./admin-prepaid-policy";

function localTime(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 23);
}
function usdNanos(value: string): string | null {
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,9})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 1_000_000_000n +
    BigInt(fraction.padEnd(9, "0"))
  ).toString();
}

export function AdminStandardPlan({
  principal,
  workspace,
  plan,
  debtPeriods = [],
  reviewablePeriods = [],
  retainedAccess = false,
  onChanged,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  plan: StandardPlanView;
  debtPeriods?: StandardPlanPeriod[];
  reviewablePeriods?: StandardPlanPeriod[];
  retainedAccess?: boolean;
  onChanged: (message: string) => void;
}) {
  const [action, setAction] = useState("manual-payment");
  const [reference, setReference] = useState("");
  const [founder, setFounder] = useState("");
  const [period, setPeriod] = useState(
    debtPeriods.find((value) => value.id === plan.period?.id)?.id ??
      debtPeriods[0]?.id ??
      "",
  );
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reviewPeriods = [
    plan.period,
    ...reviewablePeriods,
    ...debtPeriods,
  ].filter(
    (value, index, all): value is StandardPlanPeriod =>
      Boolean(value?.usage) &&
      all.findIndex((item) => item?.id === value?.id) === index,
  );
  const [reviewPeriodId, setReviewPeriodId] = useState(
    reviewPeriods[0]?.id ?? "",
  );
  const reviewPeriod = reviewPeriods.find(
    (value) => value.id === reviewPeriodId,
  );
  const [reviewCases, setReviewCases] = useState(
    String(reviewPeriod?.usage?.answeredCases ?? 0),
  );
  const [reviewAi, setReviewAi] = useState("");
  const [reviewMissing, setReviewMissing] = useState("0");
  const [reviewThrough, setReviewThrough] = useState("");
  const running = useRef(false);
  const cents = /^\d+(?:\.\d{1,2})?$/.test(amount)
    ? Math.round(Number(amount) * 100)
    : 0;
  const usage = plan.period?.usage;
  const aiUsageNanos = usage ? BigInt(usage.aiUsageUsdNanos) : 0n;
  const aiUse =
    aiUsageNanos > 0n && aiUsageNanos < 10_000_000n
      ? "less than $0.01"
      : formatUsd(Number((aiUsageNanos + 5_000_000n) / 10_000_000n));
  const isReview = action === "usage-review";
  const baseAiNanos = usdNanos(reviewAi);
  const reviewedThrough = new Date(reviewThrough).getTime();
  const answeredCases = Number(reviewCases);
  const reviewPreview = (() => {
    const terms = reviewPeriod?.usage;
    if (
      !terms ||
      baseAiNanos === null ||
      !/^(?:0|[1-9][0-9]{0,14})$/.test(reviewCases) ||
      !Number.isSafeInteger(answeredCases) ||
      answeredCases < terms.answeredCases
    )
      return null;
    const priced = applyStandardAiRateUsdNanos(baseAiNanos, terms);
    if (priced === null) return null;
    const retailNanos = BigInt(priced);
    if (retailNanos < BigInt(terms.aiUsageUsdNanos)) return null;
    try {
      return {
        ...standardUsageCharges({
          ...terms,
          answeredCases,
          aiUsageUsdNanos: retailNanos.toString(),
        }),
        aiUseCents: Number((retailNanos + 5_000_000n) / 10_000_000n),
      };
    } catch {
      return null;
    }
  })();
  const ready =
    confirmed &&
    reason.trim().length >= 3 &&
    (action === "revoke"
      ? Boolean(plan.period)
      : reference.trim().length >= 3) &&
    (action !== "founder-approved" || founder.trim().length > 0) &&
    (action !== "debt-paid" ||
      (debtPeriods.some(
        (value) =>
          value.id === period && cents <= value.chargedCents - value.paidCents,
      ) &&
        Number.isSafeInteger(cents) &&
        cents > 0)) &&
    (!isReview ||
      Boolean(
        reviewPeriod &&
        reviewPreview &&
        reviewMissing === "0" &&
        Number.isFinite(reviewedThrough) &&
        reviewedThrough >= reviewPeriod.startsAt &&
        reviewedThrough <= reviewPeriod.endsAt &&
        reviewedThrough > (reviewPeriod.usage!.aiReviewedThrough ?? 0),
      ));
  async function save() {
    if (!ready || running.current) return;
    if (isReview && reviewedThrough > Date.now()) {
      setError("Choose a review time no later than now.");
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(reference.trim()),
      );
      const referenceSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const input: BillingAction = isReview
        ? {
            action: "standard-usage-review",
            period: reviewPeriod!.id,
            referenceSha256,
            expectedReviewedThrough: reviewPeriod!.usage!.aiReviewedThrough,
            reviewedThrough,
            answeredCases,
            providerAiUsageUsdNanos: baseAiNanos!,
            aiUsageMissing: 0,
          }
        : action === "revoke"
          ? { action: "standard-access-revoke", period: plan.period!.id }
          : action === "debt-paid"
            ? { action: "standard-debt-paid", period, cents, referenceSha256 }
            : {
                action: "standard-access",
                source: action as "manual-payment" | "founder-approved",
                referenceSha256,
                approvedBy:
                  action === "founder-approved" ? founder.trim() : null,
                expectedPeriod: plan.period?.id ?? null,
              };
      await billingAdmin(principal).act(workspace, {
        ...input,
        reason: reason.trim(),
      });
      setConfirmed(false);
      onChanged(
        isReview
          ? "Usage review recorded."
          : action === "revoke"
            ? "Paid access closed."
            : action === "debt-paid"
              ? "Received payment recorded."
              : "Monthly access recorded.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change did not save. Try again.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className={styles.planStack}>
      <AdminPrepaidPolicy
        principal={principal}
        workspace={workspace}
        plan={plan}
        onChanged={onChanged}
      />
      <section className={styles.panel} aria-label="Standard workspace plan">
        <div className={styles.sectionHeader}>
          <h3>Monthly access</h3>
        </div>
        <p>
          {plan.continuesOnDebt
            ? "Ongoing access. Unpaid debt never pauses support."
            : plan.status === "paid"
              ? `Active through ${formatDay(new Date(plan.period!.endsAt).toISOString())}.`
              : plan.period
                ? "Monthly access ended."
                : retainedAccess
                  ? "Existing access stays in place."
                  : `${plan.ticketsUsed} of ${plan.ticketsTotal} test tickets used.`}{" "}
          Amount due: {formatUsd(plan.dueCents)}.
        </p>
        {plan.period && (
          <p>
            {plan.continuesOnDebt && "Billing period: "}
            {formatDay(new Date(plan.period.startsAt).toISOString())} to{" "}
            {formatDay(new Date(plan.period.endsAt).toISOString())}.{" "}
            {usage
              ? usage.aiReviewedThrough === null
                ? `Usage awaits its first review. ${usage.includedAnsweredCases} answered cases are included.`
                : `${usage.answeredCases} reviewed answered cases, with ${usage.includedAnsweredCases} included.`
              : `${plan.period.confirmedAiResolutions} confirmed AI resolutions.`}
          </p>
        )}
        {usage && (
          <>
            <p>
              Extra case charges:{" "}
              {usage.aiReviewedThrough === null
                ? "awaiting review"
                : formatUsd(usage.answeredCaseChargedCents)}{" "}
              at {formatUsd(usage.additionalAnsweredCaseCents)} per extra
              answered case. Reviewed AI use:{" "}
              {usage.aiReviewedThrough === null ? "awaiting review" : aiUse}{" "}
              against {formatUsd(usage.includedAiCreditCents)} credit.
            </p>
            <p>
              Reviewed AI charges:{" "}
              {usage.aiReviewedThrough === null
                ? "awaiting review"
                : formatUsd(usage.aiUsageChargedCents)}
              .{" "}
              {usage.aiReviewedThrough === null
                ? "AI usage awaits its first review."
                : `Latest AI review: ${formatDay(usage.aiReviewedThrough)}.`}
              {usage.aiUsageMissing > 0 &&
                ` AI cost data needs review for ${usage.aiUsageMissing} calls.`}
            </p>
          </>
        )}
        <div className={styles.formFields}>
          <label className={styles.full}>
            Action
            <select
              value={action}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value;
                setAction(next);
                if (next === "usage-review" && reviewPeriod)
                  setReviewThrough(
                    localTime(Math.min(Date.now(), reviewPeriod.endsAt)),
                  );
                setConfirmed(false);
              }}
            >
              <option value="manual-payment">Record paid month</option>
              <option value="founder-approved" disabled={plan.period !== null}>
                Record approved first month
              </option>
              <option value="debt-paid">Record received payment</option>
              <option
                value="usage-review"
                disabled={reviewPeriods.length === 0}
              >
                Record usage review
              </option>
              <option value="revoke">Close paid access</option>
            </select>
          </label>
          {(action === "manual-payment" || action === "founder-approved") && (
            <p>
              New periods cost{" "}
              {formatUsd(PRODUCT_STANDARD_PRICES.workspaceMonthlyUsdCents)} per
              month with {PRODUCT_STANDARD_PRICES.includedAnsweredCasesPerMonth}{" "}
              answered cases and{" "}
              {formatUsd(PRODUCT_STANDARD_PRICES.includedAiCreditUsdCents)} AI
              credit. Extra cases cost{" "}
              {formatUsd(
                PRODUCT_STANDARD_PRICES.additionalAnsweredCaseUsdCents,
              )}{" "}
              each. AI use costs {formatStandardAiRate(PRODUCT_STANDARD_PRICES)}
              × the GPT-6.1 Sol standard API rates.
            </p>
          )}
          {isReview && (
            <>
              <label>
                Monthly period
                <select
                  value={reviewPeriodId}
                  disabled={busy}
                  onChange={(event) => {
                    const next = reviewPeriods.find(
                      (value) => value.id === event.target.value,
                    );
                    setReviewPeriodId(event.target.value);
                    setReviewCases(String(next?.usage?.answeredCases ?? 0));
                    setReviewAi("");
                    setReviewMissing("0");
                    setReviewThrough(
                      next ? localTime(Math.min(Date.now(), next.endsAt)) : "",
                    );
                    setConfirmed(false);
                  }}
                >
                  {reviewPeriods.map((value) => (
                    <option key={value.id} value={value.id}>
                      {formatDay(value.startsAt)} to {formatDay(value.endsAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reviewed answered cases
                <input
                  value={reviewCases}
                  inputMode="numeric"
                  disabled={busy}
                  onChange={(event) => {
                    setReviewCases(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                Count each case once, after its first answer. Exclude opens,
                greetings, handoff notices, spam, tests and duplicates.
              </p>
              <label>
                Base AI use (USD)
                <input
                  value={reviewAi}
                  inputMode="decimal"
                  disabled={busy}
                  onChange={(event) => {
                    setReviewAi(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                Enter the verified GPT-6.1 Sol standard rate-card total before
                this period’s multiplier. Use up to 9 decimal places. Exclude
                Templ errors, failed calls and loops.
              </p>
              <label>
                Missing AI records
                <input
                  value={reviewMissing}
                  inputMode="numeric"
                  disabled={busy}
                  onChange={(event) => {
                    setReviewMissing(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              {reviewMissing !== "0" && (
                <p role="alert">
                  Complete the missing AI data before recording this review.
                </p>
              )}
              <label>
                Reviewed through
                <input
                  type="datetime-local"
                  step="0.001"
                  value={reviewThrough}
                  disabled={busy}
                  onChange={(event) => {
                    setReviewThrough(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                Use your local time, after the last review and within this
                period.
              </p>
              {reviewPreview && reviewPeriod?.usage && (
                <p>
                  Retail AI use: {formatUsd(reviewPreview.aiUseCents)} at{" "}
                  {formatStandardAiRate(reviewPeriod.usage)}×. Included AI
                  credit: {formatUsd(reviewPeriod.usage.includedAiCreditCents)}.
                  Extra case charges:{" "}
                  {formatUsd(reviewPreview.answeredCaseChargedCents)}. Extra AI
                  charges: {formatUsd(reviewPreview.aiUsageChargedCents)}.
                  Period charges after review:{" "}
                  {formatUsd(reviewPreview.totalChargedCents)}.
                </p>
              )}
              <p>
                Reviewed totals cannot decrease. Corrections need a separate
                credit review.
              </p>
            </>
          )}
          {action === "founder-approved" && (
            <label>
              Approving founder
              <input
                value={founder}
                disabled={busy}
                onChange={(event) => setFounder(event.target.value)}
              />
            </label>
          )}
          {action === "debt-paid" && (
            <>
              <label>
                Monthly period
                <select
                  value={period}
                  disabled={busy}
                  onChange={(event) => setPeriod(event.target.value)}
                >
                  <option value="">Choose a period</option>
                  {debtPeriods.map((value) => (
                    <option key={value.id} value={value.id}>
                      {formatDay(new Date(value.startsAt).toISOString())} to{" "}
                      {formatDay(new Date(value.endsAt).toISOString())}:{" "}
                      {formatUsd(value.chargedCents - value.paidCents)} due
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Received amount (USD)
                <input
                  value={amount}
                  inputMode="decimal"
                  disabled={busy}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
            </>
          )}
          {action !== "revoke" && (
            <label>
              {isReview
                ? "Statement reference"
                : action === "founder-approved"
                  ? "Approval reference"
                  : "Payment reference"}
              <input
                value={reference}
                disabled={busy}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
          )}
          <label>
            Reason
            <input
              value={reason}
              maxLength={280}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </div>
        <label className={styles.confirmation}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {isReview
            ? "I checked the complete statement and excluded Templ errors, failed calls and loops."
            : action === "founder-approved"
              ? "The founder approved this first month's access."
              : action === "revoke"
                ? "Close paid access for this workspace."
                : action === "manual-payment"
                  ? "The customer accepted these prices, and the payment was received outside Templ."
                  : "The stated payment was received outside Templ."}
        </label>
        <p>
          {isReview
            ? "A usage review records charges. It records no payment."
            : "Access records keep their stated source. They create no checkout receipt."}
        </p>
        <button
          className={styles.primary}
          type="button"
          disabled={!ready || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  );
}
