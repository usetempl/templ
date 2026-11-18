/** The golden-set regression gate for managed AI.
 *
 * The cases are the team's own golden set: the eval cases (`templ-eval/1`)
 * a support lead promoted on the Quality page, with their turns, frame,
 * evidence and expected handling. Managed AI answers them again after every
 * change to what it answers with (its prompt, its model, the workspace's
 * knowledge or protocol profile, or the golden cases themselves), and the
 * reference eval scorer grades each answer. The gate refuses the run when a
 * case that passed on the accepted run now fails, or when a case never
 * accepted fails. Until a run passes, member replies wait as drafts for the
 * team.
 *
 * A case is keyed by its eval id and version (`ev-…@3`), so an edited case
 * is a new case that has to pass again.
 *
 * Pure types and checks with no I/O: the worker, the web app and the release
 * gate read runs the same way. */

export const GOLDEN_LIMITS = {
  /** Golden cases one managed run answers: the first ones the team saved.
   * Larger sets are checked on these. */
  casesPerRun: 50,
} as const;

/** Why a golden case failed: no answer, the wrong handling, a failed
 * rubric item of the reference scorer, or the shared safety check. */
export const GOLDEN_PROBLEMS = [
  "no-output",
  "wrong-action",
  "facts",
  "scope",
  "evidence",
  "next-step",
  "unsafe",
] as const;
export type GoldenProblem = (typeof GOLDEN_PROBLEMS)[number];
export type GoldenResult = {
  /** `goldenCaseKey(eval id, version)`. */
  id: string;
  pass: boolean;
  problems: GoldenProblem[];
};
/** Everything that changes what the managed AI answers with, and the cases
 * it is graded on. */
export type GoldenFingerprint = {
  /** The prompt version and the hash of the prompt's own text. */
  prompt: string;
  model: string;
  knowledge: string;
  profile: string;
  /** Hash of the golden case keys the run answers. */
  cases: string;
};
export type GoldenRun = {
  fingerprint: GoldenFingerprint;
  at: string;
  results: GoldenResult[];
};
export type GoldenGateReason =
  | "passed"
  | "empty-set"
  | "incomplete"
  | "regression"
  | "new-case-failed";
export type GoldenGate = {
  ok: boolean;
  reason: GoldenGateReason;
  /** Case keys that passed on the accepted run and fail now. */
  regressions: string[];
  /** Case keys the accepted run did not pass, failing now. */
  failing: string[];
  /** Case keys the run has no result for. */
  missing: string[];
};
/** The gate's state for the workspace, as the settings page reads it. */
export type GoldenGateState = "none" | "pending" | "passed" | "failed";
/** One golden case as the settings page lists it. */
export type GoldenCaseView = {
  id: string;
  firstTurn: string;
  action: "answer" | "clarify" | "handoff";
};

/** The key a golden case is graded under. */
export const goldenCaseKey = (id: string, version: number) => `${id}@${version}`;

/** The problems of one graded answer. `score` is the reference scorer's
 * verdict (null when the model gave no usable answer); `unsafe` is set when
 * the reply failed the shared safety check. */
export function goldenProblems(
  score: {
    actionMatch: boolean;
    items: Readonly<Record<string, "pass" | "fail" | "n/a">>;
  } | null,
  unsafe = false,
): GoldenProblem[] {
  if (!score) return ["no-output"];
  const problems: GoldenProblem[] = [];
  if (!score.actionMatch) problems.push("wrong-action");
  for (const item of ["facts", "scope", "evidence", "next-step"] as const)
    if (score.items[item] === "fail") problems.push(item);
  if (unsafe) problems.push("unsafe");
  return problems;
}

/** One stable string for a fingerprint. */
export function fingerprintKey(fingerprint: GoldenFingerprint): string {
  return [
    fingerprint.prompt,
    fingerprint.model,
    fingerprint.knowledge,
    fingerprint.profile,
    fingerprint.cases,
  ].join("|");
}
export function sameFingerprint(a: GoldenFingerprint, b: GoldenFingerprint) {
  return fingerprintKey(a) === fingerprintKey(b);
}

/** The golden-set gate. `accepted` is the last run the gate let through (or
 * null), `candidate` the run on the new fingerprint, `cases` the current
 * case keys. The candidate needs a result for every case; a case that passed
 * on the accepted run must still pass, and a case the accepted run did not
 * pass must pass now. An empty set passes nothing: there is nothing to
 * compare. */
export function goldenSetGate(input: {
  cases: readonly { id: string }[];
  accepted: GoldenRun | null;
  candidate: GoldenRun;
}): GoldenGate {
  const { cases, accepted, candidate } = input;
  const gate: GoldenGate = {
    ok: false,
    reason: "passed",
    regressions: [],
    failing: [],
    missing: [],
  };
  if (!cases.length) return { ...gate, reason: "empty-set" };
  const now = new Map(candidate.results.map((result) => [result.id, result]));
  const before = new Map(
    (accepted?.results ?? []).map((result) => [result.id, result]),
  );
  for (const golden of cases) {
    const result = now.get(golden.id);
    if (!result) {
      gate.missing.push(golden.id);
      continue;
    }
    if (result.pass) continue;
    if (before.get(golden.id)?.pass) gate.regressions.push(golden.id);
    else gate.failing.push(golden.id);
  }
  if (gate.missing.length) return { ...gate, reason: "incomplete" };
  if (gate.regressions.length) return { ...gate, reason: "regression" };
  if (gate.failing.length) return { ...gate, reason: "new-case-failed" };
  return { ...gate, ok: true };
}
