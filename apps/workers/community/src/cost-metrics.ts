import {
  workspaceCostsRequest,
  pruneWorkspaceCosts,
} from "./workspace-cost-store";
import { workspaceCostLedgerRequest } from "./workspace-cost-ledger";
import {
  workspaceCostOverview,
  workspaceCostOperatorRoute,
  checkedCostMonth,
} from "./workspace-cost-api";
import {
  COST_METRICS,
  WEB2_COST_POLICY,
  costDashboard,
  mergeCostBuckets,
  parseCostInvoice,
  parseCostRates,
  type CostBucket,
  type CostMetric,
} from "@templ/chat/web2-costs";
import { HttpError, json, readJson } from "./common";
import type { Env } from "./common";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import type { CostMetricsEnv } from "./cost-observability";
import { funnelMetricsRequest, pruneFunnelDays } from "./funnel-metrics";
import {
  onboardingMetricsRequest,
  pruneOnboarding,
} from "./onboarding-metrics";
import { opsHealthRequest, pruneOpsHealth } from "./ops-health";
import { incidentsRequest, pruneIncidents } from "./support-incidents";
import {
  corpusDirectoryRequest,
  pruneCorpusDirectory,
} from "./corpus-directory";
import { groupStorageWriteLimitBytes } from "./room-retention";
const DAY = 86400000;
const PREFIX = "web2-cost-day-v1:";
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const validMonth = (value: string) => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);

/** Private binding only. Fixed daily counters; no per-person or per-community
 * records. Cost shards keep sampled workload; one instance keeps the
 * onboarding funnel counts (`funnel-metrics.ts`), another the support
 * health record (`ops-health.ts`) and another Templ's incident notices
 * (`support-incidents.ts`). */
export class CostMetrics {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    try {
      const onboarding = await onboardingMetricsRequest(
        request,
        this.state.storage,
      );
      if (onboarding) return onboarding;
      const workspace = await workspaceCostsRequest(
        request,
        this.state.storage,
      );
      if (workspace) return workspace;
      const ledger = await workspaceCostLedgerRequest(
        request,
        this.state.storage,
      );
      if (ledger) return ledger;
      const funnel = await funnelMetricsRequest(request, this.state.storage);
      if (funnel) return funnel;
      const ops = await opsHealthRequest(request, this.state.storage);
      if (ops) return ops;
      const incidents = await incidentsRequest(request, this.state.storage);
      if (incidents) return incidents;
      const corpus = await corpusDirectoryRequest(request, this.state.storage);
      if (corpus) return corpus;
      const url = new URL(request.url);
      if (url.pathname === "/snapshot" && request.method === "GET") {
        const month = url.searchParams.get("month") ?? "";
        if (!validMonth(month))
          throw new HttpError(400, "Choose a valid month.");
        const days = await this.state.storage.list<CostBucket>({
          prefix: PREFIX + month,
          limit: 31,
        });
        return json({ days: [...days.values()] });
      }
      if (url.pathname !== "/ingest" || request.method !== "POST")
        return json({ error: "Not found." }, 404);
      const body = await readJson(request, 8192);
      const rate = body.sampleRate;
      if (
        Object.keys(body).some(
          (key) => !["values", "sampleRate"].includes(key),
        ) ||
        typeof rate !== "number" ||
        !Number.isFinite(rate) ||
        rate < 0.001 ||
        rate > 1 ||
        !body.values ||
        typeof body.values !== "object" ||
        Array.isArray(body.values)
      )
        throw new HttpError(400, "Invalid metrics batch.");
      const entries = Object.entries(body.values);
      if (
        !entries.length ||
        entries.length > Object.keys(COST_METRICS).length ||
        entries.some(
          ([metric, value]) =>
            !Object.hasOwn(COST_METRICS, metric) ||
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 1e12,
        )
      )
        throw new HttpError(400, "Invalid metrics batch.");
      const now = Date.now(),
        day = dayOf(now),
        key = PREFIX + day;
      await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<CostBucket>(key);
        const next: CostBucket = current ?? {
          day,
          firstAt: now,
          lastAt: now,
          batches: 0,
          minSampleRate: rate,
          maxSampleRate: rate,
          values: {},
        };
        next.lastAt = now;
        next.batches++;
        next.minSampleRate = Math.min(next.minSampleRate, rate);
        next.maxSampleRate = Math.max(next.maxSampleRate, rate);
        for (const [name, raw] of entries) {
          const metric = name as CostMetric,
            value = raw as number,
            previous = next.values[metric];
          next.values[metric] =
            COST_METRICS[metric].kind === "maximum"
              ? {
                  observed: Math.max(previous?.observed ?? 0, value),
                  estimated: null,
                }
              : {
                  observed: (previous?.observed ?? 0) + value,
                  estimated: (previous?.estimated ?? 0) + value / rate,
                };
          if (
            !Number.isSafeInteger(Math.ceil(next.values[metric]!.observed)) ||
            !Number.isSafeInteger(
              Math.ceil(next.values[metric]!.estimated ?? 0),
            )
          )
            throw new HttpError(503, "Metrics capacity needs attention.");
        }
        await storage.put(key, next);
        if (!current) {
          const old = await storage.list({
            prefix: PREFIX,
            end:
              PREFIX + dayOf(now - (WEB2_COST_POLICY.retentionDays - 1) * DAY),
            limit: 64,
          });
          if (old.size) await storage.delete([...old.keys()]);
          await storage.setAlarm(now + DAY);
        }
      });
      return json({ ok: true });
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Metrics are unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
      );
    }
  }
  async alarm() {
    const cutoff =
      PREFIX + dayOf(Date.now() - (WEB2_COST_POLICY.retentionDays - 1) * DAY);
    const old = await this.state.storage.list({
      prefix: PREFIX,
      end: cutoff,
      limit: 64,
    });
    if (old.size) await this.state.storage.delete([...old.keys()]);
    const remaining = await this.state.storage.list({
      prefix: PREFIX,
      limit: 1,
    });
    const workspace = await pruneWorkspaceCosts(this.state.storage, Date.now());
    const funnel = await pruneFunnelDays(this.state.storage, Date.now());
    const onboarding = await pruneOnboarding(this.state.storage, Date.now());
    const ops = await pruneOpsHealth(this.state.storage, Date.now());
    const incidents = await pruneIncidents(this.state.storage, Date.now());
    const corpus = await pruneCorpusDirectory(this.state.storage, Date.now());
    if (
      remaining.size ||
      workspace.active ||
      funnel ||
      onboarding.active ||
      ops ||
      incidents ||
      corpus
    )
      await this.state.storage.setAlarm(
        Math.min(
          Date.now() + (workspace.backlog || onboarding.backlog ? 1000 : DAY),
          workspace.nextResourceAt ?? Infinity,
        ),
      );
  }
}

export async function operatorCostsRoute<S extends ServiceSession>(
  request: Request,
  env: OperatorAdminEnv &
    CostMetricsEnv &
    Pick<Env, "DO_STORAGE_PLAN"> &
    Partial<Pick<Env, "ROOMS" | "APP_ORIGIN">>,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/operator/costs" &&
    !url.pathname.startsWith("/operator/costs/")
  )
    return null;
  const session = await auth.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(403, "This page is for Templ operators.");
  const workspace = await workspaceCostOperatorRoute(request, env, session);
  if (workspace) return workspace;
  if (request.method !== "GET" || url.pathname !== "/operator/costs")
    throw new HttpError(404, "Not found.");
  const now = Date.now(),
    month = url.searchParams.get("month") ?? dayOf(now).slice(0, 7);
  const date = new Date(now);
  const previousMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  checkedCostMonth(month, now);
  const globalMonth = [dayOf(now).slice(0, 7), previousMonth].includes(month);
  const shards =
    env.COST_METRICS && globalMonth
      ? await Promise.allSettled(
          Array.from({ length: WEB2_COST_POLICY.shards }, async (_, index) => {
            const response = await env
              .COST_METRICS!.get(
                env.COST_METRICS!.idFromName(`web2-costs-v1:${index}`),
              )
              .fetch(
                new Request(`https://internal/snapshot?month=${month}`, {
                  signal: AbortSignal.timeout(2000),
                }),
              );
            if (!response.ok) throw new Error("Unavailable");
            return (await response.json<{ days: CostBucket[] }>()).days;
          }),
        )
      : [];
  const raw = shards.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const days = [...new Set(raw.map((day) => day.day))].sort().map((day) => {
    const matches = raw.filter((row) => row.day === day);
    return {
      day,
      firstAt: Math.min(...matches.map((row) => row.firstAt)),
      lastAt: Math.max(...matches.map((row) => row.lastAt)),
      batches: matches.reduce((sum, row) => sum + row.batches, 0),
      minSampleRate: Math.min(...matches.map((row) => row.minSampleRate)),
      maxSampleRate: Math.max(...matches.map((row) => row.maxSampleRate)),
      values: mergeCostBuckets(matches),
    };
  });
  return json({
    ...costDashboard({
      month,
      now,
      days,
      available:
        shards.length === WEB2_COST_POLICY.shards &&
        shards.every((result) => result.status === "fulfilled"),
      rates: parseCostRates(env.WEB2_COST_RATES_JSON),
      invoice: parseCostInvoice(env.WEB2_COST_INVOICE_JSON, month),
    }),
    storageWriteLimitBytes: groupStorageWriteLimitBytes(env.DO_STORAGE_PLAN),
    workspaceCosts: await workspaceCostOverview(
      env,
      month,
      url.searchParams.get("after"),
    ),
  });
}
