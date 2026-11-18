"use client";

import { useRelease } from "@/lib/release-context";
import { WidgetInstallCheck } from "./widget-install-check";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconBook, IconCircleCheck } from "@tabler/icons-react";
import {
  communityFetch,
  roomPath,
  COMMUNITY_API,
} from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { trackEvent } from "@/lib/analytics";

import { SITE } from "@/lib/site-environment";
import { installPrompt } from "@/lib/support-integration-prompt";
import { installFamilies } from "@/lib/install-families";
import {
  checkedWidgetAppearance,
  type WidgetAppearance,
} from "@templ/chat/widget-appearance";
import { WidgetAppearanceEditor } from "./widget-appearance-editor";
import { SUPPORT_WIDGET_LATEST_PATH } from "@/lib/support-widget-release";
import type { SupportMinimumLevel } from "@templ/chat/support";
import { IntegrationPrompt } from "@/components/pages/landing/integration-prompt";
import { SupportLink } from "@/components/team-conversations";
import {
  Callout,
  Card,
  CopyBlock,
  CopyInline,
  PageHeader,
  Skeleton,
  Spinner,
} from "@/components/ui/ui";
import controls from "@/components/ui/design-system.module.css";
import type { WorkspaceContext } from "./support-workspace";
import { UnsavedChanges } from "./unsaved-changes";
import { readWidgetAppearanceDraft } from "@/lib/support-local-state";
import { WidgetSessionSettings } from "./widget-session-settings";
import { WidgetJourneySettings } from "./widget-journey-settings";
import { WidgetIntroSettings } from "./widget-intro-settings";
import { WidgetSafetyLine } from "./widget-safety-line";
import { WidgetFrameMode } from "./widget-frame-mode";
import { WidgetVerifiedDomain } from "./widget-verified-domain";
import styles from "./workspace.module.css";

const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
/** The widget's title: the workspace name, with "support" added only when
 * the name doesn't already end with it. */
export const supportLabel = (name: string) => {
  const trimmed = name.trim();
  return /(^|\s)support$/i.test(trimmed) ? trimmed : `${trimmed} support`;
};

const LEVELS: { value: SupportMinimumLevel; label: string; hint: string }[] = [
  {
    value: "anyone",
    label: "Anyone, including guests",
    hint: "People can ask without a wallet.",
  },
  {
    value: "connected",
    label: "Attached wallet or better",
    hint: "Your app reports a wallet. It does not prove ownership.",
  },
  {
    value: "signed",
    label: "Verified wallet only",
    hint: "They sign a message first to prove the wallet is theirs.",
  },
];

export function WorkspaceWidget({
  context,
  installCheck = context.state?.features?.installCheck === true,
}: {
  context: WorkspaceContext;
  installCheck?: boolean;
}) {
  const RELEASE = useRelease();

  const { room, account, id, go } = context;
  const scope = `${room}:${account ?? "signed-out"}`;
  const currentScope = useRef(scope);
  const [appearance, setAppearance] = useState<WidgetAppearance>({});
  const [savedAppearance, setSavedAppearance] = useState<WidgetAppearance>({});
  const [appearanceRevision, setAppearanceRevision] = useState(0);
  const [appearanceAvailable, setAppearanceAvailable] = useState(false);
  const [appearanceSaving, setAppearanceSaving] = useState<string>();
  const [appearanceFeedback, setAppearanceFeedback] = useState<{
    scope: string;
    error?: string;
    saved?: boolean;
  }>();
  const [savedLevel, setSavedLevel] = useState<SupportMinimumLevel | null>(
    null,
  );
  const [level, setLevel] = useState<SupportMinimumLevel>("anyone");
  const [levelConfirmed, setLevelConfirmed] = useState(false);
  const [levelBusy, setLevelBusy] = useState(false);
  const [levelError, setLevelError] = useState("");
  const [levelNotice, setLevelNotice] = useState("");
  const [loopback, setLoopback] = useState(false);
  // A failed read shows with a retry, never as the "anyone" default.
  const [readError, setReadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [appearanceScope, setAppearanceScope] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    currentScope.current = scope;
    setSavedLevel(null);
    setLevelConfirmed(false);
    setLevelError("");
    setLevelNotice("");
    setAppearanceScope("");
    void communityFetch<{
      minimumLevel?: SupportMinimumLevel;
      options?: { loopback?: boolean; appearance?: boolean };
      appearance?: WidgetAppearance | null;
      appearanceRevision?: number;
      appearanceUnavailable?: boolean;
    }>(roomPath(room, "widget"), undefined, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const saved = checkedWidgetAppearance(data.appearance ?? null) ?? {};
        const draft =
          data.appearance === undefined
            ? readWidgetAppearanceDraft(room, account)
            : undefined;
        const initial: WidgetAppearance = draft
          ? {
              theme: draft.theme,
              ...(draft.colorMode === "pair"
                ? {
                    accent: {
                      light: draft.lightAccent,
                      dark: draft.darkAccent,
                    },
                  }
                : isHex(draft.customAccent)
                  ? { accent: draft.customAccent }
                  : {}),
              radius: draft.radius,
              position: draft.position,
            }
          : saved;
        setAppearance(initial);
        setSavedAppearance(saved);
        setAppearanceRevision(data.appearanceRevision ?? 0);
        setAppearanceAvailable(
          data.options?.appearance === true &&
            data.appearanceUnavailable !== true,
        );
        setAppearanceScope(scope);
        setAppearanceFeedback(undefined);
        setReadError("");
        setSavedLevel(data.minimumLevel ?? "anyone");
        setLevel(data.minimumLevel ?? "anyone");
        setLoopback(data.options?.loopback === true);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setReadError(
            reason instanceof Error && reason.message
              ? reason.message
              : "Could not load widget settings.",
          );
      });
    return () => {
      controller.abort();
      currentScope.current = "";
    };
  }, [room, account, scope, attempt]);
  function saveLevel() {
    setLevelBusy(true);
    setLevelError("");
    setLevelNotice("");
    void chatMutation<{ minimumLevel: SupportMinimumLevel }>(
      account as never,
      roomPath(room, "widget"),
      { minimumLevel: level, confirmed: levelConfirmed },
    )
      .then((data) => {
        if (currentScope.current !== scope) return;
        setSavedLevel(data.minimumLevel);
        setLevel(data.minimumLevel);
        setLevelConfirmed(false);
        setLevelNotice("Saved.");
      })
      .catch(
        (reason) =>
          currentScope.current === scope &&
          setLevelError(
            reason instanceof Error
              ? reason.message
              : "Could not save who can start a case.",
          ),
      )
      .finally(() => {
        if (currentScope.current === scope) setLevelBusy(false);
      });
  }
  const levelChanged = savedLevel !== null && savedLevel !== level;
  const appearanceValidation = useMemo(() => {
    try {
      return { value: checkedWidgetAppearance(appearance) ?? {}, error: "" };
    } catch (error) {
      return {
        value: undefined,
        error:
          error instanceof Error ? error.message : "Check the widget settings.",
      };
    }
  }, [appearance]);
  const appearanceDirty =
    appearanceScope === scope &&
    JSON.stringify(appearanceValidation.value ?? appearance) !==
      JSON.stringify(savedAppearance);
  const appearanceBusy = appearanceSaving === scope;
  async function saveAppearance() {
    if (
      !account ||
      appearanceBusy ||
      !appearanceAvailable ||
      !appearanceValidation.value
    )
      return;
    const chosen = appearanceValidation.value;
    setAppearanceSaving(scope);
    setAppearanceFeedback(undefined);
    try {
      const result = await chatMutation<{
        appearance: WidgetAppearance | null;
        appearanceRevision: number;
      }>(account, roomPath(room, "widget"), {
        appearance: chosen,
        appearanceRevision,
        confirmed: true,
      });
      if (currentScope.current !== scope) return;
      const saved = checkedWidgetAppearance(result.appearance) ?? {};
      if (
        !Number.isSafeInteger(result.appearanceRevision) ||
        result.appearanceRevision < appearanceRevision ||
        JSON.stringify(saved) !== JSON.stringify(chosen)
      )
        throw new Error(
          "Saved appearance could not be checked. Reload and try again.",
        );
      setAppearance(saved);
      setSavedAppearance(saved);
      setAppearanceRevision(result.appearanceRevision);
      setAppearanceFeedback({ scope, saved: true });
    } catch (error) {
      if (currentScope.current === scope)
        setAppearanceFeedback({
          scope,
          error:
            error instanceof Error
              ? error.message
              : "Could not save widget appearance.",
        });
    } finally {
      if (currentScope.current === scope) setAppearanceSaving(undefined);
    }
  }
  const snippet = `import { mountSupportWidget } from "${SITE.origin}${SUPPORT_WIDGET_LATEST_PATH}";

const support = mountSupportWidget({
  workspace: "${id}",
  apiUrl: "${COMMUNITY_API}",
  provider, // the wallet provider your app already uses (EIP-1193)
  label: "${supportLabel(context.workspace.name.replace(/["\\]/g, ""))}",
  // Optional: up to 4 questions users can send with one click.
  // prompts: ["Where is my deposit?", "How do I withdraw?"],
});

// Optional: open it from your own Help button instead of the floating one.
// Pass showLauncher: false above, then call support.open().`;
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Widget"
        title="Add support to your app"
        description="Copy the install prompt and paste it into your AI coding tool."
        actions={
          <a
            className="button secondary"
            href={`${SITE.docs}/developers/widget`}
          >
            <IconBook aria-hidden="true" /> Widget guide
          </a>
        }
      />
      <div className={styles.stack}>
        {!RELEASE.supportWidgetVerified && (
          <Callout tone="warning">
            You can save your setup now. Hosted widget checks must pass before
            you point real users at it.
          </Callout>
        )}

        <Card
          title={
            <span className={styles.stepHead}>
              <span className={styles.stepNumber}>1</span> Copy install prompt
            </span>
          }
          description="Paste this into your AI coding tool. Your workspace ID is already in it. The tool adds and tests the widget."
        >
          <IntegrationPrompt
            prompt={installPrompt({
              release: RELEASE,
              workspaceId: id,
              workspaceFeatures: context.state?.features,
              workspaceOptions: { loopback },
            })}
            label="Copy install prompt"
            families={installFamilies(RELEASE, context.state?.features)}
            onCopied={() => trackEvent("workspace_prompt_copied")}
          />
        </Card>

        <Card
          title="Customize widget"
          description="Save the appearance for everyone using the updated widget. Open widgets can reload to get the changes."
          footer={
            <>
              <button
                type="button"
                className="button"
                disabled={
                  !account ||
                  appearanceScope !== scope ||
                  !appearanceAvailable ||
                  !appearanceDirty ||
                  appearanceBusy ||
                  !!appearanceValidation.error
                }
                onClick={() => void saveAppearance()}
              >
                {appearanceBusy && <Spinner />}
                {appearanceBusy ? "Saving…" : "Save appearance"}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={
                  appearanceScope !== scope ||
                  appearanceBusy ||
                  !appearanceAvailable
                }
                onClick={() => {
                  setAppearance({});
                  setAppearanceFeedback(undefined);
                }}
              >
                Reset
              </button>
            </>
          }
        >
          <UnsavedChanges dirty={appearanceDirty} />
          {appearanceScope === scope ? (
            <WidgetAppearanceEditor
              key={scope}
              label={supportLabel(context.workspace.name)}
              value={appearance}
              disabled={appearanceBusy || !appearanceAvailable}
              onChange={(next) => {
                setAppearance(next);
                setAppearanceFeedback(undefined);
                trackEvent("widget_appearance_changed");
              }}
            />
          ) : readError ? (
            <p className={styles.error}>Widget appearance could not load.</p>
          ) : (
            <Skeleton />
          )}
          {appearanceScope === scope && !appearanceAvailable && (
            <p className={styles.error} role="alert">
              Appearance settings are unavailable. Reload and try again.
            </p>
          )}
          {appearanceValidation.error && (
            <p className={styles.error} role="alert">
              {appearanceValidation.error}
            </p>
          )}
          {appearanceFeedback?.scope === scope &&
            (appearanceFeedback.error || appearanceFeedback.saved) && (
              <p
                className={
                  appearanceFeedback.error ? styles.error : styles.status
                }
                role={appearanceFeedback.error ? "alert" : "status"}
              >
                {appearanceFeedback.error || "Saved."}
              </p>
            )}
        </Card>
        <Card title="Install by hand">
          <CopyBlock
            label="Install snippet"
            code={snippet}
            copyLabel="Copy snippet"
            onCopied={() => trackEvent("widget_snippet_copied")}
          />
          <div>
            <p className={styles.sectionTitle}>Workspace ID</p>
            <CopyInline value={id} label="Copy" />
          </div>
        </Card>

        <Card
          title="Who can start a case"
          description="Your team sees how each person signed in and can ask them to verify their wallet."
          footer={
            savedLevel === null ? undefined : (
              <>
                <label className={controls.checkLabel}>
                  <input
                    className={controls.checkbox}
                    type="checkbox"
                    checked={levelConfirmed}
                    onChange={(event) =>
                      setLevelConfirmed(event.target.checked)
                    }
                    disabled={!levelChanged}
                  />
                  Apply this to everyone using the widget, including open cases.
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={levelBusy || !levelConfirmed || !levelChanged}
                  onClick={saveLevel}
                >
                  {levelBusy && <Spinner />}
                  {levelBusy ? "Saving…" : "Save"}
                </button>
              </>
            )
          }
        >
          <UnsavedChanges dirty={levelChanged} />
          <div className={styles.stack} style={{ gap: 12 }}>
            {savedLevel === null ? (
              readError ? (
                <>
                  <p className={styles.error} role="alert">
                    {readError}
                  </p>
                  <div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        setReadError("");
                        setAttempt((value) => value + 1);
                      }}
                    >
                      Try again
                    </button>
                  </div>
                </>
              ) : (
                LEVELS.map((item) => <Skeleton key={item.value} height={42} />)
              )
            ) : (
              <fieldset className={styles.levelList} disabled={levelBusy}>
                <legend className="visually-hidden">
                  Who can start a case
                </legend>
                {LEVELS.map((item) => (
                  <label key={item.value}>
                    <input
                      type="radio"
                      name="widget-minimum-level"
                      value={item.value}
                      checked={level === item.value}
                      onChange={() => {
                        setLevel(item.value);
                        setLevelConfirmed(false);
                        setLevelNotice("");
                      }}
                    />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {savedLevel !== null && level !== "anyone" && (
              <p className={styles.small}>
                {
                  "People whose wallet won't connect can still ask as Guest, unless you turn that off under Guest support."
                }
              </p>
            )}
            {levelNotice && (
              <p className={styles.status} role="status">
                <IconCircleCheck size={15} aria-hidden="true" /> {levelNotice}
              </p>
            )}
            {levelError && (
              <p className={styles.error} role="alert">
                {levelError}
              </p>
            )}
          </div>
        </Card>

        {installCheck && <WidgetInstallCheck context={context} />}

        <WidgetSessionSettings context={context} />

        <WidgetJourneySettings context={context} />
        <WidgetIntroSettings context={context} />
        <WidgetSafetyLine context={context} />

        {/* Each shows once its hosted check passed. */}
        <WidgetVerifiedDomain context={context} />

        <WidgetFrameMode context={context} />

        <Card
          title="Test it"
          description="Open your site and send a question from the widget. It shows up in your inbox."
          footer={
            <button
              type="button"
              className="button secondary"
              onClick={() => go("inbox")}
            >
              Open inbox
            </button>
          }
        >
          <div className={styles.stack} style={{ gap: 10 }}>
            <p className={styles.muted}>
              You can also share a direct link. It opens a page on Templ where
              people sign in with a wallet and message your team privately.
            </p>
            <SupportLink
              room={room}
              visibility={context.workspace.visibility}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
