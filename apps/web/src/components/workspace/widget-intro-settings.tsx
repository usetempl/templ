"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useEffect, useId, useRef, useState } from "react";
import { communityFetch, roomPath } from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { trackEvent } from "@/lib/analytics";
import { Card, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import controls from "@/components/ui/design-system.module.css";
import { UnsavedChanges } from "./unsaved-changes";

type Settings = {
  prompts?: string[] | null;
  replyHours?: number;
  options?: { widgetIntro?: boolean };
};

export function WidgetIntroSettings({
  context,
}: {
  context: WorkspaceContext;
}) {
  const { room, account } = context;
  const available =
    canManageWorkspace({
      isManager: context.manager,
      permissions: context.state?.viewer?.permissions,
    }) && context.state?.features?.widgetIntro === true;
  const scope = `${room}:${account ?? "signed-out"}:${available}`;
  const current = useRef(scope);
  current.current = scope;
  const pending = useRef<AbortController>(null);
  const id = useId();
  const [loaded, setLoaded] = useState<{ scope: string; available: boolean }>();
  const [questions, setQuestions] = useState("");
  const [useAppQuestions, setUseAppQuestions] = useState(true);
  const [hours, setHours] = useState("");
  const [baseline, setBaseline] = useState("");
  const [attempt, setAttempt] = useState(0);
  const value = JSON.stringify({
    questions: useAppQuestions
      ? null
      : questions
          .split(/\r?\n/)
          .map((text) => text.trim())
          .filter(Boolean),
    hours: hours.trim(),
  });
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState<string>();
  const busy = saving === scope;
  const [feedback, setFeedback] = useState<{
    scope: string;
    error?: string;
    notice?: string;
  }>();
  useEffect(() => {
    if (!available)
      return () => {
        if (current.current === scope) current.current = "";
      };
    const controller = new AbortController();
    void communityFetch<Settings>(
      roomPath(room, "widget"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setQuestions((data.prompts ?? []).join("\n"));
        setUseAppQuestions(data.prompts == null);
        setHours(data.replyHours == null ? "" : String(data.replyHours));
        setBaseline(
          JSON.stringify({
            questions: data.prompts ?? null,
            hours: data.replyHours == null ? "" : String(data.replyHours),
          }),
        );
        setConfirmed(false);
        setLoaded({ scope, available: data.options?.widgetIntro === true });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFeedback({ scope, error: "Could not load the widget intro." });
      });
    return () => {
      controller.abort();
      pending.current?.abort();
      if (current.current === scope) current.current = "";
    };
  }, [room, scope, available, attempt]);
  if (!available || (loaded?.scope === scope && !loaded.available)) return null;
  const ready = loaded?.scope === scope;
  const message = feedback?.scope === scope ? feedback : undefined;
  const dirty = ready && value !== baseline;
  async function save() {
    const custom = questions
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter(Boolean);
    const replyHours = hours.trim() ? Number(hours) : null;
    if (
      !useAppQuestions &&
      (custom.length > 4 || custom.some((text) => [...text].length > 80))
    ) {
      setFeedback({
        scope,
        error: "Add up to 4 questions, each within 80 characters.",
      });
      return;
    }
    if (
      replyHours !== null &&
      (!Number.isInteger(replyHours) || replyHours < 1 || replyHours > 168)
    ) {
      setFeedback({
        scope,
        error: "Choose a reply time from 1 to 168 hours, or leave it blank.",
      });
      return;
    }
    if (!confirmed || !ready || !dirty || busy) return;
    setSaving(scope);
    setFeedback(undefined);
    const controller = new AbortController();
    pending.current = controller;
    try {
      const data = await chatMutation<Settings>(
        account as never,
        roomPath(room, "widget"),
        {
          prompts: useAppQuestions ? null : custom,
          replyHours,
          confirmed: true,
        },
        () => {
          if (current.current !== scope)
            throw new Error("The workspace changed. Review the intro again.");
        },
        controller.signal,
      );
      if (current.current !== scope) return;
      setQuestions((data.prompts ?? []).join("\n"));
      setUseAppQuestions(data.prompts == null);
      setHours(data.replyHours == null ? "" : String(data.replyHours));
      setBaseline(
        JSON.stringify({
          questions: data.prompts ?? null,
          hours: data.replyHours == null ? "" : String(data.replyHours),
        }),
      );
      setConfirmed(false);
      setFeedback({ scope, notice: "Widget intro saved." });
      trackEvent("widget_intro_saved");
    } catch (reason) {
      trackEvent("widget_intro_failed");
      if (current.current === scope)
        setFeedback({
          scope,
          error:
            reason instanceof Error
              ? reason.message
              : "Could not save the widget intro.",
        });
    } finally {
      if (current.current === scope) setSaving(undefined);
    }
  }
  return (
    <Card title="Widget intro">
      <UnsavedChanges dirty={dirty} />
      <div className={styles.stack}>
        {!ready && !message?.error && (
          <p role="status">
            <Spinner /> Loading intro…
          </p>
        )}
        {ready && (
          <>
            <label className={ui.check}>
              <input
                type="checkbox"
                className={controls.checkbox}
                checked={useAppQuestions}
                disabled={busy}
                onChange={(event) => {
                  setUseAppQuestions(event.target.checked);
                  setConfirmed(false);
                }}
              />
              Use questions set by the app
            </label>
            <div>
              <label className={ui.fieldLabel} htmlFor={`${id}-questions`}>
                Suggested questions
              </label>
              <textarea
                id={`${id}-questions`}
                className={controls.input}
                rows={4}
                value={questions}
                disabled={busy || useAppQuestions}
                aria-describedby={`${id}-questions-help`}
                onChange={(event) => {
                  setQuestions(event.target.value);
                  setConfirmed(false);
                }}
              />
              <p id={`${id}-questions-help`} className={styles.small}>
                Add 1 question per line, up to 4. Each can have 80 characters.
                These replace questions set by your app. Leave blank to hide
                them. Never ask for recovery phrases or private keys.
              </p>
            </div>
            <div>
              <label className={ui.fieldLabel} htmlFor={`${id}-hours`}>
                Usual reply time in hours
              </label>
              <input
                id={`${id}-hours`}
                className={controls.input}
                type="number"
                min={1}
                max={168}
                step={1}
                value={hours}
                disabled={busy}
                aria-describedby={`${id}-hours-help`}
                onChange={(event) => {
                  setHours(event.target.value);
                  setConfirmed(false);
                }}
              />
              <p id={`${id}-hours-help`} className={styles.small}>
                Optional. The intro says “We usually reply within {hours || "N"}{" "}
                hours”. Choose a time your team can meet. Leave blank to hide
                the line.
              </p>
            </div>
            <label className={ui.check}>
              <input
                type="checkbox"
                className={controls.checkbox}
                checked={confirmed}
                disabled={busy || !dirty}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I approve these questions and reply time for everyone using the
              widget.
            </label>
            <button
              type="button"
              className={`${controls.button} ${controls.primary}`}
              disabled={busy || !confirmed || !dirty}
              onClick={() => void save()}
            >
              {busy && <Spinner />} Save intro
            </button>
          </>
        )}
        {(message?.notice || message?.error) && (
          <p
            role={message.error ? "alert" : "status"}
            className={message.error ? styles.error : styles.status}
          >
            {message.error || message.notice}
          </p>
        )}
        {!ready && message?.error && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setFeedback(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        )}
      </div>
    </Card>
  );
}
