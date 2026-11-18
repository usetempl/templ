"use client";

import { useEffect, useState } from "react";
import {
  GOLDEN_LIMITS,
  type GoldenCaseView,
  type GoldenGate,
  type GoldenGateState,
  type GoldenProblem,
  type GoldenResult,
} from "@templ/chat/golden-set";
import type { ManagedAgentView } from "@templ/chat/managed-agent";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { Badge, Card, Spinner } from "@/components/ui/ui";
import type { WorkspaceContext } from "@/components/workspace/support-workspace";
import styles from "@/components/workspace/workspace.module.css";
import quality from "@/components/workspace/workspace-quality.module.css";

/** Words on this card. The cases live under Reports, in Answer reviews; this
 * card only shows how Templ AI does on them and asks for a check. */
export const GOLDEN_COPY = {
  title: "Golden set check",
  points: [
    "Templ AI answers your golden set after every change to its sources, profile, prompt or model.",
    "Templ refuses a change that fails a case it passed before.",
    "Until every case passes, replies to users wait as drafts.",
  ],
  states: {
    none: "No golden cases yet. Replies wait as drafts.",
    pending: "Not checked since the last change.",
    passed: "Every case passed.",
    failed: "A case failed. Replies wait as drafts.",
  } satisfies Record<GoldenGateState, string>,
  empty: "Add cases to the golden set in Reports, under Answer reviews.",
  openReviews: "Open Answer reviews",
  reviewsUnavailable:
    "Golden cases come from Answer reviews. Answer reviews aren't available in this workspace.",
  loadFailed: "The golden set could not load.",
  retry: "Try again",
  count: (n: number) => (n === 1 ? "1 golden case." : `${n} golden cases.`),
  limit: `Templ AI checks the first ${GOLDEN_LIMITS.casesPerRun} cases you saved.`,
  run: "Check again",
  queued: "Checking now.",
  running: "A check is running.",
  error: "The check didn't start. Try again.",
  lastRun: (date: string) => `Last checked ${date}.`,
  failed: "Failed:",
  problems: {
    "no-output": "No usable answer",
    "wrong-action": "Wrong handling",
    facts: "Stated a number the case doesn't have",
    scope: "Left out a phrase it must mention",
    evidence: "Gave a number without citing evidence",
    "next-step":
      "Asked for a key, signature or transaction, or linked outside its sources",
    unsafe: "Failed the safety check",
  } satisfies Record<GoldenProblem, string>,
} as const;

type GoldenView = {
  cases: GoldenCaseView[];
  state: GoldenGateState;
  running: boolean;
  last: { at: string; results: GoldenResult[]; gate: GoldenGate } | null;
};
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function GoldenSetPanel({
  context,
  summary,
}: {
  context: WorkspaceContext;
  summary: ManagedAgentView["golden"];
}) {
  const { room, account } = context;
  const [view, setView] = useState<GoldenView | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once this panel queues a check, so a list read that was already in
  // flight cannot re-enable the button.
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // A failed list read keeps the summary counts and offers a retry.
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const reviews = context.state?.features?.quality === true;
  useEffect(() => {
    const controller = new AbortController();
    communityFetch<GoldenView>(
      roomPath(room, "conversations/managed/golden"),
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        setView(next);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [room, account, context.revision, retry]);
  async function check() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice(GOLDEN_COPY.queued);
    try {
      await chatMutation(
        account,
        roomPath(room, "conversations/managed/golden"),
        { action: "run" },
      );
      setStarted(true);
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : GOLDEN_COPY.error);
    } finally {
      setBusy(false);
    }
  }
  const state = view?.state ?? summary.state;
  const count = view?.cases.length ?? summary.cases;
  const failed = (view?.last?.results ?? []).filter((result) => !result.pass);
  const turn = new Map(
    (view?.cases ?? []).map((item) => [item.id, item.firstTurn]),
  );
  return (
    <Card
      title={GOLDEN_COPY.title}
      actions={
        <Badge
          tone={
            state === "passed"
              ? "brand"
              : state === "failed"
                ? "danger"
                : "neutral"
          }
          dot
        >
          {GOLDEN_COPY.states[state]}
        </Badge>
      }
      footer={
        count > 0 ? (
          <button
            type="button"
            className="button secondary"
            disabled={busy || started || view?.running === true}
            onClick={() => void check()}
          >
            {busy && <Spinner />}
            {GOLDEN_COPY.run}
          </button>
        ) : undefined
      }
    >
      <div className={styles.formGrid}>
        <ul className={quality.points}>
          {GOLDEN_COPY.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        {loadFailed && (
          <p className={styles.error} role="alert">
            {GOLDEN_COPY.loadFailed}{" "}
            <button
              type="button"
              className={styles.inlineLink}
              onClick={() => setRetry((value) => value + 1)}
            >
              {GOLDEN_COPY.retry}
            </button>
          </p>
        )}
        {count === 0 && !reviews ? (
          <p className={styles.muted}>{GOLDEN_COPY.reviewsUnavailable}</p>
        ) : count === 0 ? (
          <p className={styles.muted}>
            {GOLDEN_COPY.empty}{" "}
            <button
              type="button"
              className={styles.inlineLink}
              onClick={() => context.go("quality", null, "answer-reviews")}
            >
              {GOLDEN_COPY.openReviews}
            </button>
          </p>
        ) : (
          <p className={styles.muted}>
            {GOLDEN_COPY.count(count)}
            {count >= GOLDEN_LIMITS.casesPerRun && ` ${GOLDEN_COPY.limit}`}
            {view?.last && ` ${GOLDEN_COPY.lastRun(when(view.last.at))}`}
          </p>
        )}
        {failed.length > 0 && (
          <div>
            <p className={styles.muted}>{GOLDEN_COPY.failed}</p>
            <ul className={quality.points} aria-label={GOLDEN_COPY.failed}>
              {failed.map((result) => (
                <li key={result.id}>
                  <div>{turn.get(result.id) ?? result.id}</div>
                  <div className={styles.muted}>
                    {result.problems
                      .map((problem) => GOLDEN_COPY.problems[problem])
                      .join(", ")}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {view?.running && !notice && (
          <p className={styles.status}>{GOLDEN_COPY.running}</p>
        )}
        {notice && (
          <p className={styles.status} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
