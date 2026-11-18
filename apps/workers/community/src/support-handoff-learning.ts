/** Learning jobs contain references only. Case text stays behind ordinary
 * authenticated message reads; the originating AI can publish only to the
 * workspace's dedicated Learned FAQ. */
import type { ChatMessage, ChatPrincipalId } from "@templ/chat/index";
import { checkedHandoffLearningResult, HANDOFF_LEARNING_EXCLUDED_REASONS, type HandoffLearningJob, type HandoffLearningEntry } from "@templ/chat/support-learning";
import type { SupportHandoffReason } from "@templ/chat/support";
import { HttpError, json, sha256Hex } from "./common";
import { CORPUS_OBJECTION_PREFIX, CORPUS_SKIP_PREFIX } from "./support-corpus";
import { messageKey } from "./message-store";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { checkedLearningEntries, learningPayloadHash } from "./support-knowledge-learning";
import { KnowledgeError } from "./support-knowledge-schema";
import type { StoredHandoff } from "./support-handoff";
import { supportRecord, readAiState, staffPreviewReason, type SupportRecord } from "./support-workflow";
import type { ConversationContext, TeamConversationRecord } from "./team-conversations";
import { featureOn } from "./workspace-flags";
import { wakeLearningJob } from "./managed-agent/room";
import { storageReadGrant } from "./brain-storage-billing";
import { readBots } from "./bots";
import { workspaceClosing } from "./workspace-deletion";
import { wakeRoomAt, type RoomAlarmContext } from "./room-alarm";

type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm">;
export const HANDOFF_LEARNING_MARKER_PREFIX = "support-handoff-learning-marker-v1:";
export const HANDOFF_LEARNING_JOB_PREFIX = "support-handoff-learning-job-v1:";
export const HANDOFF_LEARNING_ROOM_KEY = "support-handoff-learning-key-v1";
export const HANDOFF_LEARNING_SOURCE_PREFIX = "support-handoff-learning-source-v1:";
export const HANDOFF_LEARNING_CLEANUP_PREFIX = "support-handoff-learning-cleanup-v1:";
export const HANDOFF_LEARNING_INDEX_MEMBERS_PREFIX = "support-handoff-learning-index-members-v1:";
export const HANDOFF_LEARNING_PATH = /^\/conversations\/(?:handoff-learning|tc-[a-f0-9]{32}\/handoff-learning)$/;
const THREAD_PATH = /^\/conversations\/(tc-[a-f0-9]{32})\/handoff-learning$/;
const HASH = /^[a-f0-9]{64}$/;
const THREAD = /^tc-[a-f0-9]{32}$/;
const DAY = 86_400_000;
const MAX_JOBS = 1_000;
const PAGE = 20;
const pad8 = (value: number) => String(value).padStart(8, "0");
const markerKey = (thread: string, seq: number) => `${HANDOFF_LEARNING_MARKER_PREFIX}${thread}:${pad8(seq)}`;
const jobKey = (job: Pick<StoredLearningJob, "conversation" | "caseSeq" | "id">) =>
  `${HANDOFF_LEARNING_JOB_PREFIX}${job.conversation}:${pad8(job.caseSeq)}:${job.id}`;
const hidden = () => new HttpError(404, "Support tools not found.");
const stale = () => new HttpError(409, "This learning case changed. Read it again.", undefined, "handoff-learning-stale");
const invalid = () => new HttpError(400, "Use a valid learning result.", undefined, "handoff-learning-invalid");
const iso = (value: number) => new Date(value).toISOString();
type Marker = {
  v: 1;
  thread: string;
  caseSeq: number;
  requestAt: number;
  handoffAt: number;
  reason: SupportHandoffReason;
  origin: ChatPrincipalId;
  attempts?: number;
};
export type StoredLearningJob = Marker & {
  id: string;
  revision: 1;
  conversation: string;
  answer: { id: string; revision: number };
  answerHash: string;
  human: ChatPrincipalId;
  sourceToken: string;
  expiresAt: number;
  indexMembers: string[];
  working?: true;
  completed?: { hash: string; learning: unknown; hasFacts: boolean };
};
function marker(raw: unknown): Marker | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Marker;
  return row.v === 1 && THREAD.test(row.thread) && Number.isSafeInteger(row.caseSeq) && row.caseSeq > 0 &&
    Number.isSafeInteger(row.requestAt) && Number.isSafeInteger(row.handoffAt) &&
    typeof row.origin === "string" && typeof row.reason === "string" ? row : null;
}
function checkedJob(raw: unknown): StoredLearningJob | null {
  const row = raw as StoredLearningJob;
  return marker(raw) && row.conversation === row.thread && HASH.test(row.id) && row.revision === 1 &&
    row.answer && /^[1-9][0-9]{0,14}$/.test(row.answer.id) && Number.isSafeInteger(row.answer.revision) && row.answer.revision > 0 &&
    HASH.test(row.answerHash) && HASH.test(row.sourceToken) && typeof row.human === "string" &&
    Array.isArray(row.indexMembers) && row.indexMembers.every((member) => typeof member === "string" && member.length <= 160) &&
    Number.isSafeInteger(row.expiresAt) ? row : null;
}
async function removeTokenIndexes(storage: Pick<Storage, "get" | "delete">, token: string, fallback: readonly string[] = []) {
  const linked = await storage.get<{ members: string[] }>(HANDOFF_LEARNING_INDEX_MEMBERS_PREFIX + token);
  const members = Array.isArray(linked?.members) ? linked.members.filter((member) => typeof member === "string" && member.length <= 160) : [];
  for (const member of new Set([...members, ...fallback]))
    await storage.delete(`${HANDOFF_LEARNING_SOURCE_PREFIX}${member}:${token}`);
  await storage.delete(HANDOFF_LEARNING_INDEX_MEMBERS_PREFIX + token);
}
function view(job: StoredLearningJob): HandoffLearningJob {
  return {
    id: job.id, revision: job.revision, conversation: job.conversation, caseSeq: job.caseSeq,
    requestAt: iso(job.requestAt), handoffAt: iso(job.handoffAt), reason: job.reason,
    answer: job.answer, expiresAt: iso(job.expiresAt),
  };
}
async function privacyStopped(storage: Storage, record: TeamConversationRecord) {
  if (await storage.get(`${CORPUS_SKIP_PREFIX}${record.id}`)) return true;
  for (const principal of [record.member, ...(record.formerMembers ?? [])])
    if (await storage.get(`${CORPUS_OBJECTION_PREFIX}${principal}`)) return true;
  return false;
}
async function allowed(storage: Storage, context: ConversationContext, record: TeamConversationRecord, data: SupportRecord) {
  if (data.caseSeq && await storage.get(`support-encrypted-v1:${record.id}:${String(data.caseSeq).padStart(8, "0")}:state`)) return false;
  return (await featureOn(context.mediaEnv, storage, "handoffLearning")) && !(await workspaceClosing(storage)) && !record.deleting && !record.stopped &&
    data.state !== "spam" && !(await privacyStopped(storage, record)) &&
    context.canary !== record.member && !(await staffPreviewReason(storage as DurableObjectTransaction, context, record.member)) &&
    (await readAiState(storage as DurableObjectTransaction, record, data)).effective.mode !== "off";
}
async function registered(storage: Storage, context: ConversationContext, principal: ChatPrincipalId) {
  return (context.registeredBots ?? []).includes(principal) &&
    (await readBots(storage)).bots.some((bot) => bot.principalId === principal) &&
    Boolean(await context.isSupportStaff?.(principal));
}
async function sourceToken(storage: Storage, room: string, thread: string, seq: number, job: string) {
  let bytes = await storage.get<Uint8Array>(HANDOFF_LEARNING_ROOM_KEY);
  if (bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32))
    throw new HttpError(503, "Learned knowledge is unavailable.", undefined, "handoff-learning-key");
  if (bytes === undefined) {
    bytes = crypto.getRandomValues(new Uint8Array(32));
    await storage.put(HANDOFF_LEARNING_ROOM_KEY, bytes);
  }
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify([room, thread, seq, job])));
  return [...new Uint8Array(signed)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Runs inside the accepted handoff's transaction. Claiming or assigning the
 * case does not remove this provenance. A later handoff supersedes it. */
export async function captureHandoffLearning(
  storage: Storage, context: ConversationContext, record: TeamConversationRecord, data: SupportRecord, handoff: StoredHandoff,
) {
  const origin = context.viewer.principalId;
  if (handoff.by !== "agent" || HANDOFF_LEARNING_EXCLUDED_REASONS.includes(handoff.reason) ||
    !context.isBot || !origin || !data.caseSeq || data.requestedAt !== handoff.requestAt ||
    !(await registered(storage, context, origin)) || !(await allowed(storage, context, record, data))) return;
  const previous = marker(await storage.get(markerKey(record.id, data.caseSeq)));
  await storage.put(markerKey(record.id, data.caseSeq), {
    v: 1, thread: record.id, caseSeq: data.caseSeq, requestAt: handoff.requestAt,
    handoffAt: handoff.at, reason: handoff.reason, origin,
    attempts: previous?.requestAt === handoff.requestAt ? previous.attempts ?? 0 : 0,
  } satisfies Marker);
}

/** Runs only after an actual member-visible human reply was accepted. A retry
 * of that message returns before this hook. Later answers can add the facts
 * missing from an earlier clarification, with at most eight jobs per case. */
export async function queueHandoffLearningReply(
  storage: Storage, context: ConversationContext, record: TeamConversationRecord, message: ChatMessage,
): Promise<StoredLearningJob | null> {
  if (context.isBot || !context.viewer.principalId) return null;
  const data = await supportRecord(storage as DurableObjectTransaction, record);
  if (!data.caseSeq) return null;
  const key = markerKey(record.id, data.caseSeq);
  const pending = marker(await storage.get(key));
  if (!pending) return null;
  if (pending.requestAt !== data.requestedAt || context.now - pending.handoffAt > 30 * DAY ||
    !(await allowed(storage, context, record, data)) || !(await registered(storage, context, pending.origin)) ||
    !(await context.isSupportStaff?.(context.viewer.principalId)) ||
    (context.registeredBots ?? []).includes(message.author as ChatPrincipalId)) {
    await storage.delete(key);
    return null;
  }
  if ((pending.attempts ?? 0) >= 8) return null;
  const id = await sha256Hex(JSON.stringify([context.room, pending.thread, pending.caseSeq,
    pending.requestAt, pending.handoffAt, pending.origin, message.id, message.revision ?? 1]));
  const existing = checkedJob(await storage.get(jobKey({ conversation: record.id, caseSeq: data.caseSeq, id })));
  if (existing) return existing;
  const listed = await storage.list<unknown>({ prefix: HANDOFF_LEARNING_JOB_PREFIX, limit: MAX_JOBS });
  let active = 0;
  for (const [oldKey, raw] of listed) {
    const old = checkedJob(raw);
    if (!old || old.expiresAt <= context.now ||
      (old.conversation === record.id && old.caseSeq === data.caseSeq && !old.working && !old.completed)) {
      if (old && !old.working && !old.completed) await removeTokenIndexes(storage, old.sourceToken, old.indexMembers);
      await storage.delete(oldKey);
    }
    else active++;
  }
  if (active >= MAX_JOBS) return null;
  await storage.put(key, { ...pending, attempts: (pending.attempts ?? 0) + 1 });
  const job: StoredLearningJob = {
    ...pending, id, revision: 1, conversation: record.id,
    answer: { id: message.id, revision: message.revision ?? 1 },
    answerHash: await sha256Hex(message.text), human: message.author as ChatPrincipalId,
    sourceToken: await sourceToken(storage, context.room, record.id, data.caseSeq, id), expiresAt: context.now + DAY,
    indexMembers: [...new Set([record.member, ...(record.formerMembers ?? [])])],
  };
  // This provenance commits with the human reply, before a separate model or
  // completion request can mutate the knowledge object. A completion rollback
  // therefore cannot orphan its generated facts from later privacy cleanup.
  for (const member of job.indexMembers)
    await storage.put(`${HANDOFF_LEARNING_SOURCE_PREFIX}${member}:${job.sourceToken}`, { v: 1 });
  await storage.put(HANDOFF_LEARNING_INDEX_MEMBERS_PREFIX + job.sourceToken, { members: job.indexMembers });
  await storage.put(jobKey(job), job);
  await wakeLearningJob(storage as DurableObjectTransaction, context, { id, thread: record.id, at: context.now, origin: pending.origin });
  return job;
}

type Deps = {
  team: boolean;
  authorize(id: string): Promise<{ record: TeamConversationRecord; role: "member" | "team" }>;
};
async function current(storage: Storage, context: ConversationContext, deps: Deps, job: StoredLearningJob) {
  if (job.expiresAt <= context.now || context.viewer.principalId !== job.origin ||
    !(await registered(storage, context, job.origin)) || !(await context.isSupportStaff?.(job.human)) ||
    (await readBots(storage)).bots.some((bot) => bot.principalId === job.human)) throw hidden();
  const { record, role } = await deps.authorize(job.conversation);
  if (role !== "team") throw hidden();
  const data = await supportRecord(storage as DurableObjectTransaction, record);
  if (!(await allowed(storage, context, record, data))) throw hidden();
  if (data.caseSeq !== job.caseSeq || data.requestedAt !== job.requestAt ||
    (await storage.get<number>(`channel-sequence:${job.conversation}`)) !== Number(job.answer.id)) throw stale();
  const answer = await storage.get<ChatMessage>(messageKey(job.conversation, Number(job.answer.id)));
  if (!answer || answer.author !== job.human || (answer.revision ?? 1) !== job.answer.revision ||
    (await sha256Hex(answer.text)) !== job.answerHash) throw stale();
  return record;
}

export async function handoffLearningRoute(storage: Storage, context: ConversationContext, deps: Deps): Promise<Response | null> {
  if (!HANDOFF_LEARNING_PATH.test(context.pathname)) return null;
  if (!deps.team || !context.isBot || !context.viewer.principalId || context.viewer.banned || context.viewer.mutedUntil ||
    !(context.registeredBots ?? []).includes(context.viewer.principalId) ||
    !(await featureOn(context.mediaEnv, storage, "handoffLearning"))) throw hidden();
  const match = THREAD_PATH.exec(context.pathname);
  if (!match) {
    if (context.method !== "GET") throw hidden();
    const rows = await storage.list<unknown>({ prefix: HANDOFF_LEARNING_JOB_PREFIX, limit: MAX_JOBS });
    const jobs: HandoffLearningJob[] = [];
    for (const [key, raw] of rows) {
      const job = checkedJob(raw);
      if (!job || job.expiresAt <= context.now) {
        if (job && !job.working && !job.completed) await removeTokenIndexes(storage, job.sourceToken, job.indexMembers);
        await storage.delete(key); continue;
      }
      if (job.origin !== context.viewer.principalId || job.completed || job.working) continue;
      try { await current(storage, context, deps, job); } catch (error) {
        if (!(error instanceof HttpError) || ![403, 404, 409].includes(error.status)) throw error;
        continue;
      }
      jobs.push(view(job));
      if (jobs.length === PAGE) break;
    }
    return json({ jobs });
  }
  const id = context.method === "GET" ? context.query.get("id") : context.body.id;
  if (typeof id !== "string" || !HASH.test(id)) throw invalid();
  // The key's case number is derived from the current authorized case.
  const { record, role } = await deps.authorize(match[1]);
  if (role !== "team") throw hidden();
  const data = await supportRecord(storage as DurableObjectTransaction, record);
  const key = jobKey({ conversation: match[1], caseSeq: data.caseSeq ?? 0, id });
  const job = checkedJob(await storage.get(key));
  if (!job) throw hidden();
  await current(storage, context, deps, job);
  if (context.method === "GET") return json({ job: view(job) });
  if (context.method !== "POST") throw hidden();
  if (context.body.action === "begin") {
    if (context.body.revision !== job.revision || job.working || job.completed ||
      Object.keys(context.body).some((field) => !["action", "id", "revision", "expectedPrincipalId"].includes(field))) throw stale();
    await storage.put(key, { ...job, working: true });
    await storage.put(HANDOFF_LEARNING_CLEANUP_PREFIX + job.id, { sourceToken: job.sourceToken, due: job.expiresAt, members: job.indexMembers });
    await wakeRoomAt(storage, job.expiresAt);
    return json({ job: view(job) });
  }
  if (context.body.revision !== job.revision || !checkedHandoffLearningResult(context.body.result) ||
    Object.keys(context.body).some((field) => !["id", "revision", "result", "expectedKnowledgeVersion", "expectedPrincipalId"].includes(field))) throw invalid();
  let entries: HandoffLearningEntry[];
  try { entries = checkedLearningEntries(context.body.result.entries); }
  catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    throw new HttpError(error.status, error.message, undefined, error.reason);
  }
  const expectedKnowledgeVersion = context.body.expectedKnowledgeVersion;
  if (entries.length && (typeof expectedKnowledgeVersion !== "string" || !HASH.test(expectedKnowledgeVersion))) throw invalid();
  if (expectedKnowledgeVersion !== undefined && (typeof expectedKnowledgeVersion !== "string" || !HASH.test(expectedKnowledgeVersion))) throw invalid();
  const payload = { sourceToken: job.sourceToken, entries, ...(typeof expectedKnowledgeVersion === "string" ? { expectedKnowledgeVersion } : {}) };
  const hash = await learningPayloadHash(payload);
  if (job.completed) {
    if (job.completed.hash !== hash) throw stale();
    return json({ job: view(job), learning: job.completed.learning });
  }
  if (!job.working) throw stale();
  let applied = false;
  try {
    applied = entries.length > 0;
    const learning = entries.length ? await knowledgeCall(
      context.mediaEnv as unknown as KnowledgeEnv, context.room, "knowledge.learning.apply",
      { principal: job.origin, role: "bot", learningAuthorized: true },
      { operationId: job.id, payloadHash: hash, ...payload,
        storageGrant: await storageReadGrant(storage as DurableObjectTransaction, context.mediaEnv, context.now) },
    ) : { operationId: job.id, recordedAt: iso(context.now), entries: [] };
    // Cross-object writes cannot roll back with this room transaction. Recheck
    // current case/permissions/privacy and compensate only this job's token.
    await current(storage, { ...context, now: Date.now() }, deps, job);
    await storage.put(key, { ...job, completed: { hash, learning, hasFacts: entries.length > 0 } });
    if (!entries.length) await removeTokenIndexes(storage, job.sourceToken, job.indexMembers);
    await storage.delete(HANDOFF_LEARNING_CLEANUP_PREFIX + job.id);
    return json({ job: view(job), learning });
  } catch (error) {
    if (!applied) throw error;
    try {
      await forgetToken(context.mediaEnv as unknown as KnowledgeEnv, context.room, job.sourceToken);
      await removeTokenIndexes(storage, job.sourceToken, job.indexMembers);
      await storage.delete(HANDOFF_LEARNING_CLEANUP_PREFIX + job.id);
    } catch {
      // Commit a cleanup intent even when the remote result is uncertain.
      // It already had a durable expiry fence from the earlier begin request.
      await storage.put(HANDOFF_LEARNING_CLEANUP_PREFIX + job.id, { sourceToken: job.sourceToken, due: Date.now(), members: job.indexMembers });
      await wakeRoomAt(storage, Date.now() + 1_000);
      return json({ error: "Learned knowledge is being cleared.", reason: "handoff-learning-cleanup" }, 503);
    }
    throw error;
  }
}

async function forgetToken(env: KnowledgeEnv, room: string, sourceToken: string) {
  return knowledgeCall<{ removed: number }>(env, room, "knowledge.learning.forget",
    { principal: "privacy", role: "staff", learningAuthorized: true }, { sourceToken });
}

/** Only cleanup calls run on this alarm, never model work. A claim keeps an
 * expiry fence until its completion commits, including after a restore. */
export async function handoffLearningCleanupAlarm(context: Pick<RoomAlarmContext, "state" | "env">, now: number): Promise<number | null> {
  const storage = context.state.storage;
  const rows = await storage.list<{ sourceToken: string; due: number; members?: string[] }>({ prefix: HANDOFF_LEARNING_CLEANUP_PREFIX, limit: MAX_JOBS });
  if (!rows.size) return null;
  const native = await storage.get<{ room: { id: string } }>("native-room");
  if (!native || await workspaceClosing(storage)) return now + 60_000;
  let next = Infinity, processed = 0;
  for (const [key, row] of rows) {
    if (!row || !HASH.test(row.sourceToken) || !Number.isSafeInteger(row.due)) { await storage.delete(key); continue; }
    if (row.due > now) { next = Math.min(next, row.due); continue; }
    if (processed++ >= PAGE) { next = Math.min(next, now + 1_000); continue; }
    try {
      await forgetToken(context.env as unknown as KnowledgeEnv, `room:${native.room.id}`, row.sourceToken);
      await removeTokenIndexes(storage, row.sourceToken, Array.isArray(row.members) ? row.members : []);
      await storage.delete(key);
    } catch { next = Math.min(next, now + 60_000); }
  }
  return Number.isFinite(next) ? next : null;
}

/** A proved guest/wallet link keeps privacy provenance reachable from either
 * identity after the original thread's ordinary retention. It grants no access. */
export async function linkHandoffLearningMembers(storage: Pick<Storage, "get" | "list" | "put">, principals: readonly string[]) {
  const members = [...new Set(principals)];
  const tokens = new Set<string>();
  for (const member of members) {
    const prefix = `${HANDOFF_LEARNING_SOURCE_PREFIX}${member}:`;
    let after: string | undefined;
    for (;;) {
      const rows = await storage.list({ prefix, limit: 100, ...(after ? { startAfter: after } : {}) });
      for (const key of rows.keys()) if (HASH.test(key.slice(prefix.length))) tokens.add(key.slice(prefix.length));
      after = [...rows.keys()].at(-1);
      if (rows.size < 100) break;
    }
  }
  for (const member of members)
    for (const token of tokens) await storage.put(`${HANDOFF_LEARNING_SOURCE_PREFIX}${member}:${token}`, { v: 1 });
  for (const token of tokens) {
    const existing = await storage.get<{ members: string[] }>(HANDOFF_LEARNING_INDEX_MEMBERS_PREFIX + token);
    const prior = Array.isArray(existing?.members) ? existing.members.filter((member) => typeof member === "string" && member.length <= 160) : [];
    await storage.put(HANDOFF_LEARNING_INDEX_MEMBERS_PREFIX + token, { members: [...new Set([...prior, ...members])] });
  }
}

/** Privacy requests/objections remove generated contributions and prevent a
 * late in-flight completion from publishing them again. No private text is read. */
export async function forgetMemberHandoffLearning(
  storage: Pick<Storage, "get" | "list" | "delete">,
  env: KnowledgeEnv,
  room: string,
  principals: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const principal of new Set(principals)) {
    const prefix = `${HANDOFF_LEARNING_SOURCE_PREFIX}${principal}:`;
    for (;;) {
      const rows = await storage.list({ prefix, limit: 100 });
      if (!rows.size) break;
      for (const key of rows.keys()) {
        const token = key.slice(prefix.length);
        if (HASH.test(token)) {
          const result = await forgetToken(env, room, token);
          removed += result.removed;
          await removeTokenIndexes(storage, token, [principal]);
        }
        await storage.delete(key);
      }
    }
  }
  return removed;
}

/** Per-case and per-thread retention remove pending references and receipts. */
export async function deleteCaseHandoffLearning(storage: Pick<Storage, "get" | "list" | "delete">, thread: string, seq: number, budget: number) {
  let removed = 0;
  if (budget > 0 && await storage.delete(markerKey(thread, seq))) removed++;
  if (removed >= budget) return removed;
  const rows = await storage.list({ prefix: `${HANDOFF_LEARNING_JOB_PREFIX}${thread}:${pad8(seq)}:`, limit: budget - removed });
  for (const [key, raw] of rows) {
    const job = checkedJob(raw);
    if (job && !job.working && !job.completed) await removeTokenIndexes(storage, job.sourceToken, job.indexMembers);
    if (await storage.delete(key)) removed++;
  }
  return removed;
}
export async function deleteThreadHandoffLearning(storage: Pick<Storage, "get" | "list" | "delete">, thread: string, budget: number) {
  let removed = 0;
  for (const prefix of [HANDOFF_LEARNING_MARKER_PREFIX, HANDOFF_LEARNING_JOB_PREFIX]) {
    if (removed >= budget) break;
    const rows = await storage.list({ prefix: `${prefix}${thread}:`, limit: budget - removed });
    for (const [key, raw] of rows) {
      const job = checkedJob(raw);
      if (prefix === HANDOFF_LEARNING_JOB_PREFIX && job && !job.working && !job.completed)
        await removeTokenIndexes(storage, job.sourceToken, job.indexMembers);
      if (await storage.delete(key)) removed++;
    }
  }
  return removed;
}
