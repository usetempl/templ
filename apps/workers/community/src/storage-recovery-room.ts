/** The object side of the storage recovery tool: what the workspace room
 * and its support partitions answer on `/private/recovery/*`, the lock that
 * keeps members and staff out while a restore finishes, the access
 * reconcile, and the queue that deletes privacy-deleted threads again.
 *
 * Only the worker reaches these routes, through its own bindings, after the
 * edge route (`storage-recovery.ts`) checked the operator. A restore never
 * grants authority back: access after a restore is the intersection of the
 * restored state and the access right before it, and restrictions are their
 * union. Counters, billing records, switches and alert destinations follow
 * `storage-recovery-keys.ts`. */
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { TemplStaffEnv } from "./templ-staff";
import type { SupportAiMode } from "@templ/chat/support";
import { HttpError, json, readJson } from "./common";
import {
  answered,
  atTime,
  bookmarkApi,
  bookmarkText,
  type RecoveryObjectState,
} from "./storage-recovery-object";
import { PERMISSION_REVISION_KEY } from "./room-events";
import { revokeEncryptionForRestore } from "./support-encryption-access";
import { wakeRoomAt } from "./room-alarm";
import { admitRoomMember } from "./room-privacy";
import type { NativeRoomRecord } from "./native-rooms";
import type { TeamConversationRecord } from "./team-conversations";
import {
  checkedAiControl,
  effectiveAiMode,
  readAiDefault,
  stricterAiMode,
  type StoredAiControl,
} from "./support-ai-mode";
import { clearThreadAwaiting } from "./support-cases";
import { supportRecord, supportSettings } from "./support-workflow";
import { SUPPORT_RETENTION_PENDING_KEY } from "./support-retention";
import {
  checkedKeptState,
  reconcileKeptState,
  takeKeptState,
  type KeptCounts,
  type RecoveryKeptState,
  type RecoveryKeptReader,
} from "./storage-recovery-keys";
import {
  saveRecoveryPages,
  recoverySnapshotKey,
  clearRecoverySourcePages,
  recoverySnapshotGroups,
  RECOVERY_SNAPSHOT_GROUPS,
  checkedRecoveryPages,
  recoveryPageKey,
  stageRecoveryPage,
  recoveryPagesReader,
  recoveryStagedNext,
  clearRecoveryPages,
  type RecoveryPages,
} from "./storage-recovery-pages";
import { workspaceClosing } from "./workspace-deletion";
import { clearWorkspaceFlagsByRestore } from "./workspace-flags";
import { aiPrincipalsFromSettings } from "./bots";
import { recoveryStore } from "./storage-recovery-store";
import type { SafetyEnv } from "./safety";
import type { RecoveryHooks } from "./storage-recovery-barrier";

type Tx = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;

/** Pauses workspace changes from snapshot capture until reconciliation finishes. */
export const RECOVERY_LOCK_KEY = "recovery-lock-v1";
/** Written just before a restore, so the undo bookmark carries it and a
 * restore that did not apply is noticed. */
const MARKER_KEY = "recovery-marker-v1";
const COMPLETED_KEY = "recovery-completed-v1";
/** Threads deleted for a privacy request after the restore point, waiting
 * for the retention sweep. */
const REDELETE_PREFIX = "recovery-redelete-v1:";
const SUPPORT_SETTINGS_KEY = "support-settings-v1";
const CAPABILITY_KEY = "support-store-capability-v1";
const THREAD = /^tc-[0-9a-f]{32}$/;
/** Check once when a room starts, before requests, sockets or timed jobs.
 * SafetyStore survives point-in-time recovery, including the restart before
 * the operator can write a new lock into the restored room. */
export async function restoreStartupLock(
  storage: Pick<DurableObjectStorage, "get" | "put">,
  env: Pick<SafetyEnv, "SAFETY_STORE">,
) {
  if (!env.SAFETY_STORE) return;
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) return;
  const { lock } = await recoveryStore<{
    lock: { op: string; phase: string } | null;
  }>(env, {
    op: "workspace-lock",
    workspace: native.room.id,
  });
  if (
    lock &&
    !(await storage.get(RECOVERY_LOCK_KEY)) &&
    !(await storage.get(`recovery-cancelled-v1:${lock.op}`))
  )
    await storage.put(RECOVERY_LOCK_KEY, { ...lock, at: Date.now() });
}
// ---------------------------------------------------------------------------
// The lock

/** Refuses every room request except the recovery routes while a restore is
 * unfinished. Called first in the room's request path. */
export async function recoveryGate(
  storage: Pick<DurableObjectStorage, "get">,
  pathname: string,
): Promise<Response | null> {
  if (pathname.startsWith("/private/recovery/")) return null;
  if (!(await storage.get(RECOVERY_LOCK_KEY))) return null;
  return recoveryPausedResponse();
}
export function recoveryPausedResponse() {
  return json(
    {
      error: "This workspace is being restored. Try again in a few minutes.",
      reason: "restore-incomplete",
    },
    503,
    { "Retry-After": "60" },
  );
}
/** The room's timed jobs wait while a restore is unfinished: they would run
 * on restored access that is not reconciled yet. True when the alarm was
 * put off by a minute; the reconcile wakes the room when it unlocks. Called
 * first in the room's alarm. */
export async function recoveryAlarmHold(
  storage: Pick<DurableObjectStorage, "get" | "setAlarm">,
  now = Date.now(),
): Promise<boolean> {
  if (!(await storage.get(RECOVERY_LOCK_KEY))) return false;
  await storage.setAlarm(now + 60_000);
  return true;
}

// ---------------------------------------------------------------------------
// Access snapshot and reconcile

export type RecoverySnapshot = {
  schemaVersion: 3;
  takenAt: number;
  manager: ChatPrincipalId;
  pendingManager: ChatPrincipalId | null;
  /** `roles:<principal>`: the staff roles each person holds. */
  staff: Record<string, string[]>;
  /** Each staff role's switch and powers. */
  roles: Record<string, { enabled: boolean; permissions: string[] }>;
  bots: string[];
  aiPrincipals: ChatPrincipalId[];
  botsRevision: number;
  /** `ban:<principal>` values. */
  bans: Record<string, string>;
  /** `mute:<principal>` end times. */
  mutes: Record<string, string>;
  /** Stopped threads and when they were stopped. */
  stops: Record<string, number | null>;
  aiDefault: SupportAiMode;
  /** Threads a person or rule held at drafts or off. */
  ai: Record<string, StoredAiControl>;
  permissionRevision: number;
  /** Counters, billing records, switches and alert destinations. */
  keptState: RecoveryKeptState;
  keptPages?: RecoveryPages;
};
export type ReconcileCounts = KeptCounts & {
  staffRemoved: number;
  rolesReduced: number;
  botsRemoved: number;
  managerRestored: number;
  bansKept: number;
  mutesKept: number;
  stopsKept: number;
  aiKept: number;
  privacyDeleted: number;
};

type Settings = {
  roles?: {
    id: string;
    name: string;
    enabled?: boolean;
    moderationPermissions?: string[];
  }[];
  bots?: { principalId: string }[];
  botsRevision?: number;
} & Record<string, unknown>;
type ManualRoles = Record<
  string,
  { enabled?: boolean } & Record<string, unknown>
>;

/** Each value under `prefix`, a page at a time, so memory holds one page
 * however many records the workspace keeps. */
async function* eachValue<T>(
  storage: Pick<Tx, "list">,
  prefix: string,
): AsyncGenerator<T> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<T>({
      prefix,
      limit: 500,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, value] of page) {
      startAfter = key;
      yield value;
    }
    if (page.size < 500) return;
  }
}
async function listAll<T>(
  storage: Pick<Tx, "list">,
  prefix: string,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<T>({
      prefix,
      limit: 500,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, value] of page) {
      out.set(key, value);
      startAfter = key;
    }
    if (page.size < 500) return out;
  }
}
/** A well-formed stored AI control, or null. */
const aiControl = (value: unknown): StoredAiControl | null =>
  value != null && checkedAiControl(value) ? (value as StoredAiControl) : null;
const workflowCase = (data: { ledgerVersion?: 1; caseSeq?: number }) =>
  data.ledgerVersion === 1 && Number.isSafeInteger(data.caseSeq)
    ? (data.caseSeq as number)
    : 0;

/** Who holds what right now, read in one transaction before a restore. */
export async function takeAccessSnapshot(
  storage: Tx,
  now: number,
  includeKept = true,
): Promise<RecoverySnapshot> {
  if (await storage.get("support-priority-trial-capture-v1"))
    throw new HttpError(409, "Close the synthetic capture before recovery.");
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) throw new HttpError(404, "Workspace not found.");
  const settings = (await storage.get<Settings>("chat-settings")) ?? {};
  const manual = (await storage.get<ManualRoles>("native-manual-roles")) ?? {};
  const staff: Record<string, string[]> = {};
  for (const [key, roles] of await listAll<string[]>(storage, "roles:"))
    if (Array.isArray(roles) && roles.length)
      staff[key.slice("roles:".length)] = roles;
  const roles: RecoverySnapshot["roles"] = {};
  for (const role of settings.roles ?? [])
    roles[role.id] = {
      enabled: Boolean(manual[role.id]) && manual[role.id].enabled !== false,
      permissions: [...(role.moderationPermissions ?? [])],
    };
  const bans: Record<string, string> = {};
  for (const [key, value] of await listAll<string>(storage, "ban:"))
    bans[key.slice("ban:".length)] = value;
  const mutes: Record<string, string> = {};
  for (const [key, until] of await listAll<string>(storage, "mute:"))
    if (Date.parse(until) > now) mutes[key.slice("mute:".length)] = until;
  const aiDefault = readAiDefault(await supportSettings(storage));
  const stops: Record<string, number | null> = {};
  const ai: Record<string, StoredAiControl> = {};
  for await (const record of eachValue<TeamConversationRecord>(
    storage,
    "conversation-v1:",
  )) {
    if (!record || record.deleting) continue;
    if (record.stopped) stops[record.id] = record.stoppedAt ?? null;
    const control = aiControl(record.ai);
    if (!control) continue;
    const data = await supportRecord(storage, record);
    const effective = effectiveAiMode(control, data, aiDefault);
    if (effective.set && effective.mode !== "answers")
      ai[record.id] = { ...control, mode: effective.mode };
  }
  return {
    schemaVersion: 3,
    takenAt: now,
    manager: native.room.manager as ChatPrincipalId,
    pendingManager: (native.room.pendingManager ??
      null) as ChatPrincipalId | null,
    staff,
    roles,
    bots: (settings.bots ?? []).map((bot) => bot.principalId),
    aiPrincipals: aiPrincipalsFromSettings(settings),
    botsRevision: Number.isSafeInteger(settings.botsRevision)
      ? (settings.botsRevision as number)
      : 0,
    bans,
    mutes,
    stops,
    aiDefault,
    ai,
    permissionRevision:
      (await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0,
    keptState: includeKept
      ? await takeKeptState(storage)
      : { kept: {}, off: {}, destinations: {} },
  };
}

function checkedSnapshot(value: unknown): RecoverySnapshot {
  const v = value as RecoverySnapshot | null;
  const record = (x: unknown) =>
    Boolean(x) && typeof x === "object" && !Array.isArray(x);
  if (
    !v ||
    v.schemaVersion !== 3 ||
    typeof v.manager !== "string" ||
    !(v.pendingManager === null || typeof v.pendingManager === "string") ||
    !record(v.staff) ||
    !Object.values(v.staff).every(
      (roles) =>
        Array.isArray(roles) && roles.every((id) => typeof id === "string"),
    ) ||
    !record(v.roles) ||
    !Array.isArray(v.bots) ||
    !Array.isArray(v.aiPrincipals) ||
    v.aiPrincipals.some(
      (id) => !normalizeChatPrincipal(id) || normalizeChatPrincipal(id) !== id,
    ) ||
    new Set(v.aiPrincipals).size !== v.aiPrincipals.length ||
    !Number.isSafeInteger(v.botsRevision) ||
    !record(v.bans) ||
    !record(v.mutes) ||
    !record(v.stops) ||
    !["answers", "drafts", "off"].includes(v.aiDefault) ||
    !record(v.ai) ||
    !Number.isSafeInteger(v.permissionRevision)
  )
    throw new HttpError(400, "Invalid access snapshot.");
  checkedKeptState(v.keptState);
  if (v.keptPages) {
    checkedRecoveryPages(v.keptPages);
    if (Object.values(v.keptState).some((group) => Object.keys(group).length))
      throw new HttpError(400, "Invalid access snapshot.");
  }
  return v;
}

/** After a restore to T: authority is what both the restored state and the
 * snapshot grant (staff, roles, powers, bots, the manager is the snapshot's),
 * restrictions are what either holds (bans, mutes, stopped threads, the
 * stricter AI mode), and threads deleted for a privacy request after T are
 * deleted again. The permission revision moves past both timelines, so every
 * session and cache checks access again. */
export async function reconcileRecoveredAccess(
  storage: Tx,
  input: {
    snapshot: RecoverySnapshot;
    deletions: string[];
    operator: ChatPrincipalId;
    authenticatedAt: number;
  },
  now: number,
  env: TemplStaffEnv = {},
  keptReader?: RecoveryKeptReader,
): Promise<ReconcileCounts> {
  const snapshot = checkedSnapshot(input.snapshot);
  const counts: ReconcileCounts = {
    staffRemoved: 0,
    rolesReduced: 0,
    botsRemoved: 0,
    managerRestored: 0,
    bansKept: 0,
    mutesKept: 0,
    stopsKept: 0,
    aiKept: 0,
    privacyDeleted: 0,
    keptRecords: 0,
    offKept: 0,
    destinationsRemoved: 0,
    linksEnded: 0,
  };
  // The manager: an ownership change is never undone by a restore.
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) throw new HttpError(404, "Workspace not found.");
  const pending =
    native.room.pendingManager === snapshot.pendingManager
      ? snapshot.pendingManager
      : null;
  if (
    native.room.manager !== snapshot.manager ||
    (native.room.pendingManager ?? null) !== pending
  ) {
    if (native.room.manager !== snapshot.manager) counts.managerRestored = 1;
    native.room.manager = snapshot.manager as typeof native.room.manager;
    native.room.pendingManager = pending as typeof native.room.pendingManager;
    native.revision += 1;
    await storage.put("native-room", native);
    if (native.room.visibility === "private")
      await admitRoomMember(
        storage as DurableObjectTransaction,
        snapshot.manager,
        null,
      );
  }
  // Staff: roles held in both timelines.
  for (const [key, held] of await listAll<string[]>(storage, "roles:")) {
    const kept = new Set(snapshot.staff[key.slice("roles:".length)] ?? []);
    const next = (Array.isArray(held) ? held : []).filter((id) => kept.has(id));
    if (next.length === (Array.isArray(held) ? held.length : 0)) continue;
    if (next.length) {
      counts.rolesReduced++;
      await storage.put(key, next);
    } else {
      counts.staffRemoved++;
      await storage.delete(key);
    }
  }
  // Roles and bots: a switch or power on in both; a bot listed in both.
  const settings = await storage.get<Settings>("chat-settings");
  const manual = (await storage.get<ManualRoles>("native-manual-roles")) ?? {};
  if (settings) {
    let settingsChanged = false;
    let manualChanged = false;
    const agents = [
      ...new Set([
        ...aiPrincipalsFromSettings(settings),
        ...snapshot.aiPrincipals,
      ]),
    ];
    if (JSON.stringify(settings.aiPrincipals) !== JSON.stringify(agents)) {
      settings.aiPrincipals = agents;
      settingsChanged = true;
    }
    for (const role of settings.roles ?? []) {
      const before = snapshot.roles[role.id];
      const permissions = (role.moderationPermissions ?? []).filter(
        (permission) => before?.permissions.includes(permission),
      );
      if (permissions.length !== (role.moderationPermissions ?? []).length) {
        counts.rolesReduced++;
        settingsChanged = true;
        if (permissions.length) role.moderationPermissions = permissions;
        else delete role.moderationPermissions;
      }
      if (
        manual[role.id] &&
        manual[role.id].enabled !== false &&
        !before?.enabled
      ) {
        counts.rolesReduced++;
        manual[role.id] = { ...manual[role.id], enabled: false };
        role.enabled = false;
        settingsChanged = manualChanged = true;
      }
    }
    const keep = new Set(snapshot.bots);
    const bots = (settings.bots ?? []).filter((bot) =>
      keep.has(bot.principalId),
    );
    if (bots.length !== (settings.bots ?? []).length) {
      counts.botsRemoved = (settings.bots ?? []).length - bots.length;
      settings.bots = bots;
      settings.botsRevision =
        Math.max(settings.botsRevision ?? 0, snapshot.botsRevision) + 1;
      settingsChanged = true;
    }
    if (settingsChanged) await storage.put("chat-settings", settings);
    if (manualChanged) await storage.put("native-manual-roles", manual);
  }
  // Restrictions: whichever timeline holds one keeps it.
  for (const [id, value] of Object.entries(snapshot.bans))
    if (!(await storage.get(`ban:${id}`))) {
      counts.bansKept++;
      await storage.put(`ban:${id}`, value);
    }
  for (const [id, until] of Object.entries(snapshot.mutes)) {
    if (!(Date.parse(until) > now)) continue;
    const restored = await storage.get<string>(`mute:${id}`);
    if (!restored || Date.parse(restored) < Date.parse(until)) {
      counts.mutesKept++;
      await storage.put(`mute:${id}`, until);
    }
  }
  // The restored settings, or their defaults when none were saved by T.
  const supportConfig = await supportSettings(storage);
  const restoredDefault = readAiDefault(supportConfig);
  const aiDefault = stricterAiMode(restoredDefault, snapshot.aiDefault);
  if (aiDefault !== restoredDefault) {
    counts.aiKept++;
    await storage.put(SUPPORT_SETTINGS_KEY, { ...supportConfig, aiDefault });
  }
  const threads = new Set([
    ...Object.keys(snapshot.stops),
    ...Object.keys(snapshot.ai),
  ]);
  for (const id of threads) {
    if (!THREAD.test(id)) continue;
    const key = `conversation-v1:${id}`;
    const record = await storage.get<TeamConversationRecord>(key);
    if (!record || record.deleting) continue;
    let changed = false;
    if (id in snapshot.stops && !record.stopped) {
      record.stopped = true;
      record.stoppedAt = snapshot.stops[id] ?? now;
      counts.stopsKept++;
      changed = true;
    }
    const held = aiControl(snapshot.ai[id]);
    if (held) {
      const data = await supportRecord(storage, record);
      const current = effectiveAiMode(
        aiControl(record.ai),
        data,
        aiDefault,
      ).mode;
      if (stricterAiMode(current, held.mode) !== current) {
        record.ai = { ...held, caseSeq: workflowCase(data) };
        counts.aiKept++;
        changed = true;
      }
    }
    if (changed) {
      record.revision += 1;
      await storage.put(key, record);
    }
  }
  // Counters and billing records never roll back; switches off in either
  // timeline stay off; alert destinations stay only when both hold them.
  Object.assign(
    counts,
    await reconcileKeptState(storage, snapshot.keptState, env, keptReader),
  );
  // Reconciliation can reduce rights in either timeline. Require independent
  // endpoint approval against the restored/current intersection before any
  // new delivery or rewrap; retained signatures stay verifiable.
  await revokeEncryptionForRestore(storage);
  await clearWorkspaceFlagsByRestore(
    storage,
    input.operator,
    input.authenticatedAt,
    now,
  );
  // Privacy deletions made after T: closed now, rows deleted by the sweep.
  for (const id of new Set(input.deletions)) {
    if (!THREAD.test(id)) continue;
    const key = `conversation-v1:${id}`;
    const record = await storage.get<TeamConversationRecord>(key);
    if (!record) continue;
    if (!record.deleting) {
      await storage.put(key, { ...record, deleting: true });
      await clearThreadAwaiting(
        storage as DurableObjectTransaction,
        id,
        await supportRecord(storage, record),
      );
    }
    if ((await storage.get(SUPPORT_RETENTION_PENDING_KEY)) !== id)
      await storage.put(`${REDELETE_PREFIX}${id}`, now);
    counts.privacyDeleted++;
  }
  await storage.put(
    PERMISSION_REVISION_KEY,
    Math.max(
      (await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0,
      snapshot.permissionRevision,
    ) + 1,
  );
  return counts;
}

/** Room alarm consumer: hands the next privacy-deleted thread to the
 * retention sweep whenever the sweep is free. */
export async function recoveryRedeleteAlarm(
  storage: Pick<
    DurableObjectStorage,
    "get" | "put" | "delete" | "list" | "transaction"
  >,
  now: number,
): Promise<number | null> {
  return storage.transaction(async (local) => {
    const queued = await local.list<number>({
      prefix: REDELETE_PREFIX,
      limit: 1,
    });
    if (!queued.size) return null;
    if (await local.get(SUPPORT_RETENTION_PENDING_KEY)) return now + 60_000;
    const [key] = queued.keys();
    const thread = key.slice(REDELETE_PREFIX.length);
    await local.delete(key);
    const record = await local.get<TeamConversationRecord>(
      `conversation-v1:${thread}`,
    );
    if (record?.deleting)
      await local.put(SUPPORT_RETENTION_PENDING_KEY, thread);
    return now + 1_000;
  });
}

// ---------------------------------------------------------------------------
// Routes

/** The room's `/private/recovery/*` routes. */
export function roomRecoveryRoute(
  state: RecoveryObjectState,
  request: Request,
  now = Date.now(),
  env: TemplStaffEnv = {},
  hooks?: RecoveryHooks,
): Promise<Response> {
  return answered(() => roomRoute(state, request, now, env, hooks));
}
async function roomRoute(
  state: RecoveryObjectState,
  request: Request,
  now: number,
  env: TemplStaffEnv,
  hooks?: RecoveryHooks,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Not found." }, 404);
  const path = new URL(request.url).pathname.slice("/private/recovery/".length);
  const body = await readJson(request, 16_000_000);
  const storage = state.storage;
  switch (path) {
    case "inventory": {
      const native = await storage.get<NativeRoomRecord>("native-room");
      if (!native) throw new HttpError(404, "Workspace not found.");
      const partitions: { name: string; mode: "data" | "index" }[] = [];
      const seen = new Set<string>();
      for (const [prefix, mode] of [
        ["support-store-manifest-v1:", "data"],
        ["support-store-search-v1:", "index"],
        ["group-store-search-v1:", "index"],
      ] as const)
        for (const value of (
          await listAll<{ id?: unknown }>(storage, prefix)
        ).values())
          if (typeof value?.id === "string" && !seen.has(value.id)) {
            seen.add(value.id);
            partitions.push({ name: value.id, mode });
          }
      return json({
        object: state.id?.toString() ?? "",
        capability: (await storage.get<string>(CAPABILITY_KEY)) ?? null,
        partitions,
        // Set to be deleted: a restore would bring the workspace back.
        closing: await workspaceClosing(storage),
      });
    }
    case "bookmark": {
      const at = atTime(body.at);
      const api = bookmarkApi(storage);
      return json({
        target: await api.getBookmarkForTime(at),
        current: await api.getCurrentBookmark(),
      });
    }
    case "snapshot": {
      if (body.op === undefined)
        return json(
          await storage.transaction((local) => takeAccessSnapshot(local, now)),
        );
      if (
        typeof body.op !== "string" ||
        !/^[0-9a-f]{32}:(restore|undo)$/.test(body.op)
      )
        throw new HttpError(400, "Invalid recovery step.");
      const op = body.op;
      await hooks?.pause(op);
      try {
        return json(
          await storage.transaction(async (local) => {
            const lock = await local.get<{ op: string; phase?: string }>(
              RECOVERY_LOCK_KEY,
            );
            if (lock && (lock.op !== op || lock.phase !== "snapshot"))
              throw new HttpError(409, "Finish the current recovery first.");
            if (await local.get(`recovery-cancelled-v1:${op}`))
              throw new HttpError(
                409,
                "This recovery was cancelled. Make a new plan.",
              );
            const existing = await local.get<RecoverySnapshot>(
              recoverySnapshotKey(op),
            );
            if (lock && existing) return checkedSnapshot(existing);
            const snapshot = await takeAccessSnapshot(local, now, false);
            snapshot.keptPages = await saveRecoveryPages(local, op, snapshot);
            for (const group of RECOVERY_SNAPSHOT_GROUPS) snapshot[group] = {};
            await local.put(recoverySnapshotKey(op), snapshot);
            await local.put(RECOVERY_LOCK_KEY, {
              op,
              at: now,
              phase: "snapshot",
              snapshotId: snapshot.keptPages.id,
            });
            return snapshot;
          }),
        );
      } catch (error) {
        if (!(await storage.get(RECOVERY_LOCK_KEY))) hooks?.resume(op);
        throw error;
      }
    }
    case "begin": {
      const pages = checkedRecoveryPages(body.pages);
      await storage.transaction(async (local) => {
        const lock = await local.get<{
          op: string;
          phase: string;
          snapshotId: string;
        }>(RECOVERY_LOCK_KEY);
        if (
          !lock ||
          lock.op !== body.op ||
          lock.snapshotId !== pages.id ||
          !["snapshot", "restoring"].includes(lock.phase)
        )
          throw new HttpError(
            409,
            "The recovery snapshot changed. Repeat the recovery call.",
          );
        await local.put(RECOVERY_LOCK_KEY, { ...lock, phase: "restoring" });
      });
      return json({ ok: true });
    }
    case "cancel-snapshot": {
      if (
        typeof body.op !== "string" ||
        !/^[0-9a-f]{32}:(restore|undo)$/.test(body.op)
      )
        throw new HttpError(400, "Invalid recovery step.");
      await storage.transaction(async (local) => {
        const lock = await local.get<{
          op: string;
          phase: string;
          snapshotId?: string;
        }>(RECOVERY_LOCK_KEY);
        if (lock && (lock.op !== body.op || lock.phase !== "snapshot"))
          throw new HttpError(
            409,
            "History recovery has started. Repeat the recovery call to finish it.",
          );
        if (lock?.snapshotId) await clearRecoveryPages(local, lock.snapshotId);
        if ((await local.get(MARKER_KEY)) === body.op)
          await local.delete(MARKER_KEY);
        await local.put(`recovery-cancelled-v1:${body.op}`, now);
        await local.delete(RECOVERY_LOCK_KEY);
      });
      await wakeRoomAt(storage, now);
      hooks?.resume(body.op as string);
      return json({ ok: true });
    }
    case "snapshot-clear": {
      const pages = checkedRecoveryPages(body.pages);
      await storage.transaction((local) =>
        clearRecoverySourcePages(local, pages.id),
      );
      return json({ ok: true });
    }
    case "snapshot-page": {
      const pages = checkedRecoveryPages(body.pages);
      const index = body.index as number;
      if (!Number.isSafeInteger(index) || index < 0 || index >= pages.pages)
        throw new HttpError(400, "Invalid recovery page.");
      const page = await storage.get<string>(recoveryPageKey(pages.id, index));
      if (page === undefined)
        throw new HttpError(
          409,
          "The recovery snapshot is incomplete or changed.",
        );
      return json({ page });
    }
    case "stage-page": {
      const pages = checkedRecoveryPages(body.pages);
      const lock = await storage.get<{ op?: string }>(RECOVERY_LOCK_KEY);
      if (!lock?.op || !pages.id.startsWith(`${lock.op}:`))
        throw new HttpError(409, "No restore is waiting for this step.");
      await storage.transaction((local) =>
        stageRecoveryPage(local, pages, body.index as number, body.page),
      );
      return json({ ok: true });
    }
    case "stage-status": {
      const pages = checkedRecoveryPages(body.pages);
      const lock = await storage.get<{ op?: string }>(RECOVERY_LOCK_KEY);
      if (!lock?.op || !pages.id.startsWith(`${lock.op}:`))
        throw new HttpError(409, "No restore is waiting for this step.");
      return json({ next: await recoveryStagedNext(storage, pages) });
    }
    case "unlock": {
      const result = await storage.transaction(async (local) => {
        const lock = await local.get<{ op: string }>(RECOVERY_LOCK_KEY);
        if (!lock) return { unlocked: false };
        if (lock.op !== body.op || (await local.get(COMPLETED_KEY)) !== body.op)
          throw new HttpError(409, "Finish the current recovery first.");
        await local.delete([RECOVERY_LOCK_KEY, MARKER_KEY, COMPLETED_KEY]);
        return { unlocked: true };
      });
      hooks?.resume(body.op as string);
      await wakeRoomAt(storage, now);
      return json(result);
    }
    case "mark": {
      if (
        typeof body.op !== "string" ||
        !/^[0-9a-f]{32}:(restore|undo)$/.test(body.op)
      )
        throw new HttpError(400, "Invalid recovery step.");
      await storage.put(MARKER_KEY, body.op);
      return json({ current: await bookmarkApi(storage).getCurrentBookmark() });
    }
    case "restore":
      return json({
        undo: await bookmarkApi(storage).onNextSessionRestoreBookmark(
          bookmarkText(body.bookmark),
        ),
      });
    case "abort":
      // The object restarts on the restored state at its next request.
      state.abort("storage recovery");
      return json({ aborted: true }, 202);
    case "lock": {
      if (
        typeof body.op !== "string" ||
        !/^[0-9a-f]{32}:(restore|undo)$/.test(body.op)
      )
        throw new HttpError(400, "Invalid recovery step.");
      // Still carrying this step's marker: the restore did not apply.
      if ((await storage.get(MARKER_KEY)) === body.op)
        return json({ applied: false });
      await storage.put(RECOVERY_LOCK_KEY, { op: body.op, at: now });
      return json({ applied: true });
    }
    case "reconcile": {
      const lock = await storage.get<{ op?: unknown }>(RECOVERY_LOCK_KEY);
      if (
        typeof body.op !== "string" ||
        !lock ||
        lock.op !== body.op ||
        !Array.isArray(body.deletions)
      )
        throw new HttpError(409, "No restore is waiting for this step.");
      const counts = await storage.transaction(async (local) => {
        let snapshot = checkedSnapshot(body.snapshot);
        if (
          snapshot.keptPages &&
          !snapshot.keptPages.id.startsWith(`${body.op}:`)
        )
          throw new HttpError(409, "No restore is waiting for this step.");
        const reader = snapshot.keptPages
          ? await recoveryPagesReader(local, snapshot.keptPages)
          : undefined;
        if (snapshot.keptPages)
          snapshot = checkedSnapshot({
            ...snapshot,
            ...(await recoverySnapshotGroups(local, snapshot.keptPages)),
          });
        const result = await reconcileRecoveredAccess(
          local,
          {
            snapshot,
            deletions: body.deletions as string[],
            operator: body.operator as ChatPrincipalId,
            authenticatedAt: body.authenticatedAt as number,
          },
          now,
          env,
          reader,
        );
        if (snapshot.keptPages)
          await clearRecoveryPages(local, snapshot.keptPages.id);
        if (body.deferUnlock === true) await local.put(COMPLETED_KEY, body.op);
        else await local.delete([RECOVERY_LOCK_KEY, MARKER_KEY]);
        return result;
      });
      // Timed jobs (retention, the redelete queue) run on the restored state.
      await wakeRoomAt(storage, now);
      return json({ reconciled: counts });
    }
    default:
      return json({ error: "Not found." }, 404);
  }
}

export type { StoredAiControl };
