/** Input and output types of the transaction diagnosis engine. Types only.
 *
 * Every input value is JSON-safe and comes from the configured read sources
 * or from fixtures. Single-source inputs carry readSource explicitly. The
 * internal agreed shapes mean normalized consistency; readSource owns quorum. EVM quantities are canonical lowercase
 * JSON-RPC hex, hashes and addresses are lowercase hex, Solana amounts are
 * decimal strings, and slots and heights are safe integers. */

export type Hex = `0x${string}`;
/** /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/ */
export type Quantity = `0x${string}`;
/** The id is a positive safe integer. */
export type EvmNetwork = `eip155:${number}`;
/** The same strings as the structured support context. */
export type DiagnosisNetwork = EvmNetwork | "solana";
export type ProviderRole = "primary" | "confirmation";
export type UnavailableReason =
  | "provider-error"
  | "budget"
  | "not-configured"
  | "stale-head";
export type ProviderObservation = {
  provider: ProviderRole;
  value: string;
};
export type ProviderObservations = [ProviderObservation, ProviderObservation];
export type DiagnosisDisagreement = {
  network: DiagnosisNetwork | null;
  observations: ProviderObservations;
};
export type Agreement =
  | { kind: "agreed" }
  | { kind: "seen"; by: ProviderRole[] };

export type NetworkHint = {
  network: DiagnosisNetwork;
  /** member-context: the member's shared context.
   *  wallet-chain: the chain of their signed or claimed wallet. Weak.
   *  explorer-link: parsed from an explorer URL staff clicked.
   *  staff: staff chose it. */
  source: "member-context" | "wallet-chain" | "explorer-link" | "staff";
};
export type WalletFacts = {
  /** SIWE-proven (EVM) or SIWS-proven (Solana) wallet. */
  signed: { network: DiagnosisNetwork; address: string; at: string } | null;
  /** What the member's app reported. Never proof. */
  claimed: { network: DiagnosisNetwork; address: string } | null;
};
export type ProtocolContractKind =
  | "vault"
  | "router"
  | "bridge"
  | "token"
  | "staking"
  | "other";
/** Manager-owned protocol profile. */
export type ProtocolProfileFacts = {
  expectedNetworks: DiagnosisNetwork[];
  contracts: {
    network: DiagnosisNetwork;
    /** EVM lowercase hex or a Solana base58 program or account id. */
    address: string;
    /** /^[\p{L}\p{N}][\p{L}\p{N} .+&()-]{0,39}$/u */
    label: string;
    kind: ProtocolContractKind;
    /** Tokens only; /^[A-Za-z0-9.+-]{1,12}$/ */
    symbol: string | null;
    /** Tokens only; 0..77 */
    decimals: number | null;
  }[];
};
/** Explicit single-source provenance. Missing only on independent historical inputs. */
export type DiagnosisReadSource = { providerCount: 1; source: "alchemy" };

type DiagnosisCommon = {
  readSource?: DiagnosisReadSource;
  v: 1;
  /** /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/ */
  checkedAt: string;
  hint: NetworkHint | null;
  wallet: WalletFacts;
  profile: ProtocolProfileFacts | null;
  /** Set when the read that decides the status failed. */
  disagreement?: DiagnosisDisagreement;
  unavailable: {
    reason: UnavailableReason;
    network: DiagnosisNetwork | null;
  } | null;
};

export type AgreedBlock = {
  number: Quantity;
  hash: Hex;
  timestamp: Quantity;
  baseFeePerGas: Quantity | null;
};
/** One per checked network, in read order. */
export type EvmProbe =
  | { network: EvmNetwork; outcome: "found-mined"; head: AgreedBlock }
  | {
      network: EvmNetwork;
      outcome: "found-pending";
      head: AgreedBlock;
      seenBy: ProviderRole[];
    }
  /** Both providers returned a null tx and a null receipt at head. */
  | { network: EvmNetwork; outcome: "not-found"; head: AgreedBlock }
  | { network: EvmNetwork; outcome: "unavailable"; reason: UnavailableReason }
  | {
      network: EvmNetwork;
      outcome: "disagree";
      observations: ProviderObservations;
    };

export type EvmTxFact = {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  nonce: Quantity;
  value: Quantity;
  /** First 4 bytes; null when the input is shorter. */
  inputSelector: Hex | null;
  inputBytes: number;
  gas: Quantity;
  type: Quantity | null;
  gasPrice: Quantity | null;
  maxFeePerGas: Quantity | null;
  maxPriorityFeePerGas: Quantity | null;
  blockHash: Hex | null;
  blockNumber: Quantity | null;
  transactionIndex: Quantity | null;
};
export type EvmLogFact = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: Quantity;
};
export type EvmReceiptFact = {
  transactionHash: Hex;
  from: Hex;
  to: Hex | null;
  contractAddress: Hex | null;
  status: "0x0" | "0x1";
  blockHash: Hex;
  blockNumber: Quantity;
  transactionIndex: Quantity;
  gasUsed: Quantity;
  cumulativeGasUsed: Quantity;
  effectiveGasPrice: Quantity | null;
  /** Capped by capEvmLogs. */
  logs: EvmLogFact[];
  /** Count before capping. */
  logsTotal: number;
  logsTruncated: boolean;
};
export type EvmCodeFact = {
  network: EvmNetwork;
  address: Hex;
  atBlock: Quantity;
  /** "0x" is none; 0xef0100 + 20 bytes is an EIP-7702 delegation. */
  kind: "none" | "contract" | "delegated";
  delegate: Hex | null;
};
export type EvmRevertReplay =
  | {
      outcome: "disagree";
      atBlock: AgreedBlock | null;
      observations: ProviderObservations;
    }
  /** eth_call at the parent block; both providers answered error code 3
   * with identical data ("0x" allowed). */
  | { outcome: "reverted"; atBlock: AgreedBlock; data: Hex }
  | { outcome: "succeeded"; atBlock: AgreedBlock }
  | {
      outcome: "unavailable";
      atBlock: AgreedBlock | null;
      reason: UnavailableReason | "call-error";
    };
export type VerifiedAbiSource = "sourcify" | "blockscout" | "etherscan";
/** From the kept decoder core. */
export type EvmMethodFact = {
  selector: Hex | null;
  /** /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/ */
  name: string | null;
  source: "builtin" | VerifiedAbiSource | null;
  group:
    | "erc20"
    | "erc721"
    | "erc1155"
    | "weth"
    | "permit2"
    | "multicall3"
    | "universal-router"
    | "wrapper"
    | "verified"
    | null;
  /** At most 16; each value at most 200 characters. */
  args: { name: string; type: string; value: string }[];
  /** Universal Router command names, at most 32. */
  routerCommands: string[];
  /** At most 32. */
  nested: { to: Hex; name: string | null }[];
};
export type AbiParameterFact = {
  name: string;
  type: string;
  components?: AbiParameterFact[];
};
export type EvmAbiErrorItem = {
  type: "error";
  name: string;
  inputs: AbiParameterFact[];
};
export type EvmTokenFact = {
  network: EvmNetwork;
  address: Hex;
  decimals: number | null;
  decimalsSource: "builtin" | "workspace" | "chain-read" | null;
  symbol: string | null;
  symbolSource: "builtin" | "workspace" | "contract-claimed" | null;
};
export type EvmFound = {
  network: EvmNetwork;
  tx: EvmTxFact;
  /** Agreed when mined; seen when pending (the mempool is node-local). */
  txAgreement: Agreement;
  /** Agreed; null when pending. */
  receipt: EvmReceiptFact | null;
  /** Pending only: agreed head at which both providers returned a null
   * receipt, read after senderNonce. */
  receiptNullAt: Quantity | null;
  /** Inclusion block, already checked canonical at head. */
  block: AgreedBlock | null;
  heads: {
    latest: AgreedBlock;
    safe: AgreedBlock | null;
    finalized: AgreedBlock | null;
  };
  /** eth_getTransactionCount(from) at an agreed head (the next unused nonce). */
  senderNonce: { confirmed: Quantity; atBlock: Quantity } | null;
  /** eth_getTransactionCount(from, "pending") per provider. Display only. */
  pendingNonce: {
    primary: Quantity | null;
    confirmation: Quantity | null;
  } | null;
  code: EvmCodeFact[];
  /** Only when receipt.status is 0x0. */
  revert: EvmRevertReplay | null;
  method: EvmMethodFact | null;
  /** Verified error items for tx.to. */
  errorAbi: { source: VerifiedAbiSource; items: EvmAbiErrorItem[] } | null;
  /** For log addresses and approval assets, at most 16. */
  tokens: EvmTokenFact[];
};
export type EvmPreviousSighting = {
  network: EvmNetwork;
  from: Hex;
  nonce: Quantity;
  seenAt: string;
  seenBy: ProviderRole[];
  /** Re-read now: eth_getTransactionCount(from) at an agreed head. */
  confirmedNonceNow: { value: Quantity; atBlock: Quantity } | null;
};
export type EvmDiagnosisInput = DiagnosisCommon & {
  kind: "evm";
  /** /^0x[0-9a-f]{64}$/ */
  hash: Hex;
  /** 1..8, unique networks. */
  probes: EvmProbe[];
  found: EvmFound | null;
  /** From the last stored diagnosis of this hash in the thread. */
  previous: EvmPreviousSighting | null;
};

export type SolanaCommitment = "processed" | "confirmed" | "finalized";
export type SolanaTxError =
  | {
      kind: "instruction";
      index: number;
      error:
        | { kind: "custom"; code: number }
        | { kind: "builtin"; name: string };
    }
  | { kind: "insufficient-funds-for-rent"; accountIndex: number }
  | { kind: "transaction"; name: string }
  /** Canonical JSON of meta.err, at most 200 characters. */
  | { kind: "unknown"; raw: string };
export type SolanaStatusFact =
  | { kind: "agreed"; found: false }
  | {
      kind: "agreed";
      found: true;
      slot: number;
      commitment: "confirmed" | "finalized";
      err: SolanaTxError | null;
    }
  | {
      kind: "seen";
      by: ProviderRole[];
      slot: number;
      commitment: "processed";
      err: SolanaTxError | null;
    };
export type SolanaHeight = { blockHeight: number; slot: number; at: string };
export type SolanaInstructionFact = {
  programId: string;
  /** jsonParsed "program", e.g. "spl-token", "system". */
  program: string | null;
  /** jsonParsed parsed.type, /^[A-Za-z0-9]{1,48}$/ */
  type: string | null;
  info: {
    source?: string;
    destination?: string;
    authority?: string;
    owner?: string;
    delegate?: string;
    mint?: string;
    amount?: string;
    lamports?: string;
  } | null;
  /** Base58 data of a partially decoded instruction, at most 1,700 characters. */
  data: string | null;
};
export type SolanaTokenBalanceFact = {
  accountIndex: number;
  mint: string;
  owner: string | null;
  programId: string | null;
  /** /^\d{1,20}$/ */
  amount: string;
  /** 0..255 */
  decimals: number;
};
export type SolanaTxFact = {
  slot: number;
  blockTime: number | null;
  version: "legacy" | 0;
  commitment: "confirmed" | "finalized";
  err: SolanaTxError | null;
  /** Lamports, /^\d{1,20}$/ */
  fee: string;
  computeUnitsConsumed: number | null;
  accountKeys: {
    pubkey: string;
    signer: boolean;
    writable: boolean;
    source: "transaction" | "lookupTable";
  }[];
  recentBlockhash: string;
  /** Top level, at most 64. */
  instructions: SolanaInstructionFact[];
  /** Distinct, at most 64. */
  innerProgramIds: string[];
  /** Lamports per account index; exact is false if any RPC number exceeded
   * 2^53-1. */
  balances: { exact: boolean; pre: string[]; post: string[] };
  preTokenBalances: SolanaTokenBalanceFact[];
  postTokenBalances: SolanaTokenBalanceFact[];
  logMessages: string[];
  logsTruncated: boolean;
};
export type SolanaDiagnosisInput = DiagnosisCommon & {
  kind: "solana";
  /** Base58 that decodes to 64 bytes. */
  signature: string;
  /** Both providers are on the reader's archival allowlist. */
  providers: { archival: boolean };
  status: SolanaStatusFact;
  tx: SolanaTxFact | null;
  /** firstCheck: agreed confirmed block height at the first check of this
   * signature in this thread. current: read before this check's status read. */
  heights: { firstCheck: SolanaHeight; current: SolanaHeight };
  previous: { seenAt: string; commitment: SolanaCommitment } | null;
};

export type DiagnosisInput = EvmDiagnosisInput | SolanaDiagnosisInput;

export type DiagnosisEngineVersion = "dx-1" | "dx-2" | "dx-3" | "dx-4" | "dx-5";
export type DiagnosisStatus =
  | "confirmed"
  | "failed"
  | "pending"
  | "replaced"
  | "expired"
  | "not-found"
  | "unavailable"
  | "disagree";
export type DiagnosisCategory =
  | "deposit"
  | "withdrawal"
  | "swap"
  | "approval"
  | "bridge"
  | "transfer"
  | "other";
export type CategorySource =
  | "event"
  | "builtin-method"
  | "workspace-label"
  | "method-name";
export type FailureReason =
  | "slippage"
  | "deadline"
  | "allowance"
  | "balance"
  | "fee-balance"
  | "rent"
  | "vault-limit"
  | "paused"
  | "unauthorized"
  | "signature"
  | "transfer-failed"
  | "out-of-gas"
  | "compute"
  | "arithmetic"
  | "other";
export type EvidenceSourceKind =
  | "provider"
  | "agreed"
  | "observation"
  | "seen"
  | "replay"
  | "builtin-abi"
  | "verified-abi"
  | "program-log"
  | "builtin-list"
  | "workspace-label"
  | "contract-claimed"
  | "contract-text"
  | "signed-wallet"
  | "member-claim"
  | "member-hint"
  | "derived"
  | "read-window";
export type Evidence = {
  id: string;
  /** Staff label, e.g. "Gas used". */
  label: string;
  /** Staff display, e.g. "187,212 of 187,212 limit". */
  value: string;
  /** JSON pointer into the input, e.g. "/found/receipt/gasUsed". */
  fact: string;
  source: EvidenceSourceKind;
  sourceLabel: string;
};
export type RuleId =
  | "dx.unavailable"
  | "dx.disagree"
  | "dx.input-invalid"
  | "dx.hint-mismatch"
  | "dx.wallet-signed-match"
  | "dx.wallet-claimed-match"
  | "dx.wallet-signed-mismatch"
  | "dx.wallet-claimed-mismatch"
  | "evm.not-found"
  | "evm.probe-unavailable"
  | "evm.vanished"
  | "evm.other-network"
  | "evm.unexpected-network"
  | "evm.found-on-several"
  | "evm.pending"
  | "evm.nonce-gap"
  | "evm.underpriced"
  | "evm.replaced"
  | "evm.revert.error-string"
  | "evm.revert.panic"
  | "evm.revert.custom-known"
  | "evm.revert.custom-verified"
  | "evm.revert.unknown-selector"
  | "evm.revert.no-data"
  | "evm.revert.not-reproduced"
  | "evm.revert.no-replay"
  | "evm.out-of-gas"
  | "evm.succeeded"
  | "evm.not-finalized"
  | "evm.token-movement"
  | "evm.approval-only"
  | "evm.unlimited-approval"
  | "evm.vault-deposit"
  | "evm.vault-withdraw"
  | "evm.swap"
  | "evm.no-movement"
  | "evm.call-to-empty-address"
  | "evm.recipient-code-elsewhere"
  | "evm.sent-to-token-contract"
  | "evm.sent-to-protocol-contract"
  | "evm.bridge-source"
  | "evm.contract-creation"
  | "evm.relayed-userop"
  | "evm.userop-failed"
  | "evm.logs-truncated"
  | "sol.not-found"
  | "sol.expired"
  | "sol.processed"
  | "sol.succeeded"
  | "sol.not-finalized"
  | "sol.token-movement"
  | "sol.sol-movement"
  | "sol.swap"
  | "sol.approval-only"
  | "sol.unlimited-approval"
  | "sol.program-error.anchor"
  | "sol.program-error.known"
  | "sol.program-error.custom"
  | "sol.instruction-error"
  | "sol.insufficient-funds"
  | "sol.compute-exceeded"
  | "sol.insufficient-fee"
  | "sol.insufficient-rent"
  | "sol.tx-error"
  | "sol.fee"
  | "sol.bridge-source"
  | "sol.no-movement"
  | "sol.logs-truncated";
export type NextStepId =
  | "ns.recheck"
  | "ns.ask-network"
  | "ns.not-found-wait"
  | "ns.wait"
  | "ns.nonce-gap"
  | "ns.underpriced"
  | "ns.replaced"
  | "ns.slippage"
  | "ns.deadline"
  | "ns.allowance"
  | "ns.balance"
  | "ns.vault-limit"
  | "ns.paused"
  | "ns.unauthorized"
  | "ns.signature"
  | "ns.out-of-gas"
  | "ns.compute"
  | "ns.rent"
  | "ns.escalate"
  | "ns.indexer"
  | "ns.approval-only"
  | "ns.unlimited-approval"
  | "ns.no-movement"
  | "ns.empty-address"
  | "ns.sent-to-token"
  | "ns.sent-to-protocol"
  | "ns.bridge"
  | "ns.wallet-mismatch"
  | "ns.unexpected-network"
  | "ns.expired"
  | "ns.sol-not-found"
  | "ns.none";
export type MemberTemplateId =
  | "m.confirmed"
  | "m.confirmed-final"
  | "m.confirmed-sol"
  | "m.confirmed-sol-final"
  | "m.deposit"
  | "m.withdrawal"
  | "m.swap"
  | "m.swap-sol"
  | "m.approval-only"
  | "m.approval-unlimited"
  | "m.no-movement"
  | "m.no-movement-sol"
  | "m.failed-slippage"
  | "m.failed-deadline"
  | "m.failed-allowance"
  | "m.failed-balance"
  | "m.failed-vault-limit"
  | "m.failed-paused"
  | "m.failed-paused-action"
  | "m.failed-out-of-gas"
  | "m.failed-compute"
  | "m.failed-sol-balance"
  | "m.failed-rent"
  | "m.failed"
  | "m.userop-failed"
  | "m.pending"
  | "m.pending-behind"
  | "m.pending-low-fee"
  | "m.processed"
  | "m.replaced"
  | "m.expired"
  | "m.not-found"
  | "m.not-found-sol"
  | "m.bridge-source"
  | "m.bridge-source-sol"
  | "m.unavailable"
  | "m.empty-address"
  | "m.sent-to-token"
  | "m.sent-to-protocol"
  | "m.other-network";
export type FindingSeverity = "blocker" | "warning" | "info";
export type Finding = {
  rule: RuleId;
  severity: FindingSeverity;
  text: string;
  evidence: string[];
};
export type StaffNextStep = {
  id: NextStepId;
  text: string;
  needsNewTransaction: boolean;
};
export type Diagnosis = {
  readSource?: DiagnosisReadSource;
  v: 1;
  engine: DiagnosisEngineVersion;
  kind: "evm" | "solana";
  /** Full hash or signature (staff-only context). */
  subject: string;
  /** Where found; the hinted network when not found; null if unknown. */
  network: DiagnosisNetwork | null;
  checkedAt: string;
  status: DiagnosisStatus;
  finality: "final" | "not-final" | null;
  category: DiagnosisCategory;
  categorySource: CategorySource | null;
  /** Failed only. */
  reason: FailureReason | null;
  needsPerson: boolean;
  /** Internal, like notes: never on member routes, history or exports. */
  staff: {
    whatHappened: string;
    findings: Finding[];
    evidence: Evidence[];
    nextSteps: StaffNextStep[];
  };
  /** A draft staff may put in the composer. Never sent automatically. */
  member: {
    template: MemberTemplateId;
    text: string;
    evidence?: string[];
  } | null;
  trimmed: boolean;
};
export type TransactionRef =
  | { kind: "evm"; hash: Hex }
  | { kind: "solana"; signature: string };
export type DetectedTransactionRef =
  | { kind: "evm"; hash: Hex; network: EvmNetwork }
  | {
      kind: "solana";
      signature: string;
      /** Set for devnet and testnet links, which the read layer refuses. */
      cluster: "devnet" | "testnet" | null;
    };
export type DiagnosisClaims = {
  status: DiagnosisStatus;
  networks: string[];
  numbers: string[];
  tokens: string[];
  shortRefs: string[];
};
export type DiagnosisInputErrorCode =
  | "input-shape"
  | "input-limits"
  | "input-network"
  | "input-subject"
  | "input-agreement";
