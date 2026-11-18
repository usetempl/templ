"use client";

import { useEffect, useRef, useState } from "react";
import type { NativeTelegramView } from "@templ/chat/support-telegram";
import { readNativeTelegram, changeNativeTelegram } from "@/lib/alerts-client";
import { CommunityApiError } from "@/lib/community-client";
import { readSupport } from "@/lib/support-read";
import {
  Badge,
  Callout,
  Card,
  CopyButton,
  Spinner,
  ui,
} from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace-alerts.module.css";

function checkedView(value: NativeTelegramView) {
  if (typeof value?.available !== "boolean")
    throw new Error("Telegram could not load. Try again.");
  return value;
}

export function NativeTelegram({ context }: { context: WorkspaceContext }) {
  const [view, setView] = useState<NativeTelegramView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [readVersion, setReadVersion] = useState(0);
  const generation = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setView(null);
    setConfirmed(false);
    setError("");
    setBusy(false);
    setLoading(true);
    readSupport(
      (signal) => readNativeTelegram(context.room, signal),
      controller.signal,
    )
      .then((value) => {
        if (generation.current === current) setView(checkedView(value));
      })
      .catch((reason) => {
        if (generation.current === current && !controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Telegram could not load. Try again.",
          );
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current = current + 1;
      controller.abort();
      activeRead.current?.abort();
    };
  }, [context.room, context.account, context.revision, readVersion]);
  if (!view)
    return (
      <Card
        title="Telegram replies"
        description="Bring handed-off cases to your Telegram group."
      >
        {loading ? (
          <p role="status">
            <Spinner /> Loading Telegram.
          </p>
        ) : (
          <>
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
            <button
              className="button"
              onClick={() => setReadVersion((value) => value + 1)}
            >
              Retry
            </button>
          </>
        )}
      </Card>
    );
  if (view.available === false) return null;
  const processing = view.status === "preparing" || view.status === "approving";
  async function act(op?: "prepare" | "approve" | "disconnect") {
    const current = generation.current;
    const controller = op ? undefined : new AbortController();
    if (controller) activeRead.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = op
        ? await changeNativeTelegram(
            context.account,
            context.room,
            op,
            view?.approvalId ?? undefined,
          )
        : await readSupport(
            (signal) => readNativeTelegram(context.room, signal),
            controller!.signal,
          );
      if (generation.current === current) {
        setView(checkedView(next));
        setConfirmed(false);
      }
    } catch (reason) {
      if (generation.current === current) {
        if (
          !op &&
          reason instanceof CommunityApiError &&
          [401, 403, 404].includes(reason.status)
        )
          setView(null);
        setError(
          reason instanceof Error
            ? reason.message
            : "Telegram could not connect. Try again.",
        );
      }
    } finally {
      if (activeRead.current === controller) activeRead.current = null;
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <Card
      title="Telegram replies"
      description="Bring handed-off cases to your Telegram group."
    >
      <p className={styles.note}>
        Group members can read case summaries. Group administrators can reply as
        your team.
      </p>
      {view.status === "active" ? (
        <Badge>{view.group ?? "Connected"}</Badge>
      ) : view.status === "paused" ? (
        <Callout tone="warning">
          Connection paused. Disconnect and connect again.
        </Callout>
      ) : processing ? (
        <p role="status">
          <Spinner />{" "}
          {view.status === "preparing"
            ? "Preparing connection."
            : "Approving connection."}
        </p>
      ) : view.status === "pairing" ? (
        <>
          <p className={styles.note}>
            Add Templ to your group, then check the connection. The code expires
            after 24 hours.
          </p>
          <p className={styles.note}>
            Make Templ a group administrator so it can check who may reply.
          </p>
          {view.invite && (
            <a
              className="button"
              href={view.invite}
              target="_blank"
              rel="noopener noreferrer"
            >
              Add Templ
            </a>
          )}
          {view.code && (
            <>
              <p className={styles.note}>
                Already added? Send this command in the group.
              </p>
              <code className={styles.secret}>
                /start@usetempl_bot {view.code}
              </code>
              <CopyButton
                value={`/start@usetempl_bot ${view.code}`}
                label="Copy command"
              />
            </>
          )}
          {view.group && <p className={styles.note}>Group: {view.group}</p>}
        </>
      ) : null}
      {view.status === "disconnected" ||
      (view.status === "pairing" && view.group) ? (
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {view.status === "disconnected"
            ? "I approve Team access for this connection."
            : "I approve this group and its administrators."}
        </label>
      ) : null}
      <div className={styles.actions}>
        {view.status === "disconnected" ? (
          <button
            className="button"
            disabled={busy || !confirmed}
            onClick={() => void act("prepare")}
          >
            Connect Telegram
          </button>
        ) : view.status === "pairing" && view.group ? (
          <button
            className="button"
            disabled={busy || !confirmed}
            onClick={() => void act("approve")}
          >
            Approve group
          </button>
        ) : view.status !== "active" && view.status !== "paused" ? (
          <button className="button" disabled={busy} onClick={() => void act()}>
            {view.status === "pairing" ? "Check group" : "Refresh"}
          </button>
        ) : null}
        {view.status !== "disconnected" && (
          <button
            className="button"
            disabled={busy}
            onClick={() => void act("disconnect")}
          >
            Disconnect
          </button>
        )}
      </div>
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
    </Card>
  );
}
