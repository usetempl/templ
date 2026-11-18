import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ProductChargeView } from "@templ/chat/product-catalog";
import { chatMutation } from "./chat-api";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "./community-client";
import { EXPORT_LIMITS, waitFor } from "./conversation-export";

/** The manager's download of every chat, one JSONL
 * file. The worker checks the manager and each chat's access on every
 * page; notes come only when the start asked for them. */
export type WorkspaceExportStop =
  | "cancelled"
  | "access-ended"
  | "rate-limited"
  | "expired"
  | "failed";
export type WorkspaceExportResult = {
  text: string;
  filename: string;
  threads: number;
  messages: number;
  notes: number;
  partial: boolean;
  reason: WorkspaceExportStop | null;
};
type Row =
  | { type: "thread"; thread: { id: string } & Record<string, unknown> }
  | { type: "message"; thread: string; message: { id: string } }
  | { type: "note"; thread: string; note: { id: string; text: string } }
  | { type: "charge"; thread: string; charge: ProductChargeView };
type Page = {
  rows: Row[];
  nextCursor: string | null;
  export: {
    schemaVersion: 1;
    scope: "workspace";
    exportId: string;
    internalNotes: boolean;
    counts?: { skipped?: number };
    nextRequestAfterMs: number;
  };
};
type Start = {
  exportId: string;
  asOf: string;
  internalNotes: boolean;
  cursor: string;
};

const THREAD = /^tc-[0-9a-f]{32}$/;
export const WORKSPACE_EXPORT_EXCLUDED = [
  "ai-drafts",
  "provenance",
  "evidence",
  "case-frames",
  "eval-copies",
  "attachment-files",
] as const;

function stopReason(reason: unknown): WorkspaceExportStop {
  if (reason instanceof CommunityApiError) {
    if ([401, 403, 404].includes(reason.status)) return "access-ended";
    if (reason.status === 410) return "expired";
    if (reason.status === 429) return "rate-limited";
  }
  return "failed";
}
const aborted = (reason: unknown, signal?: AbortSignal) =>
  signal?.aborted === true ||
  (reason instanceof DOMException && reason.name === "AbortError");

/** Known row shapes only (threads, messages, charges and notes), message
 * ids newest first within a thread, and notes only when the start said so. */
function validPage(page: Page, notes: boolean, last: Map<string, number>) {
  if (
    !page ||
    !Array.isArray(page.rows) ||
    (page.nextCursor !== null && typeof page.nextCursor !== "string")
  )
    return false;
  for (const row of page.rows) {
    if (row?.type === "thread") {
      if (!THREAD.test(row.thread?.id)) return false;
      continue;
    }
    if (row?.type === "message") {
      if (!THREAD.test(row.thread)) return false;
      const id = Number(row.message?.id);
      if (!Number.isSafeInteger(id)) return false;
      const previous = last.get(row.thread);
      if (previous !== undefined && id >= previous) return false;
      last.set(row.thread, id);
      continue;
    }
    // A resolved case's charge: times, states and prices, never text.
    if (row?.type === "charge") {
      if (!THREAD.test(row.thread) || !/^[0-9a-f]{16}$/.test(row.charge?.ref))
        return false;
      continue;
    }
    if (row?.type === "note") {
      if (
        !notes ||
        !THREAD.test(row.thread) ||
        typeof row.note?.text !== "string"
      )
        return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Starts an export and pages it to the end, waiting the spacing the
 * worker asks for and any Retry-After up to a minute. A stop after the
 * first page keeps what arrived and marks the file partial; a refusal
 * before it throws, so no empty file is offered. */
export async function exportWorkspace(input: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  notes: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: { threads: number; messages: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}): Promise<WorkspaceExportResult> {
  const { room, signal } = input;
  const sleep = input.sleep ?? waitFor;
  const started = await chatMutation<Start>(
    input.account,
    roomPath(room, "conversations/workspace-export"),
    { notes: input.notes },
    undefined,
    signal,
  );
  const lines: string[] = [];
  const last = new Map<string, number>();
  let cursor: string | null = started.cursor;
  let spacing = 0;
  let threads = 0;
  let messages = 0;
  let notes = 0;
  let skipped = 0;
  let pages = 0;
  let reason: WorkspaceExportStop | null = null;
  while (cursor) {
    let page: Page | null = null;
    try {
      if (spacing) await sleep(spacing, signal);
      for (let attempt = 0; ; attempt += 1) {
        signal?.throwIfAborted();
        try {
          page = await communityFetch<Page>(
            roomPath(
              room,
              `conversations/workspace-export?cursor=${encodeURIComponent(cursor)}`,
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
      else if (!pages) throw failure;
      else reason = stopReason(failure);
      break;
    }
    if (!page || !validPage(page, started.internalNotes, last)) {
      if (!pages) throw new Error("The chat service sent an unexpected page.");
      reason = "failed";
      break;
    }
    pages++;
    for (const row of page.rows) {
      lines.push(JSON.stringify(row));
      if (row.type === "thread") threads++;
      else if (row.type === "message") messages++;
      else if (row.type === "note") notes++;
    }
    skipped = page.export?.counts?.skipped ?? skipped;
    input.onProgress?.({ threads, messages });
    cursor = page.nextCursor;
    spacing =
      Number.isSafeInteger(page.export?.nextRequestAfterMs) &&
      page.export.nextRequestAfterMs > 0
        ? Math.min(page.export.nextRequestAfterMs, EXPORT_LIMITS.maxRetryWaitMs)
        : EXPORT_LIMITS.defaultSpacingMs;
  }
  const exportedAt = (input.now?.() ?? new Date()).toISOString();
  const partial = reason !== null;
  const header = {
    type: "export",
    schemaVersion: 1,
    scope: "workspace",
    room,
    exportId: started.exportId,
    exportedAt,
    asOf: started.asOf,
    threads,
    messages,
    notes,
    skipped,
    internalNotes: started.internalNotes,
    partial,
    ...(reason ? { stoppedBecause: reason } : {}),
    order: "threads by id, messages newest first in each thread",
    excluded: WORKSPACE_EXPORT_EXCLUDED,
  };
  return {
    text: [JSON.stringify(header), ...lines].join("\n") + "\n",
    filename: `chats-${room.slice(5, 13)}-${exportedAt.slice(0, 10)}${partial ? "-partial" : ""}.jsonl`,
    threads,
    messages,
    notes,
    partial,
    reason,
  };
}
