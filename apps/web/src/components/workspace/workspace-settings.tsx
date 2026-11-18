"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

// Saved-reply imports with a server preview.
// The settings form keeps its own state and existing controls.
import { SupportFileImport } from "./support-file-import";
import { FollowUpRoutingSettings } from "@/components/follow-up-routing-settings";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  type SupportSavedReply,
  type SupportSettings,
} from "@templ/chat/support";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import {
  Callout,
  Card,
  Field,
  PageHeader,
  Skeleton,
  Spinner,
  ui,
} from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import { WorkspaceAlerts } from "./workspace-alerts";
import { WorkspaceDeletionSection } from "./workspace-deletion";
import { WorkspaceExport } from "./workspace-export";
import styles from "./workspace.module.css";
import layout from "./workspace-settings.module.css";
import { ImprovementCopyCard } from "./improvement-copy";
import { TeamDisplayName } from "./team-display-name";
import { WorkspacePrioritySettings } from "./priority-settings";
import { WorkspaceManagement } from "./workspace-management";
import { UnsavedChanges } from "./unsaved-changes";
import { WorkspaceSections } from "./workspace-sections";
import { CategoryRule } from "./category-rule";
import { WorkspaceIcon } from "./workspace-icon";

type Loaded = {
  key: string;
  settings?: SupportSettings;
  canEdit?: boolean;
  error?: string;
};

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

export function WorkspaceSettings({ context }: { context: WorkspaceContext }) {
  if (
    !canManageWorkspace({
      isManager: context.manager,
      permissions: context.state?.viewer?.permissions,
    })
  )
    return (
      <div className={`${styles.page} ${styles.pageNarrow} ${layout.page}`}>
        <PageHeader eyebrow="Settings" title="Workspace settings" />
        <div className={layout.sections}>
          <TeamDisplayName
            key={`${context.room}:${context.account}`}
            context={context}
          />
          <WorkspaceManagement context={context} />
          {context.state?.viewer?.permissions.includes("manageSupport") && (
            <TeamSavedReplies
              key={`${context.room}:${context.account}`}
              context={context}
            />
          )}
        </div>
      </div>
    );
  return <WorkspaceConfiguration context={context} />;
}

function TeamSavedReplies({ context }: { context: WorkspaceContext }) {
  const [attempt, setAttempt] = useState(0);
  const readKey = `${context.room}:${context.account}:${attempt}`;
  const [record, setResult] = useState<{
    key: string;
    replies: SupportSavedReply[];
    error?: string;
  }>();
  const result = record?.key === readKey ? record : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void communityFetch<{ replies: SupportSavedReply[] }>(
      roomPath(context.room, "conversations/saved-replies"),
      undefined,
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key: readKey, ...data });
      },
      () => {
        if (!controller.signal.aborted)
          setResult({
            key: readKey,
            replies: [],
            error: "Saved replies could not load.",
          });
      },
    );
    return () => controller.abort();
  }, [context.room, readKey]);
  if (!result) return <Skeleton height={80} />;
  if (result.error)
    return (
      <Card id="saved-replies" title="Saved replies">
        <Callout tone="danger" role="alert">
          {result.error}
        </Callout>
        <button
          type="button"
          className="button secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      </Card>
    );
  return <SavedReplies context={context} initial={result.replies} />;
}

function WorkspaceConfiguration({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const [attempt, setAttempt] = useState(0);
  const key = `${room}:${account}:${attempt}`;
  const [loaded, setLoaded] = useState<Loaded>();
  const current = loaded?.key === key ? loaded : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void communityFetch<{
      settings: SupportSettings;
      canEditSettings: boolean;
    }>(
      roomPath(room, "conversations/settings"),
      undefined,
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            settings: data.settings,
            canEdit: data.canEditSettings,
          });
      },
      () => {
        if (!controller.signal.aborted)
          setLoaded({ key, error: "Settings could not load." });
      },
    );
    return () => controller.abort();
  }, [room, key, attempt]);

  const prioritiesEnabled = context.state?.features?.priorityFeed === true;

  return (
    <div className={`${styles.page} ${styles.pageNarrow} ${layout.page}`}>
      <PageHeader
        eyebrow="Settings"
        title="Workspace settings"
        description="Choose what users see and how your team answers cases."
      />
      <WorkspaceSections
        items={[
          { id: "workspace-general", label: "Workspace" },
          { id: "case-settings", label: "Case handling" },
          ...(prioritiesEnabled
            ? [{ id: "priority-settings", label: "Priorities" }]
            : []),
          { id: "saved-replies", label: "Saved replies" },
          { id: "alerts", label: "Alerts" },
          ...(context.manager
            ? [{ id: "workspace-manager", label: "Ownership" }]
            : []),
        ]}
      />
      <div className={layout.sections}>
        <div id="workspace-general" className={layout.sections}>
          <TeamDisplayName
            key={`team-name:${room}:${account}`}
            context={context}
          />
          <WorkspaceName context={context} />
          {context.workspace.visibility === "public" && (
            <WorkspaceIcon context={context} />
          )}
        </div>
        {!current ? (
          <Card title="Hours and cases">
            <div className={styles.stack} style={{ gap: 12 }}>
              <Skeleton height={42} />
              <Skeleton height={42} />
              <Skeleton height={42} />
            </div>
          </Card>
        ) : current.error || !current.settings ? (
          <div>
            <Callout tone="danger" role="alert">
              {current.error ?? "Settings could not load."}
            </Callout>
            <button
              type="button"
              className="button secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <SupportSettingsForm
              key={key}
              context={context}
              initial={current.settings}
              canEdit={current.canEdit === true}
            />
            {context.state?.features?.quality === true && (
              <CategoryRule context={context} />
            )}
            <TeamSavedReplies key={`replies:${key}`} context={context} />
            <WorkspacePrioritySettings context={context} />
            {/* The workspace export and deletion sections. */}
            <WorkspaceExport
              room={context.room}
              account={context.account}
              manager={context.manager}
              enabled={context.state?.features?.workspaceExport === true}
            />
            {/* Team alert destinations. */}
            <WorkspaceAlerts key={`alerts:${key}`} context={context} />
            {/* Follow-up routing settings. */}
            <FollowUpRoutingSettings
              key={`follow-ups:${key}`}
              context={context}
            />
            {/* Templ's improvement copy, counts only. */}
            <ImprovementCopyCard key={`corpus:${key}`} room={context.room} />
            <WorkspaceManagement context={context} />
            <WorkspaceDeletionSection
              room={context.room}
              account={context.account}
              name={context.workspace.name}
              manager={context.manager}
              exportLive={context.state?.features?.workspaceExport === true}
              onScheduled={context.reload}
            />
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceName({ context }: { context: WorkspaceContext }) {
  const { room, account, workspace } = context;
  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const trimmed = name.trim();
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || trimmed === savedName || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await chatMutation(account as never, roomPath(room, "profile"), {
        name: trimmed,
      });
      setNotice("Name saved.");
      setSavedName(trimmed);
      context.reload();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The name could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={trimmed !== savedName} />
      <Card
        bodyClassName={layout.panelBody}
        id="workspace-name"
        title="Workspace name"
        description="Your users see it in the widget header and on the support page. Use your protocol’s name."
        footer={
          <>
            <span className={styles.small}>
              {notice && (
                <span className={layout.feedback} role="status">
                  {notice}
                </span>
              )}
              {error && (
                <span className={layout.feedback} role="alert">
                  {error}
                </span>
              )}
            </span>
            <button
              type="submit"
              className="button"
              disabled={!trimmed || trimmed === savedName || busy}
            >
              {busy && <Spinner />}Save name
            </button>
          </>
        }
      >
        <Field label="Name">
          <input
            className={ui.input}
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </Card>
    </form>
  );
}

function SupportSettingsForm({
  context,
  initial,
  canEdit,
}: {
  context: WorkspaceContext;
  initial: SupportSettings;
  canEdit: boolean;
}) {
  const { room, account } = context;
  const [settings, setSettings] = useState(initial);
  const [categories, setCategories] = useState(initial.categories.join("\n"));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const zones = useMemo(timeZones, []);
  const values = {
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    acknowledgment: settings.acknowledgment,
    categories: categories
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  };
  const [savedValues, setSavedValues] = useState(() =>
    JSON.stringify({
      timezone: initial.timezone,
      businessHours: initial.businessHours,
      acknowledgment: initial.acknowledgment,
      categories: initial.categories,
    }),
  );
  const dirty = JSON.stringify(values) !== savedValues;
  const edit = <K extends keyof SupportSettings>(
    name: K,
    value: SupportSettings[K],
  ) => {
    setSettings((previous) => ({ ...previous, [name]: value }));
    setConfirmed(false);
    setNotice("");
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !dirty || !confirmed || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await chatMutation(
        account as never,
        roomPath(room, "conversations/settings"),
        {
          ...values,
          confirmed,
        },
      );
      setConfirmed(false);
      setNotice("Settings saved.");
      setSavedValues(JSON.stringify(values));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The settings could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={dirty} />
      <Card
        bodyClassName={layout.panelBody}
        id="case-settings"
        title="Case handling"
        description="All optional. Users see your hours and first-response note beside their case."
        footer={
          canEdit ? (
            <>
              <label className={ui.check}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!dirty}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I checked these settings.
              </label>
              <button
                type="submit"
                className="button"
                disabled={!dirty || !confirmed || busy}
              >
                {busy && <Spinner />}Save settings
              </button>
            </>
          ) : undefined
        }
      >
        <fieldset
          disabled={!canEdit || busy}
          className={styles.formGrid}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <div className={styles.formGrid2}>
            <Field label="Business hours" optional>
              <input
                className={ui.input}
                value={settings.businessHours}
                placeholder="Monday to Friday, 09:00 to 18:00"
                maxLength={500}
                onChange={(event) => edit("businessHours", event.target.value)}
              />
            </Field>
            <Field label="Timezone">
              <input
                className={ui.input}
                list="templ-time-zones"
                value={settings.timezone}
                placeholder="UTC"
                maxLength={80}
                onChange={(event) => edit("timezone", event.target.value)}
              />
              <datalist id="templ-time-zones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field
            label="First-response note"
            optional
            hint="Shown to users beside their case, for example when to expect a reply."
          >
            <textarea
              className={ui.input}
              value={settings.acknowledgment}
              maxLength={1000}
              rows={3}
              placeholder="We reply during the business hours shown here."
              onChange={(event) => edit("acknowledgment", event.target.value)}
            />
          </Field>
          <div className={styles.formGrid2}>
            <Field
              label="Case categories"
              optional
              hint="One per line. Choose one category per case. Add tags in case details."
            >
              <textarea
                className={ui.input}
                value={categories}
                rows={5}
                onChange={(event) => {
                  setCategories(event.target.value);
                  setConfirmed(false);
                  setNotice("");
                }}
              />
            </Field>
          </div>
          {dirty && !notice && (
            <p className={layout.unsaved} role="status">
              Unsaved changes.
            </p>
          )}
          {notice && (
            <p className={layout.feedback} role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className={layout.feedback} role="alert">
              {error}
            </p>
          )}
        </fieldset>
      </Card>
    </form>
  );
}

function SavedReplies({
  context,
  initial,
}: {
  context: WorkspaceContext;
  initial: SupportSavedReply[];
}) {
  const { room, account } = context;
  const [replies, setReplies] = useState(initial);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<SupportSavedReply | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = editing
    ? title !== editing.title || text !== editing.text
    : Boolean(title || text);
  async function mutate(body: object, marker: string) {
    setBusy(marker);
    setError("");
    setNotice("");
    try {
      const result = await chatMutation<{ replies: SupportSavedReply[] }>(
        account as never,
        roomPath(room, "conversations/saved-replies"),
        body,
      );
      setReplies(result.replies);
      setNotice("Saved replies updated.");
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The saved reply could not change.",
      );
      return false;
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card
      id="saved-replies"
      bodyClassName={layout.panelBody}
      title="Saved replies"
      description="Answers your team sends often. Staff insert them from the case details and can edit before sending."
    >
      <div className={styles.stack} style={{ gap: 16 }}>
        <UnsavedChanges dirty={dirty} />
        {notice && (
          <p className={layout.feedback} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className={layout.feedback} role="alert">
            {error}
          </p>
        )}
        {/* Preview and confirm saved-reply imports. */}
        {/* A completed import refreshes the saved replies through the current-access route. */}
        {(context.manager ||
          context.state.viewer?.permissions.includes("manageSupport")) && (
          <SupportFileImport
            context={context}
            kind="saved-replies"
            onImported={() => {
              void communityFetch<{ replies: SupportSavedReply[] }>(
                roomPath(room, "conversations/saved-replies"),
              )
                .then((result) => setReplies(result.replies))
                .catch(() => setError("Saved replies could not reload."));
            }}
          />
        )}
        {replies.length > 0 ? (
          <ul className={styles.replyList}>
            {replies.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </div>
                <div className={styles.row}>
                  {removing === item.id ? (
                    <div>
                      <p>Delete “{item.title}”? You cannot undo this.</p>
                      <div className={styles.row}>
                        <button
                          type="button"
                          className="button small"
                          disabled={busy !== null}
                          onClick={() =>
                            void mutate(
                              { id: item.id, remove: true },
                              item.id,
                            ).then((saved) => {
                              if (!saved) return;
                              setRemoving(null);
                              if (editing?.id === item.id) {
                                setEditing(null);
                                setTitle("");
                                setText("");
                              }
                            })
                          }
                        >
                          {busy === item.id && <Spinner />}Delete reply
                        </button>
                        <button
                          type="button"
                          className="button small secondary"
                          disabled={busy !== null}
                          onClick={() => setRemoving(null)}
                        >
                          Keep reply
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="button small quiet"
                        aria-label={`Edit ${item.title}`}
                        disabled={busy !== null}
                        onClick={() => {
                          if (
                            dirty &&
                            !window.confirm("Discard your unsaved reply?")
                          )
                            return;
                          setEditing(item);
                          setTitle(item.title);
                          setText(item.text);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button small quiet"
                        aria-label={`Delete ${item.title}`}
                        disabled={busy !== null}
                        onClick={() => setRemoving(item.id)}
                      >
                        {busy === item.id ? (
                          <Spinner />
                        ) : (
                          <IconTrash aria-hidden="true" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>No saved replies yet.</p>
        )}
        <form
          className={styles.formGrid}
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim() || !text.trim()) return;
            void mutate(
              { ...(editing ? { id: editing.id } : {}), title, text },
              "new",
            ).then((saved) => {
              if (saved) {
                setEditing(null);
                setTitle("");
                setText("");
              }
            });
          }}
        >
          <Field label="Title">
            <input
              className={ui.input}
              maxLength={100}
              value={title}
              placeholder="Deposit not showing"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Reply">
            <textarea
              className={ui.input}
              maxLength={4000}
              rows={4}
              value={text}
              placeholder="Share the transaction hash and network so we can check it."
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <div>
            <button
              type="submit"
              className="button secondary"
              disabled={busy !== null || !title.trim() || !text.trim()}
            >
              {busy === "new" ? <Spinner /> : <IconPlus aria-hidden="true" />}
              {editing ? "Save reply" : "Add saved reply"}
            </button>
            {editing && (
              <button
                type="button"
                className="button secondary"
                disabled={busy !== null}
                onClick={() => {
                  if (dirty && !window.confirm("Discard your unsaved reply?"))
                    return;
                  setEditing(null);
                  setTitle("");
                  setText("");
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </div>
    </Card>
  );
}
