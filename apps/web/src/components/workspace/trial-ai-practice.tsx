"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Field, ui } from "@/components/ui/ui";
import { chatMutation } from "@/lib/chat-api";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./knowledge-sources.module.css";

type Practice = { remaining: number; answer?: string | null };

export function TrialAiPractice({ context }: { context: WorkspaceContext }) {
  const path = roomPath(context.room, "conversations/knowledge/practice");
  const [value, setValue] = useState<Practice>();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const lastAttempt = useRef<{ question: string; requestId: string } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    communityFetch<Practice>(path, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Your practice questions could not load.");
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [path, refresh]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (
      !context.account ||
      request.current ||
      !value?.remaining ||
      !question.trim()
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    const text = question.trim();
    if (lastAttempt.current?.question !== text) {
      lastAttempt.current = { question: text, requestId: crypto.randomUUID() };
    }
    setBusy(true);
    setError("");
    try {
      const result = await chatMutation<Practice>(
        context.account,
        path,
        lastAttempt.current,
        undefined,
        controller.signal,
      );
      lastAttempt.current = null;
      if (!controller.signal.aborted) setValue(result);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(
          reason instanceof Error
            ? reason.message
            : "The question could not be answered.",
        );
        // A dropped connection can hide a successful submission. Reuse its ID
        // until the server confirms whether it already counted the question.
        if (reason instanceof CommunityApiError && reason.status < 500)
          lastAttempt.current = null;
        const quota = await communityFetch<Practice>(
          path,
          undefined,
          controller.signal,
        ).catch(() => null);
        if (quota && !controller.signal.aborted) setValue(quota);
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <form
      className={`${styles.sourceForm} ${styles.practice}`}
      aria-label="Try your AI"
      onSubmit={ask}
    >
      <h3>Try your AI</h3>
      <div className={styles.sourceEntry}>
        <Field label="Practice question">
          <input
            className={ui.input}
            value={question}
            maxLength={800}
            disabled={busy}
            onChange={(event) => {
              setQuestion(event.target.value);
              setError("");
              setValue(
                (previous) => previous && { remaining: previous.remaining },
              );
            }}
          />
        </Field>
        <button
          className="button"
          disabled={!question.trim() || !value?.remaining || busy}
        >
          {busy ? "Checking your docs…" : "Ask AI"}
        </button>
      </div>
      <small>
        Only your team sees the answer.
        {value &&
          ` ${value.remaining} free ${value.remaining === 1 ? "question" : "questions"} left.`}
      </small>
      {error && (
        <p role="alert">
          {error}{" "}
          {!value && (
            <button
              type="button"
              className="button small secondary"
              onClick={() => {
                setError("");
                setRefresh((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {value?.answer !== undefined && (
        <p role="status">
          {value.answer ??
            "AI would ask your team for help with this question."}
        </p>
      )}
    </form>
  );
}
