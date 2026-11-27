import { featureOn, removeDeletedWorkspaceFlags } from "./workspace-flags";
import { prepareStorageDeletion } from "./brain-storage-billing";
import { STORAGE_DELETION_KEY } from "./brain-storage-keys";
import { knowledgeObjectName } from "./support-knowledge-client";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  config,
  HttpError,
  json,
  readJson,
  STORAGE_SCOPE_CHAIN_ID,
  type Env,
} from "./common";
import { appendAudit } from "./room-audit";
import { PERMISSION_REVISION_KEY } from "./room-events";
import { wakeRoomAt, type RoomAlarmContext } from "./room-alarm";
import {
  nativeRecord,
  nativeRoomId,
  NATIVE_CATALOG,
  type NativeRoomRecord,
} from "./native-rooms";
import { principal } from "./principal";
import { requireWalletAuth } from "./privileged-auth";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  actsAs,
  servicePrincipals,
  sessionPrincipals,
  type ServiceSession,
} from "./service-principals";
import {
  readRetentionHolds,
  requireSafetyAccess,
  type RetentionHolds,
  type SafetyEnv,
} from "./safety";
import {
  deletedWorkspaceStripe,
  queueDeletedWorkspaceStripe,
  type DeletedWorkspaceStripe,
} from "./stripe-deletion";
import { productReceipts } from "./product-billing";
import { PRODUCT_STATE_KEY } from "./product-entitlements";
import { STANDARD_DUE_PREFIX } from "./product-standard-plan";
// Pending and confirmed charges are dropped unbilled before the purge; the
// balance and the month totals of final charges go to the deletion record.
import {
  CHARGE_DUE_PREFIX,
  closeBillingForDeletion,
  type DeletedBilling,
} from "./product-charges";
import { supportStorage } from "./support-storage";
import {
  SUPPORT_RETENTION_PENDING_KEY,
  sweepSupportRetention,
} from "./support-retention";
import { saveRetentionRestorePoint } from "./support-retention-holds";
import { clearThreadAwaiting } from "./support-cases";
import { supportRecord } from "./support-workflow";
import type { TeamConversationRecord } from "./team-conversations";
import { deleteSupportAttachment, releaseMediaReference } from "./media";
import { recordPrivacyDeletion } from "./storage-recovery-store";

/** The manager deletes a workspace: access closes at
 * once for members, staff, AI agents and the widget; for 7 days the manager
 * can cancel; then a room alarm job deletes the workspace in bounded
 * batches. A legal hold keeps what it covers. Receipts, a who-and-when
 * record, the billing ledger and Safety records stay, and the id can never be
 * used again. Deletion never changes visibility or moves a thread.
 *
 * Each number is one named constant so a changed answer is a one-line
 * edit. */
export const WORKSPACE_DELETION_DELAY_DAYS = 7;
export const DELETION_RECORD_ACTOR_DAYS = 730;
export const DELETION_ACTIONS_PER_DAY = 5;
/** Principals collected for the sidebar cleanup. */
const PRINCIPALS_MAX = 5_000;
const PRINCIPALS_PAGE = 500;
const SUBSCRIPTIONS_PER_RUN = 50;
const PARTITIONS_PER_RUN = 5;
const ROOM_KEYS_PER_RUN = 128;
const H = 3_600_000;
const DAY = 24 * H;
const RUN_AGAIN_MS = 1_000;
/** How soon a held workspace is looked at again. A hold's release doesn't
 * wake the room, so this bounds the wait after one. */
export const HELD_RECHECK_MS = 5 * 60_000;
/** How soon a failed widget close or catalog write is tried again. */
const CLOSE_RETRY_MS = 60_000;

export const DELETION_STATE_KEY = "workspace-deletion-v1";
const ACTIONS_KEY = "workspace-deletion-actions-v1";
const PRINCIPALS_PREFIX = "workspace-deletion-principals-v1:";
const PARTITIONS_KEY = "workspace-deletion-partitions-v1";
const THREAD_CURSOR_KEY = "workspace-deletion-thread-cursor-v1";
const ROOM_CURSOR_KEY = "workspace-deletion-room-cursor-v1";
/** What the room phase keeps until the end. */
const KEEP = new Set([
  STORAGE_DELETION_KEY,
  "native-room",
  "chat-settings",
  DELETION_STATE_KEY,
  ACTIONS_KEY,
  PARTITIONS_KEY,
  THREAD_CURSOR_KEY,
  ROOM_CURSOR_KEY,
]);

export type DeletionPhase =
  | "knowledge"
  | "threads"
  | "room"
  | "outside"
  | "final";
export type DeletionState = {
  schemaVersion: 1;
  state: "scheduled" | "deleting";
  requestedAt: number;
  dueAt: number;
  actor: ChatPrincipalId;
  authenticatedAt: number;
  expeditedAt?: number;
  expeditedBy?: ChatPrincipalId;
  phase?: DeletionPhase;
  heldSince?: number;
  holdsUnavailableAt?: number;
  knowledgeDone?: boolean;
  widgetClosed?: boolean;
  catalogOpened?: boolean;
  prepared?: boolean;
  flagsRemoved?: boolean;
  outside?: {
    partitions?: number;
    media?: boolean;
    widget?: boolean;
    subscriptions?: number;
    catalog?: boolean;
  };
  counts?: { threads: number; keptUnderHold: number };
  revision: number;
};
/** The deletion as `op: "read"` carries it on every room route. */
export type WorkspaceDeletionView = {
  state: "scheduled" | "deleting";
  requestedAt: number;
  dueAt: number;
};
export type RecordWithDeletion = NativeRoomRecord & {
  workspaceDeletion?: WorkspaceDeletionView;
};

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;

function validState(value: unknown): value is DeletionState {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === 1 &&
    (row.state === "scheduled" || row.state === "deleting") &&
    Number.isSafeInteger(row.requestedAt) &&
    Number.isSafeInteger(row.dueAt) &&
    typeof row.actor === "string" &&
    Number.isSafeInteger(row.revision)
  );
}
/** The stored deletion, null when there is none, or "unreadable". */
export async function readDeletionState(
  storage: Pick<DurableObjectTransaction, "get">,
): Promise<DeletionState | null | "unreadable"> {
  const value = await storage.get<unknown>(DELETION_STATE_KEY);
  if (value === undefined || value === null) return null;
  return validState(value) ? value : "unreadable";
}
/** True while the workspace is set to be deleted.
 * An unreadable record counts as closing. */
export async function workspaceClosing(
  storage: Pick<DurableObjectTransaction, "get">,
): Promise<boolean> {
  return (await readDeletionState(storage)) !== null;
}
/** Consumers that keep running while a workspace closes. */
export const CLOSING_ALARM_CONSUMERS: ReadonlySet<string> = new Set([
  "priority-trial-capture",
  "workspace-flags",
  "own-encryption-qualification",
  "product-billing",
  "support-storage-flush",
  "support-retention",
  "storage-recovery",
  "workspace-deletion",
]);
/** The field `op: "read"` adds. An unreadable record reads as deleting, so
 * every route refuses. */
export async function deletionReadField(
  storage: Pick<DurableObjectTransaction, "get">,
): Promise<{ workspaceDeletion?: WorkspaceDeletionView }> {
  const state = await readDeletionState(storage);
  if (state === null) return {};
  if (state === "unreadable")
    return {
      workspaceDeletion: { state: "deleting", requestedAt: 0, dueAt: 0 },
    };
  return {
    workspaceDeletion: {
      state: state.state,
      requestedAt: state.requestedAt,
      dueAt: state.dueAt,
    },
  };
}
/** Manager transfer ops answer this while a deletion is set. */
export async function refuseManagerChangeWhileClosing(
  storage: Pick<DurableObjectTransaction, "get">,
) {
  if (await workspaceClosing(storage))
    throw new HttpError(
      409,
      "This workspace is already set to be deleted.",
      undefined,
      "deletion-scheduled",
    );
}

/** Trim, Unicode NFC and case folding: "Acme Support " matches "acme
 * support". A near match fails. */
export function sameWorkspaceName(typed: unknown, name: string): boolean {
  if (typeof typed !== "string") return false;
  const fold = (value: string) => value.normalize("NFC").trim().toLowerCase();
  return fold(typed) !== "" && fold(typed) === fold(name);
}

/** The worker's refusal on every room route while a deletion is set, right
 * after the room read. The manager's deletion routes run before this; the
 * manager's workspace export stays open while the deletion is scheduled. */
export function refuseClosedWorkspace(
  record: RecordWithDeletion,
  path: string,
  env: {
    SUPPORT_WORKSPACE_EXPORT_ENABLED?: string;
    RELEASED_FEATURES?: string;
  },
) {
  const deletion = record.workspaceDeletion;
  if (!deletion) return;
  if (
    deletion.state === "scheduled" &&
    featureOn(env, undefined, "workspaceExport") &&
    path === "/conversations/workspace-export"
  )
    return;
  throw new HttpError(
    410,
    "This workspace is being deleted. Only the manager can open it.",
    undefined,
    "workspace-deleting",
  );
}

// Room object: `/private/workspace-deletion` (the worker is the only caller)

async function bumpPermissions(storage: Storage) {
  await storage.put(
    PERMISSION_REVISION_KEY,
    ((await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0) + 1,
  );
}
async function countAction(storage: Storage, now: number) {
  const recent = ((await storage.get<number[]>(ACTIONS_KEY)) ?? []).filter(
    (at) => Number.isSafeInteger(at) && at > now - DAY,
  );
  if (recent.length >= DELETION_ACTIONS_PER_DAY)
    throw new HttpError(
      429,
      "Too many deletion changes today. Try again tomorrow.",
      Math.ceil((recent[0] + DAY - now) / 1000),
      "deletion-rate",
    );
  await storage.put(ACTIONS_KEY, [...recent, now]);
}
async function threadsLeft(storage: Pick<DurableObjectTransaction, "get">) {
  const counts = await storage.get<{ records?: number }>(
    "conversation-state-v1",
  );
  return Number.isSafeInteger(counts?.records) ? counts!.records! : null;
}

export type DeletionRoomView = {
  state: "none" | "scheduled" | "deleting";
  requestedAt?: number;
  dueAt?: number;
  canCancel: boolean;
  blocker?: "manager-transfer-pending";
  /** Operator view only. */
  phase?: DeletionPhase;
  held?: boolean;
  holdsUnavailable?: boolean;
  threadsLeft?: number | null;
};
async function roomView(
  storage: Storage,
  now: number,
  operator = false,
): Promise<DeletionRoomView> {
  const state = await readDeletionState(storage);
  const native = await storage.get<NativeRoomRecord>("native-room");
  const blocker = native?.room.pendingManager
    ? { blocker: "manager-transfer-pending" as const }
    : {};
  if (state === null) return { state: "none", canCancel: false, ...blocker };
  if (state === "unreadable") return { state: "deleting", canCancel: false };
  return {
    state: state.state,
    requestedAt: state.requestedAt,
    dueAt: state.dueAt,
    canCancel: state.state === "scheduled" && state.dueAt > now,
    ...(operator
      ? {
          phase: state.phase ?? "knowledge",
          held: state.heldSince !== undefined,
          holdsUnavailable: state.holdsUnavailableAt !== undefined,
          threadsLeft: await threadsLeft(storage),
        }
      : {}),
  };
}

/** The room side of request, cancel, expedite and the state reads. */
export async function workspaceDeletionRoomRequest(
  state: DurableObjectState,
  request: Request,
  now = Date.now(),
): Promise<Response> {
  const body = await readJson(request, 4_096);
  return state.storage.transaction(async (storage) => {
    const native = await storage.get<NativeRoomRecord>("native-room");
    if (!native) throw new HttpError(404, "Chat not found.");
    if (body.op === "state")
      return json(await roomView(storage, now, body.operator === true));
    const actor = principal(body.actor);
    const aliases = servicePrincipals(actor, body.aliases);
    const current = await readDeletionState(storage);
    if (current === "unreadable")
      throw new HttpError(503, "Workspace deletion is unavailable.");
    if (body.op === "expedite") {
      // The operator's speed-up for a manager who already asked.
      if (!current || current.state !== "scheduled")
        throw new HttpError(
          409,
          "Only a workspace waiting for deletion can be sped up.",
          undefined,
          "deletion-not-scheduled",
        );
      if (current.expeditedAt !== undefined)
        throw new HttpError(
          409,
          "This deletion was already sped up.",
          undefined,
          "deletion-expedited",
        );
      const next: DeletionState = {
        ...current,
        dueAt: now,
        expeditedAt: now,
        expeditedBy: actor,
        revision: current.revision + 1,
      };
      await storage.put(DELETION_STATE_KEY, next);
      await wakeRoomAt(state.storage, now + RUN_AGAIN_MS);
      return json(await roomView(storage, now));
    }
    // Request and cancel: the current manager only.
    if (!actsAs(aliases, native.room.manager))
      throw new HttpError(
        403,
        "Only the workspace manager can delete it.",
        undefined,
        "manager-only",
      );
    const authenticatedAt = body.authenticatedAt;
    if (!Number.isSafeInteger(authenticatedAt))
      throw new HttpError(400, "Invalid deletion request.");
    if (body.op === "request") {
      if (current)
        throw new HttpError(
          409,
          "This workspace is already set to be deleted.",
          undefined,
          "deletion-scheduled",
        );
      if (native.room.pendingManager)
        throw new HttpError(
          409,
          "Finish or cancel the manager transfer first.",
          undefined,
          "manager-transfer-pending",
        );
      if (!sameWorkspaceName(body.name, native.room.name))
        throw new HttpError(
          400,
          "Type the workspace name exactly as it appears.",
          undefined,
          "name-mismatch",
        );
      await countAction(storage, now);
      const dueAt = now + WORKSPACE_DELETION_DELAY_DAYS * DAY;
      const next: DeletionState = {
        schemaVersion: 1,
        state: "scheduled",
        requestedAt: now,
        dueAt,
        actor,
        authenticatedAt: authenticatedAt as number,
        revision: 1,
      };
      await storage.put(DELETION_STATE_KEY, next);
      // Open sockets re-prove access and are refused.
      await bumpPermissions(storage);
      await appendAudit(
        storage,
        {
          actor,
          action: "workspace.deletion-requested",
          authenticatedAt: new Date(authenticatedAt as number).toISOString(),
          target: null,
          after: { dueAt: new Date(dueAt).toISOString() },
        },
        now,
      );
      // The job runs once right away: it repeats the widget close and the
      // catalog write this request makes, so a failed one is retried
      // within a minute rather than at the due time.
      await wakeRoomAt(state.storage, now + RUN_AGAIN_MS);
      return json({ state: "scheduled", dueAt, requestedAt: now }, 202);
    }
    if (body.op === "cancel") {
      // Cancelling nothing answers the current state, so a retried cancel
      // can finish reopening the widget.
      if (!current) return json({ state: "none" });
      if (current.state !== "scheduled" || current.dueAt <= now)
        throw new HttpError(
          409,
          "Deletion has started and can't be cancelled.",
          undefined,
          "deletion-started",
        );
      await countAction(storage, now);
      const cancelled = current.requestedAt;
      await storage.delete(DELETION_STATE_KEY);
      await bumpPermissions(storage);
      await appendAudit(
        storage,
        {
          actor,
          action: "workspace.deletion-cancelled",
          authenticatedAt: new Date(authenticatedAt as number).toISOString(),
          target: null,
        },
        now,
      );
      return json({ state: "none", requestedAt: cancelled });
    }
    throw new HttpError(404, "Not found.");
  });
}

// Outside objects

type DeletionEnv = Env &
  SafetyEnv &
  OperatorAdminEnv & {
    WORKSPACE_DELETION_ENABLED?: string;
    SUPPORT_WORKSPACE_EXPORT_ENABLED?: string;
    TEMPL_SUPPORT_WORKSPACE?: string;
    SUPPORT_PARTITIONS?: DurableObjectNamespace;
    /** The per-workspace knowledge object, when it exists. */
    SUPPORT_KNOWLEDGE?: DurableObjectNamespace;
  };
export const deletionEnabled = (env: { WORKSPACE_DELETION_ENABLED?: string }) =>
  env.WORKSPACE_DELETION_ENABLED === "true";

const post = (path: string, body: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function answered<T>(response: Response, fallback: string): Promise<T> {
  if (response.ok) return response.json<T>();
  const error = await response
    .json<{ error?: unknown; reason?: unknown }>()
    .catch(() => null);
  throw new HttpError(
    [400, 403, 404, 409, 410, 429].includes(response.status)
      ? response.status
      : 503,
    typeof error?.error === "string" ? error.error : fallback,
    response.status === 429
      ? Number(response.headers.get("Retry-After")) || undefined
      : undefined,
    typeof error?.reason === "string" ? error.reason : undefined,
  );
}
function catalog(env: Pick<Env, "ROOMS">, body: Record<string, unknown>) {
  return env.ROOMS.get(env.ROOMS.idFromName(NATIVE_CATALOG)).fetch(
    post("/private/native-catalog", body),
  );
}
function roomCall(env: Pick<Env, "ROOMS">, id: string, body: object) {
  return env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${nativeRoomId(id)}`),
  ).fetch(post("/private/workspace-deletion", body));
}
/** The workspace's widget settings object: `close`, `reopen` or `delete`.
 * `close` and `reopen` name the deletion by its `requestedAt`, so a close
 * that arrives after that deletion was cancelled changes nothing. */
export function widgetClosure(
  env: Env,
  room: string,
  op: "close" | "reopen" | "delete",
  requestedAt?: number,
) {
  return env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${config(env).namespace}:widget-config:${room}`,
    ),
  ).fetch(
    post("/widget-config", {
      op: `workspace-${op}`,
      ...(requestedAt === undefined ? {} : { requestedAt }),
    }),
  );
}
const WIDGET_CLOSED_KEY = "widget-closed-v1";
/** The latest cancelled deletion's `requestedAt`: a close for that deletion
 * or an earlier one is stale. */
const WIDGET_REOPENED_KEY = "widget-reopened-v1";
/** The widget settings object's side: `workspace-close` and
 * `workspace-reopen` flip one marker; `workspace-delete` removes every
 * setting, the audit outbox and the refusal counts and keeps only
 * `{deletedAt}`. Null for any other op. */
export async function widgetClosureOp(
  storage: Storage,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<Response | null> {
  const requestedAt = Number.isSafeInteger(body.requestedAt)
    ? (body.requestedAt as number)
    : undefined;
  if (body.op === "workspace-close") {
    const reopened = (await storage.get<number>(WIDGET_REOPENED_KEY)) ?? null;
    if (
      requestedAt !== undefined &&
      reopened !== null &&
      requestedAt <= reopened
    )
      return json({ closed: false, stale: true });
    if (!(await storage.get(WIDGET_CLOSED_KEY)))
      await storage.put(WIDGET_CLOSED_KEY, { closedAt: now });
    return json({ closed: true });
  }
  if (body.op === "workspace-reopen") {
    const marker = await storage.get<{ deletedAt?: number }>(WIDGET_CLOSED_KEY);
    if (marker?.deletedAt)
      throw new HttpError(410, "This support chat is closed.");
    if (requestedAt !== undefined) {
      const reopened = (await storage.get<number>(WIDGET_REOPENED_KEY)) ?? 0;
      if (requestedAt > reopened)
        await storage.put(WIDGET_REOPENED_KEY, requestedAt);
    }
    await storage.delete(WIDGET_CLOSED_KEY);
    return json({ closed: false });
  }
  if (body.op === "workspace-delete") {
    const keys = [...(await storage.list({ limit: 1000 })).keys()].filter(
      (key) => key !== WIDGET_CLOSED_KEY,
    );
    for (let at = 0; at < keys.length; at += 128)
      await storage.delete(keys.slice(at, at + 128));
    await storage.put(WIDGET_CLOSED_KEY, { deletedAt: now });
    return json({ deleted: true });
  }
  return null;
}
/** Whether a widget request must answer 410 `workspace-closed`. */
export async function widgetClosed(
  storage: Pick<DurableObjectTransaction, "get">,
): Promise<boolean> {
  return Boolean(await storage.get(WIDGET_CLOSED_KEY));
}
export const workspaceClosedError = () =>
  new HttpError(
    410,
    "This support chat is closed.",
    undefined,
    "workspace-closed",
  );

/** The knowledge object's purge: eval copies first, then documents, answering
 * `{done}`. Without that object there is nothing to purge. */
async function purgeKnowledge(env: DeletionEnv, workspace: string) {
  const namespace = env.SUPPORT_KNOWLEDGE;
  if (!namespace) return true;
  const response = await namespace
    .get(namespace.idFromName(knowledgeObjectName(`room:${workspace}`)))
    .fetch(post("/purge-workspace", { workspace }));
  if (!response.ok) return false;
  return (await response.json<{ done?: unknown }>()).done === true;
}

// Catalog (`native-room-catalog:v1`)

type Tombstone = {
  schemaVersion: 1;
  id: string;
  requestedAt: number;
  deletedAt: number | null;
  actor?: ChatPrincipalId;
  authenticatedAt?: number;
  expeditedBy?: ChatPrincipalId;
  receipts: unknown[];
  openIntents: string[];
  counts: { threads: number; keptUnderHold: number };
  billing?: DeletedBilling;
  stripeCleanup?: "pending" | "done" | "not-needed";
};
const TOMBSTONE = "native-deleted:";
const OPEN = "native-deletion-open:";
/** Catalog ops for deletion, and the reserve refusal for a deleted id. Null
 * for other ops. */
export async function deletionCatalogRequest(
  storage: Storage,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<Response | null> {
  const op = body.op;
  if (op === "reserve") {
    const id = nativeRoomId(body.id);
    if (await storage.get(TOMBSTONE + id))
      throw new HttpError(
        410,
        "This workspace was deleted.",
        undefined,
        "workspace-deleted",
      );
    return null;
  }
  if (op === "deletion-open") {
    const id = nativeRoomId(body.id);
    await storage.put(OPEN + id, true);
    return json({ ok: true });
  }
  if (op === "deletion-close") {
    await storage.delete(OPEN + nativeRoomId(body.id));
    return json({ ok: true });
  }
  if (op === "tombstone") {
    const id = nativeRoomId(body.id);
    const input = body.tombstone as Tombstone & {
      stripe?: DeletedWorkspaceStripe | null;
    };
    const existing = await storage.get<Tombstone>(TOMBSTONE + id);
    if (!existing?.stripeCleanup && input.stripe)
      await queueDeletedWorkspaceStripe(
        storage as never,
        id,
        input.stripe,
        now,
      );
    await storage.put(TOMBSTONE + id, {
      schemaVersion: 1,
      id,
      requestedAt: input.requestedAt,
      deletedAt: existing?.deletedAt ?? null,
      actor: input.actor,
      authenticatedAt: input.authenticatedAt,
      ...(input.expeditedBy ? { expeditedBy: input.expeditedBy } : {}),
      receipts: existing?.receipts?.length ? existing.receipts : input.receipts,
      openIntents: input.openIntents,
      counts: input.counts,
      stripeCleanup:
        existing?.stripeCleanup ?? (input.stripe ? "pending" : "not-needed"),
      ...(existing?.billing
        ? { billing: existing.billing }
        : input.billing
          ? { billing: input.billing }
          : {}),
    } satisfies Tombstone);
    return json({ ok: true });
  }
  if (op === "deletion-finish") {
    const id = nativeRoomId(body.id);
    const tombstone = await storage.get<Tombstone>(TOMBSTONE + id);
    if (!tombstone) throw new HttpError(409, "The deletion record is missing.");
    if (tombstone.deletedAt === null) {
      await storage.put(TOMBSTONE + id, { ...tombstone, deletedAt: now });
      const reservation = await storage.get<{ room?: { creator?: string } }>(
        `native-reservation:${id}`,
      );
      const creator = reservation?.room?.creator;
      if (creator) {
        const count =
          (await storage.get<number>(`native-count:${creator}`)) ?? 0;
        await storage.put(`native-count:${creator}`, Math.max(0, count - 1));
      }
      const indexed = await storage.get<{ slug?: string | null }>(
        `native-index:${id}`,
      );
      if (
        indexed?.slug &&
        (await storage.get<string>(`native-slug:${indexed.slug}`)) === id
      )
        await storage.delete(`native-slug:${indexed.slug}`);
      await storage.delete([
        `native-index:${id}`,
        `native-index-revision:${id}`,
        `native-reservation:${id}`,
        OPEN + id,
      ]);
    }
    return json({ ok: true });
  }
  if (op === "deletion-list") {
    const open = [
      ...(await storage.list({ prefix: OPEN, limit: 50 })).keys(),
    ].map((key) => key.slice(OPEN.length));
    const cutoff = now - DELETION_RECORD_ACTOR_DAYS * DAY;
    const rows = await storage.list<Tombstone>({
      prefix: TOMBSTONE,
      limit: 200,
    });
    const tombstones: Omit<Tombstone, "actor" | "authenticatedAt">[] = [];
    let pruned = 0;
    for (const [key, row] of rows) {
      // The who-deleted fields go after 730 days, 50 per read; the rest
      // stays, since receipts are kept and the id stays unusable.
      if (
        row.deletedAt !== null &&
        row.deletedAt < cutoff &&
        (row.actor || row.authenticatedAt) &&
        pruned < 50
      ) {
        const { actor: _a, authenticatedAt: _t, ...kept } = row;
        await storage.put(key, kept);
        pruned++;
      }
      if (row.deletedAt === null || row.deletedAt >= cutoff)
        tombstones.push({
          schemaVersion: 1,
          id: row.id,
          requestedAt: row.requestedAt,
          deletedAt: row.deletedAt,
          receipts: [],
          openIntents: [],
          counts: row.counts,
        });
    }
    return json({ open, tombstones });
  }
  return null;
}

// The deletion job (room alarm consumer `workspace-deletion`)

/** Applies `patch` to the stored state (read again, so a count a batch
 * wrote is kept). The copy in memory is never written back: when the
 * stored record is gone (a cancel ran while the job waited on another
 * object) or belongs to a different request, nothing is written and the
 * answer is null, so the job stops. The read and the write sit in one
 * storage turn with no other I/O between them. */
export async function saveState(
  storage: Pick<DurableObjectStorage, "get" | "put">,
  state: Pick<DeletionState, "requestedAt">,
  patch: Partial<DeletionState>,
): Promise<DeletionState | null> {
  const stored = await readDeletionState(storage);
  if (!stored || stored === "unreadable") return null;
  if (stored.requestedAt !== state.requestedAt) return null;
  const next = { ...stored, ...patch, revision: stored.revision + 1 };
  await storage.put(DELETION_STATE_KEY, next);
  return next;
}

/** One bounded step. Returns when to run next, or null when there is
 * nothing left (the object is then empty). */
export async function workspaceDeletionAlarm(
  context: RoomAlarmContext,
  now: number,
): Promise<number | null> {
  const storage = context.state.storage;
  const env = context.env as unknown as DeletionEnv;
  const read = await readDeletionState(storage);
  if (read === null) return null;
  if (read === "unreadable") return now + H;
  let state: DeletionState = read;
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) return null;
  const id = native.room.id;
  // A cancel can land while these outside calls wait. saveState then
  // answers null and the job stops; the widget close carries requestedAt,
  // so the settings object ignores it after that deletion's reopen.
  if (!state.catalogOpened) {
    const opened = await catalog(env, { op: "deletion-open", id }).catch(
      () => null,
    );
    await opened?.body?.cancel();
    if (opened?.ok) {
      const saved = await saveState(storage, state, { catalogOpened: true });
      if (!saved) return null;
      state = saved;
    }
  }
  if (!state.widgetClosed) {
    const closed = await widgetClosure(
      env,
      id,
      "close",
      state.requestedAt,
    ).catch(() => null);
    await closed?.body?.cancel();
    if (closed?.ok) {
      const saved = await saveState(storage, state, { widgetClosed: true });
      if (!saved) return null;
      state = saved;
    }
  }
  if (state.state === "scheduled") {
    // A close or catalog write that failed is retried soon, not at the due
    // time a week away.
    if (state.dueAt > now)
      return state.widgetClosed && state.catalogOpened
        ? state.dueAt
        : Math.min(state.dueAt, now + CLOSE_RETRY_MS);
    await storage.transaction(async (local) => {
      const current = await readDeletionState(local);
      if (!current || current === "unreadable" || current.state !== "scheduled")
        return;
      const matured = await local.list({
        prefix: CHARGE_DUE_PREFIX,
        end: `${CHARGE_DUE_PREFIX}${String(now + 1).padStart(16, "0")}`,
        limit: 1,
      });
      if (matured.size) return;
      const standardMatured = await local.list({
        prefix: STANDARD_DUE_PREFIX,
        end: `${STANDARD_DUE_PREFIX}${String(now + 1).padStart(16, "0")}`,
        limit: 1,
      });
      if (standardMatured.size) return;
      await local.put(DELETION_STATE_KEY, {
        ...current,
        state: "deleting",
        phase: "knowledge",
        revision: current.revision + 1,
      } satisfies DeletionState);
      await appendAudit(
        local,
        {
          actor: current.actor,
          action: "workspace.deletion-started",
          authenticatedAt: new Date(current.authenticatedAt).toISOString(),
          target: null,
          after: { dueAt: new Date(current.dueAt).toISOString() },
        },
        now,
      );
    });
    return now + RUN_AGAIN_MS;
  }
  // Holds are read before every destructive batch.
  const holds = await readRetentionHolds(env, `room:${id}`);
  if (!holds) {
    console.warn(
      JSON.stringify({ event: "TEMPL_WORKSPACE_DELETION_HOLDS_UNAVAILABLE" }),
    );
    if (state.holdsUnavailableAt === undefined)
      await saveState(storage, state, { holdsUnavailableAt: now });
    return now + H;
  }
  if (holds.room) {
    if (state.heldSince === undefined)
      await saveState(storage, state, {
        heldSince: now,
        holdsUnavailableAt: undefined,
      });
    // Nothing wakes the room when a hold is released, so the job looks
    // again soon; holds are still read before every batch.
    return now + HELD_RECHECK_MS;
  }
  if (state.heldSince !== undefined || state.holdsUnavailableAt !== undefined) {
    const saved = await saveState(storage, state, {
      heldSince: undefined,
      holdsUnavailableAt: undefined,
    });
    if (!saved) return null;
    state = saved;
  }
  // Knowledge and eval copies: retried on later runs while the threads go;
  // the final step waits for it.
  if (!state.knowledgeDone) {
    await prepareStorageDeletion(storage as never, env as never, `room:${id}`, native.room.manager, now);
    const done = await purgeKnowledge(env, id).catch(() => false);
    if (done) {
      const saved = await saveState(storage, state, { knowledgeDone: true });
      if (!saved) return null;
      state = saved;
    }
  }
  const phase = state.phase ?? "knowledge";
  if (phase === "knowledge" || phase === "threads") {
    const step = await threadStep(context, id, holds, now);
    if (step === "more") {
      if (phase !== "threads")
        await saveState(storage, state, { phase: "threads" });
      return now + RUN_AGAIN_MS;
    }
    if (step === "unavailable") return now + H;
    if (step === "held") {
      // Held threads stay whole; the rest of the workspace waits with them.
      if (state.heldSince === undefined)
        await saveState(storage, state, { heldSince: now, phase: "threads" });
      return now + HELD_RECHECK_MS;
    }
    await saveState(storage, state, { phase: "room" });
    return now + RUN_AGAIN_MS;
  }
  if (phase === "room") {
    if (!state.flagsRemoved) {
      if (!(await removeDeletedWorkspaceFlags(storage, env, id, now))) return now + CLOSE_RETRY_MS;
      const saved = await saveState(storage, state, { flagsRemoved: true });
      if (!saved) return null;
      state = saved;
    }
    if (!state.prepared) {
      await prepareRoomPhase(storage, env, id, state, native);
      return now + RUN_AGAIN_MS;
    }
    const more = await deleteRoomKeys(storage);
    if (!more) await saveState(storage, state, { phase: "outside" });
    return now + RUN_AGAIN_MS;
  }
  if (phase === "outside") {
    const done = await outsideStep(context, env, id, state, native);
    if (done) await saveState(storage, state, { phase: "final" });
    return now + RUN_AGAIN_MS;
  }
  // final
  if (!state.knowledgeDone) return now + H;
  // The scheduler clears the alarm once no job reports a due time.
  await storage.deleteAll();
  return null;
}

type ThreadStep = "more" | "done" | "held" | "unavailable";
async function threadStep(
  { state, env, searchIndex }: RoomAlarmContext,
  workspace: string,
  holds: RetentionHolds,
  now: number,
): Promise<ThreadStep> {
  const deletionEnv = env as unknown as DeletionEnv;
  return state.storage.transaction(async (local) => {
    const support = await supportStorage(
      local,
      env,
      state.id?.toString() ?? "",
      false,
    );
    if (await support.get<string>(SUPPORT_RETENTION_PENDING_KEY)) {
      // The retention sweep deletes the pending thread's rows, 100 per call,
      // with its own hold recheck before every batch.
      const outcome = await sweepSupportRetention(
        support,
        now,
        (channel, message) => searchIndex.remove(channel, message),
        (room, conversation, attachment, reference) =>
          deleteSupportAttachment(
            env,
            { room, conversation, attachment: attachment.id },
            attachment,
            reference,
          ),
        (roomKey) => readRetentionHolds(deletionEnv, roomKey),
      );
      return outcome === "holds-unavailable" ? "unavailable" : "more";
    }
    const cursor = await local.get<string>(THREAD_CURSOR_KEY);
    const records = await support.list<TeamConversationRecord>({
      prefix: "conversation-v1:",
      limit: 20,
      ...(cursor ? { startAfter: cursor } : {}),
    });
    for (const [key, record] of records) {
      await local.put(THREAD_CURSOR_KEY, key);
      if (holds.threads.has(record.id)) continue;
      // A restore to an earlier time must not bring the thread back.
      await recordPrivacyDeletion(deletionEnv, {
        workspace,
        thread: record.id,
        at: now,
      });
      const workflow = await supportRecord(support, record);
      await support.put(SUPPORT_RETENTION_PENDING_KEY, record.id);
      await support.put(key, { ...record, deleting: true });
      await saveRetentionRestorePoint(support, record.id, workflow);
      await clearThreadAwaiting(support, record.id, workflow);
      await bumpPermissions(support);
      const current = await readDeletionState(local);
      if (current && current !== "unreadable")
        await local.put(DELETION_STATE_KEY, {
          ...current,
          counts: {
            threads: (current.counts?.threads ?? 0) + 1,
            keptUnderHold: 0,
          },
          revision: current.revision + 1,
        } satisfies DeletionState);
      return "more";
    }
    if (records.size === 20) return "more";
    await local.delete(THREAD_CURSOR_KEY);
    const left = await support.list({ prefix: "conversation-v1:", limit: 1 });
    return left.size ? "held" : "done";
  });
}

async function prepareRoomPhase(
  storage: DurableObjectStorage,
  env: DeletionEnv,
  id: string,
  state: DeletionState,
  native: NativeRoomRecord,
) {
  // Who follows the workspace: its members, staff and people with threads.
  const principals = new Set<string>(
    [
      native.room.manager,
      native.room.creator,
      native.room.pendingManager,
    ].filter((value): value is ChatPrincipalId => typeof value === "string"),
  );
  for (const prefix of ["room-member:", "roles:", "conversation-member-v1:"]) {
    let after: string | undefined;
    for (;;) {
      const page = await storage.list({
        prefix,
        limit: 500,
        ...(after ? { startAfter: after } : {}),
      });
      for (const key of page.keys()) {
        if (principals.size >= PRINCIPALS_MAX) break;
        principals.add(key.slice(prefix.length));
      }
      if (page.size < 500 || principals.size >= PRINCIPALS_MAX) break;
      after = [...page.keys()].at(-1);
    }
  }
  const list = [...principals];
  for (let page = 0; page * PRINCIPALS_PAGE < list.length; page++)
    await storage.put(
      `${PRINCIPALS_PREFIX}${String(page).padStart(4, "0")}`,
      list.slice(page * PRINCIPALS_PAGE, (page + 1) * PRINCIPALS_PAGE),
    );
  // The support partitions the room wrote, with the capability that opens
  // them, as the storage recovery inventory reads them.
  const partitions: { name: string; mode: "data" | "index" }[] = [];
  const seen = new Set<string>();
  for (const [prefix, mode] of [
    ["support-store-manifest-v1:", "data"],
    ["support-store-search-v1:", "index"],
    ["group-store-search-v1:", "index"],
  ] as const)
    for (const value of (
      await storage.list<{ id?: unknown }>({ prefix, limit: 1000 })
    ).values())
      if (typeof value?.id === "string" && !seen.has(value.id)) {
        seen.add(value.id);
        partitions.push({ name: value.id, mode });
      }
  await storage.put(PARTITIONS_KEY, {
    capability:
      (await storage.get<string>("support-store-capability-v1")) ?? null,
    partitions,
  });
  // Receipts go to the catalog record before any product key is deleted.
  const receipts = (await storage.get(PRODUCT_STATE_KEY))
    ? await productReceipts(storage as never)
    : [];
  const openIntents = [
    ...(
      await storage.list<{ id?: string; receipt?: unknown }>({
        prefix: "product-payment-intent-v1:",
        limit: 512,
      })
    ).values(),
  ]
    .filter((intent) => !intent?.receipt && typeof intent?.id === "string")
    .map((intent) => intent.id!);
  // Open charges are dropped and never billed; the balance stays owed or
  // refundable from the deletion record.
  const billing = await closeBillingForDeletion(
    storage as never,
    Date.now(),
    env,
  );
  const stripe = await deletedWorkspaceStripe(storage, `room:${id}`);
  const current = await readDeletionState(storage);
  const threads =
    current && current !== "unreadable" ? (current.counts?.threads ?? 0) : 0;
  const tombstone = await catalog(env, {
    op: "tombstone",
    id,
    tombstone: {
      requestedAt: state.requestedAt,
      actor: state.actor,
      authenticatedAt: state.authenticatedAt,
      ...(state.expeditedBy ? { expeditedBy: state.expeditedBy } : {}),
      receipts,
      openIntents,
      counts: { threads, keptUnderHold: 0 },
      stripe,
      ...(billing ? { billing } : {}),
    },
  });
  if (!tombstone.ok) {
    await tombstone.body?.cancel();
    throw new HttpError(503, "The deletion record could not be written.");
  }
  await saveState(storage, state, { prepared: true });
}

/** Deletes up to 128 room keys that the end of the job doesn't need. True
 * while more remain. */
async function deleteRoomKeys(storage: DurableObjectStorage) {
  const cursor = await storage.get<string>(ROOM_CURSOR_KEY);
  const page = await storage.list({
    limit: ROOM_KEYS_PER_RUN,
    ...(cursor ? { startAfter: cursor } : {}),
  });
  const doomed = [...page.keys()].filter(
    (key) => !KEEP.has(key) && !key.startsWith(PRINCIPALS_PREFIX),
  );
  if (doomed.length) await storage.delete(doomed);
  const last = [...page.keys()].at(-1);
  if (page.size < ROOM_KEYS_PER_RUN || !last) {
    await storage.delete(ROOM_CURSOR_KEY);
    return false;
  }
  await storage.put(ROOM_CURSOR_KEY, last);
  return true;
}

async function outsideStep(
  { state: object }: RoomAlarmContext,
  env: DeletionEnv,
  id: string,
  state: DeletionState,
  native: NativeRoomRecord,
): Promise<boolean> {
  const storage = object.storage;
  const outside = { ...(state.outside ?? {}) };
  const save = () => saveState(storage, state, { outside });
  // 1. Support partitions: each one's contents, with its identity checked.
  const stored = await storage.get<{
    capability: string | null;
    partitions: { name: string; mode: "data" | "index" }[];
  }>(PARTITIONS_KEY);
  const partitions = stored?.partitions ?? [];
  let done = outside.partitions ?? 0;
  if (done < partitions.length) {
    if (!env.SUPPORT_PARTITIONS || !stored?.capability)
      throw new HttpError(503, "Support history storage is unavailable.");
    const objectId = object.id?.toString() ?? "";
    for (const partition of partitions.slice(done, done + PARTITIONS_PER_RUN)) {
      const response = await env.SUPPORT_PARTITIONS.get(
        env.SUPPORT_PARTITIONS.idFromName(`${objectId}:${partition.name}`),
      ).fetch(
        post("/private/recovery/delete-orphan", {
          room: objectId,
          capability: stored.capability,
          partition: partition.name,
          mode: partition.mode,
        }),
      );
      await answered(response, "Support history storage is unavailable.");
      done++;
    }
    outside.partitions = done;
    await save();
    return false;
  }
  // 2. The room image's reference in its owner's media quota.
  if (!outside.media) {
    const hash = /([0-9a-f]{64})(?:\.[a-z]+)?$/.exec(native.room.image ?? "");
    if (hash) await releaseMediaReference(env, hash[1], `room:${id}`);
    outside.media = true;
    await save();
    return false;
  }
  // 3. Widget settings: only {deletedAt} stays.
  if (!outside.widget) {
    await answered(
      await widgetClosure(env, id, "delete"),
      "Widget settings are unavailable.",
    );
    outside.widget = true;
    await save();
    return false;
  }
  // 4. Sidebars: every collected principal stops following the workspace.
  const pages = [
    ...(await storage.list<string[]>({ prefix: PRINCIPALS_PREFIX })).values(),
  ].flat();
  let unsubscribed = outside.subscriptions ?? 0;
  if (unsubscribed < pages.length && env.ROOM_SUBSCRIPTIONS) {
    for (const who of pages.slice(
      unsubscribed,
      unsubscribed + SUBSCRIPTIONS_PER_RUN,
    )) {
      const response = await env.ROOM_SUBSCRIPTIONS.get(
        env.ROOM_SUBSCRIPTIONS.idFromName(`${STORAGE_SCOPE_CHAIN_ID}:${who}`),
      ).fetch(post("/subscriptions", { roomId: id, subscribed: false }));
      if (!response.ok && response.status !== 404)
        throw new HttpError(503, "Sidebars could not be updated.");
      await response.body?.cancel();
      unsubscribed++;
    }
    outside.subscriptions = unsubscribed;
    await save();
    return false;
  }
  // 5. The catalog: the id is never usable again.
  if (!outside.catalog) {
    await answered(
      await catalog(env, { op: "deletion-finish", id }),
      "The workspace list is unavailable.",
    );
    outside.catalog = true;
    await save();
  }
  return true;
}

// Worker routes

type Session = ServiceSession & {
  authMethod?: import("@templ/chat/principal").AuthMethod;
  authenticatedAt?: number;
};
export type DeletionRouteDeps<S extends Session> = {
  session: () => Promise<S>;
  /** A widget session never reaches these routes. */
  widget: boolean;
};

function expectedPrincipal(body: Record<string, unknown>, session: Session) {
  if (
    "expectedWallet" in body ||
    body.expectedPrincipalId !== session.principalId
  )
    throw new HttpError(401, "Your sign-in changed. Try again.");
}
const managerOnly = () =>
  new HttpError(
    403,
    "Only the workspace manager can delete it.",
    undefined,
    "manager-only",
  );

/** `/rooms/<id>/deletion`, `/rooms/<id>/deletion/cancel`,
 * `/operator/deletions` and `/operator/deletions/<id>/expedite`. */
export async function workspaceDeletionRoute<S extends Session>(
  request: Request,
  env: DeletionEnv,
  deps: DeletionRouteDeps<S>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const room = /^\/rooms\/([0-9a-f-]{36})\/deletion(\/cancel)?$/.exec(
    url.pathname,
  );
  const operator =
    /^\/operator\/deletions(?:\/([0-9a-f-]{36})\/expedite)?$/.exec(
      url.pathname,
    );
  if (!room && !operator) return null;
  if (deps.widget) throw new HttpError(404, "Not found.");
  if (!deletionEnabled(env)) throw new HttpError(404, "Not found.");
  const write = request.method === "POST";
  if (!write && request.method !== "GET")
    throw new HttpError(404, "Not found.");
  if (room && room[2] && !write) throw new HttpError(404, "Not found.");
  if (operator && operator[1] && !write) throw new HttpError(404, "Not found.");
  if (operator && !operator[1] && write) throw new HttpError(404, "Not found.");
  // The body is read before the session, as every other write route does.
  const body = write ? await readJson(request, 2_048) : null;
  if (operator) return operatorRoute(env, deps, body, operator[1] ?? null);
  const id = nativeRoomId(room![1]);
  const context = started(nativeRecord(env, id));
  const session = await deps.session();
  const { record } = await context;
  const aliases = sessionPrincipals(session);
  if (!aliases.includes(record.room.manager)) throw managerOnly();
  await requireSafetyAccess(env, `room:${id}`, session.principalId, aliases);
  const templWorkspace = env.TEMPL_SUPPORT_WORKSPACE === id;
  if (!body) {
    const view = await answered<DeletionRoomView>(
      await roomCall(env, id, { op: "state" }),
      "Workspace deletion is unavailable.",
    );
    return json({
      ...view,
      ...(templWorkspace ? { blocker: "templ-workspace" } : {}),
    });
  }
  expectedPrincipal(body, session);
  const authenticatedAt = requireWalletAuth(session, body.confirmed);
  if (room![2]) {
    const result = await answered<{ state: string; requestedAt?: number }>(
      await roomCall(env, id, {
        op: "cancel",
        actor: session.principalId,
        aliases,
        authenticatedAt,
      }),
      "Workspace deletion is unavailable.",
    );
    // Everyone gets access back: the widget opens again and the operator
    // list drops the workspace.
    let reopened = false;
    for (let attempt = 0; attempt < 3 && !reopened; attempt++) {
      const response = await widgetClosure(
        env,
        id,
        "reopen",
        result.requestedAt,
      ).catch(() => null);
      reopened = Boolean(response?.ok);
      await response?.body?.cancel();
    }
    if (!reopened)
      throw new HttpError(
        503,
        "Deletion cancelled, but the support chat didn't reopen. Try Cancel deletion again.",
        undefined,
        "widget-reopen-pending",
      );
    const closed = await catalog(env, { op: "deletion-close", id }).catch(
      () => null,
    );
    await closed?.body?.cancel();
    return json({ state: result.state });
  }
  if (templWorkspace)
    throw new HttpError(
      409,
      "Templ's own support workspace can't be deleted.",
      undefined,
      "templ-workspace",
    );
  const scheduled = await answered<{ dueAt: number; requestedAt: number }>(
    await roomCall(env, id, {
      op: "request",
      actor: session.principalId,
      aliases,
      authenticatedAt,
      name: body.name,
    }),
    "Workspace deletion is unavailable.",
  );
  // The widget closes in the same call; if this write fails the room read
  // still refuses every conversation route and the job retries it.
  const closed = await widgetClosure(
    env,
    id,
    "close",
    scheduled.requestedAt,
  ).catch(() => null);
  await closed?.body?.cancel();
  const opened = await catalog(env, { op: "deletion-open", id }).catch(
    () => null,
  );
  await opened?.body?.cancel();
  return json(
    {
      state: "scheduled",
      requestedAt: scheduled.requestedAt,
      dueAt: scheduled.dueAt,
    },
    202,
  );
}
function started<T>(promise: Promise<T>) {
  promise.catch(() => undefined);
  return promise;
}

async function operatorRoute<S extends Session>(
  env: DeletionEnv,
  deps: DeletionRouteDeps<S>,
  body: Record<string, unknown> | null,
  expedite: string | null,
) {
  const session = await deps.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(403, "This page is for Templ operators.");
  if (body && expedite) {
    expectedPrincipal(body, session);
    requireWalletAuth(session, body.confirmed);
    return json(
      await answered<DeletionRoomView>(
        await roomCall(env, expedite, {
          op: "expedite",
          actor: session.principalId,
          aliases: sessionPrincipals(session),
        }),
        "Workspace deletion is unavailable.",
      ),
    );
  }
  const listed = await answered<{
    open: string[];
    tombstones: {
      id: string;
      requestedAt: number;
      deletedAt: number | null;
      counts: Tombstone["counts"];
    }[];
  }>(await catalog(env, { op: "deletion-list" }), "Deletions are unavailable.");
  const open = (
    await Promise.all(
      listed.open.map(async (id) => {
        try {
          const view = await answered<DeletionRoomView>(
            await roomCall(env, id, { op: "state", operator: true }),
            "",
          );
          return view.state === "none" ? null : { id, ...view };
        } catch (error) {
          // An emptied room has finished; its tombstone lists it.
          return error instanceof HttpError && error.status === 404
            ? null
            : { id, state: "unknown" as const };
        }
      }),
    )
  )
    .filter((row) => row !== null)
    .map((row) =>
      row.state === "deleting" && (row as DeletionRoomView).held
        ? { ...row, state: "held" as const }
        : row.state === "deleting" && (row as DeletionRoomView).holdsUnavailable
          ? { ...row, state: "holds-unavailable" as const }
          : row,
    );
  return json({
    schemaVersion: 1,
    open,
    deleted: listed.tombstones.filter((row) => row.deletedAt !== null),
  });
}
