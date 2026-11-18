"use client";

import { useEffect, useState } from "react";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { readBudget, readStatementCsv, saveBudget } from "@/lib/product-client";
import { formatUsd } from "@/lib/product-format";
import { Card } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

/** The last twelve UTC months, newest first, as `yyyymm` with a label. */
export function statementMonths(now: number) {
  const date = new Date(now);
  const months: { id: string; label: string }[] = [];
  for (let back = 0; back < 12; back++) {
    const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1);
    months.push({
      id: resolutionMonth(at),
      label: new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(at),
    });
  }
  return months;
}

/** An optional monthly budget that only sends alerts (50%, 80% and 100% of
 * the month's charges), and the monthly statement as CSV. Nothing here
 * caps or stops Support. */
export function PlanBudget({
  context,
  statementsOnly = false,
}: {
  context: WorkspaceContext;
  statementsOnly?: boolean;
}) {
  const { room, account, revision } = context;
  const key = `${room}:${account}:${revision}`;
  const [loaded, setLoaded] = useState<{ key: string; cents: number | null }>();
  const [dollars, setDollars] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const months = statementMonths(Date.now());
  const [month, setMonth] = useState(months[0].id);
  useEffect(() => {
    if (statementsOnly) return;
    const controller = new AbortController();
    readBudget(room, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setLoaded({ key, cents: value.budget });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ key, cents: null });
      },
    );
    return () => controller.abort();
  }, [room, key, statementsOnly]);
  const budget = loaded?.key === key ? loaded.cents : null;
  async function save(cents: number | null) {
    setBusy(true);
    setNote("");
    try {
      const result = await saveBudget(account, room, cents);
      setLoaded({ key, cents: result.budget });
      setDollars("");
      setNote(result.budget === null ? "Budget removed." : "Budget saved.");
    } catch (reason) {
      setNote(
        reason instanceof Error ? reason.message : "The budget didn’t save.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setNote("");
    try {
      const csv = await readStatementCsv(room, month);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `templ-statement-${month}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setNote(
        reason instanceof Error
          ? reason.message
          : "The statement could not load.",
      );
    }
  }
  const entered = /^\d{1,7}$/.test(dollars.trim())
    ? Number(dollars) * 100
    : null;
  return (
    <Card title={statementsOnly ? "Statements" : "Budget and statements"}>
      <div className={styles.stack} style={{ gap: 16 }}>
        {!statementsOnly && (
          <div className={styles.stack} style={{ gap: 8 }}>
            <p className={styles.muted} style={{ margin: 0 }}>
              {budget === null
                ? "Set a monthly budget to get an email at 50%, 80% and 100% of it. It never stops Support."
                : `Monthly budget ${formatUsd(budget)}. You get an email at 50%, 80% and 100%. It never stops Support.`}
            </p>
            <div className={plan.inline}>
              <input
                inputMode="numeric"
                aria-label="Monthly budget in dollars"
                placeholder="Dollars"
                value={dollars}
                onChange={(event) => setDollars(event.target.value)}
              />
              <button
                type="button"
                className="button small"
                disabled={busy || entered === null || entered === 0}
                onClick={() => void save(entered)}
              >
                Save budget
              </button>
              {budget !== null && (
                <button
                  type="button"
                  className="button small secondary"
                  disabled={busy}
                  onClick={() => void save(null)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
        <div className={plan.inline}>
          <select
            aria-label="Statement month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          >
            {months.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button small secondary"
            onClick={() => void download()}
          >
            Download statement (CSV)
          </button>
          <a
            className={styles.inlineLink}
            href={`/billing/statement?room=${encodeURIComponent(room)}&month=${month}`}
            target="_blank"
            rel="noopener"
          >
            Printable statement
          </a>
        </div>
        {note && (
          <p className={styles.small} role="status" style={{ margin: 0 }}>
            {note}
          </p>
        )}
      </div>
    </Card>
  );
}
