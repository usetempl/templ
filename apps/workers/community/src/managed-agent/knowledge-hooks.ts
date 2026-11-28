import { CRYPTO_MONTHLY_BUDGET_CENTS, CRYPTO_SUPPORT_MODEL, LEGACY_SUPPORT_MODEL, type SupportModel } from "@templ/chat/support-models";
import { CRYPTO_SUPPORT_WORKSPACE } from "../crypto-support";
import { trialPractice, templFundedInference } from "./trial-practice";
import { verifyGroundedReceipt } from "./grounded";
import { cryptoChainReader } from "./crypto-chain-reader";
import { workspaceFeatureEnvFor } from "../workspace-flags";
import { recordWorkspaceCost } from "../workspace-cost-recording";
import type { WorkspaceCostEvent } from "@templ/chat/workspace-costs";
/** Managed AI inside the SupportKnowledge object: the room's managed ops,
 * Templ's spend meter (one object of the same class, named
 * `managed-spend:v1`, that answers nothing else) and the runner in the
 * object's own alarm. SupportKnowledge calls these from one line in its
 * fetch and one in its alarm. */
import {
  MANAGED_JOB_KINDS,
  spendMonth,
  type ManagedAgentView,
} from "@templ/chat/managed-agent";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  KnowledgeError,
  ensureSchema,
  readMeta,
  writeMeta,
  type KnowledgeDb,
} from "../support-knowledge-schema";
import { anthropicCaller } from "./anthropic";
import { TRIAL_RECEIPT_HEADERS } from "./knowledge-client";
import { prepaidGptCaller, fundedGptCaller } from "./gpt";
import type { ManagedJob } from "./room";
import { managedPrincipal } from "./principal";
import { roomClient, type RoomClientEnv } from "./room-client";
import {
  queueGolden,
  runManagedJobs,
  type RunnerDeps,
  type RunnerEnv,
  type TemplMeter,
} from "./runner";
import {
  acceptedRun,
  addJobs,
  currentFingerprint,
  goldenCases,
  goldenJobQueued,
  goldenManualAt,
  goldenState,
  lastGolden,
  nextJobDue,
  pruneSpend,
  setGoldenManual,
  templSpendRequest,
  workspaceSpend,
  reserveSpend, settleSpend, saveWorkspaceSpend,
  type StoredJob,
} from "./store";
import type { GoldenCaseView } from "@templ/chat/golden-set";

/** A person may ask for a golden check this often. */
export const GOLDEN_MANUAL_MS = 10 * 60_000;

export type ManagedKnowledgeEnv = RunnerEnv &
  RoomClientEnv & {
    SUPPORT_KNOWLEDGE?: DurableObjectNamespace;
    COST_METRICS?: DurableObjectNamespace;
  };
export const TEMPL_SPEND_OBJECT = "managed-spend:v1";
const ROOM =
  /^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD = /^tc-[0-9a-f]{32}$/;
const REQUEST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL = /^(?:0x[0-9a-f]{40}|account:[0-9a-f-]{36})$/;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/** The object binds to one room, as for every knowledge operation. */
function bindRoom(db: KnowledgeDb, room: unknown, now: number): string {
  ensureSchema(db, now);
  if (typeof room !== "string" || !ROOM.test(room))
    throw new KnowledgeError(400, "knowledge-room", "Unknown workspace.");
  const bound = readMeta(db, "room");
  if (bound === null) writeMeta(db, "room", room);
  else if (bound !== room) {
    console.error("TEMPL_KNOWLEDGE_ROOM_MISMATCH");
    throw new KnowledgeError(
      500,
      "knowledge-room",
      "Support knowledge is unavailable.",
    );
  }
  return room;
}

function checkedJobs(raw: unknown, manager: unknown, now: number): StoredJob[] {
  if (
    !Array.isArray(raw) ||
    raw.length > 50 ||
    typeof manager !== "string" ||
    !PRINCIPAL.test(manager)
  )
    throw new KnowledgeError(400, "managed-jobs", "Invalid jobs.");
  return raw.map((item) => {
    const job = item as ManagedJob;
    if (
      !job ||
      job.v !== 1 ||
      !MANAGED_JOB_KINDS.includes(job.kind) ||
      job.kind === ("golden" as never) ||
      typeof job.thread !== "string" ||
      !THREAD.test(job.thread) ||
      !(job.request === null || REQUEST.test(job.request)) ||
      (job.kind === "ask-ai") !== (job.request !== null) ||
      (job.kind === "handoff-learning" &&
        (typeof job.learningId !== "string" || !/^[a-f0-9]{64}$/.test(job.learningId))) ||
      !Number.isSafeInteger(job.at)
    )
      throw new KnowledgeError(400, "managed-jobs", "Invalid jobs.");
    return {
      id: crypto.randomUUID(),
      kind: job.kind,
      thread: job.thread,
      request: job.request,
      manager,
      at: job.at,
      due: now,
      attempts: 0,
      ...(job.kind === "handoff-learning" ? { learning: { id: job.learningId! } } : {}),
    };
  });
}

async function goldenView(db: KnowledgeDb) {
  const fingerprint = await currentFingerprint(db);
  const last = lastGolden(db);
  const accepted = acceptedRun(db);
  const cases: GoldenCaseView[] = goldenCases(db).map((golden) => ({
    id: golden.key,
    firstTurn: (
      golden.case.input.turns.find((turn) => turn.role === "member")?.text ??
      golden.case.input.turns[0].text
    ).slice(0, 80),
    action: golden.case.expected.action,
  }));
  return {
    cases,
    state: goldenState(db, fingerprint),
    running: goldenJobQueued(db),
    last: last
      ? {
          at: last.run.at,
          fingerprint: last.run.fingerprint,
          results: last.run.results,
          gate: last.gate,
        }
      : null,
    acceptedAt: accepted?.at ?? null,
  };
}

/** One managed op from the room. */
export async function managedOperation(
  db: KnowledgeDb,
  body: Record<string, unknown>,
  now: number,
): Promise<unknown> {
  bindRoom(db, body.room, now);
  const args = (body.args ?? {}) as Record<string, unknown>;
  switch (body.op) {
    case "grounded.verify":
      return verifyGroundedReceipt(db, args, now);
    case "jobs.add": {
      const jobs = checkedJobs(args.jobs, args.manager, now);
      addJobs(db, jobs);
      return { queued: jobs.length };
    }
    case "status": {
      const { month, record } = workspaceSpend(db, now);
      const golden = await goldenView(db);
      const view: Pick<ManagedAgentView, "golden"> & {
        spend: { month: string; usedCents: number };
      } = {
        spend: { month, usedCents: record.spentCents },
        golden: {
          state: golden.state,
          cases: golden.cases.length,
          lastRunAt: golden.last?.at ?? null,
          regressions: golden.last?.gate.regressions ?? [],
          failing: golden.last?.gate.failing ?? [],
        },
      };
      return view;
    }
    case "golden.get":
      return goldenView(db);
    case "golden.run": {
      // Every check spends the workspace's budget: one at a time, and a
      // person's request at most every ten minutes.
      if (!goldenCases(db).length)
        throw new KnowledgeError(
          409,
          "golden-empty",
          "Add cases to the golden set under Answer reviews on Reports first.",
        );
      if (goldenJobQueued(db))
        throw new KnowledgeError(
          429,
          "golden-running",
          "A check is already running.",
        );
      const last = goldenManualAt(db);
      if (last !== null && now - last < GOLDEN_MANUAL_MS)
        throw new KnowledgeError(
          429,
          "golden-rate",
          "You asked for a check a few minutes ago. Try again in 10 minutes.",
        );
      setGoldenManual(db, now);
      queueGolden({ db }, now, true);
      return { queued: true };
    }
    default:
      throw new KnowledgeError(404, "managed-op", "Not found.");
  }
}

/** Templ's meter, reached from any workspace's runner. */
function templMeter(env: ManagedKnowledgeEnv): TemplMeter {
  const call = async (body: Record<string, unknown>) => {
    const namespace = env.SUPPORT_KNOWLEDGE;
    if (!namespace) throw new Error("managed-spend-unavailable");
    const response = await namespace
      .get(namespace.idFromName(TEMPL_SPEND_OBJECT))
      .fetch("https://knowledge.internal/managed/spend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    if (!response.ok) throw new Error("managed-spend-unavailable");
    return (await response.json()) as { ok: boolean };
  };
  return {
    async reserve(month, id, cents, cap) {
      return (await call({ op: "reserve", month, id, cents, cap })).ok === true;
    },
    async settle(month, id, cents) {
      await call({ op: "settle", month, id, cents });
    },
    async release(month, id) {
      await call({ op: "release", month, id, cents: 0 });
    },
  };
}

/** The runner's dependencies for this object's room. */
export async function runnerDeps(
  db: KnowledgeDb,
  env: ManagedKnowledgeEnv,
  overrides: Partial<
    Pick<RunnerDeps, "model" | "templMeter" | "roomClient" | "now">
  > = {},
  schedule: (promise: Promise<unknown>) => void = () => {},
): Promise<RunnerDeps | null> {
  const room = readMeta(db, "room");
  if (!room || !ROOM.test(room)) return null;
  env = await workspaceFeatureEnvFor(env, room.slice("room:".length));
  const principal: ChatPrincipalId = await managedPrincipal(room);
  let recording = Promise.resolve();
  const observeCost = (event: WorkspaceCostEvent) => {
    recording = recording
      .then(async () => {
        await recordWorkspaceCost(env, room.slice(5), "native-ai", event);
      })
      .catch(() => {});
    schedule(recording);
  };
  return {
    db,
    env,
    room,
    principal,
    ...(room === "room:" + CRYPTO_SUPPORT_WORKSPACE ? { chainRead: cryptoChainReader() } : {}),
    ...(env.AI &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")
      ? {
          prepaidModel: (billing: import("./room-client").RoomClient, sponsoredResearch?: boolean, model: SupportModel = LEGACY_SUPPORT_MODEL) => {
            const options = { ai: env.AI!, gatewayId: env.MANAGED_AGENT_GATEWAY_ID!, observeCost };
            if (room !== "room:" + CRYPTO_SUPPORT_WORKSPACE || !sponsoredResearch) return prepaidGptCaller({ ...options, billing, model });
            const cap = CRYPTO_MONTHLY_BUDGET_CENTS;
            return fundedGptCaller({ ...options, model: CRYPTO_SUPPORT_MODEL }, templFundedInference({
              async reserve(month, id, cents) {
                return db.transaction(() => {
                  const now = Date.now();
                  const current = workspaceSpend(db, now);
                  if (current.month !== month) return false;
                  const admitted = reserveSpend(current.record, { id, cents, cap, now, sponsored: true });
                  saveWorkspaceSpend(db, month, current.record);
                  return admitted;
                });
              },
              async settle(month, id, cents) {
                db.transaction(() => {
                  const { record } = workspaceSpend(db, Date.parse(month + "-01T00:00:00Z"));
                  if (!record.reservations[id]) throw new Error("Unconfirmed sponsored AI usage.");
                  settleSpend(record, id, cents);
                  saveWorkspaceSpend(db, month, record);
                });
              },
            }, cap));
          },
        }
      : {}),
    roomClient:
      overrides.roomClient ??
      ((manager) => roomClient(env, { room, manager, principal })),
    model:
      overrides.model !== undefined
        ? overrides.model
        : env.AI &&
            /^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")
          ? anthropicCaller({
              ai: env.AI,
              gatewayId: env.MANAGED_AGENT_GATEWAY_ID!,
              observeCost,
            })
          : env.ANTHROPIC_API_KEY
            ? anthropicCaller({ apiKey: env.ANTHROPIC_API_KEY, observeCost })
            : null,
    templMeter: overrides.templMeter ?? templMeter(env),
    now: overrides.now ?? (() => Date.now()),
  };
}

/** A practice question's delivery receipt. The 200 starts, with one flushed
 * space, only once the attempt is reserved; a refusal before that throws as it
 * does without a receipt. The answer follows as JSON, or `{ error, status }`
 * when it fails. The answer runs to its settlement after a caller leaves. */
async function trialPracticeReceipt(
  state: DurableObjectState,
  db: KnowledgeDb,
  env: ManagedKnowledgeEnv,
  args: Record<string, unknown>,
): Promise<Response> {
  let accept = () => {};
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const outcome = trialPractice(db, env, templMeter(env), args, accept).then(
    (value) => ({ value }),
    (failure: unknown) => ({ failure }),
  );
  if (typeof state.waitUntil === "function") state.waitUntil(outcome);
  const early = await Promise.race([accepted, outcome]);
  if (early) {
    if ("failure" in early) throw early.failure;
    return json(early.value);
  }
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  stream.enqueue(encoder.encode(" "));
  void outcome.then((result) => {
    let answer: unknown;
    if (!("failure" in result)) answer = result.value;
    else if (result.failure instanceof KnowledgeError)
      answer = { error: result.failure.message, status: result.failure.status };
    else {
      console.error("TEMPL_MANAGED_FAILURE", { path: "/managed/op" });
      answer = { error: "Managed AI is unavailable.", status: 503 };
    }
    try {
      stream.enqueue(encoder.encode(JSON.stringify(answer)));
      stream.close();
    } catch {
      /* The caller left. The attempt has already settled. */
    }
  });
  return new Response(body, { headers: TRIAL_RECEIPT_HEADERS });
}

/** SupportKnowledge's fetch hook: null for any path it does not own. */
export async function managedKnowledgeFetch(
  state: DurableObjectState,
  db: KnowledgeDb,
  request: Request,
  env?: ManagedKnowledgeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith("/managed/"))
    return null;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Not found." }, 404);
  }
  try {
    if (url.pathname === "/managed/spend")
      return json(await templSpendRequest(state.storage, body, Date.now()));
    if (url.pathname === "/managed/op") {
      if (body.op === "trial.practice") {
        bindRoom(db, body.room, Date.now());
        if (!env) throw new KnowledgeError(503, "trial-ai-practice", "AI practice is unavailable.");
        const args = (body.args ?? {}) as Record<string, unknown>;
        if (args.receipt === true) return await trialPracticeReceipt(state, db, env, args);
        return json(await trialPractice(db, env, templMeter(env), args));
      }
      const result = await managedOperation(db, body, Date.now());
      const due = nextJobDue(db);
      if (due !== null) {
        const alarm = await state.storage.getAlarm();
        if (alarm === null || alarm > due)
          await state.storage.setAlarm(Math.max(due, Date.now() + 100));
      }
      return json(result);
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof KnowledgeError)
      return json({ error: error.message, reason: error.reason }, error.status);
    console.error("TEMPL_MANAGED_FAILURE", { path: url.pathname });
    return json(
      { error: "Managed AI is unavailable.", reason: "managed-unavailable" },
      503,
    );
  }
}

/** SupportKnowledge's alarm hook: works due jobs and says when to come
 * back, or null with nothing queued. */
export async function managedAlarm(
  db: KnowledgeDb,
  env: ManagedKnowledgeEnv,
  now: number,
  schedule: (promise: Promise<unknown>) => void = () => {},
): Promise<number | null> {
  if (nextJobDue(db) === null) {
    pruneSpend(db, now);
    return null;
  }
  const deps = await runnerDeps(db, env, {}, schedule);
  if (!deps) return null;
  const outcomes = await runManagedJobs(deps);
  for (const outcome of outcomes)
    console.log("TEMPL_MANAGED_JOB", { outcome, month: spendMonth(now) });
  const due = nextJobDue(db);
  return due === null ? null : Math.max(due, Date.now() + 1_000);
}
