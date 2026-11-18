/** Follow-ups that close on chain state.
 *
 * A person on the team can set one watch on an open follow-up:
 * - EVM transaction: closes when the selected read policy finds a successful
 *   receipt with the chain's watch confirmations; a reverted receipt blocks
 *   the follow-up and tells the owner, it never closes it.
 * - EVM block number: closes when the selected read policy sees it reached.
 * - Solana signature: closes when the selected read policy sees it finalized with no
 *   error; a failed transaction blocks it. Solana has no block-number watch.
 * - A time: closes when it passes, with no chain read.
 *
 * Reads go through the transaction check's read layer only: the same
 * explicit Alchemy-only or paired mode, the same chain switch (SUPPORT_DIAGNOSIS_ENABLED
 * plus the SUPPORT_DIAGNOSIS_CHAINS policy var) and the workspace's RPC
 * budget; a budget refusal defers the check. At most 200 watches per
 * workspace. Nothing is signed or sent; a watch only reads. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import {
  FOLLOW_UP_LIMITS,
  parseFollowUpWatch,
} from "@templ/chat/support-follow-ups";
import {
  agreeSolanaStatus,
  solanaStatusView,
} from "@templ/chat/diagnosis/solana-normalize";
import {
  isEvmTransactionHash,
  isSolanaSignature,
} from "@templ/chat/support-context";
import type { SupportNetwork } from "@templ/chat/support";
import { HttpError, type Env } from "./common";
import {
  diagnosisEndpoints,
  diagnosisPrimaryEndpoint,
  solanaDiagnosisPrimaryEndpoint,
} from "./chain-rpc";
import type { DiagnosisReadSource } from "@templ/chat/diagnosis/types";
import { createRpcBudget, RPC_BUDGET, type RpcBudgetEnv } from "./rpc-budget";
import { solanaEndpoints } from "./solana";
import type { ChatEvent } from "@templ/chat/events";
import {
  WATCH_ACTIVE_PREFIX,
  WATCH_DUE_PREFIX,
  closeByWatch,
  closeMetWatches,
  commitAlarmLine,
  recountThread,
  followUpKey,
  isActive,
  pad16,
  readFollowUp,
  refreshFollowUpLine,
  syncIndexes,
  threadFollowUps,
  waitsOnOpen,
  watchDueKey,
  type FollowUpRecord,
  type StoredFollowUp,
  type StoredWatch,
  type StoredWatchSpec,
} from "./support-follow-ups";
import {
  queueSupportNotification,
  recordSupportActivity,
  supportRecord,
  supportSettings,
} from "./support-workflow";
import { DIAGNOSIS_NETWORKS_HEADER } from "./support-diagnosis";
import type { AlertEnv } from "./alert-outbox";
import { agreedLatestHead, chainIdMatches } from "./tx-diagnosis/heads";
import { createRunMeter } from "./tx-diagnosis/budgets";
import {
  enabledDiagnosisChains,
  solanaDiagnosisEnabled,
  type DiagnosisEnv,
} from "./tx-diagnosis/chains";
import {
  createDiagnosisRpc,
  createPrimaryDiagnosisRpc,
  type Fetcher,
} from "./tx-diagnosis/rpc";
import { readAgreedReceiptStatus } from "./tx-diagnosis/watch";
import { pairFailure } from "./tx-diagnosis/agree";
import { isRegisteredBot, supportLeads } from "./support-follow-up-access";

type Storage = DurableObjectTransaction;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const WATCHES_PER_WORKSPACE = FEATURE_LIMITS.supportWatchesPerWorkspace;
/** Chain checks one alarm invocation runs (time watches need none). Each
 * check stays under 12 provider requests per side. */
export const WATCH_READS_PER_INVOCATION = 4;

/** Networks the edge says are on for checks, from the header the worker
 * sets on every conversation call. */
export function enabledWatchNetworks(headers: Headers): SupportNetwork[] {
  const value = headers.get(DIAGNOSIS_NETWORKS_HEADER) ?? "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(
      (item): item is SupportNetwork =>
        item === "solana" || /^eip155:[1-9][0-9]*$/.test(item),
    );
}
const invalid = () =>
  new HttpError(
    400,
    "Choose a transaction, a block number or a time to watch.",
    undefined,
    "watch-invalid",
  );
/** The next time a watch is checked: every 5 minutes in its first hour,
 * every 15 minutes to a day, then hourly. A time watch waits for its time. */
export function nextWatchCheck(watch: StoredWatch, now: number): number {
  if (watch.spec.kind === "time") return Math.max(watch.spec.at, now + 1_000);
  const age = now - watch.setAt;
  const step =
    age < HOUR_MS ? 5 * MINUTE_MS : age < DAY_MS ? 15 * MINUTE_MS : HOUR_MS;
  return now + step;
}
/** Validates a watch for a follow-up (null clears it). Person only; the
 * caller checks who acts. */
export async function buildWatch(
  storage: Pick<DurableObjectStorage, "list">,
  input: {
    headers: Headers;
    actor: import("@templ/chat/principal").ChatPrincipalId;
    followUp: StoredFollowUp;
    value: unknown;
    now: number;
  },
): Promise<StoredWatch | null> {
  if (input.value === null) return null;
  const parsed = parseFollowUpWatch(input.value);
  if (!parsed) throw invalid();
  const now = input.now;
  let spec: StoredWatchSpec;
  if (parsed.kind === "time") {
    const at = Date.parse(parsed.at);
    if (at <= now || at > now + FOLLOW_UP_LIMITS.watchMaxDays * DAY_MS)
      throw new HttpError(
        400,
        "Choose a time within 30 days.",
        undefined,
        "watch-time",
      );
    spec = { kind: "time", at };
  } else {
    const networks = enabledWatchNetworks(input.headers);
    if (!networks.includes(parsed.network))
      throw new HttpError(
        409,
        "Templ doesn't check that network yet.",
        undefined,
        "watch-network",
      );
    if (parsed.kind === "tx") {
      const ok =
        parsed.network === "solana"
          ? isSolanaSignature(parsed.hash)
          : isEvmTransactionHash(parsed.hash);
      if (!ok) throw invalid();
      spec = { kind: "tx", network: parsed.network, hash: parsed.hash };
    } else spec = parsed;
  }
  const already = input.followUp.watch?.state === "watching";
  if (!already) {
    const active = await storage.list({
      prefix: WATCH_ACTIVE_PREFIX,
      limit: WATCHES_PER_WORKSPACE + 1,
    });
    if (active.size >= WATCHES_PER_WORKSPACE)
      throw new HttpError(
        409,
        "This workspace is watching 200 follow-ups, the most it can. Close some to add more.",
        undefined,
        "watch-capacity",
      );
  }
  const watch: StoredWatch = {
    spec,
    setAt: now,
    setBy: input.actor,
    state: "watching",
    checks: 0,
    nextCheckAt: null,
    lastCheckedAt: null,
    lastResult: "pending",
  };
  watch.nextCheckAt = spec.kind === "time" ? spec.at : now + MINUTE_MS;
  return watch;
}

/* ---------------------------------------------------------------------- */
/* Chain reads                                                              */
/* ---------------------------------------------------------------------- */

export type WatchOutcome = (
  | { kind: "settled" }
  | { kind: "reached" }
  | { kind: "reverted" }
  | { kind: "failed" }
  | { kind: "pending"; result: "not-mined" | "confirming" | "pending" }
  | { kind: "unavailable"; result: "unavailable" | "not-configured" }
) & { readSource?: DiagnosisReadSource };
export type WatchReaders = {
  evmReceipt(
    env: DiagnosisEnv,
    network: string,
    hash: `0x${string}`,
  ): Promise<WatchOutcome>;
  evmBlock(
    env: DiagnosisEnv,
    network: string,
    target: number,
  ): Promise<WatchOutcome>;
  solanaSignature(env: DiagnosisEnv, signature: string): Promise<WatchOutcome>;
};
export function watchReaders(
  deps: { fetcher?: Fetcher; now?: () => number } = {},
): WatchReaders {
  const now = deps.now ?? (() => Date.now());
  return {
    async evmReceipt(env, network, hash) {
      const status = await readAgreedReceiptStatus(env, network, hash, deps);
      const source = status.readSource ? { readSource: status.readSource } : {};
      if (status.state === "not-mined")
        return { kind: "pending", result: "not-mined", ...source };
      if (status.state === "unavailable")
        return status.reason === "not-configured"
          ? { kind: "unavailable", result: "not-configured", ...source }
          : { kind: "unavailable", result: "unavailable", ...source };
      if (!status.success) return { kind: "reverted", ...source };
      return status.settled
        ? { kind: "settled", ...source }
        : { kind: "pending", result: "confirming", ...source };
    },
    async evmBlock(env, network, target) {
      const chain = enabledDiagnosisChains(env).find(
        (item) => item.network === network,
      );
      const primaryOnly = env.SUPPORT_DIAGNOSIS_RPC_MODE === "alchemy";
      const primary =
        chain && primaryOnly ? diagnosisPrimaryEndpoint(env, chain.id) : null;
      const endpoints =
        chain && !primaryOnly ? diagnosisEndpoints(env, chain.id) : null;
      if (!chain || (!primary && !endpoints))
        return { kind: "unavailable", result: "not-configured" };
      const rpcDeps = {
        fetcher: deps.fetcher,
        now,
        deadlineAt: now() + 10_000,
        meter: createRunMeter(8),
      };
      const rpc = primary
        ? createPrimaryDiagnosisRpc(env, "evm", primary, rpcDeps)
        : createDiagnosisRpc(env, "evm", endpoints!, rpcDeps);
      const source = primary
        ? {
            readSource: {
              providerCount: 1 as const,
              source: "alchemy" as const,
            },
          }
        : {};
      if (primary) {
        const identity = await chainIdMatches(rpc, chain.id);
        if (!identity.ok)
          return { kind: "unavailable", result: "unavailable", ...source };
      }
      const head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
      if (!head.ok)
        return { kind: "unavailable", result: "unavailable", ...source };
      return BigInt(head.block.number) >= BigInt(target)
        ? { kind: "reached", ...source }
        : { kind: "pending", result: "pending", ...source };
    },
    async solanaSignature(env, signature) {
      if (!solanaDiagnosisEnabled(env))
        return { kind: "unavailable", result: "not-configured" };
      const primary =
        env.SUPPORT_DIAGNOSIS_RPC_MODE === "alchemy"
          ? solanaDiagnosisPrimaryEndpoint(env)
          : null;
      const rpcDeps = {
        fetcher: deps.fetcher,
        now,
        deadlineAt: now() + 10_000,
        meter: createRunMeter(4),
      };
      const rpc = primary
        ? createPrimaryDiagnosisRpc(env, "solana", primary, rpcDeps)
        : createDiagnosisRpc(env, "solana", solanaEndpoints(env), rpcDeps);
      const source = primary
        ? {
            readSource: {
              providerCount: 1 as const,
              source: "alchemy" as const,
            },
          }
        : {};
      const pair = await rpc.both("getSignatureStatuses", [
        [signature],
        { searchTransactionHistory: true },
      ]);
      if (pairFailure(pair))
        return { kind: "unavailable", result: "unavailable", ...source };
      try {
        const views = pair.map((side) => {
          const value = (side.result as { value?: unknown } | undefined)?.value;
          if (!Array.isArray(value) || value.length !== 1)
            throw new Error("status");
          if (
            primary &&
            value[0] !== null &&
            (!value[0] ||
              typeof value[0] !== "object" ||
              !Object.hasOwn(value[0], "err") ||
              value[0].err === undefined)
          )
            throw new Error("status error missing");
          return solanaStatusView(value[0]);
        });
        if (views.length === 1) {
          const fact = views[0];
          if (!fact) return { kind: "pending", result: "not-mined", ...source };
          if (fact.commitment === "processed")
            return { kind: "pending", result: "confirming", ...source };
          if (fact.err) return { kind: "failed", ...source };
          return fact.commitment === "finalized"
            ? { kind: "settled", ...source }
            : { kind: "pending", result: "confirming", ...source };
        }
        const fact = agreeSolanaStatus(views[0], views[1]);
        if (fact.kind === "agreed" && !fact.found)
          return { kind: "pending", result: "not-mined" };
        // Only both providers, at confirmed or finalized, can fail it; one
        // provider's error or one seen at processed is still confirming.
        if (fact.kind !== "agreed")
          return { kind: "pending", result: "confirming" };
        if (fact.err) return { kind: "failed" };
        return fact.commitment === "finalized"
          ? { kind: "settled" }
          : { kind: "pending", result: "confirming" };
      } catch {
        return { kind: "unavailable", result: "unavailable", ...source };
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* The consumer                                                             */
/* ---------------------------------------------------------------------- */

const WATCH_KEY =
  /^support-watch-due-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([1-9][0-9]{0,7}-[1-9][0-9]?)$/;
export type WatchAlarmEnv = DiagnosisEnv &
  AlertEnv & {
    ROOMS?: DurableObjectNamespace;
    SUPPORT_FOLLOW_UPS_ENABLED?: string;
  };
export type WatchAlarmDeps = {
  readers?: WatchReaders;
  covered(storage: Storage, now: number): Promise<boolean>;
  appOrigin: string | null;
  /** Delivers the room events a committed run logged to open sessions. */
  afterCommit?: (events: ChatEvent[]) => void;
};
type Planned = {
  key: string;
  thread: string;
  id: string;
  revision: number;
  spec: StoredWatchSpec;
};
async function notifyOwner(
  storage: Storage,
  target: { now: number; room: string; appOrigin: string },
  f: StoredFollowUp,
  env: WatchAlarmEnv,
) {
  if (!target.appOrigin) return;
  const record = await storage.get<FollowUpRecord>(
    `conversation-v1:${f.thread}`,
  );
  if (!record) return;
  const recipients = f.owner
    ? [f.owner]
    : await supportLeads(storage, env, target.now);
  for (const recipient of recipients)
    if (!(await isRegisteredBot(storage, recipient)))
      await queueSupportNotification(
        storage,
        { ...target, mediaEnv: env as Env },
        record,
        recipient,
        "follow-up",
        undefined,
        { wake: false },
      );
}
/** Applies what a check found to the follow-up, if it is still the same
 * watch on the same revision. A check that changes nothing a person edits
 * (still pending, or met while earlier steps are open) keeps the revision,
 * so a person's edit in the meantime isn't refused as stale. */
async function commitOutcome(
  storage: Storage,
  env: WatchAlarmEnv,
  plan: Planned,
  outcome: WatchOutcome,
  now: number,
  target: { now: number; room: string; appOrigin: string },
  events: ChatEvent[],
) {
  const before = await readFollowUp(storage, plan.thread, plan.id);
  if (
    !before ||
    before.revision !== plan.revision ||
    before.watch?.state !== "watching" ||
    before.watch.nextCheckAt === null ||
    !isActive(before)
  ) {
    // Changed since the plan: a watch still due under this key keeps it and
    // is checked again on its new revision.
    const due =
      before &&
      isActive(before) &&
      before.watch?.state === "watching" &&
      before.watch.nextCheckAt !== null &&
      watchDueKey(before.watch.nextCheckAt, plan.thread, plan.id) === plan.key;
    if (!due) await storage.delete(plan.key);
    return;
  }
  await storage.delete(plan.key);
  const record = await storage.get<FollowUpRecord>(
    `conversation-v1:${plan.thread}`,
  );
  if (!record || record.deleting) return;
  const settings = await supportSettings(storage);
  const timeZone = settings.timezone;
  const data = await supportRecord(storage, record);
  const observed: StoredFollowUp = structuredClone(before);
  observed.watch!.checks++;
  observed.watch!.lastCheckedAt = now;
  if (outcome.readSource) observed.watch!.readSource = outcome.readSource;
  else delete observed.watch!.readSource;
  const met = outcome.kind === "settled" || outcome.kind === "reached";
  const { list } = await threadFollowUps(storage, before.thread, before.seq);
  if (met && !waitsOnOpen(before, list)) {
    const closed = await closeByWatch(
      storage,
      env,
      record,
      data,
      observed,
      now,
      timeZone,
      outcome.kind as "settled" | "reached",
    );
    // Steps met earlier that waited on this one close with it.
    const later = await closeMetWatches(
      storage,
      env,
      record,
      data,
      before.seq,
      now,
      timeZone,
    );
    await recountThread(storage, before.thread);
    if (await refreshFollowUpLine(storage, record, data, now, later ?? closed))
      await commitAlarmLine(storage, record, events, now);
    return;
  }
  const f = observed;
  const watch = f.watch!;
  const expired = now >= watch.setAt + FOLLOW_UP_LIMITS.watchMaxDays * DAY_MS;
  if (met) {
    // Met while earlier steps are open: no more checks; it closes when they
    // are done or cancelled (closeMetWatches).
    watch.lastResult = outcome.kind === "reached" ? "reached" : "settled";
    watch.nextCheckAt = null;
  } else if (outcome.kind === "reverted" || outcome.kind === "failed") {
    watch.state = "failed";
    watch.lastResult = outcome.kind;
    watch.nextCheckAt = null;
    f.state = "blocked";
  } else if (expired) {
    watch.state = "expired";
    watch.nextCheckAt = null;
    watch.lastResult =
      outcome.kind === "pending" || outcome.kind === "unavailable"
        ? outcome.result
        : watch.lastResult;
    f.state = "blocked";
  } else {
    watch.lastResult =
      outcome.kind === "pending" || outcome.kind === "unavailable"
        ? outcome.result
        : watch.lastResult;
    watch.nextCheckAt = nextWatchCheck(watch, now);
  }
  // Failed or expired changes what a person sees and edits.
  const settled = watch.state !== "watching";
  if (settled) f.revision = before.revision + 1;
  await storage.put(followUpKey(f.thread, f.seq, f.n), f);
  await syncIndexes(storage, before, f, timeZone);
  if (settled && f.state === "blocked" && before.state !== "blocked") {
    await recordSupportActivity(storage, record.id, data, {
      actor: watch.setBy,
      action: "follow-up",
      at: now,
      detail: watch.state === "failed" ? "watch-failed" : "watch-expired",
    });
    await notifyOwner(storage, target, f, env);
  }
}
/** Room alarm consumer `support-watches`: due checks in key order. Time
 * watches settle in the transaction; chain checks run outside any storage
 * transaction, charged to this workspace's RPC budget, at most
 * WATCH_READS_PER_INVOCATION per run. */
export async function supportWatchAlarm(
  context: { state: DurableObjectState; env: WatchAlarmEnv },
  now: number,
  deps: WatchAlarmDeps,
): Promise<number | null> {
  const { state } = context;
  const native = await state.storage.get<{ room: { id: string } }>(
    "native-room",
  );
  if (!native) return null;
  const target = {
    now,
    room: `room:${native.room.id}`,
    appOrigin: deps.appOrigin ?? "",
  };
  const readers = deps.readers ?? watchReaders();
  const events: ChatEvent[] = [];
  const prepared = await state.storage.transaction(async (tx) => {
    // Only the committed attempt's events are delivered.
    events.length = 0;
    if (!(await deps.covered(tx, now))) return "hold" as const;
    const due = await tx.list({
      prefix: WATCH_DUE_PREFIX,
      end: `${WATCH_DUE_PREFIX}${pad16(now + 1)}`,
      limit: FOLLOW_UP_LIMITS.alarmBatch,
    });
    const chain: Planned[] = [];
    for (const key of due.keys()) {
      const match = WATCH_KEY.exec(key);
      if (!match) {
        await tx.delete(key);
        continue;
      }
      const [, , thread, id] = match;
      const f = await readFollowUp(tx, thread, id);
      if (
        !f ||
        !isActive(f) ||
        f.watch?.state !== "watching" ||
        f.watch.nextCheckAt === null ||
        watchDueKey(f.watch.nextCheckAt, thread, id) !== key
      ) {
        await tx.delete(key);
        continue;
      }
      const plan = {
        key,
        thread,
        id,
        revision: f.revision,
        spec: f.watch.spec,
      };
      if (plan.spec.kind === "time")
        await commitOutcome(
          tx,
          context.env,
          plan,
          plan.spec.at <= now
            ? { kind: "reached" }
            : { kind: "pending", result: "pending" },
          now,
          target,
          events,
        );
      else if (chain.length < WATCH_READS_PER_INVOCATION) chain.push(plan);
    }
    return { chain, full: due.size >= FOLLOW_UP_LIMITS.alarmBatch };
  });
  if (events.length) deps.afterCommit?.([...events]);
  if (prepared === "hold") return now + DAY_MS;
  if (prepared.chain.length) {
    const budgetEnv = {
      ...context.env,
      ...(context.env.ROOMS
        ? { [RPC_BUDGET]: createRpcBudget(context.env as never) }
        : {}),
    } as WatchAlarmEnv & RpcBudgetEnv;
    if (context.env.ROOMS && budgetEnv[RPC_BUDGET])
      budgetEnv[RPC_BUDGET].setRoom(context.env.ROOMS.get(state.id), native.room.id, work => state.waitUntil(work()));
    for (const plan of prepared.chain) {
      let outcome: WatchOutcome;
      try {
        const spec = plan.spec;
        outcome =
          spec.kind === "block"
            ? await readers.evmBlock(budgetEnv, spec.network, spec.number)
            : spec.kind === "tx" && spec.network === "solana"
              ? await readers.solanaSignature(budgetEnv, spec.hash)
              : spec.kind === "tx"
                ? await readers.evmReceipt(
                    budgetEnv,
                    spec.network,
                    spec.hash as `0x${string}`,
                  )
                : { kind: "unavailable", result: "unavailable" };
      } catch {
        outcome = { kind: "unavailable", result: "unavailable" };
      }
      // The read took time; commit at the later of now and the clock.
      const at = Math.max(now, Date.now());
      const logged: ChatEvent[] = [];
      await state.storage.transaction((tx) => {
        logged.length = 0;
        return commitOutcome(
          tx,
          context.env,
          plan,
          outcome,
          at,
          { ...target, now: at },
          logged,
        );
      });
      if (logged.length) deps.afterCommit?.(logged);
    }
  }
  const next = await state.storage.list({ prefix: WATCH_DUE_PREFIX, limit: 1 });
  const first = [...next.keys()][0];
  const at = first ? Number(WATCH_KEY.exec(first)?.[1]) : NaN;
  if (prepared.full || prepared.chain.length >= WATCH_READS_PER_INVOCATION)
    return now + 1_000;
  return Number.isSafeInteger(at) ? Math.max(at, now + 1_000) : null;
}
