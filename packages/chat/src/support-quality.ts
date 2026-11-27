/** Reply labels, the sampled review queue, reported AI answers, trends, the
 * monthly knowledge-gap list and the pilot preset: codes, staff wording,
 * settings and view types.
 *
 * Browser-safe: type imports only, no SDK, storage, RPC or signing. Labels
 * and reviews are team data. Members never read them, and no view here names
 * a member, a wallet or message text. A reported answer carries only the
 * user's optional reason, and only the owner and Admins read it. */
import type { ChatPrincipalId } from "./principal";
import type { SupportHandoffReason } from "./support";

/* Reply labels                                                            */

export const REPLY_LABELS = [
  "correct",
  "wrong-facts",
  "wrong-product",
  "wrong-metric-or-window",
  "unsupported-claim",
  "should-have-handed-off",
  "unsafe",
] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];
export type ReplyProblem = Exclude<ReplyLabel, "correct">;
export const REPLY_PROBLEMS = REPLY_LABELS.filter(
  (label): label is ReplyProblem => label !== "correct",
);
/** Staff wording. */
export const REPLY_LABEL_TEXT: Record<ReplyLabel, string> = {
  correct: "Correct",
  "wrong-facts": "Wrong facts",
  "wrong-product": "Wrong product",
  "wrong-metric-or-window": "Wrong metric or time window",
  "unsupported-claim": "Unsupported claim",
  "should-have-handed-off": "Should have handed off",
  unsafe: "Unsafe",
};

/** `["correct"]` alone, or 1 to 6 distinct problems returned in
 * `REPLY_LABELS` order, or `[]` to clear. Null for anything else. */
export function checkedReplyLabels(value: unknown): ReplyLabel[] | null {
  if (!Array.isArray(value) || value.length > REPLY_PROBLEMS.length)
    return null;
  if (!value.every((item) => REPLY_LABELS.includes(item as ReplyLabel)))
    return null;
  const unique = new Set(value as ReplyLabel[]);
  if (unique.size !== value.length) return null;
  if (unique.has("correct") && unique.size > 1) return null;
  return REPLY_LABELS.filter((label) => unique.has(label));
}

export type ReplyLabelEntry = {
  /** Message id in the thread. */
  message: number;
  /** Never empty in a view. */
  labels: ReplyLabel[];
  /** The author was a registered AI agent when the reply was labeled. */
  bot: boolean;
  /** Always a person on the team. */
  by: ChatPrincipalId;
  at: string;
};

/* Review rubric                                                           */

export const RUBRIC_ITEMS = ["facts", "scope", "evidence", "next-step"] as const;
export type RubricItem = (typeof RUBRIC_ITEMS)[number];
export const RUBRIC_TEXT: Record<RubricItem, { label: string; check: string }> =
  {
    facts: {
      label: "Facts are right",
      check:
        "Every number, token, status and date matches the evidence or the approved answer.",
    },
    scope: {
      label: "Right product, metric and time window",
      check:
        "The answer is about the product, metric and window the user asked about.",
    },
    evidence: {
      label: "Evidence is cited",
      check: "Each number or claim points to a source the team can open.",
    },
    "next-step": {
      label: "The next step is safe",
      check:
        "It asks for no key, phrase, signature or transaction, and hands off when a person has to act.",
    },
  };
export const RUBRIC_SCORES = ["pass", "fail", "n/a"] as const;
export type RubricScore = (typeof RUBRIC_SCORES)[number];
export type Rubric = Record<RubricItem, RubricScore>;

/** All four items with a known score, or null. */
export function checkedRubric(value: unknown): Rubric | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== RUBRIC_ITEMS.length) return null;
  const out = {} as Rubric;
  for (const item of RUBRIC_ITEMS) {
    const score = record[item];
    if (!RUBRIC_SCORES.includes(score as RubricScore)) return null;
    out[item] = score as RubricScore;
  }
  return out;
}

/* Sampling and settings                                                   */

export type SampleRule =
  /** The AI agent answered and no person replied. */
  | { kind: "ai-answered" }
  /** The same, on a request where the member shared a transaction. */
  | { kind: "ai-answered-transaction" }
  | { kind: "handoff"; reason: SupportHandoffReason }
  | { kind: "category"; category: string }
  /** Reopened at least once before it closed. */
  | { kind: "reopened" }
  /** The member answered "Did this solve it?" with no. */
  | { kind: "not-solved" }
  | { kind: "label"; label: ReplyProblem }
  | { kind: "diagnosis-rule"; rule: string };
export type SampleReason = SampleRule | { kind: "random" } | { kind: "manual" };
export const SAMPLE_RULE_KINDS = [
  "ai-answered",
  "ai-answered-transaction",
  "handoff",
  "category",
  "reopened",
  "not-solved",
  "label",
  "diagnosis-rule",
] as const;

export type SupportQualitySettings = {
  schemaVersion: 1;
  sampling: {
    /** Integer 0..100. */
    randomPercent: number;
    /** At most `QUALITY_LIMITS.rules`. */
    rules: SampleRule[];
    /** 1..`QUALITY_LIMITS.weeklyCapMax` samples per ISO week. */
    weeklyCap: number;
    /** People with team authority, at most `QUALITY_LIMITS.reviewers`. */
    reviewers: ChatPrincipalId[];
  };
  requireCategory: boolean;
  /** Registered AI agents may export eval cases and post runs. Manager
   * only. */
  evalAgentAccess: boolean;
};
/** Sampling stays off until a lead turns it on. */
export const DEFAULT_QUALITY_SETTINGS: SupportQualitySettings = Object.freeze({
  schemaVersion: 1,
  sampling: Object.freeze({
    randomPercent: 0,
    rules: [],
    weeklyCap: 25,
    reviewers: [],
  }),
  requireCategory: false,
  evalAgentAccess: false,
}) as SupportQualitySettings;
/** The pilot's sampling. Reviewers stay as they are. */
export const PILOT_QUALITY_PRESET = Object.freeze({
  randomPercent: 10,
  rules: Object.freeze([
    { kind: "ai-answered-transaction" },
    { kind: "label", label: "unsafe" },
    { kind: "not-solved" },
  ]) as readonly SampleRule[],
  weeklyCap: 25,
  requireCategory: true,
});
/** The pilot preset as one set of named defaults: new
 * requests start in AI drafts only for the first week, a shared transaction
 * keeps the AI to drafts, and the quality sampling above. */
export const PILOT_PRESET = Object.freeze({
  /** The workspace default while the preset runs. */
  aiDefault: "drafts" as const,
  /** How long the drafts-only start lasts. */
  draftsDays: 7,
  /** The default the preset lifts to. */
  liftTo: "answers" as const,
  /** Drafts only when the member shares a transaction. */
  aiDraftsForTransactions: true,
  /** The pilot's sampling. */
  quality: PILOT_QUALITY_PRESET,
});
export type PilotPresetView = {
  /** Null when the preset was never applied. */
  appliedAt: string | null;
  /** When the drafts-only start ends. */
  liftAt: string | null;
  liftedAt: string | null;
  liftedBy: "schedule" | "manager" | null;
  /** The drafts-only start is running now. */
  active: boolean;
  aiDraftsForTransactions: boolean;
};

export const QUALITY_LIMITS = {
  labelsPerCase: 50,
  workflowLabelCases: 3,
  rules: 10,
  reviewers: 20,
  weeklyCapMax: 200,
  trendKeys: 20,
  reviewQueueScan: 1_000,
  reviewPage: 50,
  noteChars: 4_000,
  categoryChars: 60,
  diagnosisRuleChars: 64,
  /** Scored or skipped queue rows are dropped after this. */
  queueRetentionDays: 90,
  weekCounterWeeks: 8,
  trendCacheMinutes: 10,
  trendScan: 5_000,
  /** Queued or in review for longer than this is overdue. */
  overdueDays: 7,
  gapGroups: 20,
  gapSamples: 5,
  gapScan: 5_000,
} as const;

/** A canonical principal: an account id or a lowercase EVM address. */
const PRINCIPAL =
  /^(?:account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|0x[0-9a-f]{40})$/;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const shortText = (value: unknown, limit: number): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length >= 1 &&
  value.length <= limit &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(value);

/** One sampling rule in its stored shape, or null. Category names and
 * handoff reasons are checked against the workspace by the caller. */
export function checkedSampleRule(value: unknown): SampleRule | null {
  if (!isPlain(value)) return null;
  const kind = value.kind;
  const keys = Object.keys(value).sort().join();
  switch (kind) {
    case "ai-answered":
    case "ai-answered-transaction":
    case "reopened":
    case "not-solved":
      return keys === "kind" ? { kind } : null;
    case "handoff":
      return keys === "kind,reason" && typeof value.reason === "string"
        ? { kind, reason: value.reason as SupportHandoffReason }
        : null;
    case "category":
      return keys === "category,kind" &&
        shortText(value.category, QUALITY_LIMITS.categoryChars)
        ? { kind, category: value.category }
        : null;
    case "label":
      return keys === "kind,label" &&
        REPLY_PROBLEMS.includes(value.label as ReplyProblem)
        ? { kind, label: value.label as ReplyProblem }
        : null;
    case "diagnosis-rule":
      return keys === "kind,rule" &&
        typeof value.rule === "string" &&
        /^[a-z0-9][a-z0-9.-]{0,63}$/.test(value.rule)
        ? { kind, rule: value.rule }
        : null;
    default:
      return null;
  }
}
const sameRule = (a: SampleRule, b: SampleRule) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A settings body (without `schemaVersion`) or a stored record, checked
 * for shape and limits. Reviewer authority, categories and handoff reasons
 * are the caller's checks against the workspace. */
export function checkedQualitySettings(
  value: unknown,
): SupportQualitySettings | null {
  if (!isPlain(value)) return null;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    return null;
  const sampling = value.sampling;
  if (!isPlain(sampling)) return null;
  const percent = sampling.randomPercent;
  if (!natural(percent) || percent > 100) return null;
  const cap = sampling.weeklyCap;
  if (!Number.isSafeInteger(cap) || (cap as number) < 1) return null;
  if ((cap as number) > QUALITY_LIMITS.weeklyCapMax) return null;
  if (
    !Array.isArray(sampling.rules) ||
    sampling.rules.length > QUALITY_LIMITS.rules
  )
    return null;
  const rules: SampleRule[] = [];
  for (const raw of sampling.rules) {
    const rule = checkedSampleRule(raw);
    if (!rule || rules.some((other) => sameRule(other, rule))) return null;
    rules.push(rule);
  }
  if (
    !Array.isArray(sampling.reviewers) ||
    sampling.reviewers.length > QUALITY_LIMITS.reviewers ||
    !sampling.reviewers.every(
      (id) => typeof id === "string" && PRINCIPAL.test(id),
    ) ||
    new Set(sampling.reviewers).size !== sampling.reviewers.length
  )
    return null;
  if (typeof value.requireCategory !== "boolean") return null;
  if (typeof value.evalAgentAccess !== "boolean") return null;
  return {
    schemaVersion: 1,
    sampling: {
      randomPercent: percent,
      rules,
      weeklyCap: cap as number,
      reviewers: [...(sampling.reviewers as ChatPrincipalId[])],
    },
    requireCategory: value.requireCategory,
    evalAgentAccess: value.evalAgentAccess,
  };
}
export const samplingOn = (settings: SupportQualitySettings) =>
  settings.sampling.randomPercent > 0 || settings.sampling.rules.length > 0;

/* Reviews                                                                 */

export const REVIEW_STATES = ["queued", "in-review", "scored", "skipped"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const REVIEW_SKIP_REASONS = [
  "not-enough-context",
  "duplicate",
  "test",
  "other",
] as const;
export type ReviewSkipReason = (typeof REVIEW_SKIP_REASONS)[number];
export const REVIEW_SKIP_TEXT: Record<ReviewSkipReason, string> = {
  "not-enough-context": "Not enough context",
  duplicate: "Duplicate",
  test: "Test request",
  other: "Other",
};

export type SupportCaseQualityView = {
  thread: string;
  seq: number;
  openedAt: string;
  resolvedAt: string | null;
  labels: ReplyLabelEntry[];
  review: null | {
    reason: SampleReason;
    sampledAt: string;
    reviewer: ChatPrincipalId | null;
    state: ReviewState;
    rubric: Rubric | null;
    scoredBy: ChatPrincipalId | null;
    scoredAt: string | null;
    skip: ReviewSkipReason | null;
    /** The reviewer's note. Team only; never in a member view or export. */
    note: string | null;
  };
  category: string | null;
  /** Only on GET /review: eval copies saved from this request. */
  evals?: { id: string; state: "candidate" | "golden" | "retired" }[];
};
export type SupportReviewItem = {
  thread: string;
  seq: number;
  sampledAt: string;
  reason: SampleReason;
  reviewer: ChatPrincipalId | null;
  state: ReviewState;
  category: string | null;
  openedAt: string;
  overdue: boolean;
};
export type SupportQualityOverview = {
  settings: SupportQualitySettings;
  /** The manager or a support lead. */
  canEdit: boolean;
  counts: { queued: number; mine: number; overdue: number };
  /** When quality tracking began here; null before the first write. */
  since: string | null;
};

/* Reported AI answers                                                     */

/** A user's report that one AI answer didn't help, with an optional reason.
 * The thread's member is its only reporter, so a message has at most one. */
export const ANSWER_REPORT_LIMITS = {
  /** The optional reason, in characters. */
  reasonChars: 280,
  /** Reported answers kept on one case. */
  perCase: 50,
  /** Reports on one page of the list. */
  page: 50,
  /** Index rows one page reads before it hands back a cursor. */
  scan: 200,
  /** Reviewed reports leave the list after this. */
  reviewedDays: 90,
} as const;
export type SupportAnswerReportItem = {
  thread: string;
  seq: number;
  /** The reported AI answer's message id in the thread. */
  message: number;
  reportedAt: string;
  /** The user's own words. Owner and Admins only; never in another view,
   * an export, a copy or an alert. */
  reason: string | null;
  reviewedAt: string | null;
};

/** Staff wording for why a request was sampled. */
export function sampleReasonText(
  reason: SampleReason,
  words: {
    handoff?: (reason: SupportHandoffReason) => string;
  } = {},
): string {
  switch (reason.kind) {
    case "random":
      return "Random sample";
    case "manual":
      return "Picked by a lead";
    case "ai-answered":
      return "The AI agent answered alone";
    case "ai-answered-transaction":
      return "The AI agent answered a transaction question";
    case "handoff":
      return `Handed off: ${words.handoff?.(reason.reason) ?? reason.reason}`;
    case "category":
      return `Category: ${reason.category}`;
    case "reopened":
      return "Reopened";
    case "not-solved":
      return "The user said it wasn't solved";
    case "label":
      return `Labeled ${REPLY_LABEL_TEXT[reason.label]}`;
    case "diagnosis-rule":
      return `Check result: ${reason.rule}`;
  }
}

/* Trends                                                                  */

export const TREND_DIMENSIONS = [
  "category",
  "tag",
  "handoff",
  "label",
  "rubric",
  "diagnosis-rule",
  "action-type",
  "resolved-by",
  "confirmation",
] as const;
export type TrendDimension = (typeof TREND_DIMENSIONS)[number];
export const TREND_WINDOWS = ["30d", "90d", "180d"] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
export const TREND_WINDOW_DAYS: Record<TrendWindow, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
};
export type TrendRow = {
  key: string;
  total: number;
  /** One count per week in `SupportTrends.weeks`. */
  weeks: number[];
  /** Last complete week minus the week before; null with fewer than two
   * complete weeks. */
  change: number | null;
};
export type SupportTrends = {
  schemaVersion: 1;
  window: TrendWindow;
  from: string;
  to: string;
  /** The Monday (UTC) of each week, oldest first. */
  weeks: string[];
  since: string | null;
  dimensions: Record<TrendDimension, TrendRow[]>;
  cases: number;
  uncategorized: number;
  excluded: number;
  truncated: boolean;
  /** The case ledger is ready in this workspace. */
  complete: boolean;
  computedAt: string;
};
export const TREND_DIMENSION_TEXT: Record<TrendDimension, string> = {
  category: "Category",
  tag: "Tag",
  handoff: "Handed to a person",
  label: "Reply problems",
  rubric: "Failed review items",
  "diagnosis-rule": "Check results",
  "action-type": "Action types",
  "resolved-by": "Resolved by",
  confirmation: "User's answer",
};

/** Monday 00:00 UTC of the week holding `at`, as a date string. */
export function weekStart(at: number): string {
  const day = new Date(at);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - offset),
  )
    .toISOString()
    .slice(0, 10);
}
/** ISO week label ("2026-W40") for the weekly sampling cap. */
export function isoWeek(at: number): string {
  const date = new Date(at);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3),
  );
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week =
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/* Knowledge-gap list                                                      */

/** Why a closed request counts toward a gap. */
export const GAP_SIGNALS = [
  "should-have-handed-off",
  "unsupported-claim",
  "wrong-facts",
  "wrong-product",
  "wrong-metric-or-window",
  "rubric-evidence",
  "rubric-scope",
  "handoff-unsure",
] as const;
export type GapSignal = (typeof GAP_SIGNALS)[number];
export const GAP_SIGNAL_TEXT: Record<GapSignal, string> = {
  "should-have-handed-off": "Should have handed off",
  "unsupported-claim": "Unsupported claim",
  "wrong-facts": "Wrong facts",
  "wrong-product": "Wrong product",
  "wrong-metric-or-window": "Wrong metric or time window",
  "rubric-evidence": "Review: evidence missing",
  "rubric-scope": "Review: wrong product, metric or window",
  "handoff-unsure": "The AI agent wasn't sure",
};
export const GAP_STATES = ["open", "docs-updated", "not-a-gap"] as const;
export type GapState = (typeof GAP_STATES)[number];
export type KnowledgeGapGroup = {
  /** Stable within the month: category and product. */
  id: string;
  category: string | null;
  /** The case frame's product key, when the team set one. */
  product: string | null;
  cases: number;
  signals: Partial<Record<GapSignal, number>>;
  /** Up to five requests; opening one checks access again. */
  samples: { thread: string; seq: number }[];
  state: GapState;
  /** Set with "Docs updated". */
  updatedOn: string | null;
};
export type SupportKnowledgeGaps = {
  schemaVersion: 1;
  /** YYYY-MM (UTC). */
  month: string;
  groups: KnowledgeGapGroup[];
  /** Closed requests read for the month. */
  cases: number;
  truncated: boolean;
  computedAt: string;
};
