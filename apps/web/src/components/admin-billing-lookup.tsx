"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { formatBalanceCents } from "@templ/chat/resolution-copy";
import { useChatAuth } from "@/lib/chat-auth";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import { billingAdmin, type BillingDetail } from "@/lib/billing-admin-client";
import { Field, ui } from "./ui/ui";
import styles from "./cost-dashboard.module.css";

export function AdminBillingLookup() {
  const auth = useChatAuth();
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const principal = auth.session?.principalId;
  return principal ? (
    <BillingLookup key={`${principal}:${revision}`} principal={principal} />
  ) : null;
}

export function BillingLookup({ principal }: { principal: ChatPrincipalId }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ id: string; request: number }>();
  const controller = useRef<AbortController | null>(null);
  const [download, setDownload] = useState<{
    request: number;
    busy: boolean;
    error?: string;
    note?: string;
  }>();
  const [result, setResult] = useState<{
    request: number;
    detail?: BillingDetail;
    error?: string;
  }>();
  useEffect(() => {
    if (!selected) return;
    const reader = new AbortController();
    controller.current = reader;
    void billingAdmin(principal)
      .detail(selected.id, reader.signal)
      .then(
        (detail) => {
          if (!reader.signal.aborted)
            setResult({ request: selected.request, detail });
        },
        () => {
          if (!reader.signal.aborted)
            setResult({
              request: selected.request,
              error: "The workspace could not be loaded.",
            });
        },
      );
    return () => reader.abort();
  }, [principal, selected]);
  const current = result?.request === selected?.request ? result : undefined;
  const detail = current?.detail;
  const downloading =
    download?.request === selected?.request ? download : undefined;
  const downloadLedger = async () => {
    if (!selected || !controller.current || downloading?.busy) return;
    const { id, request } = selected;
    const signal = controller.current.signal;
    setDownload({ request, busy: true });
    try {
      const ledger = await billingAdmin(principal).ledgerDownload(id, signal);
      if (signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(ledger, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `ledger-${id}.json`;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownload({
        request,
        busy: false,
        note: !ledger.usageRows
          ? "Downloaded the available financial fields."
          : ledger.usageRows.next
            ? "Downloaded the first ledger page."
            : "Ledger downloaded.",
      });
    } catch {
      if (!signal.aborted)
        setDownload({
          request,
          busy: false,
          error: "The ledger could not be downloaded.",
        });
    }
  };
  return (
    <section className={styles.page} aria-label="Workspace lookup">
      <h2>Open workspace</h2>
      <form
        className={styles.controls}
        onSubmit={(event) => {
          event.preventDefault();
          const id = input.trim().toLowerCase();
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              id,
            )
          ) {
            setError("Enter a valid workspace ID.");
            return;
          }
          setError("");
          setSelected((previous) => ({
            id,
            request: (previous?.request ?? 0) + 1,
          }));
        }}
      >
        <Field label="Workspace ID" error={error}>
          <input
            className={ui.input}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setError("");
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
          />
        </Field>
        <button type="submit" disabled={!input.trim()}>
          Open workspace
        </button>
      </form>
      {selected && !current && <p role="status">Loading workspace…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {detail && (
        <>
          <h3>
            Workspace <code>{selected!.id}</code>
          </h3>
          <dl>
            <dt>Mode</dt>
            <dd>{detail.mode ?? "Unavailable"}</dd>
            <dt>Order form</dt>
            <dd>
              {detail.orderForm === undefined
                ? "Unavailable"
                : detail.orderForm
                  ? `${detail.orderForm.id}, revision ${detail.orderForm.revision}`
                  : "None"}
            </dd>
            <dt>Ever funded</dt>
            <dd>
              {detail.everFunded === undefined
                ? "Unavailable"
                : detail.everFunded
                  ? "Yes"
                  : "No"}
            </dd>
            <dt>Balance</dt>
            <dd>
              {detail.balanceCents === undefined
                ? "Unavailable"
                : formatBalanceCents(detail.balanceCents)}
            </dd>
            <dt>Usage debt</dt>
            <dd>
              {detail.usageBilling === undefined
                ? "Unavailable"
                : detail.usageBilling
                  ? formatBalanceCents(detail.usageBilling.dueCents)
                  : "None"}
            </dd>
            <dt>Manual billing</dt>
            <dd>
              {detail.manualBilling === undefined
                ? "Unavailable"
                : (detail.manualBilling?.status ?? "None")}
            </dd>
          </dl>
          <button
            type="button"
            disabled={downloading?.busy}
            onClick={() => void downloadLedger()}
          >
            {downloading?.busy ? "Downloading…" : "Download ledger"}
          </button>
          {downloading?.error && <p role="alert">{downloading.error}</p>}
          {downloading?.note && <p role="status">{downloading.note}</p>}
        </>
      )}
    </section>
  );
}
