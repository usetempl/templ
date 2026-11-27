"use client";
import { hasSupportKnowledge } from "@templ/chat/workspace-flags";
import { trackEvent } from "@/lib/analytics";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import {
  Fragment,
  useCallback,
  useRef,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  IconAlertTriangle,
  IconBook,
  IconCode,
  IconCreditCard,
  IconHome,
  IconInbox,
  IconLock,
  IconSettings,
  IconUsersGroup,
} from "@tabler/icons-react";
import type {
  ChatRoomId,
  ChatState,
  NativeRoom,
  TeamConversationStatus,
} from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ProductPaymentIntent } from "@templ/chat/product-payment";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import { useCommunityDirectory } from "@/lib/community-directory";
import { nativeRoomHref } from "@/lib/native-room";
import { isBillingView } from "@/lib/product-offer";
import { listConversations } from "@/lib/team-conversations-client";
import { teamPresentationCache } from "@/lib/team-conversations-cache";
import {
  badgeFavicon,
  readOpenInbox,
  subscribeOpenInbox,
  titleWithCount,
  watchInboxAttention,
} from "@/lib/inbox-attention";
import { onInboxCountsRequest, publishInboxCounts } from "@/lib/inbox-counts";
import { readSupportPulse } from "@/lib/support-insights-client";
import { walletError } from "@/lib/wallet";
import { InvitationEntry } from "@/components/chat-invitations";
import { AddBalanceDialog } from "@/components/add-balance-dialog";
import { Spinner } from "@/components/ui/ui";
import {
  AppFrame,
  RailNavGroup,
  RailNavItem,
  WorkspaceSwitcher,
} from "./app-frame";
import { WorkspaceInbox } from "./workspace-inbox";
import { CaseListSkeleton } from "./inbox-states";
import { followUpsAllowed } from "@/components/follow-ups-section";
import { InboxAlertsToggle } from "./inbox-alerts";
import { PushAlertsToggle } from "./push-alerts";
import { MemberSupportPage } from "./member-support";
import { WorkspaceManagement } from "./workspace-management";
import { usePhoneWalletHandoff, WalletAppCard } from "./wallet-app-card";
import { WorkspaceClosed } from "./workspace-deletion";
import { WorkspaceExport } from "./workspace-export";
import { workspaceDeleting } from "@/lib/workspace-deletion-client";
import {
  dropEarlyWorkspaceRead,
  loadWorkspaceView,
  startEarlyAllCases,
  startEarlyWorkspaceRead,
  takeEarlyWorkspaceRead,
  workspaceViews,
  type WorkspaceView,
  type EarlyCasePage,
} from "./workspace-reads";
import styles from "./workspace.module.css";
import { useWorkspaceHistory } from "./workspace-history";

function WorkspaceTabLoading() {
  return (
    <div className={styles.page}>
      <CaseListSkeleton label="shell.loading.workspace" />
    </div>
  );
}
function WorkspaceTabUnavailable() {
  return (
    <div className={styles.page}>
      <p role="alert">This page could not load. Reload and try again.</p>
      <button
        type="button"
        className="button secondary"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
const tabFailed = () => WorkspaceTabUnavailable;
const WorkspaceHome = dynamic(
  () =>
    import("./workspace-home")
      .then((module) => module.WorkspaceHome)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceWidget = dynamic(
  () =>
    import("./workspace-widget")
      .then((module) => module.WorkspaceWidget)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceTeam = dynamic(
  () =>
    import("./workspace-team")
      .then((module) => module.WorkspaceTeam)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceSettings = dynamic(
  () =>
    import("./workspace-settings")
      .then((module) => module.WorkspaceSettings)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceReports = dynamic(
  () =>
    import("./workspace-reports")
      .then((module) => module.WorkspaceReports)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceAi = dynamic(
  () =>
    import("./workspace-ai")
      .then((module) => module.WorkspaceAi)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceFollowUps = dynamic(
  () =>
    import("./workspace-follow-ups")
      .then((module) => module.WorkspaceFollowUps)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const SpecialistFollowUps = dynamic(
  () =>
    import("./workspace-follow-ups")
      .then((module) => module.SpecialistFollowUps)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspacePlan = dynamic(
  () =>
    import("./workspace-plan")
      .then((module) => module.WorkspacePlan)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);
const WorkspaceActivity = dynamic(
  () =>
    import("./workspace-activity")
      .then((module) => module.WorkspaceActivity)
      .catch(tabFailed),
  { loading: WorkspaceTabLoading },
);

export type WorkspaceTab =
  | "home"
  | "inbox"
  | "quality"
  | "knowledge"
  // Open follow-ups by owner and age.
  | "follow-ups"
  | "widget"
  | "team"
  | "activity"
  | "settings"
  | "plan";
const TABS: WorkspaceTab[] = [
  "home",
  "inbox",
  "quality",
  "widget",
  "knowledge",
  "follow-ups",
  "team",
  "activity",
  "settings",
  "plan",
];
const TITLES: Record<WorkspaceTab, string> = {
  home: "Workspace",
  inbox: "Cases",
  quality: "Reports",
  knowledge: "AI",
  "follow-ups": "Follow-ups",
  widget: "Chat",
  team: "Team",
  activity: "Activity",
  settings: "Settings",
  plan: "Plan & usage",
};

export type WorkspaceContext = {
  id: string;
  supportUrl?: string;
  room: ChatRoomId;
  workspace: NativeRoom;
  state: ChatState;
  status: TeamConversationStatus;
  account?: ChatPrincipalId;
  manager: boolean;
  billing: boolean;
  /** Bump after a change that alters permissions or setup. */
  reload: () => void;
  revision: number;
  /** Opens a tab, a thread in the inbox, or a named part of a page (the
   * element with that id, for example "ai-agent" in AI). */
  go: (
    tab: WorkspaceTab,
    conversation?: string | null,
    section?: string,
  ) => void;
  openPlans: (purpose?: "period" | "credit") => void;
  /** Opens checkout on an existing payment request. */
  openPayment: (request: ProductPaymentIntent) => void;
};

function readTab(): WorkspaceTab | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("tab");
  return TABS.includes(value as WorkspaceTab) ? (value as WorkspaceTab) : null;
}
function readConversation(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("support");
  return value && /^tc-[0-9a-f]{32}$/.test(value) ? value : null;
}

type WorkspaceEntry = { id: string; supportUrl?: string };

export function SupportWorkspacePage({ id, supportUrl }: WorkspaceEntry) {
  return (
    <InvitationEntry key={id} room={`room:${id}`}>
      <Workspace key={id} id={id} supportUrl={supportUrl} />
    </InvitationEntry>
  );
}

type Loaded = {
  scope: string;
  /** The account the view was read for. */
  account?: ChatPrincipalId;
  view?: WorkspaceView;
  firstCasePage?: EarlyCasePage;
  error?: string;
  missing?: boolean;
  /** The workspace is set to be deleted. */
  deleting?: boolean;
};
/** The worker says access ended: the kept view goes with it. A workspace
 * being deleted (410) ends access too. */
const accessEnded = (status: number | undefined) =>
  status === 401 || status === 403 || status === 404 || status === 410;

function Workspace({ id, supportUrl }: WorkspaceEntry) {
  const auth = useChatAuth();
  const account = auth.session?.principalId;
  const directory = useCommunityDirectory();
  const sessionRevision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const room = `room:${id}` as ChatRoomId;
  const [retry, setRetry] = useState(0);
  const revision = sessionRevision + retry;
  const scope = `${id}:${account}:${sessionRevision}:${retry}`;
  const [loaded, setLoaded] = useState<Loaded>();
  const current = loaded?.scope === scope ? loaded : undefined;
  // While the same account's view is read again (a reload or a session
  // revision), the page keeps showing what that account already had.
  const kept =
    !current && account && loaded?.view && loaded.account === account
      ? loaded.view
      : undefined;
  const view: WorkspaceView | undefined = current
    ? current.view
    : (kept ?? workspaceViews.get(account, id));
  const [tab, setTabValue] = useState<WorkspaceTab | null>(readTab);
  const [conversation, setConversation] = useState<string | null>(
    readConversation,
  );
  const readHistory = useCallback(() => {
    setTabValue(readTab());
    setConversation(readConversation());
  }, []);
  const pushHistory = useWorkspaceHistory(id, readHistory);
  const [plansOpen, setPlansOpen] = useState<{
    purpose: "period" | "credit";
    request?: ProductPaymentIntent;
  } | null>(null);
  const [signInError, setSignInError] = useState("");
  // A staff link opened in a phone browser with no wallet: point to the
  // wallet app first. Signing in here stays one tap away.
  const phoneHandoff = usePhoneWalletHandoff(!auth.restoring && !account);
  const [stayHere, setStayHere] = useState(false);
  // While sign-in restores, the signed reads start with the browser's
  // cookie. Their answers count only for the account that restores.
  useEffect(() => {
    if (auth.restoring) startEarlyWorkspaceRead(id);
  }, [id, auth.restoring]);
  useEffect(() => () => dropEarlyWorkspaceRead(id), [id]);
  useEffect(() => {
    if (auth.restoring) return;
    const controller = new AbortController();
    const started = takeEarlyWorkspaceRead(id);
    const initialTab = readTab();
    const firstCasePage = (!initialTab || initialTab === "inbox") &&
      !workspaceViews.get(account, id)
      ? startEarlyAllCases(room, account, controller.signal)
      : undefined;
    void (async () => {
      try {
        const next = await loadWorkspaceView(
          id,
          account,
          started,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (account && next.workspace && next.state && next.status) {
          workspaceViews.set(account, id, next);
          // The inbox shows its queue at once from this status and reads
          // it again behind it.
          teamPresentationCache(room, account, revision).rememberStatus(
            next.status,
          );
        }
        setLoaded({ scope, account, view: next, firstCasePage });
      } catch (reason) {
        if (controller.signal.aborted) return;
        const status = (reason as { status?: number }).status;
        if (accessEnded(status)) workspaceViews.delete(account, id);
        setLoaded((previous) => {
          // A passing failure keeps what this account already sees.
          const still = accessEnded(status)
            ? undefined
            : previous?.view && previous.account === account
              ? previous.view
              : workspaceViews.get(account, id);
          return still && account
            ? { scope, account, view: still }
            : {
                scope,
                account,
                missing: status === 404,
                deleting: workspaceDeleting(reason),
                error:
                  reason instanceof Error
                    ? reason.message
                    : "This workspace could not load.",
              };
        });
      }
    })();
    return () => controller.abort();
  }, [id, room, account, scope, revision, auth.restoring]);

  const workspace = view?.workspace;
  const state = view?.state;
  const status = view?.status;
  const manager = state?.viewer.isManager === true;
  const admin = canManageWorkspace(
    state?.viewer ?? {},
    state?.bots?.some((bot) => bot.principalId === account),
  );
  const billing =
    manager || state?.viewer.permissions.includes("manageBilling") === true;
  const team = status?.team === true || manager;

  const defaultTab: WorkspaceTab = "inbox";
  const allowed = (value: WorkspaceTab) =>
    value === "home" || value === "inbox" || value === "settings"
      ? true
      : value === "knowledge"
        ? admin || hasSupportKnowledge(state?.features)
        : value === "quality"
          ? state?.features?.quality === true
          : value === "follow-ups"
            ? followUpsAllowed(state?.features)
            : value === "plan"
              ? billing
              : value === "activity"
                ? manager
                : admin;
  const visible: WorkspaceTab =
    tab && allowed(tab) && (team || tab === "plan") ? tab : defaultTab;

  const listed = directory.joined.find(
    (item) => item.nativeRoom?.id === id,
  )?.nativeRoom;
  const go = useCallback(
    (next: WorkspaceTab, open: string | null = null, section?: string) => {
      const url = new URL(window.location.href);
      url.searchParams.delete("team");
      // A linked inbox view applies once, when the inbox first opens.
      url.searchParams.delete("view");
      if (next === "inbox") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      if (open) url.searchParams.set("support", open);
      else url.searchParams.delete("support");
      // The page scrolls to the section once it has loaded.
      url.hash = section ?? "";
      if (!pushHistory(url)) return;
      setTabValue(next);
      setConversation(open);
      document.getElementById("main-content")?.scrollTo({ top: 0 });
      if (section) window.dispatchEvent(new HashChangeEvent("hashchange"));
    },
    [pushHistory],
  );
  useEffect(() => {
    if (!admin || tab !== "settings") return;
    const redirectEncryption = () => {
      const url = new URL(window.location.href);
      if (url.hash !== "#case-encryption") return;
      url.searchParams.set("tab", "widget");
      if (pushHistory(url, true)) setTabValue("widget");
    };
    redirectEncryption();
    window.addEventListener("hashchange", redirectEncryption);
    return () => window.removeEventListener("hashchange", redirectEncryption);
  }, [admin, tab, pushHistory]);
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    if (
      !current?.view?.state ||
      !current.view.status ||
      !tab ||
      tab === visible
    )
      return;
    const url = new URL(window.location.href);
    if (visible === "inbox") url.searchParams.delete("tab");
    else url.searchParams.set("tab", visible);
    url.searchParams.delete("support");
    url.hash = "";
    pushHistory(url, true);
    setTabValue(visible);
    setConversation(null);
  }, [current, tab, visible, pushHistory]);
  const product = state?.product;
  const trialCheckout = manager && (visible === "home" || visible === "plan") &&
    product && isBillingView(product) && product.standardPlan?.status === "demo" && product.mode !== "exempt";
  const countAdminView = Boolean(team && admin && workspace && current && !trialCheckout && !plansOpen && tab !== "plan" && visible !== "plan");
  const countedWorkspace = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (countAdminView && countedWorkspace.current !== id) {
      trackEvent("workspace_home_viewed");
      countedWorkspace.current = id;
    }
  }, [countAdminView, id]);

  // The Needs you count powers the rail badge, the tab title and icon, and
  // the optional browser alert; the same read gives the views bar and Home
  // their counts. It keeps refreshing while the tab is hidden, so a request
  // that needs someone in a background tab still shows up. Against a
  // service without the pulse, it counts open chats as before.
  const [badge, setBadge] = useState<{ scope: string; value: string | null }>();
  const workspaceName = workspace?.name;
  useEffect(() => {
    if (!team) return;
    return watchInboxAttention({
      readPulse: (signal) => readSupportPulse(room, signal),
      // The list is oldest first, so new requests sit on its last page.
      readOpenList: (signal) =>
        readOpenInbox((cursor) =>
          listConversations(room, "open", cursor, signal),
        ),
      // While the inbox shows every open chat, its reads serve this too.
      shared: (listener) => subscribeOpenInbox(room, account, listener),
      // A reply, resolve or handoff in the inbox asks for fresh counts.
      requests: (readNow) => onInboxCountsRequest(room, account, readNow),
      publish: (counts) => publishInboxCounts(room, account, counts),
      onBadge: (value) => setBadge({ scope, value }),
      workspace: workspaceName ?? "Support",
      tag: `templ-inbox:${room}`,
    });
  }, [room, account, team, scope, workspaceName]);
  const count = team && badge?.scope === scope ? badge.value : null;
  useEffect(() => {
    document.title = titleWithCount(document.title, count);
    badgeFavicon(count);
  }, [count]);
  useEffect(
    () => () => {
      document.title = titleWithCount(document.title, null);
      badgeFavicon(null);
    },
    [],
  );

  async function signIn() {
    setSignInError("");
    try {
      await auth.signIn();
    } catch (reason) {
      if (!isChatSignInCanceled(reason)) setSignInError(walletError(reason));
    }
  }

  if (phoneHandoff && !stayHere)
    return (
      <CenteredState>
        <WalletAppCard
          options={phoneHandoff}
          onStayHere={() => setStayHere(true)}
        />
      </CenteredState>
    );

  // Loading, missing and signed-out states share one calm frame. A
  // workspace this account follows shows its frame at once instead.
  if (!view && !current?.error)
    return listed && account ? (
      <WorkspaceFrameLoading
        workspace={listed}
        workspaces={directory.joined}
        onGo={go}
      />
    ) : (
      <CenteredState>
        <Spinner size={22} />
        <p>Opening workspace…</p>
      </CenteredState>
    );
  // A workspace set to be deleted shows its date and, for the
  // manager, Cancel deletion and the export while it stays open.
  if (current?.deleting)
    return (
      <CenteredState>
        <span className={styles.stateIcon} data-tone="warning">
          <IconAlertTriangle aria-hidden="true" />
        </span>
        <WorkspaceClosed
          room={room}
          account={account}
          onReopened={reload}
          exportPanel={
            <WorkspaceExport
              room={room}
              account={account}
              manager
              enabled={state?.features?.workspaceExport === true}
            />
          }
        />
        <div className={styles.stateActions}>
          <Link href="/inbox" className="button quiet">
            All workspaces
          </Link>
        </div>
      </CenteredState>
    );
  if (current?.error || !workspace || !status)
    return (
      <CenteredState>
        <span className={styles.stateIcon} data-tone="warning">
          <IconAlertTriangle aria-hidden="true" />
        </span>
        <h1>
          {current?.missing
            ? "This workspace doesn’t exist or isn’t shared with you."
            : "This workspace could not load."}
        </h1>
        <p role="alert">{current?.error}</p>
        <div className={styles.stateActions}>
          <button type="button" className="button" onClick={reload}>
            Try again
          </button>
          {!account && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void signIn()}
            >
              Sign in
            </button>
          )}
          <Link href="/inbox" className="button quiet">
            All workspaces
          </Link>
        </div>
        {signInError && <p role="alert">{signInError}</p>}
      </CenteredState>
    );

  if (
    !team &&
    workspace.pendingManager &&
    account &&
    auth.session &&
    auth.session.principalId === account &&
    auth.session.servicePrincipals.includes(workspace.pendingManager)
  )
    return (
      <AppFrame
        title="Workspace manager"
        subtitle={workspace.name}
        rail={null}
        workspace={workspace}
      >
        <div className={`${styles.page} ${styles.pageNarrow}`}>
          <WorkspaceManagement
            context={{ room, workspace, account, manager, revision, reload }}
          />
        </div>
      </AppFrame>
    );

  // A specialist without team access sees only their
  // follow-ups and the requests those open to them, never the inbox.
  if (
    !team &&
    state?.viewer.permissions.includes("handleFollowUps") &&
    followUpsAllowed(state?.features)
  )
    return (
      <AppFrame
        title="Follow-ups"
        subtitle={workspace.name}
        rail={null}
        workspace={workspace}
      >
        <SpecialistFollowUps
          room={room}
          account={account}
          name={workspace.name}
        />
      </AppFrame>
    );
  if (!team)
    return (
      <MemberSupportPage
        room={room}
        workspace={workspace}
        revision={revision}
        signedIn={Boolean(account)}
        onSignIn={() => void signIn()}
        signInError={signInError}
      />
    );

  const context: WorkspaceContext = {
    supportUrl,
    id,
    room,
    workspace,
    state: state!,
    status,
    account,
    manager,
    billing,
    reload,
    revision,
    go,
    openPlans: (purpose) =>
      setPlansOpen({ purpose: purpose === "credit" ? "credit" : "period" }),
    openPayment: (request) =>
      setPlansOpen({
        purpose: request.standard?.purpose === "credit" ? "credit" : "period",
        request,
      }),
  };
  const accessScope = [
    id,
    account,
    manager,
    admin,
    [...(state?.viewer.permissions ?? [])].sort().join(","),
    JSON.stringify(state?.features),
  ].join(":");
  const role = manager
    ? "Owner"
    : admin
      ? "Admin"
      : state?.viewer.permissions.includes("manageSupport")
        ? "Support lead"
        : "Team";
  const workspaces = switcherWorkspaces(directory.joined);
  if (!workspaces.some((item) => item.id === id))
    workspaces.unshift({
      id,
      name: workspace.name,
      image: workspace.image,
      href: nativeRoomHref({ id }),
    });
  const settingsView = visible !== "inbox" && visible !== "knowledge";
  const rail = (
    <>
      <WorkspaceSwitcher
        current={{ id, name: workspace.name, image: workspace.image }}
        role={role}
        workspaces={workspaces}
      />
      <RailNavGroup label="Support">
        {trialCheckout && (
          <RailNavItem icon={IconHome} label="Workspace" active={visible === "home"} onClick={() => go("home")} />
        )}
        <RailNavItem
          icon={IconInbox}
          label="Cases"
          active={visible === "inbox"}
          onClick={() => go("inbox")}
          badge={count ?? undefined}
        />
        {team && (admin || hasSupportKnowledge(state?.features)) && (
          <RailNavItem
            icon={IconBook}
            label="AI"
            active={visible === "knowledge"}
            onClick={() => go("knowledge")}
          />
        )}
        {team && (
          <RailNavItem
            icon={IconSettings}
            label="Settings"
            active={settingsView && !trialCheckout}
            onClick={() => go("settings")}
          />
        )}
      </RailNavGroup>
      {settingsView && !trialCheckout && (
        <>
          <RailNavGroup label="Workspace settings">
            <RailNavItem icon={IconHome} label="Workspace" active={visible === "home"} onClick={() => go("home")} />
            {admin && (
              <>
                <RailNavItem icon={IconCode} label="Chat" active={visible === "widget"} onClick={() => go("widget")} />
                <RailNavItem icon={IconUsersGroup} label="Team" active={visible === "team"} onClick={() => go("team")} />
              </>
            )}
            {billing && (
              <RailNavItem
                icon={IconCreditCard}
                label="Plan & usage"
                active={visible === "plan"}
                onClick={() => go("plan")}
              />
            )}
          </RailNavGroup>
          <InboxAlertsToggle />
          <PushAlertsToggle
            room={room}
            enabled={state?.features?.installableInbox === true}
          />
        </>
      )}
    </>
  );
  return (
    <AppFrame
      workspace={workspace}
      title={TITLES[visible]}
      subtitle={workspace.name}
      rail={rail}
      fill={visible === "inbox"}
    >
      <Fragment key={accessScope}>
        {visible === "home" && <WorkspaceHome context={context} />}
        {visible === "inbox" && (
          <WorkspaceInbox context={context} conversation={conversation} firstCasePage={current?.firstCasePage} />
        )}
        {visible === "quality" && <WorkspaceReports context={context} />}
        {visible === "knowledge" && <WorkspaceAi context={context} />}
        {visible === "follow-ups" && <WorkspaceFollowUps context={context} />}
        {visible === "widget" && <WorkspaceWidget context={context} />}
        {visible === "team" && <WorkspaceTeam context={context} />}
        {visible === "activity" && <WorkspaceActivity context={context} />}
        {visible === "settings" && <WorkspaceSettings context={context} />}
        {visible === "plan" && <WorkspacePlan context={context} />}
      </Fragment>
      {plansOpen && billing && (
        <AddBalanceDialog
          room={room}
          purpose={plansOpen.purpose}
          request={plansOpen.request}
          onClose={() => setPlansOpen(null)}
          onConfirmed={reload}
          onSetUpAi={admin && team && state?.features?.managedAgent && !state.bots?.length
            ? () => { setPlansOpen(null); go("knowledge", null, "managed-ai"); }
            : undefined}
          onPlanReady={team ? () => { setPlansOpen(null); go("home"); } : undefined}
          assertCurrent={() => {
            if (communitySessionRevision() !== sessionRevision)
              throw new Error("Your account changed. Reopen plans.");
          }}
        />
      )}
    </AppFrame>
  );
}

function switcherWorkspaces(joined: { nativeRoom?: NativeRoom }[]) {
  return joined.flatMap((item) =>
    item.nativeRoom
      ? [
          {
            id: item.nativeRoom.id,
            name: item.nativeRoom.name,
            image: item.nativeRoom.image,
            href: nativeRoomHref(item.nativeRoom),
          },
        ]
      : [],
  );
}

/** The frame of a workspace the account follows, before its data arrives. */
function WorkspaceFrameLoading({
  workspace,
  workspaces,
  onGo,
}: {
  workspace: NativeRoom;
  workspaces: { nativeRoom?: NativeRoom }[];
  onGo: (tab: WorkspaceTab) => void;
}) {
  return (
    <AppFrame
      title={workspace.name}
      rail={
        <>
          <WorkspaceSwitcher
            current={{
              id: workspace.id,
              name: workspace.name,
              image: workspace.image,
            }}
            role=""
            workspaces={switcherWorkspaces(workspaces)}
          />
          <RailNavGroup label="Support">
            <RailNavItem
              icon={IconInbox}
              label="Cases"
              onClick={() => onGo("inbox")}
            />
          </RailNavGroup>
        </>
      }
    >
      <div className={styles.page}>
        <CaseListSkeleton label="shell.loading.workspace" />
      </div>
    </AppFrame>
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className={styles.centered}>
      <div className={styles.stateCard}>{children}</div>
      <p className={styles.stateFoot}>
        <IconLock size={14} aria-hidden="true" /> Support cases are private to
        the user and the workspace team.
      </p>
    </main>
  );
}
