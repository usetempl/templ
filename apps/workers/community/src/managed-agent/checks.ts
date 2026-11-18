/** The checks every managed AI reply passes before the room stores it. The
 * room runs them on the managed account's own write (a message or a draft)
 * and on a person's dry run from the settings page; the runner runs the same
 * function before it writes, so a refusal costs no room write.
 *
 * - Citations: every figure the reply states cites a standing evidence row
 *   of the case right after it (`checkCitations`), whatever the workspace's
 *   own citation setting is. An uncited figure, or a marker naming an
 *   unknown, withdrawn or superseded row, is refused.
 * - Metric claims: every cited figure belongs to a claim on the row it
 *   cites, with the same number, and the claims pass `checkMetricClaims`
 *   against the profile's metric definitions and the case's evidence rows.
 *   A comparison across metrics, products or windows is refused (409
 *   `metric-claim-refused`), and the runner hands the request to a person.
 * - One clarifying question per member request (409 `clarify-used`).
 *
 * These checks never grant anything; they only refuse. */
import {
  amountsIn,
  checkMetricClaims,
  checkedMetricClaim,
  sameAmount,
  type MetricClaim,
  type MetricClaimProblem,
  type MetricEvidenceRow,
  type MetricKeyBinding,
} from "@templ/chat/metric-keys";
import {
  checkCitations,
  findFigures,
  stripCitationMarkers,
  type CitationProblemKind,
  type CitableDiagnosis,
} from "@templ/chat/support-citations";
import { MANAGED_AGENT_LIMITS } from "@templ/chat/managed-agent";
import { HttpError } from "../common";

/** What a managed write carries beside its text, in `body.managed`. */
export type ManagedReplyMeta = {
  claims: MetricClaim[];
  comparisons: [number, number][];
  clarifying: boolean;
};
export function checkedReplyMeta(raw: unknown): ManagedReplyMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "claims,clarifying,comparisons")
    return null;
  if (!Array.isArray(value.claims) || !Array.isArray(value.comparisons)) return null;
  if (typeof value.clarifying !== "boolean") return null;
  const claims: MetricClaim[] = [];
  for (const raw of value.claims) {
    const claim = checkedMetricClaim(raw);
    if (!claim) return null;
    claims.push(claim);
  }
  const comparisons: [number, number][] = [];
  for (const pair of value.comparisons) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !pair.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
    )
      return null;
    comparisons.push([pair[0] as number, pair[1] as number]);
  }
  return { claims, comparisons, clarifying: value.clarifying };
}

export type ManagedReplyVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "metric-claim-refused";
      problems: MetricClaimProblem[];
    }
  | { ok: false; reason: "clarify-used" };

/** The verdict on one managed reply. `clarifyingAsked` counts the clarifying
 * questions the managed account already sent on this member request. */
export function managedReplyVerdict(input: {
  text: string;
  meta: ManagedReplyMeta;
  bindings: ReadonlyMap<string, MetricKeyBinding>;
  evidence: readonly MetricEvidenceRow[];
  diagnoses?: readonly CitableDiagnosis[];
  clarifyingAsked: number;
}): ManagedReplyVerdict {
  const { meta } = input;
  if (
    meta.clarifying &&
    input.clarifyingAsked >= MANAGED_AGENT_LIMITS.clarifyingPerCase
  )
    return { ok: false, reason: "clarify-used" };
  const plain = stripCitationMarkers(input.text).text;
  const problems: MetricClaimProblem[] = [];
  // A clarifying question may repeat the member's own number back to them;
  // any other figure needs a citation and a claim.
  if (!meta.clarifying)
    problems.push(...figureProblems(input.text, meta.claims, input.evidence, input.diagnoses));
  if (meta.clarifying && meta.claims.length)
    problems.push({ kind: "invalid-claim", claims: [] });
  problems.push(
    ...checkMetricClaims({
      claims: meta.claims,
      comparisons: meta.comparisons,
      text: plain,
      bindings: input.bindings,
      evidence: input.evidence,
    }),
  );
  return problems.length
    ? { ok: false, reason: "metric-claim-refused", problems }
    : { ok: true };
}

/** Citation problems that refuse a managed reply. The mix and comparison
 * labels are left to the claim checks, which know each figure's metric,
 * product and window. */
const REFUSED_CITATIONS: ReadonlySet<CitationProblemKind> = new Set([
  "uncited-figure",
  "unknown-evidence",
  "withdrawn-evidence",
  "superseded-evidence",
  "too-many-citations",
  "no-case",
  "evidence-unreadable",
  "unknown-diagnosis",
  "diagnosis-figure-not-in-check",
]);

/** Every figure cites a standing row, and every cited figure is one claim's
 * value on a row that claim names. */
function figureProblems(
  text: string,
  claims: readonly MetricClaim[],
  evidence: readonly MetricEvidenceRow[],
  diagnoses?: readonly CitableDiagnosis[],
): MetricClaimProblem[] {
  const problems: MetricClaimProblem[] = [];
  const cited = checkCitations(text, evidence, diagnoses);
  for (const problem of cited.problems) {
    if (!REFUSED_CITATIONS.has(problem.kind)) continue;
    problems.push({
      kind:
        problem.kind === "uncited-figure" || problem.kind === "no-case"
          ? "uncited-claim"
          : "claim-evidence-mismatch",
      claims: [],
    });
  }
  const { text: body, markers } = stripCitationMarkers(text);
  const figures = findFigures(body);
  figures.forEach((figure, index) => {
    const next = figures[index + 1];
    const marker = markers.find(
      (entry) =>
        entry.at >= figure.end &&
        !/[.!?]\s|\n/.test(body.slice(figure.end, entry.at)) &&
        !(next && next.start < entry.at),
    );
    // An uncited figure is already refused above.
    if (!marker || marker.dx?.length) return;
    const said = amountsIn(figure.text)[0];
    const owners = claims.filter(
      (claim) =>
        claim.evidence.some((n) => marker.ids.includes(n)) &&
        said !== undefined &&
        amountsIn(claim.value).some((value) => sameAmount(value, said)),
    );
    if (!owners.length) problems.push({ kind: "uncited-claim", claims: [] });
  });
  return problems;
}

/** The refusal the room answers with. */
export function verdictError(verdict: Exclude<ManagedReplyVerdict, { ok: true }>) {
  return verdict.reason === "clarify-used"
    ? new HttpError(
        409,
        "The AI agent already asked 1 question on this case. A person needs to answer next.",
        undefined,
        "clarify-used",
      )
    : new HttpError(
        409,
        "This reply compares or states numbers its evidence doesn't support. A person takes it from here.",
        undefined,
        "metric-claim-refused",
      );
}
