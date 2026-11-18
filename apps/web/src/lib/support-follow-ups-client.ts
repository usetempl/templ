import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  SupportFollowUp,
  SupportFollowUpList,
  SupportFollowUpQueue,
  SupportFollowUpQueueView,
  SupportFollowUpSettings,
  SupportFollowUpSettingsView,
  SupportFollowUpState,
  SupportFollowUpType,
  SupportFollowUpWatch,
} from "@templ/chat/support-follow-ups";
import { chatMutation } from "./chat-api";
import { communityFetch, roomPath } from "./community-client";

/** Follow-ups, routing settings and position reads. Every call goes
 * through the service's access check: the team reads and writes, a
 * specialist reaches only what a follow-up or a mention gives it, and
 * everyone else gets 404. Nothing here signs or sends anything on a chain. */
const THREAD = /^tc-[0-9a-f]{32}$/;
const FOLLOW_UP = /^[1-9][0-9]{0,7}-[1-9][0-9]?$/;
const threadPath = (room: ChatRoomId, thread: string, rest = "") => {
  if (!THREAD.test(thread)) throw new Error("Invalid case.");
  return roomPath(room, `conversations/${thread}${rest}`);
};

/** A time-ordered request id the worker checks as UUIDv7; a retry of the
 * same click reuses it. */
export function newFollowUpClientId(now = Date.now()): string {
  const random = crypto.randomUUID();
  const time = now.toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}

export type FollowUpWrite = SupportFollowUpList & {
  followUp?: SupportFollowUp;
  conversation?: { revision: number };
};

export function readFollowUps(
  room: ChatRoomId,
  thread: string,
  signal?: AbortSignal,
): Promise<SupportFollowUpList> {
  return communityFetch<SupportFollowUpList>(
    threadPath(room, thread, "/follow-ups?case=all"),
    undefined,
    signal,
  );
}

export type NewFollowUp = {
  clientId: string;
  type: SupportFollowUpType;
  title: string;
  owner?: ChatPrincipalId | null;
  group?: string | null;
  publicLabel?: string;
  memberVisible?: boolean;
  dependsOn?: string[];
  nextUpdateOn?: string;
  dueAt?: string;
  link?: string;
};
export function addFollowUp(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  thread: string,
  input: NewFollowUp,
): Promise<FollowUpWrite> {
  return chatMutation<FollowUpWrite>(
    account,
    threadPath(room, thread, "/follow-ups"),
    input,
  );
}

export type FollowUpChange = {
  revision: number;
} & (
  | { op: "state"; state: SupportFollowUpState }
  | {
      op: "update";
      owner?: ChatPrincipalId | null;
      group?: string | null;
      title?: string;
      publicLabel?: string;
      memberVisible?: boolean;
      dependsOn?: string[];
      order?: number;
      nextUpdateOn?: string | null;
      dueAt?: string | null;
      link?: string | null;
      watch?: SupportFollowUpWatch | null;
    }
  | { op: "take" }
  | { op: "release" }
);
export function changeFollowUp(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  thread: string,
  id: string,
  input: FollowUpChange,
): Promise<FollowUpWrite> {
  if (!FOLLOW_UP.test(id)) throw new Error("Invalid follow-up.");
  return chatMutation<FollowUpWrite>(
    account,
    threadPath(room, thread, `/follow-ups/${id}`),
    input,
  );
}

/** Removes one stored follow-up that fails its check (team, after a
 * confirmation in the app). */
export function discardUnreadableFollowUp(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  thread: string,
  id: string,
): Promise<FollowUpWrite> {
  if (!FOLLOW_UP.test(id)) throw new Error("Invalid follow-up.");
  return chatMutation<FollowUpWrite>(
    account,
    threadPath(room, thread, `/follow-ups/${id}`),
    { op: "discard-unreadable" },
  );
}

export function readFollowUpQueue(
  room: ChatRoomId,
  query: {
    view: SupportFollowUpQueueView;
    cursor?: string | null;
    owner?: string;
    group?: string;
    type?: SupportFollowUpType;
  },
  signal?: AbortSignal,
): Promise<SupportFollowUpQueue> {
  const params = new URLSearchParams({ view: query.view });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.owner) params.set("owner", query.owner);
  if (query.group) params.set("group", query.group);
  if (query.type) params.set("type", query.type);
  return communityFetch<SupportFollowUpQueue>(
    roomPath(room, `conversations/follow-ups?${params}`),
    undefined,
    signal,
  );
}

export function readFollowUpSettings(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<SupportFollowUpSettingsView> {
  return communityFetch<SupportFollowUpSettingsView>(
    roomPath(room, "conversations/follow-up-settings"),
    undefined,
    signal,
  );
}
export function saveFollowUpSettings(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  /** `confirmed` when the manager reviewed a change of group members. */
  input: SupportFollowUpSettings & { confirmed?: true },
): Promise<SupportFollowUpSettingsView> {
  return chatMutation<SupportFollowUpSettingsView>(
    account,
    roomPath(room, "conversations/follow-up-settings"),
    input,
  );
}

export type PositionReadView = {
  id: string;
  kind: "position" | "legacy";
  seq: number;
  network: string;
  state: "queued" | "done" | "unavailable";
  reason: string | null;
  evidence: string[];
  legacyFacts?: {
    label: string;
    status: string;
    successorLabel: string | null;
    migrationDocUrl: string | null;
  }[];
  requestedAt: string;
  finishedAt: string | null;
};
export function readPositions(
  room: ChatRoomId,
  thread: string,
  signal?: AbortSignal,
): Promise<{ positions: PositionReadView[]; networks: string[] }> {
  return communityFetch(
    threadPath(room, thread, "/positions"),
    undefined,
    signal,
  );
}
export function requestPosition(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  thread: string,
  input: {
    clientId: string;
    kind: "position" | "legacy";
    network: string;
    token?: string;
    compareBlock?: number;
  },
): Promise<{ position: PositionReadView }> {
  return chatMutation(account, threadPath(room, thread, "/positions"), input);
}
