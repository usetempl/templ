import records from "./pilot-results.json";

/** Pilot results the landing page may show. The list stays empty until the
 * founder authorizes a team's public use and its aggregate record sits under
 * audit/pilots/. The release gate
 * (apps/scripts/src/release/v4-pilot-results-evidence.mjs) checks every entry
 * against that record: its hash, the authorization, denominators, a baseline
 * for every measure and dates that have passed. This module only drops
 * entries whose shape is wrong, so a bad edit renders nothing. */
export type PilotMeasureId =
  | "staff-minutes"
  | "first-answer-minutes"
  | "solved"
  | "reopened";
export type PilotValue = { value: number; denominator: number };
export type PilotMeasure = {
  id: PilotMeasureId;
  /** The arm without Templ: the team's usual process or a holdout. */
  baseline: PilotValue;
  pilot: PilotValue;
};
export type PilotResult = {
  id: string;
  /** Null when the team asked to stay anonymous. */
  team: string | null;
  window: { from: string; to: string };
  design: "randomized" | "observational";
  /** Required when either arm has fewer than PILOT_MIN_CASES cases. */
  smallSample: boolean;
  cases: { baseline: number; pilot: number };
  measures: PilotMeasure[];
  method: string;
  evidence: { path: string; sha256: string };
};

export const PILOT_MIN_CASES = 100;
/** Medians are in minutes; counts are shown as "x of n", never as a rate. */
export const PILOT_MEASURES: Record<
  PilotMeasureId,
  { label: string; kind: "minutes" | "count"; of: string }
> = {
  "staff-minutes": {
    label: "Staff minutes per solved case (median)",
    kind: "minutes",
    of: "solved cases",
  },
  "first-answer-minutes": {
    label: "Minutes to the first human answer (median)",
    kind: "minutes",
    of: "answered cases",
  },
  solved: { label: "Cases solved", kind: "count", of: "cases" },
  reopened: {
    label: "Solved cases reopened",
    kind: "count",
    of: "solved cases",
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Words that mark a goal rather than an observed number. */
const NOT_A_RESULT = /target|goal|acceptance|criteri|expected|projected/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  ISO_DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
function mentionsGoal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsGoal);
  if (!record(value)) return false;
  return Object.entries(value).some(
    ([key, inner]) => NOT_A_RESULT.test(key) || mentionsGoal(inner),
  );
}
function validValue(
  value: unknown,
  kind: "minutes" | "count",
  cases: number,
): value is PilotValue {
  if (!record(value) || !count(value.denominator)) return false;
  const { denominator } = value;
  if (denominator < 1 || denominator > cases) return false;
  return kind === "count"
    ? count(value.value) && value.value <= denominator
    : typeof value.value === "number" &&
        Number.isFinite(value.value) &&
        value.value >= 0;
}

/** One entry's shape, as the landing page needs it. */
export function isPilotResult(value: unknown): value is PilotResult {
  if (!record(value) || mentionsGoal(value)) return false;
  const { id, team, window, design, smallSample, cases, measures } = value;
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    return false;
  if (team !== null && !(typeof team === "string" && team.trim())) return false;
  if (!record(window) || !date(window.from) || !date(window.to)) return false;
  if (window.from > window.to) return false;
  if (design !== "randomized" && design !== "observational") return false;
  if (typeof smallSample !== "boolean") return false;
  if (!record(cases) || !count(cases.baseline) || !count(cases.pilot))
    return false;
  if (cases.baseline < 1 || cases.pilot < 1) return false;
  if (
    !smallSample &&
    (cases.baseline < PILOT_MIN_CASES || cases.pilot < PILOT_MIN_CASES)
  )
    return false;
  if (!Array.isArray(measures) || measures.length === 0) return false;
  const seen = new Set<string>();
  for (const measure of measures) {
    if (!record(measure) || typeof measure.id !== "string") return false;
    if (!(measure.id in PILOT_MEASURES) || seen.has(measure.id)) return false;
    seen.add(measure.id);
    const { kind } = PILOT_MEASURES[measure.id as PilotMeasureId];
    if (
      !validValue(measure.baseline, kind, cases.baseline) ||
      !validValue(measure.pilot, kind, cases.pilot)
    )
      return false;
  }
  if (
    typeof value.method !== "string" ||
    !/^https:\/\/[^\s]+$/.test(value.method)
  )
    return false;
  const evidence = value.evidence;
  return (
    record(evidence) &&
    evidence.path === `audit/pilots/${id}.json` &&
    typeof evidence.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(evidence.sha256)
  );
}

/** The entries that can render. Ids must be unique; a repeated id drops
 * every copy of it. */
export function publishablePilotResults(input: unknown): PilotResult[] {
  if (!Array.isArray(input)) return [];
  const ids = input.map((entry) => (record(entry) ? entry.id : undefined));
  return input.filter(
    (entry, index): entry is PilotResult =>
      isPilotResult(entry) &&
      ids.indexOf(entry.id) === index &&
      ids.lastIndexOf(entry.id) === index,
  );
}

export const PILOT_RESULTS: PilotResult[] = publishablePilotResults(records);
