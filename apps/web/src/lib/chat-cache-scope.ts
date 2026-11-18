import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { BoundedCache } from "./bounded-cache";
import { communityCacheScope } from "./community-room-cache";
import {
  communitySessionRevision,
  peekCommunitySession,
  subscribeCommunitySession,
} from "./community-auth";

const privateCaches = new Set<{ clear: () => void }>();
let accountScope: string | undefined;
let cacheEpoch = 0;
export function registerPrivateChatCache(cache: { clear: () => void }) {
  privateCaches.add(cache);
}
export function clearPrivateChatCaches() {
  cacheEpoch++;
  for (const cache of privateCaches) cache.clear();
}
subscribeCommunitySession(clearPrivateChatCaches);
/** Shared by channels and support. Presentation data never survives an account
 * switch, sign-out or session revision, and never grants server permission. */
export function chatCacheScope(room: ChatRoomId, account?: ChatPrincipalId) {
  if (accountScope !== account) {
    clearPrivateChatCaches();
    accountScope = account;
  }
  return `${communityCacheScope(room)}:${account ?? "guest"}:${communitySessionRevision()}:${cacheEpoch}`;
}
export function privateChatCacheScope(
  room: ChatRoomId,
  account?: ChatPrincipalId,
) {
  const scope = chatCacheScope(room, account);
  return account && peekCommunitySession(account) ? scope : undefined;
}

/** Checking a pending response must not rotate the active account's caches. */
export function isChatCacheScopeCurrent(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  captured: string | undefined,
) {
  return (
    !!captured &&
    !!account &&
    accountScope === account &&
    captured ===
      `${communityCacheScope(room)}:${account}:${communitySessionRevision()}:${cacheEpoch}`
  );
}

export function isPrivateChatCacheScopeCurrent(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  captured: string | undefined,
) {
  return (
    isChatCacheScopeCurrent(room, account, captured) &&
    !!peekCommunitySession(account)
  );
}

/** Presentation data one account loaded, shown to that account while it is
 * read again. Memory only, read only while that account's session is
 * current, and emptied with the other private caches on sign-out, an
 * account change or any session change. It never authorizes anything. */
export function accountChatCache<T>(limit: number, maxAge: number) {
  const entries = new BoundedCache<T>(limit, maxAge);
  registerPrivateChatCache(entries);
  const key = (account: ChatPrincipalId, id: string) =>
    `${account.toLowerCase()}:${id}`;
  return {
    get(account: ChatPrincipalId | undefined, id: string): T | undefined {
      return account && peekCommunitySession(account)
        ? entries.get(key(account, id))
        : undefined;
    },
    set(account: ChatPrincipalId | undefined, id: string, value: T) {
      if (account && peekCommunitySession(account))
        entries.set(key(account, id), value);
    },
    delete(account: ChatPrincipalId | undefined, id: string) {
      if (account) entries.delete(key(account, id));
    },
  };
}
