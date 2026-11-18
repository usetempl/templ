import {
  SUPPORT_IDENTITY_LABELS,
  identityOf,
} from "@templ/chat/support-identity";
import type {
  ChatMessage,
  ChatRoomId,
  TeamConversation,
} from "@templ/chat/index";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "./community-client";

/** One page of `GET /rooms/:id/conversations/:tc/export`. The worker checks
 * current access on every page and never includes internal notes. */
export type ConversationExportPage = {
  conversation: TeamConversation;
  messages: ChatMessage[];
  nextBefore: string | null;
  export: {
    schemaVersion: 1;
    pageSize: number;
    nextRequestAfterMs: number;
    scope: "conversation";
  };
};
export type ConversationExportStop =
  | "cancelled"
  | "access-ended"
  | "rate-limited"
  | "failed";
export type ConversationExport = {
  /** JSONL: a header line, the conversation, then messages oldest first. */
  text: string;
  filename: string;
  messages: number;
  /** True when the download stopped before the oldest message. */
  partial: boolean;
  reason: ConversationExportStop | null;
};

const CONVERSATION = /^tc-[0-9a-f]{32}$/;
/** The worker asks for one export page a second; a Retry-After longer than
 * this ends the download instead of leaving it waiting. */
export const EXPORT_LIMITS = {
  defaultSpacingMs: 1_000,
  maxRetryWaitMs: 60_000,
  retriesPerPage: 3,
} as const;

function abortError() {
  return new DOMException("Download canceled.", "AbortError");
}
export function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
const aborted = (reason: unknown, signal?: AbortSignal) =>
  signal?.aborted === true ||
  (reason instanceof DOMException && reason.name === "AbortError");

function stopReason(reason: unknown): ConversationExportStop {
  if (reason instanceof CommunityApiError) {
    if ([401, 403, 404].includes(reason.status)) return "access-ended";
    if (reason.status === 429) return "rate-limited";
  }
  return "failed";
}

function validPage(
  page: ConversationExportPage,
  id: string,
  before: string | null,
): boolean {
  if (
    page.conversation?.id !== id ||
    !Array.isArray(page.messages) ||
    (page.nextBefore !== null && typeof page.nextBefore !== "string")
  )
    return false;
  let previous = 0;
  for (const message of page.messages) {
    const value = Number(message?.id);
    if (!Number.isSafeInteger(value) || value <= previous) return false;
    if (before !== null && value >= Number(before)) return false;
    previous = value;
  }
  return (
    page.nextBefore === null ||
    (page.messages.length > 0 && page.nextBefore === page.messages[0].id)
  );
}

/** Pages through one conversation's export, newest page first, waiting the
 * spacing the worker asks for and any Retry-After it sends. A refusal or a
 * cancel after the first page keeps what arrived and marks the file partial;
 * a refusal of the first page throws, so no empty file is offered. */
export async function exportConversation(input: {
  room: ChatRoomId;
  conversationId: string;
  signal?: AbortSignal;
  onProgress?: (messages: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}): Promise<ConversationExport> {
  const { room, conversationId: id, signal } = input;
  if (!CONVERSATION.test(id)) throw new Error("Invalid case.");
  const sleep = input.sleep ?? waitFor;
  const pages: ChatMessage[][] = [];
  let conversation: TeamConversation | null = null;
  let before: string | null = null;
  let spacing = 0;
  let count = 0;
  let reason: ConversationExportStop | null = null;
  for (;;) {
    let page: ConversationExportPage | null = null;
    try {
      if (spacing) await sleep(spacing, signal);
      for (let attempt = 0; ; attempt += 1) {
        signal?.throwIfAborted();
        try {
          page = await communityFetch<ConversationExportPage>(
            roomPath(
              room,
              `conversations/${id}/export${before ? `?before=${encodeURIComponent(before)}` : ""}`,
            ),
            undefined,
            signal,
          );
          break;
        } catch (failure) {
          const wait =
            failure instanceof CommunityApiError && failure.status === 429
              ? (failure.retryAfterSeconds ?? 1) * 1000
              : null;
          if (
            wait === null ||
            wait > EXPORT_LIMITS.maxRetryWaitMs ||
            attempt >= EXPORT_LIMITS.retriesPerPage
          )
            throw failure;
          await sleep(wait, signal);
        }
      }
    } catch (failure) {
      if (aborted(failure, signal)) reason = "cancelled";
      else if (!pages.length) throw failure;
      else reason = stopReason(failure);
      break;
    }
    if (!page || !validPage(page, id, before)) {
      if (!pages.length)
        throw new Error("The chat service sent an unexpected page.");
      reason = "failed";
      break;
    }
    conversation ??= page.conversation;
    pages.push(page.messages);
    count += page.messages.length;
    input.onProgress?.(count);
    before = page.nextBefore;
    if (before === null) break;
    spacing =
      Number.isSafeInteger(page.export?.nextRequestAfterMs) &&
      page.export.nextRequestAfterMs > 0
        ? Math.min(page.export.nextRequestAfterMs, EXPORT_LIMITS.maxRetryWaitMs)
        : EXPORT_LIMITS.defaultSpacingMs;
  }
  if (!conversation) throw abortError();
  const exportedAt = (input.now?.() ?? new Date()).toISOString();
  const messages = pages.reverse().flat();
  const partial = reason !== null;
  const lines = [
    {
      type: "export",
      schemaVersion: 1,
      scope: "conversation",
      room,
      conversationId: id,
      viewer: conversation.viewer,
      exportedAt,
      messages: messages.length,
      partial,
      ...(reason ? { stoppedBecause: reason } : {}),
      internalNotes: false,
    },
    {
      type: "conversation",
      conversation,
      ...(conversation.viewer === "team"
        ? {
            identity:
              conversation.support?.identity ??
              identityOf({
                level: conversation.support?.access ?? "anonymous",
              }),
            identityLabel:
              SUPPORT_IDENTITY_LABELS[
                conversation.support?.identity ??
                  identityOf({
                    level: conversation.support?.access ?? "anonymous",
                  })
              ],
          }
        : {}),
    },
    ...messages.map((message) => ({ type: "message", message })),
  ];
  return {
    text: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    filename: `chat-${id.slice(3, 11)}-${exportedAt.slice(0, 10)}${partial ? "-partial" : ""}.jsonl`,
    messages: messages.length,
    partial,
    reason,
  };
}

/** Hands the file to the browser. The caller decides when; nothing saves on
 * its own. */
export function saveConversationExport(result: ConversationExport) {
  const url = URL.createObjectURL(
    new Blob([result.text], { type: "application/x-ndjson" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
