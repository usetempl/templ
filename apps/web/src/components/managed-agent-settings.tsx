"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useEffect, useState, type FormEvent } from "react";
import type { ManagedAgentView } from "@templ/chat/managed-agent";
import type { SupportAiMode } from "@templ/chat/support";
import { isBillingView } from "@/lib/product-offer";
import { UnsavedChanges } from "./workspace/unsaved-changes";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { Badge, Card, CopyButton, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "@/components/workspace/support-workspace";
import { GoldenSetPanel } from "./golden-set";
import styles from "@/components/workspace/workspace.module.css";
import layout from "@/components/workspace/workspace-settings.module.css";

/** Words on this page. Plain actions and outcomes; nothing it can't back. */
export const MANAGED_COPY = {
  title: "Templ AI",
  description:
    "An AI agent Templ runs for your workspace. Anyone on your team can take over a case.",
  points: [
    "It answers from your AI knowledge and shows the team what it used.",
    "It follows each case's AI mode: answers, drafts only, or off.",
    "It asks at most one question per case, then hands the case to your team.",
    "It never asks for keys or recovery phrases and never asks anyone to sign.",
  ],
  addToTeam:
    "Add this account on the Team page as an AI agent. It answers only after that.",
  account: "Templ AI account",
  copy: "Copy account ID",
  planUntil: (date: string) => `Templ AI access runs until ${date}.`,
  noPlan: "Templ AI needs an active service agreement for this workspace.",
  spend: (used: string, cap: string) => `This month: ${used} of ${cap}.`,
  noBudget: "No Templ AI budget this month.",
  toggle: "Let Templ AI work on cases",
  confirm: "I checked these settings.",
  save: "Save",
  saved: "Saved.",
  error: "This didn't save. Try again.",
  unavailable: "Templ AI settings could not load.",
} as const;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function ManagedAgentSettings({
  context,
  defaultMode,
}: {
  context: WorkspaceContext;
  defaultMode?: SupportAiMode;
}) {
  const { room, account } = context;
  const [view, setView] = useState<ManagedAgentView | null>(null);
  const [failed, setFailed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    communityFetch<ManagedAgentView>(
      roomPath(room, "conversations/managed"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setView(data);
        setEnabled(data.settings.enabled);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [room, account, attempt]);
  if (failed)
    return (
      <Card title={MANAGED_COPY.title}>
        <p className={layout.feedback} role="alert">
          {MANAGED_COPY.unavailable}
        </p>
        <button
          type="button"
          className="button secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      </Card>
    );
  if (!view)
    return (
      <Card title={MANAGED_COPY.title}>
        <Spinner />
      </Card>
    );
  const dirty = enabled !== view.settings.enabled;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || busy || !dirty) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await chatMutation<ManagedAgentView>(
        account,
        roomPath(room, "conversations/managed"),
        { enabled, confirmed },
      );
      setView(next);
      setEnabled(next.settings.enabled);
      setConfirmed(false);
      setNotice(MANAGED_COPY.saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : MANAGED_COPY.error);
    } finally {
      setBusy(false);
    }
  }
  const ready = view.state === "ready";
  const product = context.state?.product;
  const standard =
    product && isBillingView(product) ? product.standardPlan : undefined;
  const prepaid = Boolean(standard) || view.model === "gpt-6.1-sol";
  const status: Record<ManagedAgentView["state"], string> = {
    ready:
      defaultMode === "off"
        ? "Ready. AI is off for new cases."
        : defaultMode === "drafts"
          ? "Ready. New cases use AI drafts only."
          : defaultMode === "answers"
            ? "Ready to answer new cases."
            : "Ready. Checking the case mode.",
    off: "Templ AI is off.",
    "not-on-team": "Add the Templ AI account to your team.",
    "no-grant": "Templ AI is not set up for this workspace.",
    "kill-switch": "Templ AI is paused.",
    "no-key": "Templ AI is paused.",
    "no-budget": "No Templ AI budget this month.",
    "workspace-cap": "This month's Templ AI budget is used up.",
    "templ-cap": "Templ AI is paused for the rest of the month.",
  };
  return (
    <section
      id="managed-ai"
      aria-label={MANAGED_COPY.title}
      className={layout.sections}
    >
      <form onSubmit={(event) => void save(event)}>
        <UnsavedChanges dirty={dirty} />
        <Card
          bodyClassName={layout.panelBody}
          title={MANAGED_COPY.title}
          description={MANAGED_COPY.description}
          actions={
            <Badge
              tone={
                ready ? "brand" : view.state === "off" ? "neutral" : "warning"
              }
              dot
            >
              {standard?.status === "demo"
                ? "Off during free integration."
                : status[view.state]}
            </Badge>
          }
          footer={
            canManageWorkspace({
              isManager: context.manager,
              permissions: context.state?.viewer?.permissions,
            }) ? (
              <>
                <label className={ui.check}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={!dirty}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {MANAGED_COPY.confirm}
                </label>
                <button
                  type="submit"
                  className="button"
                  disabled={!confirmed || busy || !dirty}
                >
                  {busy && <Spinner />}
                  {MANAGED_COPY.save}
                </button>
              </>
            ) : undefined
          }
        >
          <div className={layout.panelBody}>
            <ul className={layout.points}>
              {MANAGED_COPY.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            {view.settings.enabled && !view.onTeam && (
              <div className={layout.inset}>
                <p>{MANAGED_COPY.addToTeam}</p>
                <p className={styles.muted}>
                  {MANAGED_COPY.account}: <code>{view.principal}</code>{" "}
                  <CopyButton
                    value={view.principal}
                    label={MANAGED_COPY.copy}
                  />
                </p>
                <button
                  type="button"
                  onClick={() => context.go("team")}
                  className="button small secondary"
                >
                  Open Team
                </button>
              </div>
            )}
            <div className={layout.inset}>
              <h3>Access and usage</h3>
              <p>
                {standard
                  ? standard.status === "demo"
                    ? "Templ AI is off during free integration. Open Plan & usage when you are ready to go live."
                    : "Templ AI follows your workspace access and available AI credit."
                  : view.grant.active && view.grant.endsAt
                    ? MANAGED_COPY.planUntil(day(view.grant.endsAt))
                    : MANAGED_COPY.noPlan}
              </p>
              {/* With no budget the badge already says so. */}
              {prepaid ? (
                <p>
                  AI work uses your included credit, then prepaid USDC. Check
                  Plan & usage for your balance.
                </p>
              ) : (
                view.state !== "no-budget" && (
                  <p>
                    {view.spend.capCents > 0
                      ? MANAGED_COPY.spend(
                          dollars(view.spend.usedCents),
                          dollars(view.spend.capCents),
                        )
                      : MANAGED_COPY.noBudget}
                  </p>
                )
              )}
              {context.billing && (
                <button
                  type="button"
                  className="button small secondary"
                  onClick={() => context.go("plan")}
                >
                  Plan &amp; usage
                </button>
              )}
            </div>
            {canManageWorkspace({
              isManager: context.manager,
              permissions: context.state?.viewer?.permissions,
            }) && (
              <label className={`${ui.check} ${layout.choice}`}>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy || standard?.status === "demo"}
                  onChange={(event) => {
                    setEnabled(event.target.checked);
                    setConfirmed(false);
                    setNotice("");
                  }}
                />
                {MANAGED_COPY.toggle}
              </label>
            )}
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
          </div>
        </Card>
      </form>
      {!prepaid && <GoldenSetPanel context={context} summary={view.golden} />}
    </section>
  );
}
