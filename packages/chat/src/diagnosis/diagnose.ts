import { EvidenceBook, type Draft, type Outcome } from "./evidence";
import { evaluateEvm } from "./evm-rules";
import { cutAtWord } from "./format";
import { parseDiagnosisInput } from "./input";
import { memberTextRisk } from "./member-safety";
import { networkInfo } from "./networks";
import {
  DIAGNOSIS_ENGINE_VERSION,
  DIAGNOSIS_LIMITS,
  DiagnosisInputError,
  RULES,
} from "./rules";
import { evaluateSolana } from "./solana-rules";
import { isSolanaSignature } from "./subject";
import { NEXT_STEPS, nextStepText, renderMember } from "./templates";
import type {
  Diagnosis,
  DiagnosisInput,
  DiagnosisReadSource,
  Finding,
  StaffNextStep,
} from "./types";
import { HASH, ISO, isObj } from "./validate";

export { DiagnosisInputError } from "./rules";
export { parseDiagnosisInput } from "./input";
export { parseStoredDiagnosis } from "./stored";

const SEVERITY_RANK = { blocker: 0, warning: 1, info: 2 } as const;

function sortDrafts(drafts: readonly Draft[]): Draft[] {
  return drafts
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] ||
        RULES[a.item.rule].priority - RULES[b.item.rule].priority ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

/** Checks one value and never throws: a bad input becomes an unavailable
 * diagnosis with the rule dx.input-invalid. */
export function diagnose(value: unknown): Diagnosis {
  let input: DiagnosisInput;
  try {
    input = parseDiagnosisInput(value);
  } catch (error) {
    return invalidDiagnosis(value, error);
  }
  const book = new EvidenceBook(input.readSource);
  const outcome =
    input.kind === "evm"
      ? evaluateEvm(input, book)
      : evaluateSolana(input, book);
  return assemble(
    {
      readSource: input.readSource,
      kind: input.kind,
      subject: input.kind === "evm" ? input.hash : input.signature,
      checkedAt: input.checkedAt,
    },
    outcome,
    book,
  );
}

function invalidDiagnosis(value: unknown, error: unknown): Diagnosis {
  const raw = isObj(value) ? value : {};
  const kind = raw.kind === "solana" ? "solana" : "evm";
  const subjectValue = kind === "evm" ? raw.hash : raw.signature;
  const subject =
    typeof subjectValue === "string" &&
    (kind === "evm" ? HASH.test(subjectValue) : isSolanaSignature(subjectValue))
      ? subjectValue
      : "";
  const checkedAt =
    typeof raw.checkedAt === "string" && ISO.test(raw.checkedAt)
      ? raw.checkedAt
      : "";
  const code =
    error instanceof DiagnosisInputError ? error.code : "input-shape";
  const book = new EvidenceBook();
  book.add(
    "input",
    "Chain data",
    `Failed Templ's checks (${code})`,
    "",
    "derived",
    "Templ's checks of the chain data",
  );
  const text =
    "Couldn't check this transaction because the chain data Templ read failed its own checks.";
  const outcome: Outcome = {
    status: "unavailable",
    finality: null,
    network: null,
    category: "other",
    categorySource: null,
    drafts: [
      {
        rule: "dx.input-invalid",
        severity: "blocker",
        text,
        evidence: ["input"],
        nextStep: "ns.recheck",
        nextValues: {},
        member: "m.unavailable",
        slots: {},
        needsPerson: true,
        reason: null,
      },
    ],
  };
  return assemble({ kind, subject, checkedAt }, outcome, book);
}

type Head = {
  kind: "evm" | "solana";
  subject: string;
  checkedAt: string;
  readSource?: DiagnosisReadSource;
};

function assemble(head: Head, outcome: Outcome, book: EvidenceBook): Diagnosis {
  const sorted = sortDrafts(outcome.drafts).slice(0, DIAGNOSIS_LIMITS.findings);
  const entries = book.entries();
  const referenced = new Set(sorted.flatMap((item) => item.evidence));
  const ordered = [
    ...entries.filter((entry) => referenced.has(entry.row.id)),
    ...entries.filter((entry) => !referenced.has(entry.row.id)),
  ].slice(0, DIAGNOSIS_LIMITS.evidence);
  const rows = ordered.map((entry) => ({
    ...entry,
    row: { ...entry.row, value: cutAtWord(entry.row.value, 300) },
  }));
  const kept = new Set(rows.map((entry) => entry.row.id));
  const findings: Finding[] = sorted.map((item) => ({
    rule: item.rule,
    severity: item.severity,
    text: cutAtWord(item.text, DIAGNOSIS_LIMITS.staffTextChars),
    evidence: item.evidence.filter((id) => kept.has(id)),
  }));

  const defaults: Record<string, string | undefined> = {
    category: outcome.category === "other" ? "transaction" : outcome.category,
    explorer: outcome.network
      ? networkInfo(outcome.network)?.explorer
      : undefined,
  };
  const nextSteps: StaffNextStep[] = [];
  for (const item of sorted) {
    if (!item.nextStep || nextSteps.some((step) => step.id === item.nextStep))
      continue;
    if (nextSteps.length >= DIAGNOSIS_LIMITS.nextSteps) break;
    nextSteps.push({
      id: item.nextStep,
      text: nextStepText(item.nextStep, { ...defaults, ...item.nextValues }),
      needsNewTransaction: NEXT_STEPS[item.nextStep].needsNewTransaction,
    });
  }

  let member: Diagnosis["member"] = null;
  const main = sorted.find(
    (item) => item.member && item.member !== "m.other-network",
  );
  if (main && main.member) {
    let body = renderMember(main.member, main.slots);
    const prefix = sorted.find((item) => item.rule === "evm.other-network");
    if (body && prefix) {
      const lead = renderMember("m.other-network", prefix.slots);
      body = lead ? `${lead} ${body}` : null;
    }
    if (body && head.readSource)
      body = cutAtWord(
        `Alchemy reports: ${body}`,
        DIAGNOSIS_LIMITS.memberTextChars,
      );
    member = body
      ? {
          template: main.member,
          text: body,
          evidence: [
            ...new Set([
              ...(outcome.status === "failed" ? ["Transaction failed"] : []),
              ...(outcome.memberEvidence ?? []),
            ]),
          ].slice(0, 16),
        }
      : null;
  }
  let needsPerson =
    outcome.status === "unavailable" ||
    member === null ||
    outcome.drafts.some((item) => item.needsPerson);
  if (member && memberTextRisk(member.text) !== null) {
    member = null;
    needsPerson = true;
  }
  const reasonDraft = sorted.find((item) => item.reason !== null);
  const reason =
    outcome.status === "failed" ? (reasonDraft?.reason ?? "other") : null;

  const diagnosis: Diagnosis = {
    ...(head.readSource ? { readSource: head.readSource } : {}),
    v: 1,
    engine: DIAGNOSIS_ENGINE_VERSION,
    kind: head.kind,
    subject: head.subject,
    network: outcome.network,
    checkedAt: head.checkedAt,
    status: outcome.status,
    finality: outcome.finality,
    category: outcome.category,
    categorySource: outcome.categorySource,
    reason,
    needsPerson,
    staff: {
      whatHappened: findings[0]?.text ?? "",
      findings,
      evidence: rows.map((entry) => entry.row),
      nextSteps,
    },
    member,
    trimmed: false,
  };
  return trimDiagnosis(
    diagnosis,
    new Set(
      rows.filter((entry) => entry.movement).map((entry) => entry.row.id),
    ),
  );
}

/** Fits a diagnosis into `limit` JSON characters: drops evidence no finding
 * uses, then keeps six movement rows, then cuts finding texts to 240
 * characters at a word boundary, and as a last resort drops the lowest
 * findings. Sets `trimmed` when anything changed. */
export function trimDiagnosis(
  diagnosis: Diagnosis,
  movementIds: ReadonlySet<string>,
  limit: number = DIAGNOSIS_LIMITS.outputChars,
): Diagnosis {
  const size = (value: Diagnosis) => JSON.stringify(value).length;
  if (size(diagnosis) <= limit) return diagnosis;
  let findings = diagnosis.staff.findings;
  let evidence = diagnosis.staff.evidence;
  const build = (): Diagnosis => ({
    ...diagnosis,
    staff: {
      ...diagnosis.staff,
      whatHappened: findings[0]?.text ?? "",
      findings,
      evidence,
    },
    trimmed: true,
  });
  const used = () => new Set(findings.flatMap((item) => item.evidence));
  let referenced = used();
  evidence = evidence.filter((row) => referenced.has(row.id));
  if (size(build()) > limit) {
    const firsts = new Set(findings.map((item) => item.evidence[0]));
    let movements = 0;
    evidence = evidence.filter(
      (row) =>
        !movementIds.has(row.id) || firsts.has(row.id) || ++movements <= 6,
    );
    const left = new Set(evidence.map((row) => row.id));
    findings = findings.map((item) => ({
      ...item,
      evidence: item.evidence.filter((id) => left.has(id)),
    }));
  }
  if (size(build()) > limit)
    findings = findings.map((item) => ({
      ...item,
      text: cutAtWord(item.text, 240),
    }));
  while (size(build()) > limit && findings.length > 1) {
    findings = findings.slice(0, -1);
    referenced = used();
    evidence = evidence.filter((row) => referenced.has(row.id));
  }
  return build();
}
