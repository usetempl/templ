/** Private operational accounting. These records contain no support content. */
export type CostProducer = "hosted-ai" | "native-ai" | "telegram-polish";
export type CostCategory = "ai" | "hosting-storage" | "rpc-email" | "other";
export type CostScope = "customer" | "templ-own" | "test" | "unknown";
export interface WorkspaceCostUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  billableUnits: number | null;
}
export interface WorkspaceCostEvent {
  schemaVersion: 1;
  attemptId: string;
  phase: "started" | "provider-finished" | "consumer-finished";
  at: string;
  provider: "openai" | "anthropic" | "cloudflare";
  model: string;
  requestedModel?: string;
  purpose: "answer" | "draft" | "handoff" | "polish" | "other";
  transportOutcome?: "completed" | "failed" | "cancelled" | "timeout";
  consumerOutcome?:
    | "answer"
    | "draft"
    | "handoff"
    | "unresolved"
    | "cancelled"
    | "discarded"
    | "failed";
  usage?: WorkspaceCostUsage;
  durationMs?: number;
}
export interface CostIngestAck {
  accepted: number;
  duplicates: number;
  rejected: number;
  unavailable: boolean;
}
export interface WorkspaceResourceEvent {
  schemaVersion: 1;
  eventId: string;
  at: string;
  kind: "requests" | "rpc" | "email" | "storage";
  provider: "cloudflare" | "alchemy" | "drpc" | "resend" | "unknown";
  metric:
    | "requests"
    | "rpc-attempts"
    | "email-attempts"
    | "email-accepted"
    | "retained-byte-ms"
    | "storage-read-ops"
    | "storage-write-ops"
    | "storage-retained-bytes";
  quantity: string;
  unit: "request" | "byte-ms" | "byte" | "operation";
  instanceId?: string;
  method?: string;
  outcome?: "accepted" | "failed" | "unknown";
}
export type WorkspaceResourceTotal = Omit<
  WorkspaceResourceEvent,
  "schemaVersion" | "eventId" | "at"
> & { observedAt?: string };
export interface WorkspaceCostFinance {
  month: string;
  asOf: string;
  earnedRevenueUsdNanos: string | null;
  paymentsReceivedUsdNanos: string | null;
  knownRevenueUsdNanos: string;
  knownPaymentsUsdNanos: string;
  ticketsOpened: number | null;
  testTicketsOpened: number;
  confirmedAiResolutions: number | null;
  missing: string[];
  basis: string[];
}
export interface WorkspaceCostResource {
  producer: CostProducer;
  provider: string;
  model: string;
  purpose: WorkspaceCostEvent["purpose"];
  invocations: number;
  completed: number;
  failed: number;
  missingUsage: number;
  pending: number;
  usage: WorkspaceCostUsage;
  durationMs: number;
  consumerOutcomes: Partial<
    Record<NonNullable<WorkspaceCostEvent["consumerOutcome"]>, number>
  >;
}
export interface WorkspaceCostRow {
  workspace: string;
  name: string | null;
  category: CostScope;
  month: string;
  earnedRevenueUsd: number | null;
  paymentsReceivedUsd: number | null;
  aiUsd: number | null;
  hostingStorageUsd: number | null;
  rpcEmailUsd: number | null;
  directUsd: number | null;
  sharedUsd: number | null;
  knownSubtotalUsd: number | null;
  totalUsd: number | null;
  ticketsOpened: number | null;
  confirmedAiResolutions: number | null;
  costPerTicketUsd: number | null;
  costPerConfirmedAiResolutionUsd: number | null;
  grossMarginPercent: number | null;
  status: "missing" | "partial" | "reconciled";
  missing: string[];
  usageUpdatedAt: string | null;
  financeUpdatedAt: string | null;
  coverageStartedAt: string | null;
}
export interface WorkspaceCostInvoiceComponent {
  id: string;
  revision: number;
  provider: string;
  invoiceId: string;
  issuedAt: string;
  currency: "USD";
  periodStart: string;
  periodEnd: string;
  month: string;
  category: CostCategory;
  amountUsdNanos: string;
  assignment: "direct" | "shared" | "unattributed";
  workspace: string | null;
  sourceSha256: string;
  coverage: "complete" | "partial";
  kind: "usage" | "subscription" | "discount" | "credit" | "minimum" | "fee";
}
export interface WorkspaceCostOverview {
  schemaVersion: 1;
  month: string;
  asOf: string;
  rows: WorkspaceCostRow[];
  nextCursor: string | null;
  missing: string[];
  reconciliation: {
    invoiceUsd: number | null;
    directUsd: number;
    allocatedUsd: number;
    unattributedUsd: number;
    unallocatedSharedUsd: number;
    components: number;
    status: "missing" | "partial" | "reconciled";
  };
}
export interface WorkspaceCostDetail {
  schemaVersion: 1;
  row: WorkspaceCostRow;
  days: {
    day: string;
    resources: WorkspaceCostResource[];
    resourceTotals: WorkspaceResourceTotal[];
    recordingGaps: number;
    updatedAt: string;
  }[];
  invoices: WorkspaceCostInvoiceComponent[];
  financeBasis: string[];
  resourcesMissing: string[];
}
