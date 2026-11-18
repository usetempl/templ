import { REASON_ACTIONS, RULES } from "./rules";
import type { MemberSlots } from "./templates";
import type {
  CategorySource,
  DiagnosisCategory,
  DiagnosisNetwork,
  DiagnosisReadSource,
  DiagnosisStatus,
  Evidence,
  EvidenceSourceKind,
  FailureReason,
  FindingSeverity,
  MemberTemplateId,
  NetworkHint,
  NextStepId,
  RuleId,
  VerifiedAbiSource,
} from "./types";

/** A finding before sorting, with the facts the assembly step needs. */
export type Draft = {
  rule: RuleId;
  severity: FindingSeverity;
  text: string;
  evidence: string[];
  nextStep: NextStepId | null;
  nextValues: Record<string, string | undefined>;
  member: MemberTemplateId | null;
  slots: MemberSlots;
  needsPerson: boolean;
  reason: FailureReason | null;
};

export type DraftOptions = {
  severity?: FindingSeverity;
  nextStep?: NextStepId | null;
  nextValues?: Record<string, string | undefined>;
  member?: MemberTemplateId | null;
  slots?: MemberSlots;
  needsPerson?: boolean;
  reason?: FailureReason | null;
};

/** Builds a finding with the catalogue's defaults. A "by-reason" rule takes
 * its next step and member template from REASON_ACTIONS, and a
 * "reason-other" rule needs a person exactly when the reason is other. */
export function draft(
  rule: RuleId,
  text: string,
  evidence: string[],
  options: DraftOptions = {},
): Draft {
  const spec = RULES[rule];
  const reason = options.reason ?? null;
  const action = REASON_ACTIONS[reason ?? "other"];
  const nextStep =
    options.nextStep !== undefined
      ? options.nextStep
      : spec.nextStep === "by-reason"
        ? action.nextStep
        : spec.nextStep;
  const member =
    options.member !== undefined
      ? options.member
      : spec.member === "by-reason"
        ? action.member
        : spec.member;
  const needsPerson =
    options.needsPerson !== undefined
      ? options.needsPerson
      : spec.needsPerson === "reason-other"
        ? (reason ?? "other") === "other"
        : spec.needsPerson === "unlabeled"
          ? true
          : spec.needsPerson;
  return {
    rule,
    severity: options.severity ?? spec.severity,
    text,
    evidence: evidence.filter((id, index) => evidence.indexOf(id) === index),
    nextStep,
    nextValues: options.nextValues ?? {},
    member,
    slots: options.slots ?? {},
    needsPerson,
    reason,
  };
}

export type Outcome = {
  status: DiagnosisStatus;
  finality: "final" | "not-final" | null;
  network: DiagnosisNetwork | null;
  category: DiagnosisCategory;
  categorySource: CategorySource | null;
  drafts: Draft[];
  memberEvidence?: string[];
};

type Row = { row: Evidence; movement: boolean };

/** Evidence rows, keyed by id. The first row added under an id wins. */
export class EvidenceBook {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly readSource?: DiagnosisReadSource) {}

  add(
    id: string,
    label: string,
    value: string,
    fact: string,
    source: EvidenceSourceKind,
    sourceLabel: string,
    movement = false,
  ): string {
    if (
      this.readSource &&
      ["agreed", "seen", "replay", "program-log", "read-window"].includes(
        source,
      )
    ) {
      source = "provider";
      sourceLabel = sourceLabel.includes("both providers agreed")
        ? sourceLabel.replace(
            "both providers agreed",
            "reported by Alchemy; one provider",
          )
        : "Reported by Alchemy; one provider";
    }
    if (!this.rows.has(id))
      this.rows.set(id, {
        row: { id, label, value, fact, source, sourceLabel },
        movement,
      });
    return id;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  entries(): Row[] {
    return [...this.rows.values()];
  }
}

const ABI_SOURCES: Readonly<Record<VerifiedAbiSource, string>> = {
  sourcify: "Sourcify",
  blockscout: "Robinhood Blockscout",
  etherscan: "Etherscan",
};
const HINT_SOURCES: Readonly<Record<NetworkHint["source"], string>> = {
  "member-context": "Picked by the user",
  "wallet-chain": "The network of the user's wallet",
  "explorer-link": "From the explorer link",
  staff: "Picked by staff",
};

/** Evidence source labels shown to staff. */
export const SOURCE = {
  agreedBlock: (network: string, block: string) =>
    `${network} block ${block}, both providers agreed`,
  agreedHead: (network: string, block: string) =>
    `${network} latest block ${block}, both providers agreed`,
  seen: (count: number) => `Seen by ${count} of 2 providers, not agreed`,
  replay: (network: string, block: string) =>
    `Replayed on ${network} at block ${block}, both providers agreed`,
  builtinAbi: "Templ's built-in ABI",
  verifiedAbi: (source: VerifiedAbiSource) =>
    `Verified source on ${ABI_SOURCES[source]}`,
  builtinList: "Templ's reviewed address list",
  workspaceLabel: "The workspace profile",
  contractClaimed: "The contract's own name for itself",
  contractText: "The contract's own message",
  programLog: "Program log, both providers agreed",
  signedWallet: "Signed in with this wallet",
  memberClaim: "Reported by the user's app, not proven",
  memberHint: (source: NetworkHint["source"]) => HINT_SOURCES[source],
  derived: "Worked out from the rows above",
  reader: "Reported by Templ's chain reader",
  readWindow: "Block heights read by Templ, both providers agreed",
  solanaAgreed: (slot: string, commitment: string) =>
    `Solana slot ${slot}, both providers agreed (${commitment})`,
} as const;
