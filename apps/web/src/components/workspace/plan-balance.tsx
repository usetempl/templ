"use client";

import { useState } from "react";
import { IconArrowRight, IconCopy } from "@tabler/icons-react";
import { PRODUCT_USAGE_PAYMENT_RECIPIENT } from "@templ/chat/plans";
import { PRODUCT_CHECKOUT_OPTIONS } from "@templ/chat/product-payment";
import {
  productCheckoutAvailable,
  type CheckoutFeatures,
} from "@/lib/product-payment";
import type { ProductAccessView } from "@templ/chat/product-catalog";
import { formatDay, formatUsd } from "@/lib/product-format";
import {
  RESOLUTION_DEFINITION,
  BILLABLE_CASE_LINE,
  RESOLVED_CASES_DOCS,
  AI_ONLY_DEFINITION,
  balanceLabel,
  balanceLevelLine,
  confirmedShareLine,
  countLabel,
  CUSTOM_PRICING_LINE,
  freeStartLine,
  grantLines,
  planPriceLine,
  priceChangeLine,
  priceSteps,
  runwayLine,
  supportClosedMessage,
} from "@/lib/product-offer";
import { StandardWorkspacePlan } from "@/components/standard-workspace-plan";
import { TalkToTempl } from "@/components/talk-to-templ";
import { useActionToast } from "@/components/action-toast";
import { AppApprovalRequestButton } from "@/components/app-approval-request";
import { Badge, Callout, Card, Stat } from "@/components/ui/ui";
import { MonthActivity } from "./plan-activity";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

const closedManualMessage = supportClosedMessage;

function ManualUsagePaymentInstructions() {
  const { show, toast } = useActionToast();
  const [copying, setCopying] = useState(false);
  async function copyAddress() {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(PRODUCT_USAGE_PAYMENT_RECIPIENT);
      show("Payment address copied.");
    } catch {
      show("Could not copy. Select the address to copy it.");
    } finally {
      setCopying(false);
    }
  }
  return (
    <>
      <details className={plan.manualPayment}>
        <summary>Pay manually</summary>
        <div className={styles.stack}>
          <p>Send USDC or USDT on Ethereum, or USDC on Base.</p>
          <p>Send only the amount due.</p>
          <code className={plan.paymentAddress}>
            {PRODUCT_USAGE_PAYMENT_RECIPIENT}
          </code>
          <div className={plan.chargeActions}>
            <button
              type="button"
              className="button-secondary"
              disabled={copying}
              onClick={() => void copyAddress()}
            >
              <IconCopy aria-hidden="true" /> Copy address
            </button>
            <TalkToTempl label="Tell us you paid">Tell us you paid</TalkToTempl>
          </div>
          <p className={styles.muted}>
            Share your transaction ID with Templ. We check payment before
            reducing your debt.
          </p>
        </div>
      </details>
      {toast}
    </>
  );
}

export function needsCustomPricingSetup(view: ProductAccessView) {
  return (
    !view.standardPlan &&
    !view.manualBilling &&
    !view.usageBilling &&
    view.billing === "off" &&
    view.mode === "free" &&
    !view.balance.everFunded &&
    view.balance.balanceCents === 0 &&
    view.balance.availableCents === 0 &&
    view.balance.pendingCents === 0 &&
    view.balance.creditBaseCents === 0 &&
    view.month.cents === 0 &&
    view.billingSoon === 0 &&
    view.priceSource.kind === "public" &&
    !view.orderForm &&
    !view.pilot &&
    !view.pendingPilot &&
    !view.priceChange
  );
}

const MODE_BADGE = {
  free: { tone: "brand", label: "Demo" },
  funded: { tone: "brand", label: "Active" },
  exempt: { tone: "neutral", label: "Covered by Templ" },
  paused: { tone: "danger", label: "Paused" },
  suspended: { tone: "danger", label: "Suspended" },
} as const;

/** The balance, what it is waiting on and the one action that changes it. */
export function PlanBalance({
  view,
  onTopUp,
  features = {},
  workspace,
}: {
  view: ProductAccessView;
  onTopUp: (purpose?: "period" | "credit") => void;
  features?: CheckoutFeatures;
  workspace?: string;
}) {
  if (view.standardPlan)
    return (
      <StandardWorkspacePlan
        plan={view.standardPlan}
        workspace={workspace}
        onPay={onTopUp}
        canPay={([1, 8453, 56, "solana"] as const).some((network) =>
          productCheckoutAvailable(network, "USDC", features),
        )}
      />
    );
  if (view.usageBilling) {
    const usage = view.usageBilling;
    const checkout = PRODUCT_CHECKOUT_OPTIONS.some(
      ({ network, symbol }) =>
        [1, 8453].includes(Number(network)) &&
        productCheckoutAvailable(network, symbol, features),
    );
    return (
      <Card
        title="Usage and debt"
        footer={
          checkout && (
            <button type="button" className="button" onClick={() => onTopUp()}>
              Pay amount due
            </button>
          )
        }
      >
        <div className={styles.stack}>
          {usage.status === "credit-limit" && (
            <Callout tone="danger">
              The credit limit is reached. Pay the amount due to take new cases.
              Your team can answer existing cases.
            </Callout>
          )}
          {["off", "agreement-needed", "approval-needed"].includes(
            usage.status,
          ) && (
            <Callout>
              {usage.status === "off"
                ? "New charges are off. Earlier amounts remain due."
                : usage.status === "agreement-needed"
                  ? "Ask Templ to record your signed usage agreement."
                  : "Templ must approve your app before paid use starts."}
            </Callout>
          )}
          <div className={styles.grid3}>
            <Stat label="Amount due" value={formatUsd(usage.dueCents)} />
            <Stat
              label="Credit limit"
              value={formatUsd(usage.debtLimitCents)}
            />
            <Stat
              label="Open case reserve"
              value={formatUsd(usage.reservedCents)}
              hint="This credit covers remaining charges. Unused credit returns after final billing."
            />
          </div>
          <p>
            Payments and approved credits reduce your debt. Existing cases stay
            readable.
          </p>
          {Number.isSafeInteger(usage.dueCents) &&
            usage.dueCents > 0 &&
            usage.dueCents ===
              usage.chargedCents -
                usage.disputedCents -
                usage.forgivenCents -
                usage.paidCents &&
            usage.status !== "demo" &&
            usage.status !== "off" && <ManualUsagePaymentInstructions />}
        </div>
      </Card>
    );
  }
  if (view.manualBilling) {
    const manual = view.manualBilling;
    return (
      <Card title="Manual billing">
        <div className={styles.stack}>
          {closedManualMessage(view) && (
            <Callout tone="danger">{closedManualMessage(view)}</Callout>
          )}
          <p>
            {manual.status === "ready"
              ? "Templ bills your team manually. Checkout is off."
              : manual.status === "setup-needed"
                ? "An active software agreement is needed before new charges accrue."
                : "New manual charges are off. Earlier amounts remain due."}
          </p>
          <div className={styles.grid3}>
            <Stat
              label="Amount due"
              value={formatUsd(manual.dueCents)}
              hint="Final charges less approved dispute credits"
            />
            <Stat
              label="Pending estimate"
              value={formatUsd(manual.pendingCents)}
              hint="Final prices can change when grants expire or a lower rate applies"
            />
            <Stat
              label="Charges posted this month"
              value={formatUsd(manual.month.chargedCents)}
              hint={`${countLabel(manual.month.cases)} cases; ${formatUsd(manual.month.creditedCents)} in dispute credits`}
            />
          </div>
        </div>
      </Card>
    );
  }
  const checkoutOpen = PRODUCT_CHECKOUT_OPTIONS.some(({ network, symbol }) =>
    productCheckoutAvailable(network, symbol, features),
  );
  const closed = supportClosedMessage(view);
  const level = closed ? null : balanceLevelLine(view);
  const runway = runwayLine(view);
  const badge = MODE_BADGE[view.mode];
  const negative = view.balance.balanceCents < 0;
  return (
    <Card
      title="Balance"
      actions={
        <Badge tone={badge.tone} dot>
          {badge.label}
        </Badge>
      }
      footer={
        view.mode !== "exempt" &&
        checkoutOpen && (
          <button type="button" className="button" onClick={() => onTopUp()}>
            Add balance
          </button>
        )
      }
    >
      <div className={styles.stack} style={{ gap: 16 }}>
        {view.billing === "off" && (
          <Callout role="note">
            Billing isn’t on yet. Resolved cases are recorded here, and nothing
            is charged.
          </Callout>
        )}
        {closed && (
          <Callout tone="danger" role="alert">
            {closed}
          </Callout>
        )}
        <div className={plan.balance}>
          <span
            className={plan.balanceValue}
            data-negative={negative ? "true" : "false"}
          >
            {balanceLabel(view.balance.balanceCents)}
          </span>
          {level && (
            <p
              className={`${styles.small} ${negative ? plan.negative : ""}`}
              role="status"
              style={{ margin: 0 }}
            >
              {level}
            </p>
          )}
          {runway && (
            <p className={styles.small} style={{ margin: 0 }}>
              {runway}
            </p>
          )}
        </div>
        <div className={styles.grid3}>
          <Stat
            label="Available"
            value={balanceLabel(view.balance.availableCents)}
            hint="Balance less charges waiting to go final"
          />
          <Stat
            label="Billing soon"
            value={countLabel(view.billingSoon)}
            hint={
              view.balance.pendingCents > 0
                ? `Up to ${formatUsd(view.balance.pendingCents)} from the balance`
                : "Nothing waiting on the balance"
            }
          />
          <Stat
            label="Billed this month"
            value={formatUsd(view.month.cents)}
            hint={`${countLabel(view.month.cases)} resolved ${view.month.cases === 1 ? "case" : "cases"}`}
          />
        </div>
      </div>
    </Card>
  );
}

/** The price per resolved case, the step this month is on, and the free
 * and credited cases that come first. */
export function PlanPrice({
  view,
  workspace,
}: {
  view: ProductAccessView;
  workspace?: string;
}) {
  if (view.usageBilling) {
    const terms = view.usageBilling.terms;
    return (
      <Card title="Agreed usage prices">
        {terms ? (
          <div className={styles.stack}>
            <p>
              Your team and your AI have no resolution fee. Optional features
              are charged once per case.
            </p>
            <dl>
              <dt>Wallet check</dt>
              <dd>{formatUsd(terms.walletVerificationUsdCents)}</dd>
              <dt>Definite transaction check</dt>
              <dd>{formatUsd(terms.transactionCheckUsdCents)}</dd>
              <dt>Templ AI draft</dt>
              <dd>{formatUsd(terms.aiDraftUsdCents)}</dd>
              {terms.templAiResolutionEnabled === true && (
                <>
                  <dt>Templ AI resolution</dt>
                  <dd>
                    {formatUsd(terms.templAiResolutionUsdCents)}, including
                    those features
                  </dd>
                </>
              )}
            </dl>
            {terms.templAiResolutionEnabled === true ? (
              <p>A user must confirm a Templ AI resolution.</p>
            ) : (
              <p>Templ AI resolution charges are off for this agreement.</p>
            )}
            <p>Human support and managed services have separate quotes.</p>
          </div>
        ) : (
          <p>Ask Templ to record your signed usage agreement.</p>
        )}
      </Card>
    );
  }
  if (needsCustomPricingSetup(view))
    return (
      <Card title="Demo access">
        <p>
          Free limits are for testing. Request full access before you invite
          customers.
        </p>
        <p>We agree on usage prices before paid use starts.</p>
        <AppApprovalRequestButton workspace={workspace} />
      </Card>
    );
  if (view.manualBilling && view.manualBilling.status !== "ready")
    return (
      <Card title="Agreed prices">
        <p>
          {view.manualBilling.status === "setup-needed"
            ? "Ask Templ to record your signed software agreement. New cases do not accrue charges until it is active."
            : "New manual charges are off. Earlier charges keep their agreed prices."}
        </p>
        <TalkToTempl label="Talk to Templ">Talk to Templ</TalkToTempl>
      </Card>
    );
  // The table this workspace pays now; a published change shows above it.
  const steps = view.steps;
  const rows = priceSteps(steps);
  const billed = view.month.teamHandledCases;
  const activePilot = view.pilot?.state === "active";
  const free = freeStartLine(view);
  const grants = grantLines(view);
  const change = priceChangeLine(view);
  return (
    <Card
      title={
        activePilot
          ? "Prices before caps"
          : view.priceSource.kind === "order-form"
            ? `Your price, order form ${view.priceSource.id}`
            : "Price"
      }
      description={planPriceLine(steps)}
      footer={
        <a className={styles.inlineLink} href={RESOLVED_CASES_DOCS}>
          What counts as a resolved case <IconArrowRight aria-hidden="true" />
        </a>
      }
    >
      <div className={styles.stack} style={{ gap: 16 }}>
        {change && <Callout role="note">{change}</Callout>}
        {view.orderForm && (
          <p className={styles.small} style={{ margin: 0 }}>
            Ends {formatDay(view.orderForm.endsAt)}.
          </p>
        )}
        {(free || grants.length > 0) && (
          <ul
            className={styles.stack}
            style={{ gap: 6, margin: 0, padding: 0, listStyle: "none" }}
          >
            {free && <li className={styles.muted}>{free}</li>}
            {grants.map((line) => (
              <li key={line} className={styles.muted}>
                {line}
              </li>
            ))}
          </ul>
        )}
        <ul
          className={plan.steps}
          aria-label={
            activePilot
              ? "Prices before pilot caps"
              : "Team-handled case prices"
          }
        >
          {rows.map((row, index) => {
            const step = steps[index];
            const current =
              !activePilot &&
              billed + 1 >= step.fromCase &&
              (step.toCase === null || billed + 1 <= step.toCase);
            return (
              <li
                key={row.cases}
                className={plan.step}
                data-current={current ? "true" : "false"}
                aria-current={current ? "step" : undefined}
              >
                <span>
                  Team-handled cases{" "}
                  {step.toCase === null
                    ? `${countLabel(step.fromCase)}+`
                    : row.cases}
                  {current ? " (next)" : ""}
                </span>
                <span>{row.price} each</span>
              </li>
            );
          })}
          <li className={plan.step}>
            <span>AI-only case</span>
            <span>{formatUsd(view.aiOnlyPriceCents)} each</span>
          </li>
        </ul>
        <ul
          className={styles.stack}
          style={{ gap: 6, margin: 0, padding: 0, listStyle: "none" }}
        >
          <li className={styles.small}>{RESOLUTION_DEFINITION}</li>
          <li className={styles.small}>{BILLABLE_CASE_LINE}</li>
          <li className={styles.small}>{AI_ONLY_DEFINITION}</li>
          <li className={styles.small}>
            AI-only cases use no free case and never change your team&apos;s
            price step.
          </li>
          <li className={styles.small}>
            {CUSTOM_PRICING_LINE.replace("Talk to us.", "")}
            <TalkToTempl className={styles.inlineLink} label="Talk to us">
              Talk to us
            </TalkToTempl>
            .
          </li>
        </ul>
        {view.customVolume && (
          <Callout role="status">
            This month passed the custom volume. Talk to us about terms that fit
            it.
          </Callout>
        )}
      </div>
    </Card>
  );
}

/** This month's resolved cases from charge metadata: what billed, what
 * didn't and why, and who resolved them. Counts only. */
export function PlanMonth({
  view,
  context,
}: {
  view: ProductAccessView;
  context: WorkspaceContext;
}) {
  const month = view.month;
  const share = confirmedShareLine(view);
  const notBilled = [
    [month.voided, "reopened"],
    [month.excluded, "spam, test or preview"],
    [month.noReply, "no team reply"],
    [month.duplicate, "same user within a day"],
    [month.noContribution ?? 0, "no Templ step"],
  ] as const;
  const closers = [
    [month.byCloser.member, "by the user"],
    [month.byCloser.person, "by your team"],
    [month.byCloser.bot, "by your AI"],
    [month.byCloser.managed, "by Templ AI"],
  ] as const;
  const resolved = closers
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${countLabel(count)} ${label}`)
    .join(", ");
  return (
    <Card
      title="This month"
      description={
        view.manualBilling
          ? "Cases billed for this month. Statements show charges when they are posted."
          : "Counts from your cases. No message text."
      }
    >
      <div className={styles.stack} style={{ gap: 16 }}>
        <div className={styles.grid3}>
          <Stat
            label={view.manualBilling ? "Cases billed" : "Billed"}
            value={countLabel(month.cases)}
            hint={formatUsd(month.cents)}
          />
          <Stat
            label="Free"
            value={countLabel(month.free)}
            hint="From your free start"
          />
          <Stat
            label="From credit"
            value={countLabel(month.grant)}
            hint="Founding or pilot credit"
          />
        </div>
        {share && (
          <p className={styles.small} style={{ margin: 0 }}>
            {share}
          </p>
        )}
        <ul
          className={styles.stack}
          style={{ gap: 4, margin: 0, padding: 0, listStyle: "none" }}
        >
          <li className={styles.small}>
            {resolved ? `Resolved ${resolved}.` : "No resolved cases yet."}
          </li>
          <li className={styles.small}>
            Not billed:{" "}
            {notBilled
              .filter(([count]) => count > 0)
              .map(([count, label]) => `${countLabel(count)} ${label}`)
              .join(", ") || "none"}
            .
          </li>
        </ul>
        <MonthActivity context={context} />
      </div>
    </Card>
  );
}
