"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useEffect, useState, type FormEvent } from "react";
import type { ChatRoomId, ChatState } from "@templ/chat/index";
import type { ManagedAgentView } from "@templ/chat/managed-agent";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { SupportAiMode } from "@templ/chat/support";
import { SUPPORT_TEAM_ROLES, standardTeamRole } from "@templ/chat/team-roles";
import { isBillingView } from "@/lib/product-offer";
import { UnsavedChanges } from "./workspace/unsaved-changes";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { Badge, Card, CopyButton, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "@/components/workspace/support-workspace";
import { GoldenSetPanel } from "./golden-set";
import styles from "@/components/workspace/workspace.module.css";
import layout from "@/components/workspace/workspace-settings.module.css";

export const MANAGED_COPY = {
  title: "Templ AI",
  description:
    "An AI agent Templ runs for your workspace. Anyone on your team can take over a case.",
  addToTeam:
    "Add this account on the Team page as an AI agent. It answers only after that.",
  account: "Templ AI account",
  copy: "Copy account ID",
  teamAccess: "Visitors see “AI agent” on its replies. You can remove access on the Team page.",
  consent:
    "Allow Templ AI to read and answer this workspace’s private cases.",
  give: (on: boolean) => (on ? "Give access" : "Turn on Templ AI"),
  joined: "Templ AI joined your team.",
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
const AGENT_ROLE = "ai-agent";

/** Adds the workspace's Templ AI account to the team the way the Team page
 * adds an AI agent: the standard role, the AI label before access, then the
 * role. The account is the one the worker names in its managed view. Each
 * route rechecks the caller's authority and confirmation and audits itself. */
async function grantTeamAccess(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  principal: ChatPrincipalId,
) {
  const wanted = SUPPORT_TEAM_ROLES[AGENT_ROLE];
  const { roles } = await communityFetch<ChatState>(roomPath(room, "channels"));
  const role = roles.find((item) => item.id === AGENT_ROLE);
  if (!role)
    await chatMutation(account, roomPath(room, "roles"), {
      id: AGENT_ROLE,
      name: wanted.name,
      mode: "manual",
      moderationPermissions: [...wanted.permissions],
      confirmed: true,
    });
  else if (role.mode !== "manual" || !standardTeamRole(role))
    throw new Error(
      `The “${role.name}” role has different permissions. Ask Templ for help before granting access.`,
    );
  try {
    await chatMutation(account, roomPath(room, "bots"), {
      principalId: principal,
      displayName: "AI agent",
      confirmed: true,
    }).catch((reason: unknown) => {
      // Already labeled (409): the read-back decides.
      if ((reason as { status?: number }).status !== 409) throw reason;
    });
    const { bots } = await communityFetch<{
      bots: { principalId: string }[];
    }>(roomPath(room, "bots"));
    if (!bots.some((bot) => bot.principalId === principal))
      throw new Error("Try again.");
  } catch (reason) {
    throw new Error(
      `No access was given, because the AI label wasn’t saved. ${
        reason instanceof Error && reason.message ? reason.message : "Try again."
      }`,
    );
  }
  await chatMutation(account, roomPath(room, `roles/${AGENT_ROLE}/assign`), {
    principalId: principal,
    granted: true,
    confirmed: true,
  });
}

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
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"save" | "join" | null>(null);
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
    setBusy("save");
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
      setBusy(null);
    }
  }
  /** One confirmed step: team access for the managed account, then Templ AI
   * on. A refused step stops the rest. */
  async function join(principal: ChatPrincipalId) {
    if (!view || !consent || busy || dirty) return;
    setBusy("join");
    setError("");
    setNotice("");
    try {
      await grantTeamAccess(room, account, principal);
      const next = view.settings.enabled
        ? await communityFetch<ManagedAgentView>(
            roomPath(room, "conversations/managed"),
          )
        : await chatMutation<ManagedAgentView>(
            account,
            roomPath(room, "conversations/managed"),
            { enabled: true, confirmed: true },
          );
      setView(next);
      setEnabled(next.settings.enabled);
      if (!next.onTeam) throw new Error(MANAGED_COPY.error);
      setConsent(false);
      setNotice(MANAGED_COPY.joined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : MANAGED_COPY.error);
      // An earlier step may have saved. The worker's view shows what it kept.
      setAttempt((value) => value + 1);
    } finally {
      setBusy(null);
      context.reload();
    }
  }
  const ready = view.state === "ready";
  const product = context.state?.product;
  const standard =
    product && isBillingView(product) ? product.standardPlan : undefined;
  const prepaid = Boolean(standard) || view.model === "gpt-6.1-sol";
  // Paid AI reports a missing limit or credit with the budget states.
  const fundsStop =
    view.model === "gpt-6.1-sol" &&
    (view.state === "no-budget" || view.state === "workspace-cap");
  let creditNote = "AI uses your included credit first, then prepaid USDC.";
  if (standard?.starterAiLimitCents !== undefined) {
    if (fundsStop && view.state === "workspace-cap") {
      creditNote = "Raise your monthly AI limit in Plan & usage.";
    } else if (fundsStop) {
      creditNote = "Check your AI credit and monthly limit in Plan & usage.";
    } else if (standard.period?.usage?.includedAiCreditCents) {
      creditNote = "AI uses your included credit first. You choose how much extra to spend in Plan & usage.";
    } else {
      creditNote = "Templ AI uses prepaid USDC up to your monthly limit.";
    }
  } else if (standard && fundsStop) {
    creditNote = "Add prepaid USDC in Plan & usage.";
  }
  // An installed responder can answer even if the optional managed service is off.
  const anotherResponder = context.state?.bots?.some(bot => bot.principalId !== view.principal);
  const serviceName = anotherResponder ? "Additional hosted AI" : MANAGED_COPY.title;
  const canManage = canManageWorkspace({
    isManager: context.manager,
    permissions: context.state?.viewer?.permissions,
  });
  const target = normalizeChatPrincipal(view.principal);
  // A paid workspace without its own AI agent gives Templ AI team access here,
  // after one confirmation. Payment alone adds nothing. The plan comes from
  // the workspace state, which a payment refreshes.
  const joinable =
    canManage &&
    standard?.status === "paid" &&
    !view.onTeam &&
    !anotherResponder &&
    Boolean(target?.startsWith("account:"));
  // Without team access Templ AI answers nothing, so joining turns it on.
  const toggle = canManage && !(joinable && !view.settings.enabled);
  const status: Record<ManagedAgentView["state"], string> = {
    ready:
      defaultMode === "off"
        ? "Ready. AI is off for new cases."
        : defaultMode === "drafts"
          ? "Ready. New cases use AI drafts only."
          : defaultMode === "answers"
            ? "Ready to answer new cases."
            : "Ready. Checking the case mode.",
    off: anotherResponder ? "Not enabled" : "Templ AI is off.",
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
      aria-label={serviceName}
      className={layout.sections}
    >
      <form onSubmit={(event) => void save(event)}>
        <UnsavedChanges dirty={dirty} />
        <Card
          bodyClassName={layout.panelBody}
          title={serviceName}
          description={anotherResponder ? "Your workspace already has a registered AI agent." : MANAGED_COPY.description}
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
            toggle ? (
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
                  disabled={!confirmed || busy !== null || !dirty}
                >
                  {busy === "save" && <Spinner />}
                  {MANAGED_COPY.save}
                </button>
              </>
            ) : undefined
          }
        >
          <div className={layout.panelBody}>
            {joinable && (
              <div className={layout.inset}>
                <h3>Team access</h3>
                <p>{MANAGED_COPY.teamAccess}</p>
                <p className={styles.muted}>
                  {MANAGED_COPY.account}: <code>{target}</code>
                </p>
                <label className={ui.check}>
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy !== null}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  {MANAGED_COPY.consent}
                </label>
                <button
                  type="button"
                  className="button small"
                  disabled={!consent || busy !== null || dirty}
                  onClick={() => target && void join(target)}
                >
                  {busy === "join" && <Spinner />}
                  {MANAGED_COPY.give(view.settings.enabled)}
                </button>
              </div>
            )}
            {view.settings.enabled && !view.onTeam && !joinable && (
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
                    ? "Your team answers trial chats. Choose a plan to let AI answer visitors."
                    : "Templ AI follows your workspace access and available AI credit."
                  : view.grant.active && view.grant.endsAt
                    ? MANAGED_COPY.planUntil(day(view.grant.endsAt))
                    : MANAGED_COPY.noPlan}
              </p>
              {prepaid ? (
                <p>{creditNote}</p>
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
              {context.billing &&
                // Agreed terms renew through Plan & usage, not self-serve checkout.
                (standard?.status === "demo" &&
                (!standard.prepaid || standard.prepaid.mode === "prepaid") ? (
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => context.openPlans("period")}
                  >
                    Choose a plan
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => context.go("plan")}
                  >
                    Plan &amp; usage
                  </button>
                ))}
            </div>
            {toggle && (
              <label className={`${ui.check} ${layout.choice}`}>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy !== null || standard?.status === "demo"}
                  onChange={(event) => {
                    setEnabled(event.target.checked);
                    setConfirmed(false);
                    setNotice("");
                  }}
                />
                {prepaid && standard?.status === "paid" && !view.settings.enabled ? "Turn on AI for visitors" : MANAGED_COPY.toggle}
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
