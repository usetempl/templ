"use client";

import { useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import { useChatAuth } from "@/lib/chat-auth";
import {
  RESOLUTION_DEFINITION,
  balanceLabel,
  CUSTOM_PRICING_LINE,
  freeStartLine,
  grantLines,
  isBillingView,
  pricingLine,
  supportClosedMessage,
} from "@/lib/product-offer";
import { readProduct, type ProductUsage } from "@/lib/product-client";
import { ActivityDots } from "./ui/ui";
import { ProductCheckout } from "./product-checkout";
import { useDismissDialog } from "@/lib/use-dismiss-dialog";
import styles from "./add-balance-dialog.module.css";

export function AddBalanceDialog({
  room,
  assertCurrent,
  onConfirmed,
  onPlanReady,
  onClose,
  purpose,
}: {
  room: ChatRoomId;
  assertCurrent: () => void;
  onConfirmed: () => void;
  onPlanReady?: () => void;
  onClose: () => void;
  purpose?: "period" | "credit";
}) {
  const auth = useChatAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const usageKey = `${room}:${auth.session?.principalId}`;
  const [result, setResult] = useState<{
    key: string;
    usage?: ProductUsage;
    error?: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const [verified, setVerified] = useState<{ key: string; accessTransaction?: string }>();
  const usage = result?.key === usageKey ? result.usage : undefined;
  const error = result?.key === usageKey ? result.error : undefined;
  const standard =
    usage && isBillingView(usage) ? usage.standardPlan : undefined;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readProduct(room, controller.signal)
      .then((usage) => {
        if (!controller.signal.aborted) setResult({ key: usageKey, usage });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setResult({
            key: usageKey,
            error:
              reason instanceof Error
                ? reason.message
                : "Balance could not load.",
          });
      });
    return () => controller.abort();
  }, [room, usageKey, refresh]);
  const planActive = Boolean(verified?.key === usageKey && verified.accessTransaction && standard?.status === "paid" &&
    standard.period?.paymentId?.split(":")[1] === verified.accessTransaction);
  const dismiss = useDismissDialog(onClose);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="community-plan-title"
      {...dismiss}
    >
      <header>
        <h2 id="community-plan-title">
          {!usage
            ? "Loading plan"
            : standard
              ? "Workspace payment"
              : usage && isBillingView(usage) && usage.usageBilling
                ? "Pay amount due"
                : "Add balance"}
        </h2>
        <button
          type="button"
          className={styles.close}
          aria-label="Close"
          onClick={onClose}
        >
          <IconX size={22} />
        </button>
      </header>
      <div className={styles.content}>
        {usage && !standard && <CurrentSupport usage={usage} />}
        {error && (
          <p className={styles.note} role="alert">
            {error}{" "}
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry
            </button>
          </p>
        )}
        {!usage && !error && <p role="status"><ActivityDots /> Loading your plan…</p>}
        {verified?.key === usageKey && (
          <div className={styles.confirmed} role="status">
            <strong>{planActive ? "Your hosted plan is active." : "Payment verified."}</strong>
            <button type="button" className={styles.primary} onClick={planActive && onPlanReady ? onPlanReady : onClose}>Back to workspace</button>
          </div>
        )}
        {usage && !standard && (
          <p className={styles.note}>
            {usage && isBillingView(usage) && usage.usageBilling
              ? "A verified stablecoin transfer reduces your usage debt."
              : `${pricingLine()} ${RESOLUTION_DEFINITION}`}
          </p>
        )}
        {usage && verified?.key !== usageKey && (
          <ProductCheckout
            room={room}
            usage={usage}
            purpose={purpose}
            assertCurrent={assertCurrent}
            onConfirmed={payment => {
              setVerified({ key: usageKey, accessTransaction:
                payment.standard && payment.standard.purpose !== "credit" && payment.processedTransaction?.outcome === "credited"
                  ? payment.processedTransaction.tx : undefined });
              setRefresh((value) => value + 1);
              onConfirmed();
            }}
          />
        )}
        {!standard && <p className={styles.help}>
          {usage && !standard && CUSTOM_PRICING_LINE.replace("Talk to us.", "")}
          <button
            type="button"
            className="button small secondary"
            onClick={() => {
              dialog.current?.close();
              onClose();
              window.dispatchEvent(new CustomEvent("templ:open-support"));
            }}
          >
            Chat with Templ
          </button>
        </p>}
      </div>
    </dialog>
  );
}
/** The balance a top-up adds to, with the free cases and credit left. */
function CurrentSupport({ usage }: { usage: ProductUsage }) {
  if (!isBillingView(usage)) return null;
  if (usage.usageBilling)
    return (
      <div className={styles.coverage}>
        <strong>Amount due {balanceLabel(usage.usageBilling.dueCents)}</strong>
        <span>
          Debt limit {balanceLabel(usage.usageBilling.debtLimitCents)}.
        </span>
      </div>
    );
  const closed = supportClosedMessage(usage);
  return (
    <div className={styles.coverage}>
      <strong>Balance {balanceLabel(usage.balance.balanceCents)}</strong>
      {freeStartLine(usage) && <span>{freeStartLine(usage)}</span>}
      {grantLines(usage).map((line) => (
        <span key={line}>{line}</span>
      ))}
      {closed && <span className={styles.warning}>{closed}</span>}
    </div>
  );
}
