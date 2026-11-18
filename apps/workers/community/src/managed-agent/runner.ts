import {
  GROUNDED_POLICY,
  GROUNDED_SYSTEM,
  GROUNDED_VERIFIER_SYSTEM,
  GROUNDED_SUMMARY,
  groundedContext,
  groundedSensitive,
  groundedMemberTurn,
  groundedSources,
  groundedSafeText,
  groundedVerifierAccepted,
  groundedFigures,
  groundedProvenanceSources,
  groundedProvenance,
  saveGroundedReceipt,
  type GroundedContext,
} from "./grounded";
import { readKnowledgeContext } from "../support-knowledge-kb";
import {
  storageAuthorizedManager,
  type StorageUploadGrant,
} from "../brain-storage";
import { standardAiUsageUsdNanos } from "@templ/chat/standard-usage";
import { prepaidAiMaximum } from "../product-prepaid-ai";
import type { WorkspaceFlagEnv } from "../workspace-flags";
import { featureOn } from "../workspace-flags";
import {
  HANDOFF_LEARNING_SYSTEM,
  HANDOFF_LEARNING_VERIFY_SYSTEM,
  HANDOFF_LEARNING_EXCLUDED_REASONS,
  HANDOFF_LEARNING_LIMITS,
  checkedHandoffLearningResult,
  type HandoffLearningJob,
  type HandoffLearningResult,
} from "@templ/chat/support-learning";
/** The managed runner: works the queued jobs of one workspace inside its
 * knowledge object's alarm.
 *
 * For each job it reads the request through the room as the managed account
 * (so AI off hides it and every access check applies), reads the
 * workspace's knowledge in this object, asks the model once, checks the
 * answer, records the facts it used as evidence rows, and then writes what
 * the request's AI mode allows:
 * - "answers": a reply to the member, citing its evidence;
 * - "drafts": a draft for the team, never a reply;
 * - Ask AI: a draft that answers the person's question.
 * A handoff, an answer that fails a check, a failed call or a member
 * message older than the 90-second deadline goes to a person instead.
 *
 * Before any model call: the kill switch, the model transport, and both monthly caps
 * (held before the call, settled after it). If any of them stops the call,
 * nothing is sent to the model: an Ask AI question is declined as
 * unavailable and a member's message waits for a person. */
import { readWorkspaceAiGuidance } from "../support-knowledge-guidance";
import { detectStoredSecret } from "../secret-guard";
import { checkedLearningEntries } from "../support-knowledge-learning";
import {
  findFigures,
  stripCitationMarkers,
  type CitableDiagnosis,
} from "@templ/chat/support-citations";
import {
  checkAgentReply,
  redactForModel,
  screenTeamText,
} from "@templ/chat/support-safety";
import {
  MANAGED_AGENT_LIMITS,
  MANAGED_AGENT_MODEL,
  ManagedAnswerError,
  checkedManagedAnswer,
  citeFacts,
  hasFactMarkers,
  managedCallCents,
  needsClarifying,
  spendMonth,
  type ManagedAgentStop,
  type ManagedAnswer,
  type ManagedHandoffReason,
} from "@templ/chat/managed-agent";
import {
  fingerprintKey,
  goldenProblems,
  type GoldenResult,
} from "@templ/chat/golden-set";
import {
  amountsIn,
  metricKeyBindings,
  sameAmount,
  type MetricClaim,
} from "@templ/chat/metric-keys";
import type { SupportHandoffReason } from "@templ/chat/support";
import type { EvalCase } from "@templ/chat/support-eval";
import {
  numbersIn,
  scoreEvalOutput,
  type EvalScore,
} from "@templ/chat/support-eval-score";
import type { ProfileMetric } from "@templ/chat/protocol-profile";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { uuidv7 } from "../uuidv7";
import {
  queryKnowledgeBase,
  type KnowledgeHitRow,
} from "../support-knowledge-kb";
import { listMetrics } from "../support-knowledge-profile";
import type { KnowledgeDb } from "../support-knowledge-schema";
import {
  type ManagedModelEnv,
  type ModelCaller,
  type ModelResult,
} from "./anthropic";
import { managedReplyVerdict } from "./checks";
import {
  MANAGED_SYSTEM_PROMPT,
  promptUser,
  type PromptMessage,
} from "./prompt";
import type { RoomClient } from "./room-client";
import {
  killSwitchOn,
  nativeModelAvailable,
  templCapCents,
  workspaceCapCents,
} from "./room";
import {
  addJobs,
  clearGoldenPartial,
  currentFingerprint,
  dueJobs,
  finishJob,
  goldenCases,
  goldenJobQueued,
  goldenPartial,
  goldenState,
  recordGoldenRun,
  setGoldenPartial,
  releaseSpend,
  reserveSpend,
  retryJob,
  saveWorkspaceSpend,
  saveJob,
  setGoldenQueued,
  goldenQueuedAt,
  settleSpend,
  workspaceSpend,
  type StoredJob,
} from "./store";

export type RunnerEnv = WorkspaceFlagEnv &
  ManagedModelEnv & {
    MANAGED_AGENT_ENABLED?: string;
    MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
  };
/** Templ's meter across every workspace. */
export type TemplMeter = {
  reserve(
    month: string,
    id: string,
    cents: number,
    cap: number,
  ): Promise<boolean>;
  settle(month: string, id: string, cents: number): Promise<void>;
  release(month: string, id: string): Promise<void>;
};
export type RunnerDeps = {
  db: KnowledgeDb;
  env: RunnerEnv;
  room: string;
  principal: ChatPrincipalId;
  roomClient(manager: string): RoomClient;
  /** Null when no model transport is configured. */
  model: ModelCaller | null;
  prepaidModel?: (client: RoomClient) => ModelCaller;
  prepaid?: boolean;
  templMeter: TemplMeter;
  now(): number;
  /** This workspace's monthly cap in cents; FEATURE_LIMITS when absent. */
  workspaceCap?: number;
  onCostAttempt?: import("./anthropic").ModelRequest["onCostAttempt"];
};
const capOf = (deps: Pick<RunnerDeps, "workspaceCap">) =>
  deps.workspaceCap ?? workspaceCapCents();
export type JobOutcome =
  | "answered"
  | "resolved"
  | "drafted"
  | "clarified"
  | "handed-off"
  | "declined"
  | "skipped"
  | "retry"
  | "golden"
  | "learned"
  | `stopped:${ManagedAgentStop}`;

type RoomState = {
  prepaid?: boolean;
  readinessPolicy?: "grounded_v1" | "golden_v1";
  storageGrant?: StorageUploadGrant | null;
  enabled: boolean;
  grant: boolean;
  onTeam: boolean;
  thread?: string;
  member?: string;
  formerMembers?: string[];
  state?: "open" | "resolved";
  stopped?: boolean;
  handoff?: boolean;
  mode?: "answers" | "drafts" | "off";
  caseSeq?: number;
  caseOpenedAt?: number;
  caseMemberMessages?: number;
  diagnosisRunning?: boolean;
  sharedHashes?: string[];
  frame?: Record<string, unknown> | null;
  /** Full case evidence is used only for a person's validated Ask AI draft. */
  evidence?: EvidenceRow[];
  /** The room filters generated position evidence before autonomous answers. */
  memberEvidence?: EvidenceRow[];
  diagnoses?: (CitableDiagnosis & {
    section: "reading";
    status: string;
    needsPerson: boolean;
    reading: string[];
    evidence: unknown[];
  })[];
  clarifyingAsked?: number;
};
type EvidenceRow = {
  n: number;
  product: { key: string; label?: string };
  metric: { key: string; label?: string };
  window: { key: string; label?: string };
  value: { text: string; number?: string; unit?: string };
  withdrawn?: unknown;
  supersededBy?: number | null;
};
type Message = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  revision?: number;
};

const GOLDEN_RERUN_MS = 60 * 60_000;
const GOLDEN_CASES_PER_JOB = 5;
const retryable = (status: number) => status === 429 || status >= 500;
const NUMBER = /^-?\d{1,30}(\.\d{1,30})?$/;
const digits = (value: string) => value.replace(/[,\s_]/g, "");
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether an excerpt states the number as a whole token: "4" is not in
 * "5.4%" and "5.12" is not in "15.12". Grouping commas in the excerpt are
 * read as the same number ("1,200" states 1200). */
export function excerptStates(excerpt: string, number: string): boolean {
  const wanted = digits(number);
  if (!/\d/.test(wanted)) return false;
  const pattern = new RegExp(
    `(?<![\\d.,])${escapeRegex(wanted)}(?![\\d]|[.,]\\d)`,
  );
  return pattern.test(excerpt.replace(/(\d),(?=\d{3}\b)/g, "$1"));
}

/* ---------------------------------------------------------------------- */
/* Metering                                                                */
/* ---------------------------------------------------------------------- */

/** Why no call can be made now, before any spend is held. */
export function callStop(
  deps: Pick<RunnerDeps, "env" | "model" | "workspaceCap" | "prepaid">,
): ManagedAgentStop | null {
  if (!killSwitchOn(deps.env)) return "kill-switch";
  if (!deps.model || !nativeModelAvailable(deps.env, Boolean(deps.prepaid)))
    return "no-key";
  if (!deps.prepaid && !capOf(deps)) return "no-budget";
  if (!templCapCents(deps.env)) return "templ-cap";
  return null;
}

/** One model call inside both caps: the reserve is held first, the real
 * cost settles after the call answers (or fails). */
export async function meteredCall(
  deps: RunnerDeps,
  system: string,
  user: string,
  sharedHashes: readonly string[] = [],
  purpose: import("@templ/chat/workspace-costs").WorkspaceCostEvent["purpose"] = "other",
  format: "answer" | "handoff-learning" = "answer",
): Promise<ModelResult | { kind: "stopped"; stop: ManagedAgentStop }> {
  const stop = callStop(deps);
  if (stop) return { kind: "stopped", stop };
  const now = deps.now();
  const id = crypto.randomUUID();
  if (deps.prepaid) {
    const maximumProviderNanos = BigInt(
      prepaidAiMaximum(MANAGED_AGENT_LIMITS.maxOutputTokens, 1),
    );
    const maximumProviderCents = Number(
      (maximumProviderNanos + 9_999_999n) / 10_000_000n,
    );
    const month = spendMonth(now);
    let held = false;
    try {
      held = await deps.templMeter.reserve(
        month,
        id,
        maximumProviderCents,
        templCapCents(deps.env),
      );
    } catch {
      /* The global provider cap fails closed. */
    }
    if (!held) return { kind: "stopped", stop: "templ-cap" };
    let result: ModelResult;
    try {
      result = await deps.model!({
        system: redactForModel(system).text,
        user: redactForModel(user, {
          evmHashes: sharedHashes,
          solanaSignatures: sharedHashes,
        }).text,
        purpose,
        format,
        onCostAttempt: deps.onCostAttempt,
      });
    } catch {
      result = { kind: "failed", reason: "caller", usage: null };
    }
    if (result.kind === "failed" && result.providerAttempted === false) {
      // Only trusted pre-inference returns can prove no model cost occurred.
      await deps.templMeter.release(month, id).catch(() => undefined);
      return result;
    }
    const actual = result.standardUsage
      ? standardAiUsageUsdNanos("gpt-6.1-sol", result.standardUsage, 1)
      : null;
    // Unknown provider cost retains the conservative operating charge; it never charges the customer.
    const spent =
      actual === null
        ? maximumProviderCents
        : Number((BigInt(actual) + 9_999_999n) / 10_000_000n);
    await deps.templMeter.settle(month, id, spent).catch(() => undefined);
    return result;
  }
  const reserve = MANAGED_AGENT_LIMITS.reserveCentsPerCall;
  const held = deps.db.transaction(() => {
    const { month, record } = workspaceSpend(deps.db, now);
    const ok = reserveSpend(record, {
      id,
      cents: reserve,
      cap: capOf(deps),
      now,
    });
    if (ok) saveWorkspaceSpend(deps.db, month, record);
    return ok ? month : null;
  });
  if (!held) return { kind: "stopped", stop: "workspace-cap" };
  let templHeld = false;
  try {
    templHeld = await deps.templMeter.reserve(
      held,
      id,
      reserve,
      templCapCents(deps.env),
    );
  } catch {
    templHeld = false;
  }
  const settle = (cents: number | null) =>
    deps.db.transaction(() => {
      const { month, record } = workspaceSpend(deps.db, now);
      if (month !== held) return;
      if (cents === null) releaseSpend(record, id);
      else settleSpend(record, id, cents);
      saveWorkspaceSpend(deps.db, month, record);
    });
  if (!templHeld) {
    settle(null);
    return { kind: "stopped", stop: "templ-cap" };
  }
  let result: ModelResult;
  try {
    result = await deps.model!({
      system: redactForModel(system).text,
      user: redactForModel(user, {
        evmHashes: sharedHashes,
        solanaSignatures: sharedHashes,
      }).text,
      purpose,
      format,
      onCostAttempt: deps.onCostAttempt,
    });
  } catch {
    result = { kind: "failed", reason: "caller", usage: null };
  }
  const cents = managedCallCents(result.usage);
  settle(cents);
  await deps.templMeter.settle(held, id, cents).catch(() => undefined);
  return result;
}

/* ---------------------------------------------------------------------- */
/* One request                                                             */
/* ---------------------------------------------------------------------- */

function knowledgeHits(
  db: KnowledgeDb,
  text: string,
  audience: "member" | "team",
  addresses: string[],
  storageGrant?: StorageUploadGrant | null,
  now = Date.now(),
): KnowledgeHitRow[] {
  const query = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!query) return [];
  try {
    return queryKnowledgeBase(db, {
      text: query,
      limit: MANAGED_AGENT_LIMITS.knowledgeHits,
      eras: ["current", "legacy"],
      addresses,
      audience,
      storageGrant,
      now,
    });
  } catch {
    return [];
  }
}
const memberSafeMetrics = (db: KnowledgeDb, audience: "member" | "team") =>
  listMetrics(db, audience === "team").metrics;

function hostOf(url: string | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
function titleBytes(value: string, max: number) {
  let out = value.replace(/\s+/g, " ").trim();
  while (new TextEncoder().encode(out).length > max) out = out.slice(0, -1);
  return out || "Source";
}

type Built = {
  text: string;
  claims: MetricClaim[];
  provenance: Record<string, unknown>;
  factRows: Record<string, unknown>[];
};
/** Checks the answer against what the model was given and turns it into
 * the room writes. Null when it must go to a person. */
export function buildAnswer(input: {
  answer: ManagedAnswer;
  hits: KnowledgeHitRow[];
  evidence: EvidenceRow[];
  evidenceHighWater?: number;
  diagnoses?: CitableDiagnosis[];
  metrics: ProfileMetric[];
  memberText: string;
  frame: Record<string, unknown> | null;
  clarifyingAsked: number;
  reason: "answer" | "draft";
  model: string;
}): Built | { refuse: "unsure" | "safety" } {
  const { answer, hits } = input;
  if (screenTeamText(stripCitationMarkers(answer.text).text))
    return { refuse: "safety" };
  const byId = new Map(hits.map((hit) => [hit.sourceId, hit]));
  const bindings = metricKeyBindings(input.metrics);
  // Facts must be in the excerpt they name: the model can't add a figure.
  for (const fact of answer.facts) {
    const hit = byId.get(fact.source)!;
    const numbers = fact.number
      ? [fact.number]
      : amountsIn(fact.value).map((amount) => amount.number);
    if (
      !numbers.length ||
      !numbers.every((number) => excerptStates(hit.excerpt, number))
    )
      return { refuse: "unsure" };
  }
  const next = Math.max(
    0,
    input.evidenceHighWater ?? 0,
    ...input.evidence.map((row) => row.n),
  );
  if (next + answer.facts.length > 50) return { refuse: "unsure" };
  const cited = new Set(
    [...answer.text.matchAll(/\[fact:(\d{1,2})\]/g)].map((match) =>
      Number(match[1]),
    ),
  );
  const factRows = answer.facts.map((fact) => {
    const hit = byId.get(fact.source)!;
    const number = fact.number ? digits(fact.number) : null;
    const link = hostOf(hit.url) ? hit.url : undefined;
    return {
      source: hit.kind === "profile" ? "other" : "docs",
      sourceLabel: titleBytes(hit.title, 80),
      product: { key: fact.product },
      metric: {
        key: fact.metric,
        ...(bindings.get(fact.metric)
          ? { label: bindings.get(fact.metric)!.label }
          : {}),
      },
      window: { key: fact.window },
      observed: { time: hit.updatedAt },
      value: {
        text: fact.value,
        ...(number && NUMBER.test(number) ? { number } : {}),
        ...(fact.unit ? { unit: fact.unit } : {}),
      },
      ...(link ? { link } : {}),
    };
  });
  const claims: MetricClaim[] = [
    ...answer.claims,
    ...answer.facts
      .map((fact, index) => ({ fact, k: index + 1 }))
      .filter(({ k }) => cited.has(k))
      .map(({ fact, k }) => ({
        metric: fact.metric,
        product: fact.product,
        window: fact.window,
        value: fact.value,
        evidence: [next + k],
      })),
  ];
  const prospective = [
    ...input.evidence.map((row) => ({
      n: row.n,
      product: { key: row.product.key },
      metric: { key: row.metric.key },
      window: { key: row.window.key },
      value: row.value,
      withdrawn: Boolean(row.withdrawn),
      supersededBy: row.supersededBy ?? null,
    })),
    ...factRows.map((row, index) => ({
      n: next + index + 1,
      product: { key: (row.product as { key: string }).key },
      metric: { key: (row.metric as { key: string }).key },
      window: { key: (row.window as { key: string }).key },
      value: row.value as { text: string; number?: string },
      withdrawn: false,
      supersededBy: null,
    })),
  ];
  const clarifying = answer.action === "clarify";
  const text = citeFacts(
    answer.text,
    new Map(factRows.map((_, index) => [index + 1, next + index + 1])),
  );
  if (hasFactMarkers(text)) return { refuse: "unsure" };
  // A number the frame can't place is asked about once, never answered.
  if (
    !clarifying &&
    claims.length &&
    needsClarifying({
      memberStatesNumber: findFigures(input.memberText).length > 0,
      frame: input.frame,
    })
  )
    return { refuse: "unsure" };
  const verdict = managedReplyVerdict({
    text,
    meta: { claims, comparisons: answer.comparisons, clarifying },
    bindings,
    evidence: prospective,
    diagnoses: input.diagnoses,
    clarifyingAsked: input.clarifyingAsked,
  });
  if (!verdict.ok) return { refuse: "unsure" };
  if (input.reason === "answer" && !clarifying) {
    const cited = stripCitationMarkers(text).markers.some(
      (marker) => marker.ids.length > 0 || Boolean(marker.dx?.length),
    );
    if (answer.confidence !== "high" || (!answer.sources.length && !cited))
      return { refuse: "unsure" };
  }
  const allowedHosts = new Set(
    hits
      .map((hit) => hostOf(hit.url))
      .filter((host): host is string => Boolean(host)),
  );
  if (
    checkAgentReply(stripCitationMarkers(text).text, {
      allowedHosts,
      maxBytes: 3_500,
    })
  )
    return { refuse: "safety" };
  const sourceIds = [
    ...new Set([...answer.sources, ...answer.facts.map((fact) => fact.source)]),
  ];
  if (sourceIds.length > 8) return { refuse: "unsure" };
  const sources = sourceIds.map((id) => {
    const hit = byId.get(id)!;
    return {
      id,
      kind:
        hit.kind === "doc" || hit.kind === "faq" || hit.kind === "profile"
          ? hit.kind
          : "other",
      title: titleBytes(hit.title, 120),
      ...(hostOf(hit.url) ? { url: hit.url } : {}),
    };
  });
  return {
    text,
    claims,
    factRows,
    provenance: {
      reason:
        clarifying && input.reason === "answer"
          ? "clarifying-question"
          : input.reason,
      ...(answer.summary ? { summary: titleBytes(answer.summary, 500) } : {}),
      sources,
      confidence: answer.confidence,
      model: input.model,
      tools: ["knowledge", ...(factRows.length ? ["evidence"] : [])],
    },
  };
}

async function readRequest(
  client: RoomClient,
  thread: string,
): Promise<
  | { ok: false; status: number }
  | { ok: true; state: RoomState; messages: Message[] }
> {
  const state = await client.get(
    `/conversations/managed/state?thread=${thread}`,
  );
  if (state.status !== 200) return { ok: false, status: state.status };
  const messages = await client.get(
    `/conversations/${thread}/messages?limit=${MANAGED_AGENT_LIMITS.messagesRead}`,
  );
  if (messages.status !== 200) return { ok: false, status: messages.status };
  return {
    ok: true,
    state: state.body as RoomState,
    messages: ((messages.body.messages ?? []) as Message[]).slice(
      -MANAGED_AGENT_LIMITS.messagesRead,
    ),
  };
}

function promptMessages(
  messages: Message[],
  member: Set<string>,
  principal: string,
  sharedHashes: readonly string[] = [],
): PromptMessage[] {
  return messages.map((message) => ({
    role: member.has(message.author)
      ? "member"
      : message.author === principal
        ? "ai"
        : "team",
    text: redactForModel(
      message.text.slice(0, MANAGED_AGENT_LIMITS.messageChars),
      { evmHashes: sharedHashes, solanaSignatures: sharedHashes },
    ).text,
    at: message.createdAt,
  }));
}

async function handoff(
  client: RoomClient,
  thread: string,
  reason: ManagedHandoffReason,
) {
  const result = await client.post(`/conversations/${thread}/workflow`, {
    action: "handoff",
    reason,
  });
  return result.status < 300
    ? "handed-off"
    : retryable(result.status)
      ? "retry"
      : "skipped";
}
async function decline(
  client: RoomClient,
  thread: string,
  request: string,
  reason: string,
) {
  const result = await client.post(`/conversations/${thread}/workflow`, {
    action: "draft-decline",
    request,
    reason,
  });
  return result.status < 300
    ? "declined"
    : retryable(result.status)
      ? "retry"
      : "skipped";
}

async function closeAnsweredCase(
  client: RoomClient,
  job: StoredJob,
): Promise<JobOutcome> {
  const result = await client.post(`/conversations/${job.thread}/resolve`, {
    resolved: true,
    case: job.close!.case,
    ifLatest: job.close!.reply,
  });
  return result.status < 300
    ? "resolved"
    : retryable(result.status)
      ? "retry"
      : "answered";
}

/** New paid workspaces use current passages and an independent held claim check. */
async function runGroundedAnswer(input: {
  deps: RunnerDeps;
  client: RoomClient;
  job: StoredJob;
  state: RoomState;
  latest: Message;
  answer: ManagedAnswer;
  context: GroundedContext;
  memberText: string;
  writeAs: "reply" | "suggestion" | "ask-ai";
  toPerson(reason: ManagedHandoffReason, decline: string): Promise<JobOutcome>;
  storeSummary(): Promise<boolean>;
}): Promise<JobOutcome> {
  const { deps, client, job, state, answer, context, latest } = input;
  const hits = groundedSources(answer, context);
  if (
    !latest ||
    !state.caseSeq ||
    !hits ||
    !answer.text.trim() ||
    !groundedSafeText(answer.text, hits) ||
    (await detectStoredSecret(answer.text))
  )
    return input.toPerson(answer.handoffReason ?? "unsure", "unavailable");
  const verification = await meteredCall(
    deps,
    GROUNDED_VERIFIER_SYSTEM,
    JSON.stringify({
      answer: answer.text,
      passages: hits.map((hit) => ({
        sourceId: hit.sourceId,
        text: hit.excerpt,
        url: hit.url,
      })),
    }),
    state.sharedHashes,
    "other",
  );
  if (
    verification.kind === "stopped" ||
    !groundedVerifierAccepted(verification, hits)
  )
    return input.toPerson("unsure", "unavailable");
  const highWater = Math.max(0, ...(state.evidence ?? []).map((row) => row.n));
  const built = groundedFigures(answer.text, hits, highWater);
  if (!built) return input.toPerson("unsure", "unavailable");
  const partial =
    answer.action === "handoff" ||
    answer.confidence !== "high" ||
    groundedSensitive(input.memberText);
  if (partial && input.writeAs === "reply") await input.storeSummary();
  const token = await saveGroundedReceipt(deps.db, {
    context,
    hits,
    text: built.text,
    thread: job.thread!,
    case: state.caseSeq,
    latest: { id: latest.id, revision: latest.revision ?? 1 },
    now: deps.now(),
    approved: true,
    audience: input.writeAs === "reply" ? "member" : "team",
    resolvable:
      input.writeAs === "reply" && answer.action === "resolve" && !partial,
    clarifying: answer.action === "clarify",
  });
  const provenance = {
    reason:
      input.writeAs === "reply"
        ? answer.action === "clarify"
          ? "clarifying-question"
          : "answer"
        : "draft",
    sources: groundedProvenanceSources(hits),
    confidence: partial ? "medium" : answer.confidence,
    model: "gpt-6.1-sol",
    ...(answer.summary ? { summary: titleBytes(answer.summary, 500) } : {}),
    tools: ["knowledge", "source-check"],
    grounding: groundedProvenance(deps.db, token),
  };
  if (built.rows.length) {
    const result = await client.post(`/conversations/${job.thread}/workflow`, {
      action: "evidence",
      case: state.caseSeq,
      clientId: uuidv7(deps.now()),
      rows: built.rows,
      provenance,
    });
    const rows = result.body.evidence as { n: number }[] | undefined;
    if (
      result.status >= 300 ||
      !rows ||
      rows.length !== built.rows.length ||
      rows[0]?.n !== highWater + 1
    )
      return retryable(result.status)
        ? "retry"
        : input.toPerson("unsure", "unavailable");
  }
  const managed = {
    claims: [],
    comparisons: [],
    clarifying: answer.action === "clarify",
    grounded: token,
  };
  const ifLatest = { id: latest.id, revision: latest.revision ?? 1 };
  const result = await client.post(
    `/conversations/${job.thread}/${input.writeAs === "reply" ? "messages" : "workflow"}`,
    {
      text: built.text,
      clientId: uuidv7(deps.now()),
      provenance,
      managed,
      ...(input.writeAs === "reply"
        ? { ifLatest }
        : {
            action: "draft",
            ...(input.writeAs === "ask-ai"
              ? { request: job.request }
              : { forMessage: ifLatest }),
          }),
    },
  );
  if (result.status >= 300) {
    if (
      ["stale", "draft-closed", "draft-exists"].includes(
        String(result.body.reason),
      )
    )
      return "skipped";
    return retryable(result.status)
      ? "retry"
      : input.toPerson("unsure", "unavailable");
  }
  if (input.writeAs !== "reply") return "drafted";
  if (partial) {
    job.handoff = answer.handoffReason ?? "unsure";
    saveJob(deps.db, job);
    return handoff(client, job.thread!, job.handoff);
  }
  if (answer.action === "clarify") return "clarified";
  if (answer.action !== "resolve") return "answered";
  const message = result.body.message as Message | undefined;
  if (!message || !/^[1-9][0-9]{0,14}$/.test(message.id)) return "answered";
  job.close = {
    case: state.caseSeq,
    reply: { id: message.id, revision: message.revision ?? 1 },
  };
  saveJob(deps.db, job);
  return closeAnsweredCase(client, job);
}

/** Learns only from the accepted human answer named by a checked room job.
 * Inference starts once; a retry can only finish an already verified write. */
export async function runLearningJob(
  deps: RunnerDeps,
  job: StoredJob,
): Promise<JobOutcome> {
  if (!job.thread || !job.manager || !job.learning?.id ||
    !featureOn(deps.env, undefined, "handoffLearning")) return "skipped";
  const client = deps.roomClient(job.manager);
  const path = `/conversations/${job.thread}/handoff-learning`;
  const current = await client.get(`${path}?id=${job.learning.id}`);
  if (current.status !== 200) return retryable(current.status) ? "retry" : "skipped";
  const learning = current.body.job as HandoffLearningJob | undefined;
  if (!learning || learning.id !== job.learning.id || learning.conversation !== job.thread ||
    Date.parse(learning.expiresAt) <= deps.now() ||
    (HANDOFF_LEARNING_EXCLUDED_REASONS as readonly string[]).includes(learning.reason)) return "skipped";
  const complete = async (result: HandoffLearningResult): Promise<JobOutcome> => {
    const response = await client.post(path, {
      id: learning.id,
      revision: learning.revision,
      result,
      ...(result.entries.length ? { expectedKnowledgeVersion: job.learning!.knowledgeVersion } : {}),
    });
    return response.status < 300
      ? result.entries.length ? "learned" : "skipped"
      : retryable(response.status) ? "retry" : "skipped";
  };
  if (job.learning.result) return complete(job.learning.result);
  // A process interruption after begin never starts inference again.
  if (job.learning.started) return "skipped";
  const read = await readRequest(client, job.thread);
  if (!read.ok) return retryable(read.status) ? "retry" : "skipped";
  const { state, messages } = read;
  if (!state.enabled || !state.onTeam || !state.grant || state.mode === "off" ||
    state.caseSeq !== learning.caseSeq) return "skipped";
  const answerIndex = messages.findIndex((message) =>
    message.id === learning.answer.id && (message.revision ?? 1) === learning.answer.revision);
  if (answerIndex < 0) return "skipped";
  const accepted = messages[answerIndex];
  const members = new Set([state.member ?? "", ...(state.formerMembers ?? [])]);
  if (members.has(accepted.author) || accepted.author === deps.principal) return "skipped";
  const selected = state.prepaid
    ? deps.prepaidModel ? { ...deps, prepaid: true, model: deps.prepaidModel(client) } : null
    : deps;
  if (!selected || callStop(selected)) return "skipped";
  let context: GroundedContext;
  try { context = await groundedContext(deps.db, state.storageGrant, deps.now()); }
  catch { return "skipped"; }
  const input = {
    designatedHumanAnswer: redactForModel(accepted.text).text,
    context: messages.slice(0, answerIndex).filter((message) =>
      Date.parse(message.createdAt) >= Date.parse(learning.requestAt)).map((message) => ({
      role: members.has(message.author) ? "member" : "untrusted-context",
      text: redactForModel(message.text).text,
    })),
    sources: context.hits.map((hit) => ({
      ...hit,
      sourceId: /^kb:(kb-[a-f0-9]{16})-[1-9][0-9]*$/.exec(hit.sourceId)?.[1] ?? hit.sourceId,
    })),
  };
  const serialized = JSON.stringify(input);
  if (new TextEncoder().encode(serialized).length > HANDOFF_LEARNING_LIMITS.inputBytes) return "skipped";
  const begun = await client.post(path, {
    action: "begin",
    id: learning.id,
    revision: learning.revision,
  });
  if (begun.status >= 300) return retryable(begun.status) ? "retry" : "skipped";
  job.learning.started = true;
  saveJob(deps.db, job);
  const discard = async () => {
    job.learning!.result = { entries: [] };
    saveJob(deps.db, job);
    return complete(job.learning!.result);
  };
  const proposed = await meteredCall(selected, HANDOFF_LEARNING_SYSTEM, serialized, [], "other", "handoff-learning");
  if (proposed.kind !== "answer" || !checkedHandoffLearningResult(proposed.value)) return discard();
  if (!proposed.value.entries.length) return discard();
  try {
    checkedLearningEntries(proposed.value.entries);
    for (const entry of proposed.value.entries)
      for (const field of [entry.question, entry.answer, ...entry.conflicts.flatMap((conflict) => [conflict.quote, conflict.reason])])
        if (await detectStoredSecret(field)) return discard();
  } catch { return discard(); }
  const fresh = await client.get(`${path}?id=${job.learning.id}`);
  if (fresh.status !== 200) return discard();
  try {
    if ((await groundedContext(deps.db, state.storageGrant, deps.now())).version !== context.version)
      return discard();
  } catch { return discard(); }
  const verification = await meteredCall(selected, HANDOFF_LEARNING_VERIFY_SYSTEM,
    JSON.stringify({ ...input, proposed: proposed.value }), [], "other", "handoff-learning");
  if (verification.kind !== "answer" || !checkedHandoffLearningResult(verification.value) ||
    JSON.stringify(verification.value) !== JSON.stringify(proposed.value)) return discard();
  try {
    if ((await groundedContext(deps.db, state.storageGrant, deps.now())).version !== context.version)
      return discard();
  } catch { return discard(); }
  job.learning.result = proposed.value;
  job.learning.knowledgeVersion = context.version;
  saveJob(deps.db, job);
  return complete(proposed.value);
}

/** Runs one Ask AI, member-message or human-handoff learning job. */
export async function runJob(
  deps: RunnerDeps,
  job: StoredJob,
): Promise<JobOutcome> {
  if (job.kind === "handoff-learning") return runLearningJob(deps, job);
  if (!job.thread || !job.manager) return "skipped";
  const client = deps.roomClient(job.manager);
  if (job.close) return closeAnsweredCase(client, job);
  if (job.handoff) return handoff(client, job.thread, job.handoff);
  const read = await readRequest(client, job.thread);
  if (!read.ok) return retryable(read.status) ? "retry" : "skipped";
  const { state, messages } = read;
  const paidGrounded =
    state.prepaid === true && state.readinessPolicy === GROUNDED_POLICY;
  if (!state.enabled || !state.onTeam) return "skipped";
  const askAi = job.kind === "ask-ai";
  if (!askAi && (state.handoff || state.stopped || state.state === "resolved"))
    return "skipped";
  if (!state.grant) {
    if (askAi) return decline(client, job.thread, job.request!, "unavailable");
    return "stopped:no-grant";
  }
  const member = new Set([state.member ?? "", ...(state.formerMembers ?? [])]);
  const currentTurn = paidGrounded
    ? groundedMemberTurn(
        messages,
        member,
        state.caseOpenedAt,
        state.caseMemberMessages,
      )
    : null;
  const latest = messages.at(-1);
  const now = deps.now();
  let instruction: string | null = null;
  if (askAi) {
    const detail = await client.get(
      `/conversations/${job.thread}/cases?seq=${state.caseSeq ?? 0}`,
    );
    if (detail.status !== 200)
      return retryable(detail.status) ? "retry" : "skipped";
    const request = (
      (detail.body.requests ?? []) as {
        id: string;
        status: string;
        instruction?: string | null;
      }[]
    ).find((item) => item.id === job.request);
    if (!request || request.status !== "pending") return "skipped";
    instruction = request.instruction
      ? redactForModel(request.instruction).text
      : null;
  } else {
    if (!latest || !member.has(latest.author)) return "skipped";
    if (
      now - job.at > MANAGED_AGENT_LIMITS.handoffDeadlineMs &&
      state.mode === "answers"
    )
      return handoff(client, job.thread, "unsure");
  }
  let paidContext: GroundedContext | null = null;
  const storeSummary = async () => {
    if (!paidGrounded || !latest || !state.caseSeq) return false;
    try {
      const version =
        paidContext?.version ??
        (
          await readKnowledgeContext(deps.db, {
            storageGrant: state.storageGrant,
            now: deps.now(),
          })
        ).version;
      const token = await saveGroundedReceipt(deps.db, {
        context: { version, hits: [] },
        hits: [],
        text: GROUNDED_SUMMARY,
        thread: job.thread!,
        case: state.caseSeq,
        latest: { id: latest.id, revision: latest.revision ?? 1 },
        now: deps.now(),
        approved: false,
        summaryOnly: true,
      });
      const result = await client.post(
        `/conversations/${job.thread}/workflow`,
        {
          action: "draft",
          clientId: uuidv7(deps.now()),
          ...(askAi
            ? { request: job.request }
            : {
                forMessage: { id: latest.id, revision: latest.revision ?? 1 },
              }),
          text: GROUNDED_SUMMARY,
          provenance: {
            reason: "draft",
            sources: [],
            confidence: "low",
            tools: ["source-check"],
            grounding: groundedProvenance(deps.db, token),
          },
          managed: {
            claims: [],
            comparisons: [],
            clarifying: false,
            grounded: token,
          },
        },
      );
      return result.status < 300;
    } catch {
      return false;
    }
  };
  const toPerson = async (
    reason: ManagedHandoffReason,
    decline_: string,
  ): Promise<JobOutcome> => {
    const stored = await storeSummary();
    return askAi
      ? stored
        ? "drafted"
        : decline(client, job.thread!, job.request!, decline_)
      : handoff(client, job.thread!, reason);
  };
  if (currentTurn?.person) {
    await storeSummary();
    return handoff(client, job.thread, "person");
  }
  if (currentTurn?.incomplete) return toPerson("unsure", "unavailable");
  if (state.diagnosisRunning) {
    if (deps.now() - job.at < MANAGED_AGENT_LIMITS.handoffDeadlineMs)
      return "retry";
    return askAi
      ? decline(client, job.thread, job.request!, "unavailable")
      : handoff(client, job.thread, "transaction");
  }
  let guidance;
  try {
    guidance = await readWorkspaceAiGuidance(deps.db, deps.room);
  } catch {
    return toPerson("unsure", "unavailable");
  }
  // Member replies wait as drafts while the golden set hasn't passed on
  // what the agent answers with now.
  let writeAs: "reply" | "suggestion" | "ask-ai" = askAi
    ? "ask-ai"
    : state.mode === "answers"
      ? "reply"
      : "suggestion";
  // Paid replies use their current-source verifier. Historical plans retain their golden gate.
  if (writeAs === "reply" && !paidGrounded) {
    const gate = goldenState(deps.db, await currentFingerprint(deps.db));
    if (gate !== "passed") {
      writeAs = "suggestion";
      if (gate === "pending" && !paidGrounded) queueGolden(deps, now);
    }
  }
  const audience = askAi ? "team" : "member";
  const lastMember = [...messages]
    .reverse()
    .find((message) => member.has(message.author));
  const memberText = redactForModel(
    currentTurn ? currentTurn.text : (lastMember?.text ?? ""),
  ).text;
  const frame = (state.frame ?? null) as Record<string, unknown> | null;
  const addresses = [
    (frame?.product as { address?: string } | undefined)?.address,
  ].filter((value): value is string => typeof value === "string");
  if (paidGrounded) {
    try {
      paidContext = await groundedContext(
        deps.db,
        state.storageGrant,
        deps.now(),
      );
    } catch {
      return toPerson("unsure", "unavailable");
    }
    if (!paidContext.hits.length || !deps.prepaidModel)
      return toPerson("unsure", "unavailable");
  }
  const hits =
    paidContext?.hits ??
    knowledgeHits(
      deps.db,
      `${instruction ?? ""} ${memberText}`,
      audience,
      addresses,
      state.storageGrant,
      deps.now(),
    );
  const metrics = memberSafeMetrics(deps.db, audience);
  if (state.diagnoses?.some((row) => row.needsPerson))
    return toPerson("transaction", "handoff");
  const allEvidence = (askAi ? state.evidence : state.memberEvidence) ?? [];
  const evidenceHighWater = Math.max(
    0,
    ...(state.evidence ?? []).map((row) => row.n),
  );
  const evidence = allEvidence.filter((row) => !row.withdrawn);
  const clarifyingAsked = state.clarifyingAsked ?? 0;
  const callDeps =
    paidGrounded && deps.prepaidModel
      ? { ...deps, prepaid: true, model: deps.prepaidModel(client) }
      : deps;
  const result = await meteredCall(
    callDeps,
    paidGrounded ? GROUNDED_SYSTEM : MANAGED_SYSTEM_PROMPT,
    paidGrounded
      ? JSON.stringify({
          question: memberText,
          teamQuestion: instruction,
          guidance: { ...guidance, text: redactForModel(guidance.text).text },
          messages: promptMessages(
            messages
              .filter(
                (message) =>
                  Date.parse(message.createdAt) >=
                  (state.caseOpenedAt ?? Infinity),
              )
              .slice(-8),
            member,
            deps.principal,
            state.sharedHashes,
          ).map((message) => ({ ...message, text: message.text.slice(-1000) })),
          passages: hits,
          clarifyingAsked,
        })
      : promptUser({
          kind: askAi ? "ask-ai" : "reply",
          instruction,
          guidance: { ...guidance, text: redactForModel(guidance.text).text },
          messages: promptMessages(
            messages,
            member,
            deps.principal,
            state.sharedHashes,
          ),
          frame,
          evidence,
          diagnoses: (state.diagnoses ?? []).map((row) =>
            JSON.parse(
              redactForModel(JSON.stringify(row), {
                evmHashes: state.sharedHashes,
                solanaSignatures: state.sharedHashes,
              }).text,
            ),
          ),
          metrics,
          hits,
          clarifyingAsked,
          needsClarifying: needsClarifying({
            memberStatesNumber: findFigures(memberText).length > 0,
            frame,
          }),
        }),
    state.sharedHashes,
    writeAs === "reply" ? "answer" : "draft",
  );
  if (result.kind === "stopped") {
    if (askAi) await decline(client, job.thread, job.request!, "unavailable");
    return `stopped:${result.stop}`;
  }
  if (result.kind === "refusal") return toPerson("safety", "refused");
  if (result.kind === "failed") return toPerson("unsure", "unavailable");
  let answer: ManagedAnswer;
  try {
    answer = checkedManagedAnswer(result.value, {
      sourceIds: new Set(hits.map((hit) => hit.sourceId)),
    });
  } catch (error) {
    if (error instanceof ManagedAnswerError) return toPerson("unsure", "other");
    throw error;
  }
  if (paidGrounded && paidContext)
    return runGroundedAnswer({
      deps: callDeps,
      client,
      job,
      state,
      latest: latest!,
      answer,
      context: paidContext,
      memberText,
      writeAs,
      toPerson,
      storeSummary,
    });
  if (answer.action === "handoff")
    return toPerson(answer.handoffReason ?? "unsure", "handoff");
  if (await detectStoredSecret(stripCitationMarkers(answer.text).text))
    return toPerson("safety", "refused");
  const refusal = screenTeamText(stripCitationMarkers(answer.text).text);
  if (refusal) {
    await client.post(`/conversations/${job.thread}/safety-refusal`, {
      kind: refusal,
    });
    return toPerson("safety", "refused");
  }
  const built = buildAnswer({
    answer,
    hits,
    evidence: allEvidence,
    evidenceHighWater,
    diagnoses: state.diagnoses,
    metrics,
    memberText,
    frame,
    clarifyingAsked,
    reason: writeAs === "reply" ? "answer" : "draft",
    model: /^[a-z0-9][a-z0-9.-]{0,63}$/.test(result.model)
      ? result.model
      : MANAGED_AGENT_MODEL,
  });
  if ("refuse" in built)
    return toPerson(
      built.refuse,
      built.refuse === "safety" ? "refused" : "unsure",
    );
  // The facts become evidence rows of the case first, so the reply cites
  // rows the team can read.
  if (built.factRows.length) {
    const written = await client.post(`/conversations/${job.thread}/workflow`, {
      action: "evidence",
      case: state.caseSeq,
      clientId: uuidv7(deps.now()),
      rows: built.factRows,
      provenance: built.provenance,
    });
    if (written.status >= 300)
      return retryable(written.status) ? "retry" : toPerson("unsure", "other");
    const rows = (written.body.evidence ?? []) as { n: number }[];
    const first = evidenceHighWater + 1;
    if (rows.length !== built.factRows.length || rows[0]?.n !== first)
      return toPerson("unsure", "other");
  }
  // The room checks the same fields the runner checked. Only a posted
  // clarifying question counts toward the one per request (its provenance
  // reason); a draft that asks one is checked as a question too.
  const managed = {
    claims: built.claims,
    comparisons: answer.comparisons,
    clarifying: answer.action === "clarify",
  };
  const ifLatest = latest
    ? { id: latest.id, revision: latest.revision ?? 1 }
    : undefined;
  const written =
    writeAs === "reply"
      ? await client.post(`/conversations/${job.thread}/messages`, {
          text: built.text,
          clientId: uuidv7(deps.now()),
          provenance: built.provenance,
          ...(ifLatest ? { ifLatest } : {}),
          managed,
        })
      : await client.post(`/conversations/${job.thread}/workflow`, {
          action: "draft",
          clientId: uuidv7(deps.now()),
          ...(writeAs === "ask-ai"
            ? { request: job.request }
            : { forMessage: ifLatest }),
          text: built.text,
          provenance: built.provenance,
          managed,
        });
  if (written.status < 300) {
    if (writeAs !== "reply") return "drafted";
    if (managed.clarifying) return "clarified";
    if (answer.action !== "resolve") return "answered";
    // Held replies return success without a message. They never resolve a case.
    const message = written.body.message as Message | undefined;
    if (!message || !/^[1-9][0-9]{0,14}$/.test(message.id) || !state.caseSeq)
      return "answered";
    job.close = {
      case: state.caseSeq,
      reply: { id: message.id, revision: message.revision ?? 1 },
    };
    saveJob(deps.db, job);
    return closeAnsweredCase(client, job);
  }
  const reason = written.body.reason;
  if (
    reason === "metric-claim-refused" ||
    reason === "clarify-used" ||
    reason === "storage-source-unavailable"
  )
    return toPerson("unsure", "unsure");
  if (
    reason === "stale" ||
    reason === "draft-closed" ||
    reason === "draft-exists"
  )
    return "skipped";
  if (retryable(written.status)) return "retry";
  return "skipped";
}

/* ---------------------------------------------------------------------- */
/* The golden set                                                          */
/* ---------------------------------------------------------------------- */

/** Queues a golden-set run. Never a second one while one waits or runs;
 * otherwise at most hourly unless `force` (a person's "Check again", which
 * the knowledge hook paces). */
export function queueGolden(
  deps: Pick<RunnerDeps, "db">,
  now: number,
  force = false,
) {
  if (goldenJobQueued(deps.db)) return false;
  const queued = goldenQueuedAt(deps.db);
  if (!force && queued !== null && now - queued < GOLDEN_RERUN_MS) return false;
  setGoldenQueued(deps.db, now);
  addJobs(deps.db, [
    {
      id: crypto.randomUUID(),
      kind: "golden",
      thread: null,
      request: null,
      manager: null,
      at: now,
      due: now,
      attempts: 0,
    },
  ]);
  return true;
}

type Partial = { fingerprint: string; results: GoldenResult[] };
const EVAL_ROLE: Record<
  EvalCase["input"]["turns"][number]["role"],
  PromptMessage["role"]
> = {
  member: "member",
  agent: "ai",
  person: "team",
};
/** "e3" is evidence row 3 of the case, as the prompt numbers them. */
const evidenceNumber = (id: string, index: number) => {
  const match = /^e([1-9]\d{0,3})$/.exec(id);
  return match ? Number(match[1]) : index + 1;
};

/** Grades one managed answer to a golden eval case with the reference
 * scorer. [ev:n] cites the case's row `en`; a [fact:k] counts as citing the
 * case rows that hold the fact's amount. */
export function scoreGoldenAnswer(
  c: EvalCase,
  answer: ManagedAnswer,
  allowedHosts: ReadonlySet<string>,
): { score: EvalScore; unsafe: boolean } {
  const factCites = [...answer.text.matchAll(/\[fact:(\d{1,2})\]/g)].flatMap(
    (match) => {
      const fact = answer.facts[Number(match[1]) - 1];
      if (!fact) return [];
      const said = amountsIn(fact.value);
      return c.input.evidence
        .filter((row) =>
          amountsIn(row.value).some((value) =>
            said.some((one) => sameAmount(one, value)),
          ),
        )
        .map((row) => row.id);
    },
  );
  const { text, markers } = stripCitationMarkers(
    answer.text.replace(/ ?\[fact:\d{1,2}\]/g, ""),
  );
  const citations = [
    ...new Set([
      ...markers.flatMap((marker) => marker.ids.map((n) => `e${n}`)),
      ...factCites,
    ]),
  ];
  const action =
    answer.action === "reply" || answer.action === "resolve"
      ? "answer"
      : answer.action;
  const score = scoreEvalOutput(c, {
    action,
    text,
    ...(answer.handoffReason
      ? { handoffReason: answer.handoffReason as SupportHandoffReason }
      : {}),
    citations,
  });
  const unsafe =
    action !== "handoff" && checkAgentReply(text, { allowedHosts }) !== null;
  // A clarifying question may repeat the member's own number, as a live
  // reply may (checks.ts): that number needs no citation.
  if (action === "clarify" && score.items.evidence === "fail") {
    const said = new Set(
      c.input.turns
        .filter((turn) => turn.role === "member")
        .flatMap((turn) => numbersIn(turn.text)),
    );
    if (numbersIn(text).every((number) => said.has(number))) {
      const items = { ...score.items, evidence: "n/a" as const };
      return {
        score: {
          ...score,
          items,
          reasons: score.reasons.filter(
            (reason) => !reason.startsWith("evidence:"),
          ),
          pass: score.actionMatch && !Object.values(items).includes("fail"),
        },
        unsafe,
      };
    }
  }
  return { score, unsafe };
}

/** Answers up to five golden cases on the current fingerprint; the run is
 * recorded (and the gate applied) once every case has a result. The cases
 * are the team's golden eval cases, each with its own turns, frame,
 * evidence and profile entries. */
export async function runGoldenPart(
  deps: RunnerDeps,
): Promise<"more" | "done" | JobOutcome> {
  const cases = goldenCases(deps.db);
  if (!cases.length) {
    clearGoldenPartial(deps.db);
    return "done";
  }
  const guidance = await readWorkspaceAiGuidance(deps.db, deps.room);
  const fingerprint = await currentFingerprint(deps.db);
  const key = fingerprintKey(fingerprint);
  const saved = goldenPartial<Partial>(deps.db);
  const partial: Partial =
    saved?.fingerprint === key ? saved : { fingerprint: key, results: [] };
  const done = new Set(partial.results.map((result) => result.id));
  const metrics = memberSafeMetrics(deps.db, "member");
  const manager = storageAuthorizedManager(deps.db, deps.now());
  const checked = manager
    ? await deps.roomClient(deps.principal).get("/conversations/managed/state")
    : null;
  if (checked && retryable(checked.status)) return "retry";
  const storageGrant =
    checked?.status === 200 ? (checked.body as RoomState).storageGrant : null;
  for (const golden of cases
    .filter((item) => !done.has(item.key))
    .slice(0, GOLDEN_CASES_PER_JOB)) {
    const c = golden.case;
    const memberText = c.input.turns
      .filter((turn) => turn.role === "member")
      .map((turn) => turn.text)
      .join(" ");
    const lastMember =
      [...c.input.turns].reverse().find((turn) => turn.role === "member")
        ?.text ?? "";
    const address = c.input.frame?.product?.address;
    const hits = knowledgeHits(
      deps.db,
      memberText,
      "member",
      address ? [address] : [],
      storageGrant,
      deps.now(),
    );
    const result = await meteredCall(
      deps,
      MANAGED_SYSTEM_PROMPT,
      promptUser({
        kind: "golden",
        instruction: null,
        guidance: { ...guidance, text: redactForModel(guidance.text).text },
        messages: c.input.turns.map((turn, index) => ({
          role: EVAL_ROLE[turn.role],
          text: turn.text,
          at: `turn ${index + 1}`,
        })),
        frame: c.input.frame,
        evidence: c.input.evidence.map((row, index) => ({
          n: evidenceNumber(row.id, index),
          source: row.source,
          sourceLabel: row.label,
          product: { key: row.product ?? "" },
          metric: { key: row.metric ?? "" },
          window: { key: row.window ?? "" },
          value: { text: row.value },
          ...(row.at ? { observed: row.at } : {}),
        })),
        metrics,
        hits,
        profile: c.input.profile,
        clarifyingAsked: 0,
        needsClarifying: needsClarifying({
          memberStatesNumber: findFigures(lastMember).length > 0,
          frame: c.input.frame,
        }),
      }),
    );
    if (result.kind === "stopped") {
      setGoldenPartial(deps.db, partial);
      return `stopped:${result.stop}`;
    }
    let graded: ReturnType<typeof scoreGoldenAnswer> | null = null;
    if (result.kind === "answer")
      try {
        const answer = checkedManagedAnswer(result.value, {
          sourceIds: new Set(hits.map((hit) => hit.sourceId)),
        });
        graded = scoreGoldenAnswer(
          c,
          answer,
          new Set(
            hits
              .map((hit) => hostOf(hit.url))
              .filter((host): host is string => Boolean(host)),
          ),
        );
      } catch {
        graded = null;
      }
    const problems = goldenProblems(
      graded?.score ?? null,
      graded?.unsafe ?? false,
    );
    partial.results.push({
      id: golden.key,
      pass: problems.length === 0,
      problems,
    });
  }
  if (partial.results.length < cases.length) {
    setGoldenPartial(deps.db, partial);
    return "more";
  }
  clearGoldenPartial(deps.db);
  recordGoldenRun(deps.db, {
    fingerprint,
    at: new Date(deps.now()).toISOString(),
    results: cases.map(
      (golden) => partial.results.find((result) => result.id === golden.key)!,
    ),
  });
  return "done";
}

/* ---------------------------------------------------------------------- */
/* The alarm                                                               */
/* ---------------------------------------------------------------------- */

/** Works up to `jobsPerRun` due jobs. Returns what each did. */
export async function runManagedJobs(deps: RunnerDeps): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  for (const { key, job } of dueJobs(
    deps.db,
    deps.now(),
    MANAGED_AGENT_LIMITS.jobsPerRun,
  )) {
    const costConsumers: ((
      outcome: NonNullable<
        import("@templ/chat/workspace-costs").WorkspaceCostEvent["consumerOutcome"]
      >,
    ) => void)[] = [];
    const jobDeps = {
      ...deps,
      onCostAttempt: (consumer: (typeof costConsumers)[number]) =>
        costConsumers.push(consumer),
    };
    let outcome: JobOutcome;
    try {
      if (job.kind === "golden") {
        const part = await runGoldenPart(jobDeps);
        if (part === "more") {
          finishJob(deps.db, key);
          addJobs(deps.db, [
            { ...job, id: crypto.randomUUID(), due: deps.now() + 1_000 },
          ]);
          outcome = "golden";
        } else {
          finishJob(deps.db, key);
          outcome = part === "done" ? "golden" : part;
        }
      } else outcome = await runJob(jobDeps, job);
    } catch {
      outcome = "retry";
    }
    const consumerOutcome = ["answered", "resolved", "clarified"].includes(
      outcome,
    )
      ? "answer"
      : outcome === "drafted" || outcome === "learned"
        ? "draft"
        : outcome === "handed-off"
          ? "handoff"
          : outcome === "retry"
            ? "unresolved"
            : outcome === "declined"
              ? "failed"
              : "discarded";
    for (const consumer of costConsumers) {
      try {
        consumer(consumerOutcome);
      } catch {
        /* Accounting cannot alter a job outcome. */
      }
    }
    if (outcome === "retry") retryJob(deps.db, key, job, deps.now());
    else if (job.kind !== "golden") finishJob(deps.db, key);
    outcomes.push(outcome);
  }
  return outcomes;
}
