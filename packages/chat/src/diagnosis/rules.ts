import type {
  DiagnosisEngineVersion,
  DiagnosisInputErrorCode,
  DiagnosisStatus,
  FailureReason,
  FindingSeverity,
  MemberTemplateId,
  NextStepId,
  RuleId,
} from "./types";

/** A change to any rule condition, template or table bumps this version. */
export const DIAGNOSIS_ENGINE_VERSION: DiagnosisEngineVersion = "dx-5";
/** Stored diagnoses from these engines keep the current output shape. */
export const SUPPORTED_STORED_ENGINES: readonly string[] = [
  "dx-1",
  "dx-2",
  "dx-3",
  "dx-4",
  "dx-5",
];

export const DIAGNOSIS_LIMITS = {
  inputChars: 262_144,
  observationChars: 300,
  probes: 8,
  logs: 256,
  logBytes: 131_072,
  logDataBytes: 16_384,
  revertDataBytes: 16_384,
  errorAbiItems: 256,
  methodArgs: 16,
  methodNested: 32,
  tokens: 16,
  codeFacts: 64,
  profileNetworks: 16,
  profileContractsPerNetwork: 50,
  solanaLogLines: 200,
  solanaLogLineChars: 512,
  solanaAccounts: 256,
  solanaInstructions: 64,
  solanaInnerPrograms: 64,
  solanaTokenBalances: 128,
  findings: 16,
  evidence: 48,
  movementsShown: 12,
  nextSteps: 2,
  contractTextChars: 200,
  staffTextChars: 480,
  memberTextChars: 600,
  outputChars: 24_576,
} as const;
/** A blockhash lives for 150 block heights; one extra for safety. */
export const SOLANA_BLOCKHASH_VALID_BLOCKS = 151;

export const DIAGNOSIS_STATUSES = [
  "confirmed",
  "failed",
  "pending",
  "replaced",
  "expired",
  "not-found",
  "unavailable",
  "disagree",
] as const satisfies readonly DiagnosisStatus[];

export const STATUS_CHIPS: Readonly<
  Record<
    DiagnosisStatus,
    { label: string; tone: "good" | "bad" | "wait" | "muted" }
  >
> = {
  confirmed: { label: "Succeeded", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  pending: { label: "Pending", tone: "wait" },
  replaced: { label: "Replaced", tone: "bad" },
  expired: { label: "Expired", tone: "bad" },
  "not-found": { label: "Not found", tone: "muted" },
  unavailable: { label: "Unavailable", tone: "muted" },
  disagree: { label: "Providers disagree", tone: "wait" },
};

export class DiagnosisInputError extends Error {
  readonly code: DiagnosisInputErrorCode;
  constructor(code: DiagnosisInputErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DiagnosisInputError";
    this.code = code;
  }
}

type RuleSpec = {
  network: "evm" | "solana" | "any";
  severity: FindingSeverity;
  priority: number;
  /** "by-reason" follows REASON_ACTIONS. */
  nextStep: NextStepId | "by-reason" | null;
  member: MemberTemplateId | "by-reason" | null;
  /** "reason-other": yes when the failure reason is other.
   *  "unlabeled": yes when the spender or delegate is not a labeled contract. */
  needsPerson: boolean | "reason-other" | "unlabeled";
};

const rule = (
  network: RuleSpec["network"],
  severity: FindingSeverity,
  priority: number,
  nextStep: RuleSpec["nextStep"],
  member: RuleSpec["member"],
  needsPerson: RuleSpec["needsPerson"],
): RuleSpec => ({
  network,
  severity,
  priority,
  nextStep,
  member,
  needsPerson,
});

/** The rule catalogue. Conditions live in evm-rules.ts and solana-rules.ts.
 * A rule whose next step, member template, severity or person flag depends
 * on the facts lists its default here and sets the value on the finding. */
export const RULES: Readonly<Record<RuleId, RuleSpec>> = {
  "dx.disagree": rule("any", "blocker", 0, "ns.escalate", null, true),
  "dx.unavailable": rule(
    "any",
    "blocker",
    0,
    "ns.recheck",
    "m.unavailable",
    true,
  ),
  "dx.input-invalid": rule(
    "any",
    "blocker",
    0,
    "ns.recheck",
    "m.unavailable",
    true,
  ),
  "dx.hint-mismatch": rule("any", "info", 90, null, null, false),
  "dx.wallet-signed-match": rule("any", "info", 80, null, null, false),
  "dx.wallet-claimed-match": rule("any", "info", 81, null, null, false),
  "dx.wallet-signed-mismatch": rule(
    "any",
    "warning",
    20,
    "ns.wallet-mismatch",
    null,
    true,
  ),
  "dx.wallet-claimed-mismatch": rule("any", "info", 82, null, null, false),
  "evm.not-found": rule(
    "evm",
    "info",
    52,
    "ns.not-found-wait",
    "m.not-found",
    false,
  ),
  "evm.probe-unavailable": rule(
    "evm",
    "warning",
    53,
    "ns.recheck",
    null,
    false,
  ),
  "evm.vanished": rule("evm", "info", 54, "ns.wait", null, false),
  "evm.other-network": rule(
    "evm",
    "warning",
    30,
    null,
    "m.other-network",
    false,
  ),
  "evm.unexpected-network": rule(
    "evm",
    "warning",
    4,
    "ns.unexpected-network",
    null,
    true,
  ),
  "evm.found-on-several": rule("evm", "info", 85, null, null, false),
  "evm.pending": rule("evm", "info", 51, "ns.wait", "m.pending", false),
  "evm.nonce-gap": rule(
    "evm",
    "warning",
    7,
    "ns.nonce-gap",
    "m.pending-behind",
    false,
  ),
  "evm.underpriced": rule(
    "evm",
    "warning",
    9,
    "ns.underpriced",
    "m.pending-low-fee",
    false,
  ),
  "evm.replaced": rule("evm", "blocker", 6, "ns.replaced", "m.replaced", false),
  "evm.revert.error-string": rule(
    "evm",
    "blocker",
    10,
    "by-reason",
    "by-reason",
    "reason-other",
  ),
  "evm.revert.panic": rule(
    "evm",
    "blocker",
    10,
    "ns.escalate",
    "m.failed",
    true,
  ),
  "evm.revert.custom-known": rule(
    "evm",
    "blocker",
    10,
    "by-reason",
    "by-reason",
    "reason-other",
  ),
  "evm.revert.custom-verified": rule(
    "evm",
    "blocker",
    11,
    "by-reason",
    "by-reason",
    "reason-other",
  ),
  "evm.revert.unknown-selector": rule(
    "evm",
    "blocker",
    12,
    "ns.escalate",
    "m.failed",
    true,
  ),
  "evm.revert.no-data": rule(
    "evm",
    "blocker",
    13,
    "ns.escalate",
    "m.failed",
    true,
  ),
  "evm.revert.not-reproduced": rule(
    "evm",
    "blocker",
    14,
    "ns.escalate",
    "m.failed",
    true,
  ),
  "evm.revert.no-replay": rule(
    "evm",
    "blocker",
    15,
    "ns.recheck",
    "m.failed",
    true,
  ),
  "evm.out-of-gas": rule(
    "evm",
    "blocker",
    5,
    "ns.out-of-gas",
    "m.failed-out-of-gas",
    false,
  ),
  "evm.succeeded": rule("evm", "info", 50, "ns.none", "m.confirmed", false),
  "evm.not-finalized": rule("evm", "info", 60, null, null, false),
  "evm.token-movement": rule("evm", "info", 70, null, null, false),
  "evm.approval-only": rule(
    "evm",
    "info",
    20,
    "ns.approval-only",
    "m.approval-only",
    false,
  ),
  "evm.unlimited-approval": rule(
    "evm",
    "warning",
    15,
    "ns.unlimited-approval",
    null,
    "unlabeled",
  ),
  "evm.vault-deposit": rule(
    "evm",
    "info",
    21,
    "ns.indexer",
    "m.deposit",
    false,
  ),
  "evm.vault-withdraw": rule(
    "evm",
    "info",
    22,
    "ns.indexer",
    "m.withdrawal",
    false,
  ),
  "evm.swap": rule("evm", "info", 23, "ns.indexer", "m.swap", false),
  "evm.no-movement": rule(
    "evm",
    "info",
    40,
    "ns.no-movement",
    "m.no-movement",
    false,
  ),
  "evm.call-to-empty-address": rule(
    "evm",
    "blocker",
    1,
    "ns.empty-address",
    "m.empty-address",
    true,
  ),
  "evm.recipient-code-elsewhere": rule(
    "evm",
    "warning",
    16,
    "ns.empty-address",
    null,
    true,
  ),
  "evm.sent-to-token-contract": rule(
    "evm",
    "blocker",
    2,
    "ns.sent-to-token",
    "m.sent-to-token",
    true,
  ),
  "evm.sent-to-protocol-contract": rule(
    "evm",
    "blocker",
    3,
    "ns.sent-to-protocol",
    "m.sent-to-protocol",
    true,
  ),
  "evm.bridge-source": rule(
    "evm",
    "info",
    24,
    "ns.bridge",
    "m.bridge-source",
    true,
  ),
  "evm.contract-creation": rule("evm", "info", 86, null, null, false),
  "evm.relayed-userop": rule("evm", "info", 84, null, null, false),
  "evm.userop-failed": rule(
    "evm",
    "blocker",
    8,
    "by-reason",
    "m.userop-failed",
    "reason-other",
  ),
  "evm.logs-truncated": rule("evm", "info", 95, null, null, false),
  "sol.not-found": rule(
    "solana",
    "info",
    52,
    "ns.sol-not-found",
    "m.not-found-sol",
    false,
  ),
  "sol.expired": rule("solana", "blocker", 6, "ns.expired", "m.expired", false),
  "sol.processed": rule("solana", "info", 51, "ns.wait", "m.processed", false),
  "sol.succeeded": rule(
    "solana",
    "info",
    50,
    "ns.none",
    "m.confirmed-sol",
    false,
  ),
  "sol.not-finalized": rule("solana", "info", 60, null, null, false),
  "sol.token-movement": rule("solana", "info", 70, null, null, false),
  "sol.sol-movement": rule("solana", "info", 71, null, null, false),
  "sol.swap": rule("solana", "info", 23, "ns.indexer", "m.swap-sol", false),
  "sol.approval-only": rule(
    "solana",
    "info",
    20,
    "ns.approval-only",
    "m.approval-only",
    false,
  ),
  "sol.unlimited-approval": rule(
    "solana",
    "warning",
    15,
    "ns.unlimited-approval",
    null,
    "unlabeled",
  ),
  "sol.program-error.anchor": rule(
    "solana",
    "blocker",
    10,
    "by-reason",
    "by-reason",
    "reason-other",
  ),
  "sol.program-error.known": rule(
    "solana",
    "blocker",
    10,
    "by-reason",
    "by-reason",
    "reason-other",
  ),
  "sol.program-error.custom": rule(
    "solana",
    "blocker",
    12,
    "ns.escalate",
    "m.failed",
    true,
  ),
  "sol.instruction-error": rule(
    "solana",
    "blocker",
    13,
    "by-reason",
    "by-reason",
    "reason-other",
  ),
  "sol.insufficient-funds": rule(
    "solana",
    "blocker",
    10,
    "ns.balance",
    "m.failed-sol-balance",
    false,
  ),
  "sol.compute-exceeded": rule(
    "solana",
    "blocker",
    5,
    "ns.compute",
    "m.failed-compute",
    false,
  ),
  "sol.insufficient-fee": rule(
    "solana",
    "blocker",
    10,
    "ns.balance",
    "m.failed-sol-balance",
    false,
  ),
  "sol.insufficient-rent": rule(
    "solana",
    "blocker",
    10,
    "ns.rent",
    "m.failed-rent",
    false,
  ),
  "sol.tx-error": rule(
    "solana",
    "blocker",
    14,
    "ns.escalate",
    "m.failed",
    true,
  ),
  "sol.fee": rule("solana", "info", 75, null, null, false),
  "sol.bridge-source": rule(
    "solana",
    "info",
    24,
    "ns.bridge",
    "m.bridge-source-sol",
    true,
  ),
  "sol.no-movement": rule(
    "solana",
    "info",
    40,
    "ns.no-movement",
    "m.no-movement-sol",
    false,
  ),
  "sol.logs-truncated": rule("solana", "info", 95, null, null, false),
};
export const RULE_IDS = Object.keys(RULES) as RuleId[];

/** Failure reason to staff next step and member template. */
export const REASON_ACTIONS: Readonly<
  Record<FailureReason, { nextStep: NextStepId; member: MemberTemplateId }>
> = {
  slippage: { nextStep: "ns.slippage", member: "m.failed-slippage" },
  deadline: { nextStep: "ns.deadline", member: "m.failed-deadline" },
  allowance: { nextStep: "ns.allowance", member: "m.failed-allowance" },
  balance: { nextStep: "ns.balance", member: "m.failed-balance" },
  "fee-balance": { nextStep: "ns.balance", member: "m.failed-sol-balance" },
  rent: { nextStep: "ns.rent", member: "m.failed-rent" },
  "vault-limit": { nextStep: "ns.vault-limit", member: "m.failed-vault-limit" },
  paused: { nextStep: "ns.paused", member: "m.failed-paused" },
  unauthorized: { nextStep: "ns.unauthorized", member: "m.failed" },
  signature: { nextStep: "ns.signature", member: "m.failed" },
  "transfer-failed": { nextStep: "ns.escalate", member: "m.failed" },
  "out-of-gas": { nextStep: "ns.out-of-gas", member: "m.failed-out-of-gas" },
  compute: { nextStep: "ns.compute", member: "m.failed-compute" },
  arithmetic: { nextStep: "ns.escalate", member: "m.failed" },
  other: { nextStep: "ns.escalate", member: "m.failed" },
};
