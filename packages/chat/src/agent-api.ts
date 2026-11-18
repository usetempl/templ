/** The Agent API contract: its versions, the features each version adds,
 * and the pure input and response checks the Node client applies to the
 * version 1.1 routes (cases, frames, evidence, Ask AI drafts, follow-ups,
 * transaction check facts, reply labels, eval runs and the pulse).
 *
 * The API is the set of worker routes and fields that the Agent API reference
 * documents. A minor version only adds routes, fields, enum values and
 * reasons; clients ignore unknown fields and treat an unknown reason like an
 * unknown error. `/api/status` publishes the live version as
 * `agents.api.version`, computed from the release flags, never hand-set.
 *
 * Browser-safe and free of relative runtime imports other than
 * ./support-citations, so the generated agent client inlines it. */
import {
  CITATION_PROBLEM_KINDS,
  type CitationProblem,
} from "./support-citations";
import type {
  SupportProduct,
  SupportReported,
  SupportTag,
  SupportWindow,
} from "./support-evidence";
import type { SupportNetwork } from "./support";

export const AGENT_API_MAJOR = 1;
export const AGENT_API_VERSIONS = ["1.0", "1.1"] as const;
export type AgentApiVersion = (typeof AGENT_API_VERSIONS)[number];
/** Features by version. Each version lists every feature it serves. */
export const AGENT_API_FEATURES: Readonly<
  Record<AgentApiVersion, readonly string[]>
> = Object.freeze({
  "1.0": Object.freeze([
    "sign-in",
    "queue",
    "needs-reply",
    "needs-person",
    "thread",
    "workflow",
    "reply-if-latest",
    "note",
    "handoff",
    "typing",
    "resolve",
    "events",
  ]),
  "1.1": Object.freeze([
    "sign-in",
    "queue",
    "needs-reply",
    "needs-person",
    "thread",
    "workflow",
    "reply-if-latest",
    "note",
    "handoff",
    "typing",
    "resolve",
    "events",
    "cases",
    "frame",
    "evidence",
    "citations",
    "draft-requests",
    "drafts",
    "provenance",
    "follow-ups",
    "transaction-checks",
    "reply-labels",
    "eval-runs",
    "pulse",
  ]),
});
export function isAgentApiVersion(value: unknown): value is AgentApiVersion {
  return (AGENT_API_VERSIONS as readonly unknown[]).includes(value);
}
/** Features of a version, or none when no version is live. */
export function agentApiFeatures(
  version: AgentApiVersion | null,
): readonly string[] {
  return version === null ? [] : AGENT_API_FEATURES[version];
}

/** The fields a frame change sets, as the service reads them: the network
 * as a network id (or an EVM chain id) and the question as text. */
export type AgentFrameInput = Partial<{
  product: SupportProduct;
  network: SupportNetwork | number;
  metric: SupportTag;
  window: SupportWindow;
  reported: SupportReported;
  question: string;
}>;

/** A 422 `reply-held` answer: the workspace holds AI agent replies whose
 * figures fail the citation check, so the reply became a draft for the
 * team. Nothing was sent or counted. */
export type AgentReplyHeld = {
  /** The held draft's id: the reply's clientId. */
  draft: string;
  /** The request number the draft belongs to. */
  case: number;
  problems: CitationProblem[];
};
const UUID_V7 =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** The `held` field of a refused reply, or null unless the reason is
 * `reply-held` and the shape is exactly as documented. */
export function parseReplyHeld(
  reason: string | null,
  body: unknown,
): AgentReplyHeld | null {
  if (reason !== "reply-held" || !isRecordValue(body)) return null;
  const held = body.held;
  if (!isRecordValue(held)) return null;
  const { draft, problems } = held;
  const seq = held.case;
  if (
    typeof draft !== "string" ||
    !UUID_V7.test(draft) ||
    !Number.isSafeInteger(seq) ||
    (seq as number) < 1 ||
    !Array.isArray(problems) ||
    problems.length > 100 ||
    !problems.every(
      (problem) =>
        isRecordValue(problem) &&
        (CITATION_PROBLEM_KINDS as readonly unknown[]).includes(problem.kind),
    )
  )
    return null;
  return {
    draft,
    case: seq as number,
    problems: problems as CitationProblem[],
  };
}

/** A request number of a thread: a positive integer. */
export function caseNumber(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 99_999_999
  )
    throw new Error("Use a request number from the case list.");
  return value as number;
}
/** An evidence row number within a request. */
export function evidenceNumber(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 9_999
  )
    throw new Error("Use an evidence row number from the request.");
  return value as number;
}
/** A follow-up id: `<request>-<n>`. */
export function followUpIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,7}-[1-9][0-9]?$/.test(value))
    throw new Error("Use a follow-up id from the follow-up list.");
  return value;
}
/** A transaction check id: `dx-` and 16 lowercase hex. */
export function diagnosisIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^dx-[0-9a-f]{16}$/.test(value))
    throw new Error("Use a check id from the check list.");
  return value;
}
/** An eval run id: `run-` and 16 lowercase hex. */
export function evalRunIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^run-[0-9a-f]{16}$/.test(value))
    throw new Error("Use an eval run id.");
  return value;
}
/** Opaque page cursors the service hands out. */
export function pageCursor(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    throw new Error("Invalid page cursor.");
  return value;
}
/** A JSON object body the service validates in full. The client refuses
 * anything that is not a plain object of JSON values. */
export function jsonObject(value: unknown, what: string) {
  if (!isRecordValue(value)) throw new Error(`Send ${what} as an object.`);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error(`Send ${what} as JSON.`);
  }
  if (new TextEncoder().encode(text).length > 64_000)
    throw new Error(`${what} is too large.`);
  return JSON.parse(text) as Record<string, unknown>;
}
