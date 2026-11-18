import type {
  DiagnosisInput,
  DiagnosisNetwork,
  EvmPreviousSighting,
  Hex,
  NetworkHint,
  SolanaCommitment,
  SolanaHeight,
  WalletFacts,
} from "@templ/chat/diagnosis/types";

/** Types shared by the room (which plans and commits) and the edge read
 * layer (which reads). Types only: the room module imports nothing that can
 * reach a provider. */

export type DiagnosisTrigger =
  | "staff"
  | "agent"
  | "member-share"
  | "ask-ai"
  /** Guard only: refuses a pasted key, stores no diagnosis. */
  | "key-guard";

export type DiagnosisSubject =
  | { kind: "evm"; hash: Hex }
  | { kind: "solana"; signature: string };

export type DiagnosisRunPlan = {
  v: 1;
  lease: string;
  conversation: string;
  case: number;
  trigger: DiagnosisTrigger;
  subject: DiagnosisSubject;
  hint: NetworkHint | null;
  /** Probe networks in order: the hint first, then the enabled chains. */
  networks: DiagnosisNetwork[];
  /** Key-guard networks (EVM): hint ∪ member wallet chains ∪ {1, 8453}. */
  guardNetworks: DiagnosisNetwork[];
  wallet: WalletFacts;
  previous: Omit<EvmPreviousSighting, "confirmedNonceNow"> | null;
  /** Solana only: the first check's height and the last seen commitment. */
  solana: {
    firstCheck: SolanaHeight | null;
    previous: { seenAt: string; commitment: SolanaCommitment } | null;
  } | null;
  /** False when a stored check of this subject in the thread passed it. */
  keyGuard: boolean;
  checkedAt: string;
  deadlineAt: number;
};

export type DiagnosisReads = {
  calls: number;
  attempts: number;
  primaryCu: number;
  confirmationAttempts: number;
  subrequests: number;
  ms: number;
  networks: string[];
  budgetLimited: boolean;
};

export type DiagnosisReadResult =
  | {
      kind: "input";
      input: DiagnosisInput;
      reads: DiagnosisReads;
      /** "profile:<network>:<address>", at most 20. */
      profileRefs: string[];
    }
  /** The value looked like a private key; nothing was sent. */
  | { kind: "refused-key"; reads: DiagnosisReads }
  /** Guard-only job: the value is not a used key. */
  | { kind: "guard-clear"; reads: DiagnosisReads };
