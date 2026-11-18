"use client";

import { formatStandardAiRate } from "@templ/chat/standard-usage";

import type { StandardPlanView } from "@templ/chat/standard-plan";
import { PRODUCT_STANDARD_PRICES, PRODUCT_LIMITS } from "@templ/chat/plans";
import { formatDay, formatUsd } from "@/lib/product-format";
import { WorkspaceAccessPlan } from "./workspace-access-plan";
import { TalkToTempl } from "./talk-to-templ";
import { Badge, Card, Stat } from "./ui/ui";
import styles from "./standard-workspace-plan.module.css";

export function StandardWorkspacePlan({
  plan,
  onPay,
  canPay = false,
}: {
  plan: StandardPlanView;
  workspace?: string;
  onPay?: (purpose: "period" | "credit") => void;
  canPay?: boolean;
}) {
  if (plan.continuesOnDebt) return <WorkspaceAccessPlan />;
  const paid = plan.status === "paid";
  const period = plan.period;
  const usage = paid ? period?.usage : undefined;
  const included = period?.includedAiResolutions ?? plan.includedAiResolutions;
  const aiPrice =
    period?.additionalAiResolutionCents ?? plan.additionalAiResolutionCents;
  const aiUsageNanos = usage ? BigInt(usage.aiUsageUsdNanos) : 0n;
  const aiUse =
    aiUsageNanos > 0n && aiUsageNanos < 10_000_000n
      ? "Less than $0.01"
      : formatUsd(Number((aiUsageNanos + 5_000_000n) / 10_000_000n));
  const prepaid = plan.prepaid;
  const agreedBilling = prepaid?.mode === "debt" || prepaid?.mode === "custom";
  const customAgreement = prepaid?.mode === "custom";
  const currentPrepaid =
    paid && prepaid && prepaid.period?.id === period?.id
      ? prepaid.period
      : null;
  const nanos = (value: string) => {
    const amount = BigInt(value);
    return amount > 0n && amount < 10_000_000n
      ? "Less than $0.01"
      : formatUsd(Number(amount / 10_000_000n));
  };
  return (
    <Card
      title={period || agreedBilling ? "Workspace plan" : "Free integration"}
      actions={
        <Badge tone={paid ? "brand" : "neutral"}>
          {paid
            ? "Active month"
            : period
              ? "Month inactive"
              : agreedBilling
                ? "Access needed"
                : "Test workspace"}
        </Badge>
      }
      bodyClassName={styles.body}
      footer={
        <div className={styles.footer}>
          <p>No automatic renewal.</p>
          {!agreedBilling && (
            <TalkToTempl
              label="Chat with Templ"
              className="button small secondary"
            >
              Chat with Templ
            </TalkToTempl>
          )}
        </div>
      }
    >
      <div className={styles.overview}>
        <p className={styles.price}>
          {formatUsd(
            period && (paid || agreedBilling)
              ? period.workspaceMonthlyCents
              : PRODUCT_STANDARD_PRICES.workspaceMonthlyUsdCents,
          )}
          <span>/month per workspace</span>
        </p>
        <p className={styles.note}>
          Standard features are included where available. No seat fees.
        </p>
        <p className={styles.note}>Your own AI has no Templ AI usage charge.</p>
        {paid && (
          <p className={styles.access}>
            {`Access through ${formatDay(new Date(period!.endsAt).toISOString())}.`}
          </p>
        )}
      </div>
      {paid ? (
        <>
          {usage ? (
            <div className={styles.group}>
              <h3>Current period</h3>
              <div className={styles.stats}>
                <Stat
                  label={
                    currentPrepaid
                      ? "Answered cases"
                      : "Reviewed answered cases"
                  }
                  value={
                    usage.aiReviewedThrough === null && !currentPrepaid
                      ? "Awaiting review"
                      : String(usage.answeredCases)
                  }
                  hint={`${usage.includedAnsweredCases} included`}
                />
                <Stat
                  label="Extra case charges"
                  value={
                    usage.aiReviewedThrough === null && !currentPrepaid
                      ? "Awaiting review"
                      : formatUsd(usage.answeredCaseChargedCents)
                  }
                />
                <Stat
                  label="Reviewed AI use"
                  value={
                    usage.aiReviewedThrough === null ? "Awaiting review" : aiUse
                  }
                  hint={`${formatUsd(usage.includedAiCreditCents)} credit included`}
                />
                <Stat
                  label="Reviewed AI charges"
                  value={
                    usage.aiReviewedThrough === null
                      ? "Awaiting review"
                      : formatUsd(usage.aiUsageChargedCents)
                  }
                />
              </div>
              <p className={styles.note}>
                Extra answered cases cost{" "}
                {formatUsd(usage.additionalAnsweredCaseCents)} each. Normal
                follow-ups add no extra case fee.
              </p>
              <p className={styles.note}>
                AI use follows {formatStandardAiRate(usage)}× the GPT-6.1 Sol
                standard API rates recorded for this period. Drafts and Telegram
                assistance use AI credit too.
              </p>
              <p className={styles.note}>
                {usage.aiReviewedThrough === null
                  ? "AI charges await their first review."
                  : `Latest AI review: ${formatDay(usage.aiReviewedThrough)}.`}
                {usage.aiUsageMissing > 0 &&
                  ` AI cost data needs review for ${usage.aiUsageMissing} calls.`}
              </p>
              <p className={styles.note}>
                Templ covers its own errors, failed calls and loops.
              </p>
            </div>
          ) : (
            <div className={styles.group}>
              <Stat
                label="Confirmed AI resolutions"
                value={
                  included > 0
                    ? `${period!.confirmedAiResolutions} / ${included} included`
                    : String(period!.confirmedAiResolutions)
                }
              />
              <p className={styles.note}>
                {included > 0
                  ? "Additional confirmed Templ AI resolutions cost "
                  : "Optional Templ AI costs "}
                {formatUsd(aiPrice)}
                {included > 0 ? " each." : " per confirmed resolution."} This
                period keeps its recorded terms.
              </p>
            </div>
          )}
          <div className={styles.total}>
            <Stat label="Amount due" value={formatUsd(plan.dueCents)} />
          </div>
          {!customAgreement && (
            <div className={styles.group}>
              <h3>Renewal</h3>
              <p className={styles.note}>
                Renew here after{" "}
                {formatDay(new Date(period!.endsAt).toISOString())}. Early
                renewal is not available. Added credit does not renew your
                month.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          {!customAgreement && (
            <div className={styles.group}>
              <h3>Included each month</h3>
              <div className={styles.stats}>
                <Stat
                  label="Answered cases"
                  value={String(
                    PRODUCT_STANDARD_PRICES.includedAnsweredCasesPerMonth,
                  )}
                />
                <Stat
                  label="AI credit"
                  value={formatUsd(
                    PRODUCT_STANDARD_PRICES.includedAiCreditUsdCents,
                  )}
                />
              </div>
              <p className={styles.note}>
                Extra answered cases cost{" "}
                {formatUsd(
                  PRODUCT_STANDARD_PRICES.additionalAnsweredCaseUsdCents,
                )}{" "}
                each.
              </p>
              <p className={styles.note}>
                AI use costs {formatStandardAiRate(PRODUCT_STANDARD_PRICES)}×
                GPT-6.1 Sol’s standard API rates. This includes the use covered
                by your credit.
              </p>
            </div>
          )}
          {!agreedBilling && (
            <div className={styles.testing}>
              <h3>Test your integration</h3>
              <p>
                <strong>
                  {plan.ticketsUsed} of {plan.ticketsTotal}
                </strong>{" "}
                test tickets used. Each ticket allows{" "}
                {PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies. Templ AI
                is off.
              </p>
              <p>
                {plan.ticketsUsed >= plan.ticketsTotal
                  ? "Your free tickets are used. Pay for workspace access to continue."
                  : "Use these tickets to test your integration. Pay when you are ready to go live."}
              </p>
            </div>
          )}
          {plan.dueCents > 0 && (
            <Stat label="Earlier amount due" value={formatUsd(plan.dueCents)} />
          )}
          {!customAgreement && (
            <div className={styles.actions}>
              <button
                type="button"
                className={plan.dueCents > 0 ? "button-secondary" : "button"}
                disabled={!canPay || !onPay}
                onClick={() => onPay?.("period")}
              >
                {period ? "Renew month" : "Start paid month"}
              </button>
              <p className={styles.note}>
                Your month starts after Templ verifies payment.
              </p>
            </div>
          )}
        </>
      )}
      {prepaid && (
        <div className={styles.group}>
          <h3>Available funds</h3>
          <div className={styles.stats}>
            {currentPrepaid && (
              <Stat
                label="AI credit available"
                value={nanos(currentPrepaid.includedAiAvailableUsdNanos)}
              />
            )}
            <Stat
              label="Prepaid USDC available"
              value={nanos(prepaid.cashAvailableUsdNanos)}
            />
          </div>
          <p className={styles.note}>
            {agreedBilling
              ? "USDC pays recorded charges first. The rest stays as credit. Your agreed rates and credit terms stay unchanged."
              : currentPrepaid
                ? "AI work uses included credit first, then prepaid USDC. AI pauses when funds cannot cover the next request."
                : paid
                  ? "Added USDC stays in your prepaid balance. It does not change this month’s recorded billing terms."
                  : "Cash credit stays after your month ends. Adding credit does not start or renew monthly access."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={
                paid || customAgreement || plan.dueCents > 0
                  ? "button"
                  : "button-secondary"
              }
              disabled={!canPay || !onPay}
              onClick={() => onPay?.("credit")}
            >
              {plan.dueCents > 0
                ? "Pay amount due"
                : currentPrepaid
                  ? "Add AI credit"
                  : "Add funds"}
            </button>
          </div>
        </div>
      )}
      {agreedBilling && (
        <div className={styles.group}>
          <h3>Agreed billing</h3>
          <p className={styles.note}>
            {prepaid.mode === "debt"
              ? "Your workspace can use Templ before paying. You can pay now or add funds at any time."
              : "Your workspace uses a custom billing agreement. You can pay recorded charges or add funds."}
          </p>
          <p className={styles.note}>
            Open our chat to discuss renewal under your agreed terms.
          </p>
          <div className={styles.actions}>
            <TalkToTempl
              label="Discuss renewal"
              className="button small secondary"
            >
              Discuss renewal
            </TalkToTempl>
          </div>
        </div>
      )}
      {!canPay && (!paid || prepaid) && (
        <p className={styles.unavailable}>
          USDC payments are not available here yet.
        </p>
      )}
    </Card>
  );
}
