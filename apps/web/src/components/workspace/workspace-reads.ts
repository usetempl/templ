import {
  installCheckComplete,
  type InstallCheckRecord,
} from "@templ/chat/support-install-check";
import type {
  ChatRoomId,
  ChatState,
  NativeRoom,
  TeamConversationList,
  TeamConversationStatus,
} from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportReport } from "@templ/chat/support";
import { readPrioritySettings } from "@/lib/support-priority-client";
import { accountChatCache } from "@/lib/chat-cache-scope";
import { readLinkedInboxView } from "@/lib/inbox-link-view";
import { readSupportInboxState } from "@/lib/support-local-state";
import { teamQueueCacheKey } from "@/lib/team-conversations-cache";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import {
  readNativeRoom,
  readNativeRoomWithCookie,
  readPublicNativeRoom,
  rememberNativeRoom,
} from "@/lib/native-room";
import {
  listConversations,
  readConversationStatus,
} from "@/lib/team-conversations-client";

/** What the workspace page needs before it can show a tab. `state` is only
 * read for a signed-in viewer; `workspace` is missing when a signed-out
 * visitor opens a private workspace. */
export type WorkspaceView = {
  workspace?: NativeRoom;
  state?: ChatState;
  status?: TeamConversationStatus;
};

/** The last complete view each account loaded, shown while it is read
 * again. Presentation only: every tab still reads its own data and the
 * worker authorizes every call. */
export const workspaceViews = accountChatCache<WorkspaceView>(8, 10 * 60_000);

export type EarlyCasePage = {
  query: string;
  take(): Promise<TeamConversationList> | undefined;
};

/** Start the selected account's All cases read while workspace data loads.
 * The inbox takes this page only after its signed team access is known. */
export function startEarlyAllCases(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  signal: AbortSignal,
): EarlyCasePage | undefined {
  if (!account) return;
  const saved = readSupportInboxState(room, account);
  if ((readLinkedInboxView() ?? saved.filter) !== "all") return;
  const filters = saved.filters ?? {};
  let pending: Promise<TeamConversationList> | undefined = listConversations(
    room, "all", null, signal, filters,
  );
  void pending.catch(() => {});
  return {
    query: teamQueueCacheKey("all", filters),
    take() {
      const page = pending;
      pending = undefined;
      return page;
    },
  };
}

const signedState = (id: string, signal?: AbortSignal) =>
  communityFetch<ChatState>(
    roomPath(`room:${id}` as ChatRoomId, "channels"),
    undefined,
    signal,
  );

export async function readSignedWorkspace(
  id: string,
  signal?: AbortSignal,
): Promise<WorkspaceView> {
  const [workspace, state, status] = await Promise.all([
    readNativeRoom(id, signal),
    signedState(id, signal),
    readConversationStatus(`room:${id}` as ChatRoomId, signal),
  ]);
  return { workspace, state, status };
}

export async function readPublicWorkspace(
  id: string,
  signal?: AbortSignal,
  status?: TeamConversationStatus | Promise<TeamConversationStatus>,
): Promise<WorkspaceView> {
  const [workspace, current] = await Promise.all([
    readPublicNativeRoom(id, signal),
    status ?? readConversationStatus(`room:${id}` as ChatRoomId, signal),
  ]);
  return { workspace, status: current };
}

type EarlyView = { kind: "signed" | "public"; view: WorkspaceView };
/** Reads started while sign-in restores, one set per workspace page. */
const early = new Map<
  string,
  { promise: Promise<EarlyView>; controller: AbortController; at: number }
>();
const EARLY_READ_MAX_AGE_MS = 30_000;

/** Starts the signed reads before the session is known; the browser's
 * cookie authenticates them. Without a valid cookie the worker refuses the
 * workspace state (401), and the public reads start at once instead. */
export function startEarlyWorkspaceRead(id: string) {
  const at = Date.now();
  for (const [workspace, entry] of early)
    if (at - entry.at >= EARLY_READ_MAX_AGE_MS)
      dropEarlyWorkspaceRead(workspace);
  if (early.has(id)) return;
  const controller = new AbortController();
  const signal = controller.signal;
  const promise = (async (): Promise<EarlyView> => {
    const stateRead = signedState(id, signal);
    const statusRead = readConversationStatus(
      `room:${id}` as ChatRoomId,
      signal,
    );
    const results = Promise.allSettled([
      readNativeRoomWithCookie(id, signal),
      stateRead,
      statusRead,
    ]);
    const unauthorized = await stateRead.then(
      () => false,
      (reason) => reason instanceof CommunityApiError && reason.status === 401,
    );
    if (unauthorized)
      return {
        kind: "public",
        view: await readPublicWorkspace(
          id,
          signal,
          statusRead.catch(() =>
            readConversationStatus(`room:${id}` as ChatRoomId, signal),
          ),
        ),
      };
    const [workspace, state, status] = await results;
    if (
      workspace.status === "fulfilled" &&
      state.status === "fulfilled" &&
      status.status === "fulfilled"
    )
      return {
        kind: "signed",
        view: {
          workspace: workspace.value,
          state: state.value,
          status: status.value,
        },
      };
    throw [workspace, state, status].find(
      (result) => result.status === "rejected",
    )!.reason;
  })();
  promise.catch(() => {});
  early.set(id, { promise, controller, at });
}

/** Hands the early reads to the page once sign-in has restored. */
export function takeEarlyWorkspaceRead(id: string) {
  const entry = early.get(id);
  early.delete(id);
  if (entry && Date.now() - entry.at >= EARLY_READ_MAX_AGE_MS) {
    entry.controller.abort();
    return undefined;
  }
  return entry?.promise;
}

/** The page left before using them. */
export function dropEarlyWorkspaceRead(id: string) {
  early.get(id)?.controller.abort();
  early.delete(id);
}

const samePrincipal = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();

/** The view for the account sign-in restored. Early answers count only when
 * they were read for that same account; anything else is read again. */
export async function loadWorkspaceView(
  id: string,
  account: ChatPrincipalId | undefined,
  started: Promise<EarlyView> | undefined,
  signal: AbortSignal,
): Promise<WorkspaceView> {
  const answer = started && (await started.catch(() => undefined));
  signal.throwIfAborted();
  if (
    answer?.kind === "signed" &&
    account &&
    samePrincipal(answer.view.state?.viewer.principalId, account)
  ) {
    rememberNativeRoom(answer.view.workspace!);
    return answer.view;
  }
  if (answer?.kind === "public" && !account) return answer.view;
  return account
    ? readSignedWorkspace(id, signal)
    : readPublicWorkspace(id, signal);
}

/** A setup read that could not load, in the order Home names them. */
export const SETUP_READS = [
  "install",
  "requests",
  "priorities",
  "team",
  "widget",
] as const;
export type SetupRead = (typeof SETUP_READS)[number];

export type WorkspaceSetup = {
  origins?: string[];
  staff?: number;
  hasRequests?: boolean;
  installChecked?: boolean;
  priorityContractsPicked?: boolean;
  hostedPage?: boolean;
  /** Null when the service refuses this viewer the report (401 or 403). */
  report?: SupportReport | null;
  /** The report read failed for another reason. A retry may load it. */
  reportError?: boolean;
  /** Reads that failed. Their values stay unset: unknown, never false or
   * zero. */
  failed?: SetupRead[];
};

const refused = (reason: unknown) =>
  reason instanceof CommunityApiError &&
  (reason.status === 401 || reason.status === 403);

/** Home's reads. The report settles whether a request arrived; the list of
 * all requests is read only when the report shows none, because the report
 * leaves out spam and the test accounts a manager lists. With the install
 * check on, the manager's install check result is read instead. */
export async function readWorkspaceSetup(
  room: ChatRoomId,
  manager: boolean,
  signal?: AbortSignal,
  installCheck = false,
  priorityFeed = false,
): Promise<WorkspaceSetup> {
  const results: WorkspaceSetup = {};
  const failed = new Set<SetupRead>();
  // An answer of the wrong shape counts as a failed read too.
  const read = <T>(
    name: SetupRead,
    request: Promise<T>,
    apply: (data: T) => void,
  ) =>
    request.then(apply).catch(() => {
      failed.add(name);
    });
  await Promise.all([
    manager && priorityFeed
      ? read("priorities", readPrioritySettings(room, signal), (data) => {
          if (!Array.isArray(data.settings.contracts))
            throw new TypeError("contracts");
          results.priorityContractsPicked = data.settings.contracts.length > 0;
        })
      : undefined,
    manager && installCheck
      ? read(
          "install",
          communityFetch<{ check: InstallCheckRecord | null }>(
            roomPath(room, "widget/install-check"),
            undefined,
            signal,
          ),
          (data) => {
            if (
              !Object.hasOwn(data, "check") ||
              (data.check !== null && typeof data.check !== "object")
            )
              throw new TypeError("install check");
            results.installChecked = installCheckComplete(data.check);
          },
        )
      : undefined,
    manager
      ? read(
          "widget",
          communityFetch<{
            origins: string[];
            hostedPage?: boolean;
            options?: { hostedPage?: boolean };
          }>(roomPath(room, "widget"), undefined, signal),
          (data) => {
            if (
              !Array.isArray(data.origins) ||
              !data.origins.every((origin) => typeof origin === "string")
            )
              throw new TypeError("origins");
            results.origins = data.origins;
            results.hostedPage = data.hostedPage === true && data.options?.hostedPage === true;
          },
        )
      : undefined,
    manager
      ? read(
          "team",
          communityFetch<{
            moderators: { wallet: string; permissions: string[] }[];
          }>(roomPath(room, "moderation"), undefined, signal),
          (data) => {
            if (
              !Array.isArray(data.moderators) ||
              !data.moderators.every((entry) =>
                Array.isArray(entry.permissions),
              )
            )
              throw new TypeError("moderators");
            results.staff = data.moderators.filter((entry) =>
              entry.permissions.includes("handleConversations"),
            ).length;
          },
        )
      : undefined,
    communityFetch<{ report: SupportReport }>(
      roomPath(room, "conversations/report"),
      undefined,
      signal,
    )
      .then((data) => {
        if (
          !data?.report ||
          !Number.isSafeInteger(data.report.requests) ||
          data.report.requests < 0
        )
          throw new TypeError("report");
        results.report = data.report;
      })
      .catch((reason: unknown) => {
        if (refused(reason)) results.report = null;
        else results.reportError = true;
      }),
  ]);
  // Only the manager's setup list uses it.
  if (manager && !installCheck) {
    if (results.report && results.report.requests > 0)
      results.hasRequests = true;
    else
      await read(
        "requests",
        listConversations(room, "all", null, signal),
        (page) => {
          results.hasRequests = page.conversations.length > 0;
        },
      );
  }
  if (failed.size)
    results.failed = SETUP_READS.filter((name) => failed.has(name));
  return results;
}

/** Home's reads started with the workspace reads when the page already
 * knows the viewer manages it. Kept per account and session revision. */
const setups = accountChatCache<Promise<WorkspaceSetup>>(8, 60_000);
const setupKey = (
  room: ChatRoomId,
  revision: number,
  installCheck = false,
  priorityFeed = false,
) => `${room}:${revision}:${installCheck}:${priorityFeed}`;
export function prefetchWorkspaceSetup(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  revision: number,
  installCheck = false,
  priorityFeed = false,
) {
  if (
    !account ||
    setups.get(account, setupKey(room, revision, installCheck, priorityFeed))
  )
    return;
  const promise = readWorkspaceSetup(
    room,
    true,
    undefined,
    installCheck,
    priorityFeed,
  );
  promise.catch(() => {});
  setups.set(
    account,
    setupKey(room, revision, installCheck, priorityFeed),
    promise,
  );
}
/** The prefetched reads, when they were made for a manager view. */
export function takeWorkspaceSetup(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  revision: number,
  manager: boolean,
  installCheck = false,
  priorityFeed = false,
) {
  const promise = setups.get(
    account,
    setupKey(room, revision, installCheck, priorityFeed),
  );
  setups.delete(account, setupKey(room, revision, installCheck, priorityFeed));
  return manager ? promise : undefined;
}
