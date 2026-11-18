import type {
  WorkspaceCostDetail,
  WorkspaceCostFinance,
  WorkspaceCostInvoiceComponent,
  WorkspaceCostOverview,
  WorkspaceCostRow,
} from "@templ/chat/workspace-costs";
import { HttpError, json, readJson, type Env } from "./common";
import type { ServiceSession } from "./service-principals";
import { defer } from "./request-context";
import {
  COST_MONTH,
  COST_WORKSPACE,
  type CostDay,
} from "./workspace-cost-store";
import {
  componentMonthAmount,
  type Allocation,
  type CostRate,
  type DirectoryRow,
} from "./workspace-cost-ledger";
import {
  BILLING_INDEX_OBJECT,
  BILLING_INDEX_PATH,
  ROOM_OPERATOR_BILLING_PATH,
} from "./operator-billing";

type CostEnv = {
  COST_METRICS?: DurableObjectNamespace;
  ROOMS?: DurableObjectNamespace;
  APP_ORIGIN?: string;
};
type Snapshot = {
  days: CostDay[];
  finance: WorkspaceCostFinance | null;
  meta: {
    firstAt: string;
    lastAt: string;
    receipts?: number;
    receiptBytes?: number;
  } | null;
};
type Ledger = {
  components: WorkspaceCostInvoiceComponent[];
  allocations: Allocation[];
  rates: CostRate[];
};
const usd = (v: bigint) => Number(v) / 1e9;
const EMPTY: Ledger = { components: [], allocations: [], rates: [] };
const OBJECTS = {
  directory: "workspace-cost-directory-v1",
  ledger: "workspace-cost-invoices-v1",
};
async function call<T>(
  env: CostEnv,
  object: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!env.COST_METRICS)
    throw new HttpError(503, "Workspace cost recording is unavailable.");
  const response = await env.COST_METRICS.get(
    env.COST_METRICS.idFromName(object),
  ).fetch(
    new Request("https://internal/workspace-costs/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    }),
  );
  if (!response.ok) {
    const data = await response.json<{ error?: string }>();
    throw new HttpError(
      response.status,
      data.error ?? "Cost accounting is unavailable.",
    );
  }
  return response.json<T>();
}
export function checkedCostMonth(month: string, now = Date.now()) {
  if (!COST_MONTH.test(month))
    throw new HttpError(400, "Choose a valid month.");
  const date = new Date(now),
    first = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 12, 1),
    )
      .toISOString()
      .slice(0, 7);
  if (month < first || month > date.toISOString().slice(0, 7))
    throw new HttpError(400, "Choose one of the last thirteen months.");
  return month;
}
function allocated(
  row: WorkspaceCostInvoiceComponent,
  amount: bigint,
  ledger: Ledger,
  workspace: string,
) {
  const rule = ledger.allocations.find((r) => r.componentId === row.id);
  if (!rule) return null;
  const total = rule.weights.reduce((sum, r) => sum + BigInt(r.weight), 0n);
  let assigned = 0n;
  for (let i = 0; i < rule.weights.length; i++) {
    const r = rule.weights[i],
      piece =
        i === rule.weights.length - 1
          ? amount - assigned
          : (amount * BigInt(r.weight)) / total;
    if (r.workspace === workspace) return piece;
    assigned += piece;
  }
  return 0n;
}
function estimateAi(snapshot: Snapshot, ledger: Ledger): bigint | null {
  let sum = 0n,
    count = 0;
  for (const day of snapshot.days)
    for (const bucket of day.resources) {
      if (bucket.pending || bucket.missingUsage) return null;
      const rates = ledger.rates.filter(
        (r) =>
          r.provider === bucket.provider &&
          r.model === bucket.model &&
          r.funding === "api" &&
          Date.parse(r.startsAt) <= Date.parse(day.day) &&
          Date.parse(r.endsAt) >= Date.parse(day.day) + 86_400_000,
      );
      if (rates.length !== 1) return null;
      const rate = rates[0],
        usage = bucket.usage;
      if (
        usage.inputTokens === null ||
        usage.outputTokens === null ||
        usage.cachedInputTokens === null ||
        usage.cacheWriteInputTokens === null
      )
        return null;
      const input =
        usage.inputTokens -
        (rate.inputIncludesCacheRead ? usage.cachedInputTokens : 0) -
        (rate.inputIncludesCacheWrite ? usage.cacheWriteInputTokens : 0);
      if (input < 0) return null;
      sum +=
        (BigInt(input) * BigInt(rate.inputUsdNanosPerMillion) +
          BigInt(usage.cachedInputTokens) *
            BigInt(rate.cachedInputUsdNanosPerMillion) +
          BigInt(usage.cacheWriteInputTokens) *
            BigInt(rate.cacheWriteInputUsdNanosPerMillion) +
          BigInt(usage.outputTokens) * BigInt(rate.outputUsdNanosPerMillion)) /
        1_000_000n;
      count += bucket.invocations;
    }
  return count ? sum : null;
}
function rowFor(
  workspace: string,
  month: string,
  snapshot: Snapshot,
  ledger: Ledger,
  directory?: DirectoryRow,
): WorkspaceCostRow {
  const missing: string[] = [],
    categories = new Map<string, bigint>(),
    covered = new Set<string>();
  let direct = 0n,
    shared = 0n,
    known = 0n,
    hasKnown = false,
    sharedKnown = true;
  for (const component of ledger.components) {
    const amount = componentMonthAmount(component, month);
    if (
      amount === 0n &&
      !(
        component.periodStart.slice(0, 7) <= month &&
        component.periodEnd.slice(0, 7) >= month
      )
    )
      continue;
    if (
      component.assignment === "direct" &&
      component.workspace === workspace
    ) {
      direct += amount;
      known += amount;
      hasKnown = true;
      categories.set(
        component.category,
        (categories.get(component.category) ?? 0n) + amount,
      );
      if (component.coverage === "complete") covered.add(component.category);
    }
    if (component.assignment === "shared") {
      const piece = allocated(component, amount, ledger, workspace);
      if (piece === null) sharedKnown = false;
      else {
        shared += piece;
        known += piece;
        hasKnown = true;
      }
    }
  }
  if (!categories.has("ai")) {
    const estimate = estimateAi(snapshot, ledger);
    if (estimate !== null) {
      categories.set("ai", estimate);
      known += estimate;
      hasKnown = true;
      missing.push(
        "AI costs use dated API estimates; invoice reconciliation is missing.",
      );
    } else missing.push("AI invoice costs or verified API rates are missing.");
  }
  if (categories.has("ai") && !covered.has("ai"))
    missing.push("Complete AI invoices are missing.");
  if (!covered.has("hosting-storage"))
    missing.push("Complete hosting and storage invoices are missing.");
  if (!covered.has("rpc-email"))
    missing.push("Complete RPC and email invoices are missing.");
  if (!sharedKnown)
    missing.push("Shared invoice costs need an allocation rule.");
  if (
    ledger.components.some(
      (r) =>
        r.assignment === "unattributed" &&
        componentMonthAmount(r, month) !== 0n,
    )
  )
    missing.push("Provider invoice costs remain unattributed.");
  if (!snapshot.meta) missing.push("Workspace usage has not been recorded.");
  if (snapshot.days.some((d) => d.recordingGaps))
    missing.push("Some usage observations were not recorded.");
  if (
    snapshot.days.some((d) =>
      d.resources.some((r) => r.pending || r.missingUsage),
    )
  )
    missing.push("Some AI calls have pending or missing provider usage.");
  missing.push(
    "Best-effort usage does not prove all upstream billable attempts.",
  );
  const finance = snapshot.finance;
  if (!finance) missing.push("The financial snapshot is pending.");
  else {
    missing.push(...finance.missing);
    if (Date.now() - Date.parse(finance.asOf) > 900_000)
      missing.push("The financial snapshot needs a refresh.");
  }
  for (const component of ledger.components)
    if (component.workspace === workspace && component.coverage !== "complete")
      covered.delete(component.category);
  const directComplete = ["ai", "hosting-storage", "rpc-email", "other"].every(
    (c) => covered.has(c),
  );
  const total =
    missing.length === 0 &&
    directComplete &&
    sharedKnown &&
    !ledger.components.some(
      (r) =>
        r.assignment === "unattributed" &&
        componentMonthAmount(r, month) !== 0n,
    )
      ? direct + shared
      : null;
  const revenue =
    finance?.earnedRevenueUsdNanos === undefined ||
    finance.earnedRevenueUsdNanos === null
      ? null
      : BigInt(finance.earnedRevenueUsdNanos);
  return {
    workspace,
    name: null,
    category:
      directory?.category ??
      (workspace === "01a0fe6b-fccc-7633-b0e8-bcb29c000ebb"
        ? "templ-own"
        : "unknown"),
    month,
    earnedRevenueUsd: revenue === null ? null : usd(revenue),
    paymentsReceivedUsd:
      finance?.paymentsReceivedUsdNanos == null
        ? null
        : usd(BigInt(finance.paymentsReceivedUsdNanos)),
    aiUsd: categories.has("ai") ? usd(categories.get("ai")!) : null,
    hostingStorageUsd: categories.has("hosting-storage")
      ? usd(categories.get("hosting-storage")!)
      : null,
    rpcEmailUsd: categories.has("rpc-email")
      ? usd(categories.get("rpc-email")!)
      : null,
    directUsd: directComplete ? usd(direct) : null,
    sharedUsd:
      sharedKnown &&
      ledger.allocations.some((rule) =>
        rule.weights.some((w) => w.workspace === workspace),
      )
        ? usd(shared)
        : null,
    knownSubtotalUsd: hasKnown ? usd(known) : null,
    totalUsd: total === null ? null : usd(total),
    ticketsOpened: finance?.ticketsOpened ?? null,
    confirmedAiResolutions: finance?.confirmedAiResolutions ?? null,
    costPerTicketUsd:
      total !== null && (finance?.ticketsOpened ?? 0) > 0
        ? usd(total) / finance!.ticketsOpened!
        : null,
    costPerConfirmedAiResolutionUsd:
      total !== null && (finance?.confirmedAiResolutions ?? 0) > 0
        ? usd(total) / finance!.confirmedAiResolutions!
        : null,
    grossMarginPercent:
      missing.length === 0 &&
      total !== null &&
      revenue !== null &&
      revenue > 0n &&
      !finance?.missing.length
        ? ((usd(revenue) - usd(total)) / usd(revenue)) * 100
        : null,
    status:
      missing.length === 0 &&
      total !== null &&
      finance &&
      !finance.missing.length
        ? "reconciled"
        : hasKnown || snapshot.meta || finance
          ? "partial"
          : "missing",
    missing: [...new Set(missing)],
    usageUpdatedAt: snapshot.meta?.lastAt ?? null,
    financeUpdatedAt: finance?.asOf ?? null,
    coverageStartedAt: snapshot.meta?.firstAt ?? null,
  };
}
async function refreshFinance(env: CostEnv, workspace: string, month: string) {
  if (!env.ROOMS) return;
  try {
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName("native-room:" + workspace),
    ).fetch(
      new Request("https://internal" + ROOM_OPERATOR_BILLING_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "cost-finance", month, asOf: Date.now() }),
        signal: AbortSignal.timeout(2000),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    const value = await response.json<WorkspaceCostFinance>();
    await call(env, `workspace-costs-v1:${workspace}`, "finance", value);
  } catch {
    /* A missing snapshot stays explicitly unavailable. */
  }
}
export async function workspaceCostOverview(
  env: CostEnv,
  month: string,
  after: string | null,
): Promise<WorkspaceCostOverview> {
  checkedCostMonth(month);
  if (after && !COST_WORKSPACE.test(after))
    throw new HttpError(400, "Invalid workspace cursor.");
  const [directory, ledger, billing] = await Promise.all([
    call<{ rows: DirectoryRow[]; nextCursor: string | null }>(
      env,
      OBJECTS.directory,
      "directory" + (after ? "?after=" + after : ""),
    ).catch(() => ({ rows: [], nextCursor: null })),
    call<Ledger>(env, OBJECTS.ledger, "ledger").catch(() => EMPTY),
    env.ROOMS
      ? env.ROOMS.get(env.ROOMS.idFromName(BILLING_INDEX_OBJECT))
          .fetch(
            new Request(
              "https://internal" +
                BILLING_INDEX_PATH +
                (after ? "?after=" + after : ""),
              { signal: AbortSignal.timeout(2000) },
            ),
          )
          .then((r) =>
            r.ok
              ? r.json<{ workspaces: string[]; next: string | null }>()
              : { workspaces: [], next: null },
          )
          .catch(() => ({ workspaces: [], next: null }))
      : { workspaces: [], next: null },
  ]);
  const workspaces = [
    ...new Set([
      ...directory.rows.map((r) => r.workspace),
      ...billing.workspaces,
      ...ledger.components.flatMap((r) => (r.workspace ? [r.workspace] : [])),
      ...ledger.allocations.flatMap((r) => r.weights.map((w) => w.workspace)),
    ]),
  ]
    .filter((w) => COST_WORKSPACE.test(w) && (!after || w > after))
    .sort();
  const selected = workspaces.slice(0, 25),
    rows: WorkspaceCostRow[] = [],
    deadline = Date.now() + 2200;
  let cursor = 0;
  const refresh: string[] = [];
  await Promise.all(
    [0, 1].map(async () => {
      for (;;) {
        const index = cursor++;
        if (index >= selected.length) break;
        const workspace = selected[index];
        let snapshot: Snapshot = { days: [], finance: null, meta: null };
        if (Date.now() < deadline)
          snapshot = await call<Snapshot>(
            env,
            `workspace-costs-v1:${workspace}`,
            "snapshot?month=" + month,
          ).catch(() => snapshot);
        rows[index] = rowFor(
          workspace,
          month,
          snapshot,
          ledger,
          directory.rows.find((r) => r.workspace === workspace),
        );
        if (
          !snapshot.finance ||
          Date.now() - Date.parse(snapshot.finance.asOf) > 900_000
        )
          refresh.push(workspace);
      }
    }),
  );
  if (refresh.length)
    defer(env, async () => {
      let next = 0;
      const deadline = Date.now() + 12000;
      await Promise.all(
        [0, 1].map(async () => {
          while (next < refresh.length && Date.now() < deadline)
            await refreshFinance(env, refresh[next++], month);
        }),
      );
    });
  let direct = 0n,
    shared = 0n,
    unattributed = 0n,
    unallocated = 0n;
  for (const component of ledger.components) {
    if (component.issuedAt.slice(0, 7) !== month) continue;
    const amount = BigInt(component.amountUsdNanos);
    if (component.assignment === "direct") direct += amount;
    else if (component.assignment === "unattributed") unattributed += amount;
    else if (ledger.allocations.some((r) => r.componentId === component.id))
      shared += amount;
    else unallocated += amount;
  }
  return {
    schemaVersion: 1,
    month,
    asOf: new Date().toISOString(),
    rows,
    nextCursor:
      workspaces.length > 25 || directory.nextCursor || billing.next
        ? (selected.at(-1) ?? null)
        : null,
    missing: [
      "Historical workspace attribution is unavailable before collection began.",
      "Unmapped provider resources and missing funding remain unavailable.",
      "Workspace inventory is partial; billing and metering directories may omit inactive workspaces.",
    ],
    reconciliation: {
      invoiceUsd: ledger.components.some(
        (c) => c.issuedAt.slice(0, 7) === month,
      )
        ? usd(direct + shared + unattributed + unallocated)
        : null,
      directUsd: usd(direct),
      allocatedUsd: usd(shared),
      unattributedUsd: usd(unattributed),
      unallocatedSharedUsd: usd(unallocated),
      components: ledger.components.filter(
        (c) => c.issuedAt.slice(0, 7) === month,
      ).length,
      status: !ledger.components.some((c) => c.issuedAt.slice(0, 7) === month)
        ? "missing"
        : unattributed || unallocated
          ? "partial"
          : "reconciled",
    },
  };
}
export async function workspaceCostOperatorRoute(
  request: Request,
  env: CostEnv,
  session: ServiceSession,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/operator\/costs\/workspaces\/([a-f0-9-]{36})$/.exec(
      url.pathname,
    );
  if (match && COST_WORKSPACE.test(match[1]) && request.method === "GET") {
    const month = checkedCostMonth(
        url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7),
      ),
      workspace = match[1];
    const [snapshot, ledger, directory] = await Promise.all([
      call<Snapshot>(
        env,
        `workspace-costs-v1:${workspace}`,
        "snapshot?month=" + month,
      ),
      call<Ledger>(env, OBJECTS.ledger, "ledger"),
      call<{ row: DirectoryRow | null }>(env, OBJECTS.directory, "directory?workspace=" + workspace),
    ]);
    if (
      !snapshot.finance ||
      Date.now() - Date.parse(snapshot.finance.asOf) > 900_000
    )
      defer(env, () => refreshFinance(env, workspace, month));
    const row = rowFor(workspace, month, snapshot, ledger, directory.row ?? undefined);
    const detail: WorkspaceCostDetail = {
      schemaVersion: 1,
      row,
      days: snapshot.days,
      invoices: ledger.components.filter(
        (r) =>
          r.workspace === workspace ||
          ledger.allocations.some(
            (a) =>
              a.componentId === r.id &&
              a.weights.some((w) => w.workspace === workspace),
          ),
      ),
      financeBasis: snapshot.finance?.basis ?? ["Financial snapshot pending."],
      resourcesMissing: [
        ...(snapshot.meta &&
        Number.isSafeInteger(snapshot.meta.receipts) &&
        Number(snapshot.meta.receipts) >= 0 &&
        Number.isSafeInteger(snapshot.meta.receiptBytes) &&
        Number(snapshot.meta.receiptBytes) >= 0
          ? [
              `Usage recorder storage: ${snapshot.meta.receipts} receipts (limit 65536), ${snapshot.meta.receiptBytes} bytes (limit 33554432). Reaching either limit can leave usage unrecorded.`,
            ]
          : ["Usage recorder storage counts are unavailable."]),
        "RPC attempts are not provider billing units.",
        "Retained uploaded bytes do not measure the entire storage bill.",
        "Hosted instance observations need actual provider invoice/resource mapping.",
      ],
    };
    return json(detail);
  }
  const target = ["invoices", "allocations", "rates", "classification"].find(
    (name) => url.pathname === "/operator/costs/" + name,
  );
  if (!target) return null;
  if (request.method !== "POST")
    throw new HttpError(405, "Choose an accounting action.");
  if (
    request.headers.get("Origin") !== (env.APP_ORIGIN ?? "https://usetempl.com")
  )
    throw new HttpError(403, "Use the signed-in Templ page.");
  const body = await readJson(request, 65536);
  if (
    body.expectedPrincipalId !== session.principalId ||
    body.confirmed !== true
  )
    throw new HttpError(
      409,
      "Your account changed. Review this accounting action.",
    );
  const { expectedPrincipalId: _, confirmed: __, ...payload } = body;
  return json(
    await call(
      env,
      target === "classification" ? OBJECTS.directory : OBJECTS.ledger,
      target === "classification" ? "directory" : target,
      payload,
    ),
  );
}
