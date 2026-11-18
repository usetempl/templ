"use client";

/** Widget sign-in settings a manager changes:
 * remembered sign-in with "Sign out all members", and the visitor check for
 * guests. The worker returns the features this workspace can use.
 * Every save needs the manager's valid wallet session, like the rest of the
 * widget settings, and lands in the workspace's activity log. */
import { useEffect, useRef, useState } from "react";
import { IconCircleCheck } from "@tabler/icons-react";
import { communityFetch, roomPath } from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { Card, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

type SessionSettings = {
  remember?: boolean;
  guestCheck?: "off" | "turnstile";
  options?: { remember?: boolean; guestCheck?: boolean };
};

export function WidgetSessionSettings({
  context,
}: {
  context: WorkspaceContext;
}) {
  const { room, account } = context;
  const current = useRef(room);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [rememberChoice, setRememberChoice] = useState<boolean | null>(null);
  const [checkChoice, setCheckChoice] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    current.current = room;
    void communityFetch<SessionSettings>(
      roomPath(room, "widget"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setSettings(data);
          setError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Widget sign-in settings could not load.");
      });
    return () => controller.abort();
  }, [room, account, attempt]);
  const showRemember = settings?.options?.remember === true;
  const showCheck =
    settings?.options?.guestCheck === true ||
    settings?.guestCheck === "turnstile";
  if (!settings)
    return (
      <Card title="Widget sign-in">
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
  if (!showRemember && !showCheck) return null;
  function save(action: string, body: Record<string, unknown>, done: string) {
    setBusy(action);
    setNotice("");
    setError("");
    void chatMutation<SessionSettings>(
      account as never,
      roomPath(room, "widget"),
      {
        ...body,
        confirmed: true,
      },
    )
      .then((data) => {
        if (current.current !== room) return;
        setSettings((before) => ({ ...before, ...data }));
        if (action === "remember") setRememberChoice(null);
        if (action === "check") setCheckChoice(null);
        setAsking(false);
        setNotice(done);
      })
      .catch(
        (reason) =>
          current.current === room &&
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not save widget settings.",
          ),
      )
      .finally(() => {
        if (current.current === room) setBusy(null);
      });
  }
  const savedRemember = settings.remember !== false;
  const savedCheck = settings.guestCheck === "turnstile";
  const remember = rememberChoice ?? savedRemember;
  const checking = checkChoice ?? savedCheck;
  return (
    <>
      <UnsavedChanges
        dirty={remember !== savedRemember || checking !== savedCheck}
      />
      {showRemember && (
        <Card
          title="Keep users signed in"
          description="Users stay signed in with their wallet for 30 days. They can sign out sooner."
          footer={
            asking ? (
              <>
                <p className={styles.small}>
                  Everyone signed in through your widget will need to sign in
                  again.
                </p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setAsking(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy !== null}
                  onClick={() =>
                    save(
                      "end",
                      { endSessions: true },
                      "All users are signed out of your widget.",
                    )
                  }
                >
                  {busy === "end" && <Spinner />}
                  Sign out all users
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button secondary"
                disabled={busy !== null}
                onClick={() => setAsking(true)}
              >
                Sign out all users
              </button>
            )
          }
        >
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={remember}
              disabled={busy !== null}
              onChange={(event) => {
                setRememberChoice(event.target.checked);
                setNotice("");
              }}
            />
            Keep users signed in
          </label>
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={busy !== null || remember === savedRemember}
              onClick={() =>
                save(
                  "remember",
                  { remember },
                  remember
                    ? "Users stay signed in."
                    : "Users sign in each visit.",
                )
              }
            >
              Save sign-in setting
            </button>
          </div>
        </Card>
      )}
      {showCheck && (
        <Card
          title="Check visitors without a wallet"
          description={
            settings?.options?.guestCheck
              ? undefined
              : checking
                ? "Templ has paused this check. New visitors cannot start a case until it returns or you turn it off."
                : "Templ has paused this check. You cannot turn it on now."
          }
        >
          <div className={styles.stack} style={{ gap: 10 }}>
            <ul className={styles.small}>
              <li>
                Before their first message, visitors pass a Cloudflare Turnstile
                check.
              </li>
              <li>Wallet sign-ins skip it.</li>
              <li>
                Visitors who come back keep their chat without a new check.
              </li>
            </ul>
            <label className={ui.check}>
              <input
                type="checkbox"
                checked={checking}
                disabled={
                  busy !== null ||
                  (!savedCheck && !settings?.options?.guestCheck)
                }
                onChange={(event) => {
                  setCheckChoice(event.target.checked);
                  setNotice("");
                }}
              />
              Check visitors without a wallet
            </label>
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={busy !== null || checking === savedCheck}
                onClick={() =>
                  save(
                    "check",
                    { guestCheck: checking ? "turnstile" : "off" },
                    checking
                      ? "New visitors pass the check first."
                      : "The check is off.",
                  )
                }
              >
                Save visitor check
              </button>
            </div>
          </div>
        </Card>
      )}
      {(notice || error) && (
        <p
          className={error ? styles.error : styles.status}
          role={error ? "alert" : "status"}
        >
          {!error && <IconCircleCheck size={15} aria-hidden="true" />}{" "}
          {error || notice}
        </p>
      )}
    </>
  );
}
