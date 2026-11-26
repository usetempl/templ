"use client";

import { useEffect, useState } from "react";
import { hasSupportKnowledge } from "@templ/chat/workspace-flags";
import { Card, Callout, PageHeader, Skeleton } from "@/components/ui/ui";
import { AppApprovalRequestButton } from "@/components/app-approval-request";
import { communityFetch, roomPath } from "@/lib/community-client";
import { isBillingView } from "@/lib/product-offer";
import { TURNED_AWAY, turnedAway } from "@/lib/copy/insights";
import { HostedChatSetup } from "./hosted-chat-setup";
import { OnboardingSource } from "./onboarding-source";
import type { WorkspaceContext } from "./support-workspace";
import { useWorkspaceSectionFocus } from "./workspace-sections";
import styles from "./workspace.module.css";

export function WorkspaceHome({ context }: { context: WorkspaceContext }) {
  const { room, account, manager, workspace, go } = context;
  useWorkspaceSectionFocus(["ai-setup"]);
  const product = context.state.product;
  const billing = product && isBillingView(product) ? product : undefined;
  const standard = billing?.standardPlan;
  const paid =
    standard?.status === "paid" ||
    product?.mode === "exempt" ||
    Boolean(
      billing?.usageBilling?.agreement &&
      ["active", "credit-limit"].includes(billing.usageBilling.status),
    );
  const [attempt, retry] = useState(0);
  const [widget, setWidget] = useState<{
    key: string;
    hosted?: boolean;
    error?: boolean;
  }>();
  const key = `${room}:${account}:${context.revision}`;
  const current = widget?.key === key ? widget : undefined;
  useEffect(() => {
    if (!manager) return;
    const controller = new AbortController();
    communityFetch<{
      hostedPage?: boolean;
      options?: { hostedPage?: boolean };
    }>(roomPath(room, "widget"), undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setWidget({
            key,
            hosted:
              value.hostedPage === true && value.options?.hostedPage === true,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setWidget({ key, error: true });
      });
    return () => controller.abort();
  }, [manager, room, key, attempt]);

  return (
    <div data-workspace-settings="" className={`${styles.page} ${styles.pageNarrow}`}>
      <PageHeader title={workspace.name} />
      <div className={styles.stack}>
        {manager && paid && hasSupportKnowledge(context.state.features) && (
          <OnboardingSource key={`${room}:${account}`} context={context} />
        )}
        {manager && !current ? (
          <Skeleton height={96} />
        ) : current?.error ? (
          <Callout tone="danger" role="alert">
            Your chat link could not load.{" "}
            <button
              className="button small secondary"
              onClick={() => {
                setWidget(undefined);
                retry((value) => value + 1);
              }}
            >
              Try again
            </button>
          </Callout>
        ) : manager && current?.hosted ? (
          <HostedChatSetup
            key={`${room}:${account}`}
            context={context}
            paid={paid}
          />
        ) : (
          <Card title="Team chat">
            <div className={styles.row}>
              <button className="button" onClick={() => go("inbox")}>
                Open inbox
              </button>
              {manager && (
                <button
                  className="button secondary"
                  onClick={() => go("widget")}
                >
                  Set up chat
                </button>
              )}
            </div>
          </Card>
        )}
        {manager &&
          standard?.status === "demo" &&
          current?.hosted === false && (
            <button className="button secondary" onClick={() => go("plan")}>
              Choose a hosted plan
            </button>
          )}
        {manager && billing && !standard && !paid && (
          <AppApprovalRequestButton workspace={context.id} appUrl="" />
        )}
      </div>
    </div>
  );
}

/** One line per reason with its count, then what Templ keeps. */
export function TurnedAwayReasons({
  summary,
}: {
  summary: ReturnType<typeof turnedAway>;
}) {
  return (
    <div className={styles.stack} style={{ gap: 10 }}>
      <ul className={styles.stack} style={{ gap: 6, margin: 0, padding: 0 }}>
        {summary.reasons.map((item) => (
          <li
            key={item.reason}
            className={`${styles.rowBetween} ${styles.muted}`}
            style={{ listStyle: "none" }}
          >
            <span>{item.label}</span>
            <strong style={{ color: "var(--fg)" }}>
              {item.count.toLocaleString("en-US")}
            </strong>
          </li>
        ))}
      </ul>
      <p className={styles.small} style={{ margin: 0 }}>
        {TURNED_AWAY.footer}
      </p>
    </div>
  );
}
