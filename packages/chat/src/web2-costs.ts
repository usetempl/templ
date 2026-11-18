/** Operating budget only. This never authorizes gas, token transfers or plan purchases. */
export const WEB2_COST_POLICY = {
  monthlyTargetUsd: 500,
  monthlyCeilingUsd: 1000,
  retentionDays: 62,
  shards: 16,
  defaultSampleRate: 0.01,
} as const;

/** Fixed keys keep account, community and message data out of telemetry. */
export const COST_METRICS = {
  requests: { label: "API requests", unit: "requests", kind: "counter" },
  errors: { label: "Server errors", unit: "responses", kind: "counter" },
  rateLimited: {
    label: "Rate-limited requests",
    unit: "responses",
    kind: "counter",
  },
  groupRequests: {
    label: "Group chat requests",
    unit: "requests",
    kind: "counter",
  },
  supportRequests: {
    label: "Support requests",
    unit: "requests",
    kind: "counter",
  },
  accountRequests: {
    label: "Account requests",
    unit: "requests",
    kind: "counter",
  },
  identityReads: {
    label: "Current account identity reads",
    unit: "reads",
    kind: "counter",
  },
  identityUnder100: {
    label: "Account identity reads under 100 ms",
    unit: "reads",
    kind: "counter",
  },
  identityUnder500: {
    label: "Account identity reads from 100 to 499 ms",
    unit: "reads",
    kind: "counter",
  },
  identityUnder1000: {
    label: "Account identity reads from 500 to 999 ms",
    unit: "reads",
    kind: "counter",
  },
  identityOver1000: {
    label: "Account identity reads over 1 second",
    unit: "reads",
    kind: "counter",
  },
  otherRequests: {
    label: "Other API requests",
    unit: "requests",
    kind: "counter",
  },
  latencyUnder100: {
    label: "Responses under 100 ms",
    unit: "responses",
    kind: "counter",
  },
  latencyUnder500: {
    label: "Responses from 100 to 499 ms",
    unit: "responses",
    kind: "counter",
  },
  latencyUnder1000: {
    label: "Responses from 500 to 999 ms",
    unit: "responses",
    kind: "counter",
  },
  latencyUnder3000: {
    label: "Responses from 1 to 3 seconds",
    unit: "responses",
    kind: "counter",
  },
  latencyOver3000: {
    label: "Responses over 3 seconds",
    unit: "responses",
    kind: "counter",
  },
  rpcPrimaryAttempts: {
    label: "Primary RPC attempts",
    unit: "attempts",
    kind: "counter",
  },
  rpcPrimaryComputeUnits: {
    label: "Primary RPC admission units",
    unit: "compute units",
    kind: "counter",
  },
  rpcConfirmationAttempts: {
    label: "Confirmation RPC attempts",
    unit: "attempts",
    kind: "counter",
  },
  solanaRpcAttempts: {
    label: "Solana RPC attempts",
    unit: "attempts",
    kind: "counter",
  },
  dasAttempts: {
    label: "Solana collection provider attempts",
    unit: "attempts",
    kind: "counter",
  },
  rpcBlockedAttempts: {
    label: "RPC budget refusals",
    unit: "refusals",
    kind: "counter",
  },
  rpcBudgetRequests: {
    label: "RPC budget object requests",
    unit: "requests",
    kind: "counter",
  },
  nftSharedCacheHits: {
    label: "NFT display answers reused across rooms",
    unit: "answers",
    kind: "counter",
  },
  nftSharedCacheMisses: {
    label: "NFT shared-cache misses",
    unit: "reads",
    kind: "counter",
  },
  emailAttempts: {
    label: "Email provider attempts",
    unit: "attempts",
    kind: "counter",
  },
  emailAccepted: {
    label: "Emails accepted by provider",
    unit: "responses",
    kind: "counter",
  },
  emailFailed: {
    label: "Email provider failures",
    unit: "responses",
    kind: "counter",
  },
  emailUnknown: {
    label: "Uncertain email responses",
    unit: "responses",
    kind: "counter",
  },
  archiveCopies: {
    label: "Archive copy calls",
    unit: "calls",
    kind: "counter",
  },
  archiveBytes: {
    label: "Archive payload bytes copied",
    unit: "bytes",
    kind: "counter",
  },
  archiveFailures: {
    label: "Archive copy failures",
    unit: "failures",
    kind: "counter",
  },
  pendingArchiveBytes: {
    label: "Largest observed archive backlog",
    unit: "bytes",
    kind: "maximum",
  },
  databaseBytes: {
    label: "Largest observed room database",
    unit: "bytes",
    kind: "maximum",
  },
  mediaShardBytes: {
    label: "Largest observed media budget shard",
    unit: "bytes",
    kind: "maximum",
  },
  mediaShardObjects: {
    label: "Most objects in one observed media budget shard",
    unit: "objects",
    kind: "maximum",
  },
  socketDeliveries: {
    label: "Socket event fanout checks",
    unit: "events",
    kind: "counter",
  },
  socketReaders: {
    label: "Largest observed room socket count",
    unit: "connections",
    kind: "maximum",
  },
} as const;
export type CostMetric = keyof typeof COST_METRICS;
export type CostValues = Partial<Record<CostMetric, number>>;
export type CostReading = { observed: number; estimated: number | null };
export type CostBucket = {
  day: string;
  firstAt: number;
  lastAt: number;
  batches: number;
  minSampleRate: number;
  maxSampleRate: number;
  values: Partial<Record<CostMetric, CostReading>>;
};
export const PRICED_COST_METRICS = [
  "requests",
  "rpcBudgetRequests",
  "rpcPrimaryComputeUnits",
  "rpcConfirmationAttempts",
  "emailAttempts",
] as const satisfies readonly CostMetric[];
export type PricedCostMetric = (typeof PRICED_COST_METRICS)[number];
export type CostRates = {
  updatedAt: string;
  referenceVersion?: string;
  usdPerMillion: Partial<Record<PricedCostMetric, number>>;
  monthlyFixedUsd: number | null;
};
/** Public reference rates, checked on this date; allowances and unmeasured charges are excluded.
 * Alchemy lists $0.525/M CU for Pay As You Go. This is not the staging Free
 * account's bill. */
export const COST_REFERENCE_RATES: CostRates = {
  updatedAt: "2026-09-24T00:00:00.000Z",
  referenceVersion: "2026-09-24",
  usdPerMillion: {
    requests: 0.3,
    rpcBudgetRequests: 0.15,
    rpcPrimaryComputeUnits: 0.525,
    emailAttempts: 900,
  },
  monthlyFixedUsd: 5,
};
export const COST_RATE_SOURCES = [
  {
    label: "Cloudflare Workers pricing",
    url: "https://developers.cloudflare.com/workers/platform/pricing/",
  },
  {
    label: "Cloudflare Durable Objects pricing",
    url: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  },
  {
    label: "Alchemy PAYG pricing",
    url: "https://www.alchemy.com/pricing",
  },
  { label: "Resend pricing", url: "https://resend.com/pricing" },
] as const;
export type CostInvoice = {
  month: string;
  asOf: string;
  totalUsd: number;
  coverage: "all-web2" | "partial";
  source: "operator-entered" | "provider-feed";
};
export type CostDashboard = {
  workspaceCosts?: import("./workspace-costs").WorkspaceCostOverview;
  policy: typeof WEB2_COST_POLICY;
  month: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  collection: "available" | "unavailable";
  days: CostBucket[];
  values: Partial<Record<CostMetric, CostReading>>;
  /** Runtime SQLite write boundary for a room, when the API supplies it. */
  storageWriteLimitBytes?: number;
  sampleRate: { min: number | null; max: number | null };
  rates: CostRates | null;
  invoice: CostInvoice | null;
  estimates: { metric: PricedCostMetric; usd: number | null }[];
  estimatedSubtotalUsd: number | null;
  budgetStatus: "incomplete" | "below-target" | "over-target" | "over-ceiling";
  budgetBasis: "invoice" | "partial-estimate" | "unavailable";
};
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
/** Config has a fixed schema; text, URLs and provider credentials are rejected. */
export function parseCostRates(value: string | undefined): CostRates | null {
  try {
    if (!value) return structuredClone(COST_REFERENCE_RATES);
    if (value.length > 4096) return null;
    const raw = JSON.parse(value);
    if (
      !raw ||
      !date(raw.updatedAt) ||
      !raw.usdPerMillion ||
      typeof raw.usdPerMillion !== "object" ||
      Array.isArray(raw.usdPerMillion) ||
      Object.keys(raw).some(
        (k) => !["updatedAt", "usdPerMillion", "monthlyFixedUsd"].includes(k),
      )
    )
      return null;
    for (const [key, rate] of Object.entries(raw.usdPerMillion))
      if (
        !PRICED_COST_METRICS.includes(key as PricedCostMetric) ||
        !finite(rate) ||
        rate > 1000000
      )
        return null;
    if (
      raw.monthlyFixedUsd !== undefined &&
      raw.monthlyFixedUsd !== null &&
      (!finite(raw.monthlyFixedUsd) || raw.monthlyFixedUsd > 1000000)
    )
      return null;
    return {
      updatedAt: raw.updatedAt,
      usdPerMillion: raw.usdPerMillion,
      monthlyFixedUsd: raw.monthlyFixedUsd ?? null,
    };
  } catch {
    return null;
  }
}
export function parseCostInvoice(
  value: string | undefined,
  month: string,
): CostInvoice | null {
  try {
    if (!value || value.length > 4096) return null;
    const raw = JSON.parse(value);
    if (
      !raw ||
      raw.month !== month ||
      !date(raw.asOf) ||
      !raw.asOf.startsWith(month) ||
      !finite(raw.totalUsd) ||
      raw.totalUsd > 100000000 ||
      !["all-web2", "partial"].includes(raw.coverage) ||
      !["operator-entered", "provider-feed"].includes(raw.source) ||
      Object.keys(raw).some(
        (k) => !["month", "asOf", "totalUsd", "coverage", "source"].includes(k),
      )
    )
      return null;
    return raw;
  } catch {
    return null;
  }
}
export function mergeCostBuckets(
  buckets: readonly CostBucket[],
): CostDashboard["values"] {
  const values: CostDashboard["values"] = {};
  for (const bucket of buckets)
    for (const [name, reading] of Object.entries(bucket.values)) {
      const key = name as CostMetric;
      const prior = values[key];
      values[key] =
        COST_METRICS[key].kind === "maximum"
          ? {
              observed: Math.max(prior?.observed ?? 0, reading.observed),
              estimated: null,
            }
          : {
              observed: (prior?.observed ?? 0) + reading.observed,
              estimated: (prior?.estimated ?? 0) + (reading.estimated ?? 0),
            };
    }
  return values;
}
export function costDashboard(input: {
  month: string;
  now: number;
  days: CostBucket[];
  available: boolean;
  rates?: CostRates | null;
  invoice?: CostInvoice | null;
}): CostDashboard {
  const { month, now, days } = input;
  const values = mergeCostBuckets(days);
  const start = Date.parse(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const rates = input.rates ?? null,
    invoice = input.invoice ?? null;
  const estimates = PRICED_COST_METRICS.map((metric) => ({
    metric,
    usd:
      rates?.usdPerMillion[metric] !== undefined &&
      values[metric]?.estimated !== undefined
        ? (values[metric]!.estimated! / 1000000) * rates.usdPerMillion[metric]!
        : null,
  }));
  const priced = estimates.flatMap((row) =>
    row.usd === null ? [] : [row.usd],
  );
  const estimatedSubtotalUsd =
    priced.length ||
    (rates?.monthlyFixedUsd !== null && rates?.monthlyFixedUsd !== undefined)
      ? priced.reduce((sum, n) => sum + n, 0) + (rates?.monthlyFixedUsd ?? 0)
      : null;
  // These sources may overlap. Compare their totals without adding them or
  // allowing a small partial invoice to conceal a larger usage estimate.
  const useInvoice =
    invoice !== null &&
    (estimatedSubtotalUsd === null || invoice.totalUsd >= estimatedSubtotalUsd);
  const known = useInvoice ? invoice.totalUsd : estimatedSubtotalUsd;
  const budgetStatus =
    known === null
      ? "incomplete"
      : known >= WEB2_COST_POLICY.monthlyCeilingUsd
        ? "over-ceiling"
        : known >= WEB2_COST_POLICY.monthlyTargetUsd
          ? "over-target"
          : useInvoice && invoice?.coverage === "all-web2"
            ? "below-target"
            : "incomplete";
  return {
    policy: WEB2_COST_POLICY,
    month,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(Math.min(end.getTime(), now)).toISOString(),
    generatedAt: new Date(now).toISOString(),
    firstObservedAt: days.length
      ? new Date(Math.min(...days.map((day) => day.firstAt))).toISOString()
      : null,
    lastObservedAt: days.length
      ? new Date(Math.max(...days.map((day) => day.lastAt))).toISOString()
      : null,
    collection: input.available ? "available" : "unavailable",
    days,
    values,
    sampleRate: {
      min: days.length
        ? Math.min(...days.map((day) => day.minSampleRate))
        : null,
      max: days.length
        ? Math.max(...days.map((day) => day.maxSampleRate))
        : null,
    },
    rates,
    invoice,
    estimates,
    estimatedSubtotalUsd,
    budgetStatus,
    budgetBasis: useInvoice
      ? "invoice"
      : estimatedSubtotalUsd === null
        ? "unavailable"
        : "partial-estimate",
  };
}
