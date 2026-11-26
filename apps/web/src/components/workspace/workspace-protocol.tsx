"use client";
import { trackEvent } from "@/lib/analytics";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { canUseTrialPractice, TrialAiPractice } from "./trial-ai-practice";
import { SourceUrlForm } from "./onboarding-source";
import { KNOWLEDGE_LIMITS } from "@templ/chat/knowledge";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  KNOWLEDGE_ERAS,
  PROFILE_VISIBILITY,
  type ProfileVisibility,
  type KnowledgeEraTag,
  type KnowledgeOverview,
  type KnowledgeSourceView,
} from "@templ/chat/protocol-profile";
import {
  knowledgeAction,
  readKnowledge,
  readKnowledgeFaq,
  readAiGuidance,
  saveAiGuidance,
  type KnowledgeFilters,
} from "@/lib/knowledge-client";
import {
  ERA_TEXT,
  QUALITY_COPY as c,
  VISIBILITY_TEXT,
} from "@/lib/copy/quality";
import { CommunityApiError } from "@/lib/community-client";
import { Badge, Card, Field, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace-quality.module.css";
import sources from "./knowledge-sources.module.css";
import { UnsavedChanges } from "./unsaved-changes";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : c.error;
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

const workspaceAdmin = (context: WorkspaceContext) =>
  canManageWorkspace(
    {
      isManager: context.manager,
      permissions: context.state?.viewer?.permissions,
    },
    context.state?.bots?.some((bot) => bot.principalId === context.account),
  );

/** Support knowledge uses its own access and release gate. */
export function WorkspaceKnowledge({ context }: { context: WorkspaceContext }) {
  return (
    <div className={styles.stack}>
      <KnowledgeCard
        key={`${context.room}:${context.account}:${context.manager}:${workspaceAdmin(context)}`}
        context={context}
      />
      {workspaceAdmin(context) && canUseTrialPractice(context) && (
        <Card title="Test your AI">
          <TrialAiPractice key={context.room + ":" + context.account} context={context} />
        </Card>
      )}
    </div>
  );
}

function KnowledgeCard({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const editable = workspaceAdmin(context);
  const [data, setData] = useState<KnowledgeOverview | null>(null);
  const [editing, setEditing] = useState<KnowledgeSourceView | null>(null);
  const updateSourceRow = useCallback((saved: KnowledgeSourceView) => {
    setData(
      (current) =>
        current && {
          ...current,
          sources: current.sources.map((row) =>
            row.id === saved.id ? saved : row,
          ),
        },
    );
  }, []);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);
  const sourceRequest = useRef<AbortController | null>(null);
  const [sourceAction, setSourceAction] = useState<{
    id: string;
    action: "refresh" | "remove";
  } | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [guidanceDraft, setGuidanceDraft] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState<KnowledgeFilters>({});
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [guidanceError, setGuidanceError] = useState("");
  const [guidanceAttempt, setGuidanceAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingMore(false);
    setData(null);
    setError("");
    readKnowledge(room, controller.signal, undefined, filters)
      .then(
        (view) =>
          !controller.signal.aborted &&
          setData(Array.isArray(view?.sources) ? view : null),
      )
      .catch(
        (reason) => !controller.signal.aborted && setError(message(reason)),
      );
    return () => {
      controller.abort();
      moreRequest.current?.abort();
      sourceRequest.current?.abort();
    };
  }, [room, tick, filters]);
  async function loadMore() {
    if (!data?.next || moreRequest.current || busy) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const page = await readKnowledge(
        room,
        controller.signal,
        data.next,
        filters,
      );
      if (!controller.signal.aborted)
        setData(
          (current) =>
            current && {
              ...page,
              sources: [
                ...new Map(
                  [...current.sources, ...page.sources].map((source) => [
                    source.id,
                    source,
                  ]),
                ).values(),
              ],
            },
        );
    } catch (reason) {
      if (!controller.signal.aborted) setError(message(reason));
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }
  async function run(task: () => Promise<string | void>, reload = true) {
    moreRequest.current?.abort();
    moreRequest.current = null;
    setLoadingMore(false);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const done = await task();
      if (done) setNotice(done);
      if (reload) setTick((n) => n + 1);
      return true;
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === "AbortError")) {
        trackEvent("brain_setup_failed");
        setError(message(reason));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function changeSource(id: string, action: "refresh" | "remove") {
    if (sourceRequest.current || busy) return;
    const controller = new AbortController();
    sourceRequest.current = controller;
    setSourceAction({ id, action });
    const options = {
      assertCurrent: () => controller.signal.throwIfAborted(),
      signal: controller.signal,
    };
    try {
      await run(async () => {
        if (action === "refresh") {
          const saved = await knowledgeAction(
            room,
            account,
            id,
            { action: "refresh" },
            options,
          );
          controller.signal.throwIfAborted();
          updateSourceRow(saved);
        } else {
          await knowledgeAction(
            room,
            account,
            id,
            { action: "remove" },
            options,
          );
          controller.signal.throwIfAborted();
          setData(
            (current) =>
              current && {
                ...current,
                sources: current.sources.filter((row) => row.id !== id),
              },
          );
          setRemoving(null);
        }
        try {
          const view = await readKnowledge(
            room,
            controller.signal,
            undefined,
            filters,
          );
          controller.signal.throwIfAborted();
          setData((current) => current && { ...current, counts: view.counts });
        } catch {
          if (!controller.signal.aborted)
            return action === "refresh"
              ? "Refresh requested. Counts could not load."
              : "Source deleted. Counts could not load.";
        }
        return action === "refresh" ? "Refresh requested." : "Source deleted.";
      }, false);
    } finally {
      if (sourceRequest.current === controller) sourceRequest.current = null;
      if (!controller.signal.aborted) setSourceAction(null);
    }
  }
  useEffect(() => {
    setGuidance(null);
    setGuidanceDraft(null);
    setGuidanceError("");
    if (!editable) return;
    const controller = new AbortController();
    readAiGuidance(room, controller.signal)
      .then((view) => !controller.signal.aborted && setGuidance(view.text))
      .catch(
        () =>
          !controller.signal.aborted &&
          setGuidanceError("AI guidance could not load."),
      );
    return () => controller.abort();
  }, [room, editable, guidanceAttempt]);
  return (
    <Card id="company-brain" title="Website and docs">
      {(Boolean(data?.next) || (data?.counts.sources ?? 0) > 8 || Boolean(filters.q || filters.kind || filters.status)) && <div className={sources.toolbar}>
        {data && (
          <p className={styles.note} role="status">
            {data.counts.sources} sources in this workspace.{" "}
            {data.counts.failed} could not be read.
          </p>
        )}
        <form
          className={sources.filters}
          aria-label="Find AI sources"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || editing !== null || loadingMore) return;
            setFilters((current) => ({ ...current, q: query.trim() }));
          }}
        >
          <Field label="Search sources">
            <input
              className={ui.input}
              value={query}
              disabled={busy || editing !== null || loadingMore}
              maxLength={120}
              placeholder="Title or address"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Field label="Source type">
            <select
              className={ui.input}
              value={filters.kind ?? ""}
              disabled={busy || editing !== null || loadingMore}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  kind: event.target.value,
                }))
              }
            >
              <option value="">All types</option>
              <option value="doc">Docs pages</option>
              <option value="faq">FAQs</option>
              <option value="file">Files</option>
              <option value="saved-reply">Saved replies</option>
            </select>
          </Field>
          <Field label="Read status">
            <select
              className={ui.input}
              value={filters.status ?? ""}
              disabled={busy || editing !== null || loadingMore}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value,
                }))
              }
            >
              <option value="">All statuses</option>
              <option value="ready">Ready</option>
              <option value="pending">Waiting to read</option>
              <option value="failed">Could not read</option>
              <option value="archived">Archived copy</option>
            </select>
          </Field>
          <button
            type="submit"
            className="button small secondary"
            disabled={busy || editing !== null || loadingMore}
          >
            Search
          </button>
          {(filters.q || filters.kind || filters.status) && (
            <button
              type="button"
              className="button small secondary"
              disabled={busy || editing !== null || loadingMore}
              onClick={() => {
                setQuery("");
                setFilters({});
              }}
            >
              Clear filters
            </button>
          )}
        </form>
      </div>}
      {!data ? (
        error ? null : (
          <Spinner />
        )
      ) : data.sources.length === 0 ? (
        <p className={styles.note}>
          {filters.q || filters.kind || filters.status
            ? "No sources match these filters."
            : "No pages added yet."}
        </p>
      ) : (
        <ul className={sources.list} aria-label="AI sources">
          {data.sources.map((source) => (
            <li key={source.id} className={sources.source}>
              <div className={styles.rowHead}>
                <strong>{source.title}</strong>
                <span className={styles.badges}>
                  {source.era !== "current" && <Badge>{ERA_TEXT[source.era]}</Badge>}
                  {source.visibility !== "member-safe" && <Badge>{VISIBILITY_TEXT[source.visibility]}</Badge>}
                  {source.learning?.kind === "entry" && (
                    <Badge tone={source.learning.reviewRequired ? "warning" : "info"}>
                      {source.learning.pausedAt ? "Learned FAQ paused" : source.learning.reviewRequired ? "Learned FAQ needs review" : "Learned from team"}
                    </Badge>
                  )}
                  {!!source.possiblyOutdated?.length && (
                    <Badge tone="warning">Possibly outdated</Badge>
                  )}
                  {source.status === "ready" && (
                    <Badge
                      tone={
                        source.error || !source.chunks ? "warning" : "brand"
                      }
                    >
                      {source.error
                        ? "Latest check failed"
                        : source.chunks
                          ? "Ready"
                          : "No indexed text"}
                    </Badge>
                  )}
                  {source.status === "failed" && (
                    <Badge tone="danger">
                      {source.error === "gone" ? c.sourceGone : c.sourceFailed}
                    </Badge>
                  )}
                  {source.status === "archived" && (
                    <Badge tone="warning">{c.sourceArchived}</Badge>
                  )}
                  {source.status === "pending" && (
                    <Badge tone="info">{c.sourcePending}</Badge>
                  )}
                </span>
              </div>
              {source.url && <p className={styles.note}>{source.url}</p>}
              {source.learning?.kind === "collection" && (
                <p className={styles.note}>
                  General facts from human answers after AI handoffs. Original sources stay intact.
                </p>
              )}
              {source.learning?.pausedAt && (
                <p className={styles.note}>
                  Paused {new Date(source.learning.pausedAt).toLocaleString()} after an AI reply was labeled incorrect. AI cannot use this entry. Review its answer and visibility before publishing it again.
                </p>
              )}
              {source.learning?.reviewRequired && !source.learning.pausedAt && (
                <p className={styles.note}>
                  This answer conflicts with an existing source. It stays team-only until an Admin reviews the sources.
                </p>
              )}
              {!!source.possiblyOutdated?.length && (
                <section>
                  <h3>Review conflicting passages</h3>
                  <p className={styles.note}>
                    A human answer differs from these passages. This source is unchanged and still available to AI.
                  </p>
                  {source.possiblyOutdated.map((conflict) => (
                    <div key={`${conflict.entryId}:${conflict.quote}`}>
                      <blockquote>{conflict.quote}</blockquote>
                      <p className={styles.note}>{conflict.reason}</p>
                    </div>
                  ))}
                </section>
              )}
              <p className={styles.note}>
                {source.kind === "faq"
                  ? "FAQ"
                  : source.kind === "saved-reply"
                    ? "Saved reply"
                    : source.url
                      ? "Docs page"
                      : "File"}
                .{" "}
                {source.lastFetchAt
                  ? `Last checked ${new Date(source.lastFetchAt).toLocaleString()}.`
                  : source.kind === "doc" && source.url
                    ? "Not checked yet."
                    : `Saved ${new Date(source.updatedAt).toLocaleString()}.`}
                {source.nextFetchAt &&
                  ` Next check due ${new Date(source.nextFetchAt).toLocaleString()}.`}
              </p>
              {editable &&
                (editing?.id === source.id ? (
                  <KnowledgeSourceSettings
                    key={source.id}
                    context={context}
                    source={source}
                    onBusy={setBusy}
                    onPreview={updateSourceRow}
                    onCancel={() => setEditing(null)}
                    onSaved={(saved) => {
                      updateSourceRow(saved);
                      setEditing(null);
                      setNotice(c.saved);
                      setError("");
                    }}
                  />
                ) : (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="button small secondary"
                      disabled={
                        busy ||
                        loadingMore ||
                        editing !== null
                      }
                      onClick={() => {
                        setEditing(source);
                        setNotice("");
                        setError("");
                      }}
                    >
                      Edit
                    </button>
                    {source.kind === "doc" && source.url && (
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={busy || loadingMore || editing !== null}
                        aria-busy={
                          sourceAction?.id === source.id &&
                          sourceAction.action === "refresh"
                        }
                        onClick={() => void changeSource(source.id, "refresh")}
                      >
                        {sourceAction?.id === source.id &&
                        sourceAction.action === "refresh"
                          ? "Refreshing…"
                          : c.refresh}
                      </button>
                    )}
                    {removing === source.id ? (
                      <div>
                        <p>
                          Delete “{source.title}”? AI will stop using it. You
                          cannot undo this.
                        </p>
                        <div className={styles.actions}>
                          <button
                            type="button"
                            className="button small"
                            disabled={busy}
                            onClick={() =>
                              void changeSource(source.id, "remove")
                            }
                          >
                            {sourceAction?.id === source.id
                              ? "Deleting…"
                              : "Delete source"}
                          </button>
                          <button
                            type="button"
                            className="button small secondary"
                            disabled={busy}
                            onClick={() => setRemoving(null)}
                          >
                            Keep source
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={busy || loadingMore || editing !== null}
                        aria-busy={
                          sourceAction?.id === source.id &&
                          sourceAction.action === "remove"
                        }
                        onClick={() => setRemoving(source.id)}
                      >
                        {sourceAction?.id === source.id &&
                        sourceAction.action === "remove"
                          ? "Deleting…"
                          : c.remove}
                      </button>
                    )}
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
      {data?.next && (
        <button
          type="button"
          className="button small secondary"
          disabled={busy || loadingMore || editing !== null}
          onClick={() => void loadMore()}
        >
          {loadingMore && <Spinner />}
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
      <UnsavedChanges dirty={guidanceDraft !== null && guidanceDraft !== guidance} />
      {editable && data && <SourceUrlForm context={context} onSaved={() => setTick(value => value + 1)} />}
      {editable && (
        <>
          <Field label={c.aiGuidance} hint={c.aiGuidanceHint}>
            <textarea
              className={ui.input}
              rows={3}
              maxLength={KNOWLEDGE_LIMITS.guidanceChars}
              disabled={guidance === null || busy}
              value={guidanceDraft ?? guidance ?? ""}
              onChange={(event) => setGuidanceDraft(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="button small secondary"
            disabled={
              busy ||
              guidance === null ||
              guidanceDraft === null ||
              guidanceDraft === guidance
            }
            onClick={() =>
              void run(async () => {
                const saved = await saveAiGuidance(
                  room,
                  account,
                  guidanceDraft ?? "",
                );
                setGuidance(saved.text);
                setGuidanceDraft(null);
                return c.saved;
              }, false)
            }
          >
            {busy && <Spinner />}
            {c.saveAiGuidance}
          </button>
          {guidanceError && (
            <div>
              <p role="alert">{guidanceError}</p>
              <button
                type="button"
                className="button small secondary"
                onClick={() => setGuidanceAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          )}
        </>
      )}
      {notice && (
        <p className={styles.status} role="status">
          {notice}
        </p>
      )}
      {error && (
        <div>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => setTick((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
    </Card>
  );
}

function KnowledgeSourceSettings({
  context,
  source,
  onBusy,
  onSaved,
  onPreview,
  onCancel,
}: {
  context: WorkspaceContext;
  source: KnowledgeSourceView;
  onBusy: (busy: boolean) => void;
  onSaved: (source: KnowledgeSourceView) => void;
  onPreview: (source: KnowledgeSourceView) => void;
  onCancel: () => void;
}) {
  const { room, account } = context;
  const editable = workspaceAdmin(context);
  const [title, setTitle] = useState(source.title);
  const [era, setEra] = useState(source.era);
  const [visibility, setVisibility] = useState(source.visibility);
  const [addresses, setAddresses] = useState(source.addresses.join("\n"));
  const [answer, setAnswer] = useState<string | null>(
    source.kind === "faq" ? null : "",
  );
  const [savedAnswer, setSavedAnswer] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(source);
  const [readTick, setReadTick] = useState(0);
  const [needsReload, setNeedsReload] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (source.kind === "faq") {
      request.current = controller;
      onBusy(true);
      setAnswer(null);
      setError("");
      setNeedsReload(false);
      readKnowledgeFaq(room, source.id, controller.signal)
        .then((current) => {
          if (controller.signal.aborted) return;
          if (
            current.id !== source.id ||
            current.kind !== "faq" ||
            typeof current.text !== "string"
          )
            throw new Error("FAQ could not load. Try again.");
          setSnapshot(current);
          setTitle(current.title);
          setEra(current.era);
          setVisibility(current.visibility);
          setAddresses(current.addresses.join("\n"));
          setAnswer(current.text);
          setSavedAnswer(current.text);
          onPreview(current);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(message(reason));
        })
        .finally(() => {
          if (request.current === controller) request.current = null;
          if (!controller.signal.aborted) onBusy(false);
        });
    }
    return () => {
      controller.abort();
      request.current?.abort();
      onBusy(false);
    };
  }, [
    room,
    account,
    editable,
    source.id,
    source.kind,
    readTick,
    onBusy,
    onPreview,
  ]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (request.current || !editable || answer === null || needsReload) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    onBusy(true);
    setError("");
    onPreview({
      ...snapshot,
      title: title.trim(),
      era,
      visibility,
      addresses: era === "legacy" ? lines(addresses) : [],
    });
    try {
      const saved = await knowledgeAction(
        room,
        account,
        source.id,
        {
          action: "update",
          title: title.trim(),
          era,
          visibility,
          addresses: era === "legacy" ? lines(addresses) : [],
          ...(source.kind === "faq"
            ? { text: answer, ifUpdatedAt: snapshot.updatedAt }
            : {}),
        },
        {
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        },
      );
      if (!controller.signal.aborted) onSaved(saved);
    } catch (reason) {
      if (!controller.signal.aborted) {
        onPreview(snapshot);
        setError(message(reason));
        setNeedsReload(
          reason instanceof CommunityApiError && reason.status === 409,
        );
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
        onBusy(false);
      }
    }
  }
  const dirty =
    answer !== null &&
    (title !== snapshot.title ||
      era !== snapshot.era ||
      visibility !== snapshot.visibility ||
      (era === "legacy" &&
        JSON.stringify(lines(addresses)) !==
          JSON.stringify(snapshot.addresses)) ||
      (source.kind === "faq" &&
        savedAnswer !== null &&
        answer !== savedAnswer));
  return (
    <form
      className={styles.fields}
      aria-label="Source settings"
      onSubmit={(event) => void save(event)}
    >
      <UnsavedChanges dirty={dirty} />
      {source.kind === "faq" && answer === null && !error && <Spinner />}
      <Field label={source.kind === "faq" ? c.question : "Title"}>
        <input
          className={ui.input}
          required
          maxLength={KNOWLEDGE_LIMITS.titleChars}
          disabled={saving || answer === null}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      {source.kind === "faq" && (
        <Field label={c.answer}>
          <textarea
            className={ui.input}
            rows={4}
            maxLength={KNOWLEDGE_LIMITS.faqChars}
            disabled={saving || answer === null}
            value={answer ?? ""}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </Field>
      )}
      <Field label="Product version">
        <select
          className={ui.input}
          disabled={saving || answer === null}
          value={era}
          onChange={(event) => setEra(event.target.value as KnowledgeEraTag)}
        >
          {KNOWLEDGE_ERAS.map((value) => (
            <option key={value} value={value}>
              {ERA_TEXT[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Who may see it">
        <select
          className={ui.input}
          disabled={saving || answer === null}
          value={visibility}
          onChange={(event) =>
            setVisibility(event.target.value as ProfileVisibility)
          }
        >
          {PROFILE_VISIBILITY.map((value) => (
            <option key={value} value={value}>
              {VISIBILITY_TEXT[value]}
            </option>
          ))}
        </select>
      </Field>
      {era === "legacy" && (
        <Field label={c.addresses} hint={c.addressesHint}>
          <textarea
            className={ui.input}
            rows={2}
            disabled={saving || answer === null}
            value={addresses}
            onChange={(event) => setAddresses(event.target.value)}
          />
        </Field>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="submit"
          className="button small"
          disabled={
            !dirty ||
            saving ||
            answer === null ||
            needsReload ||
            !title.trim() ||
            (source.kind === "faq" && !answer.trim())
          }
        >
          {saving && <Spinner />}Save changes
        </button>
        {source.kind === "faq" && error && (answer === null || needsReload) && (
          <button
            type="button"
            className="button small secondary"
            disabled={saving}
            onClick={() => setReadTick((value) => value + 1)}
          >
            {answer === null ? "Retry" : "Reload FAQ"}
          </button>
        )}
        <button
          type="button"
          className="button small secondary"
          disabled={saving}
          onClick={() => {
            if (!dirty || window.confirm("Discard your source changes?"))
              onCancel();
          }}
        >
          {c.cancel}
        </button>
      </div>
    </form>
  );
}
