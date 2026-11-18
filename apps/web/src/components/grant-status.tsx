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
import { checkGrants, type GrantStatusRecord } from "@/lib/grants-admin-client";
import styles from "./cost-dashboard.module.css";

const STATUS_LABELS: Record<
  GrantStatusRecord["grants"][number]["status"],
  string
> = {
  pending: "Not credited yet",
  credited: "Credited",
  deferred: "Waiting for room",
  revoked: "Revoked",
};
const day = (value: string | null) => (value ? value.slice(0, 10) : "None");

/** Operator view of the reviewed grants: what each one did. */
export function GrantStatusPanel() {
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
      <h1>Granted cases</h1>
      <p>Only Templ operators can see this page.</p>
      <p>
        Checks each grant in the release list. Checking credits any grant a
        workspace hasn&apos;t picked up yet.
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
        <Grants key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}

function Grants({ principal }: { principal: ChatPrincipalId }) {
  const [running, setRunning] = useState(false);
  const [record, setRecord] = useState<GrantStatusRecord>();
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const start = () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setRunning(true);
    setError("");
    setRecord(undefined);
    void checkGrants(principal, next.signal)
      .then(
        (done) => {
          if (!next.signal.aborted) setRecord(done);
        },
        (reason) => {
          if (next.signal.aborted) return;
          setError(
            reason instanceof CommunityApiError && reason.status === 403
              ? "This page is for Templ operators."
              : "The check didn't finish. Try again.",
          );
        },
      )
      .finally(() => {
        if (!next.signal.aborted) setRunning(false);
      });
  };
  const save = () => {
    if (!record) return;
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(record, null, 2)}\n`], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `grant-status-${record.checkedAt.slice(0, 10)}.json`;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <>
      <div className={styles.controls}>
        <button type="button" disabled={running} onClick={start}>
          {running ? "Checking…" : record ? "Check again" : "Check grants"}
        </button>
        {record && !running && (
          <button type="button" onClick={save}>
            Save record
          </button>
        )}
      </div>
      {running && <p role="status">Checking each workspace.</p>}
      {error && <p role="alert">{error}</p>}
      {record && !running && !error && (
        <section aria-labelledby="grant-result">
          <h2 id="grant-result">
            {record.grants.length
              ? `${record.grants.length} grants`
              : "No grants are listed."}
          </h2>
          <ul>
            {record.grants.map((grant) => (
              <li key={grant.id}>
                {grant.id} ({grant.kind}): {STATUS_LABELS[grant.status]}
                {grant.endsAt ? `, ends ${day(grant.endsAt)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
