import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { isSolanaAddress } from "@templ/chat/solana";
import {
  profileKey,
  profileNetwork,
  profileAddress,
  type ProfileRef,
} from "@templ/chat/protocol-profile";
import { type Env, HttpError, json } from "./common";
import { type NativeRoomRecord, NATIVE_UUID } from "./native-rooms";
import { requirePrivilegedHeaders } from "./privileged-auth";
import { principalsFromHeaders } from "./service-principals";
import { releaseIdentity } from "./release-identity";
import {
  trialOperatorPrincipal,
  type OperatorAdminEnv,
} from "./operator-admin";
import {
  requireScopedFlagGrant,
  configuredScopedFlagGrants,
} from "./scoped-flag-grants";
import {
  featureOn,
  WORKSPACE_FLAGS_KEY,
  workspaceFeatureEnv,
  type WorkspaceFlagEnv,
} from "./workspace-flags";
import { rpcBudgetRequest } from "./rpc-budget";
import { MAX_RPC_RESERVATIONS, type RpcBudgetMetric } from "./usage-ledger";
import { wakeRoomAt } from "./room-alarm";
import {
  projectPriorityDispatch,
  projectPriorityPrice,
  projectPriorityRefusal,
  projectPriorityResponses,
  type PriorityObservation,
  type PriorityRpcDispatch,
} from "./priority-trial-observations";
import type { PriorityPosition } from "@templ/chat/support-priority";
import { readConversation } from "./team-conversations";
import { priorityProof, prioritySettings } from "./support-priority";
import { supportRecord, supportSettings } from "./support-workflow";
import type { PriorityCaptureFixture } from "./priority-trial-fixture";

export type PriorityCaptureEnv = WorkspaceFlagEnv &
  OperatorAdminEnv & {
    SUPPORT_PRIORITY_CAPTURE_ENABLED?: string;
    SUPPORT_PRIORITY_CAPTURE_SCOPES?: string;
    CF_VERSION_METADATA?: Env["CF_VERSION_METADATA"];
    RELEASE_IDENTITY?: string;
  };
export const PRIORITY_CAPTURE_PATH = "/priority-trial-capture";
export const PRIORITY_CAPTURE_KEY = "support-priority-trial-capture-v1";
export const PRIORITY_CAPTURE_ROWS = "support-priority-trial-capture-row-v1:";
export const PRIORITY_CAPTURE_MS = 30 * 60_000;
export const PRIORITY_CAPTURE_MAX_ROWS = 512;
export const PRIORITY_CAPTURE_MAX_BYTES = 1024 * 1024;
export const PRIORITY_CAPTURE_MAX_ROW_BYTES = 64 * 1024;
const THREAD = /^tc-[a-f0-9]{32}$/;
const CASE_NAMES = [
  "claimedThread",
  "verifiedThread",
  "solanaThread",
  "priceWarmThread",
  "priceCachedThread",
  "staleThread",
  "solanaRefreshThread",
  "unopenedStaleThread",
  "budgetThread",
] as const;
export type PriorityCaptureCases = {
  claimedThread: string;
  verifiedThread: string;
} & Partial<Record<(typeof CASE_NAMES)[number], string>>;
type Scope = {
  grantId: string;
  workspace: string;
  manager: ChatPrincipalId;
  actor: ChatPrincipalId;
};
type Records = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
type Identity = {
  schemaVersion: 1;
  environment: "production";
  commit: string;
  sourceDigest: string;
  lockfileSha256: string;
  service: "community";
  versionId: string;
};
type Ticket = {
  metric: RpcBudgetMetric;
  id: string;
  at: number;
  expiresAt: number;
  reservedCu: number;
};
type Capture = {
  schemaVersion: 1;
  id: string;
  scope: Scope;
  identity: Identity;
  cases: PriorityCaptureCases;
  diagnosticScope?: "evm";
  contracts: ProfileRef[];
  walletByNetwork: Record<string, string>;
  priceAssets: ProfileRef[];
  positionCheckedAt: Record<string, number>;
  startedAt: number;
  expiresAt: number;
  nextSequence: number;
  encodedBytes: number;
  incomplete: boolean;
  closedAt: number | null;
  budgetTickets: Ticket[];
  budgetStartedAt: number | null;
  budgetCompleted: boolean;
  windows: Record<
    string,
    {
      thread: string;
      startedAt: number;
      completedAt: number | null;
      complete: boolean;
      requests: Record<string, { sequence: number; answered: boolean }>;
      outcome: Pick<
        PriorityPosition,
        "state" | "usd" | "asOf" | "estimated"
      > | null;
    }
  >;
};
export type PriorityCaptureCapability = {
  captureId: string;
  runId: string;
  thread: string;
  identity: Identity;
  failed: boolean;
};
type TraceRow = {
  sequence: number;
  runId: string;
  thread: string;
  observedAt: number;
  observation: PriorityObservation;
};
const unavailable = () => new HttpError(404, "Not found.");
const rowKey = (id: string, sequence: number) =>
  `${PRIORITY_CAPTURE_ROWS}${id}:${String(sequence).padStart(4, "0")}`;
const encoded = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const canonicalRefs = (refs: readonly ProfileRef[]) =>
  refs.map(profileKey).sort().join(",");
const digest = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
function scopes(env: PriorityCaptureEnv): Scope[] {
  try {
    const values: unknown = JSON.parse(
      env.SUPPORT_PRIORITY_CAPTURE_SCOPES ?? "[]",
    );
    if (!Array.isArray(values) || values.length > 20) return [];
    const ids = new Set<string>();
    const workspaces = new Set<string>();
    for (const scope of values) {
      if (
        !scope ||
        typeof scope !== "object" ||
        Array.isArray(scope) ||
        Object.keys(scope).sort().join() !==
          "actor,grantId,manager,workspace" ||
        typeof scope.grantId !== "string" ||
        !/^[a-z0-9][a-z0-9-]{2,39}$/.test(scope.grantId) ||
        !NATIVE_UUID.test(scope.workspace) ||
        typeof scope.manager !== "string" ||
        normalizeChatPrincipal(scope.manager) !== scope.manager ||
        typeof scope.actor !== "string" ||
        normalizeChatPrincipal(scope.actor) !== scope.actor ||
        scope.actor !== scope.manager ||
        ids.has(scope.grantId) ||
        workspaces.has(scope.workspace)
      )
        return [];
      ids.add(scope.grantId);
      workspaces.add(scope.workspace);
    }
    return values;
  } catch {
    return [];
  }
}
export { scopes as configuredPriorityCaptureScopes };
async function currentIdentity(env: PriorityCaptureEnv): Promise<Identity> {
  const response = releaseIdentity(env as Env);
  if (!response.ok) throw unavailable();
  const value = await response.json<Identity>();
  if (value.environment !== "production") throw unavailable();
  return value;
}
async function checkedScope(
  storage: Storage,
  env: PriorityCaptureEnv,
  actor?: string,
  now = Date.now(),
  diagnostic = false,
): Promise<Scope> {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.SUPPORT_PRIORITY_CAPTURE_ENABLED !== "true"
  )
    throw unavailable();
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native || (await storage.get("workspace-deletion-v1")) !== undefined)
    throw unavailable();
  // The existing disposable operator may collect diagnostics only in its own fresh fixture.
  // Current audited flags and the native trial marker bind the same one-hour authority.
  if (diagnostic) {
    const marker = trialOperatorPrincipal(env, native.trialOperator);
    const created = Date.parse(native.room.createdAt);
    const flags = await storage.get<
      Record<
        string,
        {
          on?: boolean;
          operator?: string;
          until?: string;
          authenticatedAt?: string;
        }
      >
    >(WORKSPACE_FLAGS_KEY);
    const fresh =
      marker &&
      native.room.visibility === "public" &&
      native.room.creator === native.room.manager &&
      (actor === undefined || actor === native.room.manager) &&
      Number.isFinite(created) &&
      created <= now &&
      now < created + 60 * 60_000;
    const held = ["priorityFeed", "protocolProfile"].every((key) => {
      const flag = flags?.[key];
      const until = Date.parse(flag?.until ?? "");
      const authenticated = Date.parse(flag?.authenticatedAt ?? "");
      return (
        flag?.on === true &&
        flag.operator === native.room.manager &&
        Number.isFinite(until) &&
        until > now &&
        until <= created + 60 * 60_000 &&
        Number.isFinite(authenticated) &&
        authenticated >= created - 15 * 60_000 &&
        authenticated <= now
      );
    });
    if (
      fresh &&
      held &&
      env.SUPPORT_PROTOCOL_PROFILE_ENABLED === "true" &&
      env.SUPPORT_PRIORITY_FEED_ENABLED === "true"
    ) {
      await requireReaderFeatures(storage, env);
      return {
        grantId: "fresh-evm-diagnostic",
        workspace: native.room.id,
        manager: native.room.manager,
        actor: native.room.manager,
      };
    }
    throw unavailable();
  }
  const scope = scopes(env).find(
    (value) =>
      value.workspace === native.room.id &&
      value.manager === native.room.manager &&
      (actor === undefined || value.actor === actor),
  );
  const grant =
    scope &&
    configuredScopedFlagGrants(env).find(
      (value) =>
        value.id === scope.grantId &&
        value.workspace === scope.workspace &&
        value.manager === scope.manager &&
        value.kind === "demo" &&
        value.keys.includes("priorityFeed") &&
        value.keys.includes("protocolProfile"),
    );
  if (!scope || !grant) throw unavailable();
  await requireScopedFlagGrant(
    storage,
    env,
    {
      workspace: scope.workspace,
      operator: grant.operator,
      id: grant.id,
      manager: scope.manager,
    },
    now,
  );
  if (
    env.SUPPORT_PROTOCOL_PROFILE_ENABLED !== "true" ||
    env.SUPPORT_PRIORITY_FEED_ENABLED !== "true"
  )
    throw unavailable();
  return scope;
}
const sameIdentity = (a: Identity, b: Identity) =>
  Object.keys(a).sort().join() === Object.keys(b).sort().join() &&
  [
    "schemaVersion",
    "environment",
    "commit",
    "sourceDigest",
    "lockfileSha256",
    "service",
    "versionId",
  ].every((key) => a[key as keyof Identity] === b[key as keyof Identity]);
async function currentCapture(
  storage: Storage,
  env: PriorityCaptureEnv,
  now = Date.now(),
): Promise<Capture> {
  const capture = await storage.get<Capture>(PRIORITY_CAPTURE_KEY);
  if (
    !capture ||
    capture.schemaVersion !== 1 ||
    now >= capture.expiresAt ||
    capture.closedAt !== null
  )
    throw unavailable();
  const scope = await checkedScope(
    storage,
    env,
    undefined,
    now,
    capture.diagnosticScope === "evm",
  );
  if (
    JSON.stringify(scope) !== JSON.stringify(capture.scope) ||
    !sameIdentity(await currentIdentity(env), capture.identity)
  )
    throw unavailable();
  return capture;
}
async function currentSyntheticCase(
  storage: Storage,
  capture: Capture,
  thread: string,
) {
  const record = await readConversation(storage, thread);
  const settings = await supportSettings(storage);
  if (
    !record ||
    record.room !== `room:${capture.scope.workspace}` ||
    record.state !== "open" ||
    record.archivedAt ||
    !settings.testAccounts.includes(record.member) ||
    canonicalRefs((await prioritySettings(storage)).contracts) !==
      canonicalRefs(capture.contracts)
  )
    throw unavailable();
  const proof = await priorityProof(
    storage,
    record,
    await supportRecord(storage, record),
  );
  if (thread === capture.cases.claimedThread) {
    if (proof) throw unavailable();
    return null;
  }
  if (!proof) throw unavailable();
  const matches = Object.entries(capture.walletByNetwork).filter(
    ([network]) =>
      (network === "solana") === (proof.wallet.network === "solana"),
  );
  if (
    !matches.length ||
    matches.some(([, address]) => address !== proof.wallet.address)
  )
    throw unavailable();
  return proof.wallet;
}

/** The ordinary reader calls this after its current case-access check. */
export async function beginPriorityCaptureWindow(
  storage: Storage,
  env: PriorityCaptureEnv,
  input: {
    thread: string;
    contracts: readonly ProfileRef[];
    wallet: PriorityPosition["wallet"] | null;
  },
  now = Date.now(),
): Promise<PriorityCaptureCapability | null> {
  if (!(await storage.get(PRIORITY_CAPTURE_KEY))) return null;
  await requireReaderFeatures(storage, env);
  const capture = await currentCapture(storage, env, now);
  if (
    !Object.values(capture.cases).includes(input.thread) ||
    canonicalRefs(input.contracts) !== canonicalRefs(capture.contracts) ||
    Object.keys(capture.windows).length >= 32
  )
    throw unavailable();
  const currentWallet = await currentSyntheticCase(
    storage,
    capture,
    input.thread,
  );
  if (JSON.stringify(currentWallet) !== JSON.stringify(input.wallet))
    throw unavailable();
  if (input.wallet) {
    const matches = Object.entries(capture.walletByNetwork).filter(
      ([network]) =>
        (network === "solana") === (input.wallet!.network === "solana"),
    );
    if (
      !matches.length ||
      matches.some(([, address]) => address !== input.wallet!.address)
    )
      throw unavailable();
  } else if (input.thread !== capture.cases.claimedThread) throw unavailable();
  const runId = await digest({
    capture: capture.id,
    nonce: crypto.randomUUID(),
    identity: capture.identity,
    workspace: capture.scope.workspace,
    thread: input.thread,
    startedAt: now,
  });
  capture.windows[runId] = {
    thread: input.thread,
    startedAt: now,
    completedAt: null,
    complete: false,
    requests: {},
    outcome: null,
  };
  await storage.put(PRIORITY_CAPTURE_KEY, capture);
  return {
    captureId: capture.id,
    runId,
    thread: input.thread,
    identity: capture.identity,
    failed: false,
  };
}
async function heldWindow(
  storage: Storage,
  env: PriorityCaptureEnv,
  capability: PriorityCaptureCapability,
  now: number,
) {
  if (
    !capability ||
    Object.keys(capability).sort().join() !==
      "captureId,failed,identity,runId,thread" ||
    typeof capability.failed !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(capability.runId)
  )
    throw unavailable();
  await requireReaderFeatures(storage, env);
  const capture = await currentCapture(storage, env, now);
  const window = capture.windows[capability.runId];
  if (
    capture.id !== capability.captureId ||
    !sameIdentity(capture.identity, capability.identity) ||
    !window ||
    window.thread !== capability.thread ||
    window.completedAt !== null ||
    now < window.startedAt
  )
    throw unavailable();
  await currentSyntheticCase(storage, capture, capability.thread);
  return { capture, window };
}
async function requireReaderFeatures(
  storage: Storage,
  env: PriorityCaptureEnv,
) {
  const current = await workspaceFeatureEnv(env, storage);
  if (
    !featureOn(current, undefined, "protocolProfile") ||
    !featureOn(current, undefined, "priorityFeed")
  )
    throw unavailable();
}
/** Invalid or missing observations make the whole lease incomplete. */
export async function appendPriorityCaptureObservation(
  storage: Storage,
  env: PriorityCaptureEnv,
  capability: PriorityCaptureCapability,
  input: unknown,
  now = Date.now(),
): Promise<boolean> {
  const { capture, window } = await heldWindow(storage, env, capability, now);
  try {
    const raw = input as { kind?: unknown; requestId?: unknown } | null;
    let observation: PriorityObservation;
    if (raw?.kind === "rpc-dispatch") {
      observation = projectPriorityDispatch(input, capture);
      if (
        Object.hasOwn(window.requests, observation.requestId) ||
        Object.keys(window.requests).length >= 96
      )
        throw unavailable();
    } else if (raw?.kind === "rpc-response") {
      const pending =
        typeof raw.requestId === "string" && window.requests[raw.requestId];
      if (!pending || pending.answered) throw unavailable();
      const dispatched = await storage.get<TraceRow>(
        rowKey(capture.id, pending.sequence),
      );
      if (
        !dispatched ||
        dispatched.runId !== capability.runId ||
        dispatched.observation.kind !== "rpc-dispatch"
      )
        throw unavailable();
      observation = projectPriorityResponses(
        input,
        dispatched.observation as PriorityRpcDispatch,
      );
    } else if (raw?.kind === "room-refusal") {
      if (
        capability.thread !== capture.cases.budgetThread ||
        capture.budgetStartedAt === null ||
        !capture.budgetTickets.length
      )
        throw unavailable();
      observation = projectPriorityRefusal(input);
    } else observation = projectPriorityPrice(input, capture);
    const time = Date.parse(observation.at);
    if (time < window.startedAt || time > now || time >= capture.expiresAt)
      throw unavailable();
    const row: TraceRow = {
      sequence: capture.nextSequence,
      runId: capability.runId,
      thread: capability.thread,
      observedAt: now,
      observation,
    };
    const bytes = encoded(row);
    if (
      capture.nextSequence >= PRIORITY_CAPTURE_MAX_ROWS ||
      bytes > PRIORITY_CAPTURE_MAX_ROW_BYTES ||
      capture.encodedBytes + bytes > PRIORITY_CAPTURE_MAX_BYTES
    )
      throw unavailable();
    if (observation.kind === "rpc-dispatch")
      window.requests[observation.requestId] = {
        sequence: row.sequence,
        answered: false,
      };
    if (observation.kind === "rpc-response")
      window.requests[observation.requestId].answered = true;
    await storage.put(rowKey(capture.id, row.sequence), row);
    capture.nextSequence++;
    capture.encodedBytes += bytes;
    await storage.put(PRIORITY_CAPTURE_KEY, capture);
    return true;
  } catch {
    capture.incomplete = true;
    capability.failed = true;
    await storage.put(PRIORITY_CAPTURE_KEY, capture);
    return false;
  }
}
/** A finished read proves its full window, including a genuine cache hit. */
export async function finishPriorityCaptureWindow(
  storage: Storage,
  env: PriorityCaptureEnv,
  capability: PriorityCaptureCapability,
  position: PriorityPosition | null,
  now = Date.now(),
): Promise<boolean> {
  const { capture, window } = await heldWindow(storage, env, capability, now);
  let complete =
    !capability.failed &&
    !capture.incomplete &&
    Object.values(window.requests).every((request) => request.answered);
  if (position) {
    if (
      !Object.values(capture.walletByNetwork).includes(
        position.wallet.address,
      ) ||
      !["ready", "unavailable"].includes(position.state) ||
      typeof position.estimated !== "boolean" ||
      !Number.isFinite(Date.parse(position.asOf)) ||
      Date.parse(position.asOf) > now + 1000 ||
      (position.usd !== null &&
        (typeof position.usd !== "number" ||
          !Number.isFinite(position.usd) ||
          position.usd < 0))
    )
      complete = false;
    else
      window.outcome = {
        state: position.state,
        usd: position.usd,
        asOf: position.asOf,
        estimated: position.estimated,
      };
  }
  if (capability.thread === capture.cases.budgetThread) {
    const rows = await storage.list<TraceRow>({
      prefix: `${PRIORITY_CAPTURE_ROWS}${capture.id}:`,
      limit: PRIORITY_CAPTURE_MAX_ROWS,
    });
    const selected = [...rows.values()].filter(
      (row) => row.runId === capability.runId,
    );
    const refused = selected.some(
      (row) => row.observation.kind === "room-refusal",
    );
    complete &&=
      !!position &&
      position.state === "unavailable" &&
      refused &&
      !selected.some((row) => row.observation.kind === "rpc-dispatch") &&
      capture.budgetStartedAt !== null;
    // Attempt every unused fixture settlement even when the proof is incomplete.
    const settled = await settlePriorityCaptureTickets(storage, capture);
    complete &&= settled;
    capture.budgetCompleted = complete;
  }
  window.completedAt = now;
  window.complete = complete;
  if (!complete) capture.incomplete = true;
  await storage.put(PRIORITY_CAPTURE_KEY, capture);
  return complete;
}

/** Only this room's unused synthetic tickets are settled. Failed settlements remain owned. */
export async function settlePriorityCaptureTickets(
  storage: Records,
  capture: Capture,
): Promise<boolean> {
  const retained: Ticket[] = [];
  for (const ticket of capture.budgetTickets) {
    try {
      const journal = await storage.get<{
        entries: Record<
          string,
          {
            at: number;
            expiresAt: number;
            reservedCu: number;
            usedCu: number;
            remainingAttempts: object;
          }
        >;
      }>(
        ticket.metric === "primary-cu"
          ? "usage-v1:rpc-reservations"
          : "usage-v1:rpc-confirmation-reservations",
      );
      const entry = journal?.entries?.[ticket.id];
      // Expired tickets need no refund. A consumed ticket is never our unused fixture.
      if (!entry) continue;
      if (
        entry.at !== ticket.at ||
        entry.expiresAt !== ticket.expiresAt ||
        entry.reservedCu !== ticket.reservedCu
      ) {
        retained.push(ticket);
        continue;
      }
      if (entry.expiresAt * 1000 <= Date.now()) continue;
      if (
        entry.usedCu !== 0 ||
        !entry.remainingAttempts ||
        Object.keys(entry.remainingAttempts).join() !== "eth_chainId" ||
        (entry.remainingAttempts as { eth_chainId?: number }).eth_chainId !== 3
      ) {
        retained.push(ticket);
        continue;
      }
      const response = await rpcBudgetRequest(storage, {
        op: "settle",
        kind: "room",
        lane: "normal",
        metric: ticket.metric,
        id: ticket.id,
      });
      if (!response.ok) retained.push(ticket);
    } catch {
      retained.push(ticket);
    }
  }
  capture.budgetTickets = retained;
  if (retained.length) capture.incomplete = true;
  await storage.put(PRIORITY_CAPTURE_KEY, capture);
  return retained.length === 0;
}
async function deleteCaptureRows(storage: Records, capture: Capture) {
  const rows = await storage.list({
    prefix: `${PRIORITY_CAPTURE_ROWS}${capture.id}:`,
    limit: PRIORITY_CAPTURE_MAX_ROWS,
  });
  for (const key of rows.keys()) await storage.delete(key);
}
/** A restore ends only its current source-bound transient capture. */
export async function endPriorityCaptureAfterRestore(
  storage: Records,
  env: PriorityCaptureEnv,
  now = Date.now(),
): Promise<void> {
  const capture = await storage.get<Capture>(PRIORITY_CAPTURE_KEY);
  if (!capture) return;
  if (
    capture.schemaVersion === 1 &&
    capture.expiresAt <= now &&
    Array.isArray(capture.budgetTickets) &&
    capture.budgetTickets.every(
      (ticket) =>
        Number.isSafeInteger(ticket.expiresAt) &&
        ticket.expiresAt * 1000 <= now,
    )
  )
    return;
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (
    capture.schemaVersion !== 1 ||
    !native ||
    capture.scope.workspace !== native.room.id ||
    !Array.isArray(capture.budgetTickets) ||
    capture.budgetTickets.length > MAX_RPC_RESERVATIONS * 2 ||
    !sameIdentity(await currentIdentity(env), capture.identity)
  )
    throw new HttpError(409, "The synthetic capture needs verified cleanup.");
  capture.closedAt = now;
  capture.incomplete = true;
  if (!(await settlePriorityCaptureTickets(storage, capture)))
    throw new HttpError(409, "The synthetic capture needs verified cleanup.");
  await deleteCaptureRows(storage, capture);
  await storage.delete(PRIORITY_CAPTURE_KEY);
}
/** Existing room alarms retry owned cleanup before normal reservation expiry. */
export async function priorityCaptureAlarm(
  storage: Storage,
  env: PriorityCaptureEnv,
  now = Date.now(),
): Promise<number | null> {
  const capture = await storage.get<Capture>(PRIORITY_CAPTURE_KEY);
  if (!capture) return null;
  let invalid = capture.closedAt !== null || now >= capture.expiresAt;
  try {
    await checkedScope(
      storage,
      env,
      undefined,
      now,
      capture.diagnosticScope === "evm",
    );
    if (!sameIdentity(await currentIdentity(env), capture.identity))
      invalid = true;
  } catch {
    invalid = true;
  }
  const ticketsDue =
    capture.budgetStartedAt !== null && now >= capture.budgetStartedAt + 30_000;
  if ((invalid || ticketsDue) && capture.budgetTickets.length) {
    capture.incomplete = true;
    if (!(await settlePriorityCaptureTickets(storage, capture)))
      return now + 1_000;
  }
  if (invalid) {
    await deleteCaptureRows(storage, capture);
    await storage.delete(PRIORITY_CAPTURE_KEY);
    return null;
  }
  return Math.min(
    capture.expiresAt,
    capture.budgetTickets.length
      ? capture.budgetStartedAt! + 30_000
      : capture.expiresAt,
  );
}

/** A manager may request this fixed journal test once; callers choose no reservation parameters. */
export async function preparePriorityCaptureJournal(
  storage: Storage,
  env: PriorityCaptureEnv,
  actor: string,
  now = Date.now(),
): Promise<{ thread: string }> {
  const capture = await currentCapture(storage, env, now);
  if (
    capture.scope.actor !== actor ||
    capture.budgetStartedAt !== null ||
    !capture.cases.budgetThread ||
    capture.diagnosticScope
  )
    throw unavailable();
  for (const key of [
    "usage-v1:rpc-reservations",
    "usage-v1:rpc-confirmation-reservations",
  ]) {
    const journal = await storage.get<{ entries?: object }>(key);
    if (journal && (!journal.entries || Object.keys(journal.entries).length))
      throw new HttpError(409, "The normal room journal has active tickets.");
  }
  capture.budgetStartedAt = now;
  // The owning room transaction rolls back the lease and every reservation on acquisition failure.
  for (const metric of ["primary-cu", "confirmation-attempts"] as const) {
    for (let count = 0; count < MAX_RPC_RESERVATIONS; count++) {
      const response = await rpcBudgetRequest(storage, {
        op: "reserve",
        kind: "room",
        lane: "normal",
        metric,
        method: "eth_chainId",
      });
      if (!response.ok)
        throw new HttpError(
          503,
          "The synthetic journal could not be prepared.",
        );
      const ticket = await response.json<{ id: string }>();
      if (!/^[a-z0-9-]{16,64}$/.test(ticket.id))
        throw new HttpError(
          503,
          "The synthetic journal could not be prepared.",
        );
      const key =
        metric === "primary-cu"
          ? "usage-v1:rpc-reservations"
          : "usage-v1:rpc-confirmation-reservations";
      const journal = await storage.get<{
        entries: Record<
          string,
          {
            at: number;
            expiresAt: number;
            reservedCu: number;
            usedCu: number;
            remainingAttempts: Record<string, number>;
          }
        >;
      }>(key);
      const entry = journal?.entries[ticket.id];
      if (
        !entry ||
        entry.usedCu !== 0 ||
        entry.remainingAttempts.eth_chainId !== 3 ||
        Object.keys(entry.remainingAttempts).join() !== "eth_chainId" ||
        entry.reservedCu !== (metric === "primary-cu" ? 0 : 3)
      )
        throw new HttpError(
          503,
          "The synthetic journal could not be prepared.",
        );
      capture.budgetTickets.push({
        metric,
        id: ticket.id,
        at: entry.at,
        expiresAt: entry.expiresAt,
        reservedCu: entry.reservedCu,
      });
    }
  }
  await storage.put(PRIORITY_CAPTURE_KEY, capture);
  await wakeRoomAt(storage, now + 30_000);
  return { thread: capture.cases.budgetThread };
}

/** A capture never stores caller messages, credentials or arbitrary provider error bodies. */
export async function priorityCaptureRoute(
  storage: Storage,
  env: PriorityCaptureEnv,
  context: {
    path: string;
    method: string;
    actor: string | null;
    isManager: boolean;
    headers: Headers;
    body: Record<string, unknown>;
    checkedFixture: (input: {
      cases: PriorityCaptureCases;
      diagnosticScope?: "evm";
      contracts: ProfileRef[];
      walletByNetwork: Record<string, string>;
    }) => Promise<PriorityCaptureFixture | null>;
  },
  now = Date.now(),
): Promise<Response | null> {
  if (context.path !== PRIORITY_CAPTURE_PATH) return null;
  if (
    !context.isManager ||
    !context.actor ||
    context.headers.get("X-Support-Widget") === "member"
  )
    throw unavailable();
  if (context.method === "POST" && context.body.op === "close") {
    const native = await storage.get<NativeRoomRecord>("native-room");
    if (
      env.APP_ORIGIN !== "https://usetempl.com" ||
      !native ||
      native.room.manager !== context.actor
    )
      throw unavailable();
    requirePrivilegedHeaders(context.headers, context.body.confirmed, now);
    if (Object.keys(context.body).sort().join() !== "confirmed,id,op")
      throw unavailable();
    const capture = await storage.get<Capture>(PRIORITY_CAPTURE_KEY);
    if (!capture || capture.id !== context.body.id) throw unavailable();
    capture.closedAt = now;
    capture.incomplete = true;
    const complete = await settlePriorityCaptureTickets(storage, capture);
    await deleteCaptureRows(storage, capture);
    if (!complete) {
      await wakeRoomAt(storage, now + 1_000);
      return json(
        {
          error: "Synthetic ticket cleanup is pending.",
          ticketsRemaining: capture.budgetTickets.length,
        },
        503,
      );
    }
    await storage.delete(PRIORITY_CAPTURE_KEY);
    return json({ closed: true, ticketsRemaining: 0 });
  }
  const diagnostic = context.body.diagnosticScope === "evm";
  const stored =
    context.method === "GET"
      ? await storage.get<Capture>(PRIORITY_CAPTURE_KEY)
      : null;
  if (diagnostic || stored?.diagnosticScope === "evm") {
    const native = await storage.get<NativeRoomRecord>("native-room");
    const marker = trialOperatorPrincipal(env, native?.trialOperator);
    if (
      !marker ||
      !principalsFromHeaders(
        context.headers,
        normalizeChatPrincipal(context.actor),
      ).includes(marker)
    )
      throw unavailable();
  }
  const scope = await checkedScope(
    storage,
    env,
    context.actor,
    now,
    diagnostic || stored?.diagnosticScope === "evm",
  );
  if (context.method === "GET") {
    const capture = await currentCapture(storage, env, now);
    for (const thread of Object.values(capture.cases))
      await currentSyntheticCase(storage, capture, thread);
    const rows = await storage.list({
      prefix: `${PRIORITY_CAPTURE_ROWS}${capture.id}:`,
      limit: PRIORITY_CAPTURE_MAX_ROWS,
    });
    if (
      rows.size !== capture.nextSequence ||
      capture.incomplete ||
      (capture.budgetStartedAt !== null && !capture.budgetCompleted) ||
      capture.budgetTickets.length ||
      Object.values(capture.windows).some(
        (window) => !window.complete || window.completedAt === null,
      )
    )
      throw new HttpError(409, "The synthetic capture is incomplete.");
    return json({
      id: capture.id,
      scope: capture.scope,
      identity: capture.identity,
      cases: capture.cases,
      ...(capture.diagnosticScope
        ? { diagnosticScope: capture.diagnosticScope }
        : {}),
      contracts: capture.contracts,
      walletByNetwork: capture.walletByNetwork,
      startedAt: capture.startedAt,
      capturedAt: now,
      expiresAt: capture.expiresAt,
      windows: capture.windows,
      positionCheckedAt: capture.positionCheckedAt,
      rows: [...rows.values()],
    });
  }
  if (context.method !== "POST") throw unavailable();
  requirePrivilegedHeaders(context.headers, context.body.confirmed, now);
  if (context.body.op === "journal") {
    if (Object.keys(context.body).sort().join() !== "confirmed,id,op")
      throw unavailable();
    const capture = await currentCapture(storage, env, now);
    if (capture.id !== context.body.id) throw unavailable();
    return json(
      await preparePriorityCaptureJournal(storage, env, context.actor, now),
    );
  }
  if (
    context.body.op !== "start" ||
    Object.keys(context.body).sort().join() !==
      (diagnostic
        ? "cases,confirmed,contracts,diagnosticScope,expectedWorker,op,walletByNetwork"
        : "cases,confirmed,contracts,expectedWorker,op,walletByNetwork")
  )
    throw unavailable();
  if (await storage.get(PRIORITY_CAPTURE_KEY))
    throw new HttpError(409, "A synthetic capture already exists.");
  const identity = await currentIdentity(env);
  if (
    !context.body.expectedWorker ||
    !sameIdentity(context.body.expectedWorker as Identity, identity)
  )
    throw new HttpError(409, "The serving Worker changed.");
  const names = diagnostic
    ? (["claimedThread", "verifiedThread"] as const)
    : CASE_NAMES;
  const cases = context.body.cases as PriorityCaptureCases;
  const contracts = context.body.contracts as ProfileRef[];
  const wallets = context.body.walletByNetwork as Record<string, string>;
  if (
    !cases ||
    typeof cases !== "object" ||
    Array.isArray(cases) ||
    Object.keys(cases).sort().join() !== [...names].sort().join() ||
    names.some((key) => !THREAD.test(cases[key] ?? "")) ||
    new Set(Object.values(cases)).size !== names.length ||
    !Array.isArray(contracts) ||
    contracts.length < (diagnostic ? 1 : 2) ||
    contracts.length > 16 ||
    contracts.some(
      (ref) =>
        !ref ||
        Object.keys(ref).sort().join() !== "address,network" ||
        !profileNetwork(ref.network) ||
        (diagnostic && !["eip155:1", "eip155:8453"].includes(ref.network)) ||
        profileAddress(ref.network, ref.address) !== ref.address,
    ) ||
    new Set(contracts.map(profileKey)).size !== contracts.length ||
    !wallets ||
    typeof wallets !== "object" ||
    Array.isArray(wallets) ||
    Object.keys(wallets).sort().join() !==
      [...new Set(contracts.map((ref) => ref.network))].sort().join() ||
    Object.entries(wallets).some(([network, address]) =>
      network === "solana"
        ? !isSolanaAddress(address)
        : !/^0x[a-f0-9]{40}$/.test(address),
    )
  )
    throw new HttpError(400, "Choose the exact synthetic fixture.");
  const fixture = await context.checkedFixture({
    cases,
    ...(diagnostic ? { diagnosticScope: "evm" as const } : {}),
    contracts,
    walletByNetwork: wallets,
  });
  if (
    !fixture ||
    !Array.isArray(fixture.priceAssets) ||
    !fixture.priceAssets.length ||
    fixture.priceAssets.length > 32 ||
    fixture.priceAssets.some(
      (ref) =>
        !ref ||
        Object.keys(ref).sort().join() !== "address,network" ||
        !profileNetwork(ref.network) ||
        profileAddress(ref.network, ref.address) !== ref.address,
    ) ||
    new Set(fixture.priceAssets.map(profileKey)).size !==
      fixture.priceAssets.length
  )
    throw new HttpError(400, "Choose the exact synthetic fixture.");
  const capture: Capture = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    scope,
    identity,
    cases,
    ...(diagnostic ? { diagnosticScope: "evm" as const } : {}),
    contracts,
    walletByNetwork: wallets,
    priceAssets: fixture.priceAssets,
    positionCheckedAt: fixture.positionCheckedAt,
    startedAt: now,
    expiresAt: now + PRIORITY_CAPTURE_MS,
    nextSequence: 0,
    encodedBytes: 0,
    incomplete: false,
    closedAt: null,
    budgetTickets: [],
    budgetStartedAt: null,
    budgetCompleted: false,
    windows: {},
  };
  await storage.put(PRIORITY_CAPTURE_KEY, capture);
  await wakeRoomAt(storage, capture.expiresAt);
  return json(
    { id: capture.id, identity, startedAt: now, expiresAt: capture.expiresAt },
    201,
  );
}
