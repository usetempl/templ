"use client";
import { trackEvent } from "@/lib/analytics";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { BrainStoragePanel } from "./brain-storage-panel";
import { SupportFileImport } from "./support-file-import";
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
  PROFILE_STATUSES,
  PROFILE_VISIBILITY,
  parseProfileCsv,
  parseProfileJson,
  type KnowledgeEraTag,
  type KnowledgeOverview,
  type KnowledgeSourceView,
  type ProfileContract,
  type ProfileVisibility,
} from "@templ/chat/protocol-profile";
import {
  addKnowledge,
  applyProfileImport,
  applyRegistry,
  knowledgeAction,
  readKnowledge,
  readKnowledgeFaq,
  readAiGuidance,
  saveAiGuidance,
  readProfile,
  readProfileContracts,
  saveProfileSettings,
  saveRegistry,
  syncRegistry,
  uploadProfileImport,
  type ImportPreview,
  type ProfileView,
  type KnowledgeFilters,
} from "@/lib/knowledge-client";
import {
  ERA_TEXT,
  QUALITY_COPY as c,
  STATUS_TEXT,
  VISIBILITY_TEXT,
} from "@/lib/copy/quality";
import { CommunityApiError } from "@/lib/community-client";
import { Badge, Callout, Card, Field, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace-quality.module.css";
import sources from "./knowledge-sources.module.css";
import { UnsavedChanges } from "./unsaved-changes";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : c.error;
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The protocol profile in Settings. */
export function WorkspaceProtocol({ context }: { context: WorkspaceContext }) {
  return (
    <div id="protocol-resources" className={styles.stack}>
      <ProfileCard context={context} />
    </div>
  );
}

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
    </div>
  );
}

/** Entries by status: the older products the team keeps for lookups. */
function ContractList({
  context,
  revision,
}: {
  context: WorkspaceContext;
  revision: number;
}) {
  const { room } = context;
  const [status, setStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const readKey = `${room}:${revision}:${status}:${attempt}`;
  const [result, setResult] = useState<{ key: string; contracts: ProfileContract[] | null; error?: string }>();
  const contracts = result?.key === readKey ? result.contracts : null;
  const error = result?.key === readKey ? result.error : undefined;
  useEffect(() => {
    const controller = new AbortController();
    readProfileContracts(
      room,
      { status: status || undefined },
      controller.signal,
    )
      .then(
        (data) => {
          if (controller.signal.aborted) return;
          if (!Array.isArray(data?.contracts)) throw new Error("Contracts could not load.");
          setResult({ key: readKey, contracts: data.contracts });
        },
      )
      .catch(
        () =>
          !controller.signal.aborted && setResult({ key: readKey, contracts: null, error: "Contracts could not load." }),
      );
    return () => controller.abort();
  }, [room, status, readKey]);
  return (
    <>
      <h3 className={styles.subhead}>{c.contractsTitle}</h3>
      <select
        className={ui.input}
        aria-label={c.contractsFilter}
        value={status}
        onChange={(event) => setStatus(event.target.value)}
      >
        <option value="">{c.contractsAll}</option>
        {PROFILE_STATUSES.map((option) => (
          <option key={option} value={option}>
            {STATUS_TEXT[option]}
          </option>
        ))}
      </select>
      {error ? (
        <div>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="button small secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : contracts === null ? (
        <Spinner />
      ) : contracts.length === 0 ? (
        <p className={styles.note}>{c.contractsEmpty}</p>
      ) : (
        <ul className={styles.rows}>
          {contracts.map((contract) => (
            <li
              key={`${contract.network}:${contract.address}`}
              className={styles.row}
            >
              <div className={styles.rowHead}>
                <span>{contract.label}</span>
                <span className={styles.badges}>
                  <Badge>{STATUS_TEXT[contract.status]}</Badge>
                  <Badge>{VISIBILITY_TEXT[contract.visibility]}</Badge>
                </span>
              </div>
              <p
                className={styles.note}
              >{`${contract.address} on ${contract.network}`}</p>
              {contract.staffNote && (
                <p className={styles.note}>{contract.staffNote}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ProfileCard({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const admin = workspaceAdmin(context);
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [registry, setRegistry] = useState<string | null>(null);
  const [sites, setSites] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readProfile(room, controller.signal)
      .then((data) => !controller.signal.aborted && setProfile(data))
      .catch((reason) => !controller.signal.aborted && setError(message(reason)));
    return () => controller.abort();
  }, [room, tick]);
  async function run(task: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const done = await task();
      if (done) setNotice(done);
      setTick((n) => n + 1);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    const parsed = /\.csv$/i.test(file.name) ? parseProfileCsv(text) : parseProfileJson(text);
    setFileErrors(parsed.errors.slice(0, 20).map((row) => c.importRow(row.row, row.reason)));
    if (!parsed.contracts.length) return;
    await run(async () => {
      setPreview(
        await uploadProfileImport(room, account, parsed.contracts, "metrics" in parsed ? parsed.metrics : [], mode),
      );
    });
  }
  if (!profile?.counts)
    return (
      <Card title={c.profileTitle} description={c.profileIntro}>
        {error ? <><p className={styles.error} role="alert">{error}</p><button type="button" className="button secondary"
          onClick={() => { setError(""); setTick(value => value + 1); }}>Try again</button></> : <Spinner />}
      </Card>
    );
  const last = profile.registry?.lastResult;
  const registryDirty = registry !== null && registry !== (profile.registry?.url ?? "");
  const sitesDirty = sites !== null && JSON.stringify(lines(sites)) !== JSON.stringify(profile.officialUrls);
  return (
    <Card title={c.profileTitle} description={c.profileIntro}>
      <UnsavedChanges dirty={registryDirty || sitesDirty || preview !== null} />
      <p className={styles.note}>{c.profileCounts(profile.counts.contracts, profile.counts.metrics, profile.counts.abis)}</p>
      <p className={styles.badges}>
        {PROFILE_STATUSES.filter((status) => profile.counts.byStatus[status]).map((status) => (
          <Badge key={status}>{`${STATUS_TEXT[status]} ${profile.counts.byStatus[status]}`}</Badge>
        ))}
      </p>
      <ContractList context={context} revision={profile.revision} />
      {admin && (
        <>
          <h3 className={styles.subhead}>{c.importTitle}</h3>
          <p className={styles.note}>{c.importHint}</p>
          <div className={styles.actions}>
            <input
              type="file"
              accept=".json,.csv,application/json,text/csv"
              aria-label={c.importTitle}
              disabled={busy}
              onChange={(event) => void pick(event.target.files?.[0])}
            />
            <select className={ui.input} aria-label="Import mode" value={mode} onChange={(event) => setMode(event.target.value as "merge" | "replace")}>
              <option value="merge">{c.importMerge}</option>
              <option value="replace">{c.importReplace}</option>
            </select>
          </div>
          {fileErrors.length > 0 && (
            <ul className={styles.points}>
              {fileErrors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {preview && (
            <div className={styles.review}>
              <p>{c.importDiff(preview.diff.added, preview.diff.changed, preview.diff.unchanged, preview.diff.errors)}</p>
              <button
                type="button"
                className="button small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await applyProfileImport(room, account, preview.importId, preview.mode);
                    setPreview(null);
                    return c.contractsSaved(result.applied);
                  })
                }
              >
                {busy && <Spinner />}
                {c.importApply}
              </button>
            </div>
          )}
          <h3 className={styles.subhead}>{c.registryTitle}</h3>
          <p className={styles.note}>{c.registryHint}</p>
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void run(async () => {
                const result = await saveRegistry(room, account, registry ?? profile.registry?.url ?? null, "daily");
                setProfile(current => current && { ...current, registry: result.registry });
                setRegistry(null);
                return c.saved;
              });
            }}
          >
            <Field label={c.registryUrl}>
              <input
                className={ui.input}
                type="url"
                placeholder="https://"
                value={registry ?? profile.registry?.url ?? ""}
                onChange={(event) => setRegistry(event.target.value)}
              />
            </Field>
            <div className={styles.actions}>
              <button type="submit" className="button small secondary" disabled={busy || !registryDirty}>
                {c.registrySave}
              </button>
              {profile.registry && (
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const { result } = await syncRegistry(room, account);
                      return result.result === "applied"
                        ? c.syncApplied(result.added, result.changed)
                        : result.result === "unchanged"
                          ? c.nothingChanged
                          : undefined;
                    })
                  }
                >
                  {c.registrySync}
                </button>
              )}
            </div>
          </form>
          {last?.result === "paused" && (
            <div className={styles.review}>
              <p>{c.registryPaused(last.changed + last.added + last.missing)}</p>
              <ul className={styles.points}>
                {(last.pending ?? []).slice(0, 10).map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
              <button type="button" className="button small" disabled={busy} onClick={() => void run(async () => {
                await applyRegistry(room, account);
                return c.saved;
              })}>
                {c.registryApply}
              </button>
            </div>
          )}
          <Field label={c.officialSites} hint={c.officialSitesHint}>
            <textarea
              className={ui.input}
              rows={2}
              value={sites ?? profile.officialUrls.join("\n")}
              onChange={(event) => setSites(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="button small secondary"
            disabled={busy || !sitesDirty}
            onClick={() =>
              void run(async () => {
                const result = await saveProfileSettings(room, account, { officialUrls: lines(sites ?? "") });
                setProfile(current => current && { ...current, ...result });
                setSites(null);
                return c.saved;
              })
            }
          >
            {c.saveSites}
          </button>
        </>
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
    </Card>
  );
}

type Adding = "doc" | "sitemap" | "faq" | "file" | null;
function KnowledgeCard({ context }: { context: WorkspaceContext }) {
  const { room, account, manager } = context;
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
  const [adding, setAdding] = useState<Adding>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [era, setEra] = useState<KnowledgeEraTag>("current");
  const [visibility, setVisibility] =
    useState<ProfileVisibility>("member-safe");
  const [addresses, setAddresses] = useState("");
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
  function submit(event: FormEvent) {
    event.preventDefault();
    const tags = {
      era,
      visibility,
      ...(era === "legacy" ? { addresses: lines(addresses) } : {}),
    };
    void run(async () => {
      if (adding === "doc")
        await addKnowledge(room, account, { action: "add-doc", url, ...tags });
      else if (adding === "faq")
        await addKnowledge(room, account, {
          action: "add-faq",
          title,
          text,
          ...tags,
        });
      else if (adding === "sitemap") {
        const result = (await addKnowledge(room, account, {
          action: "add-sitemap",
          url,
          ...tags,
        })) as {
          added: number;
        };
        setAdding(null);
        if (result.added > 0) trackEvent("brain_source_added");
        return c.sitemapAdded(result.added);
      }
      setAdding(null);
      setUrl("");
      trackEvent("brain_source_added");
      setTitle("");
      setText("");
      setAddresses("");
      return c.saved;
    });
  }
  function cancelAdding() {
    if (
      (url || title || text || addresses) &&
      !window.confirm("Discard this new source?")
    )
      return;
    setAdding(null);
    setUrl("");
    setTitle("");
    setText("");
    setAddresses("");
  }
  return (
    <Card
      id="company-brain"
      title={c.knowledgeTitle}
      description={c.knowledgeDescription}
      actions={
        editable ? (
          <button
            type="button"
            className="button small secondary"
            disabled={
              busy || loadingMore || editing !== null || adding !== null
            }
            onClick={() => setAdding("doc")}
          >
            {c.addSource}
          </button>
        ) : undefined
      }
    >
      <UnsavedChanges
        dirty={
          (guidanceDraft !== null && guidanceDraft !== guidance) ||
          Boolean(adding && (url || title || text || addresses))
        }
      />
      <Callout tone="warning">{c.knowledgeWarning}</Callout>
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
      {manager && (
        <BrainStoragePanel
          key={`${room}:${account}:${context.revision}`}
          context={context}
          revision={tick}
        />
      )}
      {adding && (
        <div className={styles.review}>
          <Field label={c.sourceType}>
            <select
              className={ui.input}
              value={adding}
              disabled={busy}
              onChange={(event) =>
                setAdding(event.target.value as Exclude<Adding, null>)
              }
            >
              <option value="doc">Docs page</option>
              <option value="faq">FAQ entry</option>
              <option value="sitemap">Sitemap</option>
              <option value="file">File</option>
            </select>
          </Field>
          {adding === "file" ? (
            <SupportFileImport
              context={context}
              kind="knowledge"
              onImported={() => setTick((value) => value + 1)}
            />
          ) : (
            <form className={styles.fields} onSubmit={submit}>
              {adding === "faq" ? (
                <>
                  <Field label={c.question}>
                    <input
                      className={ui.input}
                      value={title}
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </Field>
                  <Field label={c.answer}>
                    <textarea
                      className={ui.input}
                      rows={4}
                      maxLength={4000}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Field label={c.pageUrl}>
                  <input
                    className={ui.input}
                    type="url"
                    placeholder="https://"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </Field>
              )}
              <div className={sources.filters}>
                <Field label="Product version">
                  <select
                    className={ui.input}
                    value={era}
                    onChange={(event) =>
                      setEra(event.target.value as KnowledgeEraTag)
                    }
                  >
                    {KNOWLEDGE_ERAS.map((option) => (
                      <option key={option} value={option}>
                        {ERA_TEXT[option]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Who may see it">
                  <select
                    className={ui.input}
                    value={visibility}
                    onChange={(event) =>
                      setVisibility(event.target.value as ProfileVisibility)
                    }
                  >
                    {PROFILE_VISIBILITY.map((option) => (
                      <option key={option} value={option}>
                        {VISIBILITY_TEXT[option]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {era === "legacy" && (
                <Field label={c.addresses} hint={c.addressesHint}>
                  <textarea
                    className={ui.input}
                    rows={2}
                    value={addresses}
                    onChange={(event) => setAddresses(event.target.value)}
                  />
                </Field>
              )}
              <div className={styles.actions}>
                <button type="submit" className="button small" disabled={busy}>
                  {busy && <Spinner />}
                  {adding === "faq"
                    ? c.addFaq
                    : adding === "sitemap"
                      ? c.addSitemap
                      : c.addPage}
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  onClick={cancelAdding}
                >
                  {c.cancel}
                </button>
              </div>
            </form>
          )}
          {adding === "file" && (
            <button
              type="button"
              className="button small secondary"
              onClick={cancelAdding}
            >
              {c.cancel}
            </button>
          )}
        </div>
      )}
      <details>
        <summary>Source updates</summary>
        <ul className={styles.points}>
          {c.knowledgePoints.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </details>
      <div className={sources.toolbar}>
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
      </div>
      {!data ? (
        error ? null : (
          <Spinner />
        )
      ) : data.sources.length === 0 ? (
        <p className={styles.note}>
          {filters.q || filters.kind || filters.status
            ? "No sources match these filters."
            : "No sources yet. Add a docs page, file or FAQ."}
        </p>
      ) : (
        <ul className={sources.list} aria-label="AI sources">
          {data.sources.map((source) => (
            <li key={source.id} className={sources.source}>
              <div className={styles.rowHead}>
                <strong>{source.title}</strong>
                <span className={styles.badges}>
                  <Badge>{ERA_TEXT[source.era]}</Badge>
                  <Badge>{VISIBILITY_TEXT[source.visibility]}</Badge>
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
                <details>
                  <summary>Review conflicting passages</summary>
                  <p className={styles.note}>
                    A human answer differs from these passages. This source is unchanged and still available to AI.
                  </p>
                  {source.possiblyOutdated.map((conflict) => (
                    <div key={`${conflict.entryId}:${conflict.quote}`}>
                      <blockquote>{conflict.quote}</blockquote>
                      <p className={styles.note}>{conflict.reason}</p>
                    </div>
                  ))}
                </details>
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
                        adding !== null ||
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
