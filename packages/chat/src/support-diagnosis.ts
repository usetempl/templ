/** Transaction diagnosis read shapes and [dx:<id>] citation targets for the inbox, AI agents and follow-ups. Browser-safe: facts only, never next steps, no RPC.
 *
 * A check reads a shared transaction and records its source policy with what
 * happened. Its result is team-only, like a note: members never see it, and
 * it is left out of every export. People on the team also get the engine's
 * next steps; a registered AI agent gets facts, the member draft and the
 * claim set it may restate. Handoff steps stay in a separate field.
 * Nothing here reads a chain or
 * can cause a signature or a transaction.
 *
 * Types and pure helpers only, with no imports, so the web and the agent
 * client can load it. It never imports ./diagnosis/*: the status and
 * category unions are copies of the engine's types. */

export const SUPPORT_DIAGNOSIS_TRIGGERS = [
  "staff",
  "agent",
  "member-share",
  "ask-ai",
] as const;
export type SupportDiagnosisTrigger =
  (typeof SUPPORT_DIAGNOSIS_TRIGGERS)[number];
export const SUPPORT_DIAGNOSIS_RATINGS = [
  "correct",
  "incomplete",
  "wrong",
] as const;
export type SupportDiagnosisRating = (typeof SUPPORT_DIAGNOSIS_RATINGS)[number];
export const SUPPORT_DIAGNOSIS_STATUSES = [
  "confirmed",
  "failed",
  "pending",
  "replaced",
  "expired",
  "not-found",
  "unavailable",
  "disagree",
] as const;
export type SupportDiagnosisStatus =
  (typeof SUPPORT_DIAGNOSIS_STATUSES)[number];
export const SUPPORT_DIAGNOSIS_CATEGORIES = [
  "deposit",
  "withdrawal",
  "swap",
  "approval",
  "bridge",
  "transfer",
  "other",
] as const;
export type SupportDiagnosisCategory =
  (typeof SUPPORT_DIAGNOSIS_CATEGORIES)[number];
export type SupportDiagnosisFinality = "final" | "not-final" | null;

/** No subject is read twice in one chat within this window, forced or not. */
export const DIAGNOSIS_MIN_RERUN_MS = 15_000;
/** How long a stored check counts as fresh. A fresh check is returned as it
 * is; a stale one runs again when someone asks. Final results stay fresh
 * until the request closes (Infinity here). */
export function diagnosisFreshForMs(
  status: SupportDiagnosisStatus,
  finality: SupportDiagnosisFinality,
): number {
  switch (status) {
    case "confirmed":
    case "failed":
      return finality === "final" ? Infinity : 5 * 60_000;
    case "replaced":
      return 10 * 60_000;
    case "expired":
      return Infinity;
    case "not-found":
      return 60_000;
    case "pending":
    case "unavailable":
    case "disagree":
      return 30_000;
  }
}

/** "dx-" and 16 lowercase hex: the id a [dx:<id>] citation names. */
export const DIAGNOSIS_ID = /^dx-[0-9a-f]{16}$/;
export function isDiagnosisId(value: unknown): value is string {
  return typeof value === "string" && DIAGNOSIS_ID.test(value);
}

export type SupportDiagnosisSection = "app" | "chain" | "reading" | "unknown";
/** The source of a fact decides its section; display text never does. */
export function diagnosisEvidenceSection(
  source: string,
): SupportDiagnosisSection {
  if (["member-claim", "member-hint", "signed-wallet"].includes(source))
    return "app";
  if (
    [
      "agreed",
      "provider",
      "seen",
      "observation",
      "replay",
      "program-log",
      "contract-text",
      "contract-claimed",
      "read-window",
    ].includes(source)
  )
    return "chain";
  return "reading";
}

export type SupportDiagnosisChip = {
  label: string;
  tone: "good" | "bad" | "wait" | "muted";
};
export type SupportDiagnosisView = {
  readSource?: { providerCount: 1; source: "alchemy" };
  id: string;
  case: number;
  run: number;
  trigger: SupportDiagnosisTrigger;
  /** The person or agent who ran it; null for an automatic run. */
  by: string | null;
  at: string;
  subject:
    | { kind: "evm"; hash: string }
    | { kind: "solana"; signature: string };
  network: { id: string; name: string } | null;
  /** The explorer page of the transaction, https only. */
  explorer: string | null;
  status: SupportDiagnosisStatus;
  chip: SupportDiagnosisChip;
  finality: SupportDiagnosisFinality;
  category: SupportDiagnosisCategory;
  reason: string | null;
  /** The engine could not settle it; a person on the team should answer. */
  needsPerson: boolean;
  whatHappened: string;
  findings: {
    rule: string;
    severity: "blocker" | "warning" | "info";
    text: string;
    evidence: string[];
  }[];
  evidence: {
    id: string;
    label: string;
    value: string;
    source: string;
    sourceLabel: string;
    section?: SupportDiagnosisSection;
    observedAt?: string;
  }[];
  /** People on the team only. */
  nextSteps?: { id: string; text: string; needsNewTransaction: boolean }[];
  /** Registered AI agents only: the values a reply may restate. */
  claims?: {
    status: string;
    networks: string[];
    numbers: string[];
    tokens: string[];
    shortRefs: string[];
  };
  /** A draft a person may put in the composer. Never sent by Templ. */
  memberDraft: string | null;
  /** Short facts safe to show under a reply that cites this check. */
  memberEvidence?: string[];
  /** Registered agents only, when this check needs a person. Never reply text. */
  handoff?: {
    nextSteps: { id: string; text: string; needsNewTransaction: boolean }[];
  };
  fresh: boolean;
  trimmed: boolean;
  rating: { rating: SupportDiagnosisRating; at: string } | null;
};
export type SupportDiagnosisList = {
  schemaVersion: 1;
  /** Checks can run in this workspace now. */
  enabled: boolean;
  /** Networks Templ reads, in probe order. */
  networks: { id: string; name: string }[];
  /** Newest first, at most three. */
  diagnoses: SupportDiagnosisView[];
  /** Saved checks that can't be shown. */
  unreadable: number;
  running: { subject: string; trigger: string; startedAt: string } | null;
  /** A shared value looked like a private key and was removed. */
  refusal: { at: string } | null;
  limits: { roomLeftToday: number; threadLeftToday: number };
};
/** Reasons a diagnosis route gives with its error, for clients. */
export const SUPPORT_DIAGNOSIS_ERROR_REASONS = [
  "diagnosis-unavailable",
  "diagnosis-network-off",
  "diagnosis-not-found",
  "diagnosis-busy",
  "diagnosis-too-soon",
  "diagnosis-limit",
  "diagnosis-lease-expired",
  "diagnosis-input-mismatch",
  "support-paused",
  "secret-refused",
  "invalid-transaction",
  "invalid-network",
  "invalid-client-id",
  "invalid-rating",
  "person-only",
] as const;
export type SupportDiagnosisErrorReason =
  (typeof SUPPORT_DIAGNOSIS_ERROR_REASONS)[number];

/** A request id: 8 to 64 letters, digits, - or _. */
export const DIAGNOSIS_CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
