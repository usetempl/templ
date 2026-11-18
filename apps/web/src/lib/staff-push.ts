import type { ChatRoomId } from "@templ/chat/index";
import { communityFetch, roomPath } from "./community-client";

/** Push alerts for staff: a push with no text, per workspace. The service
 * (`GET /conversations/push`) says whether pushes work and gives its public
 * key; this browser registers `/inbox-sw.js` for the workspace, subscribes,
 * and sends only the push address. */

export type PushStatus = {
  available: boolean;
  publicKey: string | null;
  subscribed: boolean;
};

/** Whether this browser can take a push. Nothing is offered where it
 * can't: a wallet app's browser on iPhone or iPad has no push, and the home
 * screen app there has no wallet to sign in with (WalletConnect is not in
 * this build), so pointing staff at the home screen would be a dead end.
 * Phone staff there keep the team's alert links (email, Slack, Discord,
 * Telegram). */
export function pushSupported(
  scope: {
    navigator?: Navigator;
    PushManager?: unknown;
    Notification?: unknown;
  } = typeof window === "undefined" ? {} : window,
): boolean {
  const nav = scope.navigator;
  return Boolean(
    nav &&
    "serviceWorker" in nav &&
    typeof scope.PushManager === "function" &&
    typeof scope.Notification === "function",
  );
}

const scopeFor = (room: ChatRoomId) => `/rooms/${room.slice(5)}`;

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const text = atob(publicKey.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
const sameKey = (subscription: PushSubscription, key: Uint8Array) => {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
};

export function readPushStatus(room: ChatRoomId, signal?: AbortSignal) {
  return communityFetch<PushStatus>(
    roomPath(room, "conversations/push"),
    undefined,
    signal,
  );
}

export class PushBlocked extends Error {
  constructor() {
    super("Alerts are blocked for this site.");
    this.name = "PushBlocked";
  }
}

/** Turns on push alerts for this workspace in this browser. Asks for
 * notification permission (only on the person's tap). If the service
 * refuses the address, the browser subscription is dropped too, so the
 * toggle never shows on for alerts that can't arrive. */
export async function enablePush(room: ChatRoomId, publicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushBlocked();
  const registration = await navigator.serviceWorker.register("/inbox-sw.js", {
    scope: scopeFor(room),
  });
  const key = applicationServerKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with another key can't receive these pushes.
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  try {
    await register(room, subscription);
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

const register = (room: ChatRoomId, subscription: PushSubscription) =>
  communityFetch(roomPath(room, "conversations/push"), {
    action: "subscribe",
    endpoint: subscription.endpoint,
  });

/** Turns push alerts off for this workspace in this browser. The browser
 * subscription goes even when the service can't be told (signed out,
 * removed, offline): the service drops the address at its next push. */
export async function disablePush(room: ChatRoomId) {
  const registration = await navigator.serviceWorker.getRegistration(
    scopeFor(room),
  );
  const subscription = await registration?.pushManager.getSubscription();
  // Only this browser's address: other browsers keep their alerts.
  if (!subscription) return;
  try {
    await communityFetch(roomPath(room, "conversations/push"), {
      action: "unsubscribe",
      endpoint: subscription.endpoint,
    });
  } catch {
    // The device still stops: its address is gone at the push service.
  }
  await subscription.unsubscribe();
}

/** Whether alerts are on for this workspace in this browser, checked with
 * the service: a browser subscription made with the current key is sent
 * again (the route keeps one entry per address), so an address the service
 * dropped (another browser replaced it, access lapsed, a failed save) is
 * registered again or shown as off. */
export async function syncPush(room: ChatRoomId, publicKey: string) {
  const registration = await navigator.serviceWorker?.getRegistration(
    scopeFor(room),
  );
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  if (!sameKey(subscription, applicationServerKey(publicKey))) {
    await subscription.unsubscribe().catch(() => false);
    return false;
  }
  try {
    await register(room, subscription);
    return true;
  } catch {
    return false;
  }
}
