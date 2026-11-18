"use client";
import { useRef, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ProductUsageView } from "@templ/chat/usage-billing";
import { billingAdmin, type BillingAction } from "@/lib/billing-admin-client";
import { formatUsd } from "@/lib/product-format";
import styles from "./admin-pilot-order-form.module.css";

export function AdminUsageBilling({
  principal,
  workspace,
  usage,
  onChanged,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  usage: ProductUsageView;
  onChanged: (message: string) => void;
}) {
  const [action, setAction] = useState<
    "usage-approve" | "usage-payment" | "usage-forgive"
  >("usage-approve");
  const [founder, setFounder] = useState("");
  const [dollars, setDollars] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const cents = /^\d{1,4}(?:\.\d{1,2})?$/.test(dollars.trim())
    ? Math.round(Number(dollars) * 100)
    : 0;
  const ready =
    confirmed &&
    reason.trim().length >= 3 &&
    (action === "usage-approve"
      ? Boolean(usage.agreement && founder.trim())
      : cents > 0 && cents <= 100_000 && reference.trim().length >= 3);
  async function run(enabled = true) {
    if (!ready || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      let input: BillingAction;
      if (action === "usage-approve" && usage.agreement)
        input = {
          action,
          formId: usage.agreement.id,
          revision: usage.agreement.revision,
          approvedBy: founder.trim(),
          enabled,
        };
      else {
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(reference.trim()),
        );
        input = {
          action: action as "usage-payment" | "usage-forgive",
          cents,
          referenceSha256: Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        };
      }
      await billingAdmin(principal).act(workspace, {
        ...input,
        reason: reason.trim(),
      });
      setConfirmed(false);
      setReference("");
      setDollars("");
      onChanged(
        action === "usage-approve"
          ? enabled
            ? "App access approved."
            : "App access revoked."
          : action === "usage-payment"
            ? "Payment recorded."
            : "Credit recorded.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change did not save. Try again.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Usage billing" className={styles.form}>
      <h3>App access and debt</h3>
      <p>
        {formatUsd(usage.dueCents)} due. Limit:{" "}
        {formatUsd(usage.debtLimitCents)}. Reserved for open cases:{" "}
        {formatUsd(usage.reservedCents)}.
      </p>
      <label>
        Action
        <select
          value={action}
          disabled={busy}
          onChange={(event) => {
            setAction(event.target.value as typeof action);
            setConfirmed(false);
            setError("");
          }}
        >
          <option value="usage-approve">Approve app access</option>
          <option value="usage-payment">Record received payment</option>
          <option value="usage-forgive">Forgive debt</option>
        </select>
      </label>
      <div className={styles.fields}>
        {action === "usage-approve" ? (
          <label>
            Approving founder
            <input
              value={founder}
              disabled={busy}
              onChange={(event) => setFounder(event.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              Amount (USD)
              <input
                inputMode="decimal"
                value={dollars}
                disabled={busy}
                onChange={(event) => setDollars(event.target.value)}
              />
            </label>
            <label>
              {action === "usage-payment"
                ? "Payment reference"
                : "Credit reference"}
              <input
                value={reference}
                disabled={busy}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          Reason
          <input
            value={reason}
            disabled={busy}
            maxLength={280}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {action === "usage-approve"
          ? "I checked the signed usage agreement."
          : action === "usage-payment"
            ? "I verified this payment was received."
            : "I approve forgiving this debt."}
      </label>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Saving…</p>}
      <button
        type="button"
        disabled={!ready || busy || usage.status === "off"}
        onClick={() => void run()}
      >
        {action === "usage-approve"
          ? "Approve access"
          : action === "usage-payment"
            ? "Record payment"
            : "Forgive debt"}
      </button>
      {action === "usage-approve" && usage.agreement && (
        <button
          type="button"
          disabled={!ready || busy || usage.status === "off"}
          onClick={() => void run(false)}
        >
          Revoke access
        </button>
      )}
    </section>
  );
}
