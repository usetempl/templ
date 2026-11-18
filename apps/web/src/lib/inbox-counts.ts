/** The inbox's live counts for one workspace and account, kept in this
 * browser tab's memory only. The workspace's pulse watcher publishes them;
 * the views bar, the tab title and the rail badge read them. Counts and
 * times only: no thread, person, wallet or message. Nothing is stored. */

export type InboxCounts = {
  /** Waiting requests a person must answer. */
  needsYou: number;
  /** Waiting requests the AI agent is expected to answer now. */
  aiHandling: number;
  waitingOnMember: number;
  waitingOnMemberMore: boolean;
  /** The service read only part of the waits: show both counts with "+". */
  more: boolean;
  needsYouOldestSince: string | null;
  needsYouNewestSince: string | null;
  /** The workspace registers an AI agent that is on the team. */
  agentRegistered: boolean;
  /** That agent listed its queue or used a thread in the last minute. */
  agentActive: boolean;
  /** Its latest such request, or null when it made none since Templ last
   * restarted. */
  agentSeenAt: string | null;
  complete: boolean;
  /** When this browser read them, in milliseconds. */
  at: number;
};

/** A fresh pulse is asked for at most this often per workspace and account. */
export const INBOX_COUNTS_REQUEST_MS = 5_000;

type Entry = {
  counts: InboxCounts | null;
  /** Whether the views bar shows AI is handling. It follows the latest
   * counts that say so either way and keeps its last state otherwise, so a
   * restart or a failed read never makes the tab flicker. */
  aiTab: boolean;
};
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const requestListeners = new Map<string, Set<() => void>>();
const lastRequest = new Map<string, number>();
const keyFor = (room: string, account: string | undefined) =>
  `${room}:${account?.toLowerCase() ?? "guest"}`;

/** AI is handling shows while a registered agent has checked in since the
 * last restart or is holding requests. A relay-only bot never checks in, so
 * it never shows the tab; no counts keep the last state. */
export function aiHandlingShown(
  counts: InboxCounts | null,
  previous: boolean,
): boolean {
  if (!counts) return previous;
  if (!counts.agentRegistered) return false;
  if (counts.agentSeenAt !== null || counts.aiHandling > 0) return true;
  return previous;
}

export function publishInboxCounts(
  room: string,
  account: string | undefined,
  counts: InboxCounts | null,
): void {
  const key = keyFor(room, account);
  const previous = entries.get(key);
  entries.set(key, {
    counts: counts ? { ...counts } : null,
    aiTab: aiHandlingShown(counts, previous?.aiTab ?? false),
  });
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}
export function readInboxCounts(
  room: string,
  account: string | undefined,
): InboxCounts | null {
  return entries.get(keyFor(room, account))?.counts ?? null;
}
/** Whether the views bar shows AI is handling for this workspace and
 * account, from the counts this tab saw. */
export function readAiHandlingShown(
  room: string,
  account: string | undefined,
): boolean {
  return entries.get(keyFor(room, account))?.aiTab ?? false;
}
/** Forgets this workspace's counts and request limit for the account, when
 * its inbox access ended. Listeners hear that the counts are gone. */
export function clearInboxCounts(room: string, account: string | undefined) {
  const key = keyFor(room, account);
  entries.delete(key);
  lastRequest.delete(key);
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}
export function subscribeInboxCounts(
  room: string,
  account: string | undefined,
  listener: () => void,
): () => void {
  return add(listeners, keyFor(room, account), listener);
}
/** Asks the watcher for a fresh pulse, at most once per
 * INBOX_COUNTS_REQUEST_MS per room and account. A request nobody hears
 * doesn't count toward the limit. */
export function requestInboxCounts(
  room: string,
  account: string | undefined,
  now = Date.now(),
): void {
  const key = keyFor(room, account);
  const heard = requestListeners.get(key);
  if (!heard?.size) return;
  const last = lastRequest.get(key);
  if (last !== undefined && now - last < INBOX_COUNTS_REQUEST_MS) return;
  lastRequest.set(key, now);
  for (const listener of [...heard]) listener();
}
export function onInboxCountsRequest(
  room: string,
  account: string | undefined,
  listener: () => void,
): () => void {
  return add(requestListeners, keyFor(room, account), listener);
}

function add(
  map: Map<string, Set<() => void>>,
  key: string,
  listener: () => void,
): () => void {
  const set = map.get(key) ?? new Set();
  set.add(listener);
  map.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size) map.delete(key);
  };
}
