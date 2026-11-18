"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  REPLY_LABELS,
  REPLY_LABEL_TEXT,
  type ReplyLabel,
  type SupportCaseQualityView,
} from "@templ/chat/support-quality";
import { labelReply, readCaseQuality } from "@/lib/knowledge-client";
import { QUALITY_COPY as c } from "@/lib/copy/quality";
import { Badge, Spinner } from "@/components/ui/ui";
import { EvalDialog, ReviewCard } from "./workspace-quality";
import { LearnedFaqCorrection } from "./learned-faq-correction";
import styles from "./workspace-quality.module.css";
import panel from "../case-panels.module.css";
import details from "../team-conversations.module.css";

/** A team-side reply the panel can label. */
export type QualityReply = {
  id: number;
  text: string;
  createdAt: string;
  /** The author's name as the thread shows it. */
  author: string;
  bot: boolean;
};
const message = (reason: unknown) => (reason instanceof Error ? reason.message : c.error);
/** Replies the panel lists, newest last. */
const SHOWN = 8;

/** Answer quality in the request details, for people on the team: a
 * "Review this request" card while the request is in the review queue, and
 * a label control on each team reply of the latest requests. The routes
 * check the viewer's access on every call; a member or a widget session
 * never reaches this panel's data. */
export function ThreadQuality({
  room,
  account,
  thread,
  replies,
  names,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  replies: QualityReply[];
  /** A team member's name for "Labeled by". */
  names: (principal: string) => string;
}) {
  const [cases, setCases] = useState<SupportCaseQualityView[] | null>(null);
  const scope = `${room}:${account ?? ""}:${thread}`;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [learningReviewAvailable, setLearningReviewAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    readCaseQuality(room, thread)
      .then((data) => {
        if (!live) return;
        setCases(Array.isArray(data.cases) ? data.cases : []);
        setLearningReviewAvailable(data.learningReviewAvailable === true);
        setLoadedFor(scope);
        setError(null);
      })
      .catch((reason) => {
        if (!live) return;
        setCases(null);
        setLearningReviewAvailable(false);
        setLoadedFor(scope);
        setError({ scope, text: message(reason) });
      });
    return () => {
      live = false;
    };
  }, [room, account, thread, tick, scope]);
  if (loadedFor !== scope || !cases)
    return error?.scope === scope ? (
      <section className={panel.panels} aria-label={c.panelTitle}>
        <div className={details.detailSection}>
          <h3>{c.panelTitle}</h3>
          <p className={styles.error} role="alert">
            {error.text}
          </p>
        </div>
      </section>
    ) : null;
  const opened = cases.map((entry) => Date.parse(entry.openedAt));
  const oldest = opened.length ? Math.min(...opened) : Infinity;
  const labelable = replies.filter((reply) => Date.parse(reply.createdAt) >= oldest).slice(-SHOWN);
  const labels = new Map(
    cases.flatMap((entry) => entry.labels.map((label) => [label.message, label] as const)),
  );
  const reviews = cases.filter(
    (entry) => entry.review && (entry.review.state === "queued" || entry.review.state === "in-review"),
  );
  const target = { room, account };
  return (
    <section className={panel.panels} aria-label={c.panelTitle}>
      <div className={details.detailSection}>
        <h3>{c.panelTitle}</h3>
        <p className={styles.note}>{c.panelNote}</p>
        {reviews.map((entry) => (
          <div key={entry.seq}>
            <h4 className={styles.label}>{c.panelReview}</h4>
            <ReviewCard
              context={target}
              thread={thread}
              seq={entry.seq}
              showLabels={false}
              onSaved={() => setTick((n) => n + 1)}
            />
          </div>
        ))}
        {labelable.length === 0 ? (
          <p className={styles.note}>{c.panelEmpty}</p>
        ) : (
          <ul className={styles.replies}>
            {labelable.map((reply) => (
              <ReplyLabelRow
                key={reply.id}
                room={room}
                account={account}
                thread={thread}
                reply={reply}
                current={labels.get(reply.id) ?? null}
                learningReviewAvailable={learningReviewAvailable}
                labeledBy={names}
                onChanged={(view) =>
                  setCases((list) =>
                    (list ?? []).map((entry) => (entry.seq === view.seq ? view : entry)),
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ReplyLabelRow({
  room,
  account,
  thread,
  reply,
  current,
  learningReviewAvailable,
  labeledBy,
  onChanged,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  reply: QualityReply;
  current: SupportCaseQualityView["labels"][number] | null;
  learningReviewAvailable: boolean;
  labeledBy: (principal: string) => string;
  onChanged: (view: SupportCaseQualityView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ReplyLabel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [evalOpen, setEvalOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const groupId = useId();
  const firstChip = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) firstChip.current?.focus();
  }, [open]);
  function close() {
    setOpen(false);
    opener.current?.focus();
  }
  function toggle(label: ReplyLabel) {
    setChosen((list) =>
      label === "correct"
        ? list.includes("correct")
          ? []
          : [label]
        : list.includes(label)
          ? list.filter((item) => item !== label)
          : [...list.filter((item) => item !== "correct"), label],
    );
  }
  async function save(labels: ReplyLabel[]) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { quality } = await labelReply(room, account, thread, reply.id, labels);
      onChanged(quality);
      setNotice(labels.length ? c.labelSaved : c.labelCleared);
      close();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={styles.reply}>
      <span className={styles.replyHead}>{c.replyBy(reply.bot ? c.aiAgent : reply.author)}</span>
      <p className={styles.excerpt}>{reply.text}</p>
      {current && (
        <span className={styles.badges} title={c.labeledBy(labeledBy(current.by))}>
          {current.labels.map((label) => (
            <Badge key={label} tone={label === "correct" ? "brand" : "warning"}>
              {REPLY_LABEL_TEXT[label]}
            </Badge>
          ))}
        </span>
      )}
      <div className={styles.actions}>
        <button
          ref={opener}
          type="button"
          className="button small secondary"
          aria-expanded={open}
          aria-controls={groupId}
          onClick={() => {
            if (open) return close();
            setChosen(current?.labels ?? []);
            setNotice("");
            setOpen(true);
          }}
        >
          {c.label}
        </button>
        {current && !open && (
          <button
            type="button"
            className="button small secondary"
            aria-expanded={evalOpen}
            onClick={() => setEvalOpen(!evalOpen)}
          >
            {c.saveAsEval}
          </button>
        )}
      </div>
      {open && (
        <div
          id={groupId}
          role="group"
          aria-label={c.labelsGroup}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className={styles.chips}>
            {REPLY_LABELS.map((label, index) => (
              <button
                key={label}
                ref={index === 0 ? firstChip : undefined}
                type="button"
                className={styles.chip}
                aria-pressed={chosen.includes(label)}
                onClick={() => toggle(label)}
              >
                {REPLY_LABEL_TEXT[label]}
              </button>
            ))}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className="button small"
              disabled={busy || chosen.length === 0}
              onClick={() => void save(chosen)}
            >
              {busy && <Spinner />}
              {c.saveLabel}
            </button>
            {current && (
              <button type="button" className="button small secondary" disabled={busy} onClick={() => void save([])}>
                {c.clearLabel}
              </button>
            )}
            <button type="button" className="button small secondary" disabled={busy} onClick={close}>
              {c.cancel}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className={styles.status} role="status">
          {notice}
        </p>
      )}
      {learningReviewAvailable && current?.bot && current.labels.some((label) => ["wrong-facts", "wrong-product", "wrong-metric-or-window", "unsupported-claim", "unsafe"].includes(label)) && (
        <LearnedFaqCorrection key={`${room}:${account}:${thread}:${reply.id}`} room={room} account={account} thread={thread} message={reply.id} />
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {evalOpen && (
        <EvalDialog context={{ room, account }} thread={thread} message={reply.id} onDone={() => setEvalOpen(false)} />
      )}
    </li>
  );
}
