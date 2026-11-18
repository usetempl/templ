"use client";
import { threadIdentityLabel } from "@templ/chat/support-identity-label";
import { UnsavedChanges } from "./workspace/unsaved-changes";
import { PRIORITY_COPY } from "@templ/chat/support-priority";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatRoomId, TeamConversation } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  SUPPORT_AI_MODES,
  SUPPORT_AI_MODE_CAUSES,
  SUPPORT_LIMITS,
  SUPPORT_TIME_SPENT,
  type SupportActivity,
  type SupportAiMode,
  type SupportAiModeCause,
  type SupportContext,
  type SupportNote,
  type SupportTimeSpent,
  type SupportWorkflow,
  type SupportState,
} from "@templ/chat/support";
import {
  SUPPORT_WALLET_CHAINS,
  supportChainLabel,
  supportWalletChain,
} from "@templ/chat/chains";
import {
  SOLANA_EXPLORER,
  SOLANA_NAME,
  shortSolanaAddress,
} from "@templ/chat/solana";
import {
  readStoredWidgetWallet,
  type WidgetWallet,
} from "@templ/chat/widget-wallet";
import {
  parseTransactionReference,
  supportTransactionUrl,
  type SupportContextReason,
} from "@templ/chat/support-context";
import {
  COMMUNITY_API,
  CommunityApiError,
  roomPath,
} from "@/lib/community-client";
import { requireChatSession } from "@/lib/chat-api";
import {
  readSupportWorkflow,
  updateSupportWorkflow,
} from "@/lib/team-conversations-client";
import {
  readSupportDraft,
  writeSupportDraft,
  clearSupportWorkspaceState,
} from "@/lib/support-local-state";
import { discardWorkspaceConversationOutbox } from "@/lib/chat-outbox";
import { MemberIdentity } from "./member-identity";
import { Badge } from "./ui/ui";
import { useMemberProfiles } from "@/lib/member-profiles";
import { copy as t, type MessageKey } from "@/lib/copy";
import { SupportAccountOptions } from "./support-account-options";
import type { SupportCaseActivityAction } from "@templ/chat/support-drafts";
import {
  FOLLOW_UP_ACTIVITY,
  followUpActivityText,
} from "@/lib/copy/follow-ups";
import {
  aiCauseText,
  aiModeLabel,
  handoffReasonLabel,
  isHandoffReason,
} from "./ai-control";
import {
  APP_FIELDS,
  APP_LABELS,
  FAILURE_KIND_LABELS,
  appValue,
} from "@/lib/support-widget-app";
import { threadIdentity } from "@templ/chat/support-identity";
import styles from "./team-conversations.module.css";
import detailStyles from "./support-workflow-panel.module.css";
// Case state and archive controls.
// Current case access and author permissions apply.
import { CaseStateChip } from "./case-state-chip";
import { ArchiveCaseButton } from "./archive-case-button";
import { inboxNetworkName, inboxTime } from "@/lib/inbox-facts";
import {
  SUPPORT_LEAD_CHAIN_LABELS,
  SUPPORT_LEAD_VOLUME_LABELS,
  SUPPORT_LEAD_WALLET_LABELS,
} from "@templ/chat/support-lead";

// Staff-selectable case states.
// Current case access and author permissions apply.
const states: Record<Exclude<SupportState, "abandoned">, string> = {
  open: "Open",
  waiting: "Waiting on user",
  resolved: "Resolved",
  spam: "Spam",
};
/** The element id of an internal note, so the handoff banner can show it. */
export const noteElementId = (id: string) => `support-note-${id}`;
export function SupportWorkflowPanel({
  room,
  account,
  conversation,
  enabled,
  draftsEnabled = false,
  priorityEnabled = false,
  composing,
  replyText = "",
  messagesShown = true,
  notesInThread = false,
  onReply,
  onChanged,
  onPriorityChanged,
  onOpenConversation,
  onWorkflow,
  actionBusy = false,
  onMutationStart,
  onMutationEnd,
  refreshKey = 0,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  conversation: TeamConversation;
  enabled: boolean;
  draftsEnabled?: boolean;
  priorityEnabled?: boolean;
  /** The person typed a reply since opening the thread. */
  composing: boolean;
  /** What the reply box holds now, typed or restored. */
  replyText?: string;
  /** False until the thread's messages are on screen. The read receipt and
   * presence writes wait for it, so they never hold up the first read. */
  messagesShown?: boolean;
  notesInThread?: boolean;
  onReply: (text: string) => void;
  onChanged: () => void;
  /** Refresh the queue after a background deposit check. */
  onPriorityChanged?: () => void;
  /** Opens another thread in the inbox, for requests linked by one wallet. */
  onOpenConversation?: (id: string) => void;
  /** The latest workflow read, for the thread header and banner. */
  onWorkflow?: (workflow: SupportWorkflow | undefined) => void;
  actionBusy?: boolean;
  onMutationStart?: () => boolean;
  onMutationEnd?: () => void;
  /** Changing it reads the workflow again at once. */
  refreshKey?: number;
}) {
  const scope = `${room}:${conversation.id}:${account}`;
  const [loaded, setLoaded] = useState<{
    scope: string;
    workflow: SupportWorkflow;
  }>();
  const workflow = loaded?.scope === scope ? loaded.workflow : undefined;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [assignment, setAssignment] = useState(
    conversation.assignment?.principalId ?? "",
  );
  useEffect(() => {
    setAssignment(conversation.assignment?.principalId ?? "");
  }, [scope, conversation.assignment?.principalId]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [note, setNoteValue] = useState("");
  const [mentions, setMentionsValue] = useState<string[]>([]);
  const noteValue = useRef({ note, mentions });
  noteValue.current = { note, mentions };
  const setNote = (text: string) => {
    setNoteValue(text);
    writeSupportDraft(room, account, conversation.id, "note", {
      text,
      mentions,
    });
  };
  const setMentions = (values: string[]) => {
    setMentionsValue(values);
    writeSupportDraft(room, account, conversation.id, "note", {
      text: note,
      mentions: values,
    });
  };
  const [tags, setTags] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [earlierNotes, setEarlierNotes] = useState<
    NonNullable<SupportWorkflow["notes"]>
  >([]);
  const [earlierCursor, setEarlierCursor] = useState<
    string | null | undefined
  >();
  const [savedSearch, setSavedSearch] = useState("");
  const [preview, setPreview] = useState("");
  const [context, setContext] = useState({
    description: "",
    network: "",
    transactionHash: "",
  });
  const [contextError, setContextError] = useState("");
  const [consent, setConsent] = useState(false);
  /** An AI agent note waiting for "Replace" or "Add below". */
  const [copyingNote, setCopyingNote] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Record<string, string>>({});
  const noteAttempt = useRef<{ text: string; id: string } | null>(null);
  const team = conversation.viewer === "team";
  const accessRevision = useRef(0);
  const workflowChanged = useRef(onWorkflow);
  workflowChanged.current = onWorkflow;
  const mutationVersion = useRef(0);
  const mutationPending = useRef<{ notifyParent: boolean } | null>(null);
  const mutationEnded = useRef(onMutationEnd);
  mutationEnded.current = onMutationEnd;
  const current = useRef(scope);
  current.current = scope;
  const readNow = useRef<() => void>(() => {});
  const priorityChanged = useRef(onPriorityChanged);
  priorityChanged.current = onPriorityChanged;
  const clearAccess = useCallback(() => {
    if (current.current !== scope) return;
    accessRevision.current += 1;
    const operation = mutationPending.current;
    mutationPending.current = null;
    setBusy(false);
    setSavingAction(null);
    if (operation?.notifyParent) mutationEnded.current?.();
    setLoaded(undefined);
    workflowChanged.current?.(undefined);
    setScreenshots({});
    discardWorkspaceConversationOutbox(room, account);
    clearSupportWorkspaceState(room, account);
    setNoteValue("");
    setEarlierNotes([]);
    setEarlierCursor(undefined);
    setPreview("");
    setMentionsValue([]);
    noteAttempt.current = null;
  }, [scope, room, account]);
  useEffect(() => {
    const controller = new AbortController();
    current.current = scope;
    accessRevision.current += 1;
    setLoaded(undefined);
    setScreenshots({});
    setEarlierNotes([]);
    setEarlierCursor(undefined);
    setTags(null);
    setCategory(null);
    let reading = false;
    let restoredDraft = false;
    const failed = (reason: unknown) => {
      if (controller.signal.aborted) return;
      if (
        reason instanceof CommunityApiError &&
        [401, 403, 404].includes(reason.status)
      ) {
        clearAccess();
      }
      setError(
        reason instanceof Error
          ? reason.message
          : "Support tools could not load.",
      );
    };
    const read = async () => {
      if (reading || mutationPending.current || controller.signal.aborted)
        return;
      reading = true;
      const version = mutationVersion.current;
      const access = accessRevision.current;
      try {
        const result = await readSupportWorkflow(
          room,
          conversation.id,
          controller.signal,
        );
        if (
          !controller.signal.aborted &&
          version === mutationVersion.current &&
          access === accessRevision.current
        ) {
          setLoaded({ scope, workflow: result.workflow });
          if (!restoredDraft && team) {
            restoredDraft = true;
            const draft = readSupportDraft(
              room,
              account,
              conversation.id,
              "note",
            );
            setNoteValue(draft?.text ?? "");
            setMentionsValue(draft?.mentions ?? []);
            noteAttempt.current = draft?.attempt
              ? { text: draft.attempt.text, id: draft.attempt.id }
              : null;
          }
          setError("");
        }
      } catch (reason) {
        if (access === accessRevision.current) failed(reason);
      } finally {
        reading = false;
      }
    };
    readNow.current = () => void read();
    void read();
    // Deposit checks can wait on the chain. They never hold up case details
    // or replace a workflow changed while the check was running.
    if (team && priorityEnabled) {
      const access = accessRevision.current;
      void readSupportWorkflow(
        room,
        conversation.id,
        controller.signal,
        undefined,
        true,
      ).then(
        () => {
          if (!controller.signal.aborted && access === accessRevision.current)
            priorityChanged.current?.();
        },
        (reason) => {
          if (
            access === accessRevision.current &&
            reason instanceof CommunityApiError &&
            [401, 403, 404].includes(reason.status)
          )
            failed(reason);
        },
      );
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 15_000);
    return () => {
      current.current = "";
      readNow.current = () => {};
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    room,
    conversation.id,
    account,
    scope,
    team,
    priorityEnabled,
    clearAccess,
  ]);
  useEffect(() => {
    if (refreshKey) readNow.current();
  }, [refreshKey]);
  useEffect(() => {
    if (workflow)
      onWorkflow?.(
        earlierNotes.length
          ? { ...workflow, notes: [...(workflow.notes ?? []), ...earlierNotes] }
          : workflow,
      );
  }, [workflow, earlierNotes, onWorkflow]);
  useEffect(() => {
    if (!team || !enabled || !messagesShown) return;
    void updateSupportWorkflow(account, room, conversation.id, {
      action: "read",
    }).catch(() => {});
  }, [account, room, conversation.id, team, enabled, messagesShown]);
  useEffect(() => {
    if (!team || !enabled || !messagesShown) return;
    let pending = false;
    const update = () => {
      if (!document.hidden && !pending) {
        pending = true;
        // `typed` says `composing` means typed in this thread since it
        // opened: a restored draft is not a person stepping in.
        void updateSupportWorkflow(account, room, conversation.id, {
          action: "presence",
          composing,
          typed: true,
        })
          .catch(() => {})
          .finally(() => {
            pending = false;
          });
      }
    };
    update();
    const timer = window.setInterval(update, 20_000);
    return () => window.clearInterval(timer);
  }, [account, room, conversation.id, team, enabled, composing, messagesShown]);
  async function mutate(body: Record<string, unknown>) {
    if (mutationPending.current || busy || actionBusy || !enabled) return false;
    if (onMutationStart && !onMutationStart()) return false;
    const operation = { notifyParent: true };
    mutationPending.current = operation;
    mutationVersion.current += 1;
    const access = accessRevision.current;
    const previous = workflow;
    const previousAssignment = assignment;
    if (body.action === "status" && workflow && String(body.state) in states) {
      setLoaded({
        scope,
        workflow: {
          ...workflow,
          summary: { ...workflow.summary, state: body.state as SupportState },
        },
      });
      setSavingAction("Saving status…");
    } else if (body.action === "assign") {
      setAssignment((body.principalId as ChatPrincipalId | null) ?? "");
      setSavingAction("Saving assignment…");
    } else if (body.action === "tags") {
      setSavingAction("Saving tags…");
    } else if (body.action === "note") {
      setSavingAction("Adding note…");
    } else if (body.action === "request-verification") {
      setSavingAction("Requesting verification…");
    }
    setBusy(true);
    setError("");
    try {
      const result = await updateSupportWorkflow(
        account,
        room,
        conversation.id,
        body,
      );
      if (current.current !== scope || access !== accessRevision.current)
        return false;
      setLoaded({ scope, workflow: result.workflow });
      onChanged();
      return true;
    } catch (reason) {
      if (current.current === scope && access === accessRevision.current) {
        if (
          reason instanceof CommunityApiError &&
          [401, 404].includes(reason.status)
        ) {
          clearAccess();
        } else if (previous) setLoaded({ scope, workflow: previous });
        setAssignment(previousAssignment);
        setError(
          reason instanceof Error
            ? reason.message
            : "The change could not be saved.",
        );
      }
      return false;
    } finally {
      if (mutationPending.current === operation) {
        mutationPending.current = null;
        if (current.current === scope) {
          setBusy(false);
          setSavingAction(null);
        }
        onMutationEnd?.();
      }
    }
  }
  async function saveNote() {
    const attemptText = JSON.stringify([note, mentions]);
    if (noteAttempt.current?.text !== attemptText)
      noteAttempt.current = { text: attemptText, id: crypto.randomUUID() };
    writeSupportDraft(room, account, conversation.id, "note", {
      text: note,
      mentions,
      attempt: noteAttempt.current,
    });
    if (
      await mutate({
        action: "note",
        text: note,
        mentions,
        clientId: noteAttempt.current.id,
      })
    ) {
      if (
        current.current === scope &&
        JSON.stringify([noteValue.current.note, noteValue.current.mentions]) ===
          attemptText
      ) {
        setNoteValue("");
        setMentionsValue([]);
        writeSupportDraft(room, account, conversation.id, "note", { text: "" });
      }
      noteAttempt.current = null;
    }
  }
  async function upload(file?: File) {
    if (!file || busy || mutationPending.current || actionBusy || !enabled)
      return;
    if (
      file.type !== "image/png" ||
      file.size > SUPPORT_LIMITS.screenshotBytes
    ) {
      setError("Choose a PNG screenshot up to 2 MiB.");
      return;
    }
    const access = accessRevision.current;
    const operation = { notifyParent: false };
    mutationPending.current = operation;
    mutationVersion.current += 1;
    setBusy(true);
    setError("");
    try {
      await requireChatSession(account);
      if (current.current !== scope || access !== accessRevision.current)
        return;
      const query = new URLSearchParams({
        expectedPrincipalId: account!,
        clientId: crypto.randomUUID(),
      });
      const response = await fetch(
        `${COMMUNITY_API}${roomPath(room, `conversations/${conversation.id}/workflow`)}?${query}`,
        {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "image/png" },
          body: file,
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new CommunityApiError(
          data.error ?? "The screenshot could not be uploaded.",
          response.status,
          data,
        );
      if (current.current === scope && access === accessRevision.current)
        setLoaded({ scope, workflow: data.workflow });
    } catch (reason) {
      if (current.current === scope && access === accessRevision.current) {
        if (
          reason instanceof CommunityApiError &&
          [401, 404].includes(reason.status)
        )
          clearAccess();
        setError(
          reason instanceof Error
            ? reason.message
            : "The screenshot could not be uploaded.",
        );
      }
    } finally {
      if (mutationPending.current === operation) {
        mutationPending.current = null;
        if (current.current === scope) setBusy(false);
      }
    }
  }
  async function viewScreenshot(id: string) {
    const access = accessRevision.current;
    try {
      const response = await fetch(
        `${COMMUNITY_API}${roomPath(room, `conversations/${conversation.id}/workflow`)}?attachment=${encodeURIComponent(id)}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok)
        throw new CommunityApiError(
          "This screenshot is no longer available.",
          response.status,
        );
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onload = () => {
        if (current.current === scope && access === accessRevision.current)
          setScreenshots((previous) => ({
            ...previous,
            [id]: String(reader.result),
          }));
      };
      reader.readAsDataURL(blob);
    } catch (reason) {
      if (current.current === scope && access === accessRevision.current) {
        if (
          reason instanceof CommunityApiError &&
          [401, 403, 404].includes(reason.status)
        )
          clearAccess();
        setError(
          reason instanceof Error
            ? reason.message
            : "The screenshot could not load.",
        );
      }
    }
  }
  if (!workflow)
    return error ? (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    ) : (
      <div className={styles.detailsLoading} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  const colleagues = (workflow.presence ?? []).filter(
    (person) => person.principalId !== account,
  );
  const notes = [
    ...new Map(
      [...(workflow.notes ?? []), ...earlierNotes].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  ];
  const replies =
    workflow.savedReplies?.filter((reply) =>
      `${reply.title} ${reply.text}`
        .toLowerCase()
        .includes(savedSearch.toLowerCase()),
    ) ?? [];
  // The worker lists activity newest first.
  const activity = workflow.activity ?? [];
  const shownActivity = activityOpen ? activity : activity.slice(0, 4);
  const linked = team ? (conversation.linkedConversations ?? []) : [];
  const unverified =
    team && workflow.access && workflow.access.level !== "signed"
      ? workflow.access
      : undefined;
  const wallet = walletView(workflow.wallet);
  const claimedWallet = walletView(unverified?.claimedWallet);
  const appWallet = team ? walletView(workflow.appWallet) : null;
  return (
    <section className={styles.details} aria-label="Support tools">
      <UnsavedChanges
        dirty={
          (tags !== null &&
            JSON.stringify(
              tags
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            ) !== JSON.stringify(workflow.summary.tags)) ||
          (category !== null && category !== (workflow.summary.category ?? ""))
        }
      />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {team && colleagues.length > 0 && (
        <p className={styles.presence} role="status">
          <span aria-hidden="true" />
          {colleagues.length === 1
            ? "1 other teammate"
            : `${colleagues.length} other staff`}{" "}
          {colleagues.some((person) => person.composing)
            ? "composing a reply. Check before sending."
            : "viewing this case."}
        </p>
      )}
      {!team &&
        (workflow.settings.acknowledgment ||
          workflow.settings.businessHours) && (
          <div className={styles.detailSection}>
            <h3>About this team</h3>
            {workflow.settings.acknowledgment && (
              <p className={styles.detailText}>
                {workflow.settings.acknowledgment}
              </p>
            )}
            {workflow.settings.businessHours && (
              <p className={styles.detailText}>
                Hours: {workflow.settings.businessHours} (
                {workflow.settings.timezone})
              </p>
            )}
          </div>
        )}
      {team && workflow.lead && (
        <div className={styles.detailSection}>
          <h3>App details</h3>
          <dl className={styles.facts}>
            {workflow.lead.email && (
              <div>
                <dt>Email</dt>
                <dd>{workflow.lead.email}</dd>
              </div>
            )}
            {workflow.lead.wallet && (
              <div>
                <dt>Lead wallet</dt>
                <dd className={styles.mono}>{workflow.lead.wallet.address}</dd>
              </div>
            )}
            {workflow.lead.qualified && (
              <>
                <div>
                  <dt>App URL</dt>
                  <dd className={styles.mono}>
                    {workflow.lead.qualified.appUrl}
                  </dd>
                </div>
                <div>
                  <dt>Chains</dt>
                  <dd>
                    {workflow.lead.qualified.chains
                      .map((chain) => SUPPORT_LEAD_CHAIN_LABELS[chain])
                      .join(", ")}
                  </dd>
                </div>
                <div>
                  <dt>Monthly cases</dt>
                  <dd>
                    {
                      SUPPORT_LEAD_VOLUME_LABELS[
                        workflow.lead.qualified.monthlyVolume
                      ]
                    }
                  </dd>
                </div>
                <div>
                  <dt>Wallet stack</dt>
                  <dd>
                    {workflow.lead.qualified.walletStack
                      .map((stack) => SUPPORT_LEAD_WALLET_LABELS[stack])
                      .join(", ")}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </div>
      )}
      <div className={styles.detailSection}>
        <h3>{team ? "User" : "Your case"}</h3>
        <p
          className={styles.detailText}
          data-identity={threadIdentity(workflow)}
        >
          {threadIdentityLabel(workflow)}
        </p>
        {team && workflow.emailNotices && (
          <p className={styles.detailMuted}>Email notices: on</p>
        )}
        {team && workflow.access?.walletUnavailable && (
          <p className={styles.detailText}>{"Wallet wouldn't connect"}</p>
        )}
        {workflow.wallet && wallet ? (
          <dl className={styles.facts}>
            <div>
              <dt>Wallet</dt>
              <WalletLine wallet={wallet} status="verified" />
            </div>
            <div>
              <dt>Website</dt>
              <dd className={styles.mono}>{workflow.wallet.origin}</dd>
            </div>
            <div>
              <dt>Signed in</dt>
              <dd>{inboxTime(workflow.wallet.authenticatedAt, true)}</dd>
            </div>
          </dl>
        ) : claimedWallet ? (
          <>
            {priorityEnabled && (
              <p className={styles.detailText}>{PRIORITY_COPY.claimed}</p>
            )}
            <dl className={styles.facts}>
              <div>
                <dt>Wallet</dt>
                <WalletLine wallet={claimedWallet} status="claimed" />
              </div>
            </dl>
            <p className={styles.detailMuted}>
              Their app reported this wallet. It does not prove they own it.
            </p>
          </>
        ) : unverified ? (
          <p className={styles.detailMuted}>
            They wrote without connecting a wallet.
          </p>
        ) : appWallet ? null : (
          <p className={styles.detailMuted}>
            {team
              ? "No widget wallet on record. This user wrote from the Templ app."
              : "Signed in to Templ."}
          </p>
        )}
        {workflow.appWallet && appWallet && (
          <>
            <dl className={styles.facts}>
              <div>
                <dt>Templ app wallet</dt>
                <WalletLine wallet={appWallet} status="verified" />
              </div>
              <div>
                <dt>Signed in</dt>
                <dd>{inboxTime(workflow.appWallet.authenticatedAt, true)}</dd>
              </div>
            </dl>
            <p className={styles.detailMuted}>
              They signed in to the Templ app with this wallet.
            </p>
          </>
        )}
        {unverified &&
          (workflow.verificationRequested ? (
            <p className={styles.detailMuted} role="status">
              Waiting for them to verify. Their widget shows a sign-in button.
            </p>
          ) : (
            <button
              type="button"
              className="button small secondary"
              disabled={!enabled || busy || conversation.staffMessagesStopped}
              aria-busy={savingAction === "Requesting verification…"}
              onClick={() => void mutate({ action: "request-verification" })}
            >
              {savingAction === "Requesting verification…"
                ? savingAction
                : PRIORITY_COPY.verifyAction}
            </button>
          ))}
        {linked.length > 0 && onOpenConversation && (
          <p className={styles.detailMuted}>
            {linked.length === 1
              ? "This wallet has another case here."
              : `This wallet has ${linked.length} other cases here.`}{" "}
            {linked.map((id, index) => (
              <button
                key={id}
                type="button"
                className={styles.linkButton}
                onClick={() => onOpenConversation(id)}
              >
                {linked.length === 1 ? "Open it" : `Open ${index + 1}`}
              </button>
            ))}
          </p>
        )}
        {workflow.context && (
          <ContextFacts context={workflow.context} thread={conversation.id} />
        )}
      </div>
      {!team && (
        <div className={styles.detailSection}>
          <h3>Share details</h3>
          <p className={styles.detailMuted}>
            Add what happened, the network and a transaction hash. The team sees
            it only after you share.
          </p>
          <label className={styles.detailField}>
            Issue description
            <textarea
              maxLength={2000}
              rows={3}
              value={context.description}
              onChange={(event) =>
                setContext((previous) => ({
                  ...previous,
                  description: event.target.value,
                }))
              }
            />
          </label>
          <label className={styles.detailField}>
            Network (optional)
            <select
              value={context.network}
              onChange={(event) =>
                setContext((previous) => ({
                  ...previous,
                  network: event.target.value,
                }))
              }
            >
              <option value="">Not sure</option>
              {SUPPORT_WALLET_CHAINS.map((chain) => (
                <option key={chain.id} value={`eip155:${chain.id}`}>
                  {chain.name}
                </option>
              ))}
              <option value="solana">Solana</option>
            </select>
          </label>
          <label className={styles.detailField}>
            Transaction hash or explorer link (optional)
            <input
              maxLength={300}
              value={context.transactionHash}
              placeholder={
                context.network === "solana"
                  ? "Signature or explorer link"
                  : context.network
                    ? "0x… or explorer link"
                    : "0x…, Solana signature or explorer link"
              }
              spellCheck={false}
              aria-invalid={contextError ? true : undefined}
              onChange={(event) => {
                setContextError("");
                setContext((previous) => ({
                  ...previous,
                  transactionHash: event.target.value,
                }));
              }}
            />
          </label>
          {contextError && (
            <p className={styles.detailMuted} role="alert">
              {contextError}
            </p>
          )}
          <label className={styles.detailCheck}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            Share the context shown above with this workspace’s support staff.
          </label>
          <button
            type="button"
            className="button small secondary"
            disabled={!enabled || busy || !consent}
            onClick={() => {
              const hash = context.transactionHash.trim();
              // The service checks it too; this keeps a typo from being sent.
              if (
                hash &&
                !parseTransactionReference(
                  hash,
                  context.network === "solana" ||
                    /^eip155:[1-9][0-9]*$/.test(context.network)
                    ? (context.network as `eip155:${number}` | "solana")
                    : undefined,
                )
              ) {
                setContextError(CONTEXT_ERRORS["invalid-transaction"]);
                return;
              }
              void mutate({
                action: "context",
                context: { ...context, transactionHash: hash },
                consent,
              });
            }}
          >
            Share context
          </button>
        </div>
      )}
      {team && (
        <>
          <div className={styles.detailSection}>
            <h3>Status</h3>
            {savingAction && <p role="status">{savingAction}</p>}
            {/* Current state and archive action. */}
            {/* Current case access and author permissions apply. */}
            {workflow.summary.archivedAt && (
              <CaseStateChip summary={workflow.summary} />
            )}
            <ArchiveCaseButton
              room={room}
              thread={conversation.id}
              account={account}
              summary={workflow.summary}
              canManage={workflow.canManage === true}
              onArchived={onChanged}
            />
            <label className={styles.detailField}>
              <select
                aria-label="Status"
                value={workflow.summary.state}
                disabled={!enabled || busy || actionBusy}
                onChange={(event) =>
                  void mutate({ action: "status", state: event.target.value })
                }
              >
                {/* Alarm-owned abandoned state. */}
                {/* Current case access and author permissions apply. */}
                {workflow.summary.state === "abandoned" && (
                  <option value="abandoned" disabled>
                    Abandoned
                  </option>
                )}
                {Object.entries(states).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {workflow.canManage && (
              <label className={styles.detailField}>
                Assign to
                <select
                  value={assignment}
                  disabled={!enabled || busy || actionBusy}
                  onChange={(event) =>
                    void mutate({
                      action: "assign",
                      principalId: event.target.value || null,
                    })
                  }
                >
                  <option value="">Unassigned</option>
                  <SupportAccountOptions ids={workflow.staff ?? []} />
                </select>
              </label>
            )}
          </div>
          <details key={`${scope}:tags`} className={detailStyles.disclosure}>
            <summary className={detailStyles.summary}>
              <h3>Category and tags</h3>
              {workflow.summary.category && (
                <span>{workflow.summary.category}</span>
              )}
              {workflow.summary.tags.length > 0 && (
                <span>
                  {workflow.summary.tags.length}{" "}
                  {workflow.summary.tags.length === 1 ? "tag" : "tags"}
                </span>
              )}
            </summary>
            <div className={`${styles.detailSection} ${detailStyles.body}`}>
              {workflow.summary.tags.length > 0 && (
                <div className={styles.tagList}>
                  {workflow.summary.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
              <label className={styles.detailField}>
                Tags, separated by commas
                <input
                  disabled={!enabled || busy}
                  value={tags ?? workflow.summary.tags.join(", ")}
                  onChange={(event) => setTags(event.target.value)}
                  maxLength={400}
                  placeholder="deposit, bridge"
                />
              </label>
              <label className={styles.detailField}>
                Category
                <select
                  id="case-category"
                  value={category ?? workflow.summary.category ?? ""}
                  disabled={!enabled || busy}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="">No category</option>
                  {workflow.summary.category &&
                    !workflow.settings.categories?.includes(
                      workflow.summary.category,
                    ) && (
                      <option value={workflow.summary.category}>
                        {workflow.summary.category} (removed)
                      </option>
                    )}
                  {workflow.settings.categories?.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button small secondary"
                disabled={
                  !enabled || busy || (tags === null && category === null)
                }
                aria-busy={savingAction === "Saving tags…"}
                onClick={() =>
                  void mutate({
                    action: "tags",
                    tags: (tags ?? workflow.summary.tags.join(","))
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                    ...(category !== null ? { category } : {}),
                  }).then((saved) => {
                    if (saved) {
                      setTags(null);
                      setCategory(null);
                    }
                  })
                }
              >
                {savingAction === "Saving tags…"
                  ? savingAction
                  : "Save category and tags"}
              </button>
            </div>
          </details>
          <details key={`${scope}:notes`} className={detailStyles.disclosure}>
            <summary className={detailStyles.summary}>
              <h3>Internal notes</h3>
              {notes.length > 0 && <span>{notes.length}</span>}
            </summary>
            <div
              className={`${styles.detailSection} ${detailStyles.body}`}
              data-tone="note"
            >
              <p className={styles.detailMuted}>
                Only staff with support access can read these notes. Users never
                receive them.
              </p>
              {!notesInThread && notes.length > 0 && (
                <ul className={styles.noteList}>
                  {notes.map((item) => (
                    <li
                      key={item.id}
                      id={noteElementId(item.id)}
                      tabIndex={-1}
                      data-agent={item.byAgent ? "true" : undefined}
                    >
                      <div className={styles.noteMeta}>
                        <MemberIdentity principalId={item.author} size="sm" />
                        {item.byAgent && (
                          <span className={styles.rowFlag}>
                            {t("room.notes.agentBadge")}
                          </span>
                        )}
                        <time dateTime={item.at}>
                          {new Date(item.at).toLocaleString()}
                        </time>
                      </div>
                      <p className={styles.text}>{item.text}</p>
                      {item.byAgent && (
                        <AgentNoteCopy
                          note={item}
                          replyText={replyText}
                          confirming={copyingNote === item.id}
                          onConfirm={setCopyingNote}
                          onReply={onReply}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {(earlierCursor === undefined
                ? workflow.notesNextCursor
                : earlierCursor) && (
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={busy}
                  onClick={() => {
                    const access = accessRevision.current;
                    setBusy(true);
                    void readSupportWorkflow(
                      room,
                      conversation.id,
                      undefined,
                      (earlierCursor === undefined
                        ? workflow.notesNextCursor
                        : earlierCursor) ?? undefined,
                    )
                      .then((result) => {
                        if (
                          current.current === scope &&
                          access === accessRevision.current
                        ) {
                          setEarlierNotes((previous) => [
                            ...previous,
                            ...(result.workflow.notes ?? []),
                          ]);
                          setEarlierCursor(
                            result.workflow.notesNextCursor ?? null,
                          );
                        }
                      })
                      .catch((reason) => {
                        if (
                          current.current === scope &&
                          access === accessRevision.current
                        ) {
                          if (
                            reason instanceof CommunityApiError &&
                            [401, 403, 404].includes(reason.status)
                          )
                            clearAccess();
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : "Notes could not load.",
                          );
                        }
                      })
                      .finally(() => {
                        if (
                          current.current === scope &&
                          access === accessRevision.current
                        )
                          setBusy(false);
                      });
                  }}
                >
                  Earlier notes
                </button>
              )}
              <label className={styles.detailField}>
                Internal note
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={4000}
                  rows={3}
                  placeholder="Visible to your team only"
                />
              </label>
              {(workflow.staff ?? []).length > 0 && (
                <fieldset className={styles.mentions}>
                  <legend>Mention staff</legend>
                  <StaffCheckboxes
                    ids={workflow.staff ?? []}
                    selected={mentions}
                    onChange={setMentions}
                  />
                </fieldset>
              )}
              <button
                type="button"
                className="button small secondary"
                disabled={!enabled || busy || !note.trim()}
                aria-busy={savingAction === "Adding note…"}
                onClick={() => void saveNote()}
              >
                {savingAction === "Adding note…"
                  ? savingAction
                  : "Add internal note"}
              </button>
            </div>
          </details>
          {(workflow.savedReplies?.length ?? 0) > 0 && (
            <details
              key={`${scope}:replies`}
              className={detailStyles.disclosure}
            >
              <summary className={detailStyles.summary}>
                <h3>Saved replies</h3>
                <span>{workflow.savedReplies?.length}</span>
              </summary>
              <div className={`${styles.detailSection} ${detailStyles.body}`}>
                <input
                  className={styles.detailSearch}
                  aria-label="Search saved replies"
                  placeholder="Search saved replies"
                  value={savedSearch}
                  onChange={(event) => setSavedSearch(event.target.value)}
                />
                <div className={styles.replyChoices}>
                  {replies.map((reply) => (
                    <button
                      type="button"
                      key={reply.id}
                      aria-pressed={preview === reply.text}
                      onClick={() => setPreview(reply.text)}
                    >
                      {reply.title}
                    </button>
                  ))}
                  {replies.length === 0 && (
                    <p className={styles.detailMuted}>
                      No saved reply matches.
                    </p>
                  )}
                </div>
                {preview && (
                  <div className={styles.replyPreview}>
                    <p className={styles.text}>{preview}</p>
                    <button
                      type="button"
                      className="button small"
                      onClick={() => {
                        onReply(preview);
                        setPreview("");
                      }}
                    >
                      Use in reply
                    </button>
                  </div>
                )}
              </div>
            </details>
          )}
          {activity.length > 0 && (
            <details
              key={`${scope}:activity`}
              className={detailStyles.disclosure}
            >
              <summary className={detailStyles.summary}>
                <h3>Activity</h3>
                <span>{activity.length}</span>
              </summary>
              <div className={`${styles.detailSection} ${detailStyles.body}`}>
                <ol className={styles.activity}>
                  <ActivityItems
                    draftsEnabled={draftsEnabled}
                    items={shownActivity}
                    conversation={conversation}
                  />
                </ol>
                {activity.length > 4 && (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setActivityOpen((value) => !value)}
                  >
                    {activityOpen
                      ? "Show less"
                      : `Show all ${activity.length} events`}
                  </button>
                )}
              </div>
            </details>
          )}
        </>
      )}
      <details
        key={`${scope}:screenshots`}
        className={detailStyles.disclosure}
        open={!team}
      >
        <summary className={detailStyles.summary}>
          <h3>Screenshots</h3>
          {workflow.attachments.length > 0 && (
            <span>{workflow.attachments.length}</span>
          )}
        </summary>
        <div className={`${styles.detailSection} ${detailStyles.body}`}>
          <p className={styles.detailMuted}>
            PNG only, up to 2 MiB, 4,096 pixels on either side and 4 megapixels
            total. Screenshots are private to this case. Up to 20 per case.
          </p>
          {workflow.attachments.map((item) => (
            <div key={item.id} className={styles.screenshot}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => void viewScreenshot(item.id)}
              >
                {item.author === conversation.member ||
                (item.author !== undefined &&
                  (conversation.formerMembers ?? []).includes(item.author))
                  ? "View the user’s screenshot from "
                  : "View screenshot from "}
                {new Date(item.at).toLocaleString()}
              </button>
              {screenshots[item.id] && (
                <img
                  src={screenshots[item.id]}
                  alt="Screenshot shared in this support case"
                />
              )}
            </div>
          ))}
          <label className={styles.upload}>
            <span>Add screenshot</span>
            <input
              type="file"
              accept="image/png"
              disabled={
                !enabled || busy || (team && conversation.staffMessagesStopped)
              }
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </details>
    </section>
  );
}

/** A wallet from the workflow read, checked before it is shown. A record
 * written before Solana sign-in has no network and reads as EVM. */
function walletView(value: unknown): WidgetWallet | null {
  if (!value || typeof value !== "object") return null;
  const { address } = value as { address?: unknown };
  return readStoredWidgetWallet({
    ...value,
    address:
      typeof address === "string" && address.startsWith("0x")
        ? address.toLowerCase()
        : address,
  });
}
/** The account page on the network's explorer, from Templ's own table and
 * only for a checked address. Never a link the member or their app sent. */
function walletExplorerUrl(wallet: WidgetWallet): string | null {
  if (wallet.network === "solana")
    return `${SOLANA_EXPLORER}/account/${wallet.address}`;
  return (
    supportWalletChain(wallet.chainId)?.address.replace(
      "{address}",
      wallet.address,
    ) ?? null
  );
}
/** Wallet address, network and the verification tag. */
function WalletLine({
  wallet,
  status,
}: {
  wallet: WidgetWallet;
  status: "verified" | "claimed";
}) {
  const url = walletExplorerUrl(wallet);
  const short =
    wallet.network === "solana"
      ? shortSolanaAddress(wallet.address)
      : `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  return (
    <dd>
      {url ? (
        <a
          className={styles.mono}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={wallet.address}
          aria-label={`Open ${wallet.address} in explorer`}
        >
          {short}
        </a>
      ) : (
        <span className={styles.mono} title={wallet.address}>
          {short}
        </span>
      )}
      {" on "}
      <span>
        {wallet.network === "solana"
          ? SOLANA_NAME
          : supportChainLabel(wallet.chainId)}
      </span>{" "}
      <Badge>{status === "verified" ? "Verified" : "Claimed"}</Badge>
    </dd>
  );
}
/** What the member shared, as the service checked it. Explorer links are
 * built from the chain table, never taken from what the member typed. */
function ContextFacts({
  context,
  thread,
}: {
  context: SupportContext;
  thread: string;
}) {
  const transactions = context.transactions ?? [];
  const legacy = context.legacy;
  const app = context.app ?? {};
  const typed = APP_FIELDS.filter((field) => app[field] !== undefined);
  if (
    !context.description &&
    !context.network &&
    !transactions.length &&
    !legacy &&
    !typed.length
  )
    return null;
  return (
    <dl className={styles.facts} id={`support-context-${thread}`} tabIndex={-1}>
      {context.description && (
        <div>
          <dt>Description</dt>
          <dd>{context.description}</dd>
        </div>
      )}
      {context.network && (
        <div>
          <dt>Network</dt>
          <dd>{inboxNetworkName(context.network)}</dd>
        </div>
      )}
      {transactions.map((tx) => {
        const url = supportTransactionUrl(tx);
        return (
          <div key={tx.hash}>
            <dt>Transaction</dt>
            <dd className={styles.mono}>{tx.hash}</dd>
            <dd>
              {tx.network ? inboxNetworkName(tx.network) : "Chain not stated"}
            </dd>
            {url && (
              <dd>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  Open in explorer
                </a>
              </dd>
            )}
          </div>
        );
      })}
      {/* The typed details from the protocol's app. */}
      {typed.map((field) => (
        <div key={field}>
          <dt>{APP_LABELS[field]}</dt>
          <dd>
            {field === "failure"
              ? FAILURE_KIND_LABELS[app.failure!.kind]
              : appValue(field, app, FAILURE_KIND_LABELS)}
          </dd>
          {field === "failure" && app.failure?.at && (
            <dd>{inboxTime(app.failure.at)}</dd>
          )}
          {field === "product" && app.product?.address && (
            <dd className={styles.mono}>
              {app.product.address}
              {app.product.network
                ? ` on ${inboxNetworkName(app.product.network)}`
                : ""}
            </dd>
          )}
          {field === "shown" && app.shown?.asOf && (
            <dd>As of {new Date(app.shown.asOf).toLocaleString()}</dd>
          )}
        </div>
      ))}
      {app.failure?.amount !== undefined && (
        <div>
          <dt>Amount</dt>
          <dd>
            {[
              app.failure.amount,
              app.failure.asset?.symbol ?? app.failure.asset?.address,
            ]
              .filter(Boolean)
              .join(" ")}
          </dd>
        </div>
      )}
      {legacy && (
        <div>
          <dt>Shared before Templ checked hashes</dt>
          {legacy.network && <dd className={styles.mono}>{legacy.network}</dd>}
          {legacy.transactionHash && (
            <dd className={styles.mono}>{legacy.transactionHash}</dd>
          )}
        </div>
      )}
    </dl>
  );
}
/** Exhaustive, so a new activity fails the type check until it has a label. */
export const ACTIVITY_LABELS: Record<
  SupportActivity["action"] | SupportCaseActivityAction,
  string
> = {
  status: "Status changed",
  assignment: "Assignment changed",
  tags: "Tags changed",
  note: "Note added",
  attachment: "Screenshot added",
  context: "Context shared",
  "verification-requested": "Asked to verify wallet",
  "wallet-verified": "Wallet verified",
  handoff: "Handed to a person",
  confirmed: "User answered",
  "time-spent": "Time spent recorded",
  "ai-mode": "AI mode changed",
  frame: "Case details changed",
  evidence: "Evidence added",
  "evidence-withdrawn": "Evidence withdrawn",
  "draft-request": "Asked the AI",
  "draft-held": "AI reply held for the team",
  "draft-used": "Reply sent from an AI draft",
  "draft-dismissed": "AI draft dismissed",
  "follow-up": FOLLOW_UP_ACTIVITY.changed,
};
const CONTEXT_ERRORS: Record<SupportContextReason, string> = {
  "invalid-transaction":
    "This doesn’t look like a transaction hash. Paste the hash or the explorer link.",
  "invalid-network":
    'Use a network like "eip155:8453" or "solana", or a name such as Base.',
  "invalid-context":
    "Share up to 5 transactions, with a description of at most 2,000 bytes.",
  "invalid-app-context": "Share details from the app in the documented shape.",
  "invalid-context-target":
    "Choose a detail you shared: the network, a transaction, the note or one detail from the app.",
};
/** A member's removal names the field, never its value. */
const REMOVED_FIELDS: Record<string, string> = {
  description: "the note",
  network: "the network",
  transaction: "a transaction",
  ...Object.fromEntries(
    APP_FIELDS.map((field) => [
      `app.${field}`,
      `the ${APP_LABELS[field].toLowerCase()}`,
    ]),
  ),
};
const TIME_SPENT_KEYS: Record<SupportTimeSpent, MessageKey> = {
  "under-5": "room.timeSpent.under-5",
  "5-15": "room.timeSpent.5-15",
  "15-30": "room.timeSpent.15-30",
  "30-60": "room.timeSpent.30-60",
  "over-60": "room.timeSpent.over-60",
};
/** One activity line. Details are codes, each shown as its label; an
 * unknown code keeps only the action's label. */
export function activityText(
  item: SupportActivity,
  actorName: string,
  byMember: boolean,
  draftsEnabled = false,
): string {
  const label = ACTIVITY_LABELS[item.action] ?? item.action;
  const detail = item.detail;
  // Case activity carries field names, counts or codes; staff see the plain
  // line, and a reply from a draft says whether it was edited.
  const action: string = item.action;
  if (action === "draft-used")
    return detail === "edited" ? `${label}, edited` : label;
  if (action === "follow-up") return followUpActivityText(detail);
  if (
    action === "frame" ||
    action === "draft-held" ||
    action === "draft-dismissed" ||
    action === "draft-request"
  )
    return label;
  if (item.action === "handoff") {
    if (byMember && detail === "person")
      return t("room.handoff.memberActivity");
    return isHandoffReason(detail)
      ? t("room.handoff.activity", { reason: handoffReasonLabel(detail) })
      : label;
  }
  if (item.action === "ai-mode") {
    const [mode, cause] = (detail ?? "").split(":");
    if (
      !SUPPORT_AI_MODES.includes(mode as SupportAiMode) ||
      !SUPPORT_AI_MODE_CAUSES.includes(cause as SupportAiModeCause)
    )
      return label;
    return t("room.ai.activity", {
      mode: aiModeLabel(mode as SupportAiMode, draftsEnabled),
      cause: aiCauseText(
        cause as SupportAiModeCause,
        cause === "person-thread" || cause === "transaction"
          ? undefined
          : actorName,
      ),
    });
  }
  if (item.action === "context" && detail?.startsWith("removed:")) {
    const field = REMOVED_FIELDS[detail.slice("removed:".length)];
    return field ? `User removed ${field}` : label;
  }
  if (item.action === "confirmed")
    return detail === "solved"
      ? `${label}: solved`
      : detail === "not-solved"
        ? `${label}: not solved`
        : label;
  if (item.action === "time-spent")
    return SUPPORT_TIME_SPENT.includes(detail as SupportTimeSpent)
      ? `${label}: ${t(TIME_SPENT_KEYS[detail as SupportTimeSpent]).toLowerCase()}`
      : label;
  return detail ? `${label}: ${detail}` : label;
}
/** The activity lines, with the actor's label where a cause names them.
 * Team view only: a member's view never looks up staff profiles. */
function ActivityItems({
  draftsEnabled,
  items,
  conversation,
}: {
  draftsEnabled: boolean;
  items: SupportActivity[];
  conversation: TeamConversation;
}) {
  const profiles = useMemberProfiles(items.map((item) => item.actor));
  return items.map((item) => (
    <li key={item.id}>
      <span>
        {activityText(
          item,
          profiles.get(item.actor)?.displayName?.trim() ||
            shortAccount(item.actor),
          item.actor === conversation.member ||
            (conversation.formerMembers ?? []).includes(item.actor),
          draftsEnabled,
        )}
      </span>
      <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
    </li>
  ));
}
const shortAccount = (id: string) =>
  id.length > 24 ? `${id.slice(0, 16)}…${id.slice(-6)}` : id;
/** "Copy to reply" on a note the AI agent wrote. With text already in the
 * reply box, a person picks Replace, Add below or Cancel first. */
export function AgentNoteCopy({
  note,
  replyText,
  confirming,
  onConfirm,
  onReply,
}: {
  note: SupportNote;
  replyText: string;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  onReply: (text: string) => void;
}) {
  if (!confirming)
    return (
      <button
        type="button"
        className={styles.linkButton}
        onClick={() => {
          if (replyText.trim()) onConfirm(note.id);
          else onReply(note.text);
        }}
      >
        {t("room.notes.copyToReply")}
      </button>
    );
  return (
    <div
      className={styles.noteConfirm}
      role="group"
      aria-label={t("room.notes.replaceConfirm")}
    >
      <p>{t("room.notes.replaceConfirm")}</p>
      <div>
        <button
          type="button"
          className="button small"
          onClick={() => {
            onConfirm(null);
            onReply(note.text);
          }}
        >
          {t("room.notes.replace")}
        </button>
        <button
          type="button"
          className="button small secondary"
          onClick={() => {
            onConfirm(null);
            onReply(`${replyText.trimEnd()}\n\n${note.text}`);
          }}
        >
          {t("room.notes.addBelow")}
        </button>
        <button
          type="button"
          className="button small quiet"
          onClick={() => onConfirm(null)}
        >
          {t("room.notes.cancel")}
        </button>
      </div>
    </div>
  );
}

/** Checkbox list with readable labels; values stay canonical account IDs. */
function StaffCheckboxes({
  ids,
  selected,
  onChange,
}: {
  ids: readonly string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const accounts = [...new Set(ids)];
  const profiles = useMemberProfiles(accounts);
  return (
    <div className={styles.checkList}>
      {accounts.map((id) => {
        const name = profiles.get(id)?.displayName?.trim();
        const short =
          id.length > 24 ? `${id.slice(0, 16)}…${id.slice(-6)}` : id;
        return (
          <label key={id} className={styles.detailCheck} title={id}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={selected.includes(id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, id]
                    : selected.filter((value) => value !== id),
                )
              }
            />
            {name ? `${name} (${short})` : short}
          </label>
        );
      })}
    </div>
  );
}
