import { PRODUCT_STATE_KEY, readProductSupport } from "./product-entitlements";
import type { ChatMessage, ChatPrincipalId, ChatRole } from "@templ/chat/index";
import { SUPPORT_LIMITS } from "@templ/chat/support";
import type { AppAnswerRequest } from "@templ/chat/support-telegram";
import { HttpError, type Env } from "./common";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { readAiState } from "./support-workflow";
import { lastAssistantPause, readSupportProfiles } from "./support-contact-profiles";
import { featureOn } from "./workspace-flags";
import { wakeRoomAt } from "./room-alarm";
import { currentStaffRoleIds, templStaffAccount } from "./templ-staff";
import type { NativeRoomRecord } from "./native-rooms";
import { readDeletionState } from "./workspace-deletion";
import { requireSafetyAccess } from "./safety";
import { privacyStatus, roomPrivacy } from "./room-privacy";
import { aiPrincipals } from "./bots";
import { identityRequest } from "./account-identity";
import { aliasValues, servicePrincipals } from "./service-principals";

type Storage = DurableObjectTransaction;
export const APP_AI_WORKSPACE = "";
export const APP_AI_PREFIX = "support-app-answer-v1:";
const OUTBOX = "support-app-answer-outbox-v1:";
const JOB_LIFETIME_MS = 10 * 60_000;
type Job = AppAnswerRequest & {
  actor: ChatPrincipalId;
  agent: ChatPrincipalId;
  attempts: number;
  dueAt: number;
  status:
    | "queued"
    | "dispatched"
    | "answered"
    | "handed-off"
    | "cancelled"
    | "failed";
};
const key = (thread: string) => APP_AI_PREFIX + thread;
const active = (row: Job) =>
  row.status === "queued" || row.status === "dispatched";
const unavailable = () =>
  new HttpError(
    409,
    "AI cannot answer this message now. Refresh the case.",
    undefined,
    "app-answer-unavailable",
  );

export async function appAiEnabled(
  storage: Pick<Storage, "get">,
  env: Env,
  room: string,
) {
  return (
    room === `room:${APP_AI_WORKSPACE}` &&
    Boolean(env.NATIVE_TELEGRAM_BRIDGE?.queueAppAnswer) &&
    (await featureOn(env, storage, "appAiReplies")) &&
    (await readSupportProfiles(storage))?.assistantEnabled !== false
  );
}

// Give the existing visitor request time to finish before staff buy another inference.
// The native ifLatest guard still arbitrates a late visitor response atomically.
function visitorTurnDeadline(latest: ChatMessage) {
  const sent = Date.parse(latest.createdAt);
  return Number.isFinite(sent) ? sent + SUPPORT_LIMITS.agentPickupMs + 1 : null;
}

/** Called only after normal case/staff authorization, in the workflow transaction. */
export async function enqueueAppAnswer(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  required = true,
) {
  if (
    !(await appAiEnabled(storage, context.mediaEnv, context.room)) ||
    context.isBot ||
    !context.viewer.principalId
  ) {
    if (required) throw unavailable();
    return;
  }
  if (
    record.state !== "open" ||
    record.handoff ||
    record.stopped ||
    record.deleting ||
    (await readAiState(storage, record)).effective.mode !== "answers" ||
    context.registeredBots?.length !== 1
  ) {
    if (required) throw unavailable();
    return;
  }
  const sequence = await storage.get<number>(`channel-sequence:${record.id}`);
  const latest = sequence
    ? await storage.get<ChatMessage>(
        `channel-message:${record.id}:${String(sequence).padStart(16, "0")}`,
      )
    : undefined;
  if (
    !latest ||
    visitorTurnDeadline(latest) === null ||
    ![record.member, ...(record.formerMembers ?? [])].includes(
      latest.author as ChatPrincipalId,
    )
  ) {
    if (required) throw unavailable();
    return;
  }
  const prior = await storage.get<Job>(key(record.id));
  if (
    prior &&
    prior.ifLatest.messageId === latest.id &&
    prior.ifLatest.revision === (latest.revision ?? 1) &&
    prior.revision === record.revision &&
    (active(prior) || prior.status === "answered")
  )
    return;
  // A turn gets one job. Repeated clicks and mode toggles cannot purchase another inference.
  if (
    prior?.ifLatest.messageId === latest.id &&
    prior.ifLatest.revision === (latest.revision ?? 1)
  ) {
    if (required) throw unavailable();
    return;
  }
  const day = new Date(context.now).toISOString().slice(0, 10);
  const budget = await storage.get<{ day: string; count: number }>(
    "support-app-answer-budget-v1",
  );
  const count = budget?.day === day ? budget.count : 0;
  if (count >= 40) {
    if (required)
      throw new HttpError(
        429,
        "The daily AI request limit was reached. The team can reply here.",
      );
    return;
  }
  const dueAt = Math.max(context.now, visitorTurnDeadline(latest)!);
  await storage.put("support-app-answer-budget-v1", { day, count: count + 1 });
  await storage.put(key(record.id), {
    workspaceId: APP_AI_WORKSPACE,
    conversationId: record.id,
    jobId: crypto.randomUUID(),
    revision: record.revision,
    ifLatest: { messageId: latest.id, revision: latest.revision ?? 1 },
    actor: context.viewer.principalId,
    agent: context.registeredBots[0],
    attempts: 0,
    dueAt,
    expiresAt: context.now + JOB_LIFETIME_MS,
    status: "queued",
  } satisfies Job);
  await storage.put(OUTBOX + record.id, { dueAt });
  await wakeRoomAt(storage, dueAt + 1000);
}

/** Service-binding reads and final native writes both recheck this committed job. */
export async function appAnswerAllowed(
  storage: Storage,
  env: Env,
  input: Pick<AppAnswerRequest, "workspaceId" | "conversationId" | "jobId">,
  now = Date.now(),
): Promise<boolean> {
  if (
    !input ||
    input.workspaceId !== APP_AI_WORKSPACE ||
    !/^tc-[0-9a-f]{32}$/.test(input.conversationId) ||
    !(await appAiEnabled(storage, env, `room:${input.workspaceId}`)) ||
    (await readDeletionState(storage))
  )
    return false;
  if (
    (await storage.get(PRODUCT_STATE_KEY)) &&
    !(await readProductSupport(storage, now, env)).enabled
  )
    return false;
  const job = await storage.get<Job>(key(input.conversationId));
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${input.conversationId}`,
  );
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (
    !job ||
    job.jobId !== input.jobId ||
    !active(job) ||
    job.expiresAt <= now ||
    job.expiresAt - JOB_LIFETIME_MS <= await lastAssistantPause(storage) ||
    !record ||
    record.room !== `room:${input.workspaceId}` ||
    record.revision !== job.revision ||
    record.deleting ||
    record.stopped ||
    record.handoff ||
    record.state !== "open" ||
    !native ||
    native.room.id !== input.workspaceId ||
    (await readAiState(storage, record)).effective.mode !== "answers"
  )
    return false;
  // Resolve the current login identities; a queued job cannot retain a wallet
  // alias after it is unlinked from the staff account.
  const identity = await identityRequest(env, {
    op: "read",
    principalId: job.actor,
  });
  const aliases = servicePrincipals(
    identity.principalId,
    identity.servicePrincipals,
  );
  if (!aliases.includes(job.actor)) return false;
  const settings = await storage.get<{ roles: ChatRole[] }>("chat-settings");
  const agents = settings ? await aiPrincipals(storage, settings) : [];
  if (
    !settings ||
    aliases.some((id) => agents.includes(id)) ||
    !agents.includes(job.agent) ||
    (await aliasValues(storage, "ban:", aliases)).some(Boolean)
  )
    return false;
  const isManager =
    aliases.includes(native.room.manager as ChatPrincipalId) &&
    !(await templStaffAccount(storage, aliases, env));
  const roles = await currentStaffRoleIds(storage, aliases, env, now);
  const manual = await storage.get<
    Record<string, { mode: string; enabled?: boolean }>
  >("native-manual-roles");
  if (
    !isManager &&
    !settings.roles.some(
      (role) =>
        roles.includes(role.id) &&
        role.enabled !== false &&
        manual?.[role.id]?.mode === "manual" &&
        manual[role.id].enabled !== false &&
        role.moderationPermissions?.includes("handleConversations"),
    )
  )
    return false;
  if (
    !(
      await privacyStatus(
        storage,
        await roomPrivacy(storage, native.room),
        identity.principalId,
        isManager,
        aliases,
      )
    ).canRead
  )
    return false;
  try {
    await requireSafetyAccess(env, record.room, identity.principalId, aliases);
  } catch {
    return false;
  }
  return true;
}

export async function assertAppAnswerWrite(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  body: Record<string, unknown>,
) {
  if (body.appAnswer === undefined) return;
  const job = await storage.get<Job>(key(record.id));
  if (
    typeof body.appAnswer !== "string" ||
    !context.isBot ||
    !job ||
    context.viewer.principalId !== job.agent ||
    !(await appAnswerAllowed(
      storage,
      context.mediaEnv,
      {
        workspaceId: APP_AI_WORKSPACE,
        conversationId: record.id,
        jobId: body.appAnswer,
      },
      context.now,
    ))
  )
    throw unavailable();
}

export async function finishAppAnswer(
  storage: Storage,
  thread: string,
  id: unknown,
  status: "answered" | "handed-off",
) {
  if (typeof id !== "string") return;
  const row = await storage.get<Job>(key(thread));
  if (row?.jobId === id) await storage.put(key(thread), { ...row, status });
}

/** A bounded outbox; the bridge accepts retries under the same generation ID. */
export async function appAnswerAlarm(
  state: DurableObjectState,
  env: Env,
  now: number,
): Promise<number | null> {
  let next = Infinity;
  const rows = await state.storage.list({ prefix: OUTBOX, limit: 10 });
  for (const [outbox] of rows) {
    const name = key(outbox.slice(OUTBOX.length));
    const row = await state.storage.get<Job>(name);
    if (!row || row.status !== "queued") {
      await state.storage.delete(outbox);
      continue;
    }
    if (row.dueAt > now) {
      next = Math.min(next, row.dueAt);
      continue;
    }
    const pending = await state.storage.transaction(async (storage) => {
      const current = await storage.get<Job>(name);
      if (
        !current ||
        current.jobId !== row.jobId ||
        current.status !== "queued" ||
        current.dueAt > now
      )
        return null;
      if (
        !(await appAnswerAllowed(storage, env, current, now)) ||
        current.attempts >= 8
      ) {
        await storage.put(name, { ...current, status: "cancelled" });
        await storage.delete(outbox);
        return null;
      }
      const leased = {
        ...current,
        attempts: current.attempts + 1,
        dueAt: now + 30_000,
      };
      await storage.put(name, leased);
      return leased;
    });
    if (!pending) continue;
    try {
      const queued = await env.NATIVE_TELEGRAM_BRIDGE!.queueAppAnswer!({
        workspaceId: row.workspaceId,
        conversationId: row.conversationId,
        jobId: row.jobId,
        revision: row.revision,
        ifLatest: row.ifLatest,
        expiresAt: row.expiresAt,
      });
      if (!queued.queued) throw new Error();
      await state.storage.transaction(async (storage) => {
        const current = await storage.get<Job>(name);
        if (current?.jobId === row.jobId && current.status === "queued") {
          await storage.put(name, { ...current, status: "dispatched" });
          await storage.delete(outbox);
        }
      });
    } catch {
      next = Math.min(next, pending.dueAt);
    }
  }
  // Include remaining queued rows in the next bounded pass.
  if ((await state.storage.list({ prefix: OUTBOX, limit: 1 })).size)
    next = Math.min(next, now + 30_000);
  return Number.isFinite(next) ? next : null;
}

/** Team-only status contains no model output or job credential. */
export async function appAnswerStatus(
  storage: Pick<Storage, "get">,
  thread: string,
  botCount = 1,
) {
  const row = await storage.get<Job>(key(thread));
  const seq = await storage.get<number>(`channel-sequence:${thread}`);
  const latest = seq
    ? await storage.get<ChatMessage>(
        `channel-message:${thread}:${String(seq).padStart(16, "0")}`,
      )
    : undefined;
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${thread}`,
  );
  const budget = await storage.get<{ day: string; count: number }>(
    "support-app-answer-budget-v1",
  );
  const exhausted =
    budget?.day === new Date().toISOString().slice(0, 10) && budget.count >= 40;
  const generateAvailable = Boolean(
    botCount === 1 &&
      !exhausted &&
      latest &&
      visitorTurnDeadline(latest) !== null &&
      record &&
      record.state === "open" &&
      !record.handoff &&
      !record.stopped &&
      [record.member, ...(record.formerMembers ?? [])].includes(
        latest.author as ChatPrincipalId,
      ),
  );
  const matches =
    row &&
    latest &&
    row.ifLatest.messageId === latest.id &&
    row.ifLatest.revision === (latest.revision ?? 1);
  return {
    generateAvailable,
    ...(matches
      ? {
          generation:
            active(row) && row.revision !== record?.revision
              ? ("cancelled" as const)
              : active(row) && row.expiresAt <= Date.now()
                ? ("failed" as const)
                : row.status,
        }
      : {}),
  };
}
export async function reportAppAnswerFailure(
  storage: Storage,
  input: Pick<AppAnswerRequest, "workspaceId" | "conversationId" | "jobId">,
) {
  if (
    input.workspaceId !== APP_AI_WORKSPACE ||
    !/^tc-[0-9a-f]{32}$/.test(input.conversationId)
  )
    return;
  const row = await storage.get<Job>(key(input.conversationId));
  if (row?.jobId === input.jobId && active(row))
    await storage.put(key(input.conversationId), { ...row, status: "failed" });
}
