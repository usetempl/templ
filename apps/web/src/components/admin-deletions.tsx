"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import {
  deletionsAdmin,
  type OperatorDeletions,
} from "@/lib/deletions-admin-client";
import styles from "./cost-dashboard.module.css";

const STATE: Record<OperatorDeletions["open"][number]["state"], string> = {
  scheduled: "Waiting",
  deleting: "Deleting",
  held: "Held",
  "holds-unavailable": "Holds unreadable, retrying",
  unknown: "Not answering",
};
const when = (value: number | null | undefined) =>
  value
    ? `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "–";

/** `/admin/deletions`: workspaces waiting for or going through deletion,
 * and the ones deleted in the last 730 days. */
export function AdminDeletionsPanel() {
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
      <h1>Workspace deletions</h1>
      <p>Only Templ operators can see this page.</p>
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
        <Deletions key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}

export function Deletions({ principal }: { principal: ChatPrincipalId }) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    key: number;
    data?: OperatorDeletions;
    error?: string;
  }>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Delete now is irreversible: it ends the manager's cancel window, so it
  // gets its own screen with the id's first 8 characters typed.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const expedite = (id: string) => {
    setBusy(id);
    setError("");
    void deletionsAdmin(principal)
      .expedite(id)
      .then(
        () => {
          setConfirming(null);
          setRefresh((value) => value + 1);
        },
        (reason) =>
          setError(
            reason instanceof Error
              ? reason.message
              : "The deletion didn't move. Try again.",
          ),
      )
      .finally(() => setBusy(null));
  };
  const current = result?.key === refresh ? result : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void deletionsAdmin(principal)
      .read(controller.signal)
      .then(
        (data) => {
          if (!controller.signal.aborted) setResult({ key: refresh, data });
        },
        (reason) => {
          if (!controller.signal.aborted)
            setResult({
              key: refresh,
              error:
                reason instanceof CommunityApiError && reason.status === 403
                  ? "This page is for Templ operators."
                  : "Deletions could not be loaded. Try again.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, refresh]);
  if (confirming) {
    const matches = typed.trim().toLowerCase() === confirming.slice(0, 8);
    return (
      <section aria-labelledby="deletions-confirm">
        <h2 id="deletions-confirm">Delete this workspace now?</h2>
        <p>
          <code>{confirming}</code>
        </p>
        <ul>
          <li>The manager can&apos;t cancel after this.</li>
          <li>Deletion starts right away.</li>
        </ul>
        <form
          className={styles.controls}
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && busy === null) expedite(confirming);
          }}
        >
          <label>
            Type the first 8 characters of the workspace id
            <input
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!matches || busy !== null}>
            {busy === confirming ? "Moving…" : "Delete now"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setConfirming(null);
              setError("");
            }}
          >
            Keep waiting
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  }
  return (
    <>
      {!current && <p role="status">Loading deletions…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {error && <p role="alert">{error}</p>}
      {current?.data && (
        <>
          <section aria-labelledby="deletions-open">
            <h2 id="deletions-open">Open</h2>
            {current.data.open.length ? (
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>Workspace id</th>
                      <th>Asked</th>
                      <th>Due</th>
                      <th>State</th>
                      <th>Cases left</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {current.data.open.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">
                          <code>{row.id}</code>
                        </th>
                        <td>{when(row.requestedAt)}</td>
                        <td>{when(row.dueAt)}</td>
                        <td>{STATE[row.state]}</td>
                        <td>{row.threadsLeft ?? "–"}</td>
                        <td>
                          {row.state === "scheduled" && (
                            <button
                              type="button"
                              disabled={busy !== null}
                              title="Only when the manager asked for it sooner."
                              onClick={() => {
                                setTyped("");
                                setError("");
                                setConfirming(row.id);
                              }}
                            >
                              Delete now
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>None.</p>
            )}
            <p>Delete now only when the manager asked for it sooner.</p>
          </section>
          <section aria-labelledby="deletions-done">
            <h2 id="deletions-done">Deleted</h2>
            {current.data.deleted.length ? (
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>Workspace id</th>
                      <th>Asked</th>
                      <th>Deleted</th>
                      <th>Cases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.data.deleted.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">
                          <code>{row.id}</code>
                        </th>
                        <td>{when(row.requestedAt)}</td>
                        <td>{when(row.deletedAt)}</td>
                        <td>{row.counts.threads}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>None.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
