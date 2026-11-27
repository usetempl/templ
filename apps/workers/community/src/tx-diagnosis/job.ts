import { HttpError } from "../common";
import { createRpcBudget, RPC_BUDGET, type RpcBudgetEnv } from "../rpc-budget";
import type { RoomAlarmContext } from "../room-alarm";
import {
  DIAGNOSIS_LEASE_HEADER,
  DIAGNOSIS_NETWORKS_HEADER,
  DIAGNOSIS_PHASE_HEADER,
  abortDiagnosis,
  autoSubject,
  commitDiagnosis,
  contextTransactions,
  finishDiagnosisJob,
  nextDiagnosisJobs,
  planDiagnosis,
  readLease,
  sweepOrphanDiagnoses,
  type DiagnosisJob,
} from "../support-diagnosis";
import { diagnosisCoverage, threadFacts } from "../support-diagnosis-route";
import { supportRecord, type SupportRecord } from "../support-workflow";
import {
  memberIndexKey,
  readConversation,
  type ConversationEnv,
} from "../team-conversations";
import { DIAGNOSIS_READ_LIMITS } from "./budgets";
import {
  diagnosisNetworksHeader,
  enabledDiagnosisNetworks,
  keyGuardNetworks,
  type DiagnosisEnv,
} from "./chains";
import { readDiagnosisInput, type ReadDeps } from "./index";
import { isSolanaKeypair } from "./key-guard";
import type {
  DiagnosisRunPlan,
  DiagnosisReadResult,
  DiagnosisSubject,
} from "./plan";

const PATH = /^\/conversations\/(tc-[0-9a-f]{32})\/diagnosis$/;
const EDGE_HEADERS = /^x-diagnosis-/i;

function strip(response: Response): Response {
  const clean = new Response(response.body, response);
  for (const name of [...clean.headers.keys()])
    if (EDGE_HEADERS.test(name)) clean.headers.delete(name);
  return clean;
}

/** The edge half of a person's or an agent's check. Sets the enabled
 * networks on every conversation call, then for the diagnosis path runs
 * prepare, reads the chain here (under the request's RPC budget, already
 * scoped to this workspace), and commits. Headers a client sent never reach
 * the room: the worker builds them, and the phase is set only here. */
export async function diagnosisWorkerRoute(
  env: DiagnosisEnv & ConversationEnv,
  room: DurableObjectStub,
  headers: Headers,
  input: {
    path: string;
    search?: string;
    method: string;
    body?: Record<string, unknown>;
  },
  deps: ReadDeps = {},
): Promise<Response | null> {
  for (const name of [...headers.keys()])
    if (EDGE_HEADERS.test(name)) headers.delete(name);
  headers.set(DIAGNOSIS_NETWORKS_HEADER, diagnosisNetworksHeader(env));
  if (!PATH.test(input.path)) return null;
  headers.set(
    "X-Support-Workflow",
    String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
  );
  const call = (phase: string | null, body?: unknown) => {
    const scoped = new Headers(headers);
    if (phase) scoped.set(DIAGNOSIS_PHASE_HEADER, phase);
    return room.fetch(
      new Request(`https://internal${input.path}${input.search ?? ""}`, {
        method: input.method,
        headers: scoped,
        ...(input.method === "POST"
          ? { body: JSON.stringify(body ?? {}) }
          : {}),
      }),
    );
  };
  if (input.method !== "POST") return strip(await call(null));
  const body = input.body ?? {};
  if (body.action === "rate") return strip(await call("rate", body));
  const prepared = await call("prepare", body);
  const leaseId = prepared.headers.get(DIAGNOSIS_LEASE_HEADER);
  if (prepared.status !== 200 || !leaseId) return strip(prepared);
  const { plan } = await prepared.json<{ plan: DiagnosisRunPlan }>();
  let result: DiagnosisReadResult;
  try {
    result = await readDiagnosisInput(env, plan, deps);
  } catch (error) {
    await call("abort", { lease: leaseId, calls: 1 }).catch(() => undefined);
    throw error;
  }
  const committed = await call("commit", {
    lease: leaseId,
    outcome: result.kind,
    ...(result.kind === "input"
      ? { input: result.input, profileRefs: result.profileRefs }
      : {}),
    reads: result.reads,
  });
  if (committed.status === 409) {
    // The lease expired or the input no longer matched: nothing was stored.
    await committed.body?.cancel().catch(() => undefined);
    const reason = committed.headers.get("X-Error-Reason");
    void reason;
    throw new HttpError(
      503,
      "The check couldn't be saved. Try again.",
      undefined,
      "diagnosis-unavailable",
    );
  }
  return strip(committed);
}

/* Automatic runs in the room alarm                                        */

type JobPlan = {
  plan: DiagnosisRunPlan;
  thread: string;
  kind: DiagnosisJob["kind"] | "key-guard";
};

async function prepareJob(
  tx: DurableObjectTransaction,
  env: DiagnosisEnv,
  job: DiagnosisJob,
  now: number,
): Promise<JobPlan | null> {
  const thread =
    job.thread ??
    (job.member
      ? ((await tx.get<string>(memberIndexKey(job.member as never))) ?? null)
      : null);
  if (!thread) return null;
  const record = await readConversation(tx as never, thread);
  if (!record) return null;
  const data = await supportRecord(tx as never, record);
  const enabled = enabledDiagnosisNetworks(env);
  const guardEnabled = keyGuardNetworks(env);
  if (!guardEnabled.length && !enabled.length) return null;
  const facts = threadFacts(record, data);
  // With Solana checks off no full check reads a Solana value, so a pasted
  // Solana keypair gets the key guard alone. The guard is local: nothing is
  // sent, and the refusal removes the value from the shared details.
  let pasted: DiagnosisSubject | null = null;
  if (!enabled.includes("solana"))
    for (const { subject: item } of contextTransactions(data.context))
      if (item.kind === "solana" && (await isSolanaKeypair(item.signature))) {
        pasted = item;
        break;
      }
  const subject =
    pasted ?? (await autoSubject(tx as never, facts, guardEnabled, now));
  if (!subject) return null;
  const coverage = await diagnosisCoverage(tx as never, now);
  const base = {
    storage: tx as never,
    facts,
    actor: job.actor,
    clientId: null,
    subject,
    staffNetwork: null,
    fromExplorer: false,
    enabled,
    coverage,
    force: false,
    now,
    deadlineMs: DIAGNOSIS_READ_LIMITS.jobDeadlineMs,
  };
  const guard = async (): Promise<JobPlan | null> => {
    try {
      const planned = await planDiagnosis({
        ...base,
        enabled: guardEnabled,
        coverage: { enabled: true, funded: coverage.funded },
        trigger: "key-guard",
      });
      return planned.kind === "plan"
        ? { plan: planned.plan, thread, kind: "key-guard" }
        : null;
    } catch {
      return null;
    }
  };
  if (pasted || !enabled.length) return guard();
  try {
    const planned = await planDiagnosis({ ...base, trigger: job.kind });
    return planned.kind === "plan"
      ? { plan: planned.plan, thread, kind: job.kind }
      : null;
  } catch (error) {
    // No full check today (a limit, or a paused workspace): the key guard still
    // runs under its own daily limit, so a pasted key is removed from the
    // shared details either way.
    if (!(error instanceof HttpError)) return null;
    return guard();
  }
}

async function commitJob(
  tx: DurableObjectTransaction,
  planned: JobPlan,
  result: DiagnosisReadResult,
  now: number,
  env: RoomAlarmContext["env"],
) {
  const { plan, thread } = planned;
  let lease;
  try {
    lease = await readLease(tx as never, thread, plan.lease, now);
  } catch {
    return;
  }
  const record = await readConversation(tx as never, thread);
  if (!record) {
    await tx.delete(`support-diagnosis-run-v1:${thread}`);
    return;
  }
  const data = await supportRecord(tx as never, record);
  // A member who removed the transaction from the shared details before the
  // check finished withdrew it: nothing is stored.
  if (
    planned.kind === "member-share" &&
    !contextTransactions(data.context).some(
      (item) =>
        item.subject.kind === lease.subject.kind &&
        (item.subject.kind === "evm"
          ? item.subject.hash === (lease.subject as { hash: string }).hash
          : item.subject.signature ===
            (lease.subject as { signature: string }).signature),
    )
  ) {
    await tx.delete(`support-diagnosis-run-v1:${thread}`);
    return;
  }
  await commitDiagnosis(tx as never, {
    env,
    thread,
    lease,
    body: {
      lease: plan.lease,
      outcome: result.kind,
      ...(result.kind === "input"
        ? { input: result.input, profileRefs: result.profileRefs }
        : {}),
      reads: result.reads,
    },
    now,
    readContext: async () => data.context,
    writeContext: async (next) => {
      data.context = next as SupportRecord["context"];
      await tx.put(`support-workflow-v1:${record.id}`, data);
    },
  }).catch((error) => {
    if (!(error instanceof HttpError)) throw error;
  });
}

/** Chain reads one alarm invocation runs. One run stays under 700 of the
 * 1,000 subrequests an invocation may make (budgets.ts), and the consumers
 * after this one need theirs; more queued checks wake the room again. */
export const DIAGNOSIS_READS_PER_INVOCATION = 1;

/** Room alarm consumer: plans queued automatic checks until one needs a
 * chain read, runs that one, then the daily orphan sweep. A queued job that
 * plans nothing (withdrawn, a limit) is dropped without a read. Reads happen
 * outside any storage transaction, charged to this workspace's RPC budget. */
export async function runDiagnosisJobs(
  context: Pick<RoomAlarmContext, "state" | "env">,
  now: number,
  deps: ReadDeps = {},
): Promise<number | null> {
  const { state } = context;
  const env = context.env as unknown as DiagnosisEnv;
  const jobs = await nextDiagnosisJobs(state.storage, 3);
  let reads = 0;
  for (const { key, job } of jobs) {
    if (reads >= DIAGNOSIS_READS_PER_INVOCATION) break;
    if (job && job.at > now) continue;
    const planned = await state.storage.transaction(async (tx) => {
      await tx.delete(key);
      const planned = job ? await prepareJob(tx, env, job, now) : null;
      if (job && !planned) await finishDiagnosisJob(tx as never, job, now);
      return planned;
    });
    if (!planned) continue;
    const budgetEnv = {
      ...env,
      [RPC_BUDGET]: createRpcBudget(env as never),
    } as DiagnosisEnv & RpcBudgetEnv;
    budgetEnv[RPC_BUDGET]!.setRoom(env.ROOMS.get(state.id));
    let result: DiagnosisReadResult;
    reads++;
    try {
      try {
        result = await readDiagnosisInput(budgetEnv, planned.plan, deps);
      } catch {
        await state.storage.transaction((tx) =>
          abortDiagnosis(
            tx as never,
            planned.thread,
            planned.plan.lease,
            1,
            Date.now(),
          ),
        );
        continue;
      }
      await state.storage.transaction((tx) =>
        commitJob(tx, planned, result, Date.now(), env),
      );
    } finally {
      if (job)
        await state.storage.transaction((tx) =>
          finishDiagnosisJob(tx as never, job, Date.now()),
        );
    }
  }
  const more = await nextDiagnosisJobs(state.storage, 1);
  const orphanDue = await sweepOrphanDiagnoses(state.storage as never, now);
  if (more.length) {
    const due = more[0].job?.at ?? now;
    return Math.min(Math.max(due, now + 1_000), orphanDue ?? Infinity);
  }
  return orphanDue;
}
