import type { ProductPilotView } from "@templ/chat/product-catalog";
import { formatUsd } from "@/lib/product-format";
import { Badge } from "@/components/ui/ui";
import styles from "./workspace/workspace-plan.module.css";

const STATUS: Record<ProductPilotView["state"], string> = {
  "awaiting-payment": "Awaiting payment",
  scheduled: "Scheduled",
  active: "Active",
  ended: "Ended",
};
const date = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const month = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** Billing-only pilot facts use the same UTC dates and amounts on both views. */
export function ProductPilotSummary({ pilot }: { pilot: ProductPilotView }) {
  const monthName = month.format(
    Date.UTC(Number(pilot.month.slice(0, 4)), Number(pilot.month.slice(4)) - 1),
  );
  return (
    <div className={styles.pilot}>
      <p className={styles.chargeHead}>
        <strong>{pilot.title}</strong>{" "}
        <Badge tone={pilot.state === "active" ? "brand" : "neutral"}>
          {STATUS[pilot.state]}
        </Badge>
      </p>
      <p className={styles.chargeMeta}>
        Order form {pilot.id}, revision {pilot.revision}
      </p>
      <dl className={styles.activity}>
        <div>
          <dt>Starts</dt>
          <dd>{date.format(Date.parse(pilot.startsAt))} UTC</dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>{date.format(Date.parse(pilot.endsAt))} UTC</dd>
        </div>
        <div>
          <dt>Month cap use</dt>
          <dd>
            {formatUsd(pilot.monthUsedCents)} of{" "}
            {formatUsd(pilot.monthlyCapCents)}
          </dd>
        </div>
        <div>
          <dt>Total cap use</dt>
          <dd>
            {formatUsd(pilot.totalUsedCents)} of{" "}
            {formatUsd(pilot.totalCapCents)}
          </dd>
        </div>
        <div>
          <dt>Upfront payment</dt>
          <dd>
            {formatUsd(pilot.upfrontPaidCents)} of{" "}
            {formatUsd(pilot.upfrontCents)}
          </dd>
        </div>
        <div>
          <dt>Upfront credit left</dt>
          <dd>{formatUsd(pilot.upfrontCreditLeftCents)}</dd>
        </div>
      </dl>
      <p className={styles.chargeMeta}>{monthName} (UTC)</p>
      {pilot.state === "awaiting-payment" ? (
        <p className={styles.chargeMeta} role="status">
          Templ applies these terms after it verifies the upfront payment.
        </p>
      ) : pilot.state === "scheduled" ? (
        <p className={styles.chargeMeta} role="status">
          The upfront payment is verified. The pilot starts on the date above.
        </p>
      ) : pilot.state === "ended" ? (
        <p className={styles.chargeMeta} role="status">
          The pilot ended. Normal prices apply.
        </p>
      ) : (
        <p className={styles.chargeMeta}>
          Cases keep working after a cap. Normal prices apply after the pilot
          ends.
        </p>
      )}
      <p className={styles.chargeMeta}>
        Month starts at 00:00 UTC on day 1. Upfront credit covers pilot charges.
      </p>
    </div>
  );
}
