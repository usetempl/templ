/** The recovery tool's own records, kept in `SafetyStore`: the one object a
 * workspace restore never touches, so a plan, its undo bookmarks, the audit
 * trail, the rate counter and the privacy-deletion register survive every
 * restore.
 *
 * Fixed fields only: ids, times, bookmarks, counts and principals. No
 * message text, no names, no URLs. The SafetyStore class sends
 * `POST /recovery` here; nothing outside the worker reaches it. */
import { HttpError, json, readJson } from "./common";
import {
  checkedRecoveryPages,
  type RecoveryPages,
  checkedRecoveryPage,
  recoveryPageDigest,
  recoveryPageKey,
} from "./storage-recovery-pages";
import type { RecoverySnapshot } from "./storage-recovery-room";
import type { SafetyEnv } from "./safety";

type Storage = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "list" | "transaction"
>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A plan is good for one hour after it is made. */
export const RECOVERY_PLAN_TTL_MS = HOUR;
/** Undo stays possible for 24 hours after a restore. */
export const RECOVERY_UNDO_TTL_MS = DAY;
export const RECOVERY_AUDIT_TTL_MS = 400 * DAY;
/** Privacy deletions are replayed for any restore inside Cloudflare's 30-day
 * window; the register keeps them well past it. */
export const PRIVACY_REGISTER_TTL_MS = 400 * DAY;
/** Recovery calls per operator per hour. */
export const RECOVERY_RATE_PER_HOUR = 10;
const RESTORE_ID = /^[0-9a-f]{32}$/;
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const THREAD = /^tc-[0-9a-f]{32}$/;
const ISO = (at: number) => new Date(at).toISOString();

export type RecoveryBookmarks = {
  room: { target: string; current: string };
  partitions: {
    name: string;
    mode: "data" | "index";
    target: string;
    current: string;
    orphan: boolean;
  }[];
};
export type RecoveryPlan = {
  schemaVersion: 1;
  restoreId: string;
  workspace: string;
  at: number;
  createdAt: number;
  expiresAt: number;
  operator: string;
  bookmarks: RecoveryBookmarks;
};
/** What undo needs: the bookmarks taken just before the restore, and where
 * the restore got to. `restoring` and `reconciling` are an unfinished
 * restore; the operator repeats the call. `target` is the plan's bookmarks,
 * so a repeated call finishes the restore after its plan has expired. */
export type RecoveryUndo = {
  schemaVersion: 1;
  restoreId: string;
  workspace: string;
  at: number;
  createdAt: number;
  expiresAt: number;
  operator: string;
  room: string;
  preparedPages?: RecoveryPages;
  unlockPending?: boolean;
  partitions: { name: string; mode: "data" | "index"; bookmark: string }[];
  target: RecoveryBookmarks;
  state:
    | "preparing"
    | "undo-preparing"
    | "cancelled"
    | "restoring"
    | "reconciling"
    | "restored"
    | "undoing"
    | "undo-reconciling"
    | "undone";
};
export type RecoveryAuditEntry = {
  operator: string;
  workspace: string;
  restoreId: string;
  action: "plan" | "restore" | "undo" | "refused";
  result: string;
  counts: Record<string, number>;
};
export type PrivacyDeletion = { at: number; thread: string };

const planKey = (id: string) => `recovery-plan-v1:${id}`;
const undoKey = (id: string) => `recovery-undo-v1:${id}`;
const workspaceLockKey = (workspace: string) =>
  `recovery-workspace-v1:${workspace}`;
const snapshotKey = (id: string, op: string) =>
  `recovery-snapshot-v1:${id}:${op}`;
const transferKey = (id: string) => `recovery-transfer-v1:${id}`;
type Transfer = {
  pages: RecoveryPages;
  next: number;
  digest: string;
  expiresAt: number;
};
/** Largest stored access snapshot, as JSON. */
export const RECOVERY_SNAPSHOT_MAX_BYTES = 1_500_000;
const rateKey = (principal: string, hour: number) =>
  `recovery-rate-v1:${principal}:${hour}`;
const privacyPrefix = (workspace: string) =>
  `privacy-deletion-v1:${workspace}:`;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value);

/** `SafetyStore` side of `POST /recovery`. */
export async function recoveryStoreRoute(
  storage: Storage,
  request: Request,
  now = Date.now(),
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Not found." }, 404);
  try {
    const body = await readJson(request, 2_000_000);
    return json(await storage.transaction((local) => apply(local, body, now)));
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    return json({ error: "Recovery records are unavailable." }, 503);
  }
}

async function apply(
  storage: Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">,
  body: Record<string, unknown>,
  now: number,
): Promise<unknown> {
  switch (body.op) {
    case "rate": {
      if (typeof body.principal !== "string" || body.principal.length > 200)
        throw new HttpError(400, "Invalid operator.");
      const hour = Math.floor(now / HOUR);
      const key = rateKey(body.principal, hour);
      const used = (await storage.get<number>(key)) ?? 0;
      if (used >= RECOVERY_RATE_PER_HOUR) return { allowed: false };
      await storage.put(key, used + 1);
      // The previous hour's counter is no longer read.
      await storage.delete(rateKey(body.principal, hour - 1));
      return { allowed: true };
    }
    case "plan-put": {
      const plan = checkedPlan(body.plan);
      if (!plan) throw new HttpError(400, "Invalid recovery plan.");
      await storage.put(planKey(plan.restoreId), plan);
      return { ok: true };
    }
    case "plan-get": {
      if (!text(body.restoreId, RESTORE_ID)) return { plan: null };
      const plan = checkedPlan(
        await storage.get(planKey(body.restoreId as string)),
      );
      if (!plan || plan.expiresAt <= now) return { plan: null };
      return { plan };
    }
    case "undo-put": {
      const undo = checkedUndo(body.undo);
      if (!undo) throw new HttpError(400, "Invalid undo record.");
      const previous = checkedUndo(await storage.get(undoKey(undo.restoreId)));
      if (
        previous &&
        (previous.operator !== undo.operator ||
          previous.workspace !== undo.workspace ||
          (previous.unlockPending === true && undo.state !== previous.state) ||
          !UNDO_TRANSITIONS[previous.state].includes(undo.state))
      )
        throw new HttpError(
          409,
          "This recovery changed. Repeat the recovery call.",
        );
      const key = workspaceLockKey(undo.workspace);
      const lock = await storage.get<{ restoreId: string }>(key);
      if (lock && lock.restoreId !== undo.restoreId)
        throw new HttpError(409, "Finish the current recovery first.");
      if (inProgress(undo.state)) {
        const phase = undo.state.startsWith("undo") ? "undo" : "restore";
        await storage.put(key, {
          restoreId: undo.restoreId,
          op: `${undo.restoreId}:${phase}`,
          phase: undo.state.endsWith("preparing") ? "snapshot" : "restoring",
        });
      } else if (lock) await storage.delete(key);
      await storage.put(undoKey(undo.restoreId), undo);
      return { ok: true };
    }
    case "workspace-lock": {
      if (!text(body.workspace, WORKSPACE))
        throw new HttpError(400, "Invalid recovery workspace.");
      return {
        lock:
          (await storage.get(workspaceLockKey(body.workspace as string))) ??
          null,
      };
    }
    case "undo-get": {
      if (!text(body.restoreId, RESTORE_ID)) return { undo: null };
      const undo = checkedUndo(
        await storage.get(undoKey(body.restoreId as string)),
      );
      return {
        undo:
          undo &&
          (undo.expiresAt > now ||
            inProgress(undo.state) ||
            undo.unlockPending === true)
            ? undo
            : null,
      };
    }
    case "snapshot-put": {
      // Kept before any restore, so a retried call reconciles against the
      // access the workspace had right before it.
      if (
        !text(body.restoreId, RESTORE_ID) ||
        !["restore", "undo"].includes(body.phase as string) ||
        !body.snapshot ||
        typeof body.snapshot !== "object" ||
        JSON.stringify(body.snapshot).length > RECOVERY_SNAPSHOT_MAX_BYTES
      )
        throw new HttpError(400, "Invalid access snapshot.");
      const snapshot = body.snapshot as RecoverySnapshot;
      if (snapshot.keptPages) {
        const pages = checkedRecoveryPages(snapshot.keptPages);
        if (!pages.id.startsWith(`${body.restoreId}:${body.phase}:`))
          throw new HttpError(400, "Invalid access snapshot.");
        const progress = await storage.get<Transfer>(transferKey(pages.id));
        if (
          pages.pages
            ? !progress ||
              JSON.stringify(progress.pages) !== JSON.stringify(pages) ||
              progress.next !== pages.pages ||
              progress.digest !== pages.digest ||
              (progress.expiresAt <= now &&
                !(await activeRecovery(storage, body.restoreId as string)))
            : pages.digest !== "0".repeat(64)
        )
          throw new HttpError(
            409,
            "The recovery snapshot is incomplete or changed.",
          );
      }
      const key = snapshotKey(body.restoreId as string, body.phase as string);
      const existing = await storage.get<{ snapshot: RecoverySnapshot }>(key);
      if (
        existing &&
        JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)
      )
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      await storage.put(key, {
        expiresAt: now + RECOVERY_UNDO_TTL_MS,
        snapshot: body.snapshot,
      });
      return { ok: true };
    }
    case "snapshot-page-put": {
      const pages = checkedRecoveryPages(body.pages),
        page = checkedRecoveryPage(body.page);
      if (
        !text(body.restoreId, RESTORE_ID) ||
        !["restore", "undo"].includes(body.phase as string) ||
        !pages.id.startsWith(`${body.restoreId}:${body.phase}:`) ||
        !natural(body.index) ||
        body.index >= pages.pages
      )
        throw new HttpError(400, "Invalid recovery page.");
      const key = recoveryPageKey(pages.id, body.index);
      const progress = (await storage.get<Transfer>(transferKey(pages.id))) ?? {
        pages,
        next: 0,
        digest: "0".repeat(64),
        expiresAt: now + RECOVERY_UNDO_TTL_MS,
      };
      if (
        JSON.stringify(progress.pages) !== JSON.stringify(pages) ||
        body.index > progress.next
      )
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      const existing = await storage.get<{ page: string }>(key);
      if (existing && existing.page !== page)
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      if (!existing) {
        const expiresAt = now + RECOVERY_UNDO_TTL_MS;
        await storage.put(key, { page, expiresAt });
        await storage.put(
          `recovery-page-expiry-v1:${ISO(expiresAt)}:${pages.id}:${body.index}`,
          { pageKey: key, expiresAt },
        );
      }
      if (body.index === progress.next) {
        progress.digest = await recoveryPageDigest(progress.digest, page);
        progress.next++;
        if (progress.next === pages.pages && progress.digest !== pages.digest)
          throw new HttpError(
            409,
            "The recovery snapshot is incomplete or changed.",
          );
        await storage.put(transferKey(pages.id), progress);
      }
      return { ok: true };
    }
    case "snapshot-progress": {
      const pages = checkedRecoveryPages(body.pages);
      if (
        !text(body.restoreId, RESTORE_ID) ||
        !["restore", "undo"].includes(body.phase as string) ||
        !pages.id.startsWith(`${body.restoreId}:${body.phase}:`)
      )
        throw new HttpError(400, "Invalid recovery page.");
      const progress = await storage.get<Transfer>(transferKey(pages.id));
      if (progress && JSON.stringify(progress.pages) !== JSON.stringify(pages))
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      return { next: progress?.next ?? 0 };
    }
    case "snapshot-page-get": {
      if (
        !text(body.restoreId, RESTORE_ID) ||
        !["restore", "undo"].includes(body.phase as string)
      )
        throw new HttpError(400, "Invalid recovery page.");
      const pages = checkedRecoveryPages(body.pages);
      const saved = await storage.get<{
        snapshot: RecoverySnapshot;
        expiresAt: number;
      }>(snapshotKey(body.restoreId as string, body.phase as string));
      if (
        !saved ||
        (saved.expiresAt <= now &&
          !(await activeRecovery(storage, body.restoreId as string))) ||
        JSON.stringify(saved.snapshot.keptPages) !== JSON.stringify(pages) ||
        !natural(body.index) ||
        body.index >= pages.pages
      )
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      const row = await storage.get<{ page: string; expiresAt: number }>(
        recoveryPageKey(pages.id, body.index),
      );
      if (
        !row ||
        (row.expiresAt <= now &&
          !(await activeRecovery(storage, body.restoreId as string)))
      )
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      return { page: checkedRecoveryPage(row.page) };
    }
    case "snapshot-get": {
      if (
        !text(body.restoreId, RESTORE_ID) ||
        !["restore", "undo"].includes(body.phase as string)
      )
        return { snapshot: null };
      const row = await storage.get<{ expiresAt: number; snapshot: unknown }>(
        snapshotKey(body.restoreId as string, body.phase as string),
      );
      return {
        snapshot:
          row &&
          (row.expiresAt > now ||
            (await activeRecovery(storage, body.restoreId as string)))
            ? row.snapshot
            : null,
      };
    }
    case "audit": {
      const entry = checkedAudit(body.entry);
      if (!entry) throw new HttpError(400, "Invalid audit entry.");
      await storage.put(
        `recovery-audit-v1:${ISO(now)}:${entry.restoreId}:${entry.action}`,
        { ...entry, at: now, expiresAt: now + RECOVERY_AUDIT_TTL_MS },
      );
      await prune(storage, now);
      return { ok: true };
    }
    case "privacy-record": {
      if (
        !text(body.workspace, WORKSPACE) ||
        !text(body.thread, THREAD) ||
        !natural(body.at)
      )
        throw new HttpError(400, "Invalid privacy deletion.");
      await storage.put(
        `${privacyPrefix(body.workspace as string)}${ISO(body.at)}:${body.thread}`,
        {
          at: body.at,
          thread: body.thread,
          expiresAt: now + PRIVACY_REGISTER_TTL_MS,
        },
      );
      return { ok: true };
    }
    case "privacy-list": {
      if (!text(body.workspace, WORKSPACE) || !natural(body.after))
        throw new HttpError(400, "Invalid privacy register read.");
      const prefix = privacyPrefix(body.workspace as string);
      const rows = await storage.list<PrivacyDeletion>({
        prefix,
        // Keys sort by time: everything recorded at or after the restore point.
        start: `${prefix}${ISO(body.after as number)}`,
        ...(typeof body.cursor === "string" && body.cursor.startsWith(prefix)
          ? { startAfter: body.cursor }
          : {}),
        limit: 500,
      });
      // The caller follows every page before reconciling privacy deletions.
      const deletions: PrivacyDeletion[] = [];
      for (const row of rows.values())
        if (natural(row?.at) && text(row?.thread, THREAD))
          deletions.push({ at: row.at, thread: row.thread });
      return {
        complete: rows.size < 500,
        next: rows.size === 500 ? [...rows.keys()].at(-1) : null,
        deletions,
      };
    }
    default:
      throw new HttpError(400, "Unknown recovery operation.");
  }
}

const inProgress = (state: string) =>
  [
    "preparing",
    "restoring",
    "reconciling",
    "undo-preparing",
    "undoing",
    "undo-reconciling",
  ].includes(state);
async function activeRecovery(storage: Pick<Storage, "get">, id: string) {
  const record = checkedUndo(await storage.get(undoKey(id)));
  return (
    !!record && (inProgress(record.state) || record.unlockPending === true)
  );
}

/** Drops a page of each kind of expired record. */
async function prune(
  storage: Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">,
  now: number,
) {
  const pagePrefix = "recovery-page-expiry-v1:";
  const pageCursorKey = "recovery-prune-cursor-v1:pages";
  const cursor = await storage.get<string>(pageCursorKey);
  const expiredPages = await storage.list<{
    pageKey: string;
    expiresAt: number;
  }>({
    prefix: pagePrefix,
    end: `recovery-page-expiry-v1:${ISO(now + 1)}`,
    limit: 128,
    ...(cursor ? { startAfter: cursor } : {}),
  });
  if (expiredPages.size === 128)
    await storage.put(pageCursorKey, [...expiredPages.keys()].at(-1)!);
  else await storage.delete(pageCursorKey);
  for (const [key, row] of expiredPages) {
    const id = row?.pageKey?.split(":")[1];
    if (id && (await activeRecovery(storage, id))) continue;
    if (
      typeof row?.pageKey === "string" &&
      row.pageKey.startsWith("recovery-kept-page-v1:")
    )
      await storage.delete(row.pageKey);
    await storage.delete(key);
  }
  for (const prefix of [
    "recovery-audit-v1:",
    "privacy-deletion-v1:",
    "recovery-snapshot-v1:",
    "recovery-plan-v1:",
    "recovery-undo-v1:",
    "recovery-transfer-v1:",
  ]) {
    const cursorKey = `recovery-prune-cursor-v1:${prefix}`;
    const after = await storage.get<string>(cursorKey);
    const rows = await storage.list<{ expiresAt?: number }>({
      prefix,
      limit: 20,
      ...(after ? { startAfter: after } : {}),
    });
    if (rows.size === 20)
      await storage.put(cursorKey, [...rows.keys()].at(-1)!);
    else await storage.delete(cursorKey);
    for (const [key, row] of rows) {
      const id = key.split(":")[1];
      if (
        [
          "recovery-undo-v1:",
          "recovery-snapshot-v1:",
          "recovery-transfer-v1:",
        ].includes(prefix) &&
        (await activeRecovery(storage, id))
      )
        continue;
      if (!natural(row?.expiresAt) || row.expiresAt <= now)
        await storage.delete(key);
    }
  }
}

function checkedBookmarks(value: unknown): RecoveryBookmarks | null {
  const v = value as RecoveryBookmarks | null;
  if (
    !v ||
    typeof v.room?.target !== "string" ||
    typeof v.room?.current !== "string" ||
    !Array.isArray(v.partitions) ||
    v.partitions.some(
      (entry) =>
        typeof entry?.name !== "string" ||
        !["data", "index"].includes(entry.mode) ||
        typeof entry.target !== "string" ||
        typeof entry.current !== "string" ||
        typeof entry.orphan !== "boolean",
    )
  )
    return null;
  return v;
}
function checkedPlan(value: unknown): RecoveryPlan | null {
  const v = value as RecoveryPlan | null;
  return v &&
    v.schemaVersion === 1 &&
    text(v.restoreId, RESTORE_ID) &&
    text(v.workspace, WORKSPACE) &&
    natural(v.at) &&
    natural(v.createdAt) &&
    natural(v.expiresAt) &&
    typeof v.operator === "string" &&
    checkedBookmarks(v.bookmarks)
    ? v
    : null;
}
const UNDO_STATES = new Set([
  "preparing",
  "undo-preparing",
  "cancelled",
  "restoring",
  "reconciling",
  "restored",
  "undoing",
  "undo-reconciling",
  "undone",
]);
const UNDO_TRANSITIONS: Record<RecoveryUndo["state"], RecoveryUndo["state"][]> =
  {
    preparing: ["preparing", "restoring", "cancelled"],
    restoring: ["restoring", "reconciling", "cancelled"],
    reconciling: ["reconciling", "restoring", "restored"],
    restored: ["restored", "undo-preparing"],
    "undo-preparing": ["undo-preparing", "undoing", "cancelled"],
    undoing: ["undoing", "undo-reconciling", "cancelled"],
    "undo-reconciling": ["undo-reconciling", "undoing", "undone"],
    undone: ["undone"],
    cancelled: ["cancelled"],
  };
function validPreparedPages(value: unknown, id: string) {
  try {
    return checkedRecoveryPages(value).id.startsWith(`${id}:`);
  } catch {
    return false;
  }
}
function checkedUndo(value: unknown): RecoveryUndo | null {
  const v = value as RecoveryUndo | null;
  return v &&
    v.schemaVersion === 1 &&
    text(v.restoreId, RESTORE_ID) &&
    text(v.workspace, WORKSPACE) &&
    natural(v.at) &&
    natural(v.createdAt) &&
    natural(v.expiresAt) &&
    typeof v.operator === "string" &&
    typeof v.room === "string" &&
    (v.unlockPending === undefined || typeof v.unlockPending === "boolean") &&
    (v.preparedPages === undefined ||
      validPreparedPages(v.preparedPages, v.restoreId)) &&
    Array.isArray(v.partitions) &&
    v.partitions.every(
      (entry) =>
        typeof entry?.name === "string" &&
        ["data", "index"].includes(entry.mode) &&
        typeof entry.bookmark === "string",
    ) &&
    checkedBookmarks(v.target) &&
    UNDO_STATES.has(v.state)
    ? v
    : null;
}
function checkedAudit(value: unknown): RecoveryAuditEntry | null {
  const v = value as RecoveryAuditEntry | null;
  return v &&
    typeof v.operator === "string" &&
    text(v.workspace, WORKSPACE) &&
    text(v.restoreId, RESTORE_ID) &&
    ["plan", "restore", "undo", "refused"].includes(v.action) &&
    typeof v.result === "string" &&
    /^[a-z-]{1,40}$/.test(v.result) &&
    v.counts &&
    typeof v.counts === "object" &&
    Object.entries(v.counts).every(
      ([key, count]) => /^[a-zA-Z]{1,40}$/.test(key) && natural(count),
    )
    ? {
        operator: v.operator,
        workspace: v.workspace,
        restoreId: v.restoreId,
        action: v.action,
        result: v.result,
        counts: v.counts,
      }
    : null;
}

/** Calls the store. Throws 503 when it cannot answer. */
export async function recoveryStore<T>(
  env: Pick<SafetyEnv, "SAFETY_STORE">,
  body: Record<string, unknown>,
): Promise<T> {
  if (!env.SAFETY_STORE)
    throw new HttpError(503, "Recovery records are unavailable.");
  const response = await env.SAFETY_STORE.get(
    env.SAFETY_STORE.idFromName("templ-platform-safety:v1"),
  ).fetch(
    new Request("https://internal/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      response.status === 400 ? 400 : 503,
      "Recovery records are unavailable.",
    );
  }
  return response.json<T>();
}

/** Records a thread's privacy deletion, so a restore to an earlier time deletes it again
 * before it reports success. Ids and the time only. It must succeed before
 * the deletion is reported done; a caller that cannot record it keeps the
 * request open. */
export async function recordPrivacyDeletion(
  env: Pick<SafetyEnv, "SAFETY_STORE">,
  entry: { workspace: string; thread: string; at?: number },
): Promise<void> {
  await recoveryStore(env, {
    op: "privacy-record",
    workspace: entry.workspace,
    thread: entry.thread,
    at: entry.at ?? Date.now(),
  });
}
