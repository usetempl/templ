import {
  COST_METRICS,
  WEB2_COST_POLICY,
  type CostMetric,
  type CostValues,
} from "@templ/chat/web2-costs";

export interface CostMetricsEnv {
  COST_METRICS?: DurableObjectNamespace;
  WEB2_COST_SAMPLE_RATE?: string;
  WEB2_COST_RATES_JSON?: string;
  WEB2_COST_INVOICE_JSON?: string;
}
const OBSERVATION = Symbol("web2-cost-observation");
type Observation = {
  sampled: boolean;
  rate: number;
  values: CostValues;
  finished: boolean;
};
type ObservedEnv = CostMetricsEnv & { [OBSERVATION]?: Observation };
export function costSampleRate(env: CostMetricsEnv) {
  const value = Number(
    env.WEB2_COST_SAMPLE_RATE ?? WEB2_COST_POLICY.defaultSampleRate,
  );
  return Number.isFinite(value) && value >= 0.001 && value <= 1
    ? value
    : WEB2_COST_POLICY.defaultSampleRate;
}
/** Request-local capability. No request header can create a metrics collector. */
export function withCostObservation<T extends object>(env: T): T {
  const config = env as CostMetricsEnv;
  const rate = costSampleRate(config);
  return Object.assign({}, env, {
    [OBSERVATION]: {
      sampled: !!config.COST_METRICS && Math.random() < rate,
      rate,
      values: {},
      finished: false,
    },
  });
}
export function recordCostMetric(env: object, metric: CostMetric, value = 1) {
  const observation = (env as ObservedEnv)[OBSERVATION];
  if (
    !observation?.sampled ||
    observation.finished ||
    !Object.hasOwn(COST_METRICS, metric) ||
    !Number.isFinite(value) ||
    value < 0
  )
    return;
  observation.values[metric] =
    COST_METRICS[metric].kind === "maximum"
      ? Math.max(observation.values[metric] ?? 0, value)
      : (observation.values[metric] ?? 0) + value;
}
async function send(env: CostMetricsEnv, values: CostValues, rate: number) {
  if (!env.COST_METRICS || !Object.keys(values).length) return;
  const shard = Math.floor(Math.random() * WEB2_COST_POLICY.shards);
  // Never retry an uncertain telemetry write: metrics cannot delay or duplicate a user action.
  try {
    const response = await env.COST_METRICS.get(
      env.COST_METRICS.idFromName(`web2-costs-v1:${shard}`),
    ).fetch(
      new Request("https://internal/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, sampleRate: rate }),
        signal: AbortSignal.timeout(2000),
      }),
    );
    await response.body?.cancel();
  } catch {
    /* Best-effort observations are explicitly not a complete billing feed. */
  }
}
/** Background work must await this or pass it to state.waitUntil. It emits at most one sampled batch. */
export async function observeCostWorkload(
  env: object,
  input: CostValues | (() => Promise<CostValues>),
  sampleRate?: number,
) {
  try {
    const scoped = (env as ObservedEnv)[OBSERVATION];
    const config = env as CostMetricsEnv;
    const rate = scoped?.rate ?? sampleRate ?? costSampleRate(config);
    if (
      scoped
        ? !scoped.sampled || scoped.finished
        : !config.COST_METRICS || Math.random() >= rate
    )
      return;
    const values = typeof input === "function" ? await input() : input;
    if (scoped) {
      for (const [metric, value] of Object.entries(values))
        recordCostMetric(env, metric as CostMetric, value);
      return;
    }
    await send(config, values, rate);
  } catch {
    // A failed diagnostic read cannot change the result of a committed action.
  }
}
/** No path, query, account, room, wallet or provider URL is stored. */
export function finishCostObservation(
  env: object,
  input: { path: string; status: number; durationMs: number },
  context: Pick<ExecutionContext, "waitUntil">,
) {
  const observation = (env as ObservedEnv)[OBSERVATION];
  if (!observation?.sampled || observation.finished) return;
  recordCostMetric(env, "requests");
  if (input.status >= 500) recordCostMetric(env, "errors");
  if (input.status === 429) recordCostMetric(env, "rateLimited");
  const path = input.path.split(/[?#]/, 1)[0];
  const category =
    path.startsWith("/auth") || path.startsWith("/profiles")
      ? "accountRequests"
      : /\/(conversations|support)(\/|$)/.test(path)
        ? "supportRequests"
        : /^\/(rooms|chat|channels)(\/|$)/.test(path)
          ? "groupRequests"
          : "otherRequests";
  recordCostMetric(env, category);
  recordCostMetric(
    env,
    input.durationMs < 100
      ? "latencyUnder100"
      : input.durationMs < 500
        ? "latencyUnder500"
        : input.durationMs < 1000
          ? "latencyUnder1000"
          : input.durationMs <= 3000
            ? "latencyUnder3000"
            : "latencyOver3000",
  );
  observation.finished = true;
  context.waitUntil(
    send(env as CostMetricsEnv, observation.values, observation.rate),
  );
}
