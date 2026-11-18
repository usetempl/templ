/** Ask AI requests, AI drafts and reply provenance in the room object.
 *
 * - A person on the team asks the workspace's registered AI agent for a
 *   draft ("Ask AI"). The agent finds the request in its list, reads the
 *   question through the thread's case read, and answers with a draft or
 *   declines. The first answer wins; a request expires after 10 minutes.
 * - In AI drafts only, the agent may also write one suggestion per member
 *   message. With the workspace's number check set to hold, an agent reply
 *   whose figures fail the citation check becomes a held draft.
 * - A person sends a draft by replying with it ("Use draft"); the reply is
 *   the person's, and the draft records whether they edited it.
 *
 * Drafts, requests and provenance are team-only: never sent, counted,
 * exported, searched or shown to the member, and they grant nothing. The
 * caller checks the viewer's current access to the thread first and writes
 * inside the room transaction. Keys are room-local and keyed by the thread
 * (and the case where they belong to one), so the thread's deletion and the
 * ledger's prune remove them. */
import type { ChatMessage } from "@templ/chat/index";
import { proveFaqCitationsFromSources } from "@templ/chat/support-faq-citations";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { DiagnosisNetwork } from "@templ/chat/diagnosis/types";
import type {
  SupportActivity,
  SupportAiMode,
  SupportSettings,
} from "@templ/chat/support";
import {
  checkCitations,
  hasCitationMarkers,
  findFigures,
  stripCitationMarkers,
  type Citation,
  type DiagnosisCitation,
  type CitationAdvice,
  type CitationCheck,
  type CitationProblem,
} from "@templ/chat/support-citations";
import {
  SUPPORT_AI_DECLINES,
  SUPPORT_DRAFT_LIMITS,
  SupportDraftInputError,
  checkedProvenance,
  isSourceHost,
  sourceLinks,
  type SupportAiDecline,
  type SupportAiProvenance,
  type SupportCaseSettings,
  type SupportDraft,
  type SupportDraftKind,
  type SupportDraftRequestRow,
  type SupportDraftRequestStatus,
  type SupportDraftRequestView,
  type SupportProvenanceView,
} from "@templ/chat/support-drafts";
import { HttpError } from "./common";
import { messageKey } from "./message-store";
import { messageClientId, messageTextHash } from "./message-retries";
import { messageText } from "./room";
import { refusePhrase, refuseSecretRequest } from "./secret-guard";
import { citationRows } from "./support-evidence-store";
import { citableDiagnoses } from "./support-diagnosis";
import { KNOWLEDGE_LIMITS } from "@templ/chat/protocol-profile";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import type { KnowledgeHitRow } from "./support-knowledge-kb";

type Storage = DurableObjectTransaction;
type ReadStorage = Pick<Storage, "get" | "list">;
type FaqCitationContext = { env: KnowledgeEnv; room: string; actor: ChatPrincipalId };

export const REQUEST_PREFIX = "support-draft-request-v1:";
export const PENDING_PREFIX = "support-draft-pending-v1:";
export const PENDING_COUNT_KEY = "support-draft-pending-count-v1";
export const DRAFT_PREFIX = "support-draft-v1:";
export const DRAFT_CLIENT_PREFIX = "support-draft-client-v1:";
export const PROVENANCE_PREFIX = "support-provenance-v1:";
/** A sent hosted clarification keeps its cap even if its message is later removed. */
export const AI_CLARIFICATION_PREFIX = "support-ai-clarification-v1:";
/** Every thread-scoped prefix this module writes. */
export const DRAFT_THREAD_PREFIXES = [
  DRAFT_PREFIX,
  DRAFT_CLIENT_PREFIX,
  PROVENANCE_PREFIX,
  AI_CLARIFICATION_PREFIX,
] as const;

const pad8 = (value: number) => String(value).padStart(8, "0");
const pad16 = (value: number) => String(value).padStart(16, "0");
const iso = (at: number) => new Date(at).toISOString();
const requestKey = (thread: string, id: string) =>
  `${REQUEST_PREFIX}${thread}:${id}`;
const pendingKey = (expiresAt: number, thread: string, id: string) =>
  `${PENDING_PREFIX}${pad16(expiresAt)}:${thread}:${id}`;
const draftKey = (thread: string, seq: number, id: string) =>
  `${DRAFT_PREFIX}${thread}:${pad8(seq)}:${id}`;
const draftClientKey = (thread: string, clientId: string) =>
  `${DRAFT_CLIENT_PREFIX}${thread}:${clientId}`;
export const provenanceKey = (thread: string, messageId: string | number) =>
  `${PROVENANCE_PREFIX}${thread}:${pad16(Number(messageId))}`;
const PENDING_KEY =
  /^support-draft-pending-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9a-f-]{36})$/;
const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* ---------------------------------------------------------------------- */
/* Stored shapes                                                           */
/* ---------------------------------------------------------------------- */

export type StoredDraftRequest = {
  v: 1;
  id: string;
  thread: string;
  case: number;
  requestedBy: ChatPrincipalId;
  at: number;
  expiresAt: number;
  instruction: string | null;
  /** The thread's latest message when the person asked. */
  latestMessage: { id: string; revision: number } | null;
  status: Exclude<SupportDraftRequestStatus, "expired">;
  closedAt: number | null;
  closedBy: ChatPrincipalId | null;
  decline: SupportAiDecline | null;
  draft: string | null;
};
export type StoredDraft = {
  v: 1;
  id: string;
  case: number;
  kind: SupportDraftKind;
  request: string | null;
  forMessage: { id: string; revision: number } | null;
  author: ChatPrincipalId;
  at: number;
  text: string;
  textSha256: string;
  provenance: SupportAiProvenance | null;
  citations: Citation[];
  diagnosisCitations?: DiagnosisCitation[];
  problems: CitationProblem[];
  advice: CitationAdvice[];
  status: "ready" | "used" | "dismissed";
  usedMessageId: string | null;
  edited: boolean | null;
  closedAt: number | null;
  closedBy: ChatPrincipalId | null;
};
export type StoredProvenance = {
  v: 1;
  case: number;
  kind: "reply" | "assisted";
  author: ChatPrincipalId;
  at: number;
  ai: SupportAiProvenance | null;
  citations: Citation[];
  diagnosisCitations?: DiagnosisCitation[];
  check: "passed" | "off" | "from-draft" | "none";
  problems: CitationProblem[];
  advice: CitationAdvice[];
  fromDraft?: { draft: string; edited: boolean };
};
/** Draft state on the thread's support record. */
export type DraftFields = {
  aiDrafts?: { caseSeq: number; requests: number; pending: string | null };
  /** Held agent replies not yet used or dismissed. */
  draftsHeld?: number;
};
/** The few fields of the thread's support record this module reads. */
type DraftData = DraftFields & {
  caseSeq?: number;
  ledgerVersion?: 1;
  lastAgentNoteAt?: number | null;
};

function checkedRequest(
  raw: unknown,
  thread: string,
): StoredDraftRequest | null {
  if (!isPlain(raw)) return null;
  const r = raw as StoredDraftRequest;
  return r.v === 1 &&
    typeof r.id === "string" &&
    ID.test(r.id) &&
    r.thread === thread &&
    Number.isSafeInteger(r.case) &&
    r.case >= 1 &&
    typeof r.requestedBy === "string" &&
    natural(r.at) &&
    natural(r.expiresAt) &&
    (r.instruction === null || typeof r.instruction === "string") &&
    ["pending", "answered", "declined", "cancelled"].includes(r.status) &&
    (r.decline === null ||
      (SUPPORT_AI_DECLINES as readonly unknown[]).includes(r.decline))
    ? r
    : null;
}
function checkedDraft(raw: unknown, seq: number): StoredDraft | null {
  if (!isPlain(raw)) return null;
  const d = raw as StoredDraft;
  return d.v === 1 &&
    typeof d.id === "string" &&
    ID.test(d.id) &&
    d.case === seq &&
    ["ask-ai", "suggestion", "held-reply"].includes(d.kind) &&
    typeof d.author === "string" &&
    natural(d.at) &&
    typeof d.text === "string" &&
    typeof d.textSha256 === "string" &&
    Array.isArray(d.citations) &&
    Array.isArray(d.problems) &&
    Array.isArray(d.advice) &&
    ["ready", "used", "dismissed"].includes(d.status)
    ? d
    : null;
}
function checkedStoredProvenance(raw: unknown): StoredProvenance | null {
  if (!isPlain(raw)) return null;
  const p = raw as StoredProvenance;
  return p.v === 1 &&
    Number.isSafeInteger(p.case) &&
    (p.kind === "reply" || p.kind === "assisted") &&
    typeof p.author === "string" &&
    natural(p.at) &&
    Array.isArray(p.citations) &&
    ["passed", "off", "from-draft", "none"].includes(p.check) &&
    Array.isArray(p.problems) &&
    Array.isArray(p.advice)
    ? p
    : null;
}
const statusOf = (
  request: StoredDraftRequest,
  now: number,
): SupportDraftRequestStatus =>
  request.status === "pending" && request.expiresAt <= now
    ? "expired"
    : request.status;

/* ---------------------------------------------------------------------- */
/* Errors                                                                  */
/* ---------------------------------------------------------------------- */

export const personOnly = () =>
  new HttpError(
    403,
    "Only a person on the team can do this.",
    undefined,
    "person-only",
  );
export const agentOnly = (message: string) =>
  new HttpError(403, message, undefined, "agent-only");
const closed = () =>
  new HttpError(
    409,
    "This Ask AI request is closed.",
    undefined,
    "draft-closed",
  );
const invalidProvenance = (error: unknown): never => {
  if (error instanceof SupportDraftInputError)
    throw new HttpError(400, error.message, undefined, "invalid-provenance");
  throw error;
};

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

/** The number check setting: "off" when absent, "hold" when unreadable. */
export function citationSetting(settings: unknown): "off" | "hold" {
  const value = isPlain(settings) ? settings.agentChecks : undefined;
  if (value === undefined) return "off";
  if (
    isPlain(value) &&
    (value.citations === "off" || value.citations === "hold")
  )
    return value.citations;
  return "hold";
}
/** Hosts provenance links may point to; an unreadable list is empty. */
export function sourceHostSetting(settings: unknown): string[] {
  const value = isPlain(settings) ? settings.aiSourceHosts : undefined;
  return Array.isArray(value) && value.every(isSourceHost)
    ? (value as string[]).slice(0, SUPPORT_DRAFT_LIMITS.sourceHosts)
    : [];
}
/** The case settings in a settings save. A field left out keeps its stored
 * value; anything else invalid is refused. */
export function parseCaseSettings(
  body: Record<string, unknown>,
  stored: SupportSettings & SupportCaseSettings,
): SupportCaseSettings {
  const out: SupportCaseSettings = {};
  if (body.agentChecks !== undefined) {
    const value = body.agentChecks;
    if (
      !isPlain(value) ||
      Object.keys(value).some((key) => key !== "citations") ||
      (value.citations !== "off" && value.citations !== "hold")
    )
      throw new HttpError(
        400,
        "Choose whether to check numbers in AI agent replies.",
      );
    out.agentChecks = { citations: value.citations };
  } else if (stored.agentChecks !== undefined)
    out.agentChecks = { citations: citationSetting(stored) };
  if (body.aiSourceHosts !== undefined) {
    const value = body.aiSourceHosts;
    if (
      !Array.isArray(value) ||
      value.length > SUPPORT_DRAFT_LIMITS.sourceHosts ||
      !value.every(isSourceHost)
    )
      throw new HttpError(
        400,
        `List up to ${SUPPORT_DRAFT_LIMITS.sourceHosts} sites, one per line, like docs.example.org.`,
      );
    out.aiSourceHosts = [...new Set(value as string[])];
  } else if (stored.aiSourceHosts !== undefined)
    out.aiSourceHosts = sourceHostSetting(stored);
  return out;
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

/** The thread's latest message, as `ifLatest` names it. */
async function latestMessage(
  storage: ReadStorage,
  thread: string,
): Promise<{ id: string; revision: number } | null> {
  const latest = await storage.get<number>(`channel-sequence:${thread}`);
  if (!natural(latest) || latest < 1) return null;
  const row = await storage.get<ChatMessage>(messageKey(thread, latest));
  return row ? { id: String(latest), revision: row.revision ?? 1 } : null;
}
/** The newest member-side message id among the thread's latest rows. */
async function latestMemberMessage(
  storage: ReadStorage,
  thread: string,
  members: readonly string[],
): Promise<number | null> {
  const rows = await storage.list<ChatMessage>({
    prefix: `channel-message:${thread}:`,
    reverse: true,
    limit: 50,
  });
  for (const row of rows.values())
    if (row && members.includes(row.author) && MESSAGE_ID.test(row.id))
      return Number(row.id);
  return null;
}
async function pendingCount(storage: Pick<Storage, "get">) {
  const count = await storage.get<number>(PENDING_COUNT_KEY);
  return natural(count) ? count : 0;
}
async function closePending(
  storage: Storage,
  request: StoredDraftRequest,
  data: DraftData,
) {
  if (
    await storage.delete(
      pendingKey(request.expiresAt, request.thread, request.id),
    )
  )
    await storage.put(
      PENDING_COUNT_KEY,
      Math.max(0, (await pendingCount(storage)) - 1),
    );
  if (data.aiDrafts?.pending === request.id) data.aiDrafts.pending = null;
}
/** Removes up to 20 expired pending keys, oldest first. Their requests read
 * as expired already; this only keeps the index and the count small. */
/** AI off closes the request's pending Ask AI question: the agent can no
 * longer see the thread, so the question leaves its queue and the counts at
 * once and the team sees it cancelled. */
export async function cancelPendingForAiOff(
  storage: Storage,
  input: {
    thread: string;
    data: DraftData;
    now: number;
    by: ChatPrincipalId | null;
  },
): Promise<void> {
  const id = input.data.aiDrafts?.pending;
  if (!id) return;
  const request = checkedRequest(
    await storage.get(requestKey(input.thread, id)),
    input.thread,
  );
  if (!request) {
    input.data.aiDrafts!.pending = null;
    return;
  }
  if (statusOf(request, input.now) === "pending") {
    request.status = "cancelled";
    request.closedAt = input.now;
    request.closedBy = input.by;
    await storage.put(requestKey(input.thread, request.id), request);
  }
  await closePending(storage, request, input.data);
}
export async function pruneExpiredRequests(storage: Storage, now: number) {
  const rows = await storage.list({
    prefix: PENDING_PREFIX,
    end: `${PENDING_PREFIX}${pad16(now + 1)}`,
    limit: SUPPORT_DRAFT_LIMITS.expiredPrune,
  });
  let removed = 0;
  for (const key of rows.keys()) if (await storage.delete(key)) removed++;
  if (removed)
    await storage.put(
      PENDING_COUNT_KEY,
      Math.max(0, (await pendingCount(storage)) - removed),
    );
}
function textOf(value: unknown, limit: number): string {
  const text = messageText(value);
  if (new TextEncoder().encode(text).length > limit)
    throw new HttpError(413, "Use plain text within the stated limit.");
  return text;
}

/* ---------------------------------------------------------------------- */
/* Ask AI: requests                                                        */
/* ---------------------------------------------------------------------- */

export type DraftActionInput = {
  thread: string;
  record: { member: ChatPrincipalId; formerMembers?: ChatPrincipalId[] };
  data: DraftData;
  actor: ChatPrincipalId;
  isBot: boolean;
  now: number;
};

/** `draft-request { clientId, instruction? }`, people only. Checks run in
 * the order of the design: retry, agent, AI off, instruction, pending,
 * per-case limit, workspace queue. */
export async function requestAiDraft(
  storage: Storage,
  input: DraftActionInput & {
    body: Record<string, unknown>;
    caseSeq: number;
    agentRegistered: boolean;
    mode: SupportAiMode;
  },
): Promise<{ request: StoredDraftRequest; created: boolean }> {
  if (input.isBot) throw personOnly();
  const id =
    typeof input.body.clientId === "string"
      ? input.body.clientId.toLowerCase()
      : "";
  if (!ID.test(id)) throw new HttpError(400, "Send a valid request id.");
  messageClientId(id, input.now);
  const instruction =
    input.body.instruction === undefined ||
    input.body.instruction === null ||
    (typeof input.body.instruction === "string" &&
      !input.body.instruction.trim())
      ? null
      : textOf(input.body.instruction, SUPPORT_DRAFT_LIMITS.instructionBytes);
  const existing = checkedRequest(
    await storage.get(requestKey(input.thread, id)),
    input.thread,
  );
  if (existing) {
    if (
      existing.instruction !== instruction ||
      existing.requestedBy !== input.actor
    )
      throw new HttpError(
        409,
        "This retry doesn't match the original.",
        undefined,
        "draft-request-retry-mismatch",
      );
    return { request: existing, created: false };
  }
  if (!input.agentRegistered)
    throw new HttpError(
      409,
      "Add an AI agent on the Team page to use Ask AI.",
      undefined,
      "no-agent",
    );
  if (input.mode === "off")
    throw new HttpError(
      409,
      "AI is off for this case. Turn it back on to ask the AI agent.",
      undefined,
      "ai-off",
    );
  if (instruction !== null) {
    await refusePhrase(instruction, "sent");
    refuseSecretRequest(instruction);
  }
  const data = input.data;
  if (!data.aiDrafts || data.aiDrafts.caseSeq !== input.caseSeq)
    data.aiDrafts = { caseSeq: input.caseSeq, requests: 0, pending: null };
  if (data.aiDrafts.pending) {
    const pending = checkedRequest(
      await storage.get(requestKey(input.thread, data.aiDrafts.pending)),
      input.thread,
    );
    if (pending && statusOf(pending, input.now) === "pending")
      throw new HttpError(
        409,
        "The AI agent is still working on the last question here.",
        undefined,
        "draft-pending",
      );
    data.aiDrafts.pending = null;
  }
  if (data.aiDrafts.requests >= SUPPORT_DRAFT_LIMITS.requestsPerCase)
    throw new HttpError(
      409,
      `Ask AI takes ${SUPPORT_DRAFT_LIMITS.requestsPerCase} questions per case.`,
      undefined,
      "draft-request-limit",
    );
  await pruneExpiredRequests(storage, input.now);
  if ((await pendingCount(storage)) >= SUPPORT_DRAFT_LIMITS.pendingPerWorkspace)
    throw new HttpError(
      503,
      "Ask AI is busy. Try again in a few minutes.",
      undefined,
      "draft-queue-full",
    );
  const request: StoredDraftRequest = {
    v: 1,
    id,
    thread: input.thread,
    case: input.caseSeq,
    requestedBy: input.actor,
    at: input.now,
    expiresAt: input.now + SUPPORT_DRAFT_LIMITS.requestMs,
    instruction,
    latestMessage: await latestMessage(storage, input.thread),
    status: "pending",
    closedAt: null,
    closedBy: null,
    decline: null,
    draft: null,
  };
  await storage.put(requestKey(input.thread, id), request);
  await storage.put(pendingKey(request.expiresAt, input.thread, id), true);
  await storage.put(PENDING_COUNT_KEY, (await pendingCount(storage)) + 1);
  data.aiDrafts.requests++;
  data.aiDrafts.pending = id;
  return { request, created: true };
}
async function readOpenRequest(
  storage: Storage,
  thread: string,
  value: unknown,
): Promise<StoredDraftRequest> {
  if (typeof value !== "string" || !ID.test(value))
    throw new HttpError(400, "Choose an Ask AI request.");
  const request = checkedRequest(
    await storage.get(requestKey(thread, value)),
    thread,
  );
  if (!request) throw closed();
  return request;
}
/** `draft-cancel { request }`: the person who asked, or a manager or
 * support lead. */
export async function cancelAiDraft(
  storage: Storage,
  input: DraftActionInput & {
    body: Record<string, unknown>;
    canManage: boolean;
  },
): Promise<StoredDraftRequest> {
  if (input.isBot) throw personOnly();
  const request = await readOpenRequest(
    storage,
    input.thread,
    input.body.request,
  );
  if (request.requestedBy !== input.actor && !input.canManage)
    throw new HttpError(
      403,
      "Only whoever asked or a support lead can cancel this.",
      undefined,
      "not-requester",
    );
  if (statusOf(request, input.now) !== "pending") throw closed();
  request.status = "cancelled";
  request.closedAt = input.now;
  request.closedBy = input.actor;
  await closePending(storage, request, input.data);
  await storage.put(requestKey(input.thread, request.id), request);
  return request;
}
/** `draft-decline { request, reason }`, registered AI agents only. */
export async function declineAiDraft(
  storage: Storage,
  input: DraftActionInput & { body: Record<string, unknown> },
): Promise<StoredDraftRequest> {
  if (!input.isBot)
    throw agentOnly("Only the AI agent declines an Ask AI request.");
  const reason = input.body.reason;
  if (!(SUPPORT_AI_DECLINES as readonly unknown[]).includes(reason))
    throw new HttpError(
      400,
      `Choose a reason: ${SUPPORT_AI_DECLINES.join(", ")}.`,
      undefined,
      "invalid-decline",
    );
  const request = await readOpenRequest(
    storage,
    input.thread,
    input.body.request,
  );
  if (statusOf(request, input.now) !== "pending") throw closed();
  request.status = "declined";
  request.decline = reason as SupportAiDecline;
  request.closedAt = input.now;
  request.closedBy = input.actor;
  await closePending(storage, request, input.data);
  await storage.put(requestKey(input.thread, request.id), request);
  return request;
}

/* ---------------------------------------------------------------------- */
/* Drafts                                                                  */
/* ---------------------------------------------------------------------- */

/** Makes room for one more draft in the case: at most 20 open drafts, and
 * past 20 in all the oldest closed draft is removed first. */
async function roomForDraft(storage: Storage, thread: string, seq: number) {
  const rows = await storage.list<unknown>({
    prefix: `${DRAFT_PREFIX}${thread}:${pad8(seq)}:`,
    limit: 200,
  });
  const drafts = [...rows]
    .map(([key, raw]) => ({ key, draft: checkedDraft(raw, seq) }))
    .filter((entry) => entry.draft !== null) as {
    key: string;
    draft: StoredDraft;
  }[];
  if (
    drafts.filter((entry) => entry.draft.status === "ready").length >=
    SUPPORT_DRAFT_LIMITS.draftsPerCase
  )
    throw new HttpError(
      409,
      "This case has 20 open AI drafts. Use or dismiss some first.",
      undefined,
      "draft-limit",
    );
  if (drafts.length >= SUPPORT_DRAFT_LIMITS.draftsPerCase) {
    const oldest = drafts
      .filter((entry) => entry.draft.status !== "ready")
      .sort((a, b) => a.draft.at - b.draft.at)[0];
    if (oldest) {
      await storage.delete(oldest.key);
      await storage.delete(draftClientKey(thread, oldest.draft.id));
    }
  }
  return drafts;
}
/** Runs the citation check as advice: the rows of case `seq`, or none. */
export async function adviseCitations(
  storage: ReadStorage,
  thread: string,
  seq: number | null,
  text: string,
  enabled: DiagnosisNetwork[] = [],
  audience: "team" | "agent" = "team",
): Promise<CitationCheck> {
  if (!hasCitationMarkers(text) && !findFigures(text).length)
    return checkCitations(text, []);
  // [dx:<id>] markers resolve against this thread's stored checks.
  const diagnoses = await citableDiagnoses(storage, thread, enabled);
  if (seq === null || seq < 1) return checkCitations(text, null, diagnoses);
  const rows = await citationRows(storage, thread, seq, audience);
  if (rows === "unreadable") {
    const check = checkCitations(text, [], diagnoses);
    return {
      ...check,
      ok: false,
      problems: [{ kind: "evidence-unreadable" }],
    };
  }
  return checkCitations(text, rows, diagnoses);
}
/** A copied FAQ sentence can support its figures only when the native
 * workspace still returns that exact current, member-safe FAQ. Client
 * source names, other source kinds and paraphrases grant no proof. */
async function proveFaqCitations(
  check: CitationCheck,
  provenance: SupportAiProvenance | null,
  knowledge: FaqCitationContext | undefined,
): Promise<CitationCheck> {
  const sources = provenance?.sources ?? [];
  if (!knowledge?.env.SUPPORT_KNOWLEDGE ||
      !provenance || !["answer", "draft"].includes(provenance.reason) ||
      !sources.length || sources.some((source) => source.kind !== "doc" || source.url || !/^kb\.[0-9a-f]{24}$/.test(source.id)) ||
      !check.problems.some((problem) => problem.kind === "uncited-figure")) return check;
  let hits: KnowledgeHitRow[];
  try {
    ({ hits } = await knowledgeCall<{ hits: KnowledgeHitRow[] }>(
      knowledge.env, knowledge.room, "knowledge.query",
      { principal: knowledge.actor, role: "bot" },
      { text: check.text.slice(0, KNOWLEDGE_LIMITS.queryChars), limit: 8, audience: "member", eras: ["current"] },
    ));
  } catch {
    return check;
  }
  if (!Array.isArray(hits) || hits.length > 8) return check;
  return proveFaqCitationsFromSources(check, provenance, hits);
}
function requireDiagnosisReferences(check: CitationCheck): void {
  if (check.problems.some((problem) => problem.kind === "unknown-diagnosis"))
    throw new HttpError(422, "That transaction check is not available.", undefined, "citation-check");
}
async function requireDiagnosisSources(
  storage: ReadStorage,
  thread: string,
  enabled: DiagnosisNetwork[],
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const allowed = new Set((await citableDiagnoses(storage, thread, enabled)).map((row) => row.id));
  if (ids.some((id) => !allowed.has(id)))
    throw new HttpError(422, "That transaction check is not available.", undefined, "citation-check");
}
const diagnosisSourceIds = (provenance: SupportAiProvenance | null) =>
  (provenance?.sources ?? []).filter((source) => source.kind === "diagnosis").map((source) => source.id);

/** `draft { clientId, text, request? | forMessage?, provenance? }`,
 * registered AI agents only. */
export async function writeAiDraft(
  storage: Storage,
  input: DraftActionInput & {
    body: Record<string, unknown>;
    caseSeq: number;
    mode: SupportAiMode;
    diagnosisNetworks?: DiagnosisNetwork[];
    knowledge?: FaqCitationContext;
    assertLatest: (
      ifLatest: unknown,
    ) => Promise<{ id: string; revision: number }>;
  },
): Promise<{
  draft: StoredDraft;
  created: boolean;
  request: StoredDraftRequest | null;
}> {
  if (!input.isBot)
    throw agentOnly(
      "Only an AI agent writes drafts. Write your reply in the composer.",
    );
  const body = input.body;
  const id =
    typeof body.clientId === "string" ? body.clientId.toLowerCase() : "";
  if (!ID.test(id)) throw new HttpError(400, "Send a valid draft id.");
  messageClientId(id, input.now);
  if ((body.request === undefined) === (body.forMessage === undefined))
    throw new HttpError(
      400,
      "Send a draft for one Ask AI request or one user message.",
      undefined,
      "invalid-draft",
    );
  if (input.mode === "off")
    throw new HttpError(
      409,
      "AI is off for this case. The AI agent can't reply, write drafts or add notes here.",
      undefined,
      "ai-off",
    );
  const raw = typeof body.text === "string" ? body.text : "";
  const text = textOf(raw, SUPPORT_DRAFT_LIMITS.draftBytes);
  await refusePhrase(text, "sent");
  refuseSecretRequest(text);
  let provenance: SupportAiProvenance | null = null;
  if (body.provenance !== undefined) {
    try {
      provenance = checkedProvenance(body.provenance);
    } catch (error) {
      invalidProvenance(error);
    }
  }
  const textSha256 = await messageTextHash(text);
  // A retry of the same draft returns it; other text under its id is refused.
  const priorKey = await storage.get<string>(draftClientKey(input.thread, id));
  if (typeof priorKey === "string") {
    const prior = checkedDraft(
      await storage.get(priorKey),
      Number(priorKey.split(":")[2]),
    );
    if (!prior || prior.author !== input.actor || prior.textSha256 !== textSha256)
      throw new HttpError(
        409,
        "This draft retry doesn't match the original.",
        undefined,
        "draft-retry-mismatch",
      );
    return { draft: prior, created: false, request: null };
  }
  let request: StoredDraftRequest | null = null;
  let forMessage: { id: string; revision: number } | null = null;
  let kind: SupportDraftKind;
  if (body.request !== undefined) {
    request = await readOpenRequest(storage, input.thread, body.request);
    if (
      statusOf(request, input.now) !== "pending" ||
      request.case !== input.caseSeq
    )
      throw closed();
    forMessage = request.latestMessage;
    kind = "ask-ai";
  } else {
    forMessage = await input.assertLatest(body.forMessage);
    const row = await storage.get<ChatMessage>(
      messageKey(input.thread, Number(forMessage.id)),
    );
    const members = [
      input.record.member,
      ...(input.record.formerMembers ?? []),
    ];
    if (!row || !members.includes(row.author as ChatPrincipalId))
      throw new HttpError(
        400,
        "A suggestion answers a user message.",
        undefined,
        "invalid-draft",
      );
    kind = "suggestion";
  }
  const drafts = await roomForDraft(storage, input.thread, input.caseSeq);
  if (
    kind === "suggestion" &&
    drafts.some(
      (entry) =>
        entry.draft.kind === "suggestion" &&
        entry.draft.forMessage?.id === forMessage!.id,
    )
  )
    throw new HttpError(
      409,
      "There's already a draft for this user message.",
      undefined,
      "draft-exists",
    );
  const check = await proveFaqCitations(await adviseCitations(
    storage,
    input.thread,
    input.caseSeq,
    text,
    input.diagnosisNetworks ?? [],
    request ? "team" : "agent",
  ), provenance, input.knowledge);
  requireDiagnosisReferences(check);
  await requireDiagnosisSources(storage, input.thread, input.diagnosisNetworks ?? [], diagnosisSourceIds(provenance));
  await screenAgentText(text, check.text, provenance);
  const draft: StoredDraft = {
    v: 1,
    id,
    case: input.caseSeq,
    kind,
    request: request?.id ?? null,
    forMessage,
    author: input.actor,
    at: input.now,
    text: check.text,
    textSha256,
    provenance,
    citations: check.citations,
    ...(check.diagnosisCitations?.length
      ? { diagnosisCitations: check.diagnosisCitations }
      : {}),
    problems: check.problems,
    advice: check.advice,
    status: "ready",
    usedMessageId: null,
    edited: null,
    closedAt: null,
    closedBy: null,
  };
  const key = draftKey(input.thread, input.caseSeq, id);
  await storage.put(key, draft);
  await storage.put(draftClientKey(input.thread, id), key);
  if (request) {
    request.status = "answered";
    request.draft = id;
    request.closedAt = input.now;
    request.closedBy = input.actor;
    await closePending(storage, request, input.data);
    await storage.put(requestKey(input.thread, request.id), request);
  }
  // The turn view shows "AI draft ready" to the team.
  input.data.lastAgentNoteAt = input.now;
  return { draft, created: true, request };
}
async function readDraft(
  storage: Storage,
  thread: string,
  seq: number,
  value: unknown,
): Promise<{ key: string; draft: StoredDraft }> {
  if (typeof value !== "string" || !ID.test(value))
    throw new HttpError(400, "Choose a draft.");
  const key = draftKey(thread, seq, value);
  const draft = checkedDraft(await storage.get(key), seq);
  if (!draft)
    throw new HttpError(
      404,
      "That draft isn't in this case.",
      undefined,
      "draft-not-found",
    );
  return { key, draft };
}
/** `draft-dismiss { draft }`, people only: a ready draft of the current
 * case is closed without sending anything. */
export async function dismissAiDraft(
  storage: Storage,
  input: DraftActionInput & { body: Record<string, unknown>; caseSeq: number },
): Promise<StoredDraft> {
  if (input.isBot) throw personOnly();
  const { key, draft } = await readDraft(
    storage,
    input.thread,
    input.caseSeq,
    input.body.draft,
  );
  if (draft.status !== "ready")
    throw new HttpError(
      409,
      "This draft was already used or dismissed.",
      undefined,
      "draft-closed",
    );
  draft.status = "dismissed";
  draft.closedAt = input.now;
  draft.closedBy = input.actor;
  await storage.put(key, draft);
  if (draft.kind === "held-reply")
    input.data.draftsHeld = Math.max(0, (input.data.draftsHeld ?? 1) - 1);
  return draft;
}

/* ---------------------------------------------------------------------- */
/* Held agent replies and provenance on replies                            */
/* ---------------------------------------------------------------------- */

export type HeldReply = {
  draft: string;
  case: number;
  problems: CitationProblem[];
};
/** The 422 an agent gets for a held reply. Returned, never thrown, so the
 * held draft commits with the request. */
export function heldReplyResponse(held: HeldReply): Response {
  return Response.json(
    {
      error: "Your reply was held for your team. Read held.problems.",
      reason: "reply-held",
      held,
    },
    { status: 422 },
  );
}
/** A held reply retried under its clientId: the same text returns the same
 * hold, other text is refused, and null means it was never held. */
export async function heldReplyRetry(
  storage: ReadStorage,
  thread: string,
  clientId: string | undefined,
  text: string,
): Promise<HeldReply | null> {
  if (!clientId) return null;
  const key = await storage.get<string>(draftClientKey(thread, clientId));
  if (typeof key !== "string") return null;
  const seq = Number(key.split(":")[2]);
  const draft = checkedDraft(await storage.get(key), seq);
  if (!draft || draft.kind !== "held-reply") return null;
  if (draft.textSha256 !== (await messageTextHash(text)))
    throw new HttpError(
      409,
      "This reply retry doesn't match the original.",
      undefined,
      "reply-retry-mismatch",
    );
  return { draft: draft.id, case: draft.case, problems: draft.problems };
}
/** What an AI agent's reply carries for the team: the text with markers
 * removed, its provenance and the citation check. `hold` is true when the
 * workspace holds failing replies and this one fails. */
export type AgentReplyCheck = {
  /** The text as the agent sent it, markers included (retries compare it). */
  sent: string;
  text: string;
  provenance: SupportAiProvenance | null;
  check: CitationCheck;
  /** Nothing to record: no markers, no figures and no provenance. */
  plain: boolean;
  hold: boolean;
  setting: "off" | "hold";
};
/** Screens what an AI agent's text becomes once its markers are removed,
 * and the provenance the team reads. A marker inside a phrase or a request
 * for a key would otherwise pass the checks on the raw text. */
async function screenAgentText(
  sent: string,
  text: string,
  provenance: SupportAiProvenance | null,
): Promise<void> {
  await refusePhrase(sent, "sent");
  refuseSecretRequest(sent);
  if (text !== sent) {
    if (!text.trim()) throw new HttpError(400, "Write a message first.");
    await refusePhrase(text, "sent");
    refuseSecretRequest(text);
  }
  if (!provenance) return;
  await refusePhrase(provenance.summary, "sent");
  await refusePhrase(provenance.model, "sent");
  for (const tool of provenance.tools ?? []) await refusePhrase(tool, "sent");
  for (const source of provenance.sources) await refusePhrase(source.title, "sent");
}
/** Checks a registered AI agent's reply before any write that counts.
 * People never send provenance and their text is never parsed. */
export async function checkAgentReply(
  storage: ReadStorage,
  input: {
    thread: string;
    caseSeq: number | null;
    text: string;
    provenance: unknown;
    settings: unknown;
    diagnosisNetworks?: DiagnosisNetwork[];
    knowledge?: FaqCitationContext;
  },
): Promise<AgentReplyCheck> {
  let provenance: SupportAiProvenance | null = null;
  if (input.provenance !== undefined) {
    try {
      provenance = checkedProvenance(input.provenance);
    } catch (error) {
      invalidProvenance(error);
    }
  }
  await requireDiagnosisSources(storage, input.thread, input.diagnosisNetworks ?? [], diagnosisSourceIds(provenance));
  const setting = citationSetting(input.settings);
  const marked = hasCitationMarkers(input.text);
  const figures = findFigures(stripCitationMarkers(input.text).text).length;
  if (!marked && !figures) {
    const check = checkCitations(input.text, []);
    await screenAgentText(input.text, check.text, provenance);
    return {
      sent: input.text,
      text: input.text,
      provenance,
      check,
      plain: provenance === null,
      hold: false,
      setting,
    };
  }
  const check = await proveFaqCitations(await adviseCitations(
    storage,
    input.thread,
    input.caseSeq,
    input.text,
    input.diagnosisNetworks ?? [],
    "agent",
  ), provenance, input.knowledge);
  requireDiagnosisReferences(check);
  await screenAgentText(input.text, check.text, provenance);
  return {
    sent: input.text,
    text: check.text,
    provenance,
    check,
    plain: false,
    hold: setting === "hold" && !check.ok,
    setting,
  };
}
/** Writes a held agent reply as a draft for the team. */
export async function holdAgentReply(
  storage: Storage,
  input: {
    thread: string;
    caseSeq: number;
    clientId: string;
    author: ChatPrincipalId;
    now: number;
    reply: AgentReplyCheck;
    forMessage: { id: string; revision: number } | null;
    data: DraftData;
  },
): Promise<HeldReply> {
  await roomForDraft(storage, input.thread, input.caseSeq);
  const draft: StoredDraft = {
    v: 1,
    id: input.clientId,
    case: input.caseSeq,
    kind: "held-reply",
    request: null,
    forMessage: input.forMessage,
    author: input.author,
    at: input.now,
    text: input.reply.check.text,
    // The retry compares the text the agent sent, markers included.
    textSha256: await messageTextHash(input.reply.sent),
    provenance: input.reply.provenance,
    citations: input.reply.check.citations,
    ...(input.reply.check.diagnosisCitations?.length
      ? { diagnosisCitations: input.reply.check.diagnosisCitations }
      : {}),
    problems: input.reply.check.problems,
    advice: input.reply.check.advice,
    status: "ready",
    usedMessageId: null,
    edited: null,
    closedAt: null,
    closedBy: null,
  };
  const key = draftKey(input.thread, input.caseSeq, input.clientId);
  await storage.put(key, draft);
  await storage.put(draftClientKey(input.thread, input.clientId), key);
  input.data.draftsHeld = (input.data.draftsHeld ?? 0) + 1;
  input.data.lastAgentNoteAt = input.now;
  return { draft: draft.id, case: draft.case, problems: draft.problems };
}
/** Stores the provenance of an agent's reply once the message is written. */
export async function writeAgentProvenance(
  storage: Storage,
  input: {
    thread: string;
    messageId: string;
    caseSeq: number;
    author: ChatPrincipalId;
    now: number;
    reply: AgentReplyCheck;
  },
): Promise<void> {
  if (input.reply.plain) return;
  const check = input.reply.check;
  const stored: StoredProvenance = {
    v: 1,
    case: input.caseSeq,
    kind: "reply",
    author: input.author,
    at: input.now,
    ai: input.reply.provenance,
    citations: check.citations,
    ...(check.diagnosisCitations?.length
      ? { diagnosisCitations: check.diagnosisCitations }
      : {}),
    check:
      check.figures === 0 && !check.citations.length
        ? "none"
        : input.reply.setting === "hold"
          ? "passed"
          : "off",
    problems: check.problems,
    advice: check.advice,
  };
  await storage.put(provenanceKey(input.thread, input.messageId), stored);
  if (stored.ai?.interaction?.kind === "clarify")
    await storage.put(`${AI_CLARIFICATION_PREFIX}${input.thread}:${input.caseSeq}`, { messageId: input.messageId });
}
/** `fromDraft` on a person's reply: a ready draft of the current case
 * becomes used, with `edited` from its text. Never blocks the reply: false
 * when the draft can't be used. */
export async function linkDraftUse(
  storage: Storage,
  input: {
    thread: string;
    caseSeq: number;
    draftId: unknown;
    diagnosisNetworks?: DiagnosisNetwork[];
    messageId: string;
    text: string;
    actor: ChatPrincipalId;
    now: number;
    data: DraftData;
  },
): Promise<{ linked: boolean; edited: boolean; draft: StoredDraft | null }> {
  if (
    typeof input.draftId !== "string" ||
    !ID.test(input.draftId) ||
    input.caseSeq < 1
  )
    return { linked: false, edited: false, draft: null };
  const key = draftKey(input.thread, input.caseSeq, input.draftId);
  const draft = checkedDraft(await storage.get(key), input.caseSeq);
  if (!draft || draft.status !== "ready")
    return { linked: false, edited: false, draft: null };
  const edited = input.text.trim() !== draft.text.trim();
  if (!edited)
    await requireDiagnosisSources(storage, input.thread, input.diagnosisNetworks ?? [], [
      ...(draft.diagnosisCitations ?? []).flatMap((row) => row.diagnoses),
      ...diagnosisSourceIds(draft.provenance),
    ]);
  draft.status = "used";
  draft.usedMessageId = input.messageId;
  draft.edited = edited;
  draft.closedAt = input.now;
  draft.closedBy = input.actor;
  await storage.put(key, draft);
  if (draft.kind === "held-reply")
    input.data.draftsHeld = Math.max(0, (input.data.draftsHeld ?? 1) - 1);
  const stored: StoredProvenance = {
    v: 1,
    case: input.caseSeq,
    kind: "assisted",
    author: input.actor,
    at: input.now,
    ai: edited && draft.provenance
      ? { ...draft.provenance, sources: draft.provenance.sources.filter((source) => source.kind !== "diagnosis") }
      : draft.provenance,
    // Citations carry over only when the person sent the draft as written.
    citations: edited ? [] : draft.citations,
    ...(!edited && draft.diagnosisCitations?.length
      ? { diagnosisCitations: draft.diagnosisCitations }
      : {}),
    check: edited ? "none" : "from-draft",
    problems: edited ? [] : draft.problems,
    advice: edited ? [] : draft.advice,
    fromDraft: { draft: draft.id, edited },
  };
  await storage.put(provenanceKey(input.thread, input.messageId), stored);
  return { linked: true, edited, draft };
}
function adviceProjection(
  storage: ReadStorage,
  thread: string,
  audience: "team" | "agent",
) {
  const scopes = new Map<number, Promise<Map<number, string>>>();
  return async (seq: number, advice: CitationAdvice[]) => {
    if (audience === "team" || !advice.length) return advice;
    let scope = scopes.get(seq);
    if (!scope) {
      scope = citationRows(storage, thread, seq, "agent").then((rows) =>
        new Map(
          (rows === "unreadable" ? [] : rows).map((row) =>
            [row.n, row.value.text] as const,
          ),
        ),
      );
      scopes.set(seq, scope);
    }
    const visible = await scope;
    return advice.filter((item) =>
      item?.kind === "value-mismatch" &&
      visible.has(item.evidence) &&
      visible.get(item.evidence) === item.value,
    );
  };
}

/** The team's provenance map for one page of messages: one ranged read. */
export async function provenancePage(
  storage: ReadStorage,
  thread: string,
  messageIds: readonly string[],
  /** Read only when the page has provenance to show. */
  settings: () => Promise<unknown>,
  audience: "team" | "agent" = "team",
): Promise<Record<string, SupportProvenanceView>> {
  const ids = messageIds.filter((id) => MESSAGE_ID.test(id)).map(Number);
  if (!ids.length) return {};
  // Always with a prefix: the support storage wrapper reads archived
  // partitions only for the prefixes it owns, never for this one.
  const rows = await storage.list<unknown>({
    prefix: `${PROVENANCE_PREFIX}${thread}:`,
    start: provenanceKey(thread, Math.min(...ids)),
    end: provenanceKey(thread, Math.max(...ids) + 1),
    limit: 200,
  });
  if (!rows.size) return {};
  const hosts = sourceHostSetting(await settings());
  const wanted = new Set(ids);
  const out: Record<string, SupportProvenanceView> = {};
  const projectAdvice = adviceProjection(storage, thread, audience);
  for (const [key, raw] of rows) {
    const id = Number(key.slice(key.lastIndexOf(":") + 1));
    if (!wanted.has(id)) continue;
    const stored = checkedStoredProvenance(raw);
    if (!stored) {
      console.warn(
        JSON.stringify({
          event: "TEMPL_SUPPORT_CASE_DATA_UNREADABLE",
          kind: "provenance",
          conversation: thread,
        }),
      );
      continue;
    }
    const ai = audience === "agent" && stored.kind === "assisted"
      ? null : stored.ai && { ...stored.ai };
    if (audience === "agent" && ai) delete ai.summary;
    out[String(id)] = {
      case: stored.case,
      kind: stored.kind,
      ai,
      citations: stored.citations,
      ...(stored.diagnosisCitations?.length
        ? { diagnosisCitations: stored.diagnosisCitations }
        : {}),
      check: stored.check,
      problems: stored.problems,
      advice: await projectAdvice(stored.case, stored.advice),
      ...(stored.fromDraft ? { fromDraft: stored.fromDraft } : {}),
      links: sourceLinks(ai, hosts),
    };
  }
  return out;
}
export async function deleteMessageProvenance(
  storage: Storage,
  thread: string,
  messageId: string | number,
) {
  await storage.delete(provenanceKey(thread, messageId));
}

/* ---------------------------------------------------------------------- */
/* Reads for the case detail and the agents' list                          */
/* ---------------------------------------------------------------------- */

export function requestView(
  request: StoredDraftRequest,
  now: number,
  withInstruction: boolean,
): SupportDraftRequestView {
  return {
    id: request.id,
    conversation: request.thread,
    case: request.case,
    requestedBy: request.requestedBy,
    requestedAt: iso(request.at),
    expiresAt: iso(request.expiresAt),
    ...(withInstruction ? { instruction: request.instruction } : {}),
    status: statusOf(request, now),
    decline: request.decline,
    draft: request.draft,
  };
}
function draftView(
  draft: StoredDraft,
  latestMember: number | null,
  hosts: readonly string[],
): SupportDraft {
  return {
    id: draft.id,
    case: draft.case,
    kind: draft.kind,
    request: draft.request,
    forMessage: draft.forMessage,
    author: draft.author,
    at: iso(draft.at),
    text: draft.text,
    provenance: draft.provenance,
    citations: draft.citations,
    ...(draft.diagnosisCitations?.length
      ? { diagnosisCitations: draft.diagnosisCitations }
      : {}),
    problems: draft.problems,
    advice: draft.advice,
    status: draft.status,
    usedMessageId: draft.usedMessageId,
    edited: draft.edited,
    stale:
      latestMember !== null &&
      (draft.forMessage === null || latestMember > Number(draft.forMessage.id)),
    closedAt: draft.closedAt === null ? null : iso(draft.closedAt),
    closedBy: draft.closedBy,
    links: sourceLinks(draft.provenance, hosts),
  };
}
/** A case's drafts, newest first, at most 20, with `stale` worked out from
 * the thread's newest member message and `links` from the workspace's
 * source sites. */
export async function readCaseDrafts(
  storage: ReadStorage,
  thread: string,
  seq: number,
  members: readonly string[],
  /** Read only when a draft names a source link. */
  settings: () => Promise<unknown>,
  audience: "team" | "agent" = "team",
  producer?: { actor: ChatPrincipalId; writtenDraft: StoredDraft },
): Promise<{ drafts: SupportDraft[]; unreadable: number }> {
  const rows = await storage.list<unknown>({
    prefix: `${DRAFT_PREFIX}${thread}:${pad8(seq)}:`,
    limit: 200,
  });
  const latestMember = await latestMemberMessage(storage, thread, members);
  const drafts: StoredDraft[] = [];
  let bad = 0;
  for (const raw of rows.values()) {
    const draft = checkedDraft(raw, seq);
    if (draft) drafts.push(draft);
    else bad++;
  }
  const shown = drafts
    .sort((a, b) => b.at - a.at)
    .slice(0, SUPPORT_DRAFT_LIMITS.draftsPerCase);
  const hosts = shown.some((draft) =>
    draft.provenance?.sources.some((source) => source.url),
  )
    ? sourceHostSetting(await settings())
    : [];
  const projectAdvice = adviceProjection(storage, thread, audience);
  const projected: SupportDraft[] = [];
  let visibleEvidence: Set<number> | undefined;
  for (const draft of shown) {
    const justWritten =
      producer?.actor === draft.author &&
      producer.writtenDraft.author === producer.actor &&
      producer.writtenDraft.case === seq &&
      producer.writtenDraft.id === draft.id &&
      JSON.stringify(producer.writtenDraft) === JSON.stringify(draft);
    if (audience === "agent" && !justWritten) {
      if (draft.kind === "ask-ai") continue;
      if (draft.citations.length) {
        if (!visibleEvidence) {
          const evidence = await citationRows(storage, thread, seq, "agent");
          visibleEvidence = new Set(
            (evidence === "unreadable" ? [] : evidence).map((row) => row.n),
          );
        }
        if (!draft.citations.every((citation) =>
          Array.isArray(citation?.evidence) &&
          citation.evidence.every((n) => visibleEvidence!.has(n)),
        )) continue;
      }
    }
    projected.push({
      ...draftView(draft, latestMember, hosts),
      advice: justWritten ? draft.advice : await projectAdvice(seq, draft.advice),
    });
  }
  return {
    drafts: projected,
    unreadable: bad,
  };
}
/** A case's Ask AI requests, newest first, at most 20, instructions
 * included (team case reads only). */
export async function readCaseRequests(
  storage: ReadStorage,
  thread: string,
  seq: number,
  now: number,
): Promise<SupportDraftRequestView[]> {
  const rows = await storage.list<unknown>({
    prefix: `${REQUEST_PREFIX}${thread}:`,
    limit: 500,
  });
  return [...rows.values()]
    .map((raw) => checkedRequest(raw, thread))
    .filter((request): request is StoredDraftRequest => request?.case === seq)
    .sort((a, b) => b.at - a.at)
    .slice(0, SUPPORT_DRAFT_LIMITS.requestsPerCase)
    .map((request) => requestView(request, now, true));
}
/** Open drafts and held replies of one case, for the case list. */
export async function caseDraftCount(
  storage: ReadStorage,
  thread: string,
  seq: number,
): Promise<number> {
  const rows = await storage.list<unknown>({
    prefix: `${DRAFT_PREFIX}${thread}:${pad8(seq)}:`,
    limit: 200,
  });
  return [...rows.values()].filter(
    (raw) => checkedDraft(raw, seq)?.status === "ready",
  ).length;
}
/** One page of pending, unexpired Ask AI requests, oldest first. `visible`
 * is the caller's per-row access check (which hides AI-off threads from the
 * agent); no row names more than ids, the case and times. Reads only. */
export async function draftRequestPage(
  storage: ReadStorage,
  input: {
    after: string | null;
    limit: number;
    now: number;
    visible: (thread: string) => Promise<boolean>;
  },
): Promise<{ requests: SupportDraftRequestRow[]; nextCursor: string | null }> {
  const limit = Math.max(
    1,
    Math.min(input.limit, SUPPORT_DRAFT_LIMITS.listPage),
  );
  const start = `${PENDING_PREFIX}${pad16(input.now + 1)}`;
  const rows = await storage.list<unknown>({
    prefix: PENDING_PREFIX,
    ...(input.after && input.after > start
      ? { startAfter: input.after }
      : { start }),
    limit: 500,
  });
  const out: SupportDraftRequestRow[] = [];
  let last: string | null = null;
  const seen = new Map<string, boolean>();
  for (const key of rows.keys()) {
    const match = PENDING_KEY.exec(key);
    if (!match) continue;
    const thread = match[2];
    if (!seen.has(thread)) seen.set(thread, await input.visible(thread));
    last = key;
    if (!seen.get(thread)) continue;
    const request = checkedRequest(
      await storage.get(requestKey(thread, match[3])),
      thread,
    );
    if (!request || statusOf(request, input.now) !== "pending") continue;
    out.push({
      id: request.id,
      conversation: thread,
      case: request.case,
      requestedAt: iso(request.at),
      expiresAt: iso(request.expiresAt),
    });
    if (out.length === limit) break;
  }
  return {
    requests: out,
    nextCursor: out.length === limit || rows.size === 500 ? last : null,
  };
}

/* ---------------------------------------------------------------------- */
/* Activity details and deletion                                           */
/* ---------------------------------------------------------------------- */

/** Problem kinds only, for an activity entry. */
export const problemKinds = (problems: readonly CitationProblem[]) =>
  [...new Set(problems.map((problem) => problem.kind))].join(",").slice(0, 200);
export type CaseActivityAction =
  | SupportActivity["action"]
  | "frame"
  | "evidence"
  | "evidence-withdrawn"
  | "draft-request"
  | "draft-held"
  | "draft-used"
  | "draft-dismissed"
  // A follow-up changed (the detail is its code).
  | "follow-up";

/** Deletes up to `budget` keys of case `seq`: its drafts with their retry
 * keys, and its Ask AI requests with their pending keys. */
export async function deleteCaseDrafts(
  storage: Storage,
  thread: string,
  seq: number,
  budget: number,
): Promise<number> {
  if (budget <= 0) return 0;
  let deleted = 0;
  if (await storage.delete(`${AI_CLARIFICATION_PREFIX}${thread}:${seq}`)) deleted++;
  if (deleted >= budget) return deleted;
  for (const [key, raw] of await storage.list<unknown>({
    prefix: `${DRAFT_PREFIX}${thread}:${pad8(seq)}:`,
    limit: budget,
  })) {
    const draft = checkedDraft(raw, seq);
    if (
      draft &&
      deleted < budget &&
      (await storage.delete(draftClientKey(thread, draft.id)))
    )
      deleted++;
    if (deleted >= budget) return deleted;
    if (await storage.delete(key)) deleted++;
    if (deleted >= budget) return deleted;
  }
  for (const [key, raw] of await storage.list<unknown>({
    prefix: `${REQUEST_PREFIX}${thread}:`,
    limit: 500,
  })) {
    const request = checkedRequest(raw, thread);
    if (!request || request.case !== seq) continue;
    if (deleted + 2 > budget) return deleted;
    if (
      await storage.delete(pendingKey(request.expiresAt, thread, request.id))
    ) {
      deleted++;
      await storage.put(
        PENDING_COUNT_KEY,
        Math.max(0, (await pendingCount(storage)) - 1),
      );
    }
    if (await storage.delete(key)) deleted++;
  }
  return deleted;
}
/** Deletes up to `budget` of a deleted thread's draft, request and
 * provenance keys. Pending keys go with their requests and leave the
 * workspace count. */
export async function deleteThreadDrafts(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  let deleted = 0;
  for (const [key, raw] of await storage.list<unknown>({
    prefix: `${REQUEST_PREFIX}${thread}:`,
    limit: Math.max(0, Math.floor(budget / 2)),
  })) {
    if (deleted + 2 > budget) return deleted;
    const request = checkedRequest(raw, thread);
    if (
      request &&
      (await storage.delete(pendingKey(request.expiresAt, thread, request.id)))
    ) {
      deleted++;
      await storage.put(
        PENDING_COUNT_KEY,
        Math.max(0, (await pendingCount(storage)) - 1),
      );
    }
    if (await storage.delete(key)) deleted++;
  }
  for (const prefix of DRAFT_THREAD_PREFIXES) {
    if (deleted >= budget) break;
    for (const key of (
      await storage.list({
        prefix: `${prefix}${thread}:`,
        limit: budget - deleted,
      })
    ).keys())
      if (await storage.delete(key)) deleted++;
  }
  return deleted;
}
