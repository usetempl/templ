/** Storage recovery tool: `POST /operator/recovery/{plan,restore,undo}`.
 *
 * Restores one workspace (its room and every support partition the room
 * names) to a time T in Cloudflare's 30-day point-in-time window. Sign-in
 * records, safety reports and holds, feedback, subscriptions, cost metrics
 * and media quotas are never restored: sessions come back by signing in, and
 * holds and legal records never roll back. The widget settings object
 * (allowed websites and the access level) is not restored either, so a
 * website removed after T stays removed. The support knowledge object
 * (profile, knowledge sources, eval cases and the managed AI spend meter) is
 * not restored: a spend meter never rolls back and eval copies deleted after
 * T stay deleted. Inside the room, counters, billing records, switches and
 * alert destinations follow `storage-recovery-keys.ts`. A workspace set to be
 * deleted is refused: a restore would bring it back.
 *
 * Operator only, and it grants no ticket access: every check below must
 * pass, in order, and the tool answers 404 until it is configured.
 * 1. `RECOVERY_ADMIN_TOKEN` is 64 lowercase hex and `RECOVERY_OPERATOR_PRINCIPALS`
 *    names one to three principals, each also a Templ operator.
 * 2. `Authorization: Bearer <token>` matches (constant-time digest compare).
 * 3. The current session belongs to a recovery operator (a widget session
 *    never reaches here: its session read fails outside the widget).
 * 4. `Origin` is the app origin.
 * 5. At most ten calls per operator per hour.
 * 6. Restore and undo need a valid wallet session and `confirmed: true`, and
 *    refuse while a legal hold covers the workspace.
 *
 * After a restore, access is the intersection of the restored state and the
 * access right before it, restrictions are their union, and threads deleted
 * for a privacy request after T are deleted again before success is
 * reported (`storage-recovery-room.ts`). */
import { HttpError, json, readJson, siteOrigins, type Env } from "./common";
import type { AuthMethod, ChatPrincipalId } from "@templ/chat/principal";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import { principalList } from "./principal";
import { requireWalletAuth } from "./privileged-auth";
import { readRetentionHolds, safetyDigest, type SafetyEnv } from "./safety";
import { servicePrincipals } from "./service-principals";
import {
  recoveryStore,
  RECOVERY_PLAN_TTL_MS,
  RECOVERY_UNDO_TTL_MS,
  type RecoveryBookmarks,
  type RecoveryPlan,
  type RecoveryUndo,
  type RecoveryAuditEntry,
  type PrivacyDeletion,
} from "./storage-recovery-store";
import type {
  RecoverySnapshot,
  ReconcileCounts,
} from "./storage-recovery-room";

export type RecoveryEnv = Env &
  OperatorAdminEnv &
  SafetyEnv & {
    /** Worker secret: 64 lowercase hex. Required with the principals var. */
    RECOVERY_ADMIN_TOKEN?: string;
    /** Plain var: one to three canonical principals, each also in
     * `CONTACT_ADMIN_PRINCIPALS`. Empty turns the tool off. */
    RECOVERY_OPERATOR_PRINCIPALS?: string;
  };
export type RecoverySession = {
  principalId: ChatPrincipalId;
  servicePrincipals: ChatPrincipalId[];
  authenticatedAt?: number;
  authMethod?: AuthMethod;
};
export type RecoveryDeps = {
  session: () => Promise<RecoverySession>;
  now?: () => number;
};

const DAY = 86_400_000;
/** Cloudflare keeps 30 days. A plan must still be inside it when its
 * restore is repeated from the undo record, up to a day and an hour later. */
export const RECOVERY_WINDOW_MS =
  30 * DAY - RECOVERY_PLAN_TTL_MS - RECOVERY_UNDO_TTL_MS;
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESTORE_ID = /^[0-9a-f]{32}$/;
// Each call stays within the provider's subrequest budget. Stored progress
// lets the next confirmed call continue without a workspace-size ceiling.
const PAGES_PER_CALL = 128;
type RecoveryPending = {
  restoreId: string;
  pending: true;
  phase: "copying" | "reconciling";
  pagesDone: number;
  pagesTotal: number;
};
const ROUTES = new Set(["plan", "restore", "undo", "cancel"]);
const notFound = () => new HttpError(404, "Not found.");

/** The recovery operators, or none when the var is empty, too long, or names
 * someone who is not also a Templ operator (a misconfiguration turns the
 * tool off instead of widening it). */
export function recoveryOperators(env: RecoveryEnv): ChatPrincipalId[] {
  const operators = principalList(env.RECOVERY_OPERATOR_PRINCIPALS);
  if (!operators.length || operators.length > 3) return [];
  return operators.every((id) => isOperatorAdmin(env, id, [id]))
    ? operators
    : [];
}
/** True for a recovery operator (alias-aware). Other operator tools that
 * need the same person, such as a reviewed reset, call this. */
export function isRecoveryOperator(
  env: RecoveryEnv,
  actor: ChatPrincipalId,
  aliases: unknown = [actor],
): boolean {
  const operators = recoveryOperators(env);
  return (
    operators.length > 0 &&
    isOperatorAdmin(env, actor, aliases) &&
    servicePrincipals(actor, aliases).some((id) => operators.includes(id))
  );
}
export function recoveryConfigured(env: RecoveryEnv): boolean {
  return (
    /^[0-9a-f]{64}$/.test(env.RECOVERY_ADMIN_TOKEN ?? "") &&
    recoveryOperators(env).length > 0 &&
    Boolean(env.SAFETY_STORE) &&
    Boolean(env.ROOMS)
  );
}
async function tokenMatches(request: Request, env: RecoveryEnv) {
  const actual = await safetyDigest(request.headers.get("Authorization") ?? "");
  const expected = await safetyDigest(`Bearer ${env.RECOVERY_ADMIN_TOKEN}`);
  let different = 0;
  for (let i = 0; i < actual.length; i++)
    different |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return different === 0;
}
function restoreId() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Worker route. Null for any other path. */
export async function handleRecoveryRoute(
  request: Request,
  env: RecoveryEnv,
  deps: RecoveryDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/operator\/recovery(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return null;
  // 1. Off until configured; any other path or method is not here either.
  if (
    !recoveryConfigured(env) ||
    !ROUTES.has(match[1] ?? "") ||
    request.method !== "POST"
  )
    throw notFound();
  // 2. The admin token.
  if (!(await tokenMatches(request, env))) throw notFound();
  // The body is read before the session, as every other write route does.
  const body = await readJson(request, 4_096);
  // 3. A recovery operator's own current session.
  const session = await deps.session();
  if (!isRecoveryOperator(env, session.principalId, session.servicePrincipals))
    throw new HttpError(403, "Only the recovery operator can run this.");
  // 4. From the app itself.
  if (request.headers.get("Origin") !== siteOrigins(env).appOrigin)
    throw new HttpError(403, "Open the recovery tool from Templ.");
  // 5. The hourly allowance.
  const rate = await recoveryStore<{ allowed: boolean }>(env, {
    op: "rate",
    principal: session.principalId,
  });
  if (!rate.allowed)
    throw new HttpError(
      429,
      "Too many recovery calls this hour. Try again later.",
      3600,
    );
  const now = deps.now?.() ?? Date.now();
  if (match[1] === "plan") return json(await plan(env, session, body, now));
  // 6. Restores change stored data: a valid signed-in session and confirmation.
  requireWalletAuth(session, body.confirmed, now);
  if (match[1] === "cancel")
    return json(await cancelPreparation(env, session, body));
  const result =
    match[1] === "restore"
      ? await restore(env, session, body, now)
      : await undo(env, session, body, now);
  return json(result, "pending" in result ? 202 : 200);
}

// ---------------------------------------------------------------------------
// Object calls

type Stub = { fetch(request: Request): Promise<Response> };
function roomStub(env: RecoveryEnv, workspace: string): Stub {
  // A new stub each call: after an abort the old one may be broken.
  return env.ROOMS.get(env.ROOMS.idFromName(`native-room:${workspace}`));
}
function partitionStub(env: RecoveryEnv, object: string, name: string): Stub {
  if (!env.SUPPORT_PARTITIONS)
    throw new HttpError(503, "Support history storage is unavailable.");
  return env.SUPPORT_PARTITIONS.get(
    env.SUPPORT_PARTITIONS.idFromName(`${object}:${name}`),
  );
}
async function call<T>(stub: Stub, step: string, body: object): Promise<T> {
  let response: Response;
  try {
    response = await stub.fetch(
      new Request(`https://internal/private/recovery/${step}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    throw new HttpError(503, "Workspace storage did not answer. Try again.");
  }
  if (!response.ok) {
    const error = await response
      .json<{ error?: unknown; reason?: unknown }>()
      .catch(() => null);
    throw new HttpError(
      [400, 404, 409].includes(response.status) ? response.status : 503,
      typeof error?.error === "string"
        ? error.error
        : "Workspace storage did not answer. Try again.",
      undefined,
      typeof error?.reason === "string" ? error.reason : undefined,
    );
  }
  return response.json<T>();
}
/** The object restarts on the restored state; its answer (usually an error,
 * since the abort ends the request) is expected and ignored. */
async function abort(stub: Stub, body: object = {}) {
  try {
    const response = await stub.fetch(
      new Request("https://internal/private/recovery/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    await response.body?.cancel();
  } catch {
    // Expected: the object ended the request when it aborted.
  }
}
/** Runs `task` over `items` a few at a time. */
async function each<T, R>(
  items: T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

async function legalHold(env: RecoveryEnv, workspace: string) {
  const holds = await readRetentionHolds(env, `room:${workspace}`);
  // Unknown counts as held: nothing is restored over a hold.
  return !holds || holds.room || holds.threads.size > 0;
}
async function audit(env: RecoveryEnv, entry: RecoveryAuditEntry) {
  await recoveryStore(env, { op: "audit", entry });
}

type Inventory = {
  object: string;
  capability: string | null;
  partitions: { name: string; mode: "data" | "index" }[];
  closing?: boolean;
};
const closingError = () =>
  new HttpError(
    409,
    "This workspace is set to be deleted. Cancel the deletion before restoring it.",
    undefined,
    "workspace-closing",
  );
type PartitionIdentity = {
  room: string;
  capability: string;
  partition: string;
  mode: "data" | "index";
};
const identity = (
  inventory: { object: string; capability: string },
  partition: { name: string; mode: "data" | "index" },
): PartitionIdentity => ({
  room: inventory.object,
  capability: inventory.capability,
  partition: partition.name,
  mode: partition.mode,
});

// ---------------------------------------------------------------------------
// Plan

async function plan(
  env: RecoveryEnv,
  session: RecoverySession,
  body: Record<string, unknown>,
  now: number,
) {
  const workspace = body.workspace;
  if (typeof workspace !== "string" || !WORKSPACE.test(workspace))
    throw new HttpError(400, "Name the workspace to restore.");
  const at = typeof body.at === "string" ? Date.parse(body.at) : Number.NaN;
  if (!Number.isFinite(at) || at > now || at < now - RECOVERY_WINDOW_MS)
    throw new HttpError(
      400,
      "Choose a time in the last 28 days, not in the future.",
    );
  const inventory = await call<Inventory>(
    roomStub(env, workspace),
    "inventory",
    {},
  );
  if (inventory.closing !== false) throw closingError();
  if (inventory.partitions.length && !inventory.capability)
    throw new HttpError(503, "Support history storage is unavailable.");
  const room = await call<{ target: string; current: string }>(
    roomStub(env, workspace),
    "bookmark",
    { at },
  );
  const partitions = (
    await each(inventory.partitions, async (partition) => {
      const answer = await call<{
        exists: boolean;
        target?: string | null;
        current?: string;
        createdAt?: number | null;
      }>(partitionStub(env, inventory.object, partition.name), "bookmark", {
        ...identity(
          { object: inventory.object, capability: inventory.capability! },
          partition,
        ),
        at,
      });
      if (!answer.exists) return null;
      // Made after T: nothing in it existed at T.
      const orphan =
        typeof answer.createdAt === "number"
          ? answer.createdAt > at
          : !answer.target;
      return {
        name: partition.name,
        mode: partition.mode,
        target: answer.target ?? "",
        current: answer.current ?? "",
        orphan,
      };
    })
  ).filter((entry) => entry !== null);
  const bookmarks: RecoveryBookmarks = { room, partitions };
  const id = restoreId();
  const record: RecoveryPlan = {
    schemaVersion: 1,
    restoreId: id,
    workspace,
    at,
    createdAt: now,
    expiresAt: now + RECOVERY_PLAN_TTL_MS,
    operator: session.principalId,
    bookmarks,
  };
  await recoveryStore(env, { op: "plan-put", plan: record });
  const orphanPartitions = partitions.filter((entry) => entry.orphan).length;
  const held = await legalHold(env, workspace);
  await audit(env, {
    operator: session.principalId,
    workspace,
    restoreId: id,
    action: "plan",
    result: "planned",
    counts: { partitions: partitions.length, orphanPartitions },
  });
  return {
    restoreId: id,
    at: new Date(at).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    room,
    partitions: partitions.map(({ name, target, current, orphan }) => ({
      name,
      target,
      current,
      orphan,
    })),
    // Never restored (see the top of this file).
    knowledge: null,
    orphanPartitions,
    legalHold: held,
  };
}

// ---------------------------------------------------------------------------
// Restore and undo

async function readPlan(env: RecoveryEnv, id: unknown) {
  if (typeof id !== "string" || !RESTORE_ID.test(id))
    throw new HttpError(
      409,
      "This plan has expired. Make a new one.",
      undefined,
      "plan-expired",
    );
  const { plan } = await recoveryStore<{ plan: RecoveryPlan | null }>(env, {
    op: "plan-get",
    restoreId: id,
  });
  if (!plan)
    throw new HttpError(
      409,
      "This plan has expired. Make a new one.",
      undefined,
      "plan-expired",
    );
  return plan;
}
async function readUndo(env: RecoveryEnv, id: string) {
  return (
    await recoveryStore<{ undo: RecoveryUndo | null }>(env, {
      op: "undo-get",
      restoreId: id,
    })
  ).undo;
}
async function saveUndo(env: RecoveryEnv, undo: RecoveryUndo) {
  await recoveryStore(env, { op: "undo-put", undo });
}
async function privacyDeletions(
  env: RecoveryEnv,
  workspace: string,
  at: number,
) {
  const deletions = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const register = await recoveryStore<{
      complete: boolean;
      next?: string | null;
      deletions: PrivacyDeletion[];
    }>(env, { op: "privacy-list", workspace, after: at, cursor });
    for (const entry of register.deletions) deletions.add(entry.thread);
    if (register.complete) return [...deletions];
    if (!register.next || register.next === cursor)
      throw new HttpError(503, "The privacy-deletion register is incomplete.");
    cursor = register.next;
  }
}
const notApplied = () =>
  new HttpError(
    500,
    "The restore did not take effect. Repeat the call.",
    undefined,
    "restore-not-applied",
  );
/** Locks the room on its restored state, trying three times. False when the
 * room still carries this step's marker, so the restore did not apply. */
async function lockRoom(
  env: RecoveryEnv,
  workspace: string,
  op: string,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (
        await call<{ applied: boolean }>(roomStub(env, workspace), "lock", {
          op,
        })
      ).applied;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}
/** Restores the room, then confirms its lock. SafetyStore keeps a separate
 * lock across the rollback and restart. The room checks it before serving
 * requests, sockets or timed jobs. Abort also runs after a failed call, so
 * a registered restore takes effect while recovery still holds access. */
async function restoreRoom(
  env: RecoveryEnv,
  workspace: string,
  bookmark: string,
  op: string,
) {
  let failure: unknown = null;
  try {
    await call(roomStub(env, workspace), "restore", { bookmark });
  } catch (error) {
    failure = error;
  }
  await abort(roomStub(env, workspace));
  if (await lockRoom(env, workspace, op)) return;
  // Not applied: the room is as it was, and a repeated call restores again.
  throw failure instanceof HttpError
    ? new HttpError(
        failure.status,
        failure.message,
        undefined,
        "restore-not-applied",
      )
    : notApplied();
}
/** Re-deletes, reconciles and unlocks a locked room. A room whose lock
 * could not be confirmed is locked first. Once locked, the room stays
 * locked (members and staff get 503, timed jobs wait) if any later part
 * fails, until the call is repeated. */
async function finish(
  env: RecoveryEnv,
  input: {
    workspace: string;
    at: number;
    id: string;
    phase: "restore" | "undo";
    locked: boolean;
    operator: ChatPrincipalId;
    authenticatedAt: number;
  },
): Promise<ReconcileCounts | RecoveryPending> {
  const op = `${input.id}:${input.phase}`;
  if (!input.locked && !(await lockRoom(env, input.workspace, op)))
    throw notApplied();
  try {
    const snapshot = await storedSnapshot(env, input.id, input.phase);
    const deletions = await privacyDeletions(env, input.workspace, input.at);
    if (snapshot.keptPages) {
      const { next } = await call<{ next: number }>(
        roomStub(env, input.workspace),
        "stage-status",
        { pages: snapshot.keptPages },
      );
      const end = Math.min(snapshot.keptPages.pages, next + PAGES_PER_CALL);
      for (let index = next; index < end; index++) {
        const { page } = await recoveryStore<{ page: string }>(env, {
          op: "snapshot-page-get",
          restoreId: input.id,
          phase: input.phase,
          pages: snapshot.keptPages,
          index,
        });
        await call(roomStub(env, input.workspace), "stage-page", {
          pages: snapshot.keptPages,
          index,
          page,
        });
      }
      if (end < snapshot.keptPages.pages)
        return {
          restoreId: input.id,
          pending: true,
          phase: "reconciling",
          pagesDone: end,
          pagesTotal: snapshot.keptPages.pages,
        };
    }
    return (
      await call<{ reconciled: ReconcileCounts }>(
        roomStub(env, input.workspace),
        "reconcile",
        {
          op,
          snapshot,
          deletions,
          operator: input.operator,
          authenticatedAt: input.authenticatedAt,
          deferUnlock: true,
        },
      )
    ).reconciled;
  } catch (error) {
    throw new HttpError(
      500,
      error instanceof HttpError
        ? `The workspace stays closed: ${error.message}`
        : "The workspace stays closed until the restore is repeated.",
      undefined,
      "restore-incomplete",
    );
  }
}
async function storedSnapshot(
  env: RecoveryEnv,
  id: string,
  phase: "restore" | "undo",
): Promise<RecoverySnapshot> {
  const { snapshot } = await recoveryStore<{
    snapshot: RecoverySnapshot | null;
  }>(env, { op: "snapshot-get", restoreId: id, phase });
  if (!snapshot)
    throw new HttpError(
      500,
      "The access snapshot for this restore is missing.",
      undefined,
      "restore-incomplete",
    );
  return snapshot;
}
/** Takes and keeps the access snapshot, then marks the room and returns
 * the bookmarks that bring every object back to right now. */
async function prepare(
  env: RecoveryEnv,
  input: {
    workspace: string;
    id: string;
    phase: "restore" | "undo";
    partitions: { name: string; mode: "data" | "index" }[];
    inventory: { object: string; capability: string } | null;
  },
) {
  const snapshot = await call<RecoverySnapshot>(
    roomStub(env, input.workspace),
    "snapshot",
    { op: `${input.id}:${input.phase}` },
  );
  if (snapshot.keptPages) {
    const { next } = await recoveryStore<{ next: number }>(env, {
      op: "snapshot-progress",
      restoreId: input.id,
      phase: input.phase,
      pages: snapshot.keptPages,
    });
    const end = Math.min(snapshot.keptPages.pages, next + PAGES_PER_CALL);
    for (let index = next; index < end; index++) {
      let page: string;
      try {
        ({ page } = await call<{ page: string }>(
          roomStub(env, input.workspace),
          "snapshot-page",
          { pages: snapshot.keptPages, index },
        ));
      } catch {
        ({ page } = await recoveryStore<{ page: string }>(env, {
          op: "snapshot-page-get",
          restoreId: input.id,
          phase: input.phase,
          pages: snapshot.keptPages,
          index,
        }));
      }
      await recoveryStore(env, {
        op: "snapshot-page-put",
        restoreId: input.id,
        phase: input.phase,
        pages: snapshot.keptPages,
        index,
        page,
      });
    }
    if (end < snapshot.keptPages.pages)
      return {
        restoreId: input.id,
        pending: true as const,
        phase: "copying" as const,
        pagesDone: end,
        pagesTotal: snapshot.keptPages.pages,
      };
  }
  await recoveryStore(env, {
    op: "snapshot-put",
    restoreId: input.id,
    phase: input.phase,
    snapshot,
  });
  if (snapshot.keptPages)
    await call(roomStub(env, input.workspace), "snapshot-clear", {
      pages: snapshot.keptPages,
    });
  const partitions = await each(input.partitions, async (partition) => {
    const answer = await call<{ exists: boolean; current?: string }>(
      partitionStub(env, input.inventory!.object, partition.name),
      "current",
      identity(input.inventory!, partition),
    );
    return answer.exists && answer.current
      ? { ...partition, bookmark: answer.current }
      : null;
  });
  const marked = await call<{ current: string }>(
    roomStub(env, input.workspace),
    "mark",
    { op: `${input.id}:${input.phase}` },
  );
  return {
    room: marked.current,
    preparedPages: snapshot.keptPages,
    partitions: partitions.filter((entry) => entry !== null),
  };
}

type RestoreTarget = {
  restoreId: string;
  workspace: string;
  at: number;
  operator: string;
  bookmarks: RecoveryBookmarks;
};
/** A named partition the plan does not know holds support history written
 * after the plan: the plan is refused instead of leaving it unrestored and
 * unreferenced. */
async function refuseStalePlan(
  env: RecoveryEnv,
  planned: RestoreTarget,
  read: Inventory,
) {
  const known = new Set(
    planned.bookmarks.partitions.map((entry) => entry.name),
  );
  const extra = read.partitions.filter((entry) => !known.has(entry.name));
  if (!extra.length) return false;
  if (!read.capability)
    throw new HttpError(503, "Support history storage is unavailable.");
  const inventory = { object: read.object, capability: read.capability };
  const live = await each(extra, (partition) =>
    call<{ exists: boolean }>(
      partitionStub(env, read.object, partition.name),
      "current",
      identity(inventory, partition),
    ),
  );
  return live.some((answer) => answer.exists);
}

async function restore(
  env: RecoveryEnv,
  session: RecoverySession,
  body: Record<string, unknown>,
  now: number,
) {
  const started = Date.now();
  if (typeof body.restoreId !== "string" || !RESTORE_ID.test(body.restoreId))
    throw new HttpError(
      409,
      "This plan has expired. Make a new one.",
      undefined,
      "plan-expired",
    );
  let record = await readUndo(env, body.restoreId);
  if (
    record?.state === "restored" &&
    record.unlockPending === true &&
    record.operator === session.principalId &&
    body.confirm === record.workspace
  ) {
    await call(roomStub(env, record.workspace), "unlock", {
      op: `${record.restoreId}:restore`,
    });
    await saveUndo(env, {
      ...record,
      unlockPending: false,
      expiresAt: Date.now() + RECOVERY_UNDO_TTL_MS,
    });
    return { restoreId: record.restoreId, completed: true };
  }
  if (
    record &&
    !["preparing", "restoring", "reconciling"].includes(record.state)
  )
    throw new HttpError(
      409,
      "This plan was already used.",
      undefined,
      "already-restored",
    );
  // A restore already under way finishes from its own record, which keeps
  // the plan's bookmarks for a day: its plan may have expired meanwhile.
  const planned: RestoreTarget = record
    ? {
        restoreId: record.restoreId,
        workspace: record.workspace,
        at: record.at,
        operator: record.operator,
        bookmarks: record.target,
      }
    : await readPlan(env, body.restoreId);
  if (planned.operator !== session.principalId)
    throw new HttpError(
      403,
      "Only the operator who made this plan can run it.",
    );
  if (body.confirm !== planned.workspace)
    throw new HttpError(400, "Type the workspace id to confirm the restore.");
  const id = planned.restoreId;
  const refuse = async (result: string, error: HttpError) => {
    await audit(env, {
      operator: session.principalId,
      workspace: planned.workspace,
      restoreId: id,
      action: "refused",
      result,
      counts: {},
    });
    throw error;
  };
  // Once the room restore has started, the reconcile only removes authority,
  // so it finishes even under a hold placed meanwhile; any later deletion
  // still checks holds in the retention sweep.
  const reconciling = record?.state === "reconciling";
  if (!reconciling && (await legalHold(env, planned.workspace)))
    return refuse(
      "legal-hold",
      new HttpError(
        409,
        "A legal hold covers this workspace.",
        undefined,
        "legal-hold",
      ),
    );
  const orphans = planned.bookmarks.partitions.filter((entry) => entry.orphan);
  if (orphans.length && body.allowOrphanDelete !== true)
    return refuse(
      "orphans",
      new HttpError(
        409,
        `${orphans.length} storage parts were made after that time and would be deleted. Confirm with allowOrphanDelete.`,
        undefined,
        "orphans",
      ),
    );
  const kept = planned.bookmarks.partitions.filter((entry) => !entry.orphan);
  const op = `${id}:restore`;
  let inventory: { object: string; capability: string } | null = null;
  if (!reconciling) {
    const read = await call<Inventory>(
      roomStub(env, planned.workspace),
      "inventory",
      {},
    );
    if (read.closing !== false)
      return refuse("workspace-closing", closingError());
    if (
      (!record || record.state === "preparing") &&
      (await refuseStalePlan(env, planned, read))
    )
      return refuse(
        "plan-stale",
        new HttpError(
          409,
          "Support history changed after this plan was made. Make a new plan.",
          undefined,
          "plan-stale",
        ),
      );
    if (planned.bookmarks.partitions.length) {
      if (!read.capability)
        throw new HttpError(503, "Support history storage is unavailable.");
      inventory = { object: read.object, capability: read.capability };
    }
  }
  if (!record) {
    record = {
      schemaVersion: 1,
      restoreId: id,
      workspace: planned.workspace,
      at: planned.at,
      createdAt: now,
      expiresAt: now + RECOVERY_UNDO_TTL_MS,
      operator: session.principalId,
      room: planned.bookmarks.room.current,
      partitions: [],
      target: planned.bookmarks,
      state: "preparing",
    };
    await saveUndo(env, record);
  }
  if (record.state === "preparing") {
    const bookmarks = await prepare(env, {
      workspace: planned.workspace,
      id,
      phase: "restore",
      partitions: kept,
      inventory,
    });
    if ("pending" in bookmarks) return bookmarks;
    record = {
      ...record,
      room: bookmarks.room,
      partitions: bookmarks.partitions,
      preparedPages: bookmarks.preparedPages,
      state: "restoring",
    };
    await saveUndo(env, record);
  }
  let orphansDeleted = 0;
  let locked = false;
  let reconciled: ReconcileCounts | RecoveryPending;
  try {
    if (record.state === "restoring") {
      if (record.preparedPages)
        await call(roomStub(env, planned.workspace), "begin", {
          op,
          pages: record.preparedPages,
        });
      // Partitions first, so the room restarts over history from the same time.
      await each(kept, async (partition) => {
        const stub = () =>
          partitionStub(env, inventory!.object, partition.name);
        const who = identity(inventory!, partition);
        await call(stub(), "restore", { ...who, bookmark: partition.target });
        await abort(stub(), who);
      });
      await each(orphans, async (partition) => {
        await call(
          partitionStub(env, inventory!.object, partition.name),
          "delete-orphan",
          identity(inventory!, partition),
        );
        orphansDeleted++;
      });
      // Recorded before the room restore: from here a repeated call only
      // locks, reconciles and unlocks.
      record = { ...record, state: "reconciling" };
      await saveUndo(env, record);
      await restoreRoom(
        env,
        planned.workspace,
        planned.bookmarks.room.target,
        op,
      );
      locked = true;
    }
    reconciled = await finish(env, {
      workspace: planned.workspace,
      at: planned.at,
      id,
      phase: "restore",
      locked,
      operator: session.principalId,
      authenticatedAt: session.authenticatedAt!,
    });
    if ("pending" in reconciled) return reconciled;
  } catch (error) {
    if (error instanceof HttpError && error.reason === "restore-not-applied")
      await saveUndo(env, { ...record, state: "restoring" });
    await audit(env, {
      operator: session.principalId,
      workspace: planned.workspace,
      restoreId: id,
      action: "restore",
      result:
        error instanceof HttpError && error.reason ? error.reason : "failed",
      counts: {},
    });
    throw error;
  }
  record = {
    ...record,
    state: "restored",
    unlockPending: true,
    expiresAt: Date.now() + RECOVERY_UNDO_TTL_MS,
  };
  await saveUndo(env, record);
  await call(roomStub(env, planned.workspace), "unlock", { op });
  record = {
    ...record,
    unlockPending: false,
    expiresAt: Date.now() + RECOVERY_UNDO_TTL_MS,
  };
  await saveUndo(env, record);
  await audit(env, {
    operator: session.principalId,
    workspace: planned.workspace,
    restoreId: id,
    action: "restore",
    result: "restored",
    counts: { ...reconciled, orphansDeleted, partitions: kept.length },
  });
  return {
    restoreId: id,
    undo: {
      until: new Date(record.expiresAt).toISOString(),
      partitions: record.partitions.length,
    },
    reconciled,
    orphansDeleted,
    durationMs: Date.now() - started,
  };
}

async function undo(
  env: RecoveryEnv,
  session: RecoverySession,
  body: Record<string, unknown>,
  now: number,
) {
  const started = Date.now();
  const id = body.restoreId;
  if (typeof id !== "string" || !RESTORE_ID.test(id))
    throw new HttpError(409, "Nothing to undo.", undefined, "undo-expired");
  let record = await readUndo(env, id);
  if (!record)
    throw new HttpError(
      409,
      "This restore can no longer be undone.",
      undefined,
      "undo-expired",
    );
  if (record.state === "undone" && record.unlockPending === true) {
    await call(roomStub(env, record.workspace), "unlock", {
      op: `${record.restoreId}:undo`,
    });
    await saveUndo(env, { ...record, unlockPending: false });
    return { restoreId: record.restoreId, completed: true };
  }
  if (record.unlockPending === true)
    throw new HttpError(409, "Finish the current recovery before undoing it.");
  if (
    !["restored", "undo-preparing", "undoing", "undo-reconciling"].includes(
      record.state,
    )
  )
    throw new HttpError(
      409,
      "This restore can't be undone now.",
      undefined,
      "undo-unavailable",
    );
  // As for a restore: once the room restore started, the undo finishes.
  const reconciling = record.state === "undo-reconciling";
  if (!reconciling && (await legalHold(env, record.workspace)))
    throw new HttpError(
      409,
      "A legal hold covers this workspace.",
      undefined,
      "legal-hold",
    );
  const op = `${id}:undo`;
  let inventory: { object: string; capability: string } | null = null;
  if (!reconciling) {
    const read = await call<Inventory>(
      roomStub(env, record.workspace),
      "inventory",
      {},
    );
    if (read.closing !== false) throw closingError();
    if (record.partitions.length) {
      if (!read.capability)
        throw new HttpError(503, "Support history storage is unavailable.");
      inventory = { object: read.object, capability: read.capability };
    }
  }
  if (record.state === "restored") {
    record = { ...record, state: "undo-preparing" };
    await saveUndo(env, record);
  }
  if (record.state === "undo-preparing") {
    // Only the snapshot and the marker: undo itself cannot be undone.
    const preparation = await prepare(env, {
      workspace: record.workspace,
      id,
      phase: "undo",
      partitions: [],
      inventory: null,
    });
    if ("pending" in preparation) return preparation;
    record = {
      ...record,
      state: "undoing",
      preparedPages: preparation.preparedPages,
    };
    await saveUndo(env, record);
  }
  let locked = false;
  let reconciled: ReconcileCounts | RecoveryPending;
  try {
    if (record.state === "undoing") {
      if (record.preparedPages)
        await call(roomStub(env, record.workspace), "begin", {
          op,
          pages: record.preparedPages,
        });
      await each(record.partitions, async (partition) => {
        const stub = () =>
          partitionStub(env, inventory!.object, partition.name);
        const who = identity(inventory!, partition);
        await call(stub(), "restore", { ...who, bookmark: partition.bookmark });
        await abort(stub(), who);
      });
      record = { ...record, state: "undo-reconciling" };
      await saveUndo(env, record);
      await restoreRoom(env, record.workspace, record.room, op);
      locked = true;
    }
    reconciled = await finish(env, {
      workspace: record.workspace,
      at: record.at,
      id,
      phase: "undo",
      locked,
      operator: session.principalId,
      authenticatedAt: session.authenticatedAt!,
    });
    if ("pending" in reconciled) return reconciled;
  } catch (error) {
    if (error instanceof HttpError && error.reason === "restore-not-applied")
      await saveUndo(env, { ...record, state: "undoing" });
    await audit(env, {
      operator: session.principalId,
      workspace: record.workspace,
      restoreId: id,
      action: "undo",
      result:
        error instanceof HttpError && error.reason ? error.reason : "failed",
      counts: {},
    });
    throw error;
  }
  record = { ...record, state: "undone", unlockPending: true };
  await saveUndo(env, record);
  await call(roomStub(env, record.workspace), "unlock", { op });
  await saveUndo(env, { ...record, unlockPending: false });
  await audit(env, {
    operator: session.principalId,
    workspace: record.workspace,
    restoreId: id,
    action: "undo",
    result: "undone",
    counts: { ...reconciled, partitions: record.partitions.length },
  });
  return {
    restoreId: id,
    reconciled,
    durationMs: Date.now() - started,
    undoneAt: new Date(now).toISOString(),
  };
}

/** Cancel only a snapshot whose history has not started changing. */
async function cancelPreparation(
  env: RecoveryEnv,
  session: RecoverySession,
  body: Record<string, unknown>,
) {
  if (typeof body.restoreId !== "string" || !RESTORE_ID.test(body.restoreId))
    throw new HttpError(409, "No recovery preparation was found.");
  const record = await readUndo(env, body.restoreId);
  if (!record || record.operator !== session.principalId)
    throw new HttpError(
      403,
      "Only the operator who started this recovery can cancel it.",
    );
  if (
    ![
      "preparing",
      "restoring",
      "undo-preparing",
      "undoing",
      "cancelled",
    ].includes(record.state)
  )
    throw new HttpError(
      409,
      "History recovery has started. Repeat the recovery call to finish it.",
    );
  if (record.state === "cancelled")
    return { restoreId: record.restoreId, cancelled: true };
  const undo = record.state.startsWith("undo");
  await call(roomStub(env, record.workspace), "cancel-snapshot", {
    op: `${record.restoreId}:${undo ? "undo" : "restore"}`,
  });
  await saveUndo(env, { ...record, state: "cancelled" });
  await audit(env, {
    operator: session.principalId,
    workspace: record.workspace,
    restoreId: record.restoreId,
    action: "refused",
    result: "preparation-cancelled",
    counts: {},
  });
  return { restoreId: record.restoreId, cancelled: true };
}
