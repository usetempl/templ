/** Metric keys: the names a case frame, an evidence row or an AI reply uses
 * for a figure, bound to the metric definitions of the protocol profile.
 *
 * A protocol defines each metric once on its Protocol tab (for example
 * "apy-7d-net": the 7-day net APY a vault page shows). A managed AI reply
 * that states a figure says which metric, product and window it belongs to
 * (a claim). The checks here refuse a claim whose metric the profile does not
 * define, a window the definition does not allow, a claim with no evidence
 * row behind it, and any comparison between figures of different metrics,
 * products or windows. The worker hands such a reply to a person.
 *
 * Pure functions with no I/O: the worker, the web app and the hosted trial
 * apply the same rules. Nothing here reads a chain or grants access. */

/** The same shape as an evidence tag key: lowercase, digits and . _ : / -. */
export const METRIC_KEY = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;
export const METRIC_WINDOWS = [
  "instant",
  "1d",
  "7d",
  "30d",
  "90d",
  "custom",
] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

/** What a claim needs to know about one profile metric definition. */
export type MetricDefinition = {
  id: string;
  label: string;
  window: MetricWindow;
  fees: "net" | "gross" | "n/a";
  /** Product keys the metric applies to; empty means every product. */
  appliesTo: { products: readonly string[] };
};
export type MetricKeyBinding = {
  key: string;
  label: string;
  window: MetricWindow;
  fees: MetricDefinition["fees"];
  products: readonly string[];
};

/** One figure a reply states: the metric key, the product key and the
 * window key it belongs to, the value as written, and the evidence rows
 * (their case numbers) that hold it. */
export type MetricClaim = {
  metric: string;
  product: string;
  window: string;
  value: string;
  evidence: number[];
};
/** The evidence row fields a claim is checked against. */
export type MetricEvidenceRow = {
  n: number;
  product: { key: string };
  metric: { key: string };
  window: { key: string };
  value: { text: string; number?: string; unit?: string };
  withdrawn: boolean;
  supersededBy: number | null;
};

export const METRIC_CLAIM_PROBLEMS = [
  "invalid-claim",
  "unknown-metric",
  "metric-not-for-product",
  "window-mismatch",
  "uncited-claim",
  "claim-evidence-mismatch",
  "mixed-metrics",
  "mixed-products",
  "mixed-windows",
] as const;
export type MetricClaimProblemKind = (typeof METRIC_CLAIM_PROBLEMS)[number];
export type MetricClaimProblem = {
  kind: MetricClaimProblemKind;
  /** Index of the claim, or both claims of a comparison. */
  claims: number[];
};
export const METRIC_CLAIM_LIMITS = {
  claims: 12,
  comparisons: 12,
  valueChars: 64,
} as const;

/** Profile metric definitions by key. A definition whose id is not a valid
 * key is left out, so it can never bind a claim. */
export function metricKeyBindings(
  metrics: readonly MetricDefinition[],
): Map<string, MetricKeyBinding> {
  const bindings = new Map<string, MetricKeyBinding>();
  for (const metric of metrics) {
    if (!METRIC_KEY.test(metric.id) || bindings.has(metric.id)) continue;
    bindings.set(metric.id, {
      key: metric.id,
      label: metric.label,
      window: metric.window,
      fees: metric.fees,
      products: [...metric.appliesTo.products],
    });
  }
  return bindings;
}
/** The definition a key names, or null. Keys compare exactly. */
export function bindMetricKey(
  key: unknown,
  bindings: ReadonlyMap<string, MetricKeyBinding>,
): MetricKeyBinding | null {
  return typeof key === "string" ? (bindings.get(key) ?? null) : null;
}

const WINDOW_OF: Record<string, MetricWindow> = {
  instant: "instant",
  point: "instant",
  now: "instant",
  "1d": "1d",
  "24h": "1d",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};
/** Whether a claim's window key fits the metric's defined window. A custom
 * metric accepts any window; the others accept their own key and its usual
 * spellings ("24h" for 1d, "point" for instant). */
export function windowFits(binding: MetricKeyBinding, window: string) {
  if (binding.window === "custom") return true;
  return WINDOW_OF[window] === binding.window;
}

/** A claim as the model wrote it, or null. */
export function checkedMetricClaim(raw: unknown): MetricClaim | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const claim = raw as Record<string, unknown>;
  const keys = Object.keys(claim).sort().join();
  if (keys !== "evidence,metric,product,value,window") return null;
  if (
    typeof claim.metric !== "string" ||
    !METRIC_KEY.test(claim.metric) ||
    typeof claim.product !== "string" ||
    !METRIC_KEY.test(claim.product) ||
    typeof claim.window !== "string" ||
    !METRIC_KEY.test(claim.window) ||
    typeof claim.value !== "string" ||
    !claim.value.trim() ||
    claim.value.length > METRIC_CLAIM_LIMITS.valueChars ||
    !Array.isArray(claim.evidence) ||
    claim.evidence.length > 8 ||
    !claim.evidence.every(
      (n) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= 50,
    )
  )
    return null;
  return {
    metric: claim.metric,
    product: claim.product,
    window: claim.window,
    value: claim.value.trim(),
    evidence: [...new Set(claim.evidence as number[])],
  };
}

/** Words that make two stated figures a comparison. */
const COMPARISON =
  /\b(?:vs\.?|versus|compared?(?:\s+(?:to|with))?|than|higher|lower|above|below|difference|differs?|instead of|whereas)\b/i;
/** Whether the text reads as comparing figures. */
export function readsAsComparison(text: string): boolean {
  return COMPARISON.test(text);
}

/** One amount as written: its number (no grouping, no trailing zeros after
 * the point) and its unit class. "5.12%" and "5.120 %" are the same amount;
 * "15.12%" is not "5.12". */
export type Amount = {
  number: string;
  unit: "percent" | "bps" | "currency" | "k" | "m" | "b" | "plain";
};
const AMOUNT =
  /(?<![A-Za-z0-9_.])([$€£]\s?)?(-?\d(?:[\d,_]*\d)?(?:\.\d+)?)(?:\s?(%|bps\b|[kKmMbB](?![A-Za-z])))?/g;
function normalized(raw: string) {
  let value = raw.replace(/[,_]/g, "");
  if (value.includes(".")) value = value.replace(/0+$/, "").replace(/\.$/, "");
  value = value.replace(/^(-?)0+(?=\d)/, "$1");
  return value === "-0" ? "0" : value;
}
/** Every amount a short text states, in order. */
export function amountsIn(text: string): Amount[] {
  return [...text.matchAll(AMOUNT)].map((match) => {
    const suffix = match[3]?.toLowerCase();
    return {
      number: normalized(match[2]),
      unit: match[1]
        ? "currency"
        : suffix === "%"
          ? "percent"
          : suffix === "bps"
            ? "bps"
            : suffix === "k" || suffix === "m" || suffix === "b"
              ? suffix
              : "plain",
    };
  });
}
/** Two amounts are the same: equal numbers, and the same unit class unless
 * one of them names no unit. */
export function sameAmount(a: Amount, b: Amount): boolean {
  return (
    a.number === b.number &&
    (a.unit === b.unit || a.unit === "plain" || b.unit === "plain")
  );
}
/** The amount an evidence row holds: its number with its unit (the row's
 * unit, or the one its text writes beside that number), or null when the
 * row keeps no number. */
export function rowAmount(value: {
  text?: string;
  number?: string;
  unit?: string;
}): Amount | null {
  if (value.number === undefined) return null;
  const [amount] = amountsIn(value.number);
  if (!amount) return null;
  const unit = value.unit?.trim().toLowerCase();
  const written = amountsIn(value.text ?? "").find(
    (other) => other.number === amount.number && other.unit !== "plain",
  );
  return {
    number: amount.number,
    unit:
      unit === "%"
        ? "percent"
        : unit === "bps"
          ? "bps"
          : unit === "$" || unit === "usd"
            ? "currency"
            : amount.unit !== "plain"
              ? amount.unit
              : (written?.unit ?? "plain"),
  };
}
/** Whether a claim's value states exactly the row's number. */
function claimMatchesRow(value: string, row: MetricEvidenceRow["value"]) {
  const stored = rowAmount(row);
  if (!stored) return true;
  return amountsIn(value).some((said) => sameAmount(said, stored));
}

/** Checks every claim of a reply against the profile's metric definitions
 * and the case's evidence rows, and every comparison between two claims.
 *
 * A comparison is a pair the model named in `comparisons`, and every pair of
 * claims when the reply states more than one figure and reads as a
 * comparison. Two figures compare only within one metric, one product and
 * one window. An empty problem list means the claims pass. */
export function checkMetricClaims(input: {
  claims: readonly MetricClaim[];
  comparisons?: readonly (readonly [number, number])[];
  text: string;
  bindings: ReadonlyMap<string, MetricKeyBinding>;
  evidence: readonly MetricEvidenceRow[];
}): MetricClaimProblem[] {
  const problems: MetricClaimProblem[] = [];
  const { claims, bindings } = input;
  if (claims.length > METRIC_CLAIM_LIMITS.claims)
    return [{ kind: "invalid-claim", claims: [] }];
  const rows = new Map(input.evidence.map((row) => [row.n, row]));
  claims.forEach((claim, index) => {
    const binding = bindMetricKey(claim.metric, bindings);
    if (!binding) {
      problems.push({ kind: "unknown-metric", claims: [index] });
      return;
    }
    if (binding.products.length && !binding.products.includes(claim.product))
      problems.push({ kind: "metric-not-for-product", claims: [index] });
    if (!windowFits(binding, claim.window))
      problems.push({ kind: "window-mismatch", claims: [index] });
    if (!claim.evidence.length) {
      problems.push({ kind: "uncited-claim", claims: [index] });
      return;
    }
    for (const n of claim.evidence) {
      const row = rows.get(n);
      if (
        !row ||
        row.withdrawn ||
        row.supersededBy !== null ||
        row.metric.key !== claim.metric ||
        row.product.key !== claim.product ||
        row.window.key !== claim.window ||
        !claimMatchesRow(claim.value, row.value)
      ) {
        problems.push({ kind: "claim-evidence-mismatch", claims: [index] });
        break;
      }
    }
  });
  const pairs = new Map<string, [number, number]>();
  const add = (a: number, b: number) => {
    if (a === b || a < 0 || b < 0 || a >= claims.length || b >= claims.length)
      return;
    const [x, y] = a < b ? [a, b] : [b, a];
    pairs.set(`${x}:${y}`, [x, y]);
  };
  if ((input.comparisons?.length ?? 0) > METRIC_CLAIM_LIMITS.comparisons)
    problems.push({ kind: "invalid-claim", claims: [] });
  for (const [a, b] of input.comparisons ?? []) {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
      problems.push({ kind: "invalid-claim", claims: [] });
      continue;
    }
    add(a, b);
  }
  if (claims.length > 1 && readsAsComparison(input.text))
    for (let a = 0; a < claims.length; a++)
      for (let b = a + 1; b < claims.length; b++) add(a, b);
  for (const [a, b] of pairs.values()) {
    const left = claims[a];
    const right = claims[b];
    if (left.metric !== right.metric)
      problems.push({ kind: "mixed-metrics", claims: [a, b] });
    if (left.product !== right.product)
      problems.push({ kind: "mixed-products", claims: [a, b] });
    if (left.window !== right.window)
      problems.push({ kind: "mixed-windows", claims: [a, b] });
  }
  return problems;
}

/** Plain words for the team, one line per problem kind. */
export const METRIC_CLAIM_PROBLEM_TEXT: Record<MetricClaimProblemKind, string> =
  {
    "invalid-claim": "The reply's numbers couldn't be read.",
    "unknown-metric": "A number names a metric your Protocol tab doesn't define.",
    "metric-not-for-product": "A number uses a metric for a product it doesn't apply to.",
    "window-mismatch": "A number's time window doesn't match its metric.",
    "uncited-claim": "A number has no evidence row behind it.",
    "claim-evidence-mismatch": "A number doesn't match the evidence row it cites.",
    "mixed-metrics": "The reply compares two different metrics.",
    "mixed-products": "The reply compares numbers from two products.",
    "mixed-windows": "The reply compares numbers from two time windows.",
  };
