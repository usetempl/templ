"use client";

/** The manager's safety line: one sentence in the widget's footer, "We
 * never DM you first.", off until the manager turns it on. Saving needs the
 * manager's valid wallet session, like the rest of the widget settings, and
 * lands in the workspace's activity log. */
import { useEffect, useRef, useState } from "react";
import { IconCircleCheck } from "@tabler/icons-react";
import { communityFetch, roomPath } from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { Card, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export function WidgetSafetyLine({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const current = useRef(room);
  const [on, setOn] = useState<boolean | null>(null);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    current.current = room;
    void communityFetch<{ safetyLine?: boolean }>(
      roomPath(room, "widget"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setOn(data.safetyLine === true);
          setError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("The safety line could not load.");
      });
    return () => controller.abort();
  }, [room, account, attempt]);
  if (on === null)
    return (
      <Card title="Say you never DM first">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </Card>
    );
  const selected = choice ?? on;
  const dirty = selected !== on;
  function save(next: boolean) {
    setBusy(true);
    setNotice("");
    setError("");
    void chatMutation<{ safetyLine?: boolean }>(
      account as never,
      roomPath(room, "widget"),
      { safetyLine: next, confirmed: true },
    )
      .then((data) => {
        if (current.current !== room) return;
        setOn(data.safetyLine === true);
        setChoice(null);
        setNotice(
          data.safetyLine ? "The widget shows the line." : "The line is off.",
        );
      })
      .catch(
        (reason) =>
          current.current === room &&
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not save the safety line.",
          ),
      )
      .finally(() => {
        if (current.current === room) setBusy(false);
      });
  }
  return (
    <Card title="Say you never DM first">
      <UnsavedChanges dirty={dirty} />
      <div className={styles.stack} style={{ gap: 10 }}>
        <ul className={styles.small}>
          <li>Scammers pose as support in DMs.</li>
          <li>
            This adds “We never DM you first.” to the widget, next to the
            warning about recovery phrases.
          </li>
          <li>Turn it on only if your team never starts a DM.</li>
        </ul>
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={selected}
            disabled={busy}
            onChange={(event) => {
              setChoice(event.target.checked);
              setNotice("");
            }}
          />
          {busy && <Spinner />}
          Show “We never DM you first.”
        </label>
        <div>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !dirty}
            onClick={() => save(selected)}
          >
            Save safety line
          </button>
        </div>
        {(notice || error) && (
          <p
            className={error ? styles.error : styles.status}
            role={error ? "alert" : "status"}
          >
            {!error && <IconCircleCheck size={15} aria-hidden="true" />}{" "}
            {error || notice}
          </p>
        )}
      </div>
    </Card>
  );
}
