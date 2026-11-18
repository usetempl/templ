"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { zeroAddress } from "viem";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  ChatRoomId,
  ChatSubscriptions,
  NativeRoom,
} from "@templ/chat/index";
import { CommunityApiError, communityFetch } from "./community-client";
import {
  communitySessionRevision,
  peekCommunitySession,
  readCommunitySession,
  subscribeCommunitySession,
} from "./community-auth";
import type { CommunityIdentityRead } from "./community-room-cache";
import { chatMutation } from "./chat-api";
import { normalizeChatRoomId, nativeRoomKey } from "./chat-room-id";
import type { DirectoryCommunity } from "./community-directory";
import { checkedNativeRoom } from "./native-room";

/** Current-access metadata returned by the hidden workspace list. */
type ChatHiddenWorkspaces = {
  viewerPrincipalId: ChatPrincipalId;
  viewerWallet: string | null;
  workspaces: NativeRoom[];
  nextCursor: string | null;
};

type Follow = {
  scope: string;
  templ: ChatRoomId;
  confirmed?: boolean;
  desired?: boolean;
  failedDesired?: boolean;
  community?: CommunityIdentityRead;
  pending: boolean;
  error?: string;
  intent: number;
  settledAt: number;
  assertCurrent?: () => void;
  writing?: Promise<void>;
  reading?: Promise<void>;
};
const follows = new Map<string, Follow>();
const listeners = new Set<() => void>();
let storeVersion = 0;
let intentVersion = 0;
const subscribeFollows = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const followVersion = () => storeVersion;
const publish = () => {
  ++storeVersion;
  listeners.forEach((listener) => listener());
};
function followScope(account?: ChatPrincipalId) {
  return `${account?.toLowerCase() ?? "guest"}:${communitySessionRevision()}`;
}
function entry(scope: string, templ: ChatRoomId) {
  const key = `${scope}:${templ.toLowerCase()}`;
  let value = follows.get(key);
  if (!value) {
    value = { scope, templ, pending: false, intent: 0, settledAt: 0 };
    follows.set(key, value);
    // Follow state contains public metadata only and grants no case access.
    if (follows.size > 400) {
      for (const [oldKey, old] of follows) {
        if (oldKey !== key && !old.pending && !old.reading)
          follows.delete(oldKey);
        if (follows.size <= 300) break;
      }
    }
  }
  return value;
}
const followError = (reason: unknown) =>
  reason instanceof Error &&
  !/failed to fetch|networkerror|load failed/i.test(reason.message)
    ? reason.message
    : "Couldn’t save this workspace. Try again.";

function confirmFollow(value: Follow, subscribed: boolean) {
  value.confirmed = subscribed;
  // A later read may confirm a write whose response was lost. Otherwise keep
  // its retry available; background refreshes must not discard the last click.
  if (value.failedDesired === undefined || value.failedDesired === subscribed) {
    value.failedDesired = undefined;
    value.error = undefined;
  }
}

/** Creation already confirmed the server-side follow; update the sidebar in the same frame. */
export function rememberCreatedRoomFollow(
  account: ChatPrincipalId,
  raw: NativeRoom,
) {
  const room = checkedNativeRoom(raw);
  if (room.creator.toLowerCase() !== account.toLowerCase()) return;
  const value = entry(followScope(account), nativeRoomKey(room.id));
  value.confirmed = true;
  value.desired = true;
  value.failedDesired = undefined;
  value.settledAt = Date.now();
  value.intent = ++intentVersion;
  value.community = {
    address: nativeRoomKey(room.id),
    tokenAddress: zeroAddress,
    creator: room.creator,
    name: room.name,
    symbol: "",
    image: room.image ?? undefined,
    nativeRoom: room,
  };
  publish();
}

/** Latest intent is visible immediately; writes for one wallet/room are serialized. */
export function setChatSubscription({
  account,
  community,
  subscribed,
  assertCurrent,
}: {
  account: ChatPrincipalId;
  community: CommunityIdentityRead;
  subscribed: boolean;
  assertCurrent: () => void;
}): Promise<void> {
  const scope = followScope(account);
  const validate = () => {
    if (followScope(account) !== scope || !peekCommunitySession(account))
      throw new CommunityApiError("Sign in to continue.", 401);
    assertCurrent();
  };
  validate();
  const value = entry(scope, normalizeChatRoomId(community.address));
  value.community = community;
  value.desired = subscribed;
  value.assertCurrent = validate;
  value.intent = ++intentVersion;
  value.pending = true;
  value.error = undefined;
  value.failedDesired = undefined;
  publish();
  if (value.writing) return value.writing;
  const task = (async () => {
    while (value.pending) {
      const intent = value.intent;
      const desired = value.desired!;
      const guard = value.assertCurrent!;
      try {
        await chatMutation(
          account,
          "/subscriptions",
          { roomId: value.templ.slice(5), subscribed: desired },
          guard,
        );
        value.settledAt = ++intentVersion;
        value.confirmed = desired;
        if (value.intent !== intent) continue;
        value.pending = false;
        value.desired = undefined;
        value.error = undefined;
      } catch (reason) {
        value.settledAt = ++intentVersion;
        // An older failure cannot roll back a newer click. Send that last intent.
        if (value.intent !== intent) continue;
        value.pending = false;
        value.desired = undefined;
        value.failedDesired = desired;
        value.error = followError(reason);
        throw reason;
      } finally {
        publish();
      }
    }
  })();
  value.writing = task;
  void task
    .finally(() => {
      if (value.writing === task) value.writing = undefined;
    })
    .catch(() => {});
  return task;
}

/** A signed-in account's favorites. A favorite grants no case access. */
export function useChatSubscriptions(
  account: ChatPrincipalId | undefined,
  enabled: boolean,
) {
  return useWorkspaceSubscriptions(account, enabled, false);
}

/** Hidden workspaces remain reachable, subject to current account access. */
export function useHiddenWorkspaces(
  account: ChatPrincipalId | undefined,
  enabled: boolean,
) {
  return useWorkspaceSubscriptions(account, enabled, true);
}

function useWorkspaceSubscriptions(
  account: ChatPrincipalId | undefined,
  enabled: boolean,
  hidden: boolean,
) {
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    communitySessionRevision,
  );
  useSyncExternalStore(subscribeFollows, followVersion, followVersion);
  const [page, setPage] = useState<{
    scope: string;
    items: DirectoryCommunity[];
    cursor: string | null;
    readIntent: number;
  }>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ scope: string; message: string }>();
  const [version, setVersion] = useState(0);
  const active = useRef(0);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const scope = `${account?.toLowerCase() ?? "guest"}:${revision}`;
  const refresh = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);
  const read = useCallback(
    async (cursor?: string) => {
      if (!account || !enabled || pending.current) return;
      const request = active.current;
      const readIntent = intentVersion;
      pending.current = true;
      const abort = new AbortController();
      controller.current = abort;
      setLoading(true);
      try {
        const session = await readCommunitySession(false, account);
        if (request !== active.current) return;
        if (session?.principalId.toLowerCase() !== account.toLowerCase()) {
          if (request === active.current) setPage(undefined);
          return;
        }
        const response = await communityFetch<
          ChatSubscriptions | ChatHiddenWorkspaces
        >(
          `/subscriptions${hidden ? "/hidden" : ""}?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          undefined,
          abort.signal,
        );
        if (request !== active.current) return;
        if (
          typeof response.viewerPrincipalId !== "string" ||
          response.viewerPrincipalId.toLowerCase() !== account.toLowerCase()
        )
          throw new CommunityApiError(
            "Your workspace list couldn’t be verified.",
            401,
          );
        const rooms = hidden
          ? (response as ChatHiddenWorkspaces).workspaces
          : (response as ChatSubscriptions).subscriptions
              .filter((subscription) => subscription.kind === "native")
              .map((subscription) => subscription.room);
        if (!Array.isArray(rooms))
          throw new CommunityApiError(
            "Your workspace list could not load.",
            503,
          );
        const items = await Promise.all(
          rooms.map(async (raw) => {
            const room = checkedNativeRoom(raw);
            return {
              address: nativeRoomKey(room.id),
              tokenAddress: zeroAddress,
              creator: room.creator,
              name: room.name,
              symbol: "",
              image: room.image ?? undefined,
              nativeRoom: room,
              isMember: true,
            };
          }),
        );
        if (request !== active.current) return;
        const verifiedItems = items.filter((item) => item !== undefined);
        for (const item of verifiedItems) {
          const follow = entry(scope, item.address);
          follow.community = item;
          if (
            !follow.pending &&
            Math.max(follow.intent, follow.settledAt) <= readIntent
          ) {
            confirmFollow(follow, !hidden);
          }
        }
        if (!hidden && !cursor && !response.nextCursor) {
          const present = new Set(
            verifiedItems.map((item) => item.address.toLowerCase()),
          );
          for (const follow of follows.values())
            if (
              follow.scope === scope &&
              !follow.pending &&
              Math.max(follow.intent, follow.settledAt) <= readIntent &&
              !present.has(follow.templ.toLowerCase())
            )
              confirmFollow(follow, false);
        }
        publish();
        setPage((previous) => ({
          scope,
          cursor: response.nextCursor,
          readIntent,
          items: [
            ...new Map(
              [
                ...(cursor && previous?.scope === scope ? previous.items : []),
                ...verifiedItems,
              ].map((item) => [item.address.toLowerCase(), item]),
            ).values(),
          ],
        }));
        setFailure(undefined);
      } catch (reason) {
        if (request === active.current) {
          if (
            reason instanceof CommunityApiError &&
            [401, 403].includes(reason.status)
          ) {
            setPage(undefined);
            for (const [key, follow] of follows)
              if (follow.scope === scope && !follow.pending)
                follows.delete(key);
            publish();
          }
          setFailure({
            scope,
            message:
              reason instanceof Error
                ? reason.message
                : "Your workspace list couldn’t load.",
          });
        }
      } finally {
        if (request === active.current) {
          pending.current = false;
          controller.current = null;
          setLoading(false);
        }
      }
    },
    [account, enabled, scope, hidden],
  );
  useEffect(() => {
    const generation = ++active.current;
    pending.current = false;
    if (account && enabled) void read();
    return () => {
      active.current = generation + 1;
      pending.current = false;
      controller.current?.abort();
      controller.current = null;
    };
  }, [account, enabled, revision, version, read]);
  useEffect(() => {
    window.addEventListener("templ:membership-changed", refresh);
    return () =>
      window.removeEventListener("templ:membership-changed", refresh);
  }, [refresh]);
  const visible = Boolean(enabled && account && peekCommunitySession(account));
  const overlay = [...follows.values()].filter(
    (follow) => follow.scope === scope,
  );
  const rows = new Map(
    (page?.scope === scope ? page.items : []).map((item) => [
      item.address.toLowerCase(),
      item,
    ]),
  );
  for (const follow of overlay) {
    const subscribed = follow.desired ?? follow.confirmed;
    if (subscribed === hidden) rows.delete(follow.templ.toLowerCase());
    else if (
      subscribed === !hidden &&
      follow.community &&
      (!hidden ||
        follow.pending ||
        Math.max(follow.intent, follow.settledAt) >
          (page?.readIntent ?? intentVersion))
    )
      rows.set(follow.templ.toLowerCase(), {
        ...follow.community,
        isMember: true,
      });
  }
  const mutationError = overlay.find((follow) => follow.error)?.error;
  return {
    items: visible ? [...rows.values()] : [],
    loading: Boolean(enabled && account && loading),
    error:
      enabled && account && failure?.scope === scope
        ? failure.message
        : visible && !hidden
          ? mutationError
          : undefined,
    mutationError: visible ? mutationError : undefined,
    hasMore: visible && page?.scope === scope && Boolean(page?.cursor),
    loadMore: async () => {
      if (visible && page?.scope === scope && page.cursor)
        await read(page.cursor);
    },
    refresh,
  };
}
