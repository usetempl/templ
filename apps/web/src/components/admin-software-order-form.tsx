"use client";

import { useEffect, useId, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import {
  productUsageTerms,
  isProductUsageTerms,
  usageResolutionTable,
} from "@templ/chat/usage-billing";
import { isPriceTable } from "@templ/chat/resolution-pricing";
import {
  orderFormsAdmin,
  type OperatorOrderForm,
  type OperatorOrderForms,
} from "@/lib/order-forms-admin-client";
import { formatUsd } from "@/lib/product-format";
import styles from "./admin-pilot-order-form.module.css";

/** Records an agreement already signed and approved through operator intake. */
export function AdminSoftwareOrderForm({
  principal,
  workspace,
  onChanged,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  onChanged: (message: string) => void;
}) {
  const key = `${workspace}:${principal}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    record?: OperatorOrderForms;
    error?: string;
  }>();
  const [now] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    orderFormsAdmin(principal)
      .read(workspace, controller.signal)
      .then(
        (record) => {
          if (!controller.signal.aborted) setLoaded({ key, record });
        },
        (error) => {
          if (!controller.signal.aborted)
            setLoaded({
              key,
              error:
                error instanceof Error
                  ? error.message
                  : "The agreement could not load.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, workspace, key]);
  if (!loaded || loaded.key !== key)
    return <p role="status">Loading software agreement…</p>;
  if (!loaded.record) return <p role="alert">{loaded.error}</p>;
  const latest = loaded.record.history.at(-1);
  const current =
    latest &&
    loaded.record.ended[latest.id] === undefined &&
    latest.endsAt > now
      ? latest
      : undefined;
  if (current && (current.pilot || current.service !== "software")) return null;
  return (
    <SoftwareForm
      key={`${workspace}:${current?.id}:${current?.revision}`}
      principal={principal}
      workspace={workspace}
      current={current}
      onSaved={(record) => {
        setLoaded({ key, record: { ...loaded.record!, ...record } });
        onChanged("Software agreement saved.");
      }}
    />
  );
}

function SoftwareForm({
  principal,
  workspace,
  current,
  onSaved,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  current?: OperatorOrderForm;
  onSaved: (
    record: Awaited<ReturnType<ReturnType<typeof orderFormsAdmin>["act"]>>,
  ) => void;
}) {
  const usageMode = !current || Boolean(current.usage);
  const agreedUsage = current?.usage ?? productUsageTerms();
  const aiFeesDescription = useId();
  const [aiFeesEnabled, setAiFeesEnabled] = useState(
    agreedUsage.templAiResolutionEnabled === true,
  );
  const [values, setValues] = useState({
    walletVerificationUsdCents: current
      ? String(agreedUsage.walletVerificationUsdCents)
      : "",
    transactionCheckUsdCents: current
      ? String(agreedUsage.transactionCheckUsdCents)
      : "",
    aiDraftUsdCents: current ? String(agreedUsage.aiDraftUsdCents) : "",
    templAiResolutionUsdCents: current
      ? String(agreedUsage.templAiResolutionUsdCents)
      : "",
    debtLimitCents: String(agreedUsage.debtLimitCents),
    templAiPrincipal: agreedUsage.templAiPrincipal ?? "",
    usdCents: current ? String(current.table.usdCents) : "",
    aiOnlyUsdCents: current ? String(current.table.aiOnlyUsdCents) : "",
    stepOneAfterCases: current ? String(current.table.stepOneAfterCases) : "",
    stepOneUsdCents: current ? String(current.table.stepOneUsdCents) : "",
    startsAt: current
      ? new Date(current.startsAt).toISOString().slice(0, 16)
      : "",
    endsAt: current ? new Date(current.endsAt).toISOString().slice(0, 16) : "",
    documentSha256: "",
    approvedBy: current?.approvedBy ?? "",
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const usage = {
    ...agreedUsage,
    templAiResolutionEnabled: aiFeesEnabled,
    walletVerificationUsdCents: Number(values.walletVerificationUsdCents),
    transactionCheckUsdCents: Number(values.transactionCheckUsdCents),
    aiDraftUsdCents: Number(values.aiDraftUsdCents),
    templAiResolutionUsdCents: Number(values.templAiResolutionUsdCents),
    debtLimitCents: Number(values.debtLimitCents),
    templAiPrincipal: values.templAiPrincipal.trim()
      ? normalizeChatPrincipal(values.templAiPrincipal.trim())
      : null,
  };
  const legacyTable = {
    usdCents: Number(values.usdCents),
    aiOnlyUsdCents: Number(values.aiOnlyUsdCents),
    stepOneAfterCases: Number(values.stepOneAfterCases),
    stepOneUsdCents: Number(values.stepOneUsdCents),
  };
  const table = usageMode ? usageResolutionTable(usage) : legacyTable;
  const startsAt = Date.parse(`${values.startsAt}:00.000Z`);
  const endsAt = Date.parse(`${values.endsAt}:00.000Z`);
  const ready =
    (!usageMode ||
      [
        values.walletVerificationUsdCents,
        values.transactionCheckUsdCents,
        values.aiDraftUsdCents,
        values.templAiResolutionUsdCents,
      ].every((value) => value.trim() !== "")) &&
    (usageMode
      ? isProductUsageTerms(usage) &&
        (!values.templAiPrincipal.trim() || usage.templAiPrincipal !== null) &&
        [
          "walletVerificationUsdCents",
          "transactionCheckUsdCents",
          "aiDraftUsdCents",
          "templAiResolutionUsdCents",
          "debtLimitCents",
        ].every((key) => /^\d+$/.test(values[key as keyof typeof values]))
      : Object.keys(table).every((key) =>
          /^\d+$/.test(values[key as keyof typeof legacyTable]),
        ) && isPriceTable(table, "order-form")) &&
    Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    endsAt > startsAt &&
    /^[0-9a-f]{64}$/.test(values.documentSha256) &&
    values.approvedBy.trim() &&
    values.reason.trim();
  async function save(end = false) {
    if (
      busy ||
      (end
        ? !current || !values.approvedBy.trim() || !values.reason.trim()
        : !ready)
    )
      return;
    setBusy(true);
    setError("");
    try {
      onSaved(
        await orderFormsAdmin(principal).act(
          workspace,
          end && current
            ? {
                action: "end",
                id: current.id,
                expectedRevision: current.revision,
                approvedBy: values.approvedBy.trim(),
                reason: values.reason.trim(),
              }
            : {
                action: current ? "amend" : "create",
                ...(current
                  ? { id: current.id, expectedRevision: current.revision }
                  : {}),
                service: "software",
                table,
                ...(usageMode ? { usage } : {}),
                startsAt,
                endsAt,
                documentSha256: values.documentSha256,
                approvedBy: values.approvedBy.trim(),
                reason: values.reason.trim(),
              },
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The agreement could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  const sharedFields = [
    ["startsAt", "Starts (UTC)", "datetime-local"],
    ["endsAt", "Ends (UTC)", "datetime-local"],
    ["documentSha256", "Signed document SHA-256", "text"],
    ["approvedBy", "Approving founder", "text"],
    ["reason", "Reason", "text"],
  ] as const;
  const fields = [
    ...(usageMode
      ? [
          ["walletVerificationUsdCents", "Wallet check (cents)", "number"],
          ["transactionCheckUsdCents", "Transaction check (cents)", "number"],
          ["aiDraftUsdCents", "Templ draft (cents)", "number"],
          ["templAiResolutionUsdCents", "Templ resolution (cents)", "number"],
          ["debtLimitCents", "Debt limit (cents)", "number"],
          ["templAiPrincipal", "Templ AI account", "text"],
        ]
      : [
          ["usdCents", "Team case (US cents)", "number"],
          ["aiOnlyUsdCents", "AI-only case (US cents)", "number"],
          ["stepOneAfterCases", "Lower rate after cases", "number"],
          ["stepOneUsdCents", "Lower rate (US cents)", "number"],
        ]),
    ...sharedFields,
  ] as [keyof typeof values, string, string][];
  return (
    <section aria-label="Software agreement" className={styles.form}>
      <h3>{current ? `Revise ${current.id}` : "Record software agreement"}</h3>
      <p>
        Enter the signed prices and dates. Recording an agreement does not
        enable billing or collect payment.
      </p>
      <div className={styles.fields}>
        {fields.map(([key, label, type]) => (
          <label key={key}>
            {label}
            <input
              type={type}
              value={values[key]}
              disabled={busy}
              onChange={(event) =>
                setValues({ ...values, [key]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      {usageMode && (
        <>
          <label>
            <input
              type="checkbox"
              checked={aiFeesEnabled}
              disabled={busy}
              aria-describedby={aiFeesDescription}
              onChange={(event) => setAiFeesEnabled(event.target.checked)}
            />
            AI resolution fees
          </label>
          <p id={aiFeesDescription}>
            {values.templAiResolutionUsdCents.trim() ? (
              <>
                Templ AI: {formatUsd(usage.templAiResolutionUsdCents)} per
                confirmed case, including feature charges. Use only if the
                signed agreement permits this fee. Production proof still
                controls charging.
              </>
            ) : (
              "Enter the signed resolution price. Production proof still controls charging."
            )}
          </p>
          {aiFeesEnabled && !usage.templAiPrincipal && (
            <p role="alert">Add a valid Templ AI account.</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => void save()}
      >
        Save agreement
      </button>
      {current && (
        <button
          type="button"
          disabled={busy || !values.approvedBy.trim() || !values.reason.trim()}
          onClick={() => void save(true)}
        >
          End agreement
        </button>
      )}
    </section>
  );
}
