"use client";

import { useState, type FormEvent } from "react";
import { formatStandardAiRate } from "@templ/chat/standard-usage";

import type { StandardPlanView } from "@templ/chat/standard-plan";
import { PRODUCT_STARTER_PRICES, PRODUCT_STANDARD_PRICES, PRODUCT_LIMITS, PRODUCT_TOP_UP } from "@templ/chat/plans";
import { useChatAuth } from "@/lib/chat-auth";
import { normalizeChatRoomId } from "@/lib/chat-room-id";
import { saveStarterAiLimit } from "@/lib/product-client";
import { formatDay, formatUsd } from "@/lib/product-format";
import { WorkspaceAccessPlan } from "./workspace-access-plan";
import { TalkToTempl } from "./talk-to-templ";
import { Badge, Card, Stat } from "./ui/ui";
import styles from "./standard-workspace-plan.module.css";

export function StandardWorkspacePlan({
  plan,
  workspace,
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
  const startingPrice = plan.starterAvailable && (
    !period || period.usage?.priceVersion === PRODUCT_STARTER_PRICES.publishedOn
  ) ? PRODUCT_STARTER_PRICES : PRODUCT_STANDARD_PRICES;
  const starterActive = plan.starterAiLimitCents !== undefined;
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
            ? (period?.annual ? "Active year" : "Active month")
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
          {starterActive && <span>Starter</span>}
          {paid && usage?.priceVersion === PRODUCT_STANDARD_PRICES.publishedOn && <span>Plus</span>}
          {!paid && !agreedBilling && plan.starterAvailable && !period ? <span>From</span> : null}
          {formatUsd(
            period && (paid || agreedBilling)
              ? (period.annual?.totalCents ?? period.workspaceMonthlyCents)
              : startingPrice.workspaceMonthlyUsdCents,
          )}
          <span>/{period?.annual ? "year" : "month"} per workspace</span>
        </p>
        <p className={styles.note}>
          Standard features are included where available. No seat fees.
        </p>
        <p className={styles.note}>Your own AI has no Templ AI usage charge.</p>
        {paid && (
          <p className={styles.access}>
            {`Access through ${formatDay(new Date(plan.accessEndsAt ?? period!.endsAt).toISOString())}.`}
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
                {formatDay(new Date(plan.accessEndsAt ?? period!.endsAt).toISOString())}. Added credit does not renew your plan.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          {!customAgreement && (
            <div className={styles.group}>
              <h3>Included each month</h3>
              {plan.starterAvailable && (
                <p className={styles.note}>
                  Choose Starter or Plus. Both include all seats.
                </p>
              )}
              <div className={styles.stats}>
                <Stat
                  label="Answered cases"
                  value={String(
                    startingPrice.includedAnsweredCasesPerMonth,
                  )}
                />
                <Stat
                  label="AI credit"
                  value={formatUsd(
                    startingPrice.includedAiCreditUsdCents,
                  )}
                />
              </div>
              <p className={styles.note}>
                Extra answered cases cost{" "}
                {formatUsd(
                  startingPrice.additionalAnsweredCaseUsdCents,
                )}{" "}
                each.
              </p>
              <p className={styles.note}>
                {startingPrice === PRODUCT_STARTER_PRICES
                  ? "Starter includes no Templ AI credit. Add prepaid USDC and set a monthly limit to use Templ AI."
                  : `AI use costs ${formatStandardAiRate(startingPrice)}× GPT-6.1 Sol’s standard API rates.`}
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
                {period ? "Renew month" : "Choose a plan"}
              </button>
              <p className={styles.note}>
                Access starts after Templ verifies payment.
              </p>
            </div>
          )}
        </>
      )}
      {period && workspace && plan.starterAiLimitCents !== undefined && (
        <StarterAiLimit
          key={`${workspace}:${period.id}:${plan.starterAiLimitCents}`}
          workspace={workspace}
          period={period.id}
          initialCents={plan.starterAiLimitCents}
        />
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
              : starterActive
                ? "Extra answered cases and Templ AI use prepaid USDC. Your AI limit applies only to Templ AI."
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

function StarterAiLimit({ workspace, period, initialCents }: {
  workspace: string;
  period: string;
  initialCents: number;
}) {
  const auth = useChatAuth();
  const [saved, setSaved] = useState(initialCents);
  const [dollars, setDollars] = useState(String(initialCents / 100));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const cents = /^\d{1,5}(?:\.\d{1,2})?$/.test(dollars.trim())
    ? Math.round(Number(dollars) * 100)
    : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || cents === null || cents > PRODUCT_TOP_UP.maxUsdCents) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await saveStarterAiLimit(
        auth.session?.principalId,
        normalizeChatRoomId(workspace),
        { cents, expectedCents: saved, expectedPeriod: period },
      );
      setSaved(result.cents);
      setStatus("AI limit saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the AI limit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.group} onSubmit={(event) => void submit(event)}>
      <h3>Templ AI spending limit</h3>
      <label>
        Monthly limit in US dollars
        <input
          type="number"
          value={dollars}
          min={0}
          max={PRODUCT_TOP_UP.maxUsdCents / 100}
          step="0.01"
          onChange={(event) => setDollars(event.target.value)}
        />
      </label>
      <p className={styles.note}>Set $0 to stop new Templ AI requests. Requests already running can finish.</p>
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={busy || cents === null || cents === saved || cents > PRODUCT_TOP_UP.maxUsdCents}>
          Save AI limit
        </button>
        <p role="status">{status}</p>
      </div>
    </form>
  );
}
