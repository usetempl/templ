import { PRIORITY_COPY, type PriorityCase } from "@templ/chat/support-priority";
import { Fragment } from "react";
import { Badge } from "./ui/ui";
import styles from "./team-conversations.module.css";

const clock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function PriorityReasons({ value }: { value: PriorityCase }) {
  const tags = [
    ...new Set([
      ...value.reasons,
      ...(value.tier ? [value.tier] : []),
      ...(value.claimedWallet ? [PRIORITY_COPY.claimed] : []),
    ]),
  ];
  const position = value.position;
  return (
    <span className={styles.priorityReasons}>
      <span className={styles.rowMeta}>
        {tags.map((reason, index) => (
          <Fragment key={reason}>
            {index > 0 && " "}
            <Badge className={styles.priorityReason}>{reason}</Badge>
          </Fragment>
        ))}
      </span>
      {position?.state === "ready" && position.usd !== null && (
        <span className={styles.priorityAsOf}>
          {position.estimated ? "Estimate checked" : "Checked"}{" "}
          <time dateTime={position.asOf}>
            {clock.format(new Date(position.asOf))}
          </time>
        </span>
      )}
    </span>
  );
}
