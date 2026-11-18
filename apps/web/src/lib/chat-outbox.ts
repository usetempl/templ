"use client";

import { useEffect, useSyncExternalStore } from "react";
import { OPERATIONAL_LIMITS } from "@templ/chat/plans";
import { detectSecret, screenTeamText } from "@templ/chat/support-safety";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatMessage } from "@templ/chat/index";
import { chatMutation } from "./chat-api";
import { CommunityApiError, roomPath } from "./community-client";
import { communityCacheScope } from "./community-room-cache";
import {
  readPendingSupportReplies,
  readSupportDraft,
  writePendingSupportReply,
  writeSupportDraft,
  removePendingSupportReply,
} from "./support-local-state";
import {
  communitySessionRevision,
  invalidateCommunitySession,
  peekCommunitySession,
  subscribeCommunitySession,
} from "./community-auth";
import { takeDraftUse } from "./draft-link";

export type OutboxMessage = ChatMessage & {
  replyIntent?: "answer" | "update";
  clientId: string;
  delivery: "queued" | "sending" | "sent" | "failed";
  error?: string;
  retryable?: boolean;
  refusalReason?: "unsafe-ask";
  /** Epoch ms for a paced send or a brief service retry. */
  retryAt?: number;
};
/** The message a draft answers. Author and preview are a local
 * snapshot for the composer chip; the server renders the real reference. */
export type ReplyTarget = { id: string; author: string; preview: string };
type Entry = {
  key: string;
  templ: ChatRoomId;
  conversation: string;
  account: ChatPrincipalId;
  revision: number;
  confirmedAt?: number;
  /** The AI draft this reply was sent from ("Use draft"); memory only. */
  fromDraft?: string;
  wake?: () => void;
  message: OutboxMessage;
};
const entries = new Map<string, Entry>();
const drafts = new Map<string, string>();
const replyTargets = new Map<string, ReplyTarget>();
/** A refusal that removed a message, shown once beside that case's
 * composer until it is dismissed or the next message is sent. */
const notices = new Map<string, string>();
const queues = new Map<string, Promise<void>>();
const SEND_DEADLINE_MS = 20_000;
const QUEUE_LIMIT = 20;
const MAX_QUEUE_WAIT_MS = 15 * 60_000;
const TRANSIENT_503_RETRY_DELAYS_MS = [1500, 3000] as const;
const nextSendAt = new Map<string, number>();
const accountQueueKey = (entry: Entry) =>
  `${entry.account.toLowerCase()}:${entry.revision}`;
const listeners = new Set<() => void>();
let version = 0;
let wallet: string | undefined;
const publish = () => {
  version++;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => version;
const keyFor = (
  templ: ChatRoomId,
  conversation: string,
  account?: ChatPrincipalId,
) =>
  `${communityCacheScope(templ)}:${account?.toLowerCase() ?? "guest"}:${communitySessionRevision()}:${conversation}`;

/** Sign-out discards in-memory sends; support retry records also clear through the session-scoped local store. */
export function clearChatOutbox() {
  for (const entry of entries.values()) entry.wake?.();
  entries.clear();
  drafts.clear();
  replyTargets.clear();
  notices.clear();
  queues.clear();
  nextSendAt.clear();
  publish();
}
subscribeCommunitySession(clearChatOutbox);

/** UUIDv7 lets the server expire deduplication tombstones without accepting old retries. */
export function newChatMessageId(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 255n);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function persistSupportReply(entry: Entry) {
  if (entry.message.delivery === "sent") {
    removePendingSupportReply(
      entry.templ,
      entry.account,
      entry.conversation,
      entry.message.clientId,
    );
  } else {
    writePendingSupportReply(entry.templ, entry.account, entry.conversation, {
      clientId: entry.message.clientId,
      text: entry.message.text,
      createdAt: entry.message.createdAt,
      ...(entry.message.replyTo ? { replyTo: entry.message.replyTo } : {}),
      ...(entry.message.replyIntent
        ? { replyIntent: entry.message.replyIntent }
        : {}),
      ...(entry.message.retryable !== undefined
        ? { retryable: entry.message.retryable }
        : {}),
      ...(entry.message.error ? { error: entry.message.error } : {}),
      ...(entry.message.refusalReason
        ? { refusalReason: entry.message.refusalReason }
        : {}),
    });
  }
}
/** A successful ticket read may restore pending support replies. Reload never
 * resends them automatically; explicit retry keeps the original deduplication ID. */
export function restoreConversationOutbox(
  templ: ChatRoomId,
  conversation: string,
  account?: ChatPrincipalId,
) {
  if (!account || !peekCommunitySession(account)) return;
  let changed = false;
  for (const pending of readPendingSupportReplies(
    templ,
    account,
    conversation,
  )) {
    if (entries.has(pending.clientId) || entries.size >= 100) continue;
    entries.set(pending.clientId, {
      key: keyFor(templ, conversation, account),
      templ,
      conversation,
      account,
      revision: communitySessionRevision(),
      message: {
        ...pending,
        id: pending.clientId,
        author: account,
        delivery: "failed",
        error: pending.error ?? "Reply not confirmed. Retry to check delivery.",
        retryable: pending.retryable !== false,
      },
    });
    changed = true;
  }
  if (changed) publish();
}
/** Access loss cancels even in-flight support sends. Their late responses
 * cannot restore private text because stillCurrent requires the same entry. */
export function discardWorkspaceConversationOutbox(
  templ: ChatRoomId,
  account?: ChatPrincipalId,
) {
  discardSupportOutbox(templ, account);
}
/** A deleted case ends only that case's pending sends. */
export function discardConversationOutbox(
  templ: ChatRoomId,
  conversation: string,
  account?: ChatPrincipalId,
) {
  discardSupportOutbox(templ, account, conversation);
}
function discardSupportOutbox(
  templ: ChatRoomId,
  account?: ChatPrincipalId,
  conversation?: string,
) {
  let changed = false;
  for (const [id, entry] of entries) {
    if (
      entry.templ !== templ ||
      entry.account !== account ||
      (conversation !== undefined && entry.conversation !== conversation)
    )
      continue;
    entries.delete(id);
    entry.wake?.();
    removePendingSupportReply(templ, entry.account, entry.conversation, id);
    changed = true;
  }
  if (changed) publish();
}
/** The service refused the text as a wallet recovery phrase and stored
 * nothing. No copy of it stays on this device: the pending entry, its saved
 * retry record and a composer draft holding the same text all go. */
function discardRefusedSecret(entry: Entry, message: string) {
  entries.delete(entry.message.clientId);
  entry.wake?.();
  drafts.delete(entry.key);
  removePendingSupportReply(
    entry.templ,
    entry.account,
    entry.conversation,
    entry.message.clientId,
  );
  const draft = readSupportDraft(
    entry.templ,
    entry.account,
    entry.conversation,
    "reply",
  );
  const text = entry.message.text.trim();
  if (draft && (draft.text.trim() === text || draft.attempt?.text === text))
    writeSupportDraft(entry.templ, entry.account, entry.conversation, "reply", {
      text: "",
    });
  notices.set(entry.key, message);
}
function stillCurrent(entry: Entry) {
  return (
    entries.get(entry.message.clientId) === entry &&
    communitySessionRevision() === entry.revision &&
    Boolean(peekCommunitySession(entry.account))
  );
}
/** A service 503 gets two short retries with the same message ID. Storage
 * capacity and network errors stay visible for review. */
function automaticRetryDelay(
  reason: unknown,
  transient503Retries: number,
): number | undefined {
  if (!(reason instanceof CommunityApiError)) return;
  const details = reason.details as { reason?: string } | undefined;
  if (reason.status === 503) {
    const delay = TRANSIENT_503_RETRY_DELAYS_MS[transient503Retries];
    if (details?.reason === "provider-capacity" || delay === undefined) return;
    return Math.max(delay, (reason.retryAfterSeconds ?? 0) * 1000);
  }
  if (reason.status !== 429 || !reason.retryAfterSeconds) return;
  if (
    details?.reason === "account-message-pace" ||
    /^Slow mode is on\b/.test(reason.message)
  )
    return reason.retryAfterSeconds * 1000;
}
async function waitUntil(entry: Entry, until: number) {
  if (until <= Date.now() || !stillCurrent(entry)) return;
  entry.message = { ...entry.message, delivery: "queued", retryAt: until };
  publish();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, until - Date.now());
    function done() {
      clearTimeout(timer);
      if (entry.wake === done) entry.wake = undefined;
      resolve();
    }
    entry.wake = done;
  });
}
function dispatch(entry: Entry) {
  const queueKey = accountQueueKey(entry);
  const before = queues.get(queueKey) ?? Promise.resolve();
  const task = before
    .catch(() => {})
    .then(async () => {
      const queuedAt = Date.now();
      let transient503Retries = 0;
      while (stillCurrent(entry)) {
        await waitUntil(
          entry,
          Math.max(nextSendAt.get(queueKey) ?? 0, entry.message.retryAt ?? 0),
        );
        if (!stillCurrent(entry)) return;
        entry.message = {
          ...entry.message,
          delivery: "sending",
          error: undefined,
          refusalReason: undefined,
          retryAt: undefined,
        };
        publish();
        let attemptActive = true;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let retry = false;
        try {
          const response = await Promise.race([
            chatMutation<{ message: ChatMessage }>(
              entry.account,
              roomPath(
                entry.templ,
                `conversations/${encodeURIComponent(entry.conversation)}/messages`,
              ),
              {
                text: entry.message.text,
                clientId: entry.message.clientId,
                ...(entry.message.replyTo
                  ? { replyTo: entry.message.replyTo }
                  : {}),
                ...(entry.message.replyIntent
                  ? { replyIntent: entry.message.replyIntent }
                  : {}),
                ...(entry.fromDraft ? { fromDraft: entry.fromDraft } : {}),
              },
              () => {
                if (!attemptActive) throw new Error("Send attempt expired.");
                if (!stillCurrent(entry))
                  throw new Error("Your sign-in changed.");
              },
            ),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => {
                attemptActive = false;
                reject(new Error("Delivery could not be confirmed."));
              }, SEND_DEADLINE_MS);
            }),
          ]);
          const accepted = response.message;
          if (
            !accepted ||
            accepted.clientId !== entry.message.clientId ||
            accepted.author.toLowerCase() !== entry.account.toLowerCase() ||
            accepted.text !== entry.message.text ||
            (accepted.replyTo ?? null) !== (entry.message.replyTo ?? null) ||
            !/^[1-9][0-9]*$/.test(accepted.id)
          )
            throw new Error("Delivery could not be confirmed.");
          if (communitySessionRevision() === entry.revision)
            nextSendAt.set(
              queueKey,
              Date.now() + OPERATIONAL_LIMITS.messageIntervalSeconds * 1000,
            );
          if (!stillCurrent(entry)) return;
          entry.message = {
            ...accepted,
            clientId: entry.message.clientId,
            delivery: "sent",
          };
          entry.confirmedAt = Date.now();
          persistSupportReply(entry);
          publish();
        } catch (reason) {
          if (!stillCurrent(entry)) return;
          if (reason instanceof CommunityApiError && reason.status === 401) {
            invalidateCommunitySession();
            return;
          }
          if (
            reason instanceof CommunityApiError &&
            reason.status === 422 &&
            (reason.details as { reason?: unknown } | undefined)?.reason ===
              "secret-refused"
          ) {
            discardRefusedSecret(entry, reason.message);
            publish();
            return;
          }
          const delay = automaticRetryDelay(reason, transient503Retries);
          retry =
            delay !== undefined &&
            Date.now() + delay - queuedAt <= MAX_QUEUE_WAIT_MS;
          const service503 =
            reason instanceof CommunityApiError && reason.status === 503;
          const retryAt =
            reason instanceof CommunityApiError &&
            reason.status === 429 &&
            reason.retryAfterSeconds
              ? Date.now() + reason.retryAfterSeconds * 1000
              : retry && service503 && delay !== undefined
                ? Date.now() + delay
                : undefined;
          if (retry && service503) transient503Retries++;
          if (retry && retryAt) nextSendAt.set(queueKey, retryAt);
          entry.message = {
            ...entry.message,
            delivery: retry ? "queued" : "failed",
            error:
              reason instanceof CommunityApiError
                ? reason.message
                : "Couldn’t confirm delivery.",
            retryable: !(
              reason instanceof CommunityApiError &&
              [400, 403, 404, 409, 410, 422].includes(reason.status)
            ),
            refusalReason:
              reason instanceof CommunityApiError &&
              (reason.details as { reason?: unknown } | undefined)?.reason ===
                "unsafe-ask"
                ? "unsafe-ask"
                : undefined,
            retryAt,
          };
          persistSupportReply(entry);
          publish();
        } finally {
          // Unknown outcomes keep their original ID for an explicit retry.
          attemptActive = false;
          clearTimeout(deadline);
        }
        if (!retry) return;
      }
    });
  queues.set(queueKey, task);
  void task.finally(() => {
    if (queues.get(queueKey) === task) queues.delete(queueKey);
  });
}

export function enqueueConversationMessage(
  templ: ChatRoomId,
  conversation: string,
  account: ChatPrincipalId,
  text: string,
  replyTo?: string,
  replyIntent?: "answer" | "update",
) {
  if (!/^tc-[a-f0-9]{32}$/.test(conversation)) throw new Error("Invalid case.");
  if (!peekCommunitySession(account)) throw new Error("Sign in to chat.");
  if (!text.trim()) throw new Error("Write a message.");
  if (
    entries.size >= 100 ||
    Array.from(entries.values()).filter(
      (entry) => entry.message.delivery !== "sent",
    ).length >= QUEUE_LIMIT
  )
    throw new Error("Let your pending messages finish before sending more.");
  const clientId = newChatMessageId();
  const key = keyFor(templ, conversation, account);
  const entry: Entry = {
    key,
    templ,
    conversation,
    account,
    revision: communitySessionRevision(),
    fromDraft: takeDraftUse(conversation),
    message: {
      id: clientId,
      clientId,
      text,
      author: account,
      createdAt: new Date().toISOString(),
      delivery: "queued",
      ...(replyTo ? { replyTo } : {}),
      ...(replyIntent ? { replyIntent } : {}),
    },
  };
  entries.set(clientId, entry);
  persistSupportReply(entry);
  drafts.delete(key);
  replyTargets.delete(key);
  notices.delete(key);
  publish();
  dispatch(entry);
  return clientId;
}
/** The permission comes from the current thread response. Retrying still
 * uses the normal authenticated write and its current server checks. */
export function canRetryChatMessage(
  message: OutboxMessage,
  canInstructWalletActions = false,
) {
  if (message.delivery !== "failed") return false;
  if (message.retryable) return true;
  // Older pending replies retained the service text without its reason code.
  const wordingRefusal =
    message.refusalReason === "unsafe-ask" ||
    (!message.refusalReason &&
      message.error ===
        "Templ blocks messages that ask the user to sign, approve or send anything. Sign-in happens only in the sign-in card.");
  return (
    canInstructWalletActions &&
    wordingRefusal &&
    detectSecret(message.text) === null &&
    screenTeamText(message.text, { allowWalletInstructions: true }) === null
  );
}
export function retryChatMessage(
  clientId: string,
  canInstructWalletActions = false,
) {
  const entry = entries.get(clientId);
  if (
    !entry ||
    !stillCurrent(entry) ||
    !canRetryChatMessage(entry.message, canInstructWalletActions)
  )
    return;
  entry.message = {
    ...entry.message,
    delivery: "queued",
    error: undefined,
  };
  publish();
  dispatch(entry);
}
export function forgetOutboxMessage(clientId: string) {
  const entry = entries.get(clientId);
  if (entry && ["failed", "queued"].includes(entry.message.delivery)) {
    entries.delete(clientId);
    removePendingSupportReply(
      entry.templ,
      entry.account,
      entry.conversation,
      clientId,
    );
    entry.wake?.();
    publish();
  }
}
export function reconcileChatOutbox(
  templ: ChatRoomId,
  conversation: string,
  account: ChatPrincipalId | undefined,
  messages: ChatMessage[],
  requestedAt: number,
) {
  const key = keyFor(templ, conversation, account);
  let changed = false;
  for (const message of messages) {
    const entry = message.clientId && entries.get(message.clientId);
    if (
      entry &&
      entry.key === key &&
      message.author.toLowerCase() === entry.account.toLowerCase() &&
      message.text === entry.message.text &&
      (message.replyTo ?? null) === (entry.message.replyTo ?? null)
    ) {
      entries.delete(message.clientId!);
      removePendingSupportReply(
        entry.templ,
        entry.account,
        entry.conversation,
        message.clientId!,
      );
      entry.wake?.();
      changed = true;
    }
  }
  // A read started after acknowledgment is authoritative even if a moderator
  // has since removed the accepted message. Never resurrect it from the outbox.
  for (const [id, entry] of entries) {
    if (
      entry.key === key &&
      entry.message.delivery === "sent" &&
      entry.confirmedAt !== undefined &&
      entry.confirmedAt < requestedAt
    ) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) publish();
}
export function useChatOutbox(
  templ: ChatRoomId,
  conversation: string,
  account?: ChatPrincipalId,
) {
  useSyncExternalStore(subscribe, snapshot, () => 0);
  const key = keyFor(templ, conversation, account);
  useEffect(() => {
    const next = account?.toLowerCase();
    if (wallet !== next) {
      wallet = next;
      clearChatOutbox();
    }
  }, [account]);
  return {
    messages:
      account && peekCommunitySession(account)
        ? Array.from(entries.values())
            .filter((entry) => entry.key === key)
            .map((entry) => entry.message)
        : [],
    draft: drafts.get(key) ?? "",
    setDraft: (text: string) => {
      if (text) {
        if (!drafts.has(key) && drafts.size >= 50)
          drafts.delete(drafts.keys().next().value!);
        drafts.set(key, text);
      } else drafts.delete(key);
      publish();
    },
    /** Why a message just left the list, when the service refused it. */
    notice:
      account && peekCommunitySession(account) ? (notices.get(key) ?? "") : "",
    dismissNotice: () => {
      if (notices.delete(key)) publish();
    },
    replyTarget: getReplyTarget(templ, conversation, account),
    setReplyTarget: (target: ReplyTarget | null) =>
      setReplyTarget(templ, conversation, account, target),
  };
}
/** Reply targets live beside drafts, per case, and are
 * discarded with them on sign-out. */
export function getReplyTarget(
  templ: ChatRoomId,
  conversation: string,
  account?: ChatPrincipalId,
): ReplyTarget | null {
  return replyTargets.get(keyFor(templ, conversation, account)) ?? null;
}
export function setReplyTarget(
  templ: ChatRoomId,
  conversation: string,
  account: ChatPrincipalId | undefined,
  target: ReplyTarget | null,
) {
  const key = keyFor(templ, conversation, account);
  if (target) {
    if (!replyTargets.has(key) && replyTargets.size >= 50)
      replyTargets.delete(replyTargets.keys().next().value!);
    replyTargets.set(key, target);
  } else replyTargets.delete(key);
  publish();
}
