"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  type SupportSettings,
  type WorkspaceSupportProfiles,
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
import { WorkspaceManagement } from "./workspace-management";
import { UnsavedChanges } from "./unsaved-changes";
import { WorkspaceSections } from "./workspace-sections";
import { CategoryRule } from "./category-rule";
import { WorkspaceIcon } from "./workspace-icon";
import { SupportProfiles } from "./support-profiles";

import { PersonalSettings } from "@/components/personal-settings";

type Loaded = {
  key: string;
  settings?: SupportSettings;
  supportProfiles?: WorkspaceSupportProfiles;
  responderConfigured?: boolean;
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
      <div data-workspace-settings="" className={`${styles.page} ${styles.pageNarrow} ${layout.page}`}>
        <PageHeader eyebrow="Settings" title="Workspace settings" />
        <div className={layout.sections}>
          <TeamDisplayName
            key={`${context.room}:${context.account}`}
            context={context}
          />
          <PersonalSettings />
          <WorkspaceManagement context={context} />
        </div>
      </div>
    );
  return <WorkspaceConfiguration context={context} />;
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
      supportProfiles?: WorkspaceSupportProfiles;
      responderConfigured?: boolean;
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
            supportProfiles: data.supportProfiles,
            responderConfigured: data.responderConfigured,
          });
      },
      () => {
        if (!controller.signal.aborted)
          setLoaded({ key, error: "Settings could not load." });
      },
    );
    return () => controller.abort();
  }, [room, key, attempt]);


  return (
    <div data-workspace-settings="" className={`${styles.page} ${styles.pageNarrow} ${layout.page}`}>
      <PageHeader
        title="Workspace settings"
      />
      <WorkspaceSections
        items={[
          { id: "workspace-general", label: "Workspace" },
          ...(current?.canEdit ? [{ id: "support-profiles", label: "Chat profiles" }] : []),
          { id: "case-settings", label: "Reply hours" },
          { id: "alerts", label: context.state?.features?.nativeTelegram ? "Telegram and alerts" : "Alerts" },
          ...(context.manager
            ? [{ id: "workspace-manager", label: "Ownership" }]
            : []),
          { id: "appearance-help", label: "Appearance and help" },
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
          <Card title="Reply hours">
            <div className={styles.stack} style={{ gap: 12 }}>
              <Skeleton height={42} />
              <Skeleton height={42} />
              <Skeleton height={42} />
            </div>
          </Card>
        ) : current.error || !current.settings ? (
          <div className={layout.panelBody}>
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
            {current.canEdit && <SupportProfiles key={key + ":profiles"} context={context}
              initial={current.supportProfiles} connected={current.responderConfigured === true} />}
            <SupportSettingsForm
              key={key}
              context={context}
              initial={current.settings}
              canEdit={current.canEdit === true}
            />
            {context.state?.features?.quality === true && (
              <CategoryRule context={context} />
            )}
            <WorkspaceExport
              room={context.room}
              account={context.account}
              manager={context.manager}
              enabled={context.state?.features?.workspaceExport === true}
            />
            <WorkspaceAlerts key={`alerts:${key}`} context={context} />
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
        <PersonalSettings />
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
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const zones = useMemo(timeZones, []);
  const values = {
    timezone: settings.timezone,
    businessHours: settings.businessHours,
    acknowledgment: settings.acknowledgment,
  };
  const [savedValues, setSavedValues] = useState(() =>
    JSON.stringify({
      timezone: initial.timezone,
      businessHours: initial.businessHours,
      acknowledgment: initial.acknowledgment,
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
        title="Reply hours"
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
