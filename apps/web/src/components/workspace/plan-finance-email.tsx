"use client";

import { useEffect, useRef, useState } from "react";
import type { ProductFinanceEmailView } from "@templ/chat/product-catalog";
import {
  readFinanceEmail,
  saveFinanceEmail,
  verifyFinanceEmail,
} from "@/lib/product-client";
import { Card } from "@/components/ui/ui";
import { communitySessionRevision } from "@/lib/community-auth";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

/** One optional address outside the team for billing alerts and the
 * monthly email. Its owner proves it with the code Templ sends there. */
export function PlanFinanceEmail({ context }: { context: WorkspaceContext }) {
  return (
    <FinanceEmail
      key={`${context.room}:${context.account}:${context.revision}`}
      context={context}
    />
  );
}
function FinanceEmail({ context }: { context: WorkspaceContext }) {
  const { room, account, revision } = context;
  const key = `${room}:${account}:${revision}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    value: ProductFinanceEmailView;
  }>();
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const sessionRevision = useRef(communitySessionRevision());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    readFinanceEmail(
      room,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    ).then(
      (result) => {
        if (!controller.signal.aborted)
          setLoaded({ key, value: result.financeEmail });
      },
      () => {
        if (!controller.signal.aborted) {
          setLoadError("Billing email could not load. Try again.");
          console.warn("TEMPL_SUPPORT_FAILURE", {
            route: "billing-email",
            step: "status",
            cause: "request-failed",
          });
        }
      },
    );
    return () => controller.abort();
  }, [room, key, refresh]);
  const current = loaded?.key === key ? loaded.value : null;
  function check() {
    if (
      !mounted.current ||
      sessionRevision.current !== communitySessionRevision()
    )
      throw new Error(
        "Your workspace or account changed. Reopen Plan and usage.",
      );
  }
  async function run(
    step: "send" | "verify" | "remove",
    action: () => Promise<{ financeEmail: ProductFinanceEmailView }>,
    done: (value: ProductFinanceEmailView) => string,
  ) {
    setBusy(true);
    setNote("");
    setError("");
    try {
      check();
      const result = await action();
      check();
      setLoaded({ key, value: result.financeEmail });
      setEmail("");
      setCode("");
      setNote(done(result.financeEmail));
    } catch (reason) {
      if (mounted.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : "That didn’t save. Try again.",
        );
        console.warn("TEMPL_SUPPORT_FAILURE", {
          route: "billing-email",
          step,
          cause: "request-failed",
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const send = () =>
    run(
      "send",
      () => saveFinanceEmail(account, room, email.trim(), check),
      (value) =>
        `Code requested for ${value?.email ?? "that address"}. Ask its owner for it.`,
    );
  return (
    <Card
      title="Billing email"
      description="Send billing alerts and monthly statements to one extra address. Emails contain amounts and counts. Its owner must confirm it."
    >
      <div className={styles.stack} style={{ gap: 12 }}>
        {loadError ? (
          <div>
            <p role="alert">{loadError}</p>
            <button
              type="button"
              className="button small secondary"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : !loaded ? (
          <p role="status">Loading billing email…</p>
        ) : current?.status === "verified" ? (
          <div className={plan.inline}>
            <span className={styles.muted}>{current.email}</span>
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  "remove",
                  () => saveFinanceEmail(account, room, null, check),
                  () => "Billing email removed.",
                )
              }
            >
              {busy ? "Removing…" : "Remove"}
            </button>
          </div>
        ) : current?.status === "pending" ? (
          <div className={styles.stack} style={{ gap: 8 }}>
            <p className={styles.small} style={{ margin: 0 }}>
              Enter the 6-digit code sent to {current.email}.
            </p>
            <p className={styles.small} style={{ margin: 0 }}>
              Codes expire after 15 minutes. Cancel to enter the address again.
            </p>
            <label className={styles.small} htmlFor="billing-email-code">
              Email code
            </label>
            <div className={plan.inline}>
              <input
                id="billing-email-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Code from the billing email"
                placeholder="123456"
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
              <button
                type="button"
                className="button small"
                disabled={busy || !/^\d{6}$/.test(code.trim())}
                onClick={() =>
                  void run(
                    "verify",
                    () => verifyFinanceEmail(account, room, code.trim(), check),
                    () => "Billing email added.",
                  )
                }
              >
                {busy ? "Saving…" : "Confirm"}
              </button>
              <button
                type="button"
                className="button small secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    "remove",
                    () => saveFinanceEmail(account, room, null, check),
                    () => "Billing email removed.",
                  )
                }
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.stack} style={{ gap: 8 }}>
            <label className={styles.small} htmlFor="billing-email-address">
              Email address
            </label>
            <div className={plan.inline}>
              <input
                id="billing-email-address"
                type="email"
                autoComplete="email"
                aria-label="Billing email address"
                placeholder="finance@example.org"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
              <button
                type="button"
                className="button small"
                disabled={busy || !email.includes("@")}
                onClick={() => void send()}
              >
                {busy ? "Sending…" : "Send code"}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className={styles.small} role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
        {note && (
          <p className={styles.small} role="status" style={{ margin: 0 }}>
            {note}
          </p>
        )}
      </div>
    </Card>
  );
}
