"use client";

import { useEffect, useRef, useState } from "react";
import type {
  BrainStorageLedger,
  BrainStorageView,
} from "@templ/chat/knowledge";
import {
  readBrainStorage,
  readBrainStorageLedger,
  confirmBrainStorageAgreement,
} from "@/lib/knowledge-client";
import { CommunityApiError } from "@/lib/community-client";
import { Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace-quality.module.css";

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const bytes = (value: number) =>
  `${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 3 })} MB`;
const failure = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "Storage usage could not load. Try again.";

export function BrainStoragePanel({
  context,
  revision,
}: {
  context: WorkspaceContext;
  revision: number;
}) {
  if (!context.manager) return null;
  return (
    <StoragePanel
      key={`${context.room}:${context.account}:${context.revision}:${revision}`}
      context={context}
    />
  );
}
function StoragePanel({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const [unavailable, setUnavailable] = useState(false);
  const [view, setView] = useState<BrainStorageView | null>(null);
  const [reviewing, setReviewing] = useState<
    "accept-agreement" | "withdraw-agreement" | null
  >(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const retained = useRef(false);
  const requestId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    setUnavailable(false);
    readBrainStorage(room, request.signal)
      .then((data) => {
        if (!request.signal.aborted) {
          retained.current ||= Boolean(
            data.billing?.agreement ||
            data.billing?.accepted ||
            data.billing?.dueCents,
          );
          setView(data);
          setError("");
        }
      })
      .catch((reason) => {
        if (!request.signal.aborted) {
          if (
            reason instanceof CommunityApiError &&
            reason.status === 404 &&
            context.state?.features?.brainStorage !== true &&
            !retained.current
          )
            setUnavailable(true);
          else setError(failure(reason));
        }
      });
    return () => request.abort();
  }, [room, account, retry, context.state?.features?.brainStorage]);
  async function save() {
    const signal = controller.current?.signal;
    const agreement = view?.billing?.agreement;
    if (!agreement || !reviewing || !confirmed || !signal) return;
    const action = reviewing;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      requestId.current ??= `bsc-${crypto.randomUUID()}`;
      const saved = await confirmBrainStorageAgreement(
        room,
        account,
        {
          action,
          requestId: requestId.current,
          agreementId: agreement.id,
          revision: agreement.revision,
          documentSha256: agreement.documentSha256,
          termsSha256: agreement.termsSha256,
        },
        () => signal.throwIfAborted(),
        signal,
      );
      if (signal.aborted) return;
      setView(saved);
      setLedgerRevision((value) => value + 1);
      requestId.current = null;
      setReviewing(null);
      setConfirmed(false);
      setNotice(
        action === "accept-agreement"
          ? "Storage agreement confirmed."
          : "Storage agreement withdrawn. Prior charges remain due.",
      );
    } catch (reason) {
      if (!signal.aborted) setError(failure(reason));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  if (unavailable) return null;
  return (
    <section className={styles.review} aria-labelledby="brain-storage-title">
      <h3 id="brain-storage-title">File storage</h3>
      {view ? (
        <>
          <dl>
            <dt>Stored file text</dt>
            <dd>{bytes(view.retainedUploadBytes)}</dd>
            <dt>Free allowance</dt>
            <dd>{bytes(view.price.freeBytesPerWorkspace)}</dd>
            <dt>Month estimate</dt>
            <dd>{dollars(view.meteredEstimateCents)}</dd>
            {view.billing && (
              <>
                <dt>Amount due</dt>
                <dd>{dollars(view.billing.dueCents)}</dd>
              </>
            )}
            {!!view.billing?.pendingCents && (
              <>
                <dt>Awaiting settlement</dt>
                <dd>{dollars(view.billing.pendingCents)}</dd>
              </>
            )}
          </dl>
          <p className={styles.note}>
            Additional file text costs {dollars(view.price.usdCentsPerGbMonth)}{" "}
            per GB-month, based on stored bytes and time.
          </p>
          <p className={styles.note}>
            Links, FAQs and saved replies have no file storage charge. Viewing
            this estimate creates no debt.
          </p>
          <p className={styles.note}>
            Uploads work without an agreement when total stored file text stays
            within {bytes(view.price.freeBytesPerWorkspace)}.
          </p>
          {view.billing?.status === "paused" && (
            <p className={styles.note}>
              Extra file use is paused. Pay existing debt or remove files. Links
              remain usable.
            </p>
          )}
          {view.billing?.meterUnavailable && (
            <p className={styles.note}>
              Storage usage could not be checked. You can withdraw its
              agreement.
            </p>
          )}
          {view.unclassifiedSources > 0 && (
            <p className={styles.note}>
              {view.unclassifiedSources} older sources have no import record.
              Their text is excluded.
            </p>
          )}
          {reviewing ? (
            <>
              <section>
                <h3>Signed storage agreement</h3>
                <pre className={styles.storageTerms}>
                  {view.billing?.agreement?.documentText}
                </pre>
              </section>
              <p className={styles.note}>
                Storage shares your workspace’s{" "}
                {dollars(view.billing?.debtLimitCents ?? 0)} debt limit.
              </p>
              <label className={ui.check}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {reviewing === "accept-agreement"
                  ? "I confirm this signed storage agreement."
                  : "I want to stop future storage charges."}
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="button small"
                  disabled={!confirmed || busy}
                  onClick={() => void save()}
                >
                  {busy && <Spinner />}
                  {reviewing === "withdraw-agreement"
                    ? "Withdraw agreement"
                    : "Confirm agreement"}
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  disabled={busy}
                  onClick={() => {
                    setReviewing(null);
                    requestId.current = null;
                    setConfirmed(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : view.billing?.agreement &&
            (view.billing.accepted || view.billing.collectionQualified) ? (
            <button
              type="button"
              className="button small secondary"
              onClick={() => {
                setReviewing(
                  view.billing?.accepted
                    ? "withdraw-agreement"
                    : "accept-agreement",
                );
                setNotice("");
              }}
            >
              {view.billing.accepted
                ? "Withdraw agreement"
                : "Review agreement"}
            </button>
          ) : (
            <p className={styles.note}>
              Extra files need an accepted storage agreement. You can use links
              or remove files.
            </p>
          )}
          <StorageLedger room={room} revision={ledgerRevision} />
        </>
      ) : (
        !error && (
          <p role="status">
            <Spinner />
            Loading storage usage…
          </p>
        )
      )}
      {error && (
        <>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        </>
      )}
      {notice && (
        <p className={styles.status} role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
function StorageLedger({
  room,
  revision,
}: {
  room: WorkspaceContext["room"];
  revision: number;
}) {
  const [result, setResult] = useState<{
    revision: number;
    page: BrainStorageLedger | null;
    error: string;
  } | null>(null);
  const page = result?.revision === revision ? result.page : null;
  const error = result?.revision === revision ? result.error : "";
  const [cursor, setCursor] = useState<{ revision: number; value?: string }>({
    revision,
  });
  const after = cursor.revision === revision ? cursor.value : undefined;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    readBrainStorageLedger(room, after, request.signal)
      .then((value) => {
        if (!request.signal.aborted)
          setResult({ revision, page: value, error: "" });
      })
      .catch((reason) => {
        if (!request.signal.aborted)
          setResult({ revision, page: null, error: failure(reason) });
      });
    return () => request.abort();
  }, [room, after, retry, revision]);
  return (
    <section>
      <h3>Storage charges</h3>
      {error ? (
          <>
            <p role="alert" className={styles.error}>
              {error}
            </p>
            <button
              type="button"
              className="button small secondary"
              onClick={() => {
                setResult(null);
                setRetry((n) => n + 1);
              }}
            >
              Retry charges
            </button>
          </>
        ) : !page ? (
          <p role="status">
            <Spinner />
            Loading charges…
          </p>
        ) : !page.rows.length ? (
          <p className={styles.note}>No storage charges yet.</p>
        ) : (
          <>
            <table className={styles.table}>
              <caption>Storage ledger</caption>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Entry</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {new Date(row.at).toLocaleDateString("en-US", {
                        timeZone: "UTC",
                      })}
                    </td>
                    <td>
                      {row.kind === "storage"
                        ? `Storage ${row.month}`
                        : row.kind === "payment"
                          ? "Payment"
                          : "Credit"}
                    </td>
                    <td>{dollars(row.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {page.next && (
              <button
                type="button"
                className="button small secondary"
                onClick={() => {
                  setResult(null);
                  setCursor({ revision, value: page.next! });
                }}
              >
                More charges
              </button>
            )}
          </>
        )}
    </section>
  );
}
