"use client";

import { useCallback, useEffect, useState } from "react";
import { readProduct, type ProductUsage } from "@/lib/product-client";
import { formatUsd } from "@/lib/product-format";
import {
  isBillingView,
  balanceLabel,
  freeStartLine,
  supportClosedMessage,
} from "@/lib/product-offer";
import { ProductPaymentRequests } from "@/components/product-payment-requests";
import { WorkspaceAccessPlan } from "@/components/workspace-access-plan";
import { ProductBillingHistory } from "@/components/product-billing-history";
import { ProductPilotSummary } from "@/components/product-pilot-summary";
import { ImprovementCopyPlanCard } from "./improvement-copy";
import { Callout, Card, PageHeader, Skeleton } from "@/components/ui/ui";
import { TURNED_AWAY, turnedAway, turnedAwayTotal } from "@/lib/copy/insights";
import {
  readSupportRefusals,
  type SupportRefusalsRead,
} from "@/lib/support-insights-client";
import {
  needsCustomPricingSetup,
  PlanBalance,
  PlanMonth,
  PlanPrice,
} from "./plan-balance";
import { PlanUsageHistory } from "./plan-usage-history";
import { PlanBillingSoon, PlanCharges } from "./plan-charges";
import { PlanBudget } from "./plan-budget";
import { PlanFinanceEmail } from "./plan-finance-email";
import { PlanCardBilling } from "./plan-card-billing";
import { TurnedAwayReasons } from "./workspace-home";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";

/** The Plan tab. Billing managers see the balance, the price, this month's
 * resolved cases, what is about to bill, every charge with its dispute, the
 * budget, statements and receipts. Everyone else sees whether Support is
 * taking new requests. */
export function WorkspacePlan({ context }: { context: WorkspaceContext }) {
  const { room, account, revision } = context;
  const [bump, setBump] = useState(0);
  const key = `${room}:${account}:${revision}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    request: number;
    usage?: ProductUsage;
    error?: string;
  }>();
  // Billing staff already have the plan in the workspace state: show it at
  // once while the plan route is read again. A refresh after a change keeps
  // the plan on screen until the new answer arrives.
  const known = context.billing ? context.state?.product : undefined;
  const current: typeof loaded =
    loaded?.key === key
      ? loaded
      : known
        ? { key, request: -1, usage: { ...known, canManage: true } }
        : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void readProduct(room, controller.signal)
      .then((usage) => {
        if (!controller.signal.aborted)
          setLoaded({ key, request: bump, usage });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            request: bump,
            error:
              reason instanceof Error
                ? reason.message
                : "The plan could not load.",
          });
      });
    return () => controller.abort();
  }, [room, key, bump]);
  // Requests the team couldn't take in the last 30 days. Counts only; a
  // viewer the service doesn't show them to sees nothing here.
  const [refusals, setRefusals] = useState<{
    key: string;
    value: SupportRefusalsRead | null;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    readSupportRefusals(room, 30, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setRefusals({ key, value });
      },
      () => {
        if (!controller.signal.aborted) setRefusals({ key, value: null });
      },
    );
    return () => controller.abort();
  }, [room, key]);
  const turned =
    refusals?.key === key && refusals.value ? turnedAway(refusals.value) : null;
  const usage = current?.usage;
  const managedBilling = usage?.billingManagedByTempl === true;
  const billing =
    context.billing && usage && isBillingView(usage) ? usage : null;
  const refresh = useCallback(() => setBump((value) => value + 1), []);
  return (
    <div data-workspace-settings="" className={`${styles.page} ${styles.pageNarrow}`}>
      <PageHeader
        eyebrow="Plan"
        title="Plan & usage"
        description={
          managedBilling
            ? undefined
            : billing
              ? billing.manualBilling || billing.usageBilling
                ? "Usage, agreed prices and amounts due."
                : needsCustomPricingSetup(billing)
                  ? "Free limits are for testing. Request full access for your customers."
                  : billing.standardPlan
                    ? // The plan card states its own terms; the free start
                      // belongs to resolved-case prices.
                      (supportClosedMessage(billing) ?? undefined)
                    : (supportClosedMessage(billing) ??
                      freeStartLine(billing) ??
                      `Balance ${balanceLabel(billing.balance.balanceCents)}.`)
              : "See your support balance and resolved cases."
        }
      />
      <div className={styles.stack}>
        {(loaded?.key !== key || loaded.request !== bump) && (
          <p className={styles.muted} role="status">
            {usage ? "Updating plan…" : "Loading plan…"}
          </p>
        )}
        {!current ? (
          <Card title="Balance">
            <Skeleton height={120} />
          </Card>
        ) : current.error || !usage ? (
          <Callout tone="danger" role="alert">
            {current.error ?? "The plan could not load."}
          </Callout>
        ) : managedBilling ? (
          <WorkspaceAccessPlan active={usage.support.canAdmit} />
        ) : billing ? (
          <>
            {context.billing &&
              !billing.standardPlan &&
              !billing.manualBilling &&
              !billing.usageBilling && (
                <PlanCardBilling
                  enabled={context.state?.features?.cardBilling === true}
                  view={billing}
                  context={context}
                  onChanged={refresh}
                />
              )}
            <PlanBalance
              workspace={room}
              view={billing}
              features={usage.features}
              onTopUp={context.openPlans}
            />
            {Number(billing.standardPlanDebtCents) > 0 && (
              <p>
                Earlier monthly AI amount due:{" "}
                {formatUsd(billing.standardPlanDebtCents!)}.
              </p>
            )}
            {billing.pilot && (
              <Card title="Pilot">
                <ProductPilotSummary pilot={billing.pilot} />
              </Card>
            )}
            {billing.pendingPilot && (
              <Card title="Pilot revision">
                <ProductPilotSummary pilot={billing.pendingPilot} />
              </Card>
            )}
            {(billing.standardPlan ||
              (!billing.manualBilling && !billing.usageBilling)) && (
              <ProductPaymentRequests
                room={room}
                account={account}
                onOpen={context.openPlans}
                onCredited={refresh}
              />
            )}
            {!billing.standardPlan && !billing.usageBilling && (
              <PlanBillingSoon context={context} onChanged={refresh} />
            )}
            {!billing.standardPlan && !billing.usageBilling && (
              <PlanMonth view={billing} context={context} />
            )}
            {!billing.standardPlan && (
              <PlanPrice view={billing} workspace={context.id} />
            )}
            {billing.usageBilling ? (
              <PlanUsageHistory context={context} />
            ) : (
              <PlanCharges context={context} />
            )}
          </>
        ) : (
          <Card title="Support">
            <p className={styles.muted} style={{ margin: 0 }}>
              {supportClosedMessage({
                mode: usage.support.canAdmit ? "open" : "closed",
                support: usage.support,
                offerVersion: usage.offerVersion,
              }) ??
                "Support is taking new cases. Billing managers see the balance and charges here."}
            </p>
          </Card>
        )}

        {turned && turned.total > 0 && (
          <Card
            title={TURNED_AWAY.planTitle}
            description={turnedAwayTotal(turned)}
          >
            <TurnedAwayReasons summary={turned} />
          </Card>
        )}

        {/* Templ's improvement copy and the contract that leaves it out. */}
        <ImprovementCopyPlanCard room={room} />

        {billing && !managedBilling && (
          <>
            <PlanBudget
              context={context}
              statementsOnly={Boolean(
                billing.standardPlan ||
                billing.manualBilling ||
                billing.usageBilling,
              )}
            />
            <PlanFinanceEmail context={context} />
            <Card
              title={
                billing.standardPlan || billing.usageBilling
                  ? "Payments"
                  : "Top-ups"
              }
            >
              <ProductBillingHistory
                room={room}
                account={account}
                revision={bump}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
