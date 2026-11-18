"use client";

import { useEffect, useState } from "react";
import type { ProductMonthActivity } from "@templ/chat/product-catalog";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { readActivity } from "@/lib/product-client";
import { activityRows, countLabel } from "@/lib/product-offer";
import { Callout, Skeleton } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

/** This month's cases from the case ledger: how many opened, were answered
 * and resolved, how fast, and what Templ added. Counts and times only; the
 * "This month" card shows it under the billing counts. */
export function MonthActivity({ context }: { context: WorkspaceContext }) {
  const { room, account, revision } = context;
  // The month when the tab opened; a later visit reads the next one.
  const [month] = useState(() => resolutionMonth(Date.now()));
  const key = `${room}:${account}:${revision}:${month}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    activity?: ProductMonthActivity;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    readActivity(room, month, controller.signal).then(
      (activity) => {
        if (!controller.signal.aborted) setLoaded({ key, activity });
      },
      (reason) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            error:
              reason instanceof Error ? reason.message : "This month’s cases could not load.",
          });
      },
    );
    return () => controller.abort();
  }, [room, key, month]);
  const current = loaded?.key === key ? loaded : undefined;
  return (
    <>
      {!current ? (
        <Skeleton height={80} />
      ) : current.error || !current.activity ? (
        <Callout tone="danger" role="alert">
          {current.error ?? "This month’s cases could not load."}
        </Callout>
      ) : (
        <div className={styles.stack} style={{ gap: 12 }}>
          <dl className={plan.activity} aria-label="Cases this month">
            {activityRows(current.activity).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {!current.activity.complete && (
            <p className={styles.small} style={{ margin: 0 }}>
              These counts cover the first {countLabel(current.activity.opened)} cases
              of the month.
            </p>
          )}
        </div>
      )}
    </>
  );
}
