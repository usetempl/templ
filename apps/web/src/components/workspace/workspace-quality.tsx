"use client";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  GAP_SIGNAL_TEXT,
  QUALITY_LIMITS,
  REPLY_LABEL_TEXT,
  REVIEW_SKIP_REASONS,
  REVIEW_SKIP_TEXT,
  RUBRIC_ITEMS,
  RUBRIC_TEXT,
  TREND_DIMENSIONS,
  TREND_DIMENSION_TEXT,
  TREND_WINDOWS,
  weekStart,
  type GapSignal,
  type ReviewSkipReason,
  type Rubric,
  type RubricScore,
  type SupportAnswerReportItem,
  type SupportCaseQualityView,
  type SupportKnowledgeGaps,
  type SupportQualityOverview,
  type SupportReviewItem,
  type SupportTrends,
  type TrendDimension,
  type TrendWindow,
} from "@templ/chat/support-quality";
import type {
  EvalAction,
  EvalCaseSummary,
  EvalDraft,
  EvalRunView,
  PlaceholderKind,
} from "@templ/chat/support-eval";
import {
  evalAction,
  exportGoldenSet,
  labelReply,
  markAnswerReportReviewed,
  previewEval,
  saveEval,
  markGap,
  readAnswerReports,
  readCaseQuality,
  readEvalRuns,
  readEvals,
  readGaps,
  readQuality,
  readReviews,
  readTrends,
  reviewAction,
  saveQuality,
} from "@/lib/knowledge-client";
import {
  CHECK_TEXT,
  EVAL_STATE_TEXT,
  GAP_STATE_TEXT,
  PLACEHOLDER_TEXT,
  QUALITY_COPY as c,
  REVIEW_STATE_TEXT,
  checkResultText,
  reviewReasonText,
  trendKeyText,
} from "@/lib/copy/quality";
import { Badge, Card, Field, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import { UnsavedChanges, confirmWorkspaceNavigation } from "./unsaved-changes";
import { LearnedFaqCorrection } from "./learned-faq-correction";
import styles from "./workspace-quality.module.css";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : c.error;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
/** A trend week's Monday (UTC date), shown without a time zone shift. */
const week = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
/** A whole number within the range, or null for anything else. */
function wholeNumber(text: string, min: number, max: number): number | null {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** The Quality tab, for everyone on the team: the review queue, for the
 * owner and Admins the answers users reported, and for the manager and
 * support leads, recurring problems, knowledge gaps and eval cases. Each
 * route checks access again. */
export function QualityPage({ context }: { context: WorkspaceContext }) {
  const lead =
    context.manager ||
    context.state?.viewer?.permissions
      ?.map(String)
      .includes("manageSupport") === true;
  const admin = canManageWorkspace({
    isManager: context.manager,
    permissions: context.state?.viewer?.permissions,
  });
  return (
    <div className={styles.stack}>
      <ReviewsCard context={context} />
      {admin && context.state?.features?.aiAnswerReports === true && (
        <AnswerReportsCard context={context} />
      )}
      {lead && (
        <>
          <TrendsCard context={context} />
          <GapsCard context={context} />
          <EvalsCard context={context} />
        </>
      )}
    </div>
  );
}

type Room = WorkspaceContext["room"];
/** What the quality cards need from the workspace or the thread panel. */
export type QualityTarget = Pick<WorkspaceContext, "room" | "account">;
/** Loads one read for a room and an argument. `load` is a module-level
 * function, so the effect's dependencies are complete. A result shows only
 * for the room and argument it was read for. A retry after a failure shows
 * loading again; a refresh keeps the current result until the new one. */
function useLoad<T, A>(
  load: (room: Room, arg: A, signal: AbortSignal) => Promise<T>,
  room: Room,
  arg: A,
) {
  const [state, setState] = useState<{
    room: Room;
    arg: A;
    data?: T;
    error?: string;
  }>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    load(room, arg, controller.signal)
      .then(
        (data) => !controller.signal.aborted && setState({ room, arg, data }),
      )
      .catch(
        (reason) =>
          !controller.signal.aborted &&
          setState({ room, arg, error: message(reason) }),
      );
    return () => controller.abort();
  }, [load, room, arg, tick]);
  const current = state?.room === room && state.arg === arg ? state : undefined;
  const reload = useCallback(() => {
    setState((value) => (value?.error ? undefined : value));
    setTick((n) => n + 1);
  }, []);
  /** Shows a mutation's result as the saved state without another read. */
  const replace = useCallback(
    (data: T) => setState({ room, arg, data }),
    [room, arg],
  );
  return {
    data: current?.data,
    error: current?.error,
    loading: !current,
    reload,
    replace,
  };
}
const loadQuality = (room: Room, _arg: null, signal: AbortSignal) =>
  readQuality(room, signal);
const loadGaps = (room: Room, _arg: null, signal: AbortSignal) =>
  readGaps(room, undefined, signal);
const loadEvals = (room: Room, _arg: null, signal: AbortSignal) =>
  readEvals(room, {}, signal);
const loadRuns = (room: Room, _arg: null, signal: AbortSignal) =>
  readEvalRuns(room, signal);

/** A failed read: its error and a retry, in place of any empty state. */
function LoadFailed({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div>
      <p className={styles.error} role="alert">
        {error}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className="button small secondary"
          onClick={onRetry}
        >
          {c.retry}
        </button>
      </div>
    </div>
  );
}

function Status({ notice, error }: { notice?: string; error?: string }) {
  return (
    <>
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
    </>
  );
}

export function WorkspaceQuality({ context }: { context: WorkspaceContext }) {
  const overview = useLoad<SupportQualityOverview, null>(
    loadQuality,
    context.room,
    null,
  );
  if (!overview.data?.settings?.sampling)
    return (
      <Card title={c.qualityTitle} description={c.qualityDescription}>
        {overview.loading ? (
          <Spinner />
        ) : (
          <LoadFailed
            error={overview.error ?? c.error}
            onRetry={overview.reload}
          />
        )}
      </Card>
    );
  return (
    <QualityForm
      context={context}
      saved={overview.data}
      onSaved={(result) =>
        result?.settings?.sampling
          ? overview.replace(result)
          : overview.reload()
      }
    />
  );
}

/** Review settings, edited against the last saved overview. Numbers stay as
 * typed until Save checks them. */
function QualityForm({
  context,
  saved,
  onSaved,
}: {
  context: WorkspaceContext;
  saved: SupportQualityOverview;
  onSaved: (result: SupportQualityOverview) => void;
}) {
  const { room, account } = context;
  const manager = canManageWorkspace({
    isManager: context.manager,
    permissions: context.state?.viewer?.permissions,
  });
  const settings = saved.settings;
  const capMax = QUALITY_LIMITS.weeklyCapMax;
  const [percent, setPercent] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [agents, setAgents] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const value = {
    randomPercent: percent ?? String(settings.sampling.randomPercent),
    weeklyCap: cap ?? String(settings.sampling.weeklyCap),
    evalAgentAccess: agents ?? settings.evalAgentAccess,
  };
  const dirty =
    value.randomPercent !== String(settings.sampling.randomPercent) ||
    value.weeklyCap !== String(settings.sampling.weeklyCap) ||
    value.evalAgentAccess !== settings.evalAgentAccess;
  const randomPercent = wholeNumber(value.randomPercent, 0, 100);
  const weeklyCap = wholeNumber(value.weeklyCap, 1, capMax);
  const edited = () => {
    setNotice("");
    setError("");
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !dirty || !saved.canEdit || !manager) return;
    setChecked(true);
    if (randomPercent === null || weeklyCap === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveQuality(
        room,
        account,
        {
          sampling: { randomPercent, weeklyCap },
          evalAgentAccess: value.evalAgentAccess,
        },
        true,
      );
      onSaved(result);
      setPercent(null);
      setCap(null);
      setAgents(null);
      setChecked(false);
      setNotice(c.saved);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const canEdit = saved.canEdit === true;
  const percentError =
    checked && randomPercent === null ? c.percentInvalid : undefined;
  const capError =
    checked && weeklyCap === null ? c.capInvalid(capMax) : undefined;
  return (
    <form noValidate onSubmit={(event) => void save(event)}>
      <Card
        title={c.qualityTitle}
        description={c.qualityDescription}
        footer={
          canEdit ? (
            <button type="submit" className="button" disabled={busy || !dirty}>
              {busy && <Spinner />}
              {c.saveQuality}
            </button>
          ) : undefined
        }
      >
        <UnsavedChanges dirty={dirty} />
        <fieldset disabled={!canEdit || busy} className={styles.fields}>
          <Field label={c.randomPercent} error={percentError}>
            <input
              className={ui.input}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={value.randomPercent}
              aria-invalid={percentError ? true : undefined}
              onChange={(event) => {
                setPercent(event.target.value);
                edited();
              }}
            />
          </Field>
          <Field label={c.weeklyCap} error={capError}>
            <input
              className={ui.input}
              type="number"
              inputMode="numeric"
              min={1}
              max={capMax}
              step={1}
              value={value.weeklyCap}
              aria-invalid={capError ? true : undefined}
              onChange={(event) => {
                setCap(event.target.value);
                edited();
              }}
            />
          </Field>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={value.evalAgentAccess}
              disabled={!manager}
              onChange={(event) => {
                setAgents(event.target.checked);
                edited();
              }}
            />
            {c.evalAgentAccess}
          </label>
          <p className={styles.note}>{c.evalAgentHint}</p>
        </fieldset>
        {canEdit && (
          <div className={styles.actions}>
            <span className={styles.note}>{c.categoryInSettings}</span>
            <button
              type="button"
              className="button small secondary"
              onClick={() => context.go("settings", null, "case-settings")}
            >
              {c.openCaseSettings}
            </button>
          </div>
        )}
        <Status notice={notice} error={error} />
      </Card>
    </form>
  );
}

function ReviewsCard({ context }: { context: WorkspaceContext }) {
  const { room } = context;
  const [view, setView] = useState<"mine" | "open" | "done">("open");
  const [opened, setOpened] = useState<SupportReviewItem | null>(null);
  const reviews = useLoad(readReviews, room, view);
  const items = Array.isArray(reviews.data?.items) ? reviews.data.items : [];
  return (
    <Card title={c.reviewsTitle}>
      <div className={styles.tabs} role="tablist">
        {(["mine", "open", "done"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={view === name}
            className={`button small ${view === name ? "" : "secondary"}`}
            onClick={() => {
              if (name !== view && !confirmWorkspaceNavigation()) return;
              setView(name);
              setOpened(null);
            }}
          >
            {c.reviewViews[name]}
          </button>
        ))}
      </div>
      {reviews.loading ? (
        <Spinner />
      ) : reviews.error ? (
        <LoadFailed error={reviews.error} onRetry={reviews.reload} />
      ) : items.length === 0 ? (
        <p className={styles.note}>{c.reviewsEmpty}</p>
      ) : (
        <ul className={styles.rows}>
          {items.map((item) => (
            <li key={`${item.thread}:${item.seq}`} className={styles.row}>
              <div className={styles.rowHead}>
                <span>{reviewReasonText(item.reason)}</span>
                <span className={styles.badges}>
                  {item.category && <Badge>{item.category}</Badge>}
                  <Badge tone={item.state === "scored" ? "brand" : "neutral"}>
                    {REVIEW_STATE_TEXT[item.state]}
                  </Badge>
                  {item.overdue && <Badge tone="warning">{c.overdue}</Badge>}
                </span>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="button small secondary"
                  onClick={() => context.go("inbox", item.thread)}
                >
                  {c.openRequest}
                </button>
                <button
                  type="button"
                  className="button small"
                  aria-expanded={
                    opened?.thread === item.thread && opened.seq === item.seq
                  }
                  onClick={() => {
                    if (!confirmWorkspaceNavigation()) return;
                    setOpened(
                      opened?.thread === item.thread && opened.seq === item.seq
                        ? null
                        : item,
                    );
                  }}
                >
                  {c.reviewThis}
                </button>
              </div>
              {opened?.thread === item.thread && opened.seq === item.seq && (
                <ReviewCard
                  context={context}
                  thread={item.thread}
                  seq={item.seq}
                  onSaved={reviews.reload}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type ReportPage = {
  key: string;
  items: SupportAnswerReportItem[];
  next: string | null;
  error?: string;
};

/** Answers users reported, for the owner and Admins: the ones to review,
 * newest first, and those reviewed. Each read and write checks that access
 * again. */
function AnswerReportsCard({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const [view, setView] = useState<"open" | "done">("open");
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<ReportPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const key = `${room}:${account}:${view}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    readAnswerReports(room, view, undefined, controller.signal).then(
      (data) =>
        !controller.signal.aborted &&
        setPage({ key, items: data.items, next: data.next }),
      (reason) =>
        !controller.signal.aborted &&
        setPage({ key, items: [], next: null, error: message(reason) }),
    );
    return () => controller.abort();
  }, [room, view, key]);
  const current = page?.key === key ? page : undefined;
  async function act(
    work: (shown: ReportPage) => Promise<ReportPage>,
    done?: string,
  ) {
    if (!current) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await work(current);
      setPage((value) => (value?.key === next.key ? next : value));
      if (done) setNotice(done);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const more = () =>
    act(async (shown) => {
      const data = await readAnswerReports(room, view, shown.next ?? undefined);
      return { ...shown, items: [...shown.items, ...data.items], next: data.next };
    });
  const reviewed = (item: SupportAnswerReportItem) =>
    act(async (shown) => {
      await markAnswerReportReviewed(room, account, item);
      return { ...shown, items: shown.items.filter((row) => row !== item) };
    }, c.reportReviewed);
  return (
    <Card id="answer-reports" title={c.reportsTitle} description={c.reportsDescription}>
      <div className={styles.tabs} role="tablist">
        {(["open", "done"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={view === name}
            className={`button small ${view === name ? "" : "secondary"}`}
            onClick={() => {
              setView(name);
              setError("");
              setNotice("");
            }}
          >
            {c.reportViews[name]}
          </button>
        ))}
      </div>
      {!current ? (
        <Spinner />
      ) : current.error ? (
        <LoadFailed
          error={current.error}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : current.items.length === 0 && !current.next ? (
        <p className={styles.note}>{c.reportsEmpty[view]}</p>
      ) : (
        <ul className={styles.rows}>
          {current.items.map((item) => (
            <li key={`${item.thread}:${item.message}`} className={styles.row}>
              <div className={styles.rowHead}>
                <span>{item.reason ?? c.reportNoReason}</span>
                <span className={styles.badges}>
                  <Badge>{c.reportedOn(day(item.reportedAt))}</Badge>
                  {item.reviewedAt && (
                    <Badge tone="brand">{c.reviewedOn(day(item.reviewedAt))}</Badge>
                  )}
                </span>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="button small secondary"
                  onClick={() => context.go("inbox", item.thread)}
                >
                  {c.openRequest}
                </button>
                {view === "open" && (
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => void reviewed(item)}
                  >
                    {c.markReviewed}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {current?.next && (
        <div className={styles.actions}>
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => void more()}
          >
            {c.showMore}
          </button>
        </div>
      )}
      <Status notice={notice} error={error} />
    </Card>
  );
}

/** One sampled request's review: its labels, the four rubric items, a
 * note only the team sees, and skip. The inbox panel can mount it too. */
export function ReviewCard({
  context,
  thread,
  seq,
  onSaved,
  showLabels = true,
}: {
  context: QualityTarget;
  thread: string;
  seq: number;
  onSaved?: () => void;
  /** The thread panel lists labels beside each reply instead. */
  showLabels?: boolean;
}) {
  const { room, account } = context;
  const [quality, setQuality] = useState<SupportCaseQualityView | null>(null);
  const [learningReviewAvailable, setLearningReviewAvailable] = useState(false);
  const [rubric, setRubric] = useState<Partial<Rubric>>({});
  const [note, setNote] = useState("");
  const [skip, setSkip] = useState<ReviewSkipReason>("not-enough-context");
  const [evalFor, setEvalFor] = useState<number | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setQuality(null);
    setLearningReviewAvailable(false);
    setError("");
    readCaseQuality(room, thread, seq, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const current = data.cases[0] ?? null;
        setQuality(current);
        setLearningReviewAvailable(data.learningReviewAvailable === true);
        setRubric(current?.review?.rubric ?? {});
        setNote(current?.review?.note ?? "");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(message(reason));
      });
    return () => controller.abort();
  }, [room, account, thread, seq, readAttempt]);
  const complete = RUBRIC_ITEMS.every((item) => rubric[item]);
  async function act(input: Parameters<typeof reviewAction>[3]) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await reviewAction(room, account, thread, input);
      setQuality(result.quality);
      if (input.action === "skip") {
        setRubric(result.quality.review?.rubric ?? {});
        setNote(result.quality.review?.note ?? "");
      }
      setNotice(c.saved);
      onSaved?.();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const review = quality?.review;
  const dirty = Boolean(
    quality &&
    (JSON.stringify(rubric) !== JSON.stringify(review?.rubric ?? {}) ||
      note !== (review?.note ?? "")),
  );
  return (
    <div className={styles.review}>
      <UnsavedChanges dirty={dirty} />
      {!quality && !error && <Spinner />}
      {!quality && error && (
        <button
          type="button"
          className="button small secondary"
          onClick={() => setReadAttempt((value) => value + 1)}
        >
          {c.retry}
        </button>
      )}
      {showLabels &&
        quality?.labels.map((entry) => (
          <div key={entry.message} className={styles.actions}>
            <span className={styles.badges}>
              {entry.labels.map((label) => (
                <Badge key={label}>{REPLY_LABEL_TEXT[label]}</Badge>
              ))}
            </span>
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() =>
                void labelReply(room, account, thread, entry.message, [])
                  .then((result) => setQuality(result.quality))
                  .catch((reason) => setError(message(reason)))
              }
            >
              {c.clearLabel}
            </button>
            <button
              type="button"
              className="button small secondary"
              aria-expanded={evalFor === entry.message}
              onClick={() =>
                setEvalFor(evalFor === entry.message ? null : entry.message)
              }
            >
              {c.saveAsEval}
            </button>
            {learningReviewAvailable && entry.bot && entry.labels.some((label) => ["wrong-facts", "wrong-product", "wrong-metric-or-window", "unsupported-claim", "unsafe"].includes(label)) && (
              <LearnedFaqCorrection key={`${room}:${account}:${thread}:${entry.message}`} room={room} account={account} thread={thread} message={entry.message} />
            )}
          </div>
        ))}
      {evalFor !== null && (
        <EvalDialog
          context={context}
          thread={thread}
          message={evalFor}
          onDone={() => setEvalFor(null)}
        />
      )}
      {review?.state === "queued" && !review.reviewer && (
        <button
          type="button"
          className="button small secondary"
          disabled={busy}
          onClick={() => void act({ action: "take", seq })}
        >
          {c.take}
        </button>
      )}
      {RUBRIC_ITEMS.map((item) => (
        <fieldset
          key={item}
          className={styles.rubric}
          disabled={busy || !quality}
        >
          <legend>{RUBRIC_TEXT[item].label}</legend>
          <p className={styles.note}>{RUBRIC_TEXT[item].check}</p>
          <div className={styles.actions}>
            {(["pass", "fail", "n/a"] as RubricScore[]).map((score) => (
              <button
                key={score}
                type="button"
                className={`button small ${rubric[item] === score ? "" : "secondary"}`}
                aria-pressed={rubric[item] === score}
                onClick={() => setRubric({ ...rubric, [item]: score })}
              >
                {score === "pass" ? c.pass : score === "fail" ? c.fail : c.na}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <Field label={c.note} optional>
        <textarea
          className={ui.input}
          rows={3}
          maxLength={4000}
          value={note}
          disabled={busy || !quality}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <div className={styles.actions}>
        <button
          type="button"
          className="button small"
          disabled={busy || !quality || !complete || !dirty}
          onClick={() =>
            void act({
              action: "score",
              seq,
              rubric: rubric as Rubric,
              ...(note.trim() ? { note } : {}),
            })
          }
        >
          {busy && <Spinner />}
          {c.saveReview}
        </button>
        <select
          className={ui.input}
          value={skip}
          onChange={(event) => setSkip(event.target.value as ReviewSkipReason)}
        >
          {REVIEW_SKIP_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {REVIEW_SKIP_TEXT[reason]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button small secondary"
          disabled={busy || !quality}
          onClick={() => {
            if (!dirty || confirmWorkspaceNavigation())
              void act({ action: "skip", seq, reason: skip });
          }}
        >
          {c.skip}
        </button>
      </div>
      <Status notice={notice} error={error} />
    </div>
  );
}

/** "Save as eval case": the server's de-identified copy with the parts it
 * flagged, the expected answer and the person's confirmation. */
export function EvalDialog({
  context,
  thread,
  message: reply,
  onDone,
}: {
  context: QualityTarget;
  thread: string;
  message: number;
  onDone: () => void;
}) {
  const { room, account } = context;
  const [draft, setDraft] = useState<EvalDraft | null>(null);
  const [answer, setAnswer] = useState("");
  const [action, setAction] = useState<EvalAction>("answer");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    setError("");
    previewEval(
      room,
      account,
      thread,
      reply,
      names.length ? { remove: names } : {},
    )
      .then(({ draft: next }) => {
        setDraft(next);
        setAnswer(
          (current) =>
            current || next.expected.answer || next.candidateAnswer || "",
        );
        setAction(next.expected.action);
        setConfirmed(false);
      })
      .catch((reason) => setError(message(reason)));
  }, [room, account, thread, reply, names]);
  const replaced = draft
    ? (Object.entries(draft.replaced) as [PlaceholderKind, number][]).filter(
        ([, n]) => n > 0,
      )
    : [];
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await saveEval(room, account, thread, reply, {
        ...draft,
        expected: {
          ...draft.expected,
          action,
          answer: action === "handoff" ? null : answer.trim() || null,
          handoffReason:
            action === "handoff" ? (draft.handoffReason ?? "unsure") : null,
        },
      });
      setNotice(c.evalSaved);
      setTimeout(onDone, 1_500);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.review} aria-label={c.saveEvalTitle}>
      <h4 className={styles.subhead}>{c.saveEvalTitle}</h4>
      <ul className={styles.points}>
        {c.saveEvalPoints.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {!draft ? (
        error ? null : (
          <Spinner />
        )
      ) : (
        <>
          {replaced.length > 0 && (
            <p className={styles.note}>
              {c.replacedLine(
                replaced.map(([kind, n]) =>
                  c.replacedKind(PLACEHOLDER_TEXT[kind], n),
                ),
              )}
            </p>
          )}
          {draft.checks.length > 0 && (
            <>
              <h5 className={styles.label}>{c.checkTitle}</h5>
              <ul className={styles.checks}>
                {draft.checks.map((check, index) => (
                  <li key={index}>
                    <strong>{CHECK_TEXT[check.kind]}</strong>{" "}
                    <mark>{check.excerpt}</mark>
                  </li>
                ))}
              </ul>
            </>
          )}
          <form
            className={styles.actions}
            onSubmit={(event) => {
              event.preventDefault();
              const next = name.trim();
              if (next && !names.includes(next) && names.length < 10)
                setNames([...names, next]);
              setName("");
            }}
          >
            <Field label={c.removeName} hint={c.removeNameHint} optional>
              <input
                className={ui.input}
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <button
              type="submit"
              className="button small secondary"
              disabled={!name.trim()}
            >
              {c.removeNameButton}
            </button>
          </form>
          <h5 className={styles.label}>{c.conversation}</h5>
          <ul className={styles.rows}>
            {draft.input.turns.map((turn, index) => (
              <li key={index} className={styles.turn}>
                <strong>{c.roles[turn.role]}</strong> {turn.text}
              </li>
            ))}
          </ul>
          <h5 className={styles.label}>{c.labeledReply}</h5>
          <p className={styles.turn}>{draft.evaluated?.text}</p>
          <Field label={c.expectedAction}>
            <select
              className={ui.input}
              value={action}
              onChange={(event) => setAction(event.target.value as EvalAction)}
            >
              {(Object.keys(c.actions) as EvalAction[]).map((option) => (
                <option key={option} value={option}>
                  {c.actions[option]}
                </option>
              ))}
            </select>
          </Field>
          {action !== "handoff" && (
            <Field label={c.approvedAnswer}>
              <textarea
                className={ui.input}
                rows={3}
                maxLength={4000}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
            </Field>
          )}
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {c.evalConfirm}
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className="button small"
              disabled={
                busy || !confirmed || (action !== "handoff" && !answer.trim())
              }
              onClick={() => void save()}
            >
              {busy && <Spinner />}
              {c.saveEval}
            </button>
            <button
              type="button"
              className="button small secondary"
              onClick={onDone}
            >
              {c.cancel}
            </button>
          </div>
        </>
      )}
      <Status notice={notice} error={error} />
    </section>
  );
}

function TrendsCard({ context }: { context: WorkspaceContext }) {
  const { room } = context;
  const [window, setWindow] = useState<TrendWindow>("30d");
  const trends = useLoad<SupportTrends, TrendWindow>(readTrends, room, window);
  const data =
    trends.data &&
    typeof trends.data.dimensions === "object" &&
    trends.data.dimensions
      ? trends.data
      : undefined;
  const weeks = Array.isArray(data?.weeks) ? data.weeks : [];
  // The worker's change compares the last two weeks before the current one.
  const current =
    data && Number.isFinite(Date.parse(data.to))
      ? weekStart(Date.parse(data.to))
      : null;
  const complete = current ? weeks.filter((date) => date < current) : [];
  const compared =
    complete.length >= 2
      ? c.trendsChange(
          week(complete[complete.length - 1]),
          week(complete[complete.length - 2]),
        )
      : null;
  const rows = (dimension: TrendDimension) => {
    const list = data?.dimensions[dimension];
    return Array.isArray(list) ? list : [];
  };
  const showChange = compared !== null;
  return (
    <Card
      title={c.trendsTitle}
      actions={
        <select
          className={ui.input}
          aria-label={c.trendsPeriod}
          value={window}
          onChange={(event) => setWindow(event.target.value as TrendWindow)}
        >
          {TREND_WINDOWS.map((option) => (
            <option key={option} value={option}>
              {`${option.replace("d", "")} days`}
            </option>
          ))}
        </select>
      }
    >
      {trends.loading ? (
        <Spinner />
      ) : !data ? (
        <LoadFailed error={trends.error ?? c.error} onRetry={trends.reload} />
      ) : data.cases === 0 ? (
        <p className={styles.note}>{c.trendsEmpty}</p>
      ) : (
        <>
          <ul className={styles.points}>
            {c.trendsPoints.map((point) => (
              <li key={point}>{point}</li>
            ))}
            <li>{showChange ? compared : c.trendsChangeLater}</li>
          </ul>
          {data.since && (
            <p className={styles.note}>{c.trendsSince(day(data.since))}</p>
          )}
          {TREND_DIMENSIONS.filter(
            (dimension) => rows(dimension).length > 0,
          ).map((dimension) => (
            <table
              key={dimension}
              className={`${styles.table} ${styles.trendTable}`}
            >
              <caption>{TREND_DIMENSION_TEXT[dimension]}</caption>
              <thead>
                <tr>
                  <th scope="col">{c.trendsColumns.name}</th>
                  <th scope="col">{c.trendsColumns.weeks}</th>
                  <th scope="col" className={styles.number}>
                    {c.trendsColumns.total}
                  </th>
                  {showChange && (
                    <th scope="col" className={styles.number}>
                      {c.trendsColumns.change}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows(dimension).map((row) => {
                  const counts = Array.isArray(row.weeks) ? row.weeks : [];
                  const max = Math.max(1, ...counts);
                  const dated = counts.map((count, index) => ({
                    count,
                    label: weeks[index]
                      ? c.trendsWeek(week(weeks[index]), count)
                      : undefined,
                  }));
                  // A check rule keeps its code as detail; an unknown one shows only the code.
                  const rule =
                    dimension === "diagnosis-rule" && row.key !== "other";
                  const known = rule && checkResultText(row.key) !== null;
                  return (
                    <tr key={row.key}>
                      <th scope="row">
                        {rule && !known ? (
                          <code className={styles.code}>{row.key}</code>
                        ) : (
                          trendKeyText(dimension, row.key)
                        )}
                        {known && (
                          <code className={styles.code}>{row.key}</code>
                        )}
                      </th>
                      <td>
                        <span className={styles.spark} aria-hidden="true">
                          {dated.map(({ count, label }, index) => (
                            <span
                              key={index}
                              title={label}
                              style={{
                                height: `${Math.round((count / max) * 100)}%`,
                              }}
                            />
                          ))}
                        </span>
                        {dated.some(({ label }) => label) && (
                          <span className="visually-hidden">
                            {dated
                              .map(({ label }) => label)
                              .filter(Boolean)
                              .join("; ")}
                          </span>
                        )}
                      </td>
                      <td className={styles.number}>{row.total}</td>
                      {showChange && (
                        <td className={styles.number}>
                          {row.change === null
                            ? ""
                            : row.change > 0
                              ? `+${row.change}`
                              : row.change}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </>
      )}
    </Card>
  );
}

function GapsCard({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const gaps = useLoad<SupportKnowledgeGaps, null>(loadGaps, room, null);
  const [error, setError] = useState("");
  const [override, setOverride] = useState<SupportKnowledgeGaps | null>(null);
  const loaded = override ?? gaps.data;
  const data = loaded && Array.isArray(loaded.groups) ? loaded : undefined;
  async function mark(
    id: string,
    action: "docs-updated" | "not-a-gap" | "reopen",
  ) {
    if (!data) return;
    setError("");
    try {
      setOverride(await markGap(room, account, data.month, id, action));
    } catch (reason) {
      setError(message(reason));
    }
  }
  return (
    <Card title={c.gapsTitle}>
      <ul className={styles.points}>
        {c.gapsPoints.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {!data && gaps.loading ? (
        <Spinner />
      ) : !data ? (
        <LoadFailed error={gaps.error ?? c.error} onRetry={gaps.reload} />
      ) : data.groups.length === 0 ? (
        <p className={styles.note}>{c.gapsEmpty}</p>
      ) : (
        <ul className={styles.rows}>
          {data.groups.map((group) => {
            const name = [group.category ?? c.uncategorized, group.product]
              .filter(Boolean)
              .join(", ");
            const samples = Array.isArray(group.samples) ? group.samples : [];
            return (
              <li key={group.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <div>
                    <strong>{group.category ?? c.uncategorized}</strong>
                    {group.product && (
                      <p className={styles.note}>{group.product}</p>
                    )}
                  </div>
                  <Badge>{GAP_STATE_TEXT[group.state]}</Badge>
                </div>
                <p className={styles.note}>{c.gapCases(group.cases)}</p>
                <p className={styles.note}>
                  {Object.entries(group.signals)
                    .map(([signal, count], index) => {
                      const label = GAP_SIGNAL_TEXT[signal as GapSignal];
                      const text =
                        index === 0 || /^[A-Z]{2}/.test(label)
                          ? label
                          : label.charAt(0).toLowerCase() + label.slice(1);
                      return `${text} ${count}`;
                    })
                    .join(", ")}
                </p>
                {/* Samples are numbered; thread IDs stay out of the page. */}
                {samples.length > 0 && (
                  <div
                    className={styles.actions}
                    role="group"
                    aria-label={`${c.samples}, ${name}`}
                  >
                    <span className={styles.note}>{c.samples}</span>
                    {samples.map((sample, index) => (
                      <button
                        key={`${sample.thread}:${sample.seq}`}
                        type="button"
                        className="button small secondary"
                        aria-label={c.openSample(
                          index + 1,
                          samples.length,
                          name,
                        )}
                        onClick={() => context.go("inbox", sample.thread)}
                      >
                        {c.sample(index + 1)}
                      </button>
                    ))}
                  </div>
                )}
                <div className={styles.actions}>
                  {group.state === "open" ? (
                    <>
                      <button
                        type="button"
                        className="button small"
                        onClick={() => void mark(group.id, "docs-updated")}
                      >
                        {c.docsUpdated}
                      </button>
                      <button
                        type="button"
                        className="button small secondary"
                        onClick={() => void mark(group.id, "not-a-gap")}
                      >
                        {c.notAGap}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button small secondary"
                      onClick={() => void mark(group.id, "reopen")}
                    >
                      {c.reopen}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Status error={error} />
    </Card>
  );
}

function EvalsCard({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const evals = useLoad(loadEvals, room, null);
  const runs = useLoad<{ runs: EvalRunView[] }, null>(loadRuns, room, null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(
    id: string,
    action: "promote" | "retire" | "restore" | "delete",
  ) {
    setBusy(true);
    setError("");
    try {
      await evalAction(room, account, id, action);
      evals.reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      const text = await exportGoldenSet(room);
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/x-ndjson" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "golden-set.jsonl";
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const counts = evals.data?.counts;
  const cases = Array.isArray(evals.data?.cases) ? evals.data.cases : [];
  const runList = Array.isArray(runs.data?.runs) ? runs.data.runs : [];
  return (
    <Card
      title={c.evalsTitle}
      description={
        counts ? c.evalsCount(counts.golden, counts.candidate) : undefined
      }
      actions={
        counts && counts.golden > 0 ? (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => void download()}
          >
            {c.download}
          </button>
        ) : undefined
      }
    >
      {evals.loading ? (
        <Spinner />
      ) : evals.error ? (
        <LoadFailed error={evals.error} onRetry={evals.reload} />
      ) : !cases.length ? (
        <p className={styles.note}>{c.evalsEmpty}</p>
      ) : (
        <ul className={styles.rows}>
          {cases.map((item: EvalCaseSummary) => (
            <li key={item.id} className={styles.row}>
              <div className={styles.rowHead}>
                <span>{item.firstTurn}</span>
                <span className={styles.badges}>
                  {item.labels.map((label) => (
                    <Badge key={label}>{REPLY_LABEL_TEXT[label]}</Badge>
                  ))}
                  <Badge tone={item.state === "golden" ? "brand" : "neutral"}>
                    {EVAL_STATE_TEXT[item.state]}
                  </Badge>
                </span>
              </div>
              <div className={styles.actions}>
                {item.state === "candidate" && (
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => void act(item.id, "promote")}
                  >
                    {c.addGolden}
                  </button>
                )}
                {item.state !== "retired" ? (
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={busy}
                    onClick={() => void act(item.id, "retire")}
                  >
                    {c.retire}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={busy}
                    onClick={() => void act(item.id, "restore")}
                  >
                    {c.restore}
                  </button>
                )}
                <button
                  type="button"
                  className="button small secondary"
                  disabled={busy}
                  onClick={() => void act(item.id, "delete")}
                >
                  {c.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3 className={styles.subhead}>{c.runsTitle}</h3>
      {runs.loading ? (
        <Spinner />
      ) : runs.error ? (
        <LoadFailed error={runs.error} onRetry={runs.reload} />
      ) : !runList.length ? (
        <p className={styles.note}>{c.runsEmpty}</p>
      ) : (
        <ul className={styles.rows}>
          {runList.map((run) => (
            <li key={run.id} className={styles.row}>
              <div className={styles.rowHead}>
                <span>{`${run.agent.name} ${run.agent.version}`}</span>
                <span className={styles.badges}>
                  <Badge tone={run.passed === run.total ? "brand" : "neutral"}>
                    {c.runLine(run.passed, run.total)}
                  </Badge>
                  {run.regressions.length > 0 && (
                    <Badge tone="warning">
                      {c.regressions(run.regressions.length)}
                    </Badge>
                  )}
                </span>
              </div>
              <p className={styles.note}>{day(run.postedAt)}</p>
            </li>
          ))}
        </ul>
      )}
      <Status error={error} />
    </Card>
  );
}
