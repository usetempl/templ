import { brandAsset } from "./brand-assets";
import type { TeamConversation } from "@templ/chat/index";
import type { InboxCounts } from "./inbox-counts";
import type { SupportPulseRead } from "./support-insights-client";

/** Keeps staff from missing a request while the inbox sits in a background
 * tab: the Needs you count goes in the tab title and icon, and, after a
 * click on "Alert me in this browser", a browser notification says that a
 * request needs a person. Requests the AI agent is handling show nothing.
 * Against a service without the pulse, the open-chat count and the earlier
 * alerts stay. Alerts come from an open Templ tab, never with Templ closed,
 * and never carry message text, names or wallets. */

export const INBOX_POLL = {
  visibleMs: 30_000,
  hiddenMs: 60_000,
  /** Up to this share of the delay is added at random, so open tabs spread out. */
  jitter: 0.25,
  maxBackoffMs: 5 * 60_000,
  /** Pages read per check. The worker pages 50 chats at a time, and a paid
   * workspace holds at most 1,000 open chats. */
  maxPages: 20,
} as const;
export const INBOX_ALERTS_KEY = "templ:inbox-alerts:v1";

/** The wait before the next read: longer while the tab is hidden and after
 * failures, with jitter. */
export function nextInboxRead(
  hidden: boolean,
  failures: number,
  random: () => number = Math.random,
): number {
  const base = hidden ? INBOX_POLL.hiddenMs : INBOX_POLL.visibleMs;
  const delay = Math.min(
    base * 2 ** Math.min(Math.max(failures, 0), 8),
    INBOX_POLL.maxBackoffMs,
  );
  return Math.round(delay * (1 + INBOX_POLL.jitter * random()));
}

type VisibilityTarget = Pick<
  Document,
  "hidden" | "addEventListener" | "removeEventListener"
>;
/** Reads now, then keeps reading on a timer, including while the tab is
 * hidden. Coming back to the tab reads at once. A complete open list that
 * the inbox page read on its own (`shared`) counts as a read and puts the
 * next one off. A request (`requests`) reads at once, or right after the
 * read in flight. Returns a stop function. */
export function watchInbox(options: {
  read: () => Promise<unknown>;
  /** Subscribes to lists read elsewhere; returns an unsubscribe function. */
  shared?: (received: () => void) => () => void;
  /** Subscribes to requests for a fresh read; returns an unsubscribe
   * function. */
  requests?: (readNow: () => void) => () => void;
  document?: VisibilityTarget;
  random?: () => number;
}): () => void {
  const target = options.document ?? document;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reading = false;
  let again = false;
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped)
      timer = setTimeout(
        () => void tick(),
        nextInboxRead(target.hidden, failures, options.random),
      );
  };
  const tick = async () => {
    if (stopped || reading) return;
    reading = true;
    clearTimeout(timer);
    try {
      await options.read();
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      reading = false;
    }
    if (again && !stopped) {
      again = false;
      void tick();
      return;
    }
    schedule();
  };
  const visible = () => {
    if (!target.hidden) void tick();
  };
  target.addEventListener("visibilitychange", visible);
  const unsubscribe = options.shared?.(() => {
    if (stopped || reading) return;
    failures = 0;
    schedule();
  });
  const unsubscribeRequests = options.requests?.(() => {
    if (stopped) return;
    if (reading) again = true;
    else void tick();
  });
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    target.removeEventListener("visibilitychange", visible);
    unsubscribe?.();
    unsubscribeRequests?.();
  };
}

type OpenInbox = { conversations: InboxItem[]; more: false };
const openInboxListeners = new Map<string, Set<(inbox: OpenInbox) => void>>();
const openInboxKey = (room: string, account: string | undefined) =>
  `${room}:${account?.toLowerCase() ?? "guest"}`;
/** The inbox page hands over every open chat it just read, so the badge and
 * alerts need no second read of the same list. Delivered live to listeners
 * for the same room and account; nothing is kept. */
export function publishOpenInbox(
  room: string,
  account: string | undefined,
  conversations: readonly InboxItem[],
) {
  const listeners = openInboxListeners.get(openInboxKey(room, account));
  if (!listeners) return;
  const inbox: OpenInbox = { conversations: [...conversations], more: false };
  for (const listener of listeners) listener(inbox);
}
export function subscribeOpenInbox(
  room: string,
  account: string | undefined,
  listener: (inbox: OpenInbox) => void,
): () => void {
  const key = openInboxKey(room, account);
  const listeners = openInboxListeners.get(key) ?? new Set();
  listeners.add(listener);
  openInboxListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) openInboxListeners.delete(key);
  };
}

type InboxItem = Pick<TeamConversation, "id" | "support">;
/** Every open chat, following the list's cursor for up to maxPages pages.
 * The worker lists the oldest chats first, so new requests are on the last
 * page. `more` says the cap cut the list short. */
export async function readOpenInbox<T extends InboxItem>(
  readPage: (
    cursor: string | null,
  ) => Promise<{ conversations: T[]; nextCursor: string | null }>,
  maxPages: number = INBOX_POLL.maxPages,
): Promise<{ conversations: T[]; more: boolean }> {
  const conversations: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const read: { conversations: T[]; nextCursor: string | null } =
      await readPage(cursor);
    conversations.push(...read.conversations);
    cursor = read.nextCursor;
    if (!cursor) return { conversations, more: false };
  }
  return { conversations, more: true };
}

export type InboxSnapshot = {
  /** Conversation id to the time of its latest member message. */
  items: ReadonlyMap<string, string | null>;
  /** The newest conversation id any read has seen. Ids grow with the time a
   * chat was created. */
  newestId: string | null;
  /** The latest member message any read has seen, in milliseconds. */
  latestMemberAt: number;
};
const time = (at: string | null | undefined) => (at ? Date.parse(at) : NaN);
export function inboxSnapshot(
  conversations: readonly InboxItem[],
  previous: InboxSnapshot | null = null,
): InboxSnapshot {
  let newestId = previous?.newestId ?? null;
  let latestMemberAt = previous?.latestMemberAt ?? -Infinity;
  const items = new Map<string, string | null>();
  for (const item of conversations) {
    const at = item.support?.lastMemberMessageAt ?? null;
    items.set(item.id, at);
    if (newestId === null || item.id > newestId) newestId = item.id;
    const ms = time(at);
    if (ms > latestMemberAt) latestMemberAt = ms;
  }
  return { items, newestId, latestMemberAt };
}
/** What arrived since the last read. A request is new only when it is newer
 * than every chat seen before, so an older chat coming back into the list is
 * never announced as new. A reply is a member message newer than the one
 * last seen in that chat, or, for a chat not seen last time, newer than any
 * member message seen before. The first read is the baseline. */
export function inboxChanges(
  previous: InboxSnapshot | null,
  next: InboxSnapshot,
): { requests: number; replies: number } {
  const changes = { requests: 0, replies: 0 };
  if (!previous) return changes;
  for (const [id, at] of next.items) {
    const after = time(at);
    if (previous.items.has(id)) {
      const before = previous.items.get(id);
      if (Number.isFinite(after) && (!before || after > time(before)))
        changes.replies += 1;
    } else if (previous.newestId === null || id > previous.newestId)
      changes.requests += 1;
    else if (Number.isFinite(after) && after > previous.latestMemberAt)
      changes.replies += 1;
  }
  return changes;
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isoOrNull = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
/** The pulse as the inbox counts. A pulse without the split into Needs you
 * and AI is handling (never expected from this release's service) counts
 * every wait as needing a person: an extra alert beats a missed one. */
export function pulseCounts(pulse: SupportPulseRead, at: number): InboxCounts {
  const split = isCount(pulse.needsYou) && isCount(pulse.aiHandling);
  return {
    needsYou: split ? pulse.needsYou! : pulse.needsReply,
    aiHandling: split ? pulse.aiHandling! : 0,
    more: pulse.needsReplyMore,
    waitingOnMember: isCount(pulse.waitingOnMember) ? pulse.waitingOnMember : 0,
    waitingOnMemberMore: pulse.waitingOnMemberMore === true,
    needsYouOldestSince: isoOrNull(
      split ? pulse.needsYouOldestSince : pulse.oldestWaitingSince,
    ),
    needsYouNewestSince: isoOrNull(
      split ? pulse.needsYouNewestSince : pulse.newestWaitingSince,
    ),
    agentRegistered: split && pulse.agentRegistered === true,
    agentActive: split && pulse.agentActive === true,
    agentSeenAt: split ? isoOrNull(pulse.agentSeenAt) : null,
    complete: pulse.complete,
    at,
  };
}
/** How many more requests need a person than at the last read: the rise
 * in Needs you, or one when its newest wait is newer than the last one
 * seen. The first read is the baseline, and a rise in AI is handling alone
 * is nothing. */
export function needsYouRise(
  previous: InboxCounts | null,
  next: InboxCounts,
): number {
  if (!previous) return 0;
  const rise = next.needsYou - previous.needsYou;
  if (rise > 0) return rise;
  const after = time(next.needsYouNewestSince);
  const before = time(previous.needsYouNewestSince);
  return next.needsYou > 0 &&
    Number.isFinite(after) &&
    (!Number.isFinite(before) || after > before)
    ? 1
    : 0;
}
/** The tab title, icon and rail badge: "3", "3+", or null for nothing. */
export function countBadge(count: number, more: boolean): string | null {
  return count > 0 ? `${count}${more ? "+" : ""}` : null;
}

const COUNT_PREFIX = /^\(\d+\+?\) /;
/** "(3) Title". A null count restores the plain title. */
export function titleWithCount(title: string, count: string | null): string {
  const base = title.replace(COUNT_PREFIX, "");
  return count ? `(${count}) ${base}` : base;
}

/** Plain words about what arrived. No message text, names or wallets. */
export function inboxAlertMessage(
  changes: { requests: number; replies: number },
  workspace: string,
): { title: string; body: string } | null {
  const body =
    changes.requests === 1
      ? "New support case waiting."
      : changes.requests > 1
        ? `${changes.requests} new support cases waiting.`
        : changes.replies === 1
          ? "A user is waiting for a reply."
          : changes.replies > 1
            ? `${changes.replies} users are waiting for a reply.`
            : null;
  return body ? { title: `${workspace} inbox`, body } : null;
}

/** "A case needs you." No message text, names or wallets. */
export function needsYouAlertMessage(
  rise: number,
  workspace: string,
): { title: string; body: string } | null {
  if (!(rise >= 1)) return null;
  return {
    title: `${workspace} inbox`,
    body: rise === 1 ? "A case needs you." : `${rise} cases need you.`,
  };
}

type NotificationApi = {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (
    title: string,
    options?: NotificationOptions,
  ): { onclick: ((event: Event) => unknown) | null; close(): void };
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Stored when this browser's notification constructor throws, as it does in
 * browsers that show notifications only from a service worker, such as
 * Chrome on Android. */
const UNSUPPORTED = "unsupported";
const failureListeners = new Set<() => void>();
/** Called when an alert couldn't be shown and alerts turned unsupported. */
export function onInboxAlertsFailed(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}
const stateListeners = new Set<() => void>();
/** Called whenever this tab turns alerts on or off, or finds it can't show
 * them, so every control that offers alerts shows the same state. */
export function subscribeInboxAlerts(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}
function alertsChanged() {
  for (const listener of [...stateListeners]) listener();
}
export type AlertEnvironment = {
  Notification?: NotificationApi;
  storage?: () => StorageLike;
  document?: Pick<Document, "hidden" | "hasFocus">;
  focus?: () => void;
};
function environment(env: AlertEnvironment = {}) {
  const global = globalThis as typeof globalThis & {
    Notification?: NotificationApi;
  };
  return {
    Notification: env.Notification ?? global.Notification,
    storage: env.storage ?? (() => global.localStorage),
    document: env.document ?? global.document,
    focus: env.focus ?? (() => global.focus?.()),
  };
}
function readPreference(storage: () => StorageLike): string | null {
  try {
    return storage().getItem(INBOX_ALERTS_KEY);
  } catch {
    return null;
  }
}
function writePreference(
  storage: () => StorageLike,
  value: "on" | typeof UNSUPPORTED | null,
) {
  try {
    if (value) storage().setItem(INBOX_ALERTS_KEY, value);
    else storage().removeItem(INBOX_ALERTS_KEY);
  } catch {
    // Private windows and blocked storage keep alerts off.
  }
}
/** Whether a page may construct notifications here. Checked only while
 * permission isn't granted, when a browser that allows it shows nothing. */
function constructorWorks(Notification: NotificationApi): boolean {
  try {
    const probe = new Notification("", { silent: true });
    probe.close();
    return true;
  } catch (error) {
    return !(error instanceof TypeError);
  }
}

export type InboxAlertState = "unsupported" | "blocked" | "on" | "off";
/** On only when this browser both allows notifications and was asked to. */
export function inboxAlertState(env?: AlertEnvironment): InboxAlertState {
  const { Notification, storage } = environment(env);
  const stored = readPreference(storage);
  if (!Notification || stored === UNSUPPORTED) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && stored === "on"
    ? "on"
    : "off";
}
/** Call from a click. Asks the browser for permission only when needed. */
export async function setInboxAlerts(
  on: boolean,
  env?: AlertEnvironment,
): Promise<InboxAlertState> {
  const state = await changeInboxAlerts(on, env);
  alertsChanged();
  return state;
}
async function changeInboxAlerts(
  on: boolean,
  env?: AlertEnvironment,
): Promise<InboxAlertState> {
  const resolved = environment(env);
  if (!on) {
    writePreference(resolved.storage, null);
    return inboxAlertState(env);
  }
  if (!resolved.Notification) return "unsupported";
  if (
    resolved.Notification.permission === "default" &&
    !constructorWorks(resolved.Notification)
  ) {
    writePreference(resolved.storage, UNSUPPORTED);
    return "unsupported";
  }
  const permission =
    resolved.Notification.permission === "default"
      ? await resolved.Notification.requestPermission()
      : resolved.Notification.permission;
  if (permission === "granted") writePreference(resolved.storage, "on");
  return inboxAlertState(env);
}
/** Shows one browser notification about what arrived in the open list,
 * for a service without the pulse. See showAlert. */
export function showInboxAlert(
  changes: { requests: number; replies: number },
  workspace: string,
  tag: string,
  env?: AlertEnvironment,
): boolean {
  return showAlert(inboxAlertMessage(changes, workspace), tag, env);
}
/** Shows one browser notification when more requests need a person. See
 * showAlert. */
export function showNeedsYouAlert(
  rise: number,
  workspace: string,
  tag: string,
  env?: AlertEnvironment,
): boolean {
  return showAlert(needsYouAlertMessage(rise, workspace), tag, env);
}
/** Shows one browser notification when alerts are on and the person is
 * looking elsewhere. Returns whether it showed. A browser that refuses to
 * construct one turns alerts unsupported, so the toggle stops saying On.
 * The tag makes each alert replace the workspace's last one. */
function showAlert(
  message: { title: string; body: string } | null,
  tag: string,
  env?: AlertEnvironment,
): boolean {
  const resolved = environment(env);
  if (!message || inboxAlertState(env) !== "on") return false;
  if (!resolved.document.hidden && resolved.document.hasFocus()) return false;
  try {
    const shown = new resolved.Notification!(message.title, {
      body: message.body,
      tag,
    });
    shown.onclick = () => {
      resolved.focus();
      shown.close();
    };
    return true;
  } catch {
    writePreference(resolved.storage, UNSUPPORTED);
    for (const listener of failureListeners) listener();
    alertsChanged();
    return false;
  }
}

/** A pulse is tried again this long after the service said it has none. */
export const PULSE_RETRY_MS = 10 * 60_000;
const routeMissing = (status: unknown) => status === 404 || status === 405;
/** Watches one workspace's inbox for the title, icon, rail badge, browser
 * alerts and the counts the views bar and Home read. It reads the pulse;
 * when the service has no pulse (404 or 405, retried after
 * PULSE_RETRY_MS), is still preparing it (complete false) or answers
 * something unreadable, it reads every open chat instead, keeps the earlier
 * count and alerts, and publishes no counts. A switch between the two
 * starts a new baseline, so it never alerts by itself. Returns a stop
 * function. */
export function watchInboxAttention(options: {
  readPulse: (signal: AbortSignal) => Promise<SupportPulseRead>;
  readOpenList: (
    signal: AbortSignal,
  ) => Promise<{ conversations: InboxItem[]; more: boolean }>;
  /** Complete open lists the inbox page read. Used only while the service
   * has no pulse. */
  shared?: (listener: (inbox: OpenInbox) => void) => () => void;
  /** Requests for fresh counts, such as after a reply in the open thread. */
  requests?: (readNow: () => void) => () => void;
  /** Counts for the views bar and Home; null while they come from the list. */
  publish: (counts: InboxCounts | null) => void;
  /** "3", "3+" or null. */
  onBadge: (badge: string | null) => void;
  workspace: string;
  tag: string;
  env?: AlertEnvironment;
  document?: VisibilityTarget;
  random?: () => number;
  now?: () => number;
}): () => void {
  const controller = new AbortController();
  const now = options.now ?? Date.now;
  let source: "pulse" | "list" | null = null;
  let pulseAfter = 0;
  let counts: InboxCounts | null = null;
  let snapshot: InboxSnapshot | null = null;
  const fromPulse = (pulse: SupportPulseRead) => {
    const next = pulseCounts(pulse, now());
    showNeedsYouAlert(
      needsYouRise(source === "pulse" ? counts : null, next),
      options.workspace,
      options.tag,
      options.env,
    );
    source = "pulse";
    counts = next;
    options.publish(next);
    options.onBadge(countBadge(next.needsYou, next.more));
  };
  const fromList = (inbox: { conversations: InboxItem[]; more: boolean }) => {
    const previous = source === "list" ? snapshot : null;
    const next = inboxSnapshot(inbox.conversations, previous);
    showInboxAlert(
      inboxChanges(previous, next),
      options.workspace,
      options.tag,
      options.env,
    );
    source = "list";
    snapshot = next;
    options.publish(null);
    options.onBadge(countBadge(inbox.conversations.length, inbox.more));
  };
  const read = async () => {
    const { signal } = controller;
    if (now() >= pulseAfter) {
      try {
        const pulse = await options.readPulse(signal);
        if (signal.aborted) return;
        if (pulse.complete) return fromPulse(pulse);
        // Still preparing: the list this time, the pulse at the next read.
        pulseAfter = now() + INBOX_POLL.visibleMs;
      } catch (error) {
        if (signal.aborted) return;
        const status = (error as { status?: unknown } | null)?.status;
        if (routeMissing(status)) pulseAfter = now() + PULSE_RETRY_MS;
        // Any other refusal waits and backs off; an unreadable answer or a
        // lost connection tries the list.
        else if (typeof status === "number") throw error;
      }
    }
    const inbox = await options.readOpenList(signal);
    if (!signal.aborted) fromList(inbox);
  };
  const stop = watchInbox({
    read,
    // While the list is the source, the inbox page's complete reads count.
    shared: options.shared
      ? (received) =>
          options.shared!((inbox) => {
            if (controller.signal.aborted) return;
            if (source !== "list" || now() >= pulseAfter) return;
            fromList(inbox);
            received();
          })
      : undefined,
    requests: options.requests,
    document: options.document,
    random: options.random,
  });
  return () => {
    controller.abort();
    stop();
  };
}

/** The tab keeps its normal mark until a case needs staff attention. */
export function badgeFavicon(count: string | null, doc: Document = document) {
  doc.getElementById("templ-theme-icon")?.setAttribute(
    "href",
    brandAsset(count ? "/favicon-unread.svg" : "/favicon.svg"),
  );
}
