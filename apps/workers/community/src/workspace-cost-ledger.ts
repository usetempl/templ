import type {
  CostScope,
  WorkspaceCostInvoiceComponent,
} from "@templ/chat/workspace-costs";
import { HttpError, json, readJson } from "./common";
import {
  COST_MONTH,
  COST_WORKSPACE,
  stableCostJson,
  validCostModel,
} from "./workspace-cost-store";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
export type Allocation = {
  componentId: string;
  revision: number;
  weights: { workspace: string; weight: string }[];
};
export type CostRate = {
  id: string;
  revision: number;
  provider: string;
  model: string;
  startsAt: string;
  endsAt: string;
  funding: "api" | "subscription" | "unknown";
  inputIncludesCacheRead: boolean;
  inputIncludesCacheWrite: boolean;
  inputUsdNanosPerMillion: string;
  cachedInputUsdNanosPerMillion: string;
  cacheWriteInputUsdNanosPerMillion: string;
  outputUsdNanosPerMillion: string;
  sourceSha256: string;
};
export type DirectoryRow = {
  workspace: string;
  category: CostScope;
  revision: number;
  firstAt: string;
  lastAt: string;
};
const uint = (v: unknown): v is string =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,23})$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).sort().join() === fields.sort().join();
const fail: () => never = () => {
  throw new HttpError(400, "Invalid accounting record.");
};
function component(value: unknown): WorkspaceCostInvoiceComponent {
  if (
    !object(value) ||
    !exact(value, [
      "id",
      "revision",
      "provider",
      "invoiceId",
      "issuedAt",
      "currency",
      "periodStart",
      "periodEnd",
      "month",
      "category",
      "amountUsdNanos",
      "assignment",
      "workspace",
      "sourceSha256",
      "coverage",
      "kind",
    ])
  )
    fail();
  if (
    ![value.id, value.provider, value.invoiceId].every(
      (v) => typeof v === "string" && ID.test(v),
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    value.currency !== "USD" ||
    typeof value.sourceSha256 !== "string" ||
    !SHA.test(value.sourceSha256) ||
    !["ai", "hosting-storage", "rpc-email", "other"].includes(
      String(value.category),
    ) ||
    !["direct", "shared", "unattributed"].includes(String(value.assignment)) ||
    !["complete", "partial"].includes(String(value.coverage)) ||
    !["usage", "subscription", "discount", "credit", "minimum", "fee"].includes(
      String(value.kind),
    ) ||
    typeof value.amountUsdNanos !== "string" ||
    !/^-?(0|[1-9][0-9]{0,23})$/.test(value.amountUsdNanos)
  )
    fail();
  if (
    BigInt(value.amountUsdNanos) < 0n &&
    !["discount", "credit"].includes(String(value.kind))
  )
    fail();
  const dates = [value.periodStart, value.periodEnd, value.issuedAt].map((v) =>
    typeof v === "string" ? Date.parse(v) : NaN,
  );
  if (
    dates.some((v) => !Number.isFinite(v)) ||
    dates[1] <= dates[0] ||
    dates[1] - dates[0] > 400 * 86_400_000 ||
    typeof value.month !== "string" ||
    !COST_MONTH.test(value.month) ||
    value.month !== String(value.issuedAt).slice(0, 7)
  )
    fail();
  if (
    value.assignment === "direct"
      ? typeof value.workspace !== "string" ||
        !COST_WORKSPACE.test(value.workspace)
      : value.workspace !== null
  )
    fail();
  return value as unknown as WorkspaceCostInvoiceComponent;
}
/** Exact component amount apportioned by billing-period overlap, never issue month. */
export function componentMonthAmount(
  row: WorkspaceCostInvoiceComponent,
  month: string,
): bigint {
  const from = Date.parse(row.periodStart),
    to = Date.parse(row.periodEnd),
    amount = BigInt(row.amountUsdNanos);
  let cursor = from,
    remaining = amount;
  while (cursor < to) {
    const date = new Date(cursor),
      stop = Math.min(
        to,
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
      );
    const piece =
      stop === to
        ? remaining
        : (amount * BigInt(stop - cursor)) / BigInt(to - from);
    if (new Date(cursor).toISOString().slice(0, 7) === month) return piece;
    remaining -= piece;
    cursor = stop;
  }
  return 0n;
}
export async function workspaceCostLedgerRequest(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/workspace-costs/directory") {
    if (request.method === "GET") {
      const workspace = url.searchParams.get("workspace");
      if (workspace !== null) {
        if (!COST_WORKSPACE.test(workspace) || url.searchParams.has("after")) fail();
        return json({ row: (await storage.get<DirectoryRow>("directory:" + workspace)) ?? null });
      }
      const after = url.searchParams.get("after");
      if (after && !COST_WORKSPACE.test(after)) fail();
      const rows = await storage.list<DirectoryRow>({
        prefix: "directory:",
        ...(after ? { startAfter: "directory:" + after } : {}),
        limit: 26,
      });
      const values = [...rows.values()];
      return json({
        rows: values.slice(0, 25),
        nextCursor: values.length > 25 ? values[24].workspace : null,
      });
    }
    if (request.method === "POST") {
      const body = await readJson(request, 2048);
      if (
        typeof body.workspace !== "string" ||
        !COST_WORKSPACE.test(body.workspace) ||
        Object.keys(body).some(
          (k) => !["workspace", "category", "expectedRevision"].includes(k),
        )
      )
        fail();
      return storage.transaction(async (tx) => {
        const key = "directory:" + body.workspace,
          old = await tx.get<DirectoryRow>(key),
          at = new Date().toISOString();
        if (
          body.category !== undefined &&
          (!["customer", "templ-own", "test", "unknown"].includes(
            String(body.category),
          ) ||
            body.expectedRevision !== (old?.revision ?? 0))
        )
          throw new HttpError(
            409,
            "Reload the current workspace classification.",
          );
        const row: DirectoryRow = {
          workspace: body.workspace as string,
          category:
            (body.category as CostScope) ??
            old?.category ??
            (body.workspace === "01a0fe6b-fccc-7633-b0e8-bcb29c000ebb"
              ? "templ-own"
              : "unknown"),
          revision:
            (old?.revision ?? 0) +
            (body.category !== undefined || !old ? 1 : 0),
          firstAt: old?.firstAt ?? at,
          lastAt: at,
        };
        if (
          !old &&
          (await tx.list({ prefix: "directory:", limit: 10001 })).size >= 10000
        )
          throw new HttpError(503, "Workspace accounting directory is full.");
        await tx.put(key, row);
        return json(row);
      });
    }
  }
  if (url.pathname === "/workspace-costs/ledger" && request.method === "GET")
    return json({
      components: [
        ...(
          await storage.list<WorkspaceCostInvoiceComponent>({
            prefix: "component:",
            limit: 8192,
          })
        ).values(),
      ],
      allocations: [
        ...(
          await storage.list<Allocation>({ prefix: "allocation:", limit: 8192 })
        ).values(),
      ],
      rates: [
        ...(
          await storage.list<CostRate>({ prefix: "rate:", limit: 256 })
        ).values(),
      ],
    });
  if (
    url.pathname === "/workspace-costs/invoices" &&
    request.method === "POST"
  ) {
    const body = await readJson(request, 65536);
    if (
      !exact(body, ["components", "totalUsdNanos", "expectedRevisions"]) ||
      !Array.isArray(body.components) ||
      !body.components.length ||
      body.components.length > 64 ||
      !object(body.expectedRevisions) ||
      !/^-?[0-9]{1,24}$/.test(String(body.totalUsdNanos))
    )
      fail();
    const rows = body.components.map(component);
    if (
      new Set(rows.map((r) => r.id)).size !== rows.length ||
      new Set(
        rows.map((r) =>
          [r.invoiceId, r.provider, r.issuedAt, r.sourceSha256].join(":"),
        ),
      ).size !== 1 ||
      rows.reduce((n, r) => n + BigInt(r.amountUsdNanos), 0n).toString() !==
        body.totalUsdNanos
    )
      fail();
    return storage.transaction(async (tx) => {
      const all = await tx.list({ prefix: "component:", limit: 8193 });
      if (
        all.size + rows.filter((r) => !all.has("component:" + r.id)).length >
        8192
      )
        throw new HttpError(503, "Invoice accounting capacity reached.");
      for (const row of rows) {
        const old = await tx.get<WorkspaceCostInvoiceComponent>(
          "component:" + row.id,
        );
        if (stableCostJson(old) === stableCostJson(row)) continue;
        if (
          (body.expectedRevisions as Record<string, unknown>)[row.id] !==
            (old?.revision ?? 0) ||
          row.revision !== (old?.revision ?? 0) + 1
        )
          throw new HttpError(409, "Reload the invoice component revision.");
        await tx.put("component-history:" + row.id + ":" + row.revision, row);
        await tx.put("component:" + row.id, row);
      }
      return json({ imported: rows.length, totalUsdNanos: body.totalUsdNanos });
    });
  }
  if (
    url.pathname === "/workspace-costs/allocations" &&
    request.method === "POST"
  ) {
    const body = await readJson(request, 16384);
    if (
      !exact(body, ["componentId", "expectedRevision", "weights"]) ||
      typeof body.componentId !== "string" ||
      !ID.test(body.componentId) ||
      !Array.isArray(body.weights) ||
      !body.weights.length ||
      body.weights.length > 64
    )
      fail();
    const weights = body.weights as Allocation["weights"];
    if (
      weights.some(
        (v) =>
          !object(v) ||
          !exact(v, ["workspace", "weight"]) ||
          !COST_WORKSPACE.test(v.workspace) ||
          !uint(v.weight) ||
          v.weight === "0",
      ) ||
      new Set(weights.map((v) => v.workspace)).size !== weights.length
    )
      fail();
    return storage.transaction(async (tx) => {
      const row = await tx.get<WorkspaceCostInvoiceComponent>(
        "component:" + body.componentId,
      );
      if (!row || row.assignment !== "shared")
        throw new HttpError(400, "Choose a declared shared invoice component.");
      const key = "allocation:" + body.componentId,
        old = await tx.get<Allocation>(key);
      if (body.expectedRevision !== (old?.revision ?? 0))
        throw new HttpError(409, "Reload the allocation revision.");
      const value: Allocation = {
        componentId: body.componentId as string,
        revision: (old?.revision ?? 0) + 1,
        weights,
      };
      await tx.put(key, value);
      await tx.put(
        "allocation-history:" + body.componentId + ":" + value.revision,
        value,
      );
      return json(value);
    });
  }
  if (url.pathname === "/workspace-costs/rates" && request.method === "POST") {
    const body = await readJson(request, 4096),
      row = body.rate;
    if (
      !object(row) ||
      !exact(row, [
        "id",
        "revision",
        "provider",
        "model",
        "startsAt",
        "endsAt",
        "funding",
        "inputIncludesCacheRead",
        "inputIncludesCacheWrite",
        "inputUsdNanosPerMillion",
        "cachedInputUsdNanosPerMillion",
        "cacheWriteInputUsdNanosPerMillion",
        "outputUsdNanosPerMillion",
        "sourceSha256",
      ]) ||
      typeof row.id !== "string" ||
      !ID.test(row.id) ||
      !["openai", "anthropic", "cloudflare"].includes(String(row.provider)) ||
      !validCostModel(row.model) ||
      !["api", "subscription", "unknown"].includes(String(row.funding)) ||
      typeof row.inputIncludesCacheRead !== "boolean" ||
      typeof row.inputIncludesCacheWrite !== "boolean" ||
      ![
        row.inputUsdNanosPerMillion,
        row.cachedInputUsdNanosPerMillion,
        row.cacheWriteInputUsdNanosPerMillion,
        row.outputUsdNanosPerMillion,
      ].every(uint) ||
      typeof row.sourceSha256 !== "string" ||
      !SHA.test(row.sourceSha256) ||
      !Number.isFinite(Date.parse(String(row.startsAt))) ||
      !Number.isFinite(Date.parse(String(row.endsAt))) ||
      Date.parse(String(row.endsAt)) <= Date.parse(String(row.startsAt))
    )
      fail();
    return storage.transaction(async (tx) => {
      const key = "rate:" + row.id,
        old = await tx.get<CostRate>(key);
      if (
        body.expectedRevision !== (old?.revision ?? 0) ||
        row.revision !== (old?.revision ?? 0) + 1
      )
        throw new HttpError(409, "Reload the rate revision.");
      if (!old && (await tx.list({ prefix: "rate:", limit: 256 })).size >= 256)
        throw new HttpError(409, "The private rate limit has been reached.");
      await tx.put(key, row);
      await tx.put("rate-history:" + row.id + ":" + row.revision, row);
      return json({ ok: true });
    });
  }
  return null;
}
