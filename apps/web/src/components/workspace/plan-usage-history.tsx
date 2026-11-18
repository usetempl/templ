"use client";

import { useEffect, useRef, useState } from "react";
import {
  PRODUCT_DISPUTE_REASONS,
  PRODUCT_DISPUTE_TEXT_MAX,
  type ProductDisputeReason,
} from "@templ/chat/product-catalog";
import {
  usageEntryLabel,
  type ProductUsagePage,
} from "@templ/chat/usage-billing";
import { disputeCharge, readUsageCharges } from "@/lib/product-client";
import { formatUsd } from "@/lib/product-format";
import { Card, Callout, EmptyState, Skeleton } from "@/components/ui/ui";
import { statementMonths } from "./plan-budget";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

const reasons: Record<ProductDisputeReason, string> = {
  spam: "Spam",
  test: "Our own test",
  duplicate: "Same case",
  "not-resolved": "Not resolved",
  other: "Other",
};
export function PlanUsageHistory({ context }: { context: WorkspaceContext }) {
  const { room, account, revision } = context;
  const months = statementMonths(Date.now());
  const [month, setMonth] = useState(months[0].id);
  const [bump, setBump] = useState(0);
  const key = `${room}:${account}:${revision}:${month}:${bump}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    page?: ProductUsagePage;
    error?: string;
  }>();
  const [more, setMore] = useState<{ key: string; page: ProductUsagePage }>();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState<ProductDisputeReason>("other");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    readUsageCharges(room, { month }, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted) setLoaded({ key, page });
      },
      (error) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            error:
              error instanceof Error ? error.message : "Usage could not load.",
          });
      },
    );
    return () => controller.abort();
  }, [room, month, key]);
  const current = loaded?.key === key ? loaded : undefined;
  const extra = more?.key === key ? more.page : undefined;
  const rows = [...(current?.page?.rows ?? []), ...(extra?.rows ?? [])];
  const cases = [...(current?.page?.cases ?? []), ...(extra?.cases ?? [])];
  const next = extra ? extra.next : current?.page?.next;
  async function act(dispute: boolean) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (dispute && open) {
        await disputeCharge(account, room, {
          ref: open,
          reason,
          text: note.trim() || null,
        });
        setOpen(null);
        setNote("");
        setBump((value) => value + 1);
        setMessage("Sent to Templ for review.");
      } else if (next) {
        const page = await readUsageCharges(room, { month, after: next });
        setMore({
          key,
          page: {
            rows: [...(extra?.rows ?? []), ...page.rows],
            cases: [...(extra?.cases ?? []), ...page.cases],
            next: page.next,
          },
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Try again.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const shown = new Set<string>();
  return (
    <Card
      title="Usage history"
      description="Charges, payments and credits. Each feature bills once per case."
    >
      <select
        aria-label="Usage month"
        value={month}
        onChange={(event) => {
          setMonth(event.target.value);
          setOpen(null);
          setMessage("");
        }}
      >
        {months.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {message && <p role="status">{message}</p>}
      {!current ? (
        <Skeleton height={80} />
      ) : current.error ? (
        <Callout tone="danger" role="alert">
          {current.error}
        </Callout>
      ) : !rows.length ? (
        <EmptyState title="No usage yet">
          Your charges and payments will appear here.
        </EmptyState>
      ) : (
        <ul className={plan.charges}>
          {rows.map((row) => {
            const summary = row.ref
              ? cases.find((item) => item.ref === row.ref)
              : null;
            const dispute =
              summary &&
              !shown.has(summary.ref) &&
              summary.disputeUntil !== null &&
              summary.disputeUntil > Date.now() &&
              !summary.dispute;
            if (summary) shown.add(summary.ref);
            return (
              <li key={row.id} className={plan.charge}>
                <div className={plan.chargeHead}>
                  <strong>{usageEntryLabel(row)}</strong>
                  <span>{formatUsd(row.cents)}</span>
                </div>
                <span className={plan.chargeMeta}>
                  {new Date(row.at).toLocaleDateString()}{" "}
                  {row.ref ? `Case ${row.ref}` : ""}
                </span>
                {summary?.dispute && (
                  <p className={styles.small}>
                    Dispute{" "}
                    {summary.dispute === "open"
                      ? "under review"
                      : summary.dispute === "credited"
                        ? "credited"
                        : "declined"}
                    .
                  </p>
                )}
                {dispute && open !== row.ref && (
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => {
                      setOpen(row.ref!);
                      setMessage("");
                    }}
                  >
                    Dispute
                  </button>
                )}
                {dispute && open === row.ref && (
                  <div className={plan.dispute}>
                    <label>
                      Reason
                      <select
                        value={reason}
                        onChange={(event) =>
                          setReason(event.target.value as ProductDisputeReason)
                        }
                      >
                        {PRODUCT_DISPUTE_REASONS.map((value) => (
                          <option key={value} value={value}>
                            {reasons[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <textarea
                      aria-label="Dispute note"
                      placeholder="Note for Templ (optional)"
                      maxLength={PRODUCT_DISPUTE_TEXT_MAX}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <div className={plan.chargeActions}>
                      <button
                        type="button"
                        className="button small"
                        disabled={busy}
                        onClick={() => void act(true)}
                      >
                        {busy ? "Sending…" : "Send dispute"}
                      </button>
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={busy}
                        onClick={() => setOpen(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <button
          type="button"
          className="button small secondary"
          disabled={busy}
          onClick={() => void act(false)}
        >
          {busy ? "Loading…" : "Show more"}
        </button>
      )}
    </Card>
  );
}
