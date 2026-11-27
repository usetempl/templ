"use client";
import { trackEvent } from "@/lib/analytics";

import { useEffect, useState, type FormEvent } from "react";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { hasSupportKnowledge } from "@templ/chat/workspace-flags";
import {
  SUPPORT_AI_MODES,
  type SupportAiMode,
  type SupportSettings,
} from "@templ/chat/support";
import { isBillingView } from "@/lib/product-offer";
import { copy as t, type MessageKey } from "@/lib/copy";
import { aiDraftModeLabel } from "@/lib/copy/room";
import { offersHostedNames, recoverHostedName } from "./hosted-chat-name";
import { useWorkspaceHash, useWorkspaceSectionFocus } from "./workspace-sections";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { ManagedAgentSettings } from "@/components/managed-agent-settings";
import {
  Badge,
  Callout,
  Card,
  Field,
  PageHeader,
  Skeleton,
  Spinner,
  ui,
} from "@/components/ui/ui";
import { WorkspaceKnowledge } from "./workspace-protocol";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import layout from "./workspace-settings.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export const AI_AGENT_SECTION = "ai-agent";
const MODE_LABELS: Record<SupportAiMode, MessageKey> = {
  answers: "room.ai.answers",
  drafts: "room.ai.drafts",
  off: "room.ai.off",
};
const MODE_HINTS: Record<SupportAiMode, string> = {
  answers: "An AI agent with case access may reply to the user.",
  drafts: t("room.ai.draftsHint"),
  off: t("room.ai.offHint"),
};
const isMode = (value: string): value is SupportAiMode =>
  SUPPORT_AI_MODES.includes(value as SupportAiMode);

export function WorkspaceAi({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const [defaultMode, setDefaultMode] = useState<SupportAiMode>();
  const admin = canManageWorkspace(
    {
      isManager: context.manager,
      permissions: context.state?.viewer?.permissions,
    },
    context.state?.bots?.some((bot) => bot.principalId === account),
  );
  const [nameError, setNameError] = useState(false);
  const product = context.state?.product;
  const paid = product && isBillingView(product) && product.standardPlan?.status === "paid";
  const hasHostedName = context.workspace?.hostedName;
  const activating = useWorkspaceHash() === "#managed-ai";
  useWorkspaceSectionFocus([AI_AGENT_SECTION, "managed-ai"]);
  useEffect(() => {
    if (!activating || !offersHostedNames || hasHostedName || !context.manager || !paid || !account) return;
    const controller = new AbortController();
    void recoverHostedName(room, account, true, controller.signal).then(
      () => { if (!controller.signal.aborted) setNameError(false); },
      () => { if (!controller.signal.aborted) setNameError(true); },
    );
    return () => controller.abort();
  }, [room, account, context.manager, paid, hasHostedName, activating]);
  const knowledge = hasSupportKnowledge(context.state?.features);
  return (
    <div data-workspace-settings="" className={`${styles.page} ${styles.pageNarrow} ${layout.page}`}>
      <PageHeader title="Support AI" actions={admin && context.state?.features?.nativeTelegram && (
        <button type="button" className="button secondary" onClick={() => context.go("settings", null, "alerts")}>
          Telegram handoffs
        </button>
      )} />
      {activating && nameError && <Callout role="alert">Your hosted name could not be confirmed.{" "}
        <button type="button" className="button secondary" onClick={() => context.go("home")}>Check your chat link</button>
      </Callout>}
      <div className={layout.sections}>
        {knowledge && <WorkspaceKnowledge key={`sources:${room}:${account}:${admin}`} context={context} />}
        {!admin && (
          <p className={styles.small}>
            A workspace admin can add sources and change AI instructions.
          </p>
        )}
        {!knowledge && (
          <Callout>
            AI sources are not available in this workspace.
          </Callout>
        )}
        {admin && (
          <AiConfiguration
            key={`configuration:${room}:${account}`}
            context={context}
            onMode={setDefaultMode}
          />
        )}
        {admin && context.state?.features?.managedAgent === true && (
          <ManagedAgentSettings
            key={`managed:${room}:${account}`}
            context={context}
            defaultMode={defaultMode}
          />
        )}
      </div>
    </div>
  );
}

function AiConfiguration({
  context,
  onMode,
}: {
  context: WorkspaceContext;
  onMode: (mode: SupportAiMode) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    settings: SupportSettings;
    canEditSettings: boolean;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void communityFetch<{
      settings: SupportSettings;
      canEditSettings: boolean;
    }>(
      roomPath(context.room, "conversations/settings"),
      undefined,
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted) {
          setLoaded(data);
          setError("");
          onMode(data.settings.aiDefault ?? "answers");
        }
      },
      (reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "AI settings could not load.",
          );
      },
    );
    return () => controller.abort();
  }, [context.room, attempt, onMode]);
  if (error)
    return (
      <div className={layout.panelBody}>
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
        <button
          type="button"
          className="button secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );
  if (!loaded)
    return (
      <Card title="AI agent">
        <Skeleton height={80} />
      </Card>
    );
  return (
      <AiDefaultSettings
        context={context}
        initial={loaded.settings}
        canEdit={loaded.canEditSettings === true}
        onSaved={onMode}
      />
  );
}

function AiDefaultSettings({
  context,
  initial,
  canEdit,
  onSaved,
}: {
  context: WorkspaceContext;
  initial: SupportSettings;
  canEdit: boolean;
  onSaved: (mode: SupportAiMode) => void;
}) {
  const initialMode =
    initial.aiDefault && isMode(initial.aiDefault)
      ? initial.aiDefault
      : "answers";
  const [mode, setMode] = useState<SupportAiMode>(initialMode);
  const [savedMode, setSavedMode] = useState(initialMode);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = mode !== savedMode;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !confirmed || !dirty || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await chatMutation(
        context.account,
        roomPath(context.room, "conversations/settings"),
        { aiDefault: mode, confirmed },
      );
      setConfirmed(false);
      setNotice("AI settings saved.");
      trackEvent("ai_settings_saved");
      setSavedMode(mode);
      onSaved(mode);
    } catch (reason) {
      trackEvent("ai_settings_failed");
      setError(
        reason instanceof Error
          ? reason.message
          : "AI settings could not save.",
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
        id={AI_AGENT_SECTION}
        title="AI agent"
        actions={context.state.bots.length > 0 && (
          <Badge tone={savedMode === "off" ? "neutral" : "brand"} dot>
            {savedMode === "answers" ? "Answers on" : savedMode === "drafts" ? "Drafts only" : "Replies off"}
          </Badge>
        )}
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
                I checked AI settings.
              </label>
              <button
                type="submit"
                className="button"
                disabled={!confirmed || !dirty || busy}
              >
                {busy && <Spinner />}Save AI settings
              </button>
            </>
          ) : undefined
        }
      >
        {context.state.bots.length === 0 && (
          <Callout>
            <p>
              No AI agent is connected. Choose your agent on Team.
              {context.state.features?.managedAgent === true &&
                " You can also set up Templ AI below."}
            </p>
            <button
              type="button"
              className="button small secondary"
              onClick={() => context.go("team")}
            >
              Open Team
            </button>
          </Callout>
        )}
        <fieldset
          disabled={!canEdit || busy}
          className={styles.formGrid}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <Field
            label="New cases start with"
            hint={`${MODE_HINTS[mode]} Your team can change this in a conversation.`}
          >
            <select
              className={ui.input}
              value={mode}
              onChange={(event) => {
                if (isMode(event.target.value)) {
                  setMode(event.target.value);
                  setConfirmed(false);
                  setNotice("");
                }
              }}
            >
              {SUPPORT_AI_MODES.map((item) => (
                <option key={item} value={item}>
                  {item === "drafts"
                    ? aiDraftModeLabel(
                        context.state?.features?.aiDrafts === true,
                      )
                    : t(MODE_LABELS[item])}
                </option>
              ))}
            </select>
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
