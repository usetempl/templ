"use client";

import { useRef, useState, type FormEvent } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  StandardPlanView,
  StandardPaymentMode,
} from "@templ/chat/standard-plan";
import { billingAdmin } from "@/lib/billing-admin-client";
import styles from "./admin-billing.module.css";

export function AdminPrepaidPolicy({
  principal,
  workspace,
  plan,
  onChanged,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  plan: StandardPlanView;
  onChanged(message: string): void;
}) {
  const current = plan.prepaid;
  const savedMode = current?.sponsored ? "sponsored" : current?.mode ?? "prepaid";
  const [mode, setMode] = useState<StandardPaymentMode | "sponsored">(savedMode);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  if (!current) return null;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      running.current ||
      !current ||
      mode === savedMode ||
      reason.trim().length < 3
    )
      return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await billingAdmin(principal).act(workspace, {
        action: "standard-payment-mode",
        mode,
        expectedRevision: current.revision,
        reason: reason.trim(),
      });
      onChanged("Billing arrangement saved.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Billing arrangement did not save. Try again.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.panel}
      onSubmit={(event) => void save(event)}
      aria-label="Billing arrangement"
    >
      <div className={styles.sectionHeader}>
        <h3>Billing arrangement</h3>
      </div>
      <p>
        Self-serve workspaces pay upfront. Choose Templ covers costs for a workspace Templ provisions to run without customer charges. Usage still appears in the cost ledger.
      </p>
      <div className={styles.formFields}>
        <label>
          Payment
          <select
            value={mode}
            disabled={busy}
            onChange={(event) =>
              setMode(event.target.value as StandardPaymentMode | "sponsored")
            }
          >
            <option value="prepaid">Pay upfront</option>
            <option value="sponsored">Templ covers costs</option>
            <option value="debt">Allow debt</option>
            <option value="custom">Custom agreement</option>
          </select>
        </label>
        <label>
          Reason
          <input
            value={reason}
            maxLength={280}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}>
        <button
          className={styles.primary}
          disabled={busy || mode === savedMode || reason.trim().length < 3}
        >
          {busy ? "Saving…" : "Save arrangement"}
        </button>
      </div>
    </form>
  );
}
