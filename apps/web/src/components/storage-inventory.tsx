"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import {
  groupFileInventory,
  type GroupFileInventoryRecord,
} from "@/lib/inventory-admin-client";
import styles from "./cost-dashboard.module.css";

const count = (value: number) => new Intl.NumberFormat("en-US").format(value);
export function size(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0
    ? `${count(bytes)} bytes`
    : `${value.toFixed(1)} ${units[unit]}`;
}
/** UTC minutes, the same for every operator. */
const when = (value: string | null) =>
  value === null ? "None" : `${value.slice(0, 16).replace("T", " ")} UTC`;

/** Operator count of the group chat files left in storage. */
export function StorageInventoryPanel() {
  const auth = useChatAuth();
  const principal = auth.session?.principalId;
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const [signInError, setSignInError] = useState("");
  return (
    <main className={styles.page}>
      <h1>Stored group files</h1>
      <p>Only Templ operators can see this page.</p>
      <p>
        Files from group chat stay in private storage until Templ deletes
        them. The count reads the file list and deletes nothing.
      </p>
      {auth.restoring ? (
        <p role="status">Checking sign-in…</p>
      ) : !principal ? (
        <div>
          <p>Sign in with a Templ operator account.</p>
          <button
            type="button"
            onClick={() => {
              setSignInError("");
              void auth.signIn().catch((error) => {
                if (!isChatSignInCanceled(error))
                  setSignInError("Sign-in did not finish. Try again.");
              });
            }}
          >
            Sign in
          </button>
          {signInError && <p role="alert">{signInError}</p>}
        </div>
      ) : (
        <Inventory key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}

function Inventory({ principal }: { principal: ChatPrincipalId }) {
  const [running, setRunning] = useState(false);
  const [record, setRecord] = useState<GroupFileInventoryRecord>();
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const start = () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setRunning(true);
    setError("");
    setRecord(undefined);
    void groupFileInventory(principal)
      .count(next.signal, (partial) => {
        if (!next.signal.aborted) setRecord(partial);
      })
      .then(
        (done) => {
          if (!next.signal.aborted) setRecord(done);
        },
        (reason) => {
          if (next.signal.aborted) return;
          setError(
            reason instanceof CommunityApiError && reason.status === 403
              ? "This page is for Templ operators."
              : "The count didn't finish. Try again.",
          );
        },
      )
      .finally(() => {
        if (!next.signal.aborted) setRunning(false);
      });
  };
  const save = () => {
    if (!record?.complete) return;
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(record, null, 2)}\n`], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `group-file-inventory-${record.finishedAt.slice(0, 10)}.json`;
    link.rel = "noopener";
    // Attached and revoked late: a detached link or an immediate revoke can
    // cancel the download in some browsers.
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <>
      <div className={styles.controls}>
        <button type="button" disabled={running} onClick={start}>
          {running ? "Counting…" : record ? "Count again" : "Count files"}
        </button>
        {record?.complete && !running && (
          <button type="button" onClick={save}>
            Save record
          </button>
        )}
      </div>
      {running && (
        <p role="status">
          Counting. {count(record?.objects ?? 0)} files so far.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {record && !running && !error && (
        <section aria-labelledby="inventory-result">
          <h2 id="inventory-result">
            {record.complete
              ? `${count(record.objects)} files`
              : "The count stopped before the end. Count again."}
          </h2>
          <ul>
            <li>Size: {size(record.bytes)}</li>
            <li>Oldest upload: {when(record.oldestUploaded)}</li>
            <li>Newest upload: {when(record.newestUploaded)}</li>
            <li>Other entries under group/: {count(record.otherKeys)}</li>
            <li>Counted: {when(record.finishedAt)}</li>
          </ul>
        </section>
      )}
    </>
  );
}
