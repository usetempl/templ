/** Managed AI: the AI agent Templ runs for a workspace on the Anthropic API.
 *
 * The managed agent is one account per workspace that the workspace adds
 * to its team as an AI agent. It answers the way a registered agent would,
 * through the same routes and checks, and it honors each request's AI mode:
 * "answers" posts replies, "drafts" writes drafts for the team and never
 * posts, "off" hides the request from it. Ask AI questions reach it at once;
 * nothing polls.
 *
 * It runs only while all of these hold: the workspace turned it on, the
 * workspace holds a current managed-agent grant, Templ's kill switch is on,
 * and both monthly spend caps (the workspace's and Templ's) have room for
 * the call. Otherwise it makes no model call: Ask AI questions are declined
 * as unavailable and member messages wait for a person.
 *
 * Pure types, limits and checks with no I/O. Chat text is untrusted input:
 * nothing here can sign, send a transaction or ask for a key. */
import { checkedMetricClaim, type MetricClaim } from "./metric-keys";
import type { GoldenGateState } from "./golden-set";

/** The model every managed call uses. A change is a new golden-set
 * fingerprint. */
export const MANAGED_AGENT_MODEL = "claude-opus-5";
/** Bump with any change to the system prompt, the user turn's fixed text
 * or the answer schema. */
export const MANAGED_AGENT_PROMPT_VERSION = "managed-prompt-5";
/** SHA-256 of that prompt material (`managedPromptMaterial` in the worker).
 * A test pins it to the source, so an edit fails until both move together;
 * the golden fingerprint and the release gate carry it. */
export const MANAGED_AGENT_PROMPT_SHA256 =
  "2632e625a72dbeedd461adedf3b609bb2646ce7da1ddcb2526c547e1ae752db5";
/** The fingerprint's prompt part: the version and the first 16 hex of the
 * material's hash. */
export const managedPromptId = (sha256: string) =>
  `${MANAGED_AGENT_PROMPT_VERSION}:${sha256.slice(0, 16)}`;

export const MANAGED_AGENT_LIMITS = {
  /** A member message the agent has not answered by then goes to a person. */
  handoffDeadlineMs: 90_000,
  /** One model call's time limit. */
  callTimeoutMs: 60_000,
  maxOutputTokens: 8_000,
  /** Knowledge hits one answer reads. */
  knowledgeHits: 8,
  /** Latest messages of the thread one answer reads. */
  messagesRead: 30,
  /** Characters of one message the model reads. */
  messageChars: 2_000,
  /** Jobs one run of the knowledge object's alarm works on. */
  jobsPerRun: 3,
  /** Jobs waiting for one workspace; more are dropped oldest first. */
  jobsQueued: 50,
  /** Tries of one job before it is dropped. */
  jobAttempts: 3,
  /** Clarifying questions per member request. */
  clarifyingPerCase: 1,
  /** Evidence rows one answer may add. */
  factsPerAnswer: 5,
  replyBytes: 3_500,
  summaryBytes: 500,
  /** US cents held for one call before it runs; the real cost is settled
   * after it answers. Covers the output cap at the output price plus a full
   * prompt. */
  reserveCentsPerCall: 40,
} as const;

/** US cents per million tokens for MANAGED_AGENT_MODEL. A fallback model
 * the API picks on a refusal is billed at its own rates; the ones it uses
 * cost the same or less. */
export const MANAGED_AGENT_PRICES = {
  input: 500,
  output: 2_500,
  cacheWrite: 625,
  cacheRead: 50,
} as const;
export type ManagedUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
const tokens = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
/** The cost of one call in whole US cents, rounded up. */
export function managedCallCents(usage: ManagedUsage | null | undefined) {
  if (!usage) return 0;
  const micro =
    tokens(usage.input_tokens) * MANAGED_AGENT_PRICES.input +
    tokens(usage.output_tokens) * MANAGED_AGENT_PRICES.output +
    tokens(usage.cache_creation_input_tokens) * MANAGED_AGENT_PRICES.cacheWrite +
    tokens(usage.cache_read_input_tokens) * MANAGED_AGENT_PRICES.cacheRead;
  return Math.ceil(micro / 1_000_000);
}

/** Why the managed agent makes no model call now. */
export const MANAGED_AGENT_STOPS = [
  "off",
  "not-on-team",
  "no-grant",
  "kill-switch",
  "no-key",
  "no-budget",
  "workspace-cap",
  "templ-cap",
] as const;
export type ManagedAgentStop = (typeof MANAGED_AGENT_STOPS)[number];
export type ManagedAgentState = "ready" | ManagedAgentStop;

/** What the manager stores. */
export type ManagedAgentSettings = {
  enabled: boolean;
  updatedAt: string | null;
};
/** The settings section's read. */
export type ManagedAgentView = {
  /** The account the agent answers as; the team adds it as an AI agent. */
  principal: string;
  settings: ManagedAgentSettings;
  state: ManagedAgentState;
  onTeam: boolean;
  grant: { active: boolean; endsAt: string | null };
  spend: {
    month: string;
    usedCents: number;
    /** 0 means no calls this month. */
    capCents: number;
  };
  golden: {
    state: GoldenGateState;
    cases: number;
    lastRunAt: string | null;
    regressions: string[];
    failing: string[];
  };
  model: string;
};

export const MANAGED_JOB_KINDS = ["ask-ai", "member-message", "handoff-learning", "golden"] as const;
export type ManagedJobKind = (typeof MANAGED_JOB_KINDS)[number];

/* ---------------------------------------------------------------------- */
/* The model's answer                                                      */
/* ---------------------------------------------------------------------- */

export const MANAGED_ANSWER_ACTIONS = ["reply", "resolve", "clarify", "handoff"] as const;
export type ManagedAnswerAction = (typeof MANAGED_ANSWER_ACTIONS)[number];
/** Handoff reasons the model may give; the room's list, less the ones only
 * people use. */
export const MANAGED_HANDOFF_REASONS = [
  "quote",
  "privacy",
  "account",
  "billing",
  "legal",
  "safety",
  "transaction",
  "bug",
  "person",
  "unsure",
  "strategy",
  "access",
  "recovery",
  "decision",
  "internal",
] as const;
export type ManagedHandoffReason = (typeof MANAGED_HANDOFF_REASONS)[number];

/** A fact the model read in one knowledge source, to be written as an
 * evidence row and cited as [fact:k] in the text. */
export type ManagedFact = {
  source: string;
  product: string;
  metric: string;
  window: string;
  value: string;
  number: string | null;
  unit: string | null;
};
export type ManagedAnswer = {
  action: ManagedAnswerAction;
  /** Resolve sends a real answer, then asks the member whether it solved the case.
   * The reply, the clarifying question or empty for a handoff. Figures
   * cite [ev:n], [dx:id] or [fact:k]. */
  text: string;
  /** Knowledge source ids the answer used. */
  sources: string[];
  facts: ManagedFact[];
  claims: MetricClaim[];
  /** Pairs of claim indexes the text compares. */
  comparisons: [number, number][];
  handoffReason: ManagedHandoffReason | null;
  confidence: "high" | "medium" | "low";
  /** Staff only: why it answered this way. */
  summary: string;
};

const TAG = { type: "string" } as const;
/** The JSON schema the Messages API constrains the answer to
 * (`output_config.format`). Limits the schema can't express are checked by
 * `checkedManagedAnswer`. */
export const MANAGED_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "text",
    "sources",
    "facts",
    "claims",
    "comparisons",
    "handoffReason",
    "confidence",
    "summary",
  ],
  properties: {
    action: { type: "string", enum: [...MANAGED_ANSWER_ACTIONS] },
    text: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "product", "metric", "window", "value", "number", "unit"],
        properties: {
          source: TAG,
          product: TAG,
          metric: TAG,
          window: TAG,
          value: TAG,
          number: { anyOf: [{ type: "string" }, { type: "null" }] },
          unit: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "product", "window", "value", "evidence"],
        properties: {
          metric: TAG,
          product: TAG,
          window: TAG,
          value: TAG,
          evidence: { type: "array", items: { type: "integer" } },
        },
      },
    },
    comparisons: {
      type: "array",
      items: { type: "array", items: { type: "integer" } },
    },
    handoffReason: {
      anyOf: [
        { type: "string", enum: [...MANAGED_HANDOFF_REASONS] },
        { type: "null" },
      ],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string" },
  },
} as const;

export class ManagedAnswerError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ManagedAnswerError";
  }
}
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;
const KEY = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;
const FACT_MARKER = /\[fact:(\d{1,2})\]/g;

/** The model's answer, checked against what it was given: every source id
 * must be one of `sourceIds`, every fact must name one of them and be cited,
 * every [fact:k] must name a fact. Throws ManagedAnswerError otherwise. */
export function checkedManagedAnswer(
  raw: unknown,
  input: { sourceIds: ReadonlySet<string> },
): ManagedAnswer {
  const fail = (reason: string): never => {
    throw new ManagedAnswerError(reason);
  };
  if (!isPlain(raw)) fail("not-an-object");
  const value = raw as Record<string, unknown>;
  if (!MANAGED_ANSWER_ACTIONS.includes(value.action as ManagedAnswerAction))
    fail("action");
  const action = value.action as ManagedAnswerAction;
  if (typeof value.text !== "string") fail("text");
  const text = (value.text as string).trim();
  if (action !== "handoff" && !text) fail("empty-text");
  if (bytes(text) > MANAGED_AGENT_LIMITS.replyBytes) fail("text-too-long");
  if (!Array.isArray(value.sources) || value.sources.length > 8) fail("sources");
  const sources = [...new Set(value.sources as unknown[])];
  for (const id of sources)
    if (typeof id !== "string" || !input.sourceIds.has(id)) fail("unknown-source");
  if (!Array.isArray(value.facts) || value.facts.length > MANAGED_AGENT_LIMITS.factsPerAnswer)
    fail("facts");
  const facts: ManagedFact[] = (value.facts as unknown[]).map((item) => {
    if (!isPlain(item)) return fail("fact");
    const fact = item as Record<string, unknown>;
    if (typeof fact.source !== "string" || !input.sourceIds.has(fact.source))
      fail("fact-source");
    for (const key of ["product", "metric", "window"] as const)
      if (typeof fact[key] !== "string" || !KEY.test(fact[key] as string))
        fail("fact-tag");
    if (typeof fact.value !== "string" || !fact.value.trim() || fact.value.length > 64)
      fail("fact-value");
    const optional = (field: unknown, max: number) =>
      field === null
        ? null
        : typeof field === "string" && field.trim() && field.length <= max
          ? field.trim()
          : fail("fact-field");
    return {
      source: fact.source as string,
      product: fact.product as string,
      metric: fact.metric as string,
      window: fact.window as string,
      value: (fact.value as string).trim(),
      number: optional(fact.number, 40),
      unit: optional(fact.unit, 16),
    };
  });
  for (const marker of text.matchAll(FACT_MARKER)) {
    const k = Number(marker[1]);
    if (k < 1 || k > facts.length) fail("unknown-fact");
  }
  if (!Array.isArray(value.claims)) fail("claims");
  const claims = (value.claims as unknown[]).map(
    (claim) => checkedMetricClaim(claim) ?? fail("claim"),
  );
  if (!Array.isArray(value.comparisons)) fail("comparisons");
  const comparisons = (value.comparisons as unknown[]).map((pair) =>
    Array.isArray(pair) &&
    pair.length === 2 &&
    pair.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
      ? ([pair[0], pair[1]] as [number, number])
      : fail("comparison"),
  );
  const handoffReason =
    value.handoffReason === null
      ? null
      : MANAGED_HANDOFF_REASONS.includes(value.handoffReason as ManagedHandoffReason)
        ? (value.handoffReason as ManagedHandoffReason)
        : fail("handoff-reason");
  if (action === "handoff" && !handoffReason) fail("handoff-reason");
  if (!["high", "medium", "low"].includes(value.confidence as string)) fail("confidence");
  if (action === "resolve" && (value.confidence !== "high" || handoffReason !== null))
    fail("resolve-confidence");
  if (typeof value.summary !== "string" || bytes(value.summary) > MANAGED_AGENT_LIMITS.summaryBytes)
    fail("summary");
  return {
    action,
    text,
    sources: sources as string[],
    facts,
    claims,
    comparisons,
    handoffReason,
    confidence: value.confidence as ManagedAnswer["confidence"],
    summary: (value.summary as string).trim(),
  };
}

/** Replaces [fact:k] with [ev:n] once the facts are evidence rows. */
export function citeFacts(text: string, rows: ReadonlyMap<number, number>) {
  return text.replace(FACT_MARKER, (marker, k: string) => {
    const n = rows.get(Number(k));
    return n === undefined ? marker : `[ev:${n}]`;
  });
}
/** Whether a text still holds a [fact:k] marker. */
export const hasFactMarkers = (text: string) => /\[fact:\d{1,2}\]/.test(text);

/** Whether a member message states a number with no frame to place it: the
 * case frame lacks a product, a metric or a window. The managed agent then
 * asks one clarifying question before it answers with figures. */
export function needsClarifying(input: {
  memberStatesNumber: boolean;
  frame: { product?: unknown; metric?: unknown; window?: unknown } | null;
}) {
  if (!input.memberStatesNumber) return false;
  const frame = input.frame;
  return !frame?.product || !frame.metric || !frame.window;
}

/** The month a spend counter belongs to, UTC. */
export const spendMonth = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Staff-facing words for each state of the settings section. */
export const MANAGED_AGENT_STATE_TEXT: Record<ManagedAgentState, string> = {
  ready: "Managed AI is answering.",
  off: "Managed AI is off.",
  "not-on-team": "Add the managed AI account to your team as an AI agent.",
  "no-grant": "Managed AI isn't set up for this workspace.",
  "kill-switch": "Templ has paused managed AI.",
  "no-key": "Templ has paused managed AI.",
  "no-budget": "No managed AI budget this month.",
  "workspace-cap": "This month's managed AI budget is used up.",
  "templ-cap": "Templ has paused managed AI for the rest of the month.",
};
