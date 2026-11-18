"use client";

import { useEffect, useState } from "react";
import type { ProductAccessView } from "@templ/chat/product-catalog";
import { Card, Callout, Stat } from "@/components/ui/ui";
import { formatUsd } from "@/lib/product-format";
import { trackEvent } from "@/lib/analytics";
import {
  startCardSetup,
  openCardPortal,
  requestUsdcBilling,
  stripeHostedUrl,
  stripeInvoiceStatus,
  stripeBillingFailure,
} from "@/lib/stripe-billing-client";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

/** Billing fields come from the worker's verified Stripe webhook state. */
export function PlanCardBilling({
  view,
  context,
  onChanged,
  enabled = false,
}: {
  view: ProductAccessView;
  context: Pick<WorkspaceContext, "account" | "room" | "billing">;
  onChanged: () => void;
  enabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [setupReturn] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("stripeSetup"),
  );
  const returned = setupReturn === "returned";
  const canceled = setupReturn === "canceled";
  const card = view.cardBilling;
  const active = view.billingMethod === "card";
  const checking =
    (card?.status === "setup-pending" && !canceled) || (returned && !active);
  const allowed = enabled && context.billing;
  useEffect(() => {
    if (!allowed || !checking) return;
    const interval = setInterval(onChanged, 2_000);
    return () => clearInterval(interval);
  }, [allowed, checking, onChanged]);
  if (!allowed) return null;

  async function act(kind: "setup" | "portal" | "usdc") {
    setBusy(true);
    setError("");
    setNote(
      kind === "usdc"
        ? "We are asking Stripe to end card billing."
        : "We are opening Stripe.",
    );
    trackEvent(
      kind === "setup"
        ? "card_setup_clicked"
        : kind === "portal"
          ? "card_portal_clicked"
          : "usdc_prepay_clicked",
    );
    try {
      if (kind === "usdc") {
        await requestUsdcBilling(context.account, context.room);
        trackEvent("usdc_prepay_requested");
        setNote(
          "Card billing ends after this period. Cases before then stay on the invoice.",
        );
        onChanged();
      } else {
        const result = await (
          kind === "setup" ? startCardSetup : openCardPortal
        )(context.account, context.room);
        const url = stripeHostedUrl(result.url, kind);
        trackEvent(
          kind === "setup" ? "card_setup_opened" : "card_portal_opened",
        );
        window.location.assign(url);
      }
    } catch (reason) {
      // Provider error text can contain identifiers or credentials.
      const failure = stripeBillingFailure(reason);
      console.error("TEMPL_CARD_BILLING_FAILED", {
        action: kind,
        cause: failure.cause,
      });
      setNote("");
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Payment method"
      description={
        active ? "Pay by card each month." : "Prepay with stablecoins."
      }
    >
      <div className={styles.stack} style={{ gap: 16 }}>
        <p className={styles.small} style={{ margin: 0 }}>
          Your account can pay by card for 1 workspace at a time.
        </p>
        {checking && (
          <Callout role="status">We are checking with Stripe</Callout>
        )}
        {canceled && !active && (
          <Callout role="status">
            Card setup was canceled. Your payment method stays stablecoins.
          </Callout>
        )}
        {active ? (
          <>
            <p className={styles.muted} style={{ margin: 0 }}>
              {card?.card
                ? `Card on file: ${card.card.brand} ending ${card.card.last4}.`
                : "Stripe holds your card details."}
            </p>
            <div className={styles.grid3}>
              <Stat
                label="Invoice cases"
                value={`${card?.monthCases ?? 0} cases`}
                hint="This month (UTC)"
              />
              <Stat
                label="Invoice estimate"
                value={formatUsd(card?.monthEstimateCents ?? 0)}
                hint="Final cases billed by card"
              />
              <Stat
                label="Last invoice"
                value={
                  card?.latestInvoice
                    ? stripeInvoiceStatus(card.latestInvoice.status)
                    : "No invoice yet"
                }
              />
            </div>
            {card?.status === "past-due" && (
              <Callout role="status">
                Your invoice is unpaid. Support keeps running. Templ will
                contact your billing managers.
              </Callout>
            )}
            {card?.cancelAtPeriodEnd && (
              <Callout role="status">
                Card billing ends after this period. New final cases then use
                your stablecoin balance.
              </Callout>
            )}
            <div className={plan.inline}>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void act("portal")}
              >
                Manage card
              </button>
              {!card?.cancelAtPeriodEnd && (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => void act("usdc")}
                >
                  Prepay with stablecoins
                </button>
              )}
            </div>
            <p className={styles.small} style={{ margin: 0 }}>
              Manage card and invoices on Stripe.
            </p>
          </>
        ) : (
          <>
            <p className={styles.muted} style={{ margin: 0 }}>
              Pay by card each month. Stripe bills your final resolved cases.
            </p>
            <button
              type="button"
              className="button"
              disabled={busy || (checking && returned)}
              onClick={() => void act("setup")}
            >
              {card?.status === "setup-pending" && !returned
                ? "Continue card setup"
                : "Pay by card"}
            </button>
          </>
        )}
        <p className={styles.small} style={{ margin: 0 }}>
          Cases use your free start, grants, then a positive stablecoin balance
          before card billing.
        </p>
        <p className={styles.small} style={{ margin: 0 }}>
          A positive balance pays the whole next case. Card billing starts with
          the next case once the balance reaches zero or below.
        </p>
        <p className={styles.small} style={{ margin: 0 }}>
          You save your card on Stripe. Card billing starts after Stripe
          confirms your card.
        </p>
        {note && (
          <p className={styles.small} role="status" style={{ margin: 0 }}>
            {note}
          </p>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Card>
  );
}
