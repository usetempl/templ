"use client";

/** Frame mode in the widget settings: the frame
 * script a page loads in place of the widget file, and the manager's
 * switch that refuses the regular script. Shown only once frame mode passed
 * its hosted check (`iframeIsolationVerified`). Turning the switch on asks first and
 * needs the manager's valid wallet session; each change lands in the
 * workspace's activity log. */
import { useEffect, useRef, useState } from "react";
import { IconCircleCheck } from "@tabler/icons-react";
import {
  COMMUNITY_API,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { SITE } from "@/lib/site-environment";
import { currentWidgetAssets } from "@/lib/current-widget-assets";
import { Card, CopyBlock, CopyInline, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export const FRAME_MODE_COPY = {
  title: "Frame mode",
  points: [
    "Load the chat in a frame from Templ. Scripts on your website can't read the chat, a visitor's sign-in or their unsent drafts.",
    "Your page still holds the visitor's wallet. The frame can ask that wallet to sign only Templ's sign-in message for your domain.",
  ],
  snippet: "Frame script",
  toggle: "Require frame mode",
  help: "Turn this on after every page with the chat loads the frame script. Pages that still load the regular script stop showing the chat.",
  confirmTitle: "Require frame mode?",
  confirmBody: "Pages that load the regular script will stop showing the chat.",
  turnOn: "Turn on",
  cancel: "Cancel",
  saved: "Saved.",
} as const;

export function WidgetFrameMode({
  context,
  live = context.state?.features?.frameMode === true,
}: {
  context: WorkspaceContext;
  /** Frame mode passed its hosted check. */
  live?: boolean;
}) {
  const { room, account } = context;
  const current = useRef(room);
  const [required, setRequired] = useState<boolean | null>(null);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    setError("");
    current.current = room;
    void communityFetch<{ frameRequired?: boolean }>(
      roomPath(room, "widget"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setRequired(data.frameRequired === true);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Frame settings could not load.");
      });
    return () => controller.abort();
  }, [room, account, live, attempt]);
  const framehost = currentWidgetAssets.framehost;
  if (!live || !framehost) return null;
  if (required === null)
    return (
      <Card title={FRAME_MODE_COPY.title}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </Card>
    );
  const selected = choice ?? required;
  const dirty = selected !== required;
  function save(next: boolean) {
    setAsking(false);
    setBusy(true);
    setNotice("");
    setError("");
    void chatMutation<{ frameRequired?: boolean }>(
      account as never,
      roomPath(room, "widget"),
      { frameRequired: next, confirmed: true },
    )
      .then((data) => {
        if (current.current !== room) return;
        setRequired(data.frameRequired === true);
        setChoice(null);
        setNotice(FRAME_MODE_COPY.saved);
      })
      .catch(
        (reason) =>
          current.current === room &&
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not save frame mode.",
          ),
      )
      .finally(() => {
        if (current.current === room) setBusy(false);
      });
  }
  const snippet = `import { mountSupportWidget } from "${SITE.origin}${framehost.path}";

// The same options as the regular widget file.
const support = mountSupportWidget({
  workspace: "${context.id}",
  apiUrl: "${COMMUNITY_API}",
  provider, // the wallet provider your app already uses (EIP-1193)
});`;
  return (
    <Card title={FRAME_MODE_COPY.title}>
      <UnsavedChanges dirty={dirty} />
      <div className={styles.stack} style={{ gap: 10 }}>
        <ul className={styles.small}>
          {FRAME_MODE_COPY.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <CopyBlock
          label={FRAME_MODE_COPY.snippet}
          code={snippet}
          copyLabel="Copy frame script"
        />
        <div>
          <p className={styles.sectionTitle}>SHA-384</p>
          <CopyInline value={`sha384-${framehost.sha384}`} label="Copy" />
        </div>
        {asking ? (
          <div className={styles.stack} style={{ gap: 8 }} role="group">
            <strong>{FRAME_MODE_COPY.confirmTitle}</strong>
            <p className={styles.small}>{FRAME_MODE_COPY.confirmBody}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="button"
                onClick={() => save(true)}
              >
                {FRAME_MODE_COPY.turnOn}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setAsking(false);
                  setChoice(null);
                }}
              >
                {FRAME_MODE_COPY.cancel}
              </button>
            </div>
          </div>
        ) : (
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
            {FRAME_MODE_COPY.toggle}
          </label>
        )}
        {!asking && (
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !dirty}
              onClick={() => (selected ? setAsking(true) : save(false))}
            >
              Save frame mode
            </button>
          </div>
        )}
        <p className={styles.small}>{FRAME_MODE_COPY.help}</p>
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
