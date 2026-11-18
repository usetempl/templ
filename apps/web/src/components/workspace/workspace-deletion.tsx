"use client";

import { useRelease } from "@/lib/release-context";

import { useEffect, useState, type FormEvent } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { CommunityApiError } from "@/lib/community-client";
import { staffDataFlags } from "@/lib/staff-data-release";
import {
  cancelWorkspaceDeletion,
  deletionDate,
  deletionError,
  readWorkspaceDeletion,
  requestWorkspaceDeletion,
  type WorkspaceDeletion,
} from "@/lib/workspace-deletion-client";
import { Callout, Card, Field, Spinner, ui } from "@/components/ui/ui";
import { WORKSPACE_EXPORT_SECTION } from "./workspace-export";
import styles from "./workspace.module.css";
import own from "./staff-data.module.css";

const sameName = (typed: string, name: string) => {
  const fold = (value: string) => value.normalize("NFC").trim().toLowerCase();
  return fold(typed) !== "" && fold(typed) === fold(name);
};

/** Settings > Delete workspace, for the manager. One step per screen: the
 * section, an export offer while the export is live, then the confirmation
 * with the typed name. A fresh wallet sign-in opens when the service asks
 * for one. */
export function WorkspaceDeletionSection({
  room,
  account,
  name,
  manager,
  onScheduled,
  enabled: suppliedEnabled,
  exportLive = false,
}: {
  room: ChatRoomId;
  account?: ChatPrincipalId;
  name: string;
  manager: boolean;
  onScheduled: () => void;
  enabled?: boolean;
  exportLive?: boolean;
}) {
  const RELEASE = useRelease();
  const enabled = suppliedEnabled ?? staffDataFlags(RELEASE).workspaceDeletion;

  const [step, setStep] = useState<"section" | "export" | "confirm">("section");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!enabled || !manager) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!sameName(typed, name) || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestWorkspaceDeletion(room, account, typed);
      onScheduled();
    } catch (reason) {
      setError(deletionError(reason));
    } finally {
      setBusy(false);
    }
  }
  if (step === "export")
    return (
      <Card
        title="Download an export first?"
        description="Once the workspace is deleted, there is nothing left to export."
      >
        <div className={own.actions}>
          <button
            type="button"
            className="button"
            onClick={() => {
              setStep("section");
              document
                .getElementById(WORKSPACE_EXPORT_SECTION)
                ?.scrollIntoView({ block: "start" });
            }}
          >
            Download export
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setStep("confirm")}
          >
            Skip
          </button>
        </div>
      </Card>
    );
  if (step === "confirm")
    return (
      <form onSubmit={(event) => void submit(event)}>
        <Card
          className={own.danger}
          title={`Delete ${name}?`}
          footer={
            <>
              <span className={styles.small}>
                {error && (
                  <span className={styles.error} role="alert">
                    {error}
                  </span>
                )}
              </span>
              <span className={own.actions}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setStep("section");
                    setTyped("");
                    setError("");
                  }}
                >
                  Keep workspace
                </button>
                <button
                  type="submit"
                  className={`button secondary ${own.dangerButton}`}
                  disabled={!sameName(typed, name) || busy}
                >
                  {busy && <Spinner />}Delete workspace
                </button>
              </span>
            </>
          }
        >
          <ul className={own.points}>
            <li>
              Templ keeps payment receipts and a record of who deleted it and
              when.
            </li>
          </ul>
          <Field label="Type the workspace name">
            <input
              className={ui.input}
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        </Card>
      </form>
    );
  return (
    <Card title="Delete workspace" className={own.danger}>
      <ul className={own.points}>
        <li>Users and your team lose access right away.</li>
        <li>
          After 7 days, Templ deletes cases, notes, screenshots, settings and
          the team list.
        </li>
        <li>You can cancel until then.</li>
      </ul>
      <div className={own.actions}>
        <button
          type="button"
          className={`button secondary ${own.dangerButton}`}
          onClick={() => setStep(exportLive ? "export" : "confirm")}
        >
          Delete workspace
        </button>
      </div>
    </Card>
  );
}

/** What a closing workspace shows instead of its pages. The manager sees
 * the date and can cancel while the deletion waits; everyone else reads
 * that only the manager can open it. */
export function WorkspaceClosed({
  room,
  account,
  onReopened,
  exportPanel,
}: {
  room: ChatRoomId;
  account?: ChatPrincipalId;
  onReopened: () => void;
  /** The manager's workspace export, while it stays open. */
  exportPanel?: React.ReactNode;
}) {
  const [view, setView] = useState<WorkspaceDeletion | "not-manager">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    readWorkspaceDeletion(room, controller.signal).then(
      (value) => setView(value),
      (reason) => {
        if (controller.signal.aborted) return;
        setView(
          reason instanceof CommunityApiError &&
            [401, 403, 404].includes(reason.status)
            ? "not-manager"
            : undefined,
        );
        if (
          !(reason instanceof CommunityApiError) ||
          ![401, 403, 404].includes(reason.status)
        )
          setError(deletionError(reason));
      },
    );
    return () => controller.abort();
  }, [room]);
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await cancelWorkspaceDeletion(room, account);
      setNotice("Deletion cancelled. Everyone has access again.");
      onReopened();
    } catch (reason) {
      setError(deletionError(reason));
    } finally {
      setBusy(false);
    }
  }
  if (notice)
    return (
      <p role="status" className={styles.status}>
        {notice}
      </p>
    );
  if (view === "not-manager" || (view && view.state === "none"))
    return (
      <p>This workspace is being deleted. Only the manager can open it.</p>
    );
  if (!view)
    return error ? (
      <p role="alert">{error}</p>
    ) : (
      <p role="status">Checking the workspace…</p>
    );
  if (view.state === "deleting")
    return (
      <p>
        Deleting this workspace. Templ keeps anything it is legally required to
        keep until it no longer has to.
      </p>
    );
  return (
    <>
      <Callout tone="warning" role="status">
        This workspace will be deleted on {deletionDate(view.dueAt ?? 0)}. Users
        and your team can&apos;t open it.
      </Callout>
      <div className={own.actions}>
        {view.canCancel && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {busy && <Spinner />}Cancel deletion
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {exportPanel}
    </>
  );
}
