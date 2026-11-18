/** Answer quality in the room: reply labels, the sampled review queue,
 * trends, the monthly knowledge-gap list and the required category.
 *
 * Everything attaches to a case: one quality record per request
 * (`support-case-quality-v1:<tc>:<seq>`), beside the case ledger, deleted
 * with its case. Labels and reviews are human judgments by people on the
 * team; registered AI agents read labels and get 403 on writes. Nothing
 * here reaches a member, a member export, a realtime event or an alert, and
 * no view ranks or names staff by their labels.
 *
 * Sampling runs where the team reads the queue: a closed request is
 * sampled once, a "not solved" answer or a label can sample a request the
 * first pass left out, and a weekly cap bounds the work. Sampling never
 * blocks a member's write. */
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { SUPPORT_HANDOFF_REASONS, type SupportCase } from "@templ/chat/support";
import {
  DEFAULT_QUALITY_SETTINGS,
  GAP_SIGNALS,
  QUALITY_LIMITS,
  REVIEW_SKIP_REASONS,
  REVIEW_STATES,
  RUBRIC_ITEMS,
  TREND_DIMENSIONS,
  TREND_WINDOWS,
  TREND_WINDOW_DAYS,
  checkedQualitySettings,
  checkedReplyLabels,
  checkedRubric,
  checkedSampleRule,
  isoWeek,
  samplingOn,
  weekStart,
  type GapSignal,
  type GapState,
  type KnowledgeGapGroup,
  type ReplyLabel,
  type ReplyLabelEntry,
  type ReviewSkipReason,
  type ReviewState,
  type Rubric,
  type SampleReason,
  type SampleRule,
  type SupportCaseQualityView,
  type SupportKnowledgeGaps,
  type SupportQualityOverview,
  type SupportQualitySettings,
  type SupportReviewItem,
  type SupportTrends,
  type TrendDimension,
  type TrendRow,
  type TrendWindow,
} from "@templ/chat/support-quality";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { HttpError } from "./common";
import { readMessage } from "./message-store";
import { refusePhrase } from "./secret-guard";
import {
  readCase,
  readCasesOpened,
  readThreadCases,
  type CaseRead,
} from "./support-case-data";
import { ledgerState } from "./support-cases";
import { readCaseFrame } from "./support-evidence-store";
import type { CaseActivityAction } from "./support-drafts";
import {
  recordSupportActivity,
  supportRecord,
  supportSettings,
} from "./support-workflow";
import {
  conversationAuthority,
  readConversation,
  type ConversationContext,
  type TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
export const QUALITY_PREFIX = "support-case-quality-v1:";
export const REVIEW_QUEUE_PREFIX = "support-review-queue-v1:";
export const REVIEW_WEEK_PREFIX = "support-review-week-v1:";
export const REVIEW_RR_KEY = "support-review-rr-v1";
export const QUALITY_SETTINGS_KEY = "support-quality-settings-v1";
export const QUALITY_MARKER_KEY = "support-quality-marker-v1";
export const TRENDS_CACHE_PREFIX = "support-trends-cache-v1:";
export const SAMPLE_SCAN_KEY = "support-quality-scan-v1";
export const GAPS_PREFIX = "support-gaps-v1:";
const THREAD = /^tc-[0-9a-f]{32}$/;
const DAY = 86_400_000;
const pad8 = (value: number) => String(value).padStart(8, "0");
const pad16 = (value: number) => String(value).padStart(16, "0");
const iso = (value: number) => new Date(value).toISOString();
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export const qualityKey = (thread: string, seq: number) =>
  `${QUALITY_PREFIX}${thread}:${pad8(seq)}`;
const queueKey = (sampledAt: number, thread: string, seq: number) =>
  `${REVIEW_QUEUE_PREFIX}${pad16(sampledAt)}:${thread}:${pad8(seq)}`;
const QUEUE_KEY =
  /^support-review-queue-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9]{8})$/;

/* ---------------------------------------------------------------------- */
/* Who is asking                                                           */
/* ---------------------------------------------------------------------- */

export type QualityViewer = {
  principal: ChatPrincipalId;
  team: boolean;
  bot: boolean;
  manager: boolean;
  /** The manager or a support lead (`manageSupport`), never a bot. */
  lead: boolean;
  admin: boolean;
};
/** The viewer's current authority from the session the room verified.
 * Members, billing-only holders, revoked staff and outsiders are not on
 * the team: every route here answers them 404. */
export function qualityViewer(
  context: Pick<ConversationContext, "viewer" | "isBot">,
): QualityViewer | null {
  const principal = context.viewer.principalId;
  if (!principal) return null;
  const team = conversationAuthority(context.viewer).team;
  if (!team) return null;
  const bot = Boolean(context.isBot);
  const manager = Boolean(context.viewer.isManager) && !bot;
  const lead =
    !bot &&
    (manager || context.viewer.permissions.map(String).includes("manageSupport"));
  return { principal, team, bot, manager, lead, admin: canManageWorkspace(context.viewer, bot) };
}
export const toolsNotFound = () =>
  new HttpError(404, "Support tools not found.");
export const peopleOnly = (text = "Only people on the team can do this.") =>
  new HttpError(403, text, undefined, "people-only");
export const leadOnly = () =>
  new HttpError(
    403,
    "Only the manager or a support lead can do this.",
    undefined,
    "lead-only",
  );

/* ---------------------------------------------------------------------- */
/* The quality record                                                      */
/* ---------------------------------------------------------------------- */

type StoredLabel = {
  message: number;
  labels: ReplyLabel[];
  bot: boolean;
  by: ChatPrincipalId;
  at: number;
};
export type StoredCaseQuality = {
  schemaVersion: 1;
  thread: string;
  seq: number;
  source: "live" | "repaired";
  labels: StoredLabel[];
  sampleDecision: null | {
    at: number;
    result: "sampled" | "not-sampled" | "capped";
  };
  review: null | {
    reason: SampleReason;
    sampledAt: number;
    reviewer: ChatPrincipalId | null;
    state: ReviewState;
    rubric: Rubric | null;
    by: ChatPrincipalId | null;
    at: number | null;
    skip: ReviewSkipReason | null;
    note: string | null;
  };
  facets: {
    category: string | null;
    categorySetAt: number | null;
    tags: string[];
    closedAt: number | null;
    diagnosisRules: string[];
    diagnosisRatings: {
      diagnosis: string;
      rating: "correct" | "incomplete" | "wrong";
      at: number;
    }[];
    actionTypes: string[];
  };
};
const principalOk = (value: unknown): value is ChatPrincipalId =>
  typeof value === "string" && normalizeChatPrincipal(value) === value;
function checkedReason(value: unknown): SampleReason | null {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "random" || kind === "manual")
    return Object.keys(value as object).length === 1 ? { kind } : null;
  return checkedSampleRule(value);
}
const stringList = (value: unknown, max: number, chars: number) =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length <= chars);

/** A stored record, or null when anything fails its checks. A rejected
 * record is never shown, exported or counted, and the next staff write
 * replaces it with a repaired one. */
export function checkedQuality(
  raw: unknown,
  thread: string,
  seq: number,
): StoredCaseQuality | null {
  const q = raw as StoredCaseQuality | undefined;
  if (!q || typeof q !== "object" || q.schemaVersion !== 1) return null;
  if (q.thread !== thread || q.seq !== seq) return null;
  if (q.source !== "live" && q.source !== "repaired") return null;
  if (!Array.isArray(q.labels) || q.labels.length > QUALITY_LIMITS.labelsPerCase)
    return null;
  for (const label of q.labels) {
    if (!label || !natural(label.message) || label.message < 1) return null;
    const codes = checkedReplyLabels(label.labels);
    if (!codes || !codes.length || codes.join() !== label.labels.join()) return null;
    if (typeof label.bot !== "boolean" || !principalOk(label.by) || !natural(label.at))
      return null;
  }
  if (q.sampleDecision !== null) {
    if (
      !q.sampleDecision ||
      !natural(q.sampleDecision.at) ||
      !["sampled", "not-sampled", "capped"].includes(q.sampleDecision.result)
    )
      return null;
  }
  if (q.review !== null) {
    const r = q.review;
    if (!r || !checkedReason(r.reason) || !natural(r.sampledAt)) return null;
    if (r.reviewer !== null && !principalOk(r.reviewer)) return null;
    if (!REVIEW_STATES.includes(r.state)) return null;
    if (r.rubric !== null && !checkedRubric(r.rubric)) return null;
    if (r.by !== null && !principalOk(r.by)) return null;
    if (r.at !== null && !natural(r.at)) return null;
    if (r.skip !== null && !REVIEW_SKIP_REASONS.includes(r.skip)) return null;
    if (
      r.note !== null &&
      (typeof r.note !== "string" ||
        new TextEncoder().encode(r.note).length > QUALITY_LIMITS.noteChars)
    )
      return null;
  }
  const f = q.facets;
  if (!f || typeof f !== "object") return null;
  if (f.category !== null && (typeof f.category !== "string" || f.category.length > 60))
    return null;
  if (f.categorySetAt !== null && !natural(f.categorySetAt)) return null;
  if (f.closedAt !== null && !natural(f.closedAt)) return null;
  if (!stringList(f.tags, 10, 40)) return null;
  if (!stringList(f.diagnosisRules, 16, 64)) return null;
  if (!stringList(f.actionTypes, 8, 40)) return null;
  if (!Array.isArray(f.diagnosisRatings) || f.diagnosisRatings.length > 8) return null;
  return q;
}
export async function readQuality(
  storage: Pick<Storage, "get">,
  thread: string,
  seq: number,
): Promise<StoredCaseQuality | null> {
  return checkedQuality(await storage.get(qualityKey(thread, seq)), thread, seq);
}
function freshQuality(
  thread: string,
  seq: number,
  source: StoredCaseQuality["source"],
): StoredCaseQuality {
  return {
    schemaVersion: 1,
    thread,
    seq,
    source,
    labels: [],
    sampleDecision: null,
    review: null,
    facets: {
      category: null,
      categorySetAt: null,
      tags: [],
      closedAt: null,
      diagnosisRules: [],
      diagnosisRatings: [],
      actionTypes: [],
    },
  };
}
/** The record to change: the stored one, or a fresh one (repaired when the
 * stored one was unreadable). */
async function writableQuality(
  storage: Storage,
  thread: string,
  seq: number,
  now: number,
): Promise<StoredCaseQuality> {
  const raw = await storage.get(qualityKey(thread, seq));
  const q = checkedQuality(raw, thread, seq);
  if (q) return q;
  if (raw !== undefined)
    console.warn("TEMPL_SUPPORT_QUALITY_REPAIRED", { thread, seq });
  if ((await storage.get(QUALITY_MARKER_KEY)) === undefined)
    await storage.put(QUALITY_MARKER_KEY, { schemaVersion: 1, startedAt: now });
  return freshQuality(thread, seq, raw === undefined ? "live" : "repaired");
}
export async function writeQuality(storage: Storage, q: StoredCaseQuality) {
  await storage.put(qualityKey(q.thread, q.seq), q);
}
/** Deletes a case's quality record and its queue row (case prune). */
export async function deleteCaseQuality(
  storage: Storage,
  thread: string,
  seq: number,
  budget: number,
): Promise<number> {
  if (budget <= 0) return 0;
  const q = await readQuality(storage, thread, seq);
  let deleted = 0;
  if (q?.review) {
    if (await storage.delete(queueKey(q.review.sampledAt, thread, seq))) deleted++;
    if (deleted >= budget) return deleted;
  }
  if (await storage.delete(qualityKey(thread, seq))) deleted++;
  return deleted;
}

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

export async function qualitySettings(
  storage: Pick<Storage, "get">,
): Promise<SupportQualitySettings> {
  const stored = checkedQualitySettings(await storage.get(QUALITY_SETTINGS_KEY));
  return stored ?? structuredClone(DEFAULT_QUALITY_SETTINGS);
}
/** Checks a settings body against the workspace: rules name configured
 * categories and known handoff reasons; reviewers are current people with
 * team authority. */
export async function checkedSettingsBody(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "isSupportStaff" | "bots">,
  body: unknown,
): Promise<SupportQualitySettings> {
  const settings = checkedQualitySettings(body);
  if (!settings)
    throw new HttpError(
      400,
      "Check the sampling percent, rules, weekly cap and reviewers.",
      undefined,
      "quality-settings",
    );
  const { categories } = await supportSettings(storage);
  for (const rule of settings.sampling.rules) {
    if (rule.kind === "category" && !categories.includes(rule.category))
      throw new HttpError(400, "Choose a configured case category.", undefined, "quality-settings");
    if (
      rule.kind === "handoff" &&
      !(SUPPORT_HANDOFF_REASONS as readonly string[]).includes(rule.reason)
    )
      throw new HttpError(400, "Choose a handoff reason.", undefined, "quality-settings");
  }
  for (const reviewer of settings.sampling.reviewers)
    if (
      (context.bots ?? []).includes(reviewer) ||
      !(await context.isSupportStaff?.(reviewer))
    )
      throw new HttpError(400, "Choose a current support staff account.", undefined, "quality-settings");
  return settings;
}

/* ---------------------------------------------------------------------- */
/* Labels                                                                  */
/* ---------------------------------------------------------------------- */

/** The request a team reply belongs to: the newest case opened before it.
 * A reply after a close and before the next request belongs to the closed
 * one. */
export async function caseForMessage(
  storage: Storage,
  record: TeamConversationRecord,
  messageId: number,
): Promise<{ read: CaseRead; author: string; createdAt: number }> {
  const row = await readMessage(storage, record.id, messageId);
  if (!row)
    throw new HttpError(404, "Reply not found.", undefined, "reply-not-found");
  if (row.author === record.member || record.formerMembers?.includes(row.author as ChatPrincipalId))
    throw new HttpError(400, "Label replies from your team only.", undefined, "label-member-message");
  const createdAt = Date.parse(row.createdAt);
  const cases = await readThreadCases(storage, record.id as `tc-${string}`, { limit: 100 });
  const read = cases.find((entry) => entry.case.openedAt <= createdAt);
  if (!read || read.case.excluded.includes("canary"))
    throw new HttpError(
      409,
      "This reply isn't part of a case, so it can't be labeled.",
      undefined,
      "label-no-case",
    );
  return { read, author: row.author, createdAt };
}
function labelEntry(label: StoredLabel): ReplyLabelEntry {
  return { message: label.message, labels: label.labels, bot: label.bot, by: label.by, at: iso(label.at) };
}
export function qualityView(
  read: CaseRead,
  q: StoredCaseQuality | null,
): SupportCaseQualityView {
  const review = q?.review ?? null;
  return {
    thread: read.thread,
    seq: read.seq,
    openedAt: iso(read.case.openedAt),
    resolvedAt: read.case.resolvedAt === null ? null : iso(read.case.resolvedAt),
    labels: [...(q?.labels ?? [])]
      .sort((a, b) => a.message - b.message)
      .map(labelEntry),
    review: review
      ? {
          reason: review.reason,
          sampledAt: iso(review.sampledAt),
          reviewer: review.reviewer,
          state: review.state,
          rubric: review.rubric,
          scoredBy: review.by,
          scoredAt: review.at === null ? null : iso(review.at),
          skip: review.skip,
          note: review.note,
        }
      : null,
    category: q?.facets.category ?? null,
  };
}
/** The latest three requests' quality, or one request's. */
export async function qualityViews(
  storage: Storage,
  record: TeamConversationRecord,
  seq: number | null,
): Promise<SupportCaseQualityView[]> {
  const cases =
    seq === null
      ? await readThreadCases(storage, record.id as `tc-${string}`, {
          limit: QUALITY_LIMITS.workflowLabelCases,
        })
      : [await readCase(storage, { thread: record.id as `tc-${string}`, seq })].filter(
          (entry): entry is CaseRead => entry !== null,
        );
  if (seq !== null && !cases.length)
    throw new HttpError(404, "Case not found.", undefined, "case-not-found");
  const out: SupportCaseQualityView[] = [];
  for (const read of cases)
    out.push(qualityView(read, await readQuality(storage, read.thread, read.seq)));
  return out;
}
export async function labelReply(
  storage: Storage,
  context: ConversationContext,
  viewer: QualityViewer,
  record: TeamConversationRecord,
  input: { message: unknown; labels: unknown },
): Promise<SupportCaseQualityView> {
  if (viewer.bot) throw peopleOnly("Only people on the team can label replies.");
  const labels = checkedReplyLabels(input.labels);
  if (!labels)
    throw new HttpError(400, "Choose Correct, Useful, or one or more problems.", undefined, "invalid-label");
  const message = Number(input.message);
  if (
    !Number.isSafeInteger(message) ||
    !/^[1-9][0-9]{0,14}$/.test(String(input.message))
  )
    throw new HttpError(400, "Choose a reply.", undefined, "invalid-message");
  const { read, author } = await caseForMessage(storage, record, message);
  const q = await writableQuality(storage, read.thread, read.seq, context.now);
  const existing = q.labels.findIndex((label) => label.message === message);
  if (labels.length === 0) {
    if (existing >= 0) q.labels.splice(existing, 1);
  } else {
    if (existing < 0 && q.labels.length >= QUALITY_LIMITS.labelsPerCase)
      throw new HttpError(
        409,
        "This case has 50 labeled replies. Clear one to add another.",
        undefined,
        "label-limit",
      );
    const entry: StoredLabel = {
      message,
      labels,
      bot: (context.bots ?? []).includes(author as ChatPrincipalId),
      by: viewer.principal,
      at: context.now,
    };
    if (existing >= 0) q.labels[existing] = entry;
    else q.labels.push(entry);
  }
  // A problem label can sample the request for review.
  if (labels.length && labels[0] !== "correct") {
    const settings = await qualitySettings(storage);
    await maybeSample(storage, context, read.case, q, settings, {
      trigger: "label",
      labels,
    }).catch(() => console.warn("TEMPL_SUPPORT_QUALITY_SKIPPED", { thread: read.thread, path: "label" }));
  }
  await writeQuality(storage, q);
  const data = await supportRecord(storage, record);
  await recordSupportActivity(storage, record.id, data, {
    actor: viewer.principal,
    action: "label" as CaseActivityAction,
    at: context.now,
    detail: labels.length ? labels.join(",") : "cleared",
  });
  return qualityView(read, q);
}

/* ---------------------------------------------------------------------- */
/* Sampling                                                                */
/* ---------------------------------------------------------------------- */

type Trigger =
  | { trigger: "close" }
  | { trigger: "confirm" }
  | { trigger: "label"; labels: ReplyLabel[] }
  | { trigger: "manual" };
function ruleMatches(rule: SampleRule, c: SupportCase, q: StoredCaseQuality): boolean {
  switch (rule.kind) {
    case "ai-answered":
      return c.firstBotReplyAt !== null && c.counts.humanReplies === 0;
    case "ai-answered-transaction":
      return c.firstBotReplyAt !== null && c.counts.humanReplies === 0 && c.context.transaction;
    case "handoff":
      return c.handoffReason === rule.reason;
    case "category":
      return q.facets.category === rule.category;
    case "reopened":
      return c.reopens > 0;
    case "diagnosis-rule":
      return q.facets.diagnosisRules.includes(rule.rule);
    case "not-solved":
      return c.confirmation === "not-solved";
    case "label":
      return q.labels.some((label) => label.labels.includes(rule.label));
  }
}
async function nextReviewer(
  storage: Storage,
  context: Pick<ConversationContext, "isSupportStaff" | "bots">,
  settings: SupportQualitySettings,
): Promise<ChatPrincipalId | null> {
  const list = settings.sampling.reviewers;
  if (!list.length) return null;
  const start = ((await storage.get<number>(REVIEW_RR_KEY)) ?? 0) % list.length;
  for (let offset = 0; offset < list.length; offset++) {
    const index = (start + offset) % list.length;
    const candidate = list[index];
    if ((context.bots ?? []).includes(candidate)) continue;
    if (!(await context.isSupportStaff?.(candidate))) continue;
    await storage.put(REVIEW_RR_KEY, index + 1);
    return candidate;
  }
  return null;
}
async function queueSample(
  storage: Storage,
  context: Pick<ConversationContext, "isSupportStaff" | "bots">,
  c: SupportCase,
  q: StoredCaseQuality,
  settings: SupportQualitySettings,
  reason: SampleReason,
  now: number,
  cap: boolean,
): Promise<boolean> {
  const week = `${REVIEW_WEEK_PREFIX}${isoWeek(now)}`;
  const count = (await storage.get<number>(week)) ?? 0;
  if (cap && count >= settings.sampling.weeklyCap) {
    q.sampleDecision = { at: now, result: "capped" };
    return false;
  }
  const reviewer = await nextReviewer(storage, context, settings);
  q.review = {
    reason,
    sampledAt: now,
    reviewer,
    state: "queued",
    rubric: null,
    by: null,
    at: null,
    skip: null,
    note: null,
  };
  q.sampleDecision = { at: now, result: "sampled" };
  await storage.put(week, count + 1);
  await storage.put(queueKey(now, c.thread, c.seq), { reviewer, state: "queued" });
  return true;
}
/** Samples one case for review when a rule or the random share picks it. */
export async function maybeSample(
  storage: Storage,
  context: Pick<ConversationContext, "isSupportStaff" | "bots" | "now">,
  c: SupportCase,
  q: StoredCaseQuality,
  settings: SupportQualitySettings,
  trigger: Trigger,
): Promise<boolean> {
  if (c.excluded.length || q.review) return false;
  if (trigger.trigger === "manual")
    return queueSample(storage, context, c, q, settings, { kind: "manual" }, context.now, false);
  if (!samplingOn(settings)) {
    // A request that closed while sampling was off is never sampled later
    // at random.
    if (trigger.trigger === "close" && !q.sampleDecision)
      q.sampleDecision = { at: context.now, result: "not-sampled" };
    return false;
  }
  const rules = settings.sampling.rules;
  let reason: SampleReason | null = null;
  if (trigger.trigger === "label") {
    const rule = rules.find(
      (r) => r.kind === "label" && trigger.labels.includes(r.label),
    );
    reason = rule ?? null;
  } else if (trigger.trigger === "confirm") {
    const rule = rules.find((r) => r.kind === "not-solved");
    reason = rule && c.confirmation === "not-solved" ? rule : null;
  } else {
    if (q.sampleDecision) return false;
    const rule = rules.find(
      (r) => r.kind !== "label" && r.kind !== "not-solved" && ruleMatches(r, c, q),
    );
    if (rule) reason = rule;
    else {
      const draw = crypto.getRandomValues(new Uint32Array(1))[0] % 10_000;
      if (draw < settings.sampling.randomPercent * 100) reason = { kind: "random" };
    }
    if (!reason) {
      q.sampleDecision = { at: context.now, result: "not-sampled" };
      return false;
    }
  }
  if (!reason) return false;
  return queueSample(storage, context, c, q, settings, reason, context.now, true);
}
/** Snapshots a closed case's category and tags, then samples it. Reads the
 * newest 500 requests of the last 30 days in batches; only closed requests
 * without a decision are written. */
export async function reconcileSampling(
  storage: Storage,
  context: Pick<ConversationContext, "isSupportStaff" | "bots" | "now">,
): Promise<number> {
  await storage.put(SAMPLE_SCAN_KEY, context.now);
  const settings = await qualitySettings(storage);
  const cases = (
    await readCasesOpened(storage, {
      from: context.now - 30 * DAY,
      to: context.now + 1,
      limit: 500,
      newest: true,
    })
  ).filter((read) => read.case.resolvedAt !== null && !read.case.excluded.length);
  const stored = await batchGet<unknown>(
    storage,
    cases.map((read) => qualityKey(read.thread, read.seq)),
  );
  let sampled = 0;
  for (const read of cases) {
    const c = read.case;
    const existing = checkedQuality(
      stored.get(qualityKey(read.thread, read.seq)),
      read.thread,
      read.seq,
    );
    const done =
      existing?.sampleDecision &&
      (existing.review || c.confirmation !== "not-solved" || !samplingOn(settings));
    if (done) continue;
    const q = existing ?? (await writableQuality(storage, read.thread, read.seq, context.now));
    if (q.facets.closedAt === null) {
      const record = await readConversation(storage, read.thread);
      if (!record) continue;
      const data = await supportRecord(storage, record);
      q.facets.category = data.category;
      q.facets.tags = data.tags.slice(0, 10);
      q.facets.closedAt = c.resolvedAt;
    }
    try {
      if (!q.sampleDecision && (await maybeSample(storage, context, c, q, settings, { trigger: "close" })))
        sampled++;
      else if (
        c.confirmation === "not-solved" &&
        (await maybeSample(storage, context, c, q, settings, { trigger: "confirm" }))
      )
        sampled++;
    } catch {
      console.warn("TEMPL_SUPPORT_QUALITY_SKIPPED", { thread: read.thread, path: "close" });
    }
    await writeQuality(storage, q);
  }
  return sampled;
}

/* ---------------------------------------------------------------------- */
/* Reviews                                                                 */
/* ---------------------------------------------------------------------- */

export async function reviewAction(
  storage: Storage,
  context: ConversationContext,
  viewer: QualityViewer,
  record: TeamConversationRecord,
  body: Record<string, unknown>,
): Promise<SupportCaseQualityView> {
  if (viewer.bot) throw peopleOnly();
  const seq = Number(body.seq);
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw new HttpError(400, "Choose a case number.", undefined, "invalid-seq");
  const read = await readCase(storage, { thread: record.id as `tc-${string}`, seq });
  if (!read)
    throw new HttpError(404, "Case not found.", undefined, "case-not-found");
  const q = await writableQuality(storage, read.thread, read.seq, context.now);
  const action = body.action;
  const notSampled = () =>
    new HttpError(409, "This case wasn't sampled for review.", undefined, "review-not-sampled");
  const setQueue = async () => {
    if (q.review)
      await storage.put(queueKey(q.review.sampledAt, read.thread, read.seq), {
        reviewer: q.review.reviewer,
        state: q.review.state,
      });
  };
  if (action === "sample") {
    if (!viewer.lead) throw leadOnly();
    if (q.review) throw new HttpError(409, "This case is already in the review queue.", undefined, "review-exists");
    await maybeSample(storage, context, read.case, q, await qualitySettings(storage), { trigger: "manual" });
  } else if (action === "take") {
    if (!q.review) throw notSampled();
    if (q.review.reviewer && q.review.reviewer !== viewer.principal)
      throw new HttpError(403, "This review is assigned to someone else.", undefined, "review-not-yours");
    if (q.review.state === "scored" || q.review.state === "skipped")
      throw new HttpError(409, "This review is already saved.", undefined, "review-done");
    q.review.reviewer = viewer.principal;
    q.review.state = "in-review";
    await setQueue();
  } else if (action === "assign-review") {
    if (!viewer.lead) throw leadOnly();
    if (!q.review) throw notSampled();
    const reviewer = normalizeChatPrincipal(body.reviewer);
    if (
      !reviewer ||
      (context.bots ?? []).includes(reviewer) ||
      !(await context.isSupportStaff?.(reviewer))
    )
      throw new HttpError(400, "Choose a current support staff account.", undefined, "invalid-reviewer");
    q.review.reviewer = reviewer;
    await setQueue();
  } else if (action === "score" || action === "skip") {
    if (!q.review) throw notSampled();
    const mine = q.review.reviewer === viewer.principal;
    if (!mine && !viewer.lead)
      throw new HttpError(403, "This review is assigned to someone else.", undefined, "review-not-yours");
    if ((q.review.state === "scored" || q.review.state === "skipped") && !viewer.lead)
      throw new HttpError(409, "This review is already saved.", undefined, "review-done");
    if (action === "score") {
      const rubric = checkedRubric(body.rubric);
      if (!rubric)
        throw new HttpError(400, "Score all four review items.", undefined, "review-rubric");
      let note: string | null = null;
      if (body.note !== undefined && body.note !== null && body.note !== "") {
        if (
          typeof body.note !== "string" ||
          new TextEncoder().encode(body.note).length > QUALITY_LIMITS.noteChars ||
          // eslint-disable-next-line no-control-regex
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.note)
        )
          throw new HttpError(400, "Keep the note under 4,000 characters.", undefined, "review-note");
        await refusePhrase(body.note, "saved");
        note = body.note.trim();
      }
      q.review.rubric = rubric;
      q.review.note = note;
      q.review.state = "scored";
      q.review.skip = null;
    } else {
      if (!REVIEW_SKIP_REASONS.includes(body.reason as ReviewSkipReason))
        throw new HttpError(400, "Choose why you're skipping this review.", undefined, "review-skip");
      q.review.skip = body.reason as ReviewSkipReason;
      q.review.state = "skipped";
      q.review.rubric = null;
    }
    q.review.by = viewer.principal;
    q.review.at = context.now;
    if (!q.review.reviewer) q.review.reviewer = viewer.principal;
    await setQueue();
  } else
    throw new HttpError(400, "Choose a review action.", undefined, "review-action");
  await writeQuality(storage, q);
  const data = await supportRecord(storage, record);
  await recordSupportActivity(storage, record.id, data, {
    actor: viewer.principal,
    action: "review" as CaseActivityAction,
    at: context.now,
    detail: q.review?.state ?? "queued",
  });
  return qualityView(read, q);
}

export async function reviewQueuePage(
  storage: Storage,
  context: Pick<ConversationContext, "room" | "now">,
  viewer: QualityViewer,
  view: "mine" | "open" | "done",
  after: string | null,
): Promise<{ items: SupportReviewItem[]; next: string | null }> {
  const rows = await storage.list<{ reviewer: ChatPrincipalId | null; state: ReviewState }>({
    prefix: REVIEW_QUEUE_PREFIX,
    reverse: true,
    limit: QUALITY_LIMITS.reviewQueueScan,
    ...(after && QUEUE_KEY.test(after) ? { end: after } : {}),
  });
  const items: SupportReviewItem[] = [];
  let next: string | null = null;
  const stale: string[] = [];
  for (const [key, row] of rows) {
    const match = QUEUE_KEY.exec(key);
    if (!match || !row) continue;
    const [, at, thread, seqText] = match;
    const sampledAt = Number(at);
    const open = row.state === "queued" || row.state === "in-review";
    if (!open && sampledAt < context.now - QUALITY_LIMITS.queueRetentionDays * DAY) {
      stale.push(key);
      continue;
    }
    if (view === "open" && !open) continue;
    if (view === "done" && open) continue;
    if (view === "mine" && (!open || row.reviewer !== viewer.principal)) continue;
    const record = await readConversation(storage, thread);
    const read = record?.room === context.room
      ? await readCase(storage, { thread: thread as `tc-${string}`, seq: Number(seqText) })
      : null;
    const q = read ? await readQuality(storage, thread, Number(seqText)) : null;
    if (!read || !q?.review) {
      stale.push(key);
      continue;
    }
    items.push({
      thread,
      seq: Number(seqText),
      sampledAt: iso(q.review.sampledAt),
      reason: q.review.reason,
      reviewer: q.review.reviewer,
      state: q.review.state,
      category: q.facets.category,
      openedAt: iso(read.case.openedAt),
      overdue: open && q.review.sampledAt < context.now - QUALITY_LIMITS.overdueDays * DAY,
    });
    if (items.length >= QUALITY_LIMITS.reviewPage) {
      next = key;
      break;
    }
  }
  for (const key of stale.slice(0, 50)) await storage.delete(key);
  return { items, next };
}
export async function qualityOverview(
  storage: Storage,
  context: Pick<ConversationContext, "now">,
  viewer: QualityViewer,
): Promise<SupportQualityOverview> {
  const settings = await qualitySettings(storage);
  const counts = { queued: 0, mine: 0, overdue: 0 };
  const rows = await storage.list<{ reviewer: ChatPrincipalId | null; state: ReviewState }>({
    prefix: REVIEW_QUEUE_PREFIX,
    reverse: true,
    limit: QUALITY_LIMITS.reviewQueueScan,
  });
  for (const [key, row] of rows) {
    const match = QUEUE_KEY.exec(key);
    if (!match || !row || (row.state !== "queued" && row.state !== "in-review")) continue;
    counts.queued++;
    if (row.reviewer === viewer.principal) counts.mine++;
    if (Number(match[1]) < context.now - QUALITY_LIMITS.overdueDays * DAY) counts.overdue++;
  }
  const marker = await storage.get<{ startedAt?: number }>(QUALITY_MARKER_KEY);
  return {
    settings,
    canEdit: viewer.admin,
    counts,
    since: natural(marker?.startedAt) ? iso(marker!.startedAt!) : null,
  };
}
/** Week counters older than eight weeks and trend caches older than a day
 * go when settings are read. */
export async function pruneQualityCounters(storage: Storage, now: number) {
  const oldest = isoWeek(now - QUALITY_LIMITS.weekCounterWeeks * 7 * DAY);
  const weeks = await storage.list({ prefix: REVIEW_WEEK_PREFIX, limit: 100 });
  for (const key of weeks.keys())
    if (key.slice(REVIEW_WEEK_PREFIX.length) < oldest) await storage.delete(key);
  for (const window of TREND_WINDOWS) {
    const cached = await storage.get<{ computedAt: number }>(`${TRENDS_CACHE_PREFIX}${window}`);
    if (cached && cached.computedAt < now - DAY)
      await storage.delete(`${TRENDS_CACHE_PREFIX}${window}`);
  }
}

/* ---------------------------------------------------------------------- */
/* Category at resolve                                                     */
/* ---------------------------------------------------------------------- */

/** Records when a person or the AI agent set the category of the current
 * request, on that request's quality record (deleted with the case).
 * Called before the workflow `tags` action runs. */
export async function noteCategorySet(
  storage: Storage,
  record: TeamConversationRecord,
  category: unknown,
  now: number,
) {
  const { categories } = await supportSettings(storage);
  if (typeof category !== "string" || !categories.includes(category)) return;
  await markCategorySet(storage, record, category, now);
}
async function markCategorySet(
  storage: Storage,
  record: TeamConversationRecord,
  category: string,
  now: number,
) {
  const [current] = await readThreadCases(storage, record.id as `tc-${string}`, { limit: 1 });
  if (!current || current.case.resolvedAt !== null) return;
  const q = await writableQuality(storage, current.thread, current.seq, now);
  q.facets.category = category;
  q.facets.categorySetAt = now;
  await writeQuality(storage, q);
}
/** 409 `category-required` unless the current request has a category set
 * during it. A `category` in the body is applied first. Members, spam and
 * the member's "not solved" are never blocked. */
export async function requireCategoryBeforeResolve(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  category: unknown,
): Promise<void> {
  const settings = await qualitySettings(storage);
  if (!settings.requireCategory) return;
  const data = await supportRecord(storage, record);
  const cases = await readThreadCases(storage, record.id as `tc-${string}`, { limit: 1 });
  const current = cases[0];
  if (!current || current.case.resolvedAt !== null) return;
  if (category !== undefined && category !== null) {
    const { categories } = await supportSettings(storage);
    if (typeof category !== "string" || !categories.includes(category))
      throw new HttpError(400, "Choose a configured case category.", undefined, "invalid-category");
    if (data.category !== category) {
      data.category = category;
      await recordSupportActivity(storage, record.id, data, {
        actor: context.viewer.principalId!,
        action: "tags",
        at: context.now,
      });
    }
    await markCategorySet(storage, record, category, context.now);
    return;
  }
  const set = (await readQuality(storage, current.thread, current.seq))?.facets;
  if (
    data.category &&
    set?.category === data.category &&
    set.categorySetAt !== null &&
    set.categorySetAt >= current.case.openedAt
  )
    return;
  throw new HttpError(
    409,
    "Pick a category for this case before you resolve it.",
    undefined,
    "category-required",
  );
}

/* ---------------------------------------------------------------------- */
/* Trends                                                                  */
/* ---------------------------------------------------------------------- */

const READ_BATCH = 128;
async function batchGet<T>(storage: Pick<Storage, "get">, keys: string[]) {
  const out = new Map<string, T>();
  for (let at = 0; at < keys.length; at += READ_BATCH) {
    const values = await storage.get<T>(keys.slice(at, at + READ_BATCH));
    for (const [key, value] of values) out.set(key, value);
  }
  return out;
}
export async function supportTrends(
  storage: Storage,
  window: TrendWindow,
  now: number,
): Promise<SupportTrends> {
  const cacheKey = `${TRENDS_CACHE_PREFIX}${window}`;
  const cached = await storage.get<{ computedAt: number; trends: SupportTrends }>(cacheKey);
  if (cached && now - cached.computedAt < QUALITY_LIMITS.trendCacheMinutes * 60_000)
    return cached.trends;
  const days = TREND_WINDOW_DAYS[window];
  const from = now - days * DAY;
  const cases = await readCasesOpened(storage, {
    from,
    to: now + 1,
    limit: QUALITY_LIMITS.trendScan,
    newest: true,
  });
  const truncated = cases.length >= QUALITY_LIMITS.trendScan;
  const marker = await storage.get<{ startedAt?: number }>(QUALITY_MARKER_KEY);
  const since = natural(marker?.startedAt) ? marker!.startedAt! : null;
  const weeks: string[] = [];
  for (let at = Date.parse(`${weekStart(from)}T00:00:00Z`); at <= now; at += 7 * DAY)
    weeks.push(new Date(at).toISOString().slice(0, 10));
  const qualities = await batchGet<unknown>(
    storage,
    cases.map((read) => qualityKey(read.thread, read.seq)),
  );
  const records = await batchGet<{ category?: string | null; tags?: string[] }>(
    storage,
    [...new Set(cases.map((read) => `support-workflow-v1:${read.thread}`))],
  );
  const counts = Object.fromEntries(
    TREND_DIMENSIONS.map((dimension) => [dimension, new Map<string, number[]>()]),
  ) as Record<TrendDimension, Map<string, number[]>>;
  const add = (dimension: TrendDimension, key: string, week: number) => {
    const map = counts[dimension];
    const row = map.get(key) ?? weeks.map(() => 0);
    row[week]++;
    map.set(key, row);
  };
  let excluded = 0;
  let uncategorized = 0;
  let total = 0;
  for (const read of cases) {
    const c = read.case;
    if (c.excluded.length) {
      excluded++;
      continue;
    }
    total++;
    const week = weeks.indexOf(weekStart(c.openedAt));
    if (week < 0) continue;
    const q = checkedQuality(qualities.get(qualityKey(read.thread, read.seq)), read.thread, read.seq);
    const record = records.get(`support-workflow-v1:${read.thread}`);
    const closedAfterStart = c.resolvedAt !== null && since !== null && c.resolvedAt >= since;
    if (closedAfterStart) {
      const category = q?.facets.closedAt !== null && q ? q.facets.category : (record?.category ?? null);
      if (category) add("category", category, week);
      else {
        uncategorized++;
        add("category", "Uncategorized", week);
      }
      const tags = q?.facets.closedAt !== null && q ? q.facets.tags : (record?.tags ?? []);
      for (const tag of new Set(tags.slice(0, 10))) add("tag", tag, week);
    }
    if (c.handoffReason) add("handoff", c.handoffReason, week);
    if (q) {
      const problems = new Set(q.labels.flatMap((label) => label.labels).filter((l) => l !== "correct"));
      for (const problem of problems) add("label", problem, week);
      for (const item of RUBRIC_ITEMS)
        if (q.review?.rubric?.[item] === "fail") add("rubric", item, week);
      for (const rule of new Set(q.facets.diagnosisRules)) add("diagnosis-rule", rule, week);
      for (const type of new Set(q.facets.actionTypes)) add("action-type", type, week);
    }
    if (c.resolvedBy) add("resolved-by", String(c.resolvedBy), week);
    if (c.confirmation) add("confirmation", c.confirmation, week);
  }
  // The last complete week and the week before it.
  const currentWeek = weekStart(now);
  const complete = weeks.filter((week) => week < currentWeek);
  const lastIndex = weeks.indexOf(complete[complete.length - 1]);
  const dimensions = {} as Record<TrendDimension, TrendRow[]>;
  for (const dimension of TREND_DIMENSIONS) {
    const rows = [...counts[dimension].entries()]
      .map(([key, series]) => ({ key, series, total: series.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    const top = rows.slice(0, QUALITY_LIMITS.trendKeys);
    const rest = rows.slice(QUALITY_LIMITS.trendKeys);
    if (rest.length)
      top.push({
        key: "other",
        series: weeks.map((_, i) => rest.reduce((sum, row) => sum + row.series[i], 0)),
        total: rest.reduce((sum, row) => sum + row.total, 0),
      });
    dimensions[dimension] = top.map((row) => ({
      key: row.key,
      total: row.total,
      weeks: row.series,
      change: complete.length >= 2 ? row.series[lastIndex] - row.series[lastIndex - 1] : null,
    }));
  }
  const trends: SupportTrends = {
    schemaVersion: 1,
    window,
    from: iso(from),
    to: iso(now),
    weeks,
    since: since === null ? null : iso(since),
    dimensions,
    cases: total,
    uncategorized,
    excluded,
    truncated,
    complete: (await ledgerState(storage)) === "ready",
    computedAt: iso(now),
  };
  await storage.put(cacheKey, { computedAt: now, trends });
  return trends;
}

/* ---------------------------------------------------------------------- */
/* Knowledge-gap list                                                      */
/* ---------------------------------------------------------------------- */

type StoredGaps = SupportKnowledgeGaps & {
  states: Record<string, { state: GapState; updatedOn: string | null }>;
  computedAtMs: number;
};
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export function monthOf(now: number) {
  return new Date(now).toISOString().slice(0, 7);
}
async function gapId(category: string | null, product: string | null) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${category ?? ""}\u0000${product ?? ""}`),
  );
  return `gap-${[...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/** Closed requests of a month (UTC) whose replies were labeled wrong,
 * unsupported or "should have handed off", whose review failed evidence or
 * scope, or that the AI agent handed off unsure, grouped by category and
 * product. Counts and request links only: no member, no message text. */
export async function knowledgeGaps(
  storage: Storage,
  month: string,
  now: number,
): Promise<SupportKnowledgeGaps> {
  const match = MONTH.exec(month);
  if (!match)
    throw new HttpError(400, "Choose a month as YYYY-MM.", undefined, "gaps-month");
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  const end = Date.UTC(Number(match[1]), Number(match[2]), 1);
  if (start > now) throw new HttpError(400, "Choose this month or an earlier one.", undefined, "gaps-month");
  const key = `${GAPS_PREFIX}${month}`;
  const stored = await storage.get<StoredGaps>(key);
  const fresh = stored && (end <= stored.computedAtMs || now - stored.computedAtMs < 60 * 60_000);
  if (stored && fresh) return withStates(stored);
  const cases = await readCasesOpened(storage, {
    from: start - 90 * DAY,
    to: Math.min(end, now + 1),
    limit: QUALITY_LIMITS.gapScan,
    newest: true,
  });
  const qualities = await batchGet<unknown>(storage, cases.map((r) => qualityKey(r.thread, r.seq)));
  const groups = new Map<string, KnowledgeGapGroup>();
  let closed = 0;
  for (const read of cases) {
    const c = read.case;
    if (c.resolvedAt === null || c.resolvedAt < start || c.resolvedAt >= end || c.excluded.length)
      continue;
    closed++;
    const q = checkedQuality(qualities.get(qualityKey(read.thread, read.seq)), read.thread, read.seq);
    const signals = new Set<GapSignal>();
    for (const label of q?.labels ?? [])
      for (const code of label.labels)
        if ((GAP_SIGNALS as readonly string[]).includes(code)) signals.add(code as GapSignal);
    if (q?.review?.rubric?.evidence === "fail") signals.add("rubric-evidence");
    if (q?.review?.rubric?.scope === "fail") signals.add("rubric-scope");
    if (c.handoffReason === "unsure") signals.add("handoff-unsure");
    if (!signals.size) continue;
    const frame = await readCaseFrame(storage, read.thread, read.seq).catch(() => null);
    const category = q?.facets.category ?? null;
    const product = frame?.product?.key ?? null;
    const id = await gapId(category, product);
    const group = groups.get(id) ?? {
      id,
      category,
      product,
      cases: 0,
      signals: {},
      samples: [],
      state: "open" as GapState,
      updatedOn: null,
    };
    group.cases++;
    for (const signal of signals) group.signals[signal] = (group.signals[signal] ?? 0) + 1;
    if (group.samples.length < QUALITY_LIMITS.gapSamples)
      group.samples.push({ thread: read.thread, seq: read.seq });
    groups.set(id, group);
  }
  const list = [...groups.values()]
    .sort((a, b) => b.cases - a.cases || a.id.localeCompare(b.id))
    .slice(0, QUALITY_LIMITS.gapGroups);
  const next: StoredGaps = {
    schemaVersion: 1,
    month,
    groups: list,
    cases: closed,
    truncated: cases.length >= QUALITY_LIMITS.gapScan,
    computedAt: iso(now),
    computedAtMs: now,
    states: stored?.states ?? {},
  };
  await storage.put(key, next);
  return withStates(next);
}
function withStates(stored: StoredGaps): SupportKnowledgeGaps {
  return {
    schemaVersion: 1,
    month: stored.month,
    groups: stored.groups.map((group) => ({
      ...group,
      state: stored.states[group.id]?.state ?? "open",
      updatedOn: stored.states[group.id]?.updatedOn ?? null,
    })),
    cases: stored.cases,
    truncated: stored.truncated,
    computedAt: stored.computedAt,
  };
}
export async function gapAction(
  storage: Storage,
  body: Record<string, unknown>,
  now: number,
): Promise<SupportKnowledgeGaps> {
  const month = String(body.month ?? "");
  const stored = await storage.get<StoredGaps>(`${GAPS_PREFIX}${month}`);
  if (!stored || !MONTH.test(month))
    throw new HttpError(404, "Open this month's list first.", undefined, "gaps-missing");
  const id = String(body.id ?? "");
  if (!stored.groups.some((group) => group.id === id))
    throw new HttpError(404, "That group isn't in this month's list.", undefined, "gaps-missing");
  const state =
    body.action === "docs-updated"
      ? "docs-updated"
      : body.action === "not-a-gap"
        ? "not-a-gap"
        : body.action === "reopen"
          ? "open"
          : null;
  if (!state) throw new HttpError(400, "Choose Docs updated, Not a gap or Reopen.", undefined, "gaps-action");
  stored.states[id] = {
    state,
    updatedOn: state === "docs-updated" ? new Date(now).toISOString().slice(0, 10) : null,
  };
  await storage.put(`${GAPS_PREFIX}${month}`, stored);
  return withStates(stored);
}

/** Facets other features write into a case's quality record: diagnosis
 * rule ids, "Was this check right?" ratings and action types. */
export async function recordCaseFacet(
  storage: Storage,
  thread: string,
  seq: number,
  facet:
    | { diagnosisRule: string }
    | { diagnosisRating: { diagnosis: string; rating: "correct" | "incomplete" | "wrong" } }
    | { actionType: string },
  at: number,
): Promise<void> {
  if (!THREAD.test(thread) || !Number.isSafeInteger(seq) || seq < 1) return;
  const q = await writableQuality(storage, thread, seq, at);
  if ("diagnosisRule" in facet) {
    if (!q.facets.diagnosisRules.includes(facet.diagnosisRule) && q.facets.diagnosisRules.length < 16)
      q.facets.diagnosisRules.push(facet.diagnosisRule.slice(0, 64));
  } else if ("diagnosisRating" in facet) {
    q.facets.diagnosisRatings = [
      ...q.facets.diagnosisRatings.filter((r) => r.diagnosis !== facet.diagnosisRating.diagnosis),
      { ...facet.diagnosisRating, at },
    ].slice(-8);
  } else if (!q.facets.actionTypes.includes(facet.actionType) && q.facets.actionTypes.length < 8)
    q.facets.actionTypes.push(facet.actionType.slice(0, 40));
  await writeQuality(storage, q);
}
