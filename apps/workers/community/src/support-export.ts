import { featureOn } from "./workspace-flags";
import {
  hideAmbiguousPayload,
  sharedTransactionHashes,
} from "./support-secret-sinks";
import {
  SUPPORT_IDENTITY_LABELS,
  threadIdentity,
  type SupportIdentity,
} from "@templ/chat/support-identity";
import type { ChatMessage } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportNote } from "@templ/chat/support";
import type { ProductChargeView } from "@templ/chat/product-catalog";
import type { ProductUsageRow } from "@templ/chat/usage-billing";
import { usageCaseRows } from "./product-usage-billing";
import { chargeRef, threadCharges } from "./product-charges";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { HttpError, json } from "./common";
import { admitExport, exportPolicy } from "./export";
import { renderMessages, type StoredMessage } from "./message-store";
import { actsAs } from "./service-principals";
import { supportRecord, type SupportRecord } from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

/** R3-WORKSPACE-EXPORT. The current manager downloads every chat in the
 * workspace as JSONL pages. Every page checks that the caller is still the
 * manager and runs each thread through the conversation read predicate
 * again. Internal notes are included only when the manager ticks the box at
 * the start. The start and the finish go to the access log, never any text.
 * Staff, AI agents and members get no workspace export; staff keep the
 * per-thread export. */
export const WORKSPACE_EXPORT_PATH = "/conversations/workspace-export";
export const WORKSPACE_EXPORT_LIMITS = Object.freeze({
  startsPerDay: FEATURE_LIMITS.workspaceExportStartsPerDay,
  threadsPerPage: FEATURE_LIMITS.workspaceExportThreadsPerPage,
  messagesPerPage: FEATURE_LIMITS.workspaceExportMessagesPerPage,
  notesPerPage: FEATURE_LIMITS.workspaceExportNotesPerPage,
  cursorHours: FEATURE_LIMITS.workspaceExportCursorHours,
});
/** What the header names as left out. */
export const WORKSPACE_EXPORT_EXCLUDED = [
  "ai-drafts",
  "provenance",
  "evidence",
  "case-frames",
  "eval-copies",
  "attachment-files",
] as const;

const H = 3_600_000;
const STARTS_PREFIX = "workspace-export-starts-v1:";
const RECORD_PREFIX = "workspace-export-v1:";
const KEY = "workspace-export-key-v1";
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Storage = DurableObjectTransaction;
type ExportRecord = {
  actor: ChatPrincipalId;
  notes: boolean;
  asOf: number;
  done: boolean;
};
export type ExportCursor = {
  v: 1;
  exportId: string;
  actor: ChatPrincipalId;
  notes: boolean;
  asOf: number;
  expires: number;
  /** The thread being paged (its header already sent), or null. */
  thread: string | null;
  /** The last thread finished; listing resumes after it. */
  after: string | null;
  part: "messages" | "notes";
  /** A message id (newest first) or a note key suffix (oldest first). */
  before: string | null;
  counts: { threads: number; messages: number; notes: number; skipped: number };
};
export type WorkspaceExportThread = {
  identity: SupportIdentity;
  identityLabel: string;
  id: string;
  member: ChatPrincipalId;
  formerMembers: ChatPrincipalId[];
  linkedConversations: string[];
  initiator: TeamConversationRecord["initiator"];
  createdAt: string;
  state: "open" | "resolved";
  resolvedBy: { principalId: ChatPrincipalId; kind: string; at: string } | null;
  lastMessageAt: string | null;
  handoff: { reason: string } | null;
  assignment: { principalId: ChatPrincipalId; claimedAt: string } | null;
  tags: string[];
  category: string | null;
  attachments: {
    id: string;
    contentType: string;
    bytes: number;
    createdAt: string;
  }[];
  wallet?: { network?: string; address: string };
  claimedWallet?: unknown;
};
export type WorkspaceExportRow =
  | { type: "thread"; thread: WorkspaceExportThread }
  | { type: "message"; thread: string; message: ChatMessage }
  | { type: "note"; thread: string; note: SupportNote }
  | { type: "charge"; thread: string; charge: ProductChargeView }
  | { type: "usage-charge"; thread: string; charge: ProductUsageRow };

const iso = (value: number) => new Date(value).toISOString();
const day = (value: number) => iso(value).slice(0, 10);
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64 = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );

/** One view with an explicit key list: ids, times, states and attachment
 * facts. No text, no drafts, evidence or case frames, no file bytes. */
export function exportThreadView(
  record: TeamConversationRecord,
  workflow: SupportRecord,
): WorkspaceExportThread {
  return {
    identity: threadIdentity(workflow),
    identityLabel: SUPPORT_IDENTITY_LABELS[threadIdentity(workflow)],
    id: record.id,
    member: record.member,
    formerMembers: record.formerMembers ?? [],
    linkedConversations: record.linkedConversations ?? [],
    initiator: record.initiator,
    createdAt: iso(record.createdAt),
    state: record.state,
    resolvedBy: record.resolvedBy
      ? {
          principalId: record.resolvedBy.principalId,
          kind: record.resolvedBy.kind,
          at: iso(record.resolvedBy.at),
        }
      : null,
    lastMessageAt:
      record.lastMessageAt === null ? null : iso(record.lastMessageAt),
    handoff: record.handoff ? { reason: record.handoff.reason } : null,
    assignment: record.assignment
      ? {
          principalId: record.assignment.principalId,
          claimedAt: iso(record.assignment.claimedAt),
        }
      : null,
    tags: [...workflow.tags],
    category: workflow.category,
    attachments: workflow.attachments.map((attachment) => ({
      id: attachment.id,
      contentType: attachment.contentType,
      bytes: attachment.bytes,
      createdAt: attachment.at,
    })),
    ...(workflow.wallet
      ? {
          wallet: {
            ...(workflow.wallet.network
              ? { network: workflow.wallet.network }
              : {}),
            address: workflow.wallet.address,
          },
        }
      : {}),
    ...(workflow.access?.claimedWallet
      ? { claimedWallet: workflow.access.claimedWallet }
      : {}),
  };
}

async function signingKey(storage: Storage, room: string) {
  let secret = await storage.get<string>(KEY);
  if (!secret) {
    secret = base64(crypto.getRandomValues(new Uint8Array(32)));
    await storage.put(KEY, secret);
  }
  // Its own label: a search cursor never verifies as an export cursor.
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`workspace-export:${room}:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function signCursor(
  storage: Storage,
  room: string,
  cursor: ExportCursor,
) {
  const payload = encoder.encode(JSON.stringify(cursor));
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", await signingKey(storage, room), payload),
  );
  return `we1.${base64(payload)}.${base64(mac)}`;
}
const invalidCursor = () =>
  new HttpError(400, "This export link is invalid. Start a new export.");
function checkedCursor(value: unknown): value is ExportCursor {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const count = (entry: unknown) =>
    Number.isSafeInteger(entry) && (entry as number) >= 0;
  const counts = row.counts as Record<string, unknown> | undefined;
  return (
    row.v === 1 &&
    typeof row.exportId === "string" &&
    UUIDV7.test(row.exportId) &&
    typeof row.actor === "string" &&
    typeof row.notes === "boolean" &&
    Number.isSafeInteger(row.asOf) &&
    Number.isSafeInteger(row.expires) &&
    (row.thread === null ||
      (typeof row.thread === "string" &&
        /^tc-[0-9a-f]{32}$/.test(row.thread))) &&
    (row.after === null ||
      (typeof row.after === "string" && /^tc-[0-9a-f]{32}$/.test(row.after))) &&
    (row.part === "messages" || row.part === "notes") &&
    (row.before === null ||
      (typeof row.before === "string" && /^[0-9]{1,16}$/.test(row.before))) &&
    !!counts &&
    count(counts.threads) &&
    count(counts.messages) &&
    count(counts.notes) &&
    count(counts.skipped)
  );
}
async function readCursor(storage: Storage, room: string, token: string) {
  if (token.length > 4_000) throw invalidCursor();
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "we1") throw invalidCursor();
  let payload: Uint8Array;
  let mac: Uint8Array;
  try {
    payload = fromBase64(parts[1]);
    mac = fromBase64(parts[2]);
  } catch {
    throw invalidCursor();
  }
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await signingKey(storage, room),
      mac,
      payload,
    ))
  )
    throw invalidCursor();
  let cursor: unknown;
  try {
    cursor = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw invalidCursor();
  }
  if (!checkedCursor(cursor)) throw invalidCursor();
  return cursor;
}

const notFound = () => new HttpError(404, "Case not found.");
const expired = () =>
  new HttpError(
    410,
    "This export expired. Start a new one.",
    undefined,
    "export-expired",
  );

/** Manager check against the room's current record, in this transaction.
 * Anyone off the team (or signed out, or through the widget) gets the same
 * not-found as a hidden thread. */
function requireManager(context: ConversationContext) {
  const viewer = context.viewer;
  const team =
    viewer.isManager ||
    viewer.permissions.includes("handleConversations") ||
    viewer.permissions.includes("manageSupport");
  if (!viewer.principalId || !team) throw notFound();
  if (!viewer.isManager)
    throw new HttpError(
      403,
      "Only the manager can export every chat.",
      undefined,
      "manager-only",
    );
  return viewer.principalId;
}
function requireEnabled(context: ConversationContext) {
  if (!featureOn(context.mediaEnv, undefined, "workspaceExport"))
    throw new HttpError(
      503,
      "Workspace export isn't available yet.",
      undefined,
      "export-unavailable",
    );
}

/** `POST` and `GET /conversations/workspace-export`. Null for other paths. */
export async function workspaceExportRoute(
  storage: Storage,
  context: ConversationContext,
  deps: { canRead: (id: string) => Promise<boolean> },
): Promise<Response | null> {
  if (context.pathname !== WORKSPACE_EXPORT_PATH) return null;
  if (context.method === "POST") return startExport(storage, context);
  if (context.method === "GET") return exportPage(storage, context, deps);
  throw notFound();
}

async function startExport(storage: Storage, context: ConversationContext) {
  const actor = requireManager(context);
  requireEnabled(context);
  const body = context.body;
  if (
    Object.keys(body).some(
      (key) => !["notes", "expectedPrincipalId"].includes(key),
    ) ||
    typeof body.notes !== "boolean"
  )
    throw new HttpError(400, "Choose whether to include internal notes.");
  const now = context.now;
  const today = `${STARTS_PREFIX}${day(now)}`;
  const started = (await storage.get<number>(today)) ?? 0;
  if (started >= WORKSPACE_EXPORT_LIMITS.startsPerDay) {
    const midnight = Date.parse(`${day(now)}T00:00:00.000Z`) + 24 * H;
    throw new HttpError(
      429,
      `You can start ${WORKSPACE_EXPORT_LIMITS.startsPerDay} workspace exports a day. Try again tomorrow.`,
      Math.max(1, Math.ceil((midnight - now) / 1000)),
      "export-daily-limit",
    );
  }
  await storage.put(today, started + 1);
  const yesterday = `${STARTS_PREFIX}${day(now - 24 * H)}`;
  await storage.delete(yesterday);
  await admitExport(storage, actor, now, context.aliases);
  // Records older than 48 hours go, at most 10 per start.
  for (const [key, record] of await storage.list<ExportRecord>({
    prefix: RECORD_PREFIX,
    limit: 50,
  }))
    if (record.asOf < now - 48 * H) await storage.delete(key);
  const exportId = uuidv7(now);
  const notes = body.notes;
  await storage.put(`${RECORD_PREFIX}${exportId}`, {
    actor,
    notes,
    asOf: now,
    done: false,
  } satisfies ExportRecord);
  context.pendingAudit.push({
    actor,
    action: "workspace.export",
    target: null,
    after: { op: "start", exportId, notes, asOf: iso(now) },
  });
  const cursor = await signCursor(storage, context.room, {
    v: 1,
    exportId,
    actor,
    notes,
    asOf: now,
    expires: now + WORKSPACE_EXPORT_LIMITS.cursorHours * H,
    thread: null,
    after: null,
    part: "messages",
    before: null,
    counts: { threads: 0, messages: 0, notes: 0, skipped: 0 },
  });
  return json({ exportId, asOf: iso(now), internalNotes: notes, cursor });
}

async function exportPage(
  storage: Storage,
  context: ConversationContext,
  deps: { canRead: (id: string) => Promise<boolean> },
) {
  const actor = requireManager(context);
  requireEnabled(context);
  const token = context.query.get("cursor");
  if (!token) throw invalidCursor();
  const cursor = await readCursor(storage, context.room, token);
  // The cursor belongs to the person who started it, while they manage.
  if (!actsAs(context.aliases, cursor.actor)) throw notFound();
  const now = context.now;
  if (cursor.expires <= now) throw expired();
  const record = await storage.get<ExportRecord>(
    `${RECORD_PREFIX}${cursor.exportId}`,
  );
  if (!record || record.actor !== cursor.actor || record.notes !== cursor.notes)
    throw expired();
  const policy = await admitExport(storage, actor, now, context.aliases);
  const rows: WorkspaceExportRow[] = [];
  const next: ExportCursor = {
    ...cursor,
    counts: { ...cursor.counts },
  };
  let threads = 0;
  let messages = 0;
  let notes = 0;
  let finished = false;
  const aliases = context.aliases;
  const readable = async (id: string) => {
    const thread = await storage.get<TeamConversationRecord>(
      `conversation-v1:${id}`,
    );
    return thread && !thread.deleting && (await deps.canRead(id))
      ? thread
      : null;
  };
  for (;;) {
    if (next.thread === null) {
      if (threads >= WORKSPACE_EXPORT_LIMITS.threadsPerPage) break;
      const listed = await storage.list<TeamConversationRecord>({
        prefix: "conversation-v1:",
        limit: 20,
        ...(next.after ? { startAfter: `conversation-v1:${next.after}` } : {}),
      });
      let found: TeamConversationRecord | null = null;
      for (const thread of listed.values()) {
        next.after = thread.id;
        // A snapshot: threads opened after the start are left out.
        if (thread.createdAt > cursor.asOf) continue;
        if (thread.deleting || !(await deps.canRead(thread.id))) {
          next.counts.skipped++;
          continue;
        }
        found = thread;
        break;
      }
      if (!found) {
        if (listed.size < 20) {
          finished = true;
          break;
        }
        continue;
      }
      rows.push({
        type: "thread",
        thread: exportThreadView(found, await supportRecord(storage, found)),
      });
      // The thread's charges with their history: times, states and prices,
      // never text. The manager manages billing and reads every thread.
      for (const charge of await threadCharges(storage, found.id))
        rows.push({ type: "charge", thread: found.id, charge });
      for (const [key] of await storage.list({
        prefix: `support-case-v1:${found.id}:`,
      })) {
        const ref = await chargeRef(storage, found.id, Number(key.slice(-8)));
        for (const charge of await usageCaseRows(storage, ref))
          rows.push({ type: "usage-charge", thread: found.id, charge });
      }
      threads++;
      next.counts.threads++;
      next.thread = found.id;
      next.part = "messages";
      next.before = null;
      continue;
    }
    const thread = next.thread;
    // Deleted or hidden since the last page: the rest of it is skipped.
    if (!(await readable(thread))) {
      next.counts.skipped++;
      next.thread = null;
      next.before = null;
      next.part = "messages";
      continue;
    }
    if (next.part === "messages") {
      if (messages >= WORKSPACE_EXPORT_LIMITS.messagesPerPage) break;
      const room = WORKSPACE_EXPORT_LIMITS.messagesPerPage - messages;
      const listed = await storage.list<StoredMessage>({
        prefix: `channel-message:${thread}:`,
        reverse: true,
        limit: room + 1,
        ...(next.before
          ? {
              end: `channel-message:${thread}:${next.before.padStart(16, "0")}`,
            }
          : {}),
      });
      const page = [...listed.values()].slice(0, room);
      const more = listed.size > room;
      const kept = page.filter(
        (row) => Date.parse(row.createdAt) <= cursor.asOf,
      );
      for (const message of await renderMessages(storage, thread, kept, {
        aliases,
      }))
        rows.push({ type: "message", thread, message });
      messages += page.length;
      next.counts.messages += kept.length;
      if (more) {
        next.before = String(Number(page.at(-1)!.id));
        continue;
      }
      next.before = null;
      if (cursor.notes) {
        next.part = "notes";
        continue;
      }
    } else {
      if (notes >= WORKSPACE_EXPORT_LIMITS.notesPerPage) break;
      const room = WORKSPACE_EXPORT_LIMITS.notesPerPage - notes;
      const listed = await storage.list<SupportNote>({
        prefix: `support-note-v1:${thread}:`,
        limit: room + 1,
        ...(next.before
          ? { startAfter: `support-note-v1:${thread}:${next.before}` }
          : {}),
      });
      const entries = [...listed].slice(0, room);
      for (const [, note] of entries)
        if (Date.parse(note.at) <= cursor.asOf) {
          rows.push({ type: "note", thread, note });
          next.counts.notes++;
        }
      notes += entries.length;
      if (listed.size > room) {
        next.before = entries
          .at(-1)![0]
          .slice(`support-note-v1:${thread}:`.length);
        continue;
      }
      next.before = null;
    }
    // This thread is done.
    next.after = thread;
    next.thread = null;
    next.part = "messages";
  }
  if (finished && !record.done) {
    await storage.put(`${RECORD_PREFIX}${cursor.exportId}`, {
      ...record,
      done: true,
    } satisfies ExportRecord);
    context.pendingAudit.push({
      actor,
      action: "workspace.export",
      target: null,
      after: {
        op: "done",
        exportId: cursor.exportId,
        ...next.counts,
      },
    });
  }
  return json({
    rows: await Promise.all(
      rows.map(async (row) =>
        hideAmbiguousPayload(
          row,
          "thread" in row && typeof row.thread === "string"
            ? await sharedTransactionHashes(storage, row.thread)
            : [],
        ),
      ),
    ),
    nextCursor: finished ? null : await signCursor(storage, context.room, next),
    export: {
      schemaVersion: 1,
      scope: "workspace",
      exportId: cursor.exportId,
      asOf: iso(cursor.asOf),
      internalNotes: cursor.notes,
      counts: next.counts,
      excluded: WORKSPACE_EXPORT_EXCLUDED,
      pageSize: exportPolicy().pageSize,
      nextRequestAfterMs: policy.nextRequestAfterMs,
    },
  });
}

function uuidv7(now: number) {
  const time = now.toString(16).padStart(12, "0");
  const random = crypto.randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}
