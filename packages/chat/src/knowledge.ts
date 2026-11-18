/** Shared limits for workspace knowledge reads and ingestion. */
export const KNOWLEDGE_LIMITS = {
  sources: 500,
  sitemapPages: 200,
  pageBytes: 1_048_576,
  chunkChars: 1_200,
  chunksPerSource: 200,
  faqChars: 4_000,
  guidanceChars: 4_000,
  titleChars: 120,
  addresses: 16,
  /** Pages the object's alarm fetches per run. */
  fetchesPerRun: 5,
  refreshHours: 24,
  queryChars: 500,
  queryLimit: 10,
  excerptChars: 400,
  listPage: 100,
} as const;

/** Full current, member-safe source chunks. Follow every cursor for complete context. */
export type KnowledgeContextHit = {
  sourceId: string;
  kind: "doc" | "faq" | "saved-reply";
  title: string;
  excerpt: string;
  url?: string;
  era: "current";
  visibility: "member-safe";
  updatedAt: string;
};
export type KnowledgeContextPage = {
  hits: KnowledgeContextHit[];
  nextCursor: string | null;
  version: string;
};

/** Manager preferences are not answer sources or replacements for safety rules. */
export type WorkspaceAiGuidance = { text: string; revision: number; interactionPolicy?: "bounded-v1" };
export function checkedWorkspaceAiGuidance(value: unknown): value is WorkspaceAiGuidance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => ["text", "revision", "interactionPolicy"].includes(key)) &&
    (row.interactionPolicy === undefined || row.interactionPolicy === "bounded-v1") &&
    typeof row.text === "string" && row.text.length <= KNOWLEDGE_LIMITS.guidanceChars &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(row.text) &&
    Number.isSafeInteger(row.revision) && Number(row.revision) >= 0;
}

export type BrainStoragePrice = {
  version: string;
  freeBytesPerWorkspace: number;
  bytesPerGb: number;
  usdCentsPerGbMonth: number;
};
export type BrainStorageView = {
  schema: 1;
  collectionQualified: false;
  retainedUploadBytes: number;
  unclassifiedSources: number;
  measuredAt: string;
  month: string;
  monthEndsAt: string;
  price: BrainStoragePrice;
  terms: string;
  termsSha256: string;
  meteredEstimateCents: number;
  billing?: {
    schema: 1; collectionQualified: boolean; pendingSettlement: boolean; pendingCents: number; meterUnavailable?: boolean; chargedCents: number; paidCents: number; creditedCents: number; dueCents: number;
    status: "off" | "agreement-needed" | "acceptance-needed" | "active" | "paused";
    debtLimitCents: number;
    agreement: { id: string; revision: number; documentText: string; documentSha256: string; termsSha256: string; signedBy: string; workspace: string; price: BrainStoragePrice } | null;
    accepted: { id: string; acceptedAt: number; withdrawnAt: number | null } | null;
  };
};


export type BrainStorageLedger = {
  rows: { id: string; kind: "storage" | "payment" | "credit"; at: number; cents: number; month?: string }[];
  next: string | null;
};
