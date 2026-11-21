import { canManageWorkspace } from "@templ/chat/moderation-permissions";
/** Pilot settings and the metrics export.
 *
 * A workspace keeps the context its pilot numbers need: its time zone,
 * staffed hours, reply targets, incident windows and the baseline its team
 * reported from before Templ. The metrics export turns the case ledger into
 * one row per request, with times, counts and fixed labels: no message or
 * note text, member, wallet or thread ID. The legacy monthly customer-charge
 * average requires separate billing permission and is hidden for customer
 * arrangements managed by Templ. `billed` says whether
 * the request's charge bills (billed, free, pending, a reason it doesn't,
 * or open while nobody resolved it). A request left out of pilot numbers
 * (spam, a test account, a staff preview or Templ's canary) keeps its row
 * with that reason in `excluded` and no times, so a report can count what
 * it left out. A row names its request by a keyed hash that only this
 * workspace's key produces.
 *
 * Routes (team views; a member gets 404):
 * - GET  /conversations/pilot            the manager and support leads
 * - POST /conversations/pilot            the manager, with a valid wallet
 *                                        sign-in and `confirmed: true`; the
 *                                        fields sent replace those fields
 * - GET  /conversations/metrics?from=&to=&format=json|csv
 *                                        the manager and support leads; at
 *                                        most `metricsExportMaxDays` days and
 *                                        `metricsExportsPerHour` exports an
 *                                        hour per workspace */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import type { SupportCase, SupportCaseExclusion } from "@templ/chat/support";
import { effectivePermissions } from "@templ/chat/moderation-permissions";
import { HttpError, json } from "./common";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import type { ProductCaseBilling } from "@templ/chat/product-catalog";
import { readMessage } from "./message-store";
import { readQuality, qualityKey } from "./support-quality";
import { billingManagedForWorkspace } from "./customer-debt-access";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { readChargeMonth } from "./product-charges";
import { caseBilling } from "./product-charges";
import { readCasesOpened } from "./support-case-data";
import type { ConversationContext } from "./team-conversations";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;

export const PILOT_SETTINGS_KEY = "pilot-settings-v1";
const METRICS_KEY = "pilot-metrics-key-v1";
const RATE_KEY = "pilot-metrics-rate-v1";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Most requests one export reads (the case ledger's window read); a
 * window that reaches it is refused, never cut short. */
export const METRICS_MAX_ROWS = 5_000;
export const PILOT_INCIDENT_CODES = [
  "outage",
  "exploit",
  "launch",
  "other",
] as const;
export const PILOT_BASELINE_METHODS = [
  "helpdesk-export",
  "manual-count",
  "estimate",
] as const;
export type PilotSettings = {
  schema: 1;
  timezone: string;
  staffedHours: { day: number; from: string; to: string }[];
  targets: { firstReplyMinutes?: number; resolveHours?: number };
  incidents: {
    id: string;
    from: string;
    to: string;
    code: (typeof PILOT_INCIDENT_CODES)[number];
  }[];
  baseline: {
    from: string;
    to: string;
    source: "reported-by-team";
    method: (typeof PILOT_BASELINE_METHODS)[number];
    requests?: number;
    medianFirstReplyMinutes?: number;
    medianResolveHours?: number;
    first_useful_s?: number;
    clarify_turns?: number;
    context_ready_s?: number;
    handling_s?: number;
    diagnosis_rated_wrong?: number;
    action_completed?: number;
  } | null;
  updatedAt: string | null;
};
const EMPTY: PilotSettings = {
  schema: 1,
  timezone: "UTC",
  staffedHours: [],
  targets: {},
  incidents: [],
  baseline: null,
  updatedAt: null,
};
export const METRICS_COLUMNS = [
  "case",
  "opened_hour_utc",
  "access",
  "first_reply_s",
  "first_reply_by",
  "handoff_reason",
  "resolved_by",
  "resolve_s",
  "reopens",
  "billed",
  "in_staffed_hours",
  "in_incident",
  "excluded",
  "first_useful_s",
  "clarify_turns",
  "context_ready_s",
  "handling_s",
  "diagnosis_rated_wrong",
  "action_completed",
  "cost_per_resolved",
  // Additive names preserve readers of the original columns without
  // presenting a composing-time or customer-charge proxy as delivery ROI.
  "composition_s",
  "reviewed_first_useful_s",
  "staff_reported_time_bucket",
  "customer_charge_average_cents",
  "service_cost_per_resolved_usd",
  "member_confirmed_resolution",
  "ai_reviewed_replies",
  "ai_reviewed_correct_replies",
  "ai_reviewed_flagged_replies",
] as const;

export const METRICS_DEFINITIONS = Object.freeze({
  first_useful_s: "Legacy proxy: first staff-labeled correct reply, otherwise last reply on a resolved case.",
  handling_s: "Legacy alias of composition_s. Observed human composing seconds; excludes reading, research and work outside Templ.",
  cost_per_resolved: "Legacy alias of customer_charge_average_cents. Monthly customer case-charge cents divided by final paid, free and grant cases; not per-case delivery cost.",
  reviewed_first_useful_s: "First reply currently labeled Correct by a person, with its recorded reply timing. No resolved-last-reply fallback.",
  composition_s: "Observed human composing seconds; excludes reading, research and work outside Templ.",
  staff_reported_time_bucket: "Optional total time reported by a person when resolving. A range, never inferred from composing time.",
  customer_charge_average_cents: "Opening-month customer case-charge average in USD cents. Only current billing-authorized viewers can read it; operator-managed customer billing stays hidden.",
  service_cost_per_resolved_usd: "Unavailable: provider and shared infrastructure costs are not attributed to these individual cases. Blank never means zero.",
  member_confirmed_resolution: "True only for a currently resolved case with a recorded member resolution or a current affirmative confirmation. False means no recorded affirmation, not failure.",
  ai_reviewed_replies: "Distinct AI replies currently labeled by a person; an unreviewed reply establishes no quality result.",
  ai_reviewed_correct_replies: "Reviewed AI replies labeled Correct by a person.",
  ai_reviewed_flagged_replies: "Reviewed AI replies carrying one or more problem labels; each reply counts once.",
});

type ReviewCounts = {
  reviewed: number | null;
  correct: number | null;
  flagged: number | null;
  firstUsefulAt: number | null;
};
const NO_REVIEW: ReviewCounts = { reviewed: 0, correct: 0, flagged: 0, firstUsefulAt: null };
/** The one reason an excluded row names, when a case has several. */
const METRICS_EXCLUSION_ORDER: readonly SupportCaseExclusion[] = [
  "canary",
  "staff-preview",
  "install-preview",
  "test-account",
  "spam",
];

const bad = (message: string) => new HttpError(400, message);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const whole = (value: unknown, max: number) =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= max;

function timezone(value: unknown) {
  if (typeof value !== "string" || value.length > 64)
    throw bad("Choose a time zone.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw bad("Choose a time zone.");
  }
  return value;
}
function staffedHours(value: unknown) {
  if (!Array.isArray(value) || value.length > 14)
    throw bad("Use at most 14 staffed-hour rows.");
  return value.map((row) => {
    if (
      !plain(row) ||
      !whole(row.day, 6) ||
      typeof row.from !== "string" ||
      typeof row.to !== "string" ||
      !TIME.test(row.from) ||
      !TIME.test(row.to) ||
      row.from >= row.to
    )
      throw bad(
        "Each staffed-hour row needs a day and a start before its end.",
      );
    return { day: row.day as number, from: row.from, to: row.to };
  });
}
function targets(value: unknown) {
  if (!plain(value)) throw bad("Targets must be minutes and hours.");
  const out: PilotSettings["targets"] = {};
  for (const [key, max] of [
    ["firstReplyMinutes", 10_080],
    ["resolveHours", 8_760],
  ] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!whole(value[key], max) || value[key] === 0)
      throw bad("Targets must be whole minutes and hours above zero.");
    out[key] = value[key] as number;
  }
  if (
    Object.keys(value).some(
      (key) => !["firstReplyMinutes", "resolveHours"].includes(key),
    )
  )
    throw bad("Targets must be minutes and hours.");
  return out;
}
const instant = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
function incidents(value: unknown) {
  if (!Array.isArray(value) || value.length > 20)
    throw bad("Use at most 20 incidents.");
  const ids = new Set<string>();
  return value.map((row) => {
    if (
      !plain(row) ||
      typeof row.id !== "string" ||
      !/^[a-z0-9-]{1,40}$/.test(row.id) ||
      ids.has(row.id) ||
      !instant(row.from) ||
      !instant(row.to) ||
      Date.parse(row.from as string) >= Date.parse(row.to as string) ||
      !(PILOT_INCIDENT_CODES as readonly unknown[]).includes(row.code)
    )
      throw bad(
        "Each incident needs a short id, a start before its end and a kind.",
      );
    ids.add(row.id);
    return {
      id: row.id,
      from: new Date(row.from as string).toISOString(),
      to: new Date(row.to as string).toISOString(),
      code: row.code as PilotSettings["incidents"][number]["code"],
    };
  });
}
function baseline(value: unknown): PilotSettings["baseline"] {
  if (value === null) return null;
  if (
    !plain(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    !DATE.test(value.from) ||
    !DATE.test(value.to) ||
    value.from > value.to ||
    value.source !== "reported-by-team" ||
    !(PILOT_BASELINE_METHODS as readonly unknown[]).includes(value.method)
  )
    throw bad(
      "The baseline needs its dates, how your team counted it and nothing else.",
    );
  const out: NonNullable<PilotSettings["baseline"]> = {
    from: value.from,
    to: value.to,
    source: "reported-by-team",
    method: value.method as NonNullable<PilotSettings["baseline"]>["method"],
  };
  for (const [key, max] of [
    ["requests", 10_000_000],
    ["medianFirstReplyMinutes", 525_600],
    ["medianResolveHours", 8_760],
    ...(["first_useful_s", "clarify_turns", "context_ready_s", "handling_s", "diagnosis_rated_wrong", "action_completed"] as const).map((key) => [key, 10_000_000] as const),
  ] as const) {
    if (value[key] === undefined) continue;
    if (!whole(value[key], max))
      throw bad("Baseline numbers must be whole and not negative.");
    out[key] = value[key] as number;
  }
  const allowed = [
    "from",
    "to",
    "source",
    "method",
    "requests",
    "medianFirstReplyMinutes",
    "medianResolveHours",
    "first_useful_s", "clarify_turns", "context_ready_s", "handling_s", "diagnosis_rated_wrong", "action_completed",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw bad(
      "The baseline needs its dates, how your team counted it and nothing else.",
    );
  return out;
}
const FIELDS = {
  timezone,
  staffedHours,
  targets,
  incidents,
  baseline,
} as const;

export async function readPilotSettings(
  storage: Pick<Storage, "get">,
): Promise<PilotSettings> {
  const stored = await storage.get<PilotSettings>(PILOT_SETTINGS_KEY);
  return stored?.schema === 1 ? { ...EMPTY, ...stored } : { ...EMPTY };
}

/** The hour and weekday of `at` in `zone`. */
function local(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return {
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      get("weekday") ?? "",
    ),
    time: `${get("hour")}:${get("minute")}`,
  };
}
export function inStaffedHours(settings: PilotSettings, at: number) {
  if (!settings.staffedHours.length) return null;
  const { day, time } = local(at, settings.timezone);
  return settings.staffedHours.some(
    (row) => row.day === day && row.from <= time && time < row.to,
  );
}

async function metricsKey(storage: Storage) {
  let hex = await storage.get<string>(METRICS_KEY);
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await storage.put(METRICS_KEY, hex);
  }
  const bytes = new Uint8Array(
    hex.match(/../g)!.map((pair) => parseInt(pair, 16)),
  );
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
async function caseId(key: CryptoKey, thread: string, seq: number) {
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${thread}:${seq}`),
    ),
  );
  return [...mac.slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const seconds = (ms: number | null) =>
  ms === null ? null : Math.max(0, Math.round(ms / 1000));

/** The `billed` cell: whether the case's charge bills, never an amount.
 * `open` while nobody resolved it. */
export function billedCell(billing: ProductCaseBilling | null): string {
  if (!billing) return "open";
  return billing.status === "not-billed" ? billing.reason : billing.status;
}

type MetricsRow = Record<
  (typeof METRICS_COLUMNS)[number],
  string | number | boolean | null
>;
/** One export row: times, counts and fixed labels only. An excluded case
 * keeps its case, opening hour, access and reason, and nothing else. */
export function metricsRow(
  id: string,
  c: SupportCase,
  settings: PilotSettings,
  billing: ProductCaseBilling | null = null,
  costPerResolved: number | null = null,
  reviews: ReviewCounts = NO_REVIEW,
): MetricsRow {
  const hour = new Date(Math.floor(c.openedAt / HOUR) * HOUR).toISOString();
  const excluded =
    METRICS_EXCLUSION_ORDER.find((reason) => c.excluded.includes(reason)) ??
    null;
  if (excluded)
    return {
      ...(Object.fromEntries(
        METRICS_COLUMNS.map((column) => [column, null]),
      ) as MetricsRow),
      case: id,
      opened_hour_utc: `${hour.slice(0, 13)}:00Z`,
      access: c.access,
      excluded,
    };
  return {
    case: id,
    opened_hour_utc: `${hour.slice(0, 13)}:00Z`,
    access: c.access,
    first_reply_s:
      c.firstReplyAt === null
        ? null
        : seconds(c.firstReplyAt - c.openedAt),
    first_reply_by:
      c.firstReplyAt === null
        ? null
        : c.firstReplyAt === c.firstHumanReplyAt
          ? "person"
          : c.firstReplyAt === c.firstBotReplyAt
            ? "ai"
            : null,
    handoff_reason: c.handoffReason,
    resolved_by: c.resolvedBy,
    resolve_s:
      c.firstResolvedAt === null
        ? null
        : seconds(c.firstResolvedAt - c.openedAt),
    reopens: c.reopens,
    billed: billedCell(billing),
    in_staffed_hours: inStaffedHours(settings, c.openedAt),
    in_incident: settings.incidents.some(
      (incident) =>
        Date.parse(incident.from) <= c.openedAt &&
        c.openedAt < Date.parse(incident.to),
    ),
    excluded: null,
    first_useful_s: c.metrics?.firstUsefulAt != null ? seconds(c.metrics.firstUsefulAt - c.openedAt) : c.resolvedAt != null && c.lastReplyAt != null ? seconds(c.lastReplyAt - c.openedAt) : null,
    clarify_turns: c.metrics?.firstUsefulAt != null || c.resolvedAt != null ? c.metrics?.clarifyTurns ?? null : null,
    context_ready_s: (c.metrics?.firstUsefulAt != null || c.resolvedAt != null) && c.metrics?.contextReadyAt != null ? seconds(c.metrics.contextReadyAt - c.openedAt) : null,
    handling_s: c.metrics?.handlingMs == null ? null : seconds(c.metrics.handlingMs),
    diagnosis_rated_wrong: c.metrics?.diagnosisRatedWrong ?? null,
    action_completed: c.metrics?.actionCompleted ?? null,
    cost_per_resolved: costPerResolved,
    composition_s: c.metrics?.handlingMs == null ? null : seconds(c.metrics.handlingMs),
    reviewed_first_useful_s: reviews.firstUsefulAt === null ? null : seconds(reviews.firstUsefulAt - c.openedAt),
    staff_reported_time_bucket: c.timeSpent,
    customer_charge_average_cents: costPerResolved,
    service_cost_per_resolved_usd: null,
    member_confirmed_resolution: c.resolvedAt === null ? null :
      c.resolvedBy === "member" || (c.confirmation === "solved" && c.confirmedAt !== null && c.confirmedAt >= c.resolvedAt),
    ai_reviewed_replies: reviews.reviewed,
    ai_reviewed_correct_replies: reviews.correct,
    ai_reviewed_flagged_replies: reviews.flagged,
  };
}
const cell = (value: string | number | boolean | null) =>
  value === null ? "" : String(value);

function day(value: string | null, name: string) {
  if (!value || !DATE.test(value) || !Number.isFinite(Date.parse(value)))
    throw bad(`Choose the ${name} date as YYYY-MM-DD.`);
  return Date.parse(`${value}T00:00:00Z`);
}

/** Enriches case-local metrics from the current quality labels and charge month. */
async function measuredCase(storage: Storage, c: SupportCase) {
  const metrics = { ...c.metrics };
  let firstReviewedUsefulAt: number | null = null;
  const quality = await readQuality(storage, c.thread, c.seq);
  const currentLabels = new Map<number, NonNullable<typeof quality>["labels"][number]>();
  for (const label of quality?.labels ?? []) {
    const prior = currentLabels.get(label.message);
    if (!prior || label.at > prior.at) currentLabels.set(label.message, label);
  }
  if (quality) {
    if (quality.facets.diagnosisRatings.length) metrics.diagnosisRatedWrong = quality.facets.diagnosisRatings.filter((rating) => rating.rating === "wrong").length;
    // A reply staff label Correct is the useful reply the metric times.
    const useful = [...currentLabels.values()].filter((label) => label.labels.includes("correct"));
    for (const label of useful) {
      const reply = await readMessage(storage, c.thread, label.message);
      if (!reply) continue;
      const at = Date.parse(reply.createdAt);
      const measure = await storage.get<{ at: number; turns: number; contextAt: number }>(`support-reply-measure-v1:${c.thread}:${String(c.seq).padStart(8, "0")}:${at}`);
      if (!measure) continue;
      firstReviewedUsefulAt = firstReviewedUsefulAt === null ? at : Math.min(firstReviewedUsefulAt, at);
      if (metrics.firstUsefulAt !== undefined && metrics.firstUsefulAt <= at) continue;
      metrics.firstUsefulAt = at;
      metrics.clarifyTurns = measure.turns;
      metrics.contextReadyAt = measure.contextAt;
    }
  }
  // A missing record means no review was recorded. A malformed stored
  // record is unavailable, not a fabricated zero-review result.
  let reviews: ReviewCounts = NO_REVIEW;
  if (quality) {
    const ai = [...currentLabels.values()].filter((label) => label.bot);
    reviews = {
      reviewed: ai.length,
      correct: ai.filter((label) => label.labels.includes("correct")).length,
      flagged: ai.filter((label) => !label.labels.includes("correct")).length,
      firstUsefulAt: firstReviewedUsefulAt,
    };
  } else if (await storage.get(qualityKey(c.thread, c.seq))) {
    reviews = { reviewed: null, correct: null, flagged: null, firstUsefulAt: null };
  }
  return { case: { ...c, metrics }, reviews };
}

/** The pilot routes, for the conversation route's feature block. Null for
 * any other path. */
export async function pilotRoute(
  storage: Storage,
  context: ConversationContext,
): Promise<Response | null> {
  const path = context.pathname;
  if (path !== "/conversations/pilot" && path !== "/conversations/metrics")
    return null;
  const { viewer } = context;
  if (!viewer.principalId) throw new HttpError(401, "Sign in to continue.");
  const team =
    viewer.isManager ||
    effectivePermissions(viewer.permissions).includes("handleConversations");
  // Members never learn these views exist.
  if (!team || context.headers.get("X-Support-Widget") !== null)
    throw new HttpError(404, "Not found.");
  const lead =
    viewer.isManager ||
    effectivePermissions(viewer.permissions).includes("manageSupport");
  if (!lead)
    throw new HttpError(
      403,
      "Only the manager or a support lead can open pilot settings and metrics.",
    );
  if (path === "/conversations/pilot") {
    if (context.method === "GET")
      return json({
        settings: await readPilotSettings(storage),
        canEdit: canManageWorkspace(viewer),
      });
    if (context.method !== "POST")
      throw new HttpError(405, "This pilot action is not available.");
    if (!canManageWorkspace(viewer))
      throw new HttpError(403, "Only workspace admins can change pilot settings.");
    const authenticatedAt = requireWorkspaceAdminHeaders(
      context.headers,
      viewer.isManager,
      context.body.confirmed,
      context.now,
    );
    const changed = Object.keys(context.body).filter(
      (key) => key !== "confirmed" && key !== "expectedPrincipalId",
    );
    if (!changed.length || changed.some((key) => !(key in FIELDS)))
      throw bad(
        "Send the time zone, staffed hours, targets, incidents or baseline.",
      );
    const next: PilotSettings = { ...(await readPilotSettings(storage)) };
    for (const key of changed as (keyof typeof FIELDS)[])
      (next as Record<string, unknown>)[key] = FIELDS[key](context.body[key]);
    next.updatedAt = new Date(context.now).toISOString();
    await storage.put(PILOT_SETTINGS_KEY, next);
    context.pendingAudit.push({
      actor: viewer.principalId,
      authenticatedAt: new Date(authenticatedAt).toISOString(),
      action: "support.settings",
      target: "pilot",
      after: { fields: changed.sort() },
    });
    return json({ settings: next, canEdit: true });
  }
  if (context.method !== "GET")
    throw new HttpError(405, "This metrics action is not available.");
  const format = context.query.get("format") ?? "json";
  if (format !== "json" && format !== "csv") throw bad("Choose json or csv.");
  const from = day(context.query.get("from"), "start");
  const to = day(context.query.get("to"), "end") + DAY;
  if (!(to > from) || to - from > FEATURE_LIMITS.metricsExportMaxDays * DAY)
    throw bad(
      `Choose a window of at most ${FEATURE_LIMITS.metricsExportMaxDays} days.`,
    );
  // One counter for the workspace, in the clock hour it counts.
  const hour = Math.floor(context.now / HOUR);
  const rate = await storage.get<{ hour: number; used: number }>(RATE_KEY);
  const used = rate?.hour === hour ? rate.used : 0;
  if (used >= FEATURE_LIMITS.metricsExportsPerHour)
    throw new HttpError(
      429,
      `You can export metrics ${FEATURE_LIMITS.metricsExportsPerHour} times an hour. Try again later.`,
    );
  await storage.put(RATE_KEY, { hour, used: used + 1 });
  // The ledger read drops index rows whose case is gone or was rebuilt, so
  // the refusal counts the index rows it listed, not the requests it kept:
  // a full index page means later requests in the window went unread.
  let indexed = 0;
  const counted: Pick<DurableObjectStorage, "get" | "list"> = {
    get: storage.get.bind(storage) as DurableObjectStorage["get"],
    list: (async (options?: DurableObjectListOptions) => {
      const rows = await storage.list(options);
      indexed += rows.size;
      return rows;
    }) as DurableObjectStorage["list"],
  };
  const opened = await readCasesOpened(counted, {
    from,
    to,
    limit: METRICS_MAX_ROWS,
  });
  if (indexed >= METRICS_MAX_ROWS || opened.length >= METRICS_MAX_ROWS)
    throw bad(
      `This window has ${METRICS_MAX_ROWS.toLocaleString("en-US")} cases or more. Choose a shorter one.`,
    );
  const settings = await readPilotSettings(storage);
  const key = await metricsKey(storage);
  const canReadCharges = !context.isBot && !(await billingManagedForWorkspace(storage, context.room)) &&
    (viewer.isManager || viewer.permissions.map(String).includes("manageBilling"));
  const chargeMonths = new Map<string, Promise<number | null>>();
  const customerChargeAverage = (openedAt: number) => {
    if (!canReadCharges) return Promise.resolve(null);
    const monthKey = resolutionMonth(openedAt);
    let value = chargeMonths.get(monthKey);
    if (!value) {
      value = readChargeMonth(storage as never, monthKey).then((month) => {
        const total = month.cases + month.free + month.grant;
        return total > 0 ? month.cents / total : null;
      });
      chargeMonths.set(monthKey, value);
    }
    return value;
  };
  const rows = await Promise.all(
    opened.map(async (entry) => {
      const measured = await measuredCase(storage, entry.case);
      return metricsRow(
        await caseId(key, entry.thread, entry.seq),
        measured.case,
        settings,
        entry.case.excluded.length
          ? null
          : await caseBilling(storage as never, entry.thread, entry.seq),
        entry.case.excluded.length ? null : await customerChargeAverage(entry.case.openedAt),
        measured.reviews,
      );
    }),
  );
  if (format === "json") return json({
    schemaVersion: 2,
    columns: METRICS_COLUMNS,
    definitions: METRICS_DEFINITIONS,
    customerChargesAvailable: canReadCharges,
    rows,
  });
  const csv = [
    METRICS_COLUMNS.join(","),
    ...rows.map((row) =>
      METRICS_COLUMNS.map((column) => cell(row[column])).join(","),
    ),
  ].join("\n");
  return new Response(`${csv}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="templ-support-metrics.csv"',
      "Cache-Control": "no-store",
    },
  });
}
