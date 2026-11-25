"use client";

import { useEffect, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import { getChatChain } from "@templ/chat/chains";
import type { ProductPaymentReceipt } from "@templ/chat/product-payment";
import { readProductReceipts } from "@/lib/product-client";
import { formatUsd } from "@/lib/product-format";
import { balanceLabel } from "@/lib/product-offer";

/** "$500 top-up plus $50 credit". */
function receiptSummary(receipt: ProductPaymentReceipt): string {
  const paid = `${formatUsd(receipt.usdCents)} ${receipt.settlement === "manual-usage" ? "debt payment" : "top-up"}`;
  return receipt.bonusCents > 0
    ? `${paid} plus ${formatUsd(receipt.bonusCents)} credit`
    : paid;
}
const explorer = (receipt: ProductPaymentReceipt) =>
  `${receipt.chainId === "solana" ? "https://explorer.solana.com" : getChatChain(receipt.chainId).explorer}/tx/${receipt.txHash}`;

/** Every verified top-up, newest first, with what each receipt holds: the
 * chain, the transaction, the payer, the paid part and the bonus. */
export function ProductBillingHistory({
  room,
  account,
  revision = 0,
}: {
  room: ChatRoomId;
  account?: string;
  revision?: number;
}) {
  const [result, setResult] = useState<{
    key: string;
    receipts?: ProductPaymentReceipt[];
    failed?: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  const key = `${room}:${account}`;
  useEffect(() => {
    const controller = new AbortController();
    void readProductReceipts(room, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setResult({ key, receipts: value.receipts });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, failed: true });
      });
    return () => controller.abort();
  }, [room, key, attempt, revision]);
  const current = result?.key === key ? result : undefined;
  return (
    <section>
      <h3>Payment receipts</h3>
      {!current && <p role="status">Loading receipts…</p>}
      {current?.failed && (
        <p role="alert">
          Receipts could not load.{" "}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {current?.receipts?.length === 0 && (
        <p>No payments have been credited to this workspace.</p>
      )}
      {current?.receipts && current.receipts.length > 0 && (
        <ul>
          {current.receipts.map((receipt) => (
            <li key={`${receipt.chainId}:${receipt.txHash}`}>
              <strong>{receiptSummary(receipt)}</strong>, paid{" "}
              {new Date(receipt.paidAt).toLocaleString()}
              <dl>
                <dt>Network</dt>
                <dd>
                  {receipt.chainId === "solana"
                    ? "Solana"
                    : getChatChain(receipt.chainId).name}
                </dd>
                <dt>Rail</dt>
                <dd>{receipt.rail}</dd>
                <dt>Token</dt>
                <dd>{receipt.asset.label}</dd>
                <dt>Recipient</dt>
                <dd>{receipt.recipient}</dd>
                <dt>Transfer index</dt>
                <dd>{receipt.logIndex ?? receipt.instructionIndex}</dd>
                <dt>Request</dt>
                <dd>{receipt.requestId}</dd>
                {receipt.orderFormId && (
                  <>
                    <dt>Order form</dt>
                    <dd>{receipt.orderFormId}</dd>
                  </>
                )}
                <dt>Credited</dt>
                <dd>{new Date(receipt.creditedAt).toLocaleString()}</dd>
                <dt>Paid from</dt>
                <dd>{receipt.payer}</dd>
                <dt>Balance after</dt>
                <dd>{balanceLabel(receipt.balanceAfterCents)}</dd>
                <dt>Transaction</dt>
                <dd>
                  <a href={explorer(receipt)} target="_blank" rel="noreferrer">
                    {receipt.txHash}
                  </a>
                </dd>
              </dl>
              <a
                href={`/billing/receipt?room=${encodeURIComponent(room)}&tx=${receipt.txHash}`}
                target="_blank"
                rel="noopener"
              >
                Printable receipt
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
