"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { chatMutation } from "@/lib/chat-api";
import {
  communitySessionRevision,
  peekCommunitySession,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import { roomPath } from "@/lib/community-client";
import { checkedNativeRoom, rememberNativeRoom } from "@/lib/native-room";
import { Callout, Card, Field, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

type Action = "nominate" | "cancel" | "accept";
type ManagementContext = Pick<
  WorkspaceContext,
  "room" | "workspace" | "account" | "manager" | "revision" | "reload"
>;

export function WorkspaceManagement({
  context,
}: {
  context: ManagementContext;
}) {
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const session = peekCommunitySession();
  if (!session || session.principalId !== context.account) return null;
  const aliases = session.servicePrincipals;
  const manager =
    context.manager && aliases.includes(context.workspace.manager);
  const nominee =
    context.workspace.pendingManager !== null &&
    aliases.includes(context.workspace.pendingManager);
  if (!manager && !nominee) return null;
  return (
    <Management
      key={`${context.room}:${context.account}:${revision}:${context.workspace.manager}:${context.workspace.pendingManager}`}
      context={context}
      manager={manager}
      revision={revision}
    />
  );
}

function Management({
  context,
  manager,
  revision,
}: {
  context: ManagementContext;
  manager: boolean;
  revision: number;
}) {
  const { room, account, workspace } = context;
  const [entered, setEntered] = useState("");
  const [review, setReview] = useState<Action | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const target = normalizeChatPrincipal(entered.trim());
  function start(action: Action) {
    setError("");
    if (action === "nominate") {
      if (!target) {
        setError("Enter a wallet address or account ID.");
        return;
      }
      if (peekCommunitySession()?.servicePrincipals.includes(target)) {
        setError("Choose another manager.");
        return;
      }
    }
    setConfirmed(false);
    setReview(action);
  }
  async function save() {
    if (!review || !confirmed || pending.current) return;
    const action = review;
    const request = new AbortController();
    pending.current = request;
    const assertCurrent = () => {
      request.signal.throwIfAborted();
      if (
        communitySessionRevision() !== revision ||
        peekCommunitySession()?.principalId !== account
      )
        throw new Error("Your account changed. Review the transfer again.");
    };
    setBusy(true);
    setError("");
    try {
      assertCurrent();
      const result = checkedNativeRoom(
        await chatMutation<unknown>(
          account,
          roomPath(room, action === "accept" ? "manager/accept" : "manager"),
          action === "accept"
            ? { confirmed: true }
            : { next: action === "cancel" ? null : target, confirmed: true },
          assertCurrent,
          request.signal,
        ),
      );
      assertCurrent();
      if (
        result.id !== workspace.id ||
        result.manager !==
          (action === "accept" ? account : workspace.manager) ||
        result.pendingManager !== (action === "nominate" ? target : null)
      )
        throw new Error(
          "Could not verify this transfer. Reload the workspace.",
        );
      rememberNativeRoom(result);
      setEntered("");
      setReview(null);
      setConfirmed(false);
      setNotice(
        action === "nominate"
          ? "Nomination sent. The new manager must open this workspace to accept."
          : action === "cancel"
            ? "Transfer cancelled."
            : "Management accepted.",
      );
      context.reload();
    } catch (reason) {
      if (!request.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "The transfer failed. Try again.",
        );
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const reviewedTarget =
    review === "nominate" ? target : workspace.pendingManager;
  return (
    <Card id="workspace-manager" title="Workspace manager">
      <UnsavedChanges dirty={Boolean(entered.trim() || review)} />
      {review ? (
        <div className={styles.stack}>
          <p>
            {review === "cancel"
              ? "Cancel this manager transfer?"
              : review === "accept"
                ? "You will control AI sources, settings and team access."
                : "Your manager access ends when the new manager accepts."}
          </p>
          <div>
            <p className={styles.small}>New manager</p>
            <p style={{ overflowWrap: "anywhere" }}>
              <code>{reviewedTarget}</code>
            </p>
          </div>
          {review !== "cancel" && (
            <p className={styles.small}>
              Current file-storage acceptance closes when management changes.
              Prior charges remain due.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            I reviewed this change.
          </label>
          <div>
            <button
              type="button"
              className="button"
              disabled={!confirmed || busy}
              onClick={() => void save()}
            >
              {busy && <Spinner />}
              {review === "cancel"
                ? "Cancel transfer"
                : review === "accept"
                  ? "Accept management"
                  : "Nominate manager"}
            </button>{" "}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setReview(null);
                setConfirmed(false);
                setError("");
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : manager ? (
        workspace.pendingManager ? (
          <div className={styles.stack}>
            <p>Waiting for the new manager to accept.</p>
            <p style={{ overflowWrap: "anywhere" }}>
              <code>{workspace.pendingManager}</code>
            </p>
            <button
              type="button"
              className="button secondary"
              onClick={() => start("cancel")}
            >
              Cancel transfer
            </button>
          </div>
        ) : (
          <form
            className={styles.stack}
            onSubmit={(event) => {
              event.preventDefault();
              start("nominate");
            }}
          >
            <Field
              label="New manager"
              hint="Enter their wallet address or account ID."
            >
              <input
                className={ui.input}
                value={entered}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setEntered(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <button type="submit" className="button secondary">
              Review transfer
            </button>
          </form>
        )
      ) : (
        <div className={styles.stack}>
          <p>The current manager nominated you to manage this workspace.</p>
          <button
            type="button"
            className="button"
            onClick={() => start("accept")}
          >
            Review transfer
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
    </Card>
  );
}
