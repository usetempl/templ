"use client";

import { sharedWalletAddresses } from "../lib/case-wallet-addresses";
import { CustomerEncryptedSupport } from "./customer-encrypted-support";
import { threadIdentityLabel } from "@templ/chat/support-identity-label";
import { InboxCaseRow } from "./inbox-case-row";
import { useReplyDraft } from "./use-reply-draft";
import {
  SUPPORT_IDENTITY_LABELS,
  identityOf,
  threadIdentity,
} from "@templ/chat/support-identity";
import {
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  IconArrowLeft,
  IconCheck,
  IconListCheck,
  IconCopy,
  IconFilter,
  IconMessageCircle,
  IconMessages,
  IconLoader2,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconShieldLock,
} from "@tabler/icons-react";
import type {
  ChatMessage,
  ChatAuthorFacts,
  ChatRoomId,
  TeamConversation,
  TeamConversationFilter,
  TeamConversationStatus,
  TeamConversationMessages,
  TeamConversationTyping,
} from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  type SupportAiMode,
  type SupportHandoffBy,
  type SupportHandoffReason,
  type SupportWorkflow,
} from "@templ/chat/support";
import { caseBillingLabel } from "@/lib/product-offer";
import { useChatAuth } from "@/lib/chat-auth";
import { chatHref } from "@/lib/chat-room-id";
import { CommunityApiError } from "@/lib/community-client";
import {
  subscribeCommunitySession,
  communitySessionRevision,
} from "@/lib/community-auth";
import { pacedSupportRequest } from "@/lib/support-request-pacing";
import { readCaseList, readSupport } from "@/lib/support-read";
import type { EarlyCasePage } from "./workspace/workspace-reads";
import { useInboxPreviews } from "@/lib/use-inbox-previews";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import {
  newChatMessageId,
  enqueueConversationMessage,
  restoreConversationOutbox,
  discardWorkspaceConversationOutbox,
  discardConversationOutbox,
  useChatOutbox,
  reconcileChatOutbox,
  retryChatMessage,
  canRetryChatMessage,
  forgetOutboxMessage,
} from "@/lib/chat-outbox";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import {
  askPerson,
  askTeam,
  conversationErrorMessage,
  conversationErrorReason,
  handOffConversation,
  listConversations,
  markTeamTyping,
  readConversationMessages,
  readConversationStatus,
  resolveConversation,
  setAiMode,
  generateAppAnswer,
  updateSupportWorkflow,
  stopTeamMessages,
} from "@/lib/team-conversations-client";
import { copy as t, type MessageKey } from "@/lib/copy";
import { ChatMessageText, messageDay } from "./chat-message-text";
// Safety and case UI.
// Current case access and author permissions apply.
import { RedactHexButton } from "./redact-hex-button";
import { caseStateLabel } from "./case-state-chip";
import { useComposeActivity } from "@/lib/use-compose-activity";
import {
  teamPresentationCache,
  teamQueueCacheKey,
} from "@/lib/team-conversations-cache";
import {
  readSupportDraft,
  readPendingSupportReplies,
  writeSupportDraft,
  readSupportInboxState,
  writeSupportInboxState,
  clearSupportWorkspaceState,
  clearSupportConversationState,
} from "@/lib/support-local-state";
import { ChatSkeleton } from "./loading-state";
import { CaseListSkeleton, InboxEmptyState } from "./workspace/inbox-states";
import { MemberIdentity } from "./member-identity";
import { Badge } from "./ui/ui";
import { StateLine } from "./state-line";
import { Identicon } from "./ui/identicon";
import styles from "./team-conversations.module.css";
import { useStaffChatWorkflow, useStaffChatPresence } from "./use-staff-chat-workflow";
import { SupportWorkflowPanel } from "./support-workflow-panel";
import {
  AiControl,
  HandOffMenu,
  HandoffBanner,
} from "./ai-control";
import { useActionToast } from "./action-toast";
import { SupportInboxSearch } from "./support-inbox-search";
import { SupportAccountOptions } from "./support-account-options";
import { DownloadChat } from "./workspace/download-chat";
import { InboxAlertsNudge } from "./workspace/inbox-alerts";
import { publishOpenInbox } from "@/lib/inbox-attention";
import { clearInboxCounts, requestInboxCounts } from "@/lib/inbox-counts";
import {
  turnChip,
  turnLine,
  waitAge,
} from "@/lib/inbox-turn";
import {
  InboxViews,
  agentOfflineLine,
  needsReadyViews,
  useInboxCounts,
} from "./inbox-views";
import {
  PhoneActions,
  PhoneConversation,
  PhoneDetails,
  PhoneDetailsButton,
} from "./phone-thread";
import {
  clearLinkedInboxView,
  readLinkedInboxView,
} from "@/lib/inbox-link-view";
import {
  InboxSystemLine,
  inboxThreadItems,
} from "./inbox-thread-markers";
/** The member's one conversation with a workspace's team and the team's
 * room-scoped queue.
 *
 * Members see the protocol team name and the disclosure before writing.
 * Newly authorized staff can read retained messages. The safety banner cannot be dismissed. Messages render as plain
 * text and ordinary links only: no token chips, NFT cards, wallet, approval,
 * signing, payment or swap controls, so nothing here can look like a
 * staff-endorsed transaction. Authority badges come from the worker's facts,
 * never from a chosen name. */
export const ACCOUNT_SETTINGS_PATH = "/settings/account";
/** Each empty view names the cases it contains. */
const EMPTY_KEYS: Partial<Record<TeamConversationFilter, MessageKey>> = {
  "needs-you": "shell.inbox.emptyNeedsYou",
  "ai-handling": "shell.inbox.emptyAi",
  "waiting-on-member": "shell.inbox.emptyWaiting",
  open: "shell.inbox.emptyOpen",
  resolved: "shell.inbox.emptyResolved",
  "needs-reply": "shell.inbox.emptyNeedsReply",
  "needs-person": "shell.inbox.emptyNeedsPerson",
};
const POLL_MS = 15_000;
/** While a reply may land soon: the member just wrote, or someone is
 * typing. */
const WAITING_POLL_MS = 3_000;
/** The member's own message keeps the thread reading quickly this long. */
const WAITING_WINDOW_MS = 5 * 60_000;
/** A person's typing mark goes at most this often, and only after they
 * typed in this thread. */
export const TYPING_MARK_MS = 5_000;
/** The AI agent is still writing after this long: say so. */
const SLOW_AGENT_MS = 60_000;
/** Milliseconds since an ISO time; read when rendering. */
const ageOf = (value: string, now = Date.now()) => now - Date.parse(value);
/** A window focus right after a read reads nothing new. */
export const FOCUS_REFRESH_MS = 10_000;
const accessEnded = (reason: unknown) =>
  reason instanceof CommunityApiError &&
  [401, 403, 404].includes(reason.status);
const shortTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
function shortTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? shortTimeFormatter.format(date)
    : date.toLocaleTimeString();
}
type BodyProps = {
  features?: Partial<import("@templ/chat/workspace-flags").WorkspaceFeatures>;
  room: ChatRoomId;
  communityName: string;
  /** "mine" opens the member's thread; "team" the queue. */
  view: "mine" | "team";
  visibility: "public" | "private";
  /** Bumps whenever room permissions or membership changed, so the panel
   * re-reads its status and drops anything it may no longer read. */
  revision: number;
  /** A conversation to open at once (staff opening one they just started). */
  initialConversation?: string | null;
  firstCasePage?: EarlyCasePage;
};
/** Reads current access, then renders the workspace queue or member thread. */
function TeamConversationsBody(props: BodyProps) {
  const account = useChatAuth().session?.principalId;
  const sessionRevision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  return (
    <ScopedTeamConversationsBody
      key={`${props.room}:${account}:${sessionRevision}:${props.revision}:${props.view}`}
      {...props}
    />
  );
}
function ScopedTeamConversationsBody({
  features,
  room,
  communityName,
  view,
  visibility,
  revision,
  initialConversation = null,
  firstCasePage,
}: BodyProps) {
  const auth = useChatAuth();
  const account = auth.session?.principalId;
  const cache = useMemo(
    () => teamPresentationCache(room, account, revision),
    [room, account, revision],
  );
  const [status, setStatus] = useState<TeamConversationStatus | null>(
    () => cache.status() ?? null,
  );
  // The workspace hands over the status it just read, so the queue and the
  // saved selection show at once while the status is read again.
  const [primedTeam] = useState(() => cache.status()?.team === true);
  const hadTeamAccess = useRef(status?.team === true);
  const linkedConversation = useRef(initialConversation);
  const [statusError, setStatusError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => {
    if (initialConversation) return initialConversation;
    const known = cache.status();
    if (view === "mine") return known?.mine ?? null;
    return known?.team
      ? (readSupportInboxState(room, account).selected ?? null)
      : null;
  });
  /** The queue row a thread was opened from, shown until its read lands. */
  const [selectedRow, setSelectedRow] = useState<TeamConversation | null>(null);
  const statusRefresh = useRef<() => void>(() => {});
  // The status read is the one source of what this account may do here; it
  // is re-read on every permission or membership change, and a lost right
  // closes the thread view at once.
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let refreshAgain = false;
    let lastRead = 0;
    const read = async (initial = false) => {
      if (controller.signal.aborted) return;
      if (pending) {
        refreshAgain = true;
        return;
      }
      pending = true;
      try {
        const next = await readSupport(
          (signal) => readConversationStatus(room, signal),
          controller.signal,
        );
        if (!controller.signal.aborted) {
          lastRead = Date.now();
          if (hadTeamAccess.current && !next.team) {
            cache.clear();
            discardWorkspaceConversationOutbox(room, account);
            clearSupportWorkspaceState(room, account);
            clearInboxCounts(room, account);
          }
          hadTeamAccess.current = next.team;
          cache.rememberStatus(next);
          setStatus(next);
          setStatusError("");
          if ((initial && view === "mine") || (view === "team" && !next.team))
            setSelected(next.mine);
          // With a handed-over status the selection was restored at once;
          // a row picked since then stays picked.
          else if (
            initial &&
            next.team &&
            (!primedTeam || initialConversation !== linkedConversation.current)
          )
            setSelected(
              initialConversation ??
                readSupportInboxState(room, account).selected ??
                null,
            );
          if (initial) linkedConversation.current = initialConversation;
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          if (accessEnded(reason)) {
            hadTeamAccess.current = false;
            cache.clear();
            discardWorkspaceConversationOutbox(room, account);
            clearSupportWorkspaceState(room, account);
            clearInboxCounts(room, account);
            setStatus(null);
            setSelected(null);
          }
          setStatusError(conversationErrorMessage(reason, t));
        }
      } finally {
        pending = false;
        if (refreshAgain && !controller.signal.aborted) {
          refreshAgain = false;
          void read();
        }
      }
    };
    const refresh = () => {
      if (!document.hidden) void read();
    };
    const focused = () => {
      if (Date.now() - lastRead >= FOCUS_REFRESH_MS) refresh();
    };
    statusRefresh.current = () => void read();
    void read(true);
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", focused);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", focused);
    };
  }, [room, view, revision, account, initialConversation, cache, primedTeam]);
  const refreshStatus = useCallback(() => {
    statusRefresh.current();
  }, []);
  const selectConversation = useCallback(
    (id: string | null, row?: TeamConversation) => {
      setSelected(id);
      // Picking the open thread again keeps its row, and reads nothing new.
      setSelectedRow((previous) =>
        !row || row.id !== id ? null : previous?.id === id ? previous : row,
      );
      writeSupportInboxState(room, account, { selected: id });
    },
    [room, account],
  );
  const openCase = useRef(selected);
  openCase.current = selected;
  const seed = selectedRow?.id === selected ? selectedRow : null;
  const team = status?.team === true && view === "team";
  // Stable handlers: the thread's loader depends on them, and a new function
  // per render would start a second read of the same page.
  const onOpened = useCallback(
    (id: string) => {
      selectConversation(id);
      refreshStatus();
    },
    [refreshStatus, selectConversation],
  );
  const onBack = useMemo(
    () => (team ? () => selectConversation(null) : undefined),
    [team, selectConversation],
  );
  const onRevoked = useCallback(() => {
    selectConversation(null);
    refreshStatus();
  }, [refreshStatus, selectConversation]);
  /** Bumps after a person's reply, resolve, reopen, handoff, AI change or
   * assignment in the open thread: the queue re-reads its visible pages
   * once and the workspace reads fresh counts, so the row changes view
   * within a read. */
  const [queueNudge, setQueueNudge] = useState(0);
  const [pendingCases, setPendingCases] = useState<
    Record<string, TeamConversation>
  >({});
  const previewCase = useCallback(
    (id: string, value: TeamConversation | null) => {
      setPendingCases((previous) => {
        const next = { ...previous };
        if (value) next[id] = value;
        else delete next[id];
        return next;
      });
    },
    [],
  );
  const onQueueChange = useCallback(() => {
    setQueueNudge((value) => value + 1);
    requestInboxCounts(room, account);
  }, [room, account]);
  return (
    <>
      {statusError && (
        <p className={styles.error} role="alert">
          {statusError}{" "}
          <button
            type="button"
            className={styles.linkButton}
            onClick={refreshStatus}
          >
            Retry
          </button>
        </p>
      )}
      {!status &&
        !statusError &&
        (view === "team" ? <CaseListSkeleton /> : <ChatSkeleton />)}
      {status && team && (
        <div className={styles.split} data-selected={Boolean(selected)}>
          <TeamQueue
            draftsEnabled={features?.aiDrafts === true}
            key={`queue:${room}:${account ?? "guest"}`}
            room={room}
            revision={revision}
            available={status.available}
            bulkAvailable={status.available && status.supportWorkflowAvailable === true}
            onBulkChanged={(ids) => {
              const current = openCase.current;
              if (current && ids.includes(current)) selectConversation(null);
              onQueueChange();
            }}
            needsReplyReady={status.needsReplyReady === true}
            onOpen={selectConversation}
            selected={selected}
            nudge={queueNudge}
            pendingCases={pendingCases}
            firstCasePage={firstCasePage}
          />
          <div className={styles.splitMain}>
            {selected ? (
              <ConversationView
                features={features}
                key={`conversation:${room}:${account ?? "guest"}:staff`}
                room={room}
                communityName={communityName}
                status={status}
                conversationId={selected}
                seed={seed}
                account={account}
                onSignIn={auth.signIn}
                visibility={visibility}
                revision={revision}
                onOpened={onOpened}
                onBack={onBack}
                onRevoked={onRevoked}
                onQueueChange={onQueueChange}
                onPreviewCase={previewCase}
              />
            ) : (
              <div className={styles.noSelection}>
                <span aria-hidden="true">
                  <IconMessages size={26} />
                </span>
                <h2>Open a case</h2>
                <p>Select a case to read the conversation and reply.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {status && !team && (
        <ConversationView
          features={features}
          key={`conversation:${room}:${account ?? "guest"}:${status.team ? "staff" : "member"}`}
          room={room}
          communityName={communityName}
          status={status}
          conversationId={selected}
          seed={seed}
          account={account}
          onSignIn={auth.signIn}
          visibility={visibility}
          revision={revision}
          onOpened={onOpened}
          onBack={onBack}
          onRevoked={onRevoked}
          onQueueChange={team ? onQueueChange : undefined}
        />
      )}
    </>
  );
}
/** The workspace inbox: the queue beside the open thread and its details.
 * Members get their one thread with the team behind the safety banner. */
export function TeamConversationsPane(props: BodyProps) {
  return (
    <section className={styles.pane} aria-label={t("room.team.queueTitle")}>
      <TeamConversationsBody {...props} />
    </section>
  );
}
/** The team's room-scoped queue. Members never see it; a member who reaches
 * it through a stale link sees only their own thread. */
function TeamQueue({
  draftsEnabled,
  room,
  revision,
  available,
  bulkAvailable,
  onBulkChanged,
  needsReplyReady = false,
  onOpen,
  selected = null,
  nudge = 0,
  pendingCases,
  firstCasePage,
}: {
  draftsEnabled: boolean;
  room: ChatRoomId;
  revision: number;
  available: boolean;
  bulkAvailable: boolean;
  onBulkChanged: (ids: string[]) => void;
  /** The service says its case ledger and views are ready: the queue opens
   * on Needs you. */
  needsReplyReady?: boolean;
  /** The row comes along so the thread can show it while it loads. */
  onOpen: (id: string, row?: TeamConversation) => void;
  selected?: string | null;
  /** Changes after an action in the open thread: re-read the visible pages
   * once. */
  nudge?: number;
  pendingCases?: Record<string, TeamConversation>;
  firstCasePage?: EarlyCasePage;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const account = useChatAuth().session?.principalId;
  const filterId = useId();
  const [savedInbox] = useState(() => readSupportInboxState(room, account));
  /** The service's words when a ledger view is still being set up. The
   * queue shows All open for the rest of this visit. */
  const [preparing, setPreparing] = useState("");
  // A view saved since this release wins; a saved ledger view waits until
  // the service is ready. Everyone else starts on Needs you.
  const [filter, setFilterValue] = useState<TeamConversationFilter>(() => {
    // A link's view (alert links open Needs you) comes first.
    const linked = readLinkedInboxView();
    if (linked && (!needsReadyViews(linked) || needsReplyReady)) return linked;
    const saved = savedInbox.filter;
    if (saved && (!needsReadyViews(saved) || needsReplyReady)) return saved;
    return needsReplyReady ? "needs-you" : "open";
  });
  // The service's preparing answer holds for the rest of this visit, so
  // picking another view keeps the earlier bar.
  const setFilter = (value: TeamConversationFilter) => {
    setSelection(null);
    clearLinkedInboxView();
    setFilterValue(value);
    writeSupportInboxState(room, account, { filter: value });
  };
  const viewsReady = needsReplyReady && !preparing;
  const { counts, aiShown } = useInboxCounts(room, account);
  const offline = viewsReady ? agentOfflineLine(counts) : null;
  const [filters, setFiltersValue] = useState({
    category: "",
    ...(savedInbox.filters ?? {
      member: "",
      tag: "",
      after: "",
      before: "",
    }),
    assignee: "",
  });
  const setFilters = (value: typeof filters) => {
    setSelection(null);
    setFiltersValue(value);
    writeSupportInboxState(room, account, { filters: value });
  };
  const [filterDraft, setFilterDraft] = useState(filters);
  // Each read names the query it answers; a filter or revision change shows
  // the loading line again without a synchronous reset inside the effect.
  const query = teamQueueCacheKey(filter, filters);
  const cache = useMemo(
    () => teamPresentationCache(room, account, revision),
    [room, account, revision],
  );
  const [loaded, setLoaded] = useState<{
    query: string;
    rows?: TeamConversation[];
    nextCursor?: string | null;
    pending?: "refresh" | "more" | "retry";
    error?: string;
  }>();
  const current: typeof loaded =
    loaded?.query === query
      ? loaded
      : cache.queue(query)
        ? { query, ...cache.queue(query) }
        : undefined;
  const rows = current?.rows ?? null;
  const error = current?.error ?? "";
  const readQueue = useRef<(more?: boolean) => void>(() => {});
  /** Re-reads the visible pages, after the read in flight when there is one. */
  const rereadQueue = useRef<() => void>(() => {});
  const seenNudge = useRef(nudge);
  useEffect(() => {
    if (seenNudge.current === nudge) return;
    seenNudge.current = nudge;
    rereadQueue.current();
  }, [nudge]);
  const profiles = useMemberProfiles(rows?.map(row => row.member) ?? []);
  const listScroll = useRef<HTMLDivElement>(null);
  const previewFor = useInboxPreviews(room, rows, listScroll, cache);
  const [selection, setSelection] = useState<{ query: string; ids: string[] } | null>(null);
  const selectionActive = selection?.query === query && bulkAvailable;
  const candidates = rows?.filter(row =>
    row.viewer === "team" && !row.encryption && !row.support?.archivedAt &&
    row.support?.state !== "spam" && !pendingCases?.[row.id],
  ) ?? [];
  const selectable = new Set(candidates.map(row => row.id));
  const checked = selectionActive ? selection.ids.filter(id => selectable.has(id)) : [];
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const bulkRequest = useRef<AbortController | null>(null);
  const bulkChanges = useRef(0);
  useEffect(() => () => bulkRequest.current?.abort(), []);

  function toggleCase(id: string) {
    if (!selectable.has(id) || bulkRequest.current) return;
    setSelection(previous => {
      if (!previous || previous.query !== query) return previous;
      const ids = previous.ids.includes(id)
        ? previous.ids.filter(selected => selected !== id)
        : [...previous.ids, id];
      return { query, ids };
    });
  }

  function selectVisibleCases() {
    const list = listScroll.current;
    if (!list || bulkRequest.current) return;
    const bounds = list.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom);
    const visible = Array.from(list.querySelectorAll<HTMLElement>("[data-inbox-case]"))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > top && rect.top < bottom;
      })
      .map(element => element.dataset.inboxCase!)
      .filter(id => selectable.has(id));
    setSelection(previous => previous?.query === query
      ? { query, ids: [...new Set([...previous.ids, ...visible])] }
      : previous);
  }

  async function markSpam() {
    if (!account || bulkRequest.current || !checked.length) return;
    const action = new AbortController();
    bulkRequest.current = action;
    setBulkStatus(null);
    setBulkBusy(true);
    const done: string[] = [];
    const failed: string[] = [];
    const remaining = checked.values();
    async function updateNext() {
      for (const id of remaining) {
        if (action.signal.aborted) return;
        try {
          const result = await updateSupportWorkflow(account, room, id, { action: "status", state: "spam" });
          if (result.workflow.summary.state === "spam") done.push(id);
          else failed.push(id);
        } catch {
          failed.push(id);
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, checked.length) }, updateNext));
      if (action.signal.aborted) return;
      setSelection(previous => previous?.query === query ? { query, ids: failed } : previous);
      setBulkStatus({
        text: failed.length
          ? `${done.length} marked as spam. ${failed.length} couldn’t be updated.`
          : `${done.length} marked as spam.`,
        failed: Boolean(failed.length),
      });
      if (done.length) {
        bulkChanges.current += 1;
        cache.forgetQueues();
        const confirmed = new Set(done);
        setLoaded(previous => {
          if (!previous?.rows) return previous;
          const rows = previous.query.startsWith("all:")
            ? previous.rows.map(row => confirmed.has(row.id) && row.support
              ? { ...row, state: "resolved" as const, support: { ...row.support, state: "spam" as const } }
              : row)
            : previous.rows.filter(row => !confirmed.has(row.id));
          return { ...previous, rows };
        });
        onBulkChanged(done);
      }
    } finally {
      bulkRequest.current = null;
      if (!action.signal.aborted) setBulkBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let visiblePage = cache.queue(query);
    let pageChanges: number | undefined;
    let retryMore = false;
    let pending = false;
    let again = false;
    let lastRead = 0;
    const read = async (more = false) => {
      if (pending || controller.signal.aborted || (more && !visiblePage?.nextCursor)) return;
      pending = true;
      const changes = bulkChanges.current;
      setLoaded((previous) => ({
        ...(previous?.query === query
          ? previous
          : { query, ...cache.queue(query) }),
        error: undefined,
        pending: more ? "more" : "refresh",
      }));
      try {
        // Re-read the visible pages together: a resolved or newly opened
        // conversation can move across page boundaries between refreshes.
        // More cases can use the last page's cursor and leave visible rows in place.
        const previous = more && pageChanges === changes ? visiblePage : undefined;
        const rows = new Map(previous?.rows.map((row) => [row.id, row]));
        let cursor = previous?.nextCursor ?? null;
        const cursors = new Set(cursor ? [cursor] : []);
        let pages = previous?.pages ?? 0;
        const pageLimit = (visiblePage?.pages ?? 1) + (more ? 1 : 0);
        do {
          const load = (signal: AbortSignal) => {
            const early = pages === 0 && firstCasePage?.query === query
              ? firstCasePage.take()
              : undefined;
            return early ?? listConversations(room, filter, cursor, signal, filters);
          };
          const page = pages === 0 || filter === "all"
            ? await readCaseList(load, controller.signal, () =>
                setLoaded((previous) => previous?.query === query
                  ? { ...previous, pending: "retry" }
                  : previous),
                filter === "all",
              )
            : await readSupport(load, controller.signal);
          if (controller.signal.aborted) return;
          for (const row of page.conversations) rows.set(row.id, row);
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor))
            throw new Error(t("room.team.errorGeneric"));
          if (cursor) cursors.add(cursor);
          pages += 1;
        } while (cursor && pages < pageLimit);
        if (changes !== bulkChanges.current) {
          retryMore = more;
          again = true;
          return;
        }
        const page = { rows: [...rows.values()], nextCursor: cursor, pages };
        visiblePage = page;
        pageChanges = changes;
        cache.rememberQueue(query, page);
        setLoaded({ query, ...page });
        lastRead = Date.now();
        // Every open chat is on screen: the workspace's badge and alerts
        // use this read instead of reading the same list again.
        if (!cursor && query === teamQueueCacheKey("open"))
          publishOpenInbox(room, account, page.rows);
      } catch (reason) {
        if (
          !controller.signal.aborted &&
          conversationErrorReason(reason) === "needs-reply-preparing"
        ) {
          again = false;
          setPreparing(
            reason instanceof Error ? reason.message : t("room.team.noOpen"),
          );
          setFilterValue("open");
          return;
        }
        if (!controller.signal.aborted && accessEnded(reason)) {
          visiblePage = undefined;
          cache.clear();
          discardWorkspaceConversationOutbox(room, account);
          clearSupportWorkspaceState(room, account);
          clearInboxCounts(room, account);
        }
        if (!controller.signal.aborted)
          setLoaded((previous) => ({
            ...(previous?.query === query && !accessEnded(reason)
              ? previous
              : { query }),
            pending: undefined,
            error: conversationErrorMessage(reason, t, "team"),
          }));
      } finally {
        pending = false;
        if (again && !controller.signal.aborted) {
          again = false;
          const more = retryMore;
          retryMore = false;
          void read(more);
        }
      }
    };
    readQueue.current = (more) => void read(more);
    rereadQueue.current = () => {
      if (pending) again = true;
      else void read();
    };
    void read();
    const refresh = () => {
      if (!document.hidden) void read();
    };
    const focused = () => {
      if (Date.now() - lastRead >= FOCUS_REFRESH_MS) refresh();
    };
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", focused);
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("focus", focused);
    };
  }, [room, account, filter, revision, query, filters, cache, firstCasePage]);
  const activeFilters = Object.values(filters).filter(Boolean).length;
  const filterForm = (
    <form
      className={styles.filterForm}
      onSubmit={(event) => {
        event.preventDefault();
        setFilters(filterDraft);
        setFiltersOpen(false);
      }}
    >
      {(
        ["member", "tag", "category", "after", "before"] as const
      ).map((name) => (
        <label key={name}>
          {
            {
              member: "User",
              tag: "Tag",
              category: "Category",
              after: "Created after",
              before: "Created before",
            }[name]
          }
          <input
            type={name === "after" || name === "before" ? "date" : "text"}
            list={
              ["member", "tag", "category"].includes(name)
                ? `${filterId}-${name}`
                : undefined
            }
            value={filterDraft[name]}
            onChange={(event) =>
              setFilterDraft((previous) => ({
                ...previous,
                [name]: event.target.value,
              }))
            }
            maxLength={150}
            placeholder={
              name === "member"
                ? "Account ID"
                : name === "tag"
                  ? "deposit"
                  : undefined
            }
          />
        </label>
      ))}
      <datalist id={`${filterId}-member`}>
        <SupportAccountOptions ids={rows?.map((row) => row.member) ?? []} />
      </datalist>
      <datalist id={`${filterId}-tag`}>
        {[
          ...new Set(rows?.flatMap((row) => row.support?.tags ?? []) ?? []),
        ].map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <datalist id={`${filterId}-category`}>
        {[
          ...new Set(
            rows?.flatMap((row) =>
              row.support?.category ? [row.support.category] : [],
            ) ?? [],
          ),
        ].map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
      <p className={styles.filterHint}>
        Suggestions come from loaded cases. Tags match without capitalization.
      </p>
      <div className={styles.filterActions}>
        <button type="submit" className="button small">
          Apply filters
        </button>
        <button
          type="button"
          className="button small quiet"
          onClick={() => {
            const empty = {
              member: "",
              assignee: "",
              tag: "",
              category: "",
              after: "",
              before: "",
            };
            setFilterDraft(empty);
            setFilters(empty);
          }}
        >
          Clear filters
        </button>
      </div>
    </form>
  );
  return (
    <div className={styles.queue}>
      <div className={styles.queueHead}>
        <h1>{t("room.team.list")}</h1>
        <div className={styles.queueHeadActions}>
          {bulkAvailable && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={selectionActive ? "Cancel selection" : "Select cases"}
              title={selectionActive ? "Cancel selection" : "Select cases"}
              aria-pressed={selectionActive}
              disabled={bulkBusy}
              onClick={() => {
                setBulkStatus(null);
                setSelection(selectionActive ? null : { query, ids: [] });
              }}
            >
              <IconListCheck size={17} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("room.team.refresh")}
            title={t("room.team.refresh")}
            disabled={!!current?.pending}
            onClick={() => readQueue.current()}
          >
            <IconRefresh
              size={17}
              aria-hidden="true"
              className={
                current?.pending === "refresh" ? styles.spinning : undefined
              }
            />
          </button>
          <button
              type="button"
              className={styles.iconButton}
              aria-label="Filters"
              title="Filters"
              aria-expanded={filtersOpen}
              data-active={activeFilters > 0}
              onClick={() => setFiltersOpen((value) => !value)}
            >
              <IconFilter size={17} aria-hidden="true" />
              {activeFilters > 0 && (
                <span className={styles.filterCount}>{activeFilters}</span>
              )}
            </button>
        </div>
      </div>
      <SupportInboxSearch
        key={`search:${room}:${account}`}
        room={room}
        onOpen={onOpen}
      />

      {filtersOpen && <div className={styles.filterPanel}>{filterForm}</div>}
      {!available && (
        <p className={styles.note} role="status">
          {t("room.team.unavailableNote")}
        </p>
      )}
      {preparing && (
        <p className={styles.note} role="status">
          {preparing}
        </p>
      )}
      {offline && (
        <p className={styles.note} role="status" data-note="agent-offline">
          {offline}
        </p>
      )}
      <InboxViews
        value={filter}
        ready={viewsReady}
        counts={counts}
        showAiHandling={aiShown}
        onChange={setFilter}
      />

      {selectionActive && (
        <div className={styles.bulkBar} aria-label="Selected cases">
          <button
            type="button"
            className="button small secondary"
            disabled={!selectable.size || bulkBusy}
            onClick={selectVisibleCases}
          >
            Select visible
          </button>
          <button
            type="button"
            className="button small"
            disabled={bulkBusy || !checked.length}
            onClick={() => void markSpam()}
          >
            {bulkBusy ? "Marking spam…" : checked.length ? `Mark ${checked.length} as spam` : "Mark as spam"}
          </button>
        </div>
      )}
      {selectionActive && rows && rows.length > 0 && !candidates.length && (
        <p className={styles.bulkStatus}>None of these cases can be marked as spam.</p>
      )}
      {bulkStatus && (
        <p className={styles.bulkStatus} role={bulkStatus.failed ? "alert" : "status"}>
          {bulkStatus.text}
        </p>
      )}
      {current?.pending === "retry" && (
        <p role="status">Reconnecting to cases…</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}{" "}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => readQueue.current()}
          >
            {t("room.team.refresh")}
          </button>
        </p>
      )}
      {current?.pending === "retry" && (
        <p className={styles.note} role="status">Trying the case list again…</p>
      )}
      <div
        ref={listScroll}
        className={styles.listScroll}
        data-view={filter}
      >
        {rows === null && !error && <CaseListSkeleton />}
        {rows?.length === 0 && !current?.nextCursor && !error && (
          <div className={styles.queueEmpty}>
                <InboxEmptyState
                  message={
                    activeFilters > 0
                      ? "shell.inbox.emptyFiltered"
                      : (EMPTY_KEYS[filter] ?? "shell.inbox.emptyView")
                  }
                  action={
                    activeFilters > 0 ? (
                      <button
                        type="button"
                        className="button small secondary"
                        onClick={() => {
                          const cleared = {
                            member: "",
                            assignee: "",
                            tag: "",
                            category: "",
                            after: "",
                            before: "",
                          };
                          setFilterDraft(cleared);
                          setFilters(cleared);
                        }}
                      >
                        {t("shell.inbox.clearFilters")}
                      </button>
                    ) : undefined
                  }
                />
                {filter === "needs-you" &&
                  activeFilters === 0 &&
                  counts &&
                  counts.aiHandling > 0 && (
                    <p className={styles.filterHint}>
                      {t(
                        counts.aiHandling === 1 && !counts.more
                          ? "room.inbox.aiBusyOne"
                          : "room.inbox.aiBusyMany",
                        {
                          n: `${counts.aiHandling}${counts.more ? "+" : ""}`,
                        },
                      )}
                    </p>
                  )}
                {filter === "needs-you" && activeFilters === 0 && (
                  <InboxAlertsNudge
                    className={styles.queueNudge}
                    textClassName={styles.filterHint}
                  />
                )}
          </div>
        )}
        {rows && rows.length > 0 && (
          <ul className={styles.list} aria-label={t("room.team.list")}>
            {rows.map((savedRow) => {
              const row = pendingCases?.[savedRow.id] ?? savedRow;
              const profile = profiles.get(row.member);
              const preview = previewFor(row);
              const name = profile?.displayName?.trim();
              const label = name || (preview ? "" : row.encryption ? "Encrypted conversation" : "Guest");
              const waitSince = row.support?.turn !== "member" ? row.support?.waitingSince : undefined;
              const at = row.support?.lastAt ?? row.lastMessageAt ?? row.createdAt;
              const chip = row.handoff ? turnChip(row, undefined, draftsEnabled) : null;
              const statusLabel = row.support?.state === "spam" ? "Spam"
                : row.state === "resolved" && filter === "all" ? "Resolved" : null;
              return (
                <li
                  key={row.id}
                  data-inbox-case={row.id}
                  className={selectionActive ? styles.selectableRow : undefined}
                >
                  {selectionActive && (
                    <input
                      type="checkbox"
                      className={styles.selectCase}
                      aria-label={`Select case: ${preview || label || "Guest"}`}
                      checked={checked.includes(row.id)}
                      disabled={bulkBusy || !selectable.has(row.id)}
                      onChange={() => toggleCase(row.id)}
                    />
                  )}
                  <InboxCaseRow
                    label={label}
                    requestPreview={preview}
                    avatar={
                      <Identicon
                        seed={row.member}
                        profile={profile}
                        size={32}
                        radius={10}
                      />
                    }
                    time={
                      <time dateTime={waitSince ?? at} title={new Date(waitSince ?? at).toLocaleString()}>
                        {waitSince ? waitAge(waitSince) : relativeTime(at)}
                      </time>
                    }
                    selected={selectionActive ? checked.includes(row.id) : row.id === selected}
                    selectionChecked={selectionActive ? checked.includes(row.id) : undefined}
                    disabled={selectionActive && (bulkBusy || !selectable.has(row.id))}
                    unread={row.support?.unread === true}
                    busy={Boolean(pendingCases?.[row.id])}
                    humanRequest={
                      row.state === "open" &&
                      (row.support?.turnReason === "asked" ||
                        (!row.support?.turn &&
                          (row.handoff?.reason === "person" ||
                            row.handoff?.by === "member")))
                    }
                    onOpen={selectionActive ? () => toggleCase(row.id) : () => onOpen(row.id, row)}
                  >
                      <span className={styles.rowMeta}>
                        {chip && <span className={styles.tag} title={chip.text}>{chip.text}</span>}
                        {statusLabel && <span className={styles.tag}>{statusLabel}</span>}
                        {row.staffMessagesStopped && <span className={styles.tag}>{t("room.team.rowStopped")}</span>}
                        {row.support?.test && <span className={styles.tag}>{t("room.turn.test")}</span>}
                        {row.support?.tags.map((tag) => <span key={tag} className={styles.tag}>{tag}</span>)}
                        {row.support?.unread && <span className={styles.srOnly}>Unread</span>}
                      </span>
                  </InboxCaseRow>
                </li>
              );
            })}
          </ul>
        )}
        {current?.nextCursor && (
          <button
            type="button"
            className={`button small secondary ${styles.more}`}
            disabled={!!current.pending}
            onClick={() => readQueue.current(true)}
          >
            {current.pending === "more"
              ? t("room.team.loading")
              : t("room.team.loadMore")}
          </button>
        )}
      </div>
    </div>
  );
}
const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "narrow",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
/** "4m", "3h" for recent activity; a date after a day. */
export function relativeTime(value: string, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour");
  return dayFormat.format(new Date(time));
}
export function SupportLink({
  room,
  visibility,
}: {
  room: ChatRoomId;
  visibility: "public" | "private";
}) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState("");
  async function copy() {
    // Build from the room ID, never the current URL's invitation or thread.
    const url = new URL(chatHref(room), window.location.origin);
    url.searchParams.set("team", "1");
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setManual("");
    } catch {
      setCopied(false);
      setManual(url.toString());
    }
  }
  return (
    <div className={styles.supportLink}>
      <button
        type="button"
        className={styles.secondary}
        onClick={() => void copy()}
      >
        {copied ? (
          <IconCheck size={16} aria-hidden="true" />
        ) : (
          <IconCopy size={16} aria-hidden="true" />
        )}
        {copied ? t("room.invite.linkCopied") : t("room.team.copySupportLink")}
      </button>
      {visibility === "private" && (
        <span className={styles.linkNote}>
          {t("room.team.supportMembersOnly")}
        </span>
      )}
      {manual && (
        <label className={styles.manualLink}>
          {t("room.handoff.copyThisLink")}
          <input
            readOnly
            value={manual}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}
/** One conversation, for the fixed member or a current team member. */
function ConversationView({
  features,
  room,
  communityName,
  status,
  conversationId,
  seed = null,
  account,
  onSignIn,
  visibility,
  revision,
  onOpened,
  onBack,
  onRevoked,
  onQueueChange,
  onPreviewCase,
}: {
  room: ChatRoomId;
  communityName: string;
  status: TeamConversationStatus;
  features?: Partial<import("@templ/chat/workspace-flags").WorkspaceFeatures>;
  conversationId: string | null;
  /** The queue row this thread was opened from. It lets the details load
   * with the messages; the thread's own read replaces it. */
  seed?: TeamConversation | null;
  account?: ChatPrincipalId;
  onSignIn: () => Promise<unknown>;
  visibility: "public" | "private";
  revision: number;
  onOpened: (id: string) => void;
  onBack?: () => void;
  onRevoked: () => void;
  /** A person's action here may move the request to another inbox view. */
  onQueueChange?: () => void;
  onPreviewCase?: (id: string, value: TeamConversation | null) => void;
}) {
  const cache = useMemo(
    () => teamPresentationCache(room, account, revision),
    [room, account, revision],
  );
  const [cachedPage] = useState(() =>
    conversationId ? cache.thread(conversationId) : undefined,
  );
  const [conversation, setConversation] = useState<TeamConversation | null>(
    cachedPage?.conversation ??
      (seed && seed.id === conversationId ? seed : null),
  );
  const [messages, setMessages] = useState<ChatMessage[]>(
    cachedPage?.messages ?? [],
  );
  /** The thread whose messages are on screen, from its read or the cache. */
  const [shownThread, setShownThread] = useState<string | null>(
    cachedPage ? conversationId : null,
  );
  const lastLoadedAt = useRef(0);
  const outbox = useChatOutbox(room, conversationId ?? "support-new", account);
  const outboxEntries = useRef(outbox.messages);
  outboxEntries.current = outbox.messages;
  const [authors, setAuthors] = useState<Record<string, ChatAuthorFacts>>(
    (cachedPage?.authors ?? {}) as never,
  );
  const [text, setTextValue] = useState("");
  const currentText = useRef(text);
  currentText.current = text;
  /** Who is writing a reply here now, from the latest thread read. */
  const [typing, setTyping] = useState<TeamConversationTyping>(null);
  /** The thread this person typed in since opening it. Only then do their
   * typing marks and composing presence go out: a restored draft is not
   * typing. */
  const [typedIn, setTypedIn] = useState<string | null>(null);
  const lastTypingMark = useRef(0);
  /** The latest handoff this member saw. Its line stays until a team or AI
   * agent message arrives after it, so taking the request before replying
   * never turns it back into "The team has your message". */
  const [sticky, setSticky] = useState<{
    thread: string;
    by: SupportHandoffBy;
    after: string | null;
  } | null>(null);
  /** The member tapped "Talk to a person" and the request is on its way. */
  const [asking, setAsking] = useState<string | null>(null);
  const [categoryPrompt, setCategoryPrompt] = useState<string | null>(null);
  /** The details panel’s latest workflow read. */
  const [panelWorkflow, setPanelWorkflow] = useState<{
    thread: string;
    workflow: SupportWorkflow;
  } | null>(null);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const draftHint = useId();
  const toast = useActionToast();
  const draftTicket = conversationId ?? "new";
  const restoredDraft = useRef<string | null>(null);
  const setText = useCallback(
    (value: string) => {
      setTextValue(value);
      writeSupportDraft(room, account, draftTicket, "reply", { text: value });
    },
    [room, account, draftTicket],
  );
  const restoreDraft = useCallback(() => {
    if (restoredDraft.current === draftTicket) return;
    restoredDraft.current = draftTicket;
    setTextValue(
      readSupportDraft(room, account, draftTicket, "reply")?.text ?? "",
    );
  }, [room, account, draftTicket]);
  const [busy, setBusy] = useState(false);
  const pendingMutation = useRef<string | null>(null);
  const caseMutations = useRef(
    new Map<string, { conversation: TeamConversation; text: string }>(),
  );
  const [panelScope, setPanelScope] = useState({ id: conversationId });
  if (panelScope.id !== conversationId) setPanelScope({ id: conversationId });
  const pendingPanelMutation = useRef<typeof panelScope | null>(null);
  const [caseAction, setCaseAction] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [waitingToOpen, setWaitingToOpen] = useState(false);
  const openingRequest = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [revoked, setRevoked] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(
    cachedPage?.nextBefore ?? null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const history = useRef<TeamConversationMessages | null>(cachedPage ?? null);
  const activeConversation = useRef<string | null>(conversationId);
  useLayoutEffect(
    () => () => {
      activeConversation.current = null;
    },
    [],
  );
  const reading = useRef(false);
  const refreshAfterRead = useRef(false);
  const readOlder = useRef<() => void>(() => {});
  const refreshThread = useRef<() => Promise<void>>(async () => {});
  const scrollAnchor = useRef<{
    top: number;
    height: number;
  } | null>(null);
  const stickToLatest = useRef(true);
  const mutationRevision = useRef(0);
  const imeComposing = useRef(false);
  useLayoutEffect(() => {
    imeComposing.current = false;
    return () => {
      imeComposing.current = false;
    };
  }, [room, account, conversationId]);
  const sendAttempt = useRef<{
    text: string;
    conversation: string | null;
    clientId: string;
  } | null>(null);
  useLayoutEffect(() => {
    const cancel = () => openingRequest.current?.abort();
    const unsubscribe = subscribeCommunitySession(cancel);
    return () => {
      cancel();
      unsubscribe();
    };
  }, [room, account]);
  const list = useRef<HTMLDivElement>(null);
  const clearCaseAccess = useCallback(
    (missingThread?: string) => {
      mutationRevision.current += 1;
      refreshAfterRead.current = false;
      for (const id of caseMutations.current.keys()) {
        if (missingThread && id !== missingThread) continue;
        onPreviewCase?.(id, null);
        caseMutations.current.delete(id);
      }
      pendingMutation.current = null;
      pendingPanelMutation.current = null;
      setCaseAction(null);
      setBusy(false);
      cache.clear();
      if (missingThread) {
        discardConversationOutbox(room, missingThread, account);
        clearSupportConversationState(room, account, missingThread);
      } else {
        discardWorkspaceConversationOutbox(room, account);
        clearSupportWorkspaceState(room, account);
      }
      for (const message of outboxEntries.current)
        forgetOutboxMessage(message.clientId);
      setConversation(null);
      setMessages([]);
      setAuthors({});
      setTextValue("");
      sendAttempt.current = null;
      setNextBefore(null);
      history.current = null;
      setShownThread(null);
      setTyping(null);
      setPanelWorkflow(null);
      setRevoked(true);
      onRevoked();
    },
    [cache, room, account, onRevoked, onPreviewCase],
  );
  // The member's profile is usually cached from the queue already.
  const profiles = useMemberProfiles([
    ...(conversation ? [conversation.member] : []),
    ...messages.map((message) => message.author),
    ...(conversation?.assignment ? [conversation.assignment.principalId] : []),
  ]);
  const load = useCallback(
    async (signal: AbortSignal, before?: string) => {
      if (
        !conversationId ||
        reading.current ||
        signal.aborted ||
        pendingMutation.current === conversationId
      )
        return;
      reading.current = true;
      const mutation = mutationRevision.current;
      let requestedAt = Date.now();
      if (before) setLoadingOlder(true);
      try {
        let page = await readSupport(
          (requestSignal) =>
            readConversationMessages(
              room,
              conversationId,
              {
                limit: 50,
                // Reply email: the newest page read with the tab
                // visible marks the team's replies seen; the room writes it for
                // the member only.
                ...(before
                  ? { before }
                  : typeof document !== "undefined" &&
                      document.visibilityState === "visible"
                    ? { seen: true }
                    : {}),
              },
              requestSignal,
            ),
          signal,
        );
        if (signal.aborted || mutation !== mutationRevision.current) return;
        let previous = history.current;
        // A deletion invalidates every cached page, including older history.
        // Start at the latest page again instead of retaining removed text.
        if (previous && previous.deletionRevision !== page.deletionRevision) {
          previous = null;
          history.current = null;
          setMessages([]);
          setAuthors({});
          setNextBefore(null);
          if (before) {
            requestedAt = Date.now();
            page = await readSupport(
              (requestSignal) =>
                readConversationMessages(
                  room,
                  conversationId,
                  { limit: 50 },
                  requestSignal,
                ),
              signal,
            );
            if (signal.aborted || mutation !== mutationRevision.current) return;
          }
        }
        const element = list.current;
        stickToLatest.current =
          !previous ||
          (!!element &&
            element.scrollHeight - element.scrollTop - element.clientHeight <
              60);
        if (before && previous) {
          if (element)
            scrollAnchor.current = {
              top: element.scrollTop,
              height: element.scrollHeight,
            };
          const merged = new Map(
            [...previous.messages, ...page.messages].map((message) => [
              message.id,
              message,
            ]),
          );
          page = {
            ...page,
            messages: [...merged.values()].sort((a, b) =>
              BigInt(a.id) < BigInt(b.id) ? -1 : 1,
            ),
            authors: { ...previous.authors, ...page.authors },
          };
        } else if (
          previous &&
          page.messages.some((message) =>
            previous.messages.some((older) => older.id === message.id),
          )
        ) {
          // Keep the pages the person opened while replacing the latest page.
          // Without overlap there may be a gap, so use the new page's cursor.
          const first = BigInt(page.messages[0].id);
          const older = previous.messages.filter(
            (message) => BigInt(message.id) < first,
          );
          page = {
            ...page,
            messages: [...older, ...page.messages],
            nextBefore: older.length ? previous.nextBefore : page.nextBefore,
            authors: { ...previous.authors, ...page.authors },
          };
        }
        history.current = page;
        cache.rememberThread(conversationId, page);
        setConversation(page.conversation);
        setTyping(page.typing ?? null);
        if (page.conversation.handoff)
          setSticky({
            thread: conversationId,
            by: page.conversation.handoff.by ?? "person",
            after: page.messages[page.messages.length - 1]?.id ?? null,
          });
        // A resolution ends the request, and the handoff line with it.
        else if (page.conversation.state === "resolved") setSticky(null);
        restoreDraft();
        setMessages(page.messages);
        setShownThread(conversationId);
        lastLoadedAt.current = Date.now();
        restoreConversationOutbox(room, conversationId, account);
        reconcileChatOutbox(
          room,
          conversationId!,
          account,
          page.messages,
          before ? 0 : requestedAt,
        );
        setAuthors((page.authors ?? {}) as never);
        setNextBefore(page.nextBefore);
        setRevoked(false);
        setError("");
      } catch (reason) {
        if (signal.aborted) return;
        // A 404 can mean one case was deleted. The fresh status separates
        // that from role loss. No refused case stays visible during the read.
        if (reason instanceof CommunityApiError && reason.status === 404) {
          cache.clear();
          discardConversationOutbox(room, conversationId, account);
          clearSupportConversationState(room, account, conversationId);
          setConversation(null);
          setMessages([]);
          setAuthors({});
          setTextValue("");
          setPanelWorkflow(null);
          setRevoked(true);
          let currentTeam = false;
          try {
            currentTeam =
              (
                await readSupport(
                  (requestSignal) =>
                    readConversationStatus(room, requestSignal),
                  signal,
                )
              ).team === true;
          } catch {
            /* Unknown current access keeps the workspace-wide refusal. */
          }
          if (signal.aborted || mutation !== mutationRevision.current) return;
          clearCaseAccess(currentTeam ? conversationId : undefined);
          return;
        }
        // An expired session or lost grant must clear every cached page.
        if (accessEnded(reason)) {
          clearCaseAccess();
          return;
        }
        setError(conversationErrorMessage(reason, t));
      } finally {
        if (!signal.aborted) {
          reading.current = false;
          setLoadingOlder(false);
          if (refreshAfterRead.current) {
            refreshAfterRead.current = false;
            void load(signal);
          }
        }
      }
    },
    [room, conversationId, account, clearCaseAccess, cache, restoreDraft],
  );
  useLayoutEffect(() => {
    const controller = new AbortController();
    reading.current = false;
    refreshAfterRead.current = false;
    history.current = conversationId
      ? (cache.thread(conversationId) ?? null)
      : null;
    setNextBefore(history.current?.nextBefore ?? null);
    setLoadingOlder(false);
    setError("");
    if (activeConversation.current !== conversationId) {
      const pendingCase = conversationId
        ? caseMutations.current.get(conversationId)
        : undefined;
      const leavingCaseMutation = activeConversation.current
        ? caseMutations.current.has(activeConversation.current)
        : false;
      if (pendingPanelMutation.current) {
        pendingPanelMutation.current = null;
        pendingMutation.current = null;
        mutationRevision.current += 1;
        setBusy(false);
      }
      if (leavingCaseMutation || pendingCase) {
        pendingMutation.current = pendingCase ? conversationId : null;
        mutationRevision.current += 1;
        setBusy(Boolean(pendingCase));
        setCaseAction(
          pendingCase ? { id: conversationId!, text: pendingCase.text } : null,
        );
      }
      const cached = conversationId ? cache.thread(conversationId) : undefined;
      setConversation(
        pendingCase?.conversation ??
          cached?.conversation ??
          (seed && seed.id === conversationId ? seed : null),
      );
      setMessages(cached?.messages ?? []);
      setShownThread(cached ? conversationId : null);
      setAuthors((cached?.authors ?? {}) as never);
      setTextValue("");
      restoredDraft.current = null;
      setTyping(null);
      setTypedIn(null);
      setCategoryPrompt(null);
      lastTypingMark.current = 0;
      sendAttempt.current = null;
    }
    if (!conversationId || caseMutations.current.has(conversationId))
      restoreDraft();
    activeConversation.current = conversationId;
    readOlder.current = () => {
      const before = history.current?.nextBefore;
      if (before) void load(controller.signal, before);
    };
    refreshThread.current = async () => {
      if (reading.current) {
        refreshAfterRead.current = true;
        return;
      }
      await load(controller.signal);
    };
    void load(controller.signal);
    const refresh = () => {
      if (!document.hidden) void load(controller.signal);
    };
    const focused = () => {
      if (Date.now() - lastLoadedAt.current >= FOCUS_REFRESH_MS) refresh();
    };
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", focused);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", focused);
    };
  }, [load, revision, conversationId, cache, restoreDraft, seed]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (scrollAnchor.current) {
      element.scrollTop =
        scrollAnchor.current.top +
        element.scrollHeight -
        scrollAnchor.current.height;
      scrollAnchor.current = null;
    } else if (stickToLatest.current) {
      element.scrollTo({ top: element.scrollHeight });
    }
  }, [messages, typing]);
  const viewerIsMember = conversation?.viewer === "member";
  /** The member side is the thread's member plus any guest id it held
   * before proving a wallet; anyone else writing is the team. */
  const teamSideOf = (message: ChatMessage) => {
    const facts = authors[message.author];
    return conversation
      ? message.author !== conversation.member &&
          !conversation.formerMembers?.some(
            (former) => former === message.author,
          )
      : Boolean(
          facts?.badges.some(
            (badge) =>
              badge === "manager" || badge === "moderator" || badge === "bot",
          ),
        );
  };
  const lastMessage = messages[messages.length - 1];
  const unconfirmed = outbox.messages.filter(
    (pending) =>
      !messages.some((message) => message.clientId === pending.clientId),
  );
  /** A send the service accepted that no thread read shows yet. */
  const sentUnread = unconfirmed
    .filter((pending) => pending.delivery === "sent")
    .map((pending) => pending.clientId)
    .join(",");
  const failedUnread = unconfirmed
    .filter(
      (pending) => pending.delivery === "failed" && pending.retryable === false,
    )
    .map((pending) => pending.clientId)
    .join(",");
  const checkedFailures = useRef(new Set<string>());
  const memberName = conversation
    ? memberLabel(profiles.get(conversation.member), conversation.member)
    : undefined;
  const canWrite =
    Boolean(account) &&
    status.available &&
    (conversation
      ? conversation.canPost
      : !conversationId && status.canAsk && !revoked);
  const teamView = conversation
    ? conversation.viewer === "team"
    : status.team === true;
  const workflowEnabled = status.supportWorkflowAvailable === true;
  const openRequest =
    conversation?.state === "open" && !conversation.staffMessagesStopped;
  const lastMine = Boolean(lastMessage && !teamSideOf(lastMessage));
  // Read every few seconds while a reply may land: someone is typing, a
  // send is on its way, or the member's own message is recent.
  const waiting =
    Boolean(conversation) &&
    openRequest &&
    (typing !== null ||
      unconfirmed.some((pending) => pending.delivery !== "failed") ||
      (!teamView &&
        lastMine &&
        ageOf(lastMessage!.createdAt) < WAITING_WINDOW_MS));
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshThread.current();
    }, WAITING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting]);
  // A confirmed send is read back at once, so what happens next shows
  // within one read. A person's reply also moves the request in the queue.
  useEffect(() => {
    if (!sentUnread) return;
    void refreshThread.current();
    onQueueChange?.();
  }, [sentUnread, onQueueChange]);
  useEffect(() => {
    if (busy) return;
    const failed = new Set(failedUnread ? failedUnread.split(",") : []);
    const changed = [...failed].some((id) => !checkedFailures.current.has(id));
    checkedFailures.current = failed;
    // A write refusal can mean lost access or a business limit. Read the
    // case immediately; only that read decides whether it stays visible.
    if (changed) void refreshThread.current();
  }, [failedUnread, busy]);
  const onPanelWorkflow = useCallback(
    (workflow: SupportWorkflow | undefined) => {
      if (!conversationId || activeConversation.current !== conversationId)
        return;
      setPanelWorkflow(workflow ? { thread: conversationId, workflow } : null);
      if (!workflow) {
        mutationRevision.current += 1;
        void refreshThread.current();
      }
    },
    [conversationId],
  );
  const staffThread = teamView && workflowEnabled && !revoked && !conversation?.encryption
    ? conversation?.id ?? null : null;
  useStaffChatWorkflow(room, staffThread, workflowRevision, onPanelWorkflow);
  const workflowNow =
    conversation && panelWorkflow?.thread === conversation.id
      ? panelWorkflow.workflow
      : null;
  /** A status, assignment, tag or note change in the details panel. */
  const panelChanged = () => {
    void refreshThread.current();
    onQueueChange?.();
  };
  function beginPanelMutation() {
    if (
      !conversation ||
      activeConversation.current !== conversation.id ||
      busy ||
      pendingMutation.current
    )
      return false;
    pendingPanelMutation.current = panelScope;
    pendingMutation.current = conversation.id;
    mutationRevision.current += 1;
    setBusy(true);
    return true;
  }
  function endPanelMutation() {
    if (
      pendingMutation.current !== conversation?.id ||
      pendingPanelMutation.current !== panelScope
    )
      return;
    mutationRevision.current += 1;
    pendingPanelMutation.current = null;
    pendingMutation.current = null;
    setBusy(false);
    setWorkflowRevision((value) => value + 1);
    void refreshThread.current();
  }
  // Observed compose activity.
  // Current case access and author permissions apply.
  const composeActivity = useComposeActivity(conversation?.id);
  const typedSinceOpen = Boolean(conversation) && typedIn === conversation?.id;
  useStaffChatPresence(room, account, staffThread, shownThread === staffThread,
    typedSinceOpen && composeActivity.active && Boolean(text.trim()));
  /** A person's typing mark: only after they type here, at most every
   * TYPING_MARK_MS, never for a member. Refusals are ignored; the reply
   * itself says why it can't go. */
  function noteTyping(value: string) {
    if (!conversation || !teamView) return;
    if (typedIn !== conversation.id) setTypedIn(conversation.id);
    if (!value.trim() || !canWrite) return;
    const now = Date.now();
    if (now - lastTypingMark.current < TYPING_MARK_MS) return;
    lastTypingMark.current = now;
    void markTeamTyping(account, room, conversation.id).catch(() => {});
  }
  async function submit(event: FormEvent, replyIntent?: "answer" | "update") {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy || openingRequest.current || !canWrite) return;
    const target = conversation?.id ?? null;
    const savedAttempt = readSupportDraft(
      room,
      account,
      draftTicket,
      "reply",
    )?.attempt;
    if (
      sendAttempt.current?.text !== body ||
      sendAttempt.current.conversation !== target
    )
      sendAttempt.current = {
        text: body,
        conversation: target,
        clientId:
          savedAttempt?.text === body ? savedAttempt.id : newChatMessageId(),
      };
    const clientId = sendAttempt.current.clientId;
    writeSupportDraft(room, account, draftTicket, "reply", {
      text,
      attempt: { text: body, id: clientId },
    });
    const controller = new AbortController();
    openingRequest.current = controller;
    setBusy(true);
    setError("");
    try {
      if (conversation) {
        enqueueConversationMessage(
          room,
          conversation.id,
          account!,
          body,
          undefined,
          teamView && conversation.answerIntentRequired
            ? (replyIntent ?? "answer")
            : undefined,
        );
        stickToLatest.current = true;
        // The reply clears the mark; the next keystroke may mark again.
        lastTypingMark.current = 0;
      } else {
        const draft = { text: body, clientId };
        const result = await pacedSupportRequest(
          (assertCurrent) => askTeam(account, room, draft, assertCurrent),
          controller.signal,
          setWaitingToOpen,
        );
        const followUp =
          currentText.current !== text ? currentText.current : "";
        writeSupportDraft(room, account, result.conversation.id, "reply", {
          text: followUp,
        });
        writeSupportDraft(room, account, "new", "reply", { text: "" });
        restoredDraft.current = result.conversation.id;
        currentText.current = followUp;
        setTextValue(followUp);
        activeConversation.current = result.conversation.id;
        setConversation(result.conversation);
        if (result.message) setMessages([result.message]);
        onOpened(result.conversation.id);
      }
      sendAttempt.current = null;
      if (currentText.current === text) setText("");
    } catch (reason) {
      // A recovery phrase was refused and stored nowhere: keep no copy of
      // it in the reply box or this device's saved draft either.
      if (conversationErrorReason(reason) === "secret-refused") {
        sendAttempt.current = null;
        if (currentText.current === text) setText("");
      }
      if (
        !controller.signal.aborted &&
        !(reason instanceof DOMException && reason.name === "AbortError")
      )
        setError(
          conversationErrorMessage(reason, t, teamView ? "team" : "member"),
        );
    } finally {
      if (openingRequest.current === controller) openingRequest.current = null;
      controller.abort();
      setWaitingToOpen(false);
      setBusy(false);
    }
  }
  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSignIn();
    } catch (reason) {
      if (!isChatSignInCanceled(reason))
        setError(conversationErrorMessage(reason, t));
    } finally {
      setBusy(false);
    }
  }
  async function setStopped(stopped: boolean) {
    if (!conversation) return;
    setBusy(true);
    setError("");
    try {
      const result = stopped
        ? await stopTeamMessages(account, room, conversation.id, true)
        : await askTeam(account, room, {});
      mutationRevision.current += 1;
      setConversation(result.conversation);
    } catch (reason) {
      setError(conversationErrorMessage(reason, t, "member"));
    } finally {
      setBusy(false);
    }
  }
  function beginCaseMutation(optimistic: TeamConversation, text: string) {
    const id = optimistic.id;
    if (
      activeConversation.current !== id ||
      busy ||
      pendingMutation.current ||
      caseMutations.current.has(id)
    )
      return null;
    const mutation = { conversation: optimistic, text };
    caseMutations.current.set(id, mutation);
    pendingMutation.current = id;
    mutationRevision.current += 1;
    setConversation(optimistic);
    onPreviewCase?.(id, optimistic);
    setCaseAction({ id, text });
    setBusy(true);
    setError("");
    return mutation;
  }
  function endCaseMutation(
    id: string,
    mutation: { conversation: TeamConversation; text: string },
  ) {
    if (caseMutations.current.get(id) !== mutation) return;
    caseMutations.current.delete(id);
    onPreviewCase?.(id, null);
    if (activeConversation.current !== id) return;
    mutationRevision.current += 1;
    pendingMutation.current = null;
    setCaseAction(null);
    setBusy(false);
  }
  async function setResolved(resolved: boolean, category?: string) {
    if (!conversation) return;
    const previous = conversation;
    const id = previous.id;
    const optimistic: TeamConversation = {
      ...previous,
      state: resolved ? "resolved" : "open",
      ...(previous.support
        ? {
            support: {
              ...previous.support,
              state: resolved ? "resolved" : "open",
            },
          }
        : {}),
    };
    const mutation = beginCaseMutation(
      optimistic,
      resolved ? "Resolving…" : "Reopening…",
    );
    if (!mutation) return;
    try {
      const result = await resolveConversation(account, room, id, resolved, {
        ifRevision: previous.revision,
        ...(resolved && category ? { category } : {}),
      });
      if (caseMutations.current.get(id) !== mutation) return;
      setConversation((current) =>
        current?.id === id ? result.conversation : current,
      );
      if (activeConversation.current === id) setCategoryPrompt(null);
      onQueueChange?.();
    } catch (reason) {
      if (caseMutations.current.get(id) !== mutation) return;
      if (
        reason instanceof CommunityApiError &&
        [401, 404].includes(reason.status)
      ) {
        if (activeConversation.current === id) {
          let currentTeam = false;
          if (reason.status === 404) {
            cache.clear();
            setConversation(null);
            setMessages([]);
            setAuthors({});
            setTextValue("");
            setPanelWorkflow(null);
            setRevoked(true);
            const revision = mutationRevision.current;
            try {
              currentTeam =
                (
                  await readSupport(
                    (signal) => readConversationStatus(room, signal),
                    new AbortController().signal,
                  )
                ).team === true;
            } catch {
              /* Unknown access fails closed. */
            }
            if (
              activeConversation.current !== id ||
              revision !== mutationRevision.current
            )
              return;
          }
          clearCaseAccess(currentTeam ? id : undefined);
        } else {
          cache.forgetThread(id);
          writeSupportDraft(room, account, id, "reply", { text: "" });
          writeSupportDraft(room, account, id, "note", { text: "" });
          if (account)
            for (const pending of readPendingSupportReplies(room, account, id))
              forgetOutboxMessage(pending.clientId);
        }
        return;
      }
      setConversation((current) => (current?.id === id ? previous : current));
      if (activeConversation.current === id) {
        setError(conversationErrorMessage(reason, t, "team"));
        if (
          reason instanceof CommunityApiError &&
          reason.details &&
          typeof reason.details === "object" &&
          "reason" in reason.details &&
          reason.details.reason === "category-required"
        )
          setCategoryPrompt(id);
      } else toast.show("Could not update the case. Open it to try again.");
    } finally {
      endCaseMutation(id, mutation);
    }
  }
  /** Take over from AI, Let AI answer or a mode from the AI menu. */
  async function chooseAiMode(mode: SupportAiMode, takeOver?: true, generate = false) {
    if (!conversation) return;
    const id = conversation.id;
    const mutation = beginCaseMutation(
      conversation,
      takeOver ? "Taking over…" : "Saving AI setting…",
    );
    if (!mutation) return;
    let changed = false;
    try {
      const result = generate ? await generateAppAnswer(account, room, id) : await setAiMode(
        account,
        room,
        id,
        takeOver ? { mode, takeOver } : { mode },
      );
      if (caseMutations.current.get(id) !== mutation) return;
      changed = true;
      setConversation((previous) =>
        previous?.id === id
          ? {
              ...previous,
              ai: result.workflow.ai ?? previous.ai,
              ...((takeOver || mode === "answers") &&
              previous.handoff?.by !== "member"
                ? { handoff: null }
                : {}),
            }
          : previous,
      );
      if (activeConversation.current === id) {
        if (generate) toast.show(t("room.ai.generationQueued"));
        else if (takeOver) toast.show(t("room.ai.tookOver"));
        else if (mode === "answers") toast.show(t("room.ai.letAnswerDone"));
      }
      onQueueChange?.();
    } catch (reason) {
      if (caseMutations.current.get(id) !== mutation) return;
      if (activeConversation.current === id)
        setError(conversationErrorMessage(reason, t, "team"));
      else toast.show("Could not update the case. Open it to try again.");
    } finally {
      const current =
        activeConversation.current === id &&
        caseMutations.current.get(id) === mutation;
      endCaseMutation(id, mutation);
      if (current && changed) {
        setWorkflowRevision((value) => value + 1);
        void refreshThread.current();
      }
    }
  }
  async function handOff(reason: SupportHandoffReason) {
    if (!conversation) return;
    const id = conversation.id;
    const mutation = beginCaseMutation(conversation, "Handing to the team…");
    if (!mutation) return;
    let changed = false;
    try {
      await handOffConversation(account, room, id, reason);
      if (caseMutations.current.get(id) !== mutation) return;
      changed = true;
      setConversation((previous) =>
        previous?.id === id && !previous.handoff
          ? {
              ...previous,
              handoff: { at: new Date().toISOString(), reason, by: "person" },
            }
          : previous,
      );
      onQueueChange?.();
    } catch (failure) {
      if (caseMutations.current.get(id) !== mutation) return;
      if (activeConversation.current === id)
        setError(conversationErrorMessage(failure, t, "team"));
      else toast.show("Could not update the case. Open it to try again.");
    } finally {
      const current =
        activeConversation.current === id &&
        caseMutations.current.get(id) === mutation;
      endCaseMutation(id, mutation);
      if (current && changed) {
        setWorkflowRevision((value) => value + 1);
        void refreshThread.current();
      }
    }
  }
  /** "Talk to a person": the member's line shows at once, before the
   * service answers. A refusal takes it back and says why. */
  async function askForPerson() {
    if (!conversation || asking) return;
    const id = conversation.id;
    const after = lastMessage?.id ?? null;
    setAsking(id);
    setError("");
    try {
      const result = await askPerson(account, room, id);
      setSticky({ thread: id, by: result.handoff?.by ?? "member", after });
      await refreshThread.current();
      composer.current?.focus();
    } catch (reason) {
      setError(conversationErrorMessage(reason, t, "member"));
    } finally {
      setAsking(null);
    }
  }
  const blocked = conversation?.postBlockedReason ?? null;
  const replyBlocked = teamView ? (conversation?.replyBlocked ?? null) : null;
  const resolveButton =
    conversation &&
    conversation.viewer === "team" &&
    (conversation.state === "open" ? (
      <button
        type="button"
        className="button small secondary"
        disabled={busy || !status.available}
        onClick={() => void setResolved(true)}
      >
        <IconCheck aria-hidden="true" /> {t("room.team.resolve")}
      </button>
    ) : (
      <button
        type="button"
        className="button small secondary"
        disabled={
          busy || !status.available || conversation.staffMessagesStopped
        }
        onClick={() => void setResolved(false)}
      >
        {t("room.team.reopen")}
      </button>
    ));
  const stopButton =
    conversation &&
    viewerIsMember &&
    (conversation.staffMessagesStopped ? (
      <button
        type="button"
        className="button small secondary"
        disabled={busy || !status.available}
        onClick={() => void setStopped(false)}
      >
        <IconMessages size={16} aria-hidden="true" /> {t("room.team.resume")}
      </button>
    ) : (
      <button
        type="button"
        className="button small quiet"
        disabled={busy || !status.available}
        onClick={() => void setStopped(true)}
      >
        {t("room.team.stop")}
      </button>
    ));
  // Thread reads and successful mode changes share the same mutation guard.
  // A details-panel read can predate a completed takeover.
  const ai = teamView ? (conversation?.ai ?? null) : null;
  useEffect(() => {
    if (ai?.generation !== "queued" && ai?.generation !== "dispatched") return;
    const timer = setInterval(() => {
      if (!document.hidden) void refreshThread.current();
    }, 3000);
    return () => clearInterval(timer);
  }, [ai?.generation, conversation?.id]);
  const handoff = conversation?.handoff ?? null;
  const hasMemberRequest =
    Boolean(conversation?.support?.lastMemberMessageAt) ||
    messages.some((message) => !teamSideOf(message));
  const latestVisitorMessage = shownThread === conversation?.id
    ? messages.findLast(message => !teamSideOf(message))
    : undefined;
  const draftMessage = useMemo(
    () => latestVisitorMessage ? { id: latestVisitorMessage.id, revision: latestVisitorMessage.revision ?? 1 } : undefined,
    [latestVisitorMessage],
  );
  const replyDraft = useReplyDraft({
    room,
    account,
    thread: conversation?.id ?? null,
    enabled: teamView && workflowEnabled && !revoked && !conversation?.encryption && openRequest &&
      features?.aiDrafts === true && ai?.agentRegistered === true && ai.mode !== "off" && hasMemberRequest,
    latest: draftMessage,
    refreshKey: workflowRevision,
    text,
    onUse(value) {
      setText(value);
      composer.current?.focus({ preventScroll: true });
    },
    onError: toast.show,
  });
  const canHandOff =
    teamView &&
    workflowEnabled &&
    status.available &&
    Boolean(conversation) &&
    openRequest &&
    conversation?.support?.state !== "spam" &&
    !handoff &&
    hasMemberRequest;
  const teammateWriting = (workflowNow?.presence ?? []).some(
    (person) => person.composing && person.principalId !== account,
  );
  const labelFor = (principalId: string) =>
    (conversation?.assignment?.principalId === principalId
      ? conversation.assignment.teamName
      : null) ||
    messages.find(
      (message) => message.author === principalId && message.teamName,
    )?.teamName ||
    memberLabel(profiles.get(principalId), principalId);
  const aiBar = teamView &&
    conversation &&
    workflowEnabled &&
    (ai?.agentRegistered || canHandOff) && (
      <div className={styles.aiBar}>
        <AiControl
          draftsEnabled={features?.aiDrafts === true}
          ai={ai}
          handoff={handoff}
          replyHasText={Boolean(text.trim())}
          teammateWriting={teammateWriting}
          canManage={workflowNow?.canManage === true}
          busy={busy || !status.available}
          name={labelFor}
          onChoose={(mode, takeOver) => void chooseAiMode(mode, takeOver)}
          onGenerate={features?.appAiReplies === true ? () => void chooseAiMode("answers", undefined, true) : undefined}
        />
        {canHandOff && (
          <HandOffMenu
            agentRegistered={ai?.agentRegistered === true}
            busy={busy}
            onHandOff={(reason) => void handOff(reason)}
          />
        )}
      </div>
    );
  const banner = teamView && conversation && handoff && (
    <div className={styles.handoffSlot}>
      <HandoffBanner handoff={handoff} />
    </div>
  );
  // Who acts next, for the header: from the thread read, else the details
  // panel's read, whichever says whose turn it is. The newest team message
  // on screen names who replied.
  const summaries = [conversation?.support, workflowNow?.summary];
  const lastTeamMessage =
    conversation && shownThread === conversation.id
      ? [...messages].reverse().find(teamSideOf)
      : undefined;
  const stateLine =
    teamView && conversation
      ? turnLine({
          conversation,
          summary:
            summaries.find((summary) => summary?.turn) ??
            summaries.find(Boolean),
          viewer: account,
          name: labelFor,
          lastReply: lastTeamMessage
            ? {
                author: lastTeamMessage.author,
                at: lastTeamMessage.createdAt,
                agent:
                  authors[lastTeamMessage.author]?.badges.includes("bot") ===
                  true,
              }
            : null,
          typing,
          bannerShown: Boolean(banner),
          draftsEnabled: features?.aiDrafts === true,
        })
      : null;
  const earlierLine = (thread: TeamConversation) => ({
    state: thread.support
      ? caseStateLabel(thread.support)
      : thread.state === "resolved"
        ? "Resolved"
        : "Open",
    detail: "",
  });
  // What happens next, under the latest message. The member sees who
  // answers next; the team sees who is typing. Nothing here is a message.
  const lastBot = Boolean(
    lastMessage &&
    teamSideOf(lastMessage) &&
    authors[lastMessage.author]?.badges.includes("bot"),
  );
  const teamSpokeAfter = (after: string | null) =>
    messages.some(
      (message) =>
        teamSideOf(message) &&
        (after === null || BigInt(message.id) > BigInt(after)),
    );
  const handoffBy: SupportHandoffBy | null =
    !viewerIsMember || !conversation || !openRequest
      ? null
      : asking === conversation.id
        ? "member"
        : handoff
          ? (handoff.by ?? "person")
          : sticky?.thread === conversation.id && !teamSpokeAfter(sticky.after)
            ? sticky.by
            : null;
  // After a confirmed send the tail waits for the first read that includes
  // the message, so it never shows the state from before it.
  const tailReady =
    viewerIsMember &&
    Boolean(conversation) &&
    openRequest &&
    Boolean(lastMessage) &&
    shownThread === conversation?.id &&
    unconfirmed.every((pending) => pending.delivery === "failed");
  const typingShown =
    typing !== null &&
    (teamView ? openRequest : tailReady) &&
    !(handoffBy && typing === "agent");
  const tail = (
    <>
      {typingShown && (
        <div className={styles.typing} role="status" aria-live="polite">
          <span className={styles.dots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            {typing === "agent"
              ? t("room.typing.agent")
              : teamView
                ? t("room.typing.teammate")
                : t("room.typing.team")}
          </span>
        </div>
      )}
      {tailReady && (
        <div className={styles.tail} aria-live="polite">
          {handoffBy && (
            <p className={styles.system}>
              {handoffBy === "member"
                ? t("room.member.askedPerson")
                : handoffBy === "agent"
                  ? t("room.member.agentHandedOff")
                  : t("room.member.teamHasRequest")}
            </p>
          )}
          {/* The line the service writes for the
                  member's current follow-up step (a label and a date only). */}
          {conversation?.followUp && (
            <p className={styles.system} role="status">
              {conversation.followUp.text}
            </p>
          )}
          {!handoffBy &&
            typing === "agent" &&
            lastMine &&
            ageOf(lastMessage!.createdAt) > SLOW_AGENT_MS && (
              <p className={styles.system}>{t("room.member.slow")}</p>
            )}
          {!handoffBy && typing === null && lastMine && (
            <p className={styles.system}>{t("room.member.teamWait")}</p>
          )}
          {!handoffBy &&
            status.available &&
            (typing === "agent" || (lastBot && typing === null)) && (
              <button
                type="button"
                className={styles.hatch}
                disabled={Boolean(asking)}
                onClick={() => void askForPerson()}
              >
                {t("room.member.askPerson")}
              </button>
            )}
        </div>
      )}
    </>
  );
  const memberIds = conversation
    ? [conversation.member, ...(conversation.formerMembers ?? [])]
    : [];
  const timeline = inboxThreadItems(
    messages,
    teamView ? workflowNow : null,
    memberIds,
  );
  const caseIdentity = workflowNow
    ? threadIdentity(workflowNow)
    : identityOf({ level: conversation?.support?.access ?? "app" });
  const caseFacts = teamView && conversation && (
    <span className={styles.caseFacts}>
      <span data-identity={caseIdentity}>
        {workflowNow
          ? threadIdentityLabel(workflowNow)
          : (conversation.support?.identityLabel ??
            SUPPORT_IDENTITY_LABELS[caseIdentity])}
      </span>
    </span>
  );
  const secure = conversation?.encryption ?? (!conversationId && !conversation ? status.encryption : undefined);
  if (secure && !revoked) return (
    <div className={styles.threadMain}>
      {onBack && <button type="button" className={styles.back} onClick={onBack}>{t("room.team.allConversations")}</button>}
      <CustomerEncryptedSupport key={`${room}:${account}:${conversation?.id}:${conversation?.encryption?.caseSeq}`}
        origin={secure.clientOrigin} workspace={String(room).replace(/^room:/, "")} conversation={conversation?.id}
        caseSeq={conversation?.encryption?.caseSeq} name={communityName} custody={secure.custody}
        inline={teamView} account={account} />
    </div>
  );
  const thread = (
    <div className={styles.threadMain}>
      <header className={styles.threadHeader}>
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack}>
            <IconArrowLeft size={16} aria-hidden="true" />{" "}
            <span>{t("room.team.allConversations")}</span>
          </button>
        )}

        {(conversation || !teamView) && (
          <>
            <span className={styles.threadAvatar}>
              <Identicon
                seed={
                  teamView && conversation ? conversation.member : communityName
                }
                profile={
                  teamView && conversation
                    ? profiles.get(conversation.member)
                    : undefined
                }
                size={36}
                radius={10}
              />
            </span>
            <div className={styles.threadTitle}>
              <strong>
                {teamView
                  ? memberName
                  : t("room.team.title", { name: communityName })}
              </strong>
              {teamView && conversation && (
                <span className={styles.walletList}>
                  {sharedWalletAddresses(conversation).map(address => (
                    <span key={address}>Verified wallet <code>{address}</code></span>
                  ))}
                </span>
              )}
              {caseFacts}
              {teamView && conversation ? (
                <StateLine value={stateLine ?? earlierLine(conversation)} />
              ) : (
                <span>
                  {t("room.team.disclosure", { name: communityName })}
                </span>
              )}
            </div>
            {!teamView && <PhoneDetailsButton />}
            <PhoneActions className={styles.threadActions}>
              {resolveButton}
              {stopButton}
            </PhoneActions>
          </>
        )}
      </header>
      {categoryPrompt && categoryPrompt === conversation?.id && teamView && (
        <label className={styles.resolveCategory}>
          Category to resolve this case
          <select value="" disabled={busy || !status.available} onChange={event => {
            if (event.target.value) void setResolved(true, event.target.value);
          }}>
            <option value="">Choose a category</option>
            {workflowNow?.settings.categories?.map(category => <option key={category}>{category}</option>)}
          </select>
        </label>
      )}
      {banner}
      {caseAction && caseAction.id === conversation?.id && (
        <p className={styles.caseAction} role="status">
          <IconLoader2
            className={styles.spinning}
            size={16}
            aria-hidden="true"
          />{" "}
          {caseAction.text}
        </p>
      )}
      {!teamView && (
        <p className={styles.banner} role="note" data-banner="safety">
          <IconShieldLock size={18} aria-hidden="true" />
          <span>
            {t("room.team.safetyBanner")}{" "}
            <Link href={ACCOUNT_SETTINGS_PATH}>
              {t("room.team.accountSettings")}
            </Link>
          </span>
        </p>
      )}
      {!status.available && (
        <p className={styles.note} role="status">
          {t("room.team.unavailableNote")}
        </p>
      )}
      {!conversation && status.postBlockedReason && (
        <p className={styles.note} role="status">
          {t(
            status.postBlockedReason === "muted"
              ? "room.team.placeholderMuted"
              : "room.team.placeholderBanned",
          )}
        </p>
      )}
      {revoked && (
        <p className={styles.note} role="status">
          {t("room.team.revokedNote")}
        </p>
      )}
      <div
        ref={list}
        className={styles.messages}
        aria-label={t("room.team.messages")}
      >
        {conversation?.initiator.kind === "staff" && (
          <p className={styles.system}>
            {t("room.team.staffStarted", { name: communityName })}
          </p>
        )}
        {conversation?.staffMessagesStopped && (
          <p className={styles.note} role="status">
            {viewerIsMember
              ? t("room.team.stoppedNote")
              : t("room.team.memberStopped")}
          </p>
        )}
        {nextBefore && (
          <button
            type="button"
            className={styles.olderMessages}
            disabled={loadingOlder}
            onClick={() => readOlder.current()}
          >
            {loadingOlder
              ? t("room.messages.loadingEarlier")
              : t("room.messages.earlier")}
          </button>
        )}
        {conversation &&
          messages.length === 0 &&
          (!conversationId || shownThread === conversationId) && (
            <p className={styles.note}>{t("room.team.noMessages")}</p>
          )}
        {conversationId &&
          (!conversation || shownThread !== conversationId) &&
          messages.length === 0 &&
          !revoked &&
          !error && <ChatSkeleton composer={false} />}
        {!conversation &&
          !conversationId &&
          !revoked &&
          (!account || status.canAsk || visibility === "private") && (
            <div className={styles.introCard}>
              <IconMessageCircle size={22} aria-hidden="true" />
              <p>
                {!account
                  ? t("room.team.signInToAsk")
                  : status.canAsk
                    ? t("room.team.intro")
                    : t("room.team.privateOnly")}
              </p>
            </div>
          )}
        {timeline.map((item, index) => {
          if (item.kind === "event")
            return (
              <InboxSystemLine
                key={item.id}
                activity={item.activity}
                members={memberIds}
              />
            );
          const message = item.message;
          const facts = authors[message.author];
          // The member side is the thread's member plus any guest id it held
          // before proving a wallet; anyone else writing is the team.
          const teamSide = conversation
            ? message.author !== conversation.member &&
              !conversation.formerMembers?.some(
                (former) => former === message.author,
              )
            : Boolean(
                facts?.badges.some(
                  (badge) =>
                    badge === "manager" ||
                    badge === "moderator" ||
                    badge === "bot",
                ),
              );
          const previousItem = timeline[index - 1];
          const previous =
            previousItem?.kind === "message" ? previousItem.message : undefined;
          const grouped =
            previous?.author === message.author &&
            previous.teamName === message.teamName &&
            Date.parse(message.createdAt) - Date.parse(previous.createdAt) <
              5 * 60_000;
          return (
            <div
              key={message.id}
              className={styles.message}
              data-side={teamSide ? "team" : "member"}
              data-grouped={grouped}
              data-message-id={message.id}
            >
              <span className={styles.avatar}>
                <Identicon
                  seed={message.author}
                  profile={profiles.get(message.author)}
                  size={30}
                  radius={10}
                />
              </span>
              <div className={styles.messageBody}>
                <div className={styles.meta}>
                  {teamSide && facts?.badges.includes("bot") ? (
                    <strong>AI agent</strong>
                  ) : teamSide && !teamView ? (
                    <strong>
                      {facts?.badges.includes("bot") ? (
                        "AI agent"
                      ) : message.teamName ? (
                        <>
                          {message.teamName} <Badge>Team</Badge>
                        </>
                      ) : (
                        communityName
                      )}
                    </strong>
                  ) : teamSide &&
                    message.teamName &&
                    !facts?.badges.includes("bot") ? (
                    <strong>{message.teamName}</strong>
                  ) : (
                    <MemberIdentity
                      principalId={message.author}
                      profile={profiles.get(message.author)}
                      facts={facts as never}
                      size="sm"
                    />
                  )}
                  {teamView && facts?.templStaff && <span>Templ</span>}
                  <time
                    dateTime={message.createdAt}
                    title={messageDay(message.createdAt)}
                  >
                    {shortTime(message.createdAt)}
                  </time>
                </div>
                <div className={styles.text}>
                  {/* Message formatting grants no signing or transaction authority. */}
                  <ChatMessageText text={message.text} />
                  {/* Private key redaction. */}
                  {/* Current case access and author permissions apply. */}
                  {!viewerIsMember && conversation && (
                    <RedactHexButton
                      room={room}
                      account={account}
                      thread={conversation.id}
                      messageId={message.id}
                      text={message.text}
                      sharedHashes={workflowNow?.context?.transactions?.map(
                        (tx) => tx.hash,
                      )}
                      canManage={workflowNow?.canManage === true}
                      onRedacted={() => void refreshThread.current()}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {outbox.messages
          .filter(
            (pending) =>
              !messages.some(
                (message) => message.clientId === pending.clientId,
              ),
          )
          .map((pending) => (
            <div
              key={pending.clientId}
              className={styles.message}
              data-side={viewerIsMember ? "member" : "team"}
              data-pending={pending.delivery}
            >
              <div className={styles.messageBody}>
                <div className={styles.text}>
                  <ChatMessageText text={pending.text} />
                </div>
                <small className={styles.delivery}>
                  {pending.delivery === "queued"
                    ? "Queued"
                    : pending.delivery === "sending"
                      ? "Sending…"
                      : pending.delivery === "sent"
                        ? "Sent"
                        : (pending.error ?? "Could not send")}
                </small>
                {pending.delivery === "queued" && (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => forgetOutboxMessage(pending.clientId)}
                  >
                    Cancel
                  </button>
                )}
                {pending.delivery === "failed" && (
                  <>
                    {canRetryChatMessage(
                      pending,
                      canWrite && conversation?.canInstructWalletActions === true,
                    ) && (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() =>
                          retryChatMessage(
                            pending.clientId,
                            canWrite && conversation?.canInstructWalletActions === true,
                          )
                        }
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => forgetOutboxMessage(pending.clientId)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        {tail}
        {conversation?.state === "resolved" && (
          <p className={styles.system}>
            {conversation.resolvedBy
              ? conversation.resolvedBy.kind === "team"
                ? t("room.team.resolvedByTeam")
                : t("room.team.resolvedByMember")
              : t("room.team.resolved")}{" "}
            {viewerIsMember ? t("room.team.replyToReopen") : ""}
          </p>
        )}
        {teamView && conversation?.billing && (
          <p
            className={styles.system}
            data-billing={conversation.billing.status}
          >
            {caseBillingLabel(conversation.billing)}
          </p>
        )}
      </div>

      {waitingToOpen && (
        <p role="status" className={styles.note}>
          Queued. Your message will send shortly.{" "}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => openingRequest.current?.abort()}
          >
            Cancel
          </button>
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {outbox.notice && (
        <p className={styles.error} role="alert">
          {outbox.notice}{" "}
          <button
            type="button"
            className={styles.linkButton}
            onClick={outbox.dismissNotice}
          >
            {t("room.notes.cancel")}
          </button>
        </p>
      )}
      {!account && !revoked && (
        <button
          type="button"
          className={`button ${styles.signIn}`}
          disabled={busy}
          onClick={() => void signIn()}
        >
          {t("shell.common.signIn")}
        </button>
      )}
      {(conversation || status.canAsk) && !revoked && (
        <form
          className={styles.composer}
          onSubmit={(event) => void submit(event)}
        >
          <label className={styles.srOnly} htmlFor="team-conversation-input">
            {t("room.team.message")}
          </label>
          <textarea
            ref={composer}
            id="team-conversation-input"
            value={text}
            maxLength={4000}
            rows={2}
            aria-describedby={replyDraft.suggestion && !text.trim() ? draftHint : undefined}
            placeholder={
              canWrite
                ? replyDraft.suggestion?.text ?? (teamView
                  ? "Write a reply…"
                  : t("room.team.placeholderWrite"))
                : replyBlocked === "paused"
                  ? t("room.team.placeholderPaused")
                  : replyBlocked === "message-limit"
                    ? t("room.team.placeholderMessageLimit")
                    : replyBlocked
                      ? t("room.team.errorHandedOff")
                      : blocked === "stopped"
                        ? t("room.team.placeholderStopped")
                        : blocked === "history-capacity"
                          ? t("room.team.placeholderHistoryFull")
                          : blocked === "muted"
                            ? t("room.team.placeholderMuted")
                            : blocked === "banned"
                              ? t("room.team.placeholderBanned")
                              : t("room.team.placeholderClosed")
            }
            disabled={!canWrite || busy}
            onBlur={() => {
              imeComposing.current = false;
              composeActivity.blur();
            }}
            onCompositionStart={() => {
              imeComposing.current = true;
            }}
            onCompositionEnd={() => {
              imeComposing.current = false;
            }}
            onChange={(event) => {
              // Start composition after input.
              // Current case access and author permissions apply.
              composeActivity.input();
              setText(event.target.value);
              noteTyping(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey && !event.altKey &&
                  !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing &&
                  !imeComposing.current && !text.trim() && replyDraft.suggestion) {
                event.preventDefault();
                replyDraft.useSuggestion();
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !imeComposing.current &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {replyDraft.suggestion && !text.trim() && (
            <span id={draftHint} className={styles.srOnly}>Press Tab to use the AI draft.</span>
          )}
          <div className={styles.composerBar}>
            {aiBar}
            {(replyDraft.canRequest || replyDraft.requesting) && (
              <button
                type="button"
                className="button small secondary"
                disabled={busy || !canWrite || Boolean(text.trim()) || replyDraft.requesting}
                aria-busy={replyDraft.requesting}
                onClick={() => void replyDraft.openDraft()}
              >
                {replyDraft.requesting
                  ? <IconLoader2 size={16} className={styles.spinning} aria-hidden="true" />
                  : <IconSparkles size={16} aria-hidden="true" />}
                {replyDraft.requesting ? "Drafting…" : replyDraft.suggestion ? "Use AI draft" : "Draft reply"}
              </button>
            )}
            {teamView && conversation?.answerIntentRequired && (
              <button
                type="button"
                className="button small secondary"
                disabled={!canWrite || busy || !text.trim()}
                onClick={(event) => void submit(event, "update")}
                title="Request details or share progress without counting an answered case"
              >
                Send update
              </button>
            )}
            <button
              type="submit"
              className={styles.primary}
              aria-label={
                teamView && conversation?.answerIntentRequired
                  ? "Send answer"
                  : t("room.team.send")
              }
              disabled={!canWrite || busy || !text.trim()}
            >
              <IconSend size={17} aria-hidden="true" />
              <span aria-hidden="true">
                {teamView && conversation?.answerIntentRequired
                  ? "Send answer"
                  : "Send"}
              </span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
  if (teamView) return (
    <div className={styles.conversation} data-viewer="team">
      {thread}
      {toast.toast}
    </div>
  );
  return (
    <PhoneConversation
      className={styles.conversation}
      viewer="member"
      details={Boolean(conversation && !revoked)}
      resetKey={conversation?.id ?? ""}
    >
      {thread}
      {conversation && !revoked && (
        <PhoneDetails className={styles.threadAside} label="Case details">
          <SupportWorkflowPanel
            priorityEnabled={features?.priorityFeed === true}
            draftsEnabled={features?.aiDrafts === true}
            key={`workflow:${room}:${conversation.id}:${account}`}
            room={room}
            account={account}
            conversation={conversation}
            enabled={status.supportWorkflowAvailable === true}
            composing={
              // Human compose intervals.
              // Current case access and author permissions apply.
              typedSinceOpen && composeActivity.active && Boolean(text.trim())
            }
            messagesShown={shownThread === conversation.id}
            onReply={setText}
            onChanged={panelChanged}
            onPriorityChanged={onQueueChange}
            onOpenConversation={onOpened}
            onWorkflow={onPanelWorkflow}
            actionBusy={busy}
            onMutationStart={beginPanelMutation}
            onMutationEnd={endPanelMutation}
            refreshKey={workflowRevision}
          />
          <DownloadChat
            key={`download:${room}:${conversation.id}:${account}`}
            room={room}
            conversationId={conversation.id}
            viewer={conversation.viewer}
          />
        </PhoneDetails>
      )}
    </PhoneConversation>
  );
}
