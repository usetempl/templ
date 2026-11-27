"use client";
import { useEffect, useRef, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ProductPaymentIntent } from "@templ/chat/product-payment";
import {
  readProductPaymentRequests,
  checkProductPayment,
} from "@/lib/product-client";
import { CommunityApiError } from "@/lib/community-client";
import { watchProductPayments } from "@/lib/product-payment-live";
import { readProductPaymentStatus } from "@/lib/product-payment-status";
import { trackEvent } from "@/lib/analytics";
import { ProductPaymentRequestDetails } from "./product-payment-request";

type RequestListProps = {
  room: ChatRoomId;
  account?: ChatPrincipalId;
  onOpen: (request: ProductPaymentIntent) => void;
  onCredited?: () => void;
};
export function ProductPaymentRequests(props: RequestListProps) {
  return <RequestList key={`${props.room}:${props.account}`} {...props} />;
}
function RequestList({ room, account, onOpen, onCredited }: RequestListProps) {
  const [requests, setRequests] = useState<ProductPaymentIntent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const creditAmounts = useRef<Map<string, number> | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void readProductPaymentStatus(
      (signal) => readProductPaymentRequests(room, signal),
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        const amounts = new Map(
          result.requests.map((request) => [
            request.id,
            request.status === "credited"
              ? request.usdCents
              : (request.creditedCents ?? 0),
          ]),
        );
        const previousAmounts = creditAmounts.current;
        const credited = [...amounts].some(
          ([id, amount]) => amount > (previousAmounts?.get(id) ?? 0),
        );
        creditAmounts.current = amounts;
        setRequests(result.requests);
        if (credited) onCredited?.();
      },
      () => {},
    );
    return () => controller.abort();
  }, [room, account, revision, onCredited]);
  useEffect(
    () => watchProductPayments(room, () => setRevision((v) => v + 1)),
    [room, account],
  );
  const active = requests.filter((request) =>
    ["open", "seen"].includes(request.status),
  );
  if (!active.length) return null;
  return (
    <div>
      {active.map((request) => (
        <div key={request.id}>
          <ProductPaymentRequestDetails
            request={request}
            busy={busy}
            onCheck={() => {
              if (busy) return;
              setBusy(true);
              setError("");
              trackEvent("payment_check_clicked");
              void checkProductPayment(account, room, request.id)
                .then(
                  () => setRevision((v) => v + 1),
                  (reason) => {
                    if (
                      reason instanceof CommunityApiError &&
                      reason.status === 409 &&
                      (reason.details as { reason?: string })?.reason ===
                        "product-payment-review-required"
                    )
                      setRequests((rows) =>
                        rows.map((row) =>
                          row.id === request.id
                            ? { ...row, verificationReviewRequired: true }
                            : row,
                        ),
                      );
                    if (
                      reason instanceof CommunityApiError &&
                      reason.status === 429
                    )
                      setRequests((rows) =>
                        rows.map((row) =>
                          row.id === request.id
                            ? {
                                ...row,
                                checkAgainAt:
                                  Date.now() +
                                  (reason.retryAfterSeconds ?? 30) * 1000,
                              }
                            : row,
                        ),
                      );
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "The payment could not be checked.",
                    );
                    trackEvent("payment_failed");
                    console.warn("TEMPL_SUPPORT_FAILURE", {
                      route: "payment",
                      step: "check",
                      cause: "service-refused",
                    });
                  },
                )
                .finally(() => setBusy(false));
            }}
          />
          <button type="button" onClick={() => onOpen(request)}>
            Open payment request
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
