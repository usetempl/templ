"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { communitySessionRevision } from "@/lib/community-auth";
import { readProduct, type ProductUsage } from "@/lib/product-client";
import { productCheckoutAvailable } from "@/lib/product-payment";
import {
  NO_SEATS,
  RESOLUTION_DEFINITION,
  isBillingView,
} from "@/lib/product-offer";
import { WorkspaceAccessPlan } from "./workspace-access-plan";
import { StandardWorkspacePlan } from "./standard-workspace-plan";
import { ChatPlanUsage } from "./chat-plan-usage";
import { AddBalanceDialog } from "./add-balance-dialog";
import { ProductBillingHistory } from "./product-billing-history";
import styles from "./plan-crypto-checkout.module.css";

export function ProductBillingPage({ room }: { room: ChatRoomId }) {
  const auth = useChatAuth();
  const account = auth.session?.principalId;
  const key = `${room}:${account}:${communitySessionRevision()}`;
  const currentKey = useRef(key);
  useLayoutEffect(() => {
    currentKey.current = key;
  }, [key]);
  const [result, setResult] = useState<{
    key: string;
    usage?: ProductUsage;
    error?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const [openKey, setOpenKey] = useState<string>();
  const [paymentPurpose, setPaymentPurpose] = useState<"period" | "credit">(
    "period",
  );
  const [signInError, setSignInError] = useState("");
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    void readProduct(room, controller.signal)
      .then((usage) => {
        if (!controller.signal.aborted) setResult({ key, usage });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            error:
              reason instanceof Error
                ? reason.message
                : "Billing could not load.",
          });
      });
    return () => controller.abort();
  }, [account, room, key, attempt]);
  if (!account)
    return (
      <>
        <button
          type="button"
          className={styles.primary}
          disabled={auth.restoring}
          onClick={() => {
            setSignInError("");
            void auth.signIn().catch((reason) => {
              if (!isChatSignInCanceled(reason))
                setSignInError("Sign-in failed. Try again.");
            });
          }}
        >
          Sign in
        </button>
        {signInError && <p role="alert">{signInError}</p>}
      </>
    );
  const current = result?.key === key ? result : undefined;
  if (!current) return <p role="status">Loading billing…</p>;
  if (current.error)
    return (
      <p role="alert">
        {current.error}{" "}
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </button>
      </p>
    );
  const usage = current.usage!;
  if (usage.billingManagedByTempl)
    return <WorkspaceAccessPlan active={usage.support.canAdmit} />;
  if (!usage.canManage)
    return (
      <p>
        Only the workspace owner and billing staff can see the balance and add
        to it.
      </p>
    );
  const standard = isBillingView(usage) ? usage.standardPlan : undefined;
  return (
    <>
      {standard ? (
        <StandardWorkspacePlan
          plan={standard}
          workspace={room}
          onPay={(purpose) => {
            setPaymentPurpose(purpose);
            setOpenKey(key);
          }}
          canPay={([1, 8453, 56, "solana"] as const).some((network) =>
            productCheckoutAvailable(network, "USDC", usage.features),
          )}
        />
      ) : (
        <>
          <h2>
            {isBillingView(usage) && usage.usageBilling
              ? "Usage and debt"
              : "Balance and resolved cases"}
          </h2>
          <p>
            {isBillingView(usage) && usage.usageBilling
              ? "Only the optional features you use are charged. Templ AI resolutions include those features."
              : `${RESOLUTION_DEFINITION} ${NO_SEATS}`}
          </p>
          <ChatPlanUsage usage={usage} />
          <button
            type="button"
            className={styles.primary}
            onClick={() => setOpenKey(key)}
          >
            Add balance
          </button>
        </>
      )}
      <ProductBillingHistory
        key={`${key}:${attempt}`}
        room={room}
        account={account}
      />
      {openKey === key && (
        <AddBalanceDialog
          key={key}
          room={room}
          purpose={paymentPurpose}
          assertCurrent={() => {
            if (
              currentKey.current !== key ||
              key !== `${room}:${account}:${communitySessionRevision()}`
            )
              throw new Error(
                "Your account or workspace changed. Open it again.",
              );
          }}
          onClose={() => setOpenKey(undefined)}
          onConfirmed={() => setAttempt((value) => value + 1)}
        />
      )}
    </>
  );
}
