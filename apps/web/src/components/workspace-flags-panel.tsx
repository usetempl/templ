"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import type { WorkspaceFlagKey } from "@templ/chat/workspace-flags";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import {
  readOperatorFlags,
  setWorkspaceFlag,
  WORKSPACE_FEATURE_NAMES,
  type WorkspaceFlagsIndex,
} from "@/lib/workspace-flags-client";
import styles from "./cost-dashboard.module.css";
import own from "./workspace-flags-panel.module.css";

export function WorkspaceFlagsPanel() {
  const auth = useChatAuth();
  const principal = auth.session?.principalId;
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const [error, setError] = useState("");
  return (
    <main className={styles.page}>
      <h1>Workspace flags</h1>
      <p>Only Templ operators can use this page.</p>
      {auth.restoring ? (
        <p role="status">Checking sign-in…</p>
      ) : !principal ? (
        <>
          <p>Sign in with a Templ operator account.</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              void auth.signIn().catch((reason) => {
                if (!isChatSignInCanceled(reason))
                  setError("Sign-in did not finish. Try again.");
              });
            }}
          >
            Sign in
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      ) : (
        <Flags key={`${principal}:${revision}`} />
      )}
    </main>
  );
}

function Flags() {
  const [record, setRecord] = useState<WorkspaceFlagsIndex>();
  const [workspace, setWorkspace] = useState("");
  const [key, setKey] = useState<WorkspaceFlagKey>("installCheck");
  const [on, setOn] = useState(true);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readOperatorFlags(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setRecord(value);
      },
      (failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof CommunityApiError && failure.status === 404
              ? "This page is for Templ operators."
              : "Flags could not load. Try again.",
          );
      },
    );
    return () => controller.abort();
  }, [bump]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      await setWorkspaceFlag({
        workspace: workspace.trim(),
        key,
        on,
        until: new Date(until).toISOString(),
        reason: reason.trim(),
      });
      setSaved(true);
      setBump((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The flag could not save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section aria-labelledby="set-workspace-flag">
        <h2 id="set-workspace-flag">Set a flag</h2>
        <form className={own.form} onSubmit={(event) => void submit(event)}>
          <label>
            Workspace
            <input
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              required
            />
          </label>
          <label>
            Feature
            <select
              value={key}
              onChange={(event) =>
                setKey(event.target.value as WorkspaceFlagKey)
              }
            >
              {(Object.keys(WORKSPACE_FEATURE_NAMES) as WorkspaceFlagKey[]).map(
                (value) => (
                  <option key={value} value={value}>
                    {WORKSPACE_FEATURE_NAMES[value]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Flag
            <select
              value={on ? "on" : "off"}
              onChange={(event) => setOn(event.target.value === "on")}
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label>
            End date
            <input
              type="datetime-local"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              required
            />
          </label>
          <label>
            Reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              maxLength={280}
              required
            />
          </label>
          <p>Flags end within 90 days. The kill switch must be on.</p>
          <button disabled={busy} type="submit">
            {busy ? "Saving…" : "Save flag"}
          </button>
        </form>
      </section>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Flag saved.</p>}
      {record && (
        <section aria-labelledby="active-workspace-flags">
          <h2 id="active-workspace-flags">Flags on</h2>
          {!record.workspaces.length ? (
            <p>No workspace flags are on.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Feature</th>
                    <th>End date</th>
                    <th>Set by</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {record.workspaces.flatMap((row) =>
                    row.flags.map((flag) => (
                      <tr key={`${row.workspace}:${flag.key}`}>
                        <th scope="row">{row.workspace}</th>
                        <td>{WORKSPACE_FEATURE_NAMES[flag.key]}</td>
                        <td>
                          <time dateTime={flag.until}>
                            {new Date(flag.until).toLocaleString()}
                          </time>
                        </td>
                        <td>{flag.operator}</td>
                        <td>{flag.reason}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
