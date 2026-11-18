import type { ProfileMatch } from "@templ/chat/protocol-profile";
import type { PriorityPosition } from "@templ/chat/support-priority";
import { createRpcBudget, RPC_BUDGET, type RpcBudgetEnv } from "./rpc-budget";
import { featureOn, workspaceFeatureEnv } from "./workspace-flags";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { supportStorage } from "./support-storage";
import { readConversation, type ConversationEnv } from "./team-conversations";
import type { Env } from "./common";
import type { DiagnosisEnv } from "./tx-diagnosis/chains";
import { readPriorityPosition } from "./support-priority-positions";
import {
  commitPriorityRead,
  preparePriorityRead,
  PRIORITY_PENDING_PREFIX,
  PRIORITY_PHASE_HEADER,
  type PriorityReadPlan,
} from "./support-priority";
import type { PriorityPositionDeps } from "./support-priority-positions";
import { priorityTrialObserver } from "./priority-trial-observer";
import { PRIORITY_DEPOSIT_SCOPE } from "./support-priority-scope";
import {
  beginPriorityCaptureWindow,
  appendPriorityCaptureObservation,
  finishPriorityCaptureWindow,
  type PriorityCaptureCapability,
  type PriorityCaptureEnv,
} from "./priority-trial-capture";

type ReadEnv = DiagnosisEnv & KnowledgeEnv & ConversationEnv;
export type PriorityReader = typeof readPriorityPosition;

/** Chain reads happen between prepare and commit, outside room transactions. */
export async function runPriorityRead(
  env: ReadEnv,
  plan: PriorityReadPlan,
  reader: PriorityReader = readPriorityPosition,
  deps: PriorityPositionDeps = {},
): Promise<PriorityPosition> {
  try {
    if (plan.depositScope !== PRIORITY_DEPOSIT_SCOPE)
      throw new Error("Priority deposit scope changed.");
    const { matches = [] } = await knowledgeCall<{ matches: ProfileMatch[] }>(
      env,
      plan.room,
      "profile.lookup",
      { principal: "system", role: "staff" },
      { refs: plan.settings.contracts },
    );
    const refs = matches.flatMap((entry) =>
      entry.underlying ? [entry.underlying] : [],
    );
    const underlying = refs.length
      ? (
          await knowledgeCall<{ matches: ProfileMatch[] }>(
            env,
            plan.room,
            "profile.lookup",
            { principal: "system", role: "staff" },
            { refs },
          )
        ).matches
      : [];
    return await reader(
      env,
      plan.wallet,
      plan.settings.contracts,
      [...matches, ...underlying],
      deps,
    );
  } catch {
    return {
      wallet: plan.wallet,
      usd: null,
      asOf: new Date().toISOString(),
      state: "unavailable",
      estimated: false,
    };
  }
}

/** A case open checks current team access before reading and again on commit. */
export async function priorityWorkerOpen(
  env: ReadEnv,
  room: DurableObjectStub,
  headers: Headers,
  input: { path: string; method: string; search?: string },
  reader: PriorityReader = readPriorityPosition,
): Promise<Response | null> {
  const thread = /^\/conversations\/(tc-[0-9a-f]{32})(?:\/workflow)?$/.exec(
    input.path,
  )?.[1];
  const query = new URLSearchParams(input.search);
  if (
    !thread ||
    input.method !== "GET" ||
    query.get("priorityOpen") !== "1" ||
    query.has("attachment") ||
    headers.get("X-Support-Widget") === "member"
  )
    return null;
  const call = (phase: string, body: Record<string, unknown> = {}) => {
    const scoped = new Headers(headers);
    scoped.set(PRIORITY_PHASE_HEADER, phase);
    scoped.set("X-Conversations", String(env.CONVERSATIONS_ENABLED === "true"));
    scoped.set(
      "X-Support-Workflow",
      String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
    );
    return room.fetch(
      new Request(`https://internal/conversations/${thread}/priority`, {
        method: "POST",
        headers: scoped,
        body: JSON.stringify(body),
      }),
    );
  };
  const prepared = await call("prepare");
  // A member's own case still opens through its ordinary route.
  if (prepared.status === 403) {
    await prepared.body?.cancel();
    return null;
  }
  if (!prepared.ok) {
    await prepared.body?.cancel();
    return null;
  }
  const { plan, capture } = await prepared.json<{
    plan: PriorityReadPlan | null;
    capture?: PriorityCaptureCapability | null;
  }>();
  const captureCall = async (op: "observe" | "finish", value: unknown) => {
    if (!capture) return false;
    const scoped = new Headers(headers);
    scoped.set("Content-Type", "application/json");
    const result = await room.fetch(
      new Request("https://internal/private/priority-trial-capture", {
        method: "POST",
        headers: scoped,
        body: JSON.stringify({ op, capability: capture, value }),
      }),
    );
    if (!result.ok) {
      await result.body?.cancel();
      return false;
    }
    const data = await result.json<{ accepted: boolean }>();
    return data.accepted === true;
  };
  if (!plan) {
    if (capture) {
      try {
        await captureCall("finish", null);
      } catch {
        /* The ordinary cached open remains available. */
      }
    }
    return null;
  }
  const observer = capture
    ? priorityTrialObserver(env, capture, (observation) =>
        captureCall("observe", observation),
      )
    : null;
  let position: PriorityPosition;
  try {
    position = await runPriorityRead(env, plan, reader, observer?.deps);
  } finally {
    observer?.stop();
  }
  const committed = await call("commit", {
    thread,
    lease: plan.lease,
    position,
  });
  if (capture) {
    if (!committed.ok) capture.failed = true;
    try {
      await captureCall("finish", position);
    } catch {
      /* A missing completion refuses capture without changing the open. */
    }
  }
  if (committed.status === 403) return committed;
  await committed.body?.cancel();
  return null;
}

/** A checked wallet proof schedules one immediate read, with no timer. */
export async function runPriorityVerifications(
  state: DurableObjectState,
  env: Env,
  reader: PriorityReader = readPriorityPosition,
): Promise<void> {
  const scoped = await workspaceFeatureEnv(env, state.storage);
  if (!featureOn(scoped, undefined, "priorityFeed")) return;
  const pending = await state.storage.list({
    prefix: PRIORITY_PENDING_PREFIX,
    limit: 1,
  });
  for (const key of pending.keys()) {
    const thread = key.slice(PRIORITY_PENDING_PREFIX.length);
    const plan = await state.storage.transaction(async (tx) => {
      const storage = await supportStorage(tx, env, state.id?.toString() ?? "");
      await storage.delete(key);
      const record = await readConversation(storage, thread);
      return record
        ? preparePriorityRead(storage, record, Date.now(), "verification")
        : null;
    });
    if (!plan) continue;
    const budgetEnv = { ...scoped, [RPC_BUDGET]: createRpcBudget(env) } as Env &
      RpcBudgetEnv;
    budgetEnv[RPC_BUDGET]!.setRoom(env.ROOMS.get(state.id));
    let capture: PriorityCaptureCapability | null = null;
    try {
      capture = await state.storage.transaction(async (tx) =>
        beginPriorityCaptureWindow(
          await supportStorage(tx, env, state.id?.toString() ?? ""),
          env as PriorityCaptureEnv,
          { thread, wallet: plan.wallet, contracts: plan.settings.contracts },
        ),
      );
    } catch {
      /* Capture never changes ordinary verification. */
    }
    const observer = capture
      ? priorityTrialObserver(budgetEnv, capture, (observation) =>
          state.storage.transaction(async (tx) =>
            appendPriorityCaptureObservation(
              await supportStorage(tx, env, state.id?.toString() ?? ""),
              env as PriorityCaptureEnv,
              capture!,
              observation,
            ),
          ),
        )
      : null;
    let position: PriorityPosition;
    try {
      position = await runPriorityRead(budgetEnv, plan, reader, observer?.deps);
    } finally {
      observer?.stop();
    }
    await state.storage.transaction(async (tx) => {
      const current = await workspaceFeatureEnv(env, tx);
      if (!featureOn(current, undefined, "priorityFeed")) return;
      const storage = await supportStorage(tx, env, state.id?.toString() ?? "");
      const saved = await commitPriorityRead(
        storage,
        { thread, lease: plan.lease, position },
        Date.now(),
      );
      if (capture) {
        if (!saved) capture.failed = true;
        try {
          await finishPriorityCaptureWindow(
            storage,
            env as PriorityCaptureEnv,
            capture,
            position,
          );
        } catch {
          /* An incomplete window cannot become proof. */
        }
      }
    });
  }
}
