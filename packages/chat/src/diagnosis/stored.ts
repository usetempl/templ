import { parseDiagnosisReadSource } from "./input";
import { memberTextRisk } from "./member-safety";
import {
  DIAGNOSIS_ENGINE_VERSION,
  DIAGNOSIS_LIMITS,
  DIAGNOSIS_STATUSES,
  RULE_IDS,
  SUPPORTED_STORED_ENGINES,
} from "./rules";
import { isSolanaSignature } from "./subject";
import { MEMBER_TEMPLATES, NEXT_STEPS } from "./templates";
import type { Diagnosis, Evidence, Finding, StaffNextStep } from "./types";
import {
  HASH,
  bool,
  fail,
  iso,
  list,
  network,
  nullable,
  obj,
  oneOf,
  text,
} from "./validate";

const FINDING_SEVERITIES = ["blocker", "warning", "info"];
const CATEGORIES = [
  "deposit",
  "withdrawal",
  "swap",
  "approval",
  "bridge",
  "transfer",
  "other",
];
const CATEGORY_SOURCES = [
  "event",
  "builtin-method",
  "workspace-label",
  "method-name",
];
const REASONS = [
  "slippage",
  "deadline",
  "allowance",
  "balance",
  "fee-balance",
  "rent",
  "vault-limit",
  "paused",
  "unauthorized",
  "signature",
  "transfer-failed",
  "out-of-gas",
  "compute",
  "arithmetic",
  "other",
];
const SOURCE_KINDS = [
  "provider",
  "observation",
  "agreed",
  "seen",
  "replay",
  "builtin-abi",
  "verified-abi",
  "program-log",
  "builtin-list",
  "workspace-label",
  "contract-claimed",
  "contract-text",
  "signed-wallet",
  "member-claim",
  "member-hint",
  "derived",
  "read-window",
];

/** Validates a stored diagnosis. Any problem returns null, so a partial
 * record is never rendered. The member draft is checked again. */
export function parseStoredDiagnosis(value: unknown): Diagnosis | null {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string" || json.length > DIAGNOSIS_LIMITS.outputChars)
      return null;
    const o = obj(
      value,
      "",
      [
        "v",
        "engine",
        "kind",
        "subject",
        "network",
        "checkedAt",
        "status",
        "finality",
        "category",
        "categorySource",
        "reason",
        "needsPerson",
        "staff",
        "member",
        "trimmed",
      ],
      ["readSource"],
    );
    if (
      o.v !== 1 ||
      typeof o.engine !== "string" ||
      !SUPPORTED_STORED_ENGINES.includes(o.engine)
    )
      return null;
    const kind = oneOf(o.kind, "/kind", ["evm", "solana"] as const);
    const subject = text(o.subject, "/subject", null, 100);
    if (
      subject !== "" &&
      !(kind === "evm" ? HASH.test(subject) : isSolanaSignature(subject))
    )
      return null;
    const checkedAt = o.checkedAt === "" ? "" : iso(o.checkedAt, "/checkedAt");
    const staff = obj(o.staff, "/staff", [
      "whatHappened",
      "findings",
      "evidence",
      "nextSteps",
    ]);
    const evidence: Evidence[] = list(
      staff.evidence,
      "/staff/evidence",
      DIAGNOSIS_LIMITS.evidence,
    ).map((item, index) => {
      const e = obj(item, `/staff/evidence/${index}`, [
        "id",
        "label",
        "value",
        "fact",
        "source",
        "sourceLabel",
      ]);
      return {
        id: text(e.id, "/id", null, 160),
        label: text(e.label, "/label", null, 120),
        value: text(e.value, "/value", null, 400),
        fact: text(e.fact, "/fact", /^(?:\/[A-Za-z0-9]+)*$/, 120),
        source: oneOf(e.source, "/source", SOURCE_KINDS) as Evidence["source"],
        sourceLabel: text(e.sourceLabel, "/sourceLabel", null, 160),
      };
    });
    const readSource =
      o.readSource === undefined
        ? undefined
        : parseDiagnosisReadSource(o.readSource);
    if (
      evidence.some(
        (row) =>
          row.source === "provider" &&
          (!readSource || !row.sourceLabel.includes("Alchemy")),
      )
    )
      return null;
    if (
      readSource &&
      evidence.some(
        (row) =>
          ["agreed", "seen", "replay", "program-log", "read-window"].includes(
            row.source,
          ) || row.sourceLabel.includes("both providers agreed"),
      )
    )
      return null;
    const ids = new Set(evidence.map((item) => item.id));
    const findings: Finding[] = list(
      staff.findings,
      "/staff/findings",
      DIAGNOSIS_LIMITS.findings,
    ).map((item, index) => {
      const f = obj(item, `/staff/findings/${index}`, [
        "rule",
        "severity",
        "text",
        "evidence",
      ]);
      const refs = list(
        f.evidence,
        "/evidence",
        DIAGNOSIS_LIMITS.evidence,
        1,
      ).map((id) => text(id, "/evidence", null, 160));
      if (!refs.every((id) => ids.has(id)))
        fail("input-agreement", "/evidence");
      return {
        rule: oneOf(f.rule, "/rule", RULE_IDS),
        severity: oneOf(
          f.severity,
          "/severity",
          FINDING_SEVERITIES,
        ) as Finding["severity"],
        text: text(f.text, "/text", null, DIAGNOSIS_LIMITS.staffTextChars),
        evidence: refs,
      };
    });
    const nextIds = Object.keys(NEXT_STEPS);
    const nextSteps: StaffNextStep[] = list(
      staff.nextSteps,
      "/staff/nextSteps",
      DIAGNOSIS_LIMITS.nextSteps,
    ).map((item, index) => {
      const n = obj(item, `/staff/nextSteps/${index}`, [
        "id",
        "text",
        "needsNewTransaction",
      ]);
      return {
        id: oneOf(n.id, "/id", nextIds) as StaffNextStep["id"],
        text: text(n.text, "/text", null, DIAGNOSIS_LIMITS.staffTextChars),
        needsNewTransaction: bool(
          n.needsNewTransaction,
          "/needsNewTransaction",
        ),
      };
    });
    const member = nullable(o.member, (item) => {
      const m = obj(item, "/member", ["template", "text", "evidence"]);
      const textValue = text(
        m.text,
        "/member/text",
        null,
        DIAGNOSIS_LIMITS.memberTextChars,
      );
      if (memberTextRisk(textValue) !== null)
        fail("input-shape", "/member/text");
      return {
        template: oneOf(
          m.template,
          "/member/template",
          Object.keys(MEMBER_TEMPLATES),
        ) as NonNullable<Diagnosis["member"]>["template"],
        text: textValue,
        ...(m.evidence !== undefined
          ? {
              evidence: list(m.evidence, "/member/evidence", 16).map(
                (value) => {
                  const line = text(value, "/member/evidence", null, 100);
                  if (
                    line !== "Transaction failed" &&
                    !/^[A-Za-z0-9.+-]{1,12} stayed in your wallet$/.test(line)
                  )
                    fail("input-shape", "/member/evidence");
                  return line;
                },
              ),
            }
          : {}),
      };
    });
    return {
      ...(o.readSource === undefined
        ? {}
        : { readSource: parseDiagnosisReadSource(o.readSource) }),
      v: 1,
      engine: DIAGNOSIS_ENGINE_VERSION,
      kind,
      subject,
      network: nullable(o.network, (item) => network(item, "/network")),
      checkedAt,
      status: oneOf(o.status, "/status", DIAGNOSIS_STATUSES),
      finality: nullable(o.finality, (item) =>
        oneOf(item, "/finality", ["final", "not-final"] as const),
      ),
      category: oneOf(
        o.category,
        "/category",
        CATEGORIES,
      ) as Diagnosis["category"],
      categorySource: nullable(
        o.categorySource,
        (item) =>
          oneOf(item, "/categorySource", CATEGORY_SOURCES) as NonNullable<
            Diagnosis["categorySource"]
          >,
      ),
      reason: nullable(
        o.reason,
        (item) =>
          oneOf(item, "/reason", REASONS) as NonNullable<Diagnosis["reason"]>,
      ),
      needsPerson: bool(o.needsPerson, "/needsPerson"),
      staff: {
        whatHappened: text(
          staff.whatHappened,
          "/staff/whatHappened",
          null,
          DIAGNOSIS_LIMITS.staffTextChars,
        ),
        findings,
        evidence,
        nextSteps,
      },
      member,
      trimmed: bool(o.trimmed, "/trimmed"),
    };
  } catch {
    return null;
  }
}
