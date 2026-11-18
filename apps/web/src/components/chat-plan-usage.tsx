"use client";

import {
  isBillingView,
  planSummary,
  pricingLine,
  runwayLine,
  supportClosedMessage,
} from "@/lib/product-offer";
import type { ProductUsage } from "@/lib/product-client";
import { formatUsd } from "@/lib/product-format";
import styles from "./chat-plan-usage.module.css";

/** The balance in one line (or what stops new requests, when something
 * does), with the runway. Staff without billing see only whether Support
 * is open. */
export function ChatPlanUsage({ usage }: { usage: ProductUsage }) {
  const closed = supportClosedMessage(usage);
  if (usage.billingManagedByTempl) return <p>{closed ?? "Ongoing access"}</p>;
  if (!isBillingView(usage))
    return closed ? <p className={styles.hint}>{closed}</p> : null;
  if (usage.standardPlan)
    return (
      <p>
        {usage.standardPlan.status === "paid"
          ? "Paid workspace access is active."
          : `${usage.standardPlan.ticketsUsed} of ${usage.standardPlan.ticketsTotal} test tickets used.`}
      </p>
    );
  if (usage.usageBilling)
    return (
      <div className={styles.usage}>
        {Number(usage.standardPlanDebtCents) > 0 && (
          <p>
            Earlier monthly AI amount due:{" "}
            {formatUsd(usage.standardPlanDebtCents!)}.
          </p>
        )}
        <p>
          {formatUsd(usage.usageBilling.dueCents)} due. Credit limit:{" "}
          {formatUsd(usage.usageBilling.debtLimitCents)}.
        </p>
        {usage.usageBilling.status === "credit-limit" && (
          <p role="status">
            Pay the amount due to take new cases. Existing cases stay open.
          </p>
        )}
      </div>
    );
  const runway = runwayLine(usage);
  return (
    <div className={styles.usage}>
      {Number(usage.standardPlanDebtCents) > 0 && (
        <p>
          Earlier monthly AI amount due:{" "}
          {formatUsd(usage.standardPlanDebtCents!)}.
        </p>
      )}
      <div className={styles.usageMeter}>
        <div>
          <span role={closed ? "status" : undefined}>{planSummary(usage)}</span>
        </div>
        {runway && <small>{runway}</small>}
      </div>
      <p className={styles.hint}>{pricingLine()}</p>
    </div>
  );
}
