import type {
  CostIngestAck,
  CostProducer,
  WorkspaceCostEvent,
  WorkspaceCostResource,
  WorkspaceResourceEvent,
  WorkspaceResourceTotal,
} from "@templ/chat/workspace-costs";
import { HttpError, json, readJson } from "./common";

export const COST_WORKSPACE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const COST_MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID =
  /^(?:unknown|@cf\/[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9._:-]*|[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)+)$/;
const privateIdentifier = (value: string) =>
  value.length > 96 || /:\/\/|0x[a-f0-9]{40}/i.test(value);
export const validCostModel = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value) && !privateIdentifier(value);
export const validCostInstance = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9:_-]{1,128}$/.test(value) &&
  !/0x[a-f0-9]{40}/i.test(value) &&
  !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const HASH = /^[a-f0-9]{64}$/;
const DAY = 86_400_000;
const RESOURCE_REPLAY_MS = 3_600_000;
const RESOURCE_EXPIRY = "workspace-resource-cost-expiry:v2:";
const RESOURCE_CURSOR = "workspace-resource-cost-prune:v2";
const DAY_KEY = "workspace-cost-day-v1:";
const ATTEMPT = "workspace-cost-attempt-v1:";
const EXPIRY = "workspace-cost-expiry-v1:";
const META = "workspace-cost-meta-v1";
const PRODUCERS = ["hosted-ai", "native-ai", "telegram-polish"];
const COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningTokens",
  "billableUnits",
] as const;
export type CostDay = {
  day: string;
  updatedAt: string;
  recordingGaps: number;
  resources: WorkspaceCostResource[];
  resourceTotals: WorkspaceResourceTotal[];
};
type Receipt = {
  producer: CostProducer;
  scope: string;
  day: string;
  startedAt: string;
  provider: string;
  model: string;
  purpose: WorkspaceCostEvent["purpose"];
  phases: Partial<Record<WorkspaceCostEvent["phase"], string>>;
  terminal?: WorkspaceCostEvent;
  consumer?: WorkspaceCostEvent["consumerOutcome"];
};
const emptyUsage = () => ({
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  billableUnits: null,
});
const fail: () => never = () => {
  throw new HttpError(400, "Invalid private cost observation.");
};
const exact = (
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
export const stableCostJson = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(stableCostJson(v)))
        : Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, v]) => [key, JSON.parse(stableCostJson(v))]),
          )
      : value,
  );
export const costHash = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableCostJson(value)),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function checkedCostEvent(
  value: unknown,
  now = Date.now(),
): WorkspaceCostEvent {
  if (
    !object(value) ||
    !exact(
      value,
      [
        "schemaVersion",
        "attemptId",
        "phase",
        "at",
        "provider",
        "model",
        "purpose",
      ],
      [
        "requestedModel",
        "transportOutcome",
        "consumerOutcome",
        "usage",
        "durationMs",
      ],
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.attemptId !== "string" ||
    !UUID.test(value.attemptId) ||
    !["started", "provider-finished", "consumer-finished"].includes(
      String(value.phase),
    ) ||
    !["openai", "anthropic", "cloudflare"].includes(String(value.provider)) ||
    typeof value.model !== "string" ||
    !validCostModel(value.model) ||
    (value.requestedModel !== undefined &&
      (typeof value.requestedModel !== "string" ||
        !ID.test(value.requestedModel) ||
        privateIdentifier(value.requestedModel))) ||
    !["answer", "draft", "handoff", "polish", "other"].includes(
      String(value.purpose),
    )
  )
    fail();
  const at = typeof value.at === "string" ? Date.parse(value.at) : NaN;
  if (
    !Number.isFinite(at) ||
    new Date(at).toISOString() !== value.at ||
    at > now + 60_000 ||
    at < now - 62 * DAY
  )
    fail();
  if (
    value.transportOutcome !== undefined &&
    !["completed", "failed", "cancelled", "timeout"].includes(
      String(value.transportOutcome),
    )
  )
    fail();
  if (
    value.consumerOutcome !== undefined &&
    ![
      "answer",
      "draft",
      "handoff",
      "unresolved",
      "cancelled",
      "discarded",
      "failed",
    ].includes(String(value.consumerOutcome))
  )
    fail();
  if (
    value.durationMs !== undefined &&
    (!Number.isSafeInteger(value.durationMs) ||
      Number(value.durationMs) < 0 ||
      Number(value.durationMs) > DAY)
  )
    fail();
  if (value.usage !== undefined) {
    if (
      !object(value.usage) ||
      !exact(value.usage, [...COUNTERS]) ||
      Object.values(value.usage).some(
        (v) =>
          v !== null &&
          (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 1e12),
      )
    )
      fail();
  }
  if (
    value.phase === "started" &&
    (value.usage !== undefined ||
      value.transportOutcome !== undefined ||
      value.consumerOutcome !== undefined)
  )
    fail();
  if (
    value.phase === "provider-finished" &&
    value.transportOutcome === undefined
  )
    fail();
  if (
    value.phase === "consumer-finished" &&
    (value.consumerOutcome === undefined ||
      value.usage !== undefined ||
      value.transportOutcome !== undefined)
  )
    fail();
  if (JSON.stringify(value).length > 2048) fail();
  return value as unknown as WorkspaceCostEvent;
}
export function checkedResourceEvent(
  value: unknown,
  now = Date.now(),
): WorkspaceResourceEvent {
  if (
    !object(value) ||
    !exact(
      value,
      [
        "schemaVersion",
        "eventId",
        "at",
        "kind",
        "provider",
        "metric",
        "quantity",
        "unit",
      ],
      ["instanceId", "method", "outcome"],
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.eventId !== "string" ||
    !UUID.test(value.eventId) ||
    !["requests", "rpc", "email", "storage"].includes(String(value.kind)) ||
    !["cloudflare", "alchemy", "drpc", "resend", "unknown"].includes(
      String(value.provider),
    ) ||
    ![
      "requests",
      "rpc-attempts",
      "email-attempts",
      "email-accepted",
      "retained-byte-ms",
      "storage-read-ops",
      "storage-write-ops",
      "storage-retained-bytes",
    ].includes(String(value.metric)) ||
    !["request", "byte-ms", "byte", "operation"].includes(String(value.unit)) ||
    typeof value.quantity !== "string" ||
    !/^(0|[1-9][0-9]{0,29})$/.test(value.quantity)
  )
    fail();
  const at = typeof value.at === "string" ? Date.parse(value.at) : NaN;
  if (
    !Number.isFinite(at) ||
    new Date(at).toISOString() !== value.at ||
    at > now + 60_000 ||
    at < now - RESOURCE_REPLAY_MS
  )
    fail();
  if (value.instanceId !== undefined && !validCostInstance(value.instanceId))
    fail();
  if (
    value.method !== undefined &&
    (typeof value.method !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.method) ||
      /0x[a-f0-9]{40}/i.test(value.method) ||
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.method))
  )
    fail();
  if (
    value.outcome !== undefined &&
    !["accepted", "failed", "unknown"].includes(String(value.outcome))
  )
    fail();
  if (JSON.stringify(value).length > 2048) fail();
  return value as unknown as WorkspaceResourceEvent;
}
function addReceipt(day: CostDay, receipt: Receipt, sign: 1 | -1) {
  const key = [
    receipt.producer,
    receipt.provider,
    receipt.model,
    receipt.purpose,
  ].join(":");
  let bucket = day.resources.find(
    (row) =>
      [row.producer, row.provider, row.model, row.purpose].join(":") === key,
  );
  if (!bucket) {
    if (day.resources.length >= 32)
      throw new HttpError(503, "Cost recording capacity reached.");
    bucket = {
      producer: receipt.producer,
      provider: receipt.provider,
      model: receipt.model,
      purpose: receipt.purpose,
      invocations: 0,
      completed: 0,
      failed: 0,
      missingUsage: 0,
      pending: 0,
      usage: emptyUsage(),
      durationMs: 0,
      consumerOutcomes: {},
    };
    day.resources.push(bucket);
  }
  bucket.invocations += sign;
  const terminal = receipt.terminal;
  if (!terminal) bucket.pending += sign;
  else {
    if (terminal.transportOutcome === "completed") bucket.completed += sign;
    else bucket.failed += sign;
    if (
      !terminal.usage ||
      terminal.usage.inputTokens === null ||
      terminal.usage.outputTokens === null
    )
      bucket.missingUsage += sign;
    if (terminal.usage)
      for (const name of COUNTERS)
        if (terminal.usage[name] !== null)
          bucket.usage[name] =
            (bucket.usage[name] ?? 0) + sign * terminal.usage[name]!;
    bucket.durationMs += sign * (terminal.durationMs ?? 0);
  }
  if (receipt.consumer)
    bucket.consumerOutcomes[receipt.consumer] =
      (bucket.consumerOutcomes[receipt.consumer] ?? 0) + sign;
  day.resources = day.resources.filter((row) => row.invocations > 0);
  for (const row of day.resources)
    if (
      [
        row.invocations,
        row.durationMs,
        ...Object.values(row.usage).filter((v) => v !== null),
      ].some((v) => !Number.isSafeInteger(v) || Number(v) < 0)
    )
      throw new HttpError(503, "Cost recording capacity reached.");
}
export async function workspaceCostsRequest(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/workspace-costs/")) return null;
  if (url.pathname === "/workspace-costs/health" && request.method === "POST") {
    const body = await readJson(request, 2048);
    if (
      !exact(body, ["at", "recordingGaps", "pendingAttempts", "instance"]) ||
      !validCostInstance(body.instance) ||
      !Number.isSafeInteger(body.recordingGaps) ||
      Number(body.recordingGaps) < 0 ||
      !Number.isSafeInteger(body.pendingAttempts) ||
      Number(body.pendingAttempts) < 0 ||
      Number(body.pendingAttempts) > 256 ||
      typeof body.at !== "string" ||
      !Number.isFinite(Date.parse(body.at)) ||
      Date.parse(body.at) > Date.now() + 60_000 ||
      Date.parse(body.at) < Date.now() - 62 * DAY
    )
      fail();
    await storage.transaction(async (tx) => {
      const key = "workspace-cost-health-v1:" + body.instance,
        old = await tx.get<{ at: string; recordingGaps: number }>(key);
      if (old && Date.parse(old.at) > Date.parse(body.at as string)) return;
      if (
        !old &&
        (await tx.list({ prefix: "workspace-cost-health-v1:", limit: 17 }))
          .size >= 16
      )
        throw new HttpError(503, "Cost recorder inventory is full.");
      const gaps = Math.max(
        Number(body.recordingGaps),
        old?.recordingGaps ?? 0,
      );
      await tx.put(key, { ...body, recordingGaps: gaps });
      const dayName = String(body.at).slice(0, 10),
        day = (await tx.get<CostDay>(DAY_KEY + dayName)) ?? {
          day: dayName,
          updatedAt: new Date().toISOString(),
          recordingGaps: 0,
          resources: [],
          resourceTotals: [],
        };
      day.recordingGaps += gaps - (old?.recordingGaps ?? 0);
      await tx.put(DAY_KEY + dayName, day);
    });
    return json({ unavailable: false });
  }
  if (
    url.pathname === "/workspace-costs/snapshot" &&
    request.method === "GET"
  ) {
    const month = url.searchParams.get("month") ?? "";
    if (!COST_MONTH.test(month)) fail();
    return json({
      days: [
        ...(
          await storage.list<CostDay>({ prefix: DAY_KEY + month, limit: 31 })
        ).values(),
      ],
      finance:
        (await storage.get("workspace-cost-finance-v1:" + month)) ?? null,
      meta: (await storage.get(META)) ?? null,
    });
  }
  if (
    url.pathname === "/workspace-costs/finance" &&
    request.method === "POST"
  ) {
    const body = await readJson(request, 16384);
    if (typeof body.month !== "string" || !COST_MONTH.test(body.month)) fail();
    await storage.transaction(async (tx) => {
      const key = "workspace-cost-finance-v1:" + body.month;
      const old = await tx.get<{ asOf: string }>(key);
      if (!old || Date.parse(String(body.asOf)) >= Date.parse(old.asOf))
        await tx.put(key, body);
    });
    return json({ ok: true });
  }
  if (
    !["/workspace-costs/ingest", "/workspace-costs/resource"].includes(
      url.pathname,
    ) ||
    request.method !== "POST"
  )
    return null;
  const body = await readJson(request, 32768);
  if (
    !exact(
      body,
      ["workspace", "producer", "events"],
      ["scopeDigest", "instance"],
    ) ||
    typeof body.workspace !== "string" ||
    !COST_WORKSPACE.test(body.workspace) ||
    !Array.isArray(body.events) ||
    !body.events.length ||
    body.events.length > 16
  )
    fail();
  const resource = url.pathname.endsWith("/resource");
  if (!resource && !PRODUCERS.includes(String(body.producer))) fail();
  if (resource && body.producer !== "resource") fail();
  const scope = body.scopeDigest ?? "";
  if (
    typeof scope !== "string" ||
    (scope && !HASH.test(scope)) ||
    (body.producer === "telegram-polish" && !scope)
  )
    fail();
  const now = Date.now();
  const events = body.events.map((value) =>
    resource ? checkedResourceEvent(value, now) : checkedCostEvent(value, now),
  );
  const digests = await Promise.all(events.map(costHash));
  const occupancy = await storage.get<{ workspace: string; receipts: number }>(
    META,
  );
  if (occupancy && occupancy.workspace !== body.workspace) fail();
  const resourceCleanup =
    occupancy && occupancy.receipts >= 65536 - 16
      ? await pruneResourceCostReceipts(storage, now)
      : null;
  const ack: CostIngestAck = {
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    unavailable: false,
  };
  await storage.transaction(async (tx) => {
    const meta = (await tx.get<{
      workspace: string;
      firstAt: string;
      lastAt: string;
      receipts: number;
      receiptBytes: number;
    }>(META)) ?? {
      workspace: body.workspace as string,
      firstAt: new Date(now).toISOString(),
      lastAt: new Date(now).toISOString(),
      receipts: 0,
      receiptBytes: 0,
    };
    if (meta.workspace !== body.workspace) fail();
    for (let index = 0; index < events.length; index++) {
      const event = events[index],
        id = resource
          ? (event as WorkspaceResourceEvent).eventId
          : (event as WorkspaceCostEvent).attemptId;
      const key = `${ATTEMPT}${body.producer}:${id}`;
      const previous = await tx.get<Receipt | { digest: string }>(key);
      const dayName =
        previous && "day" in previous ? previous.day : event.at.slice(0, 10);
      const day: CostDay = (await tx.get<CostDay>(DAY_KEY + dayName)) ?? {
        day: dayName,
        updatedAt: new Date(now).toISOString(),
        recordingGaps: 0,
        resources: [],
        resourceTotals: [],
      };
      if (
        !previous &&
        (meta.receipts >= 65536 || meta.receiptBytes >= 33_554_432)
      ) {
        day.recordingGaps++;
        ack.rejected++;
        await tx.put(DAY_KEY + dayName, day);
        continue;
      }
      let next: Receipt | { digest: string };
      if (resource) {
        if (previous) {
          if ("digest" in previous && previous.digest === digests[index])
            ack.duplicates++;
          else {
            day.recordingGaps++;
            ack.rejected++;
            await tx.put(DAY_KEY + dayName, day);
          }
          continue;
        }
        const {
          schemaVersion: _,
          eventId: __,
          at: ___,
          ...total
        } = event as WorkspaceResourceEvent;
        const resourceKey = stableCostJson(
          Object.fromEntries(
            Object.entries(total).filter(([key]) => key !== "quantity"),
          ),
        );
        const existing = day.resourceTotals.find(
          (row) =>
            stableCostJson(
              Object.fromEntries(
                Object.entries(row).filter(
                  ([key]) => !["quantity", "observedAt"].includes(key),
                ),
              ),
            ) === resourceKey,
        );
        if (!existing && day.resourceTotals.length >= 32) {
          day.recordingGaps++;
          ack.rejected++;
          await tx.put(DAY_KEY + dayName, day);
          continue;
        }
        if (existing) {
          if (total.metric !== "storage-retained-bytes")
            existing.quantity = String(
              BigInt(existing.quantity) + BigInt(total.quantity),
            );
          else if (
            !existing.observedAt ||
            Date.parse(event.at) >= Date.parse(existing.observedAt)
          ) {
            existing.quantity = total.quantity;
            existing.observedAt = event.at;
          }
        } else
          day.resourceTotals.push({
            ...total,
            ...(total.metric === "storage-retained-bytes"
              ? { observedAt: event.at }
              : {}),
          });
        next = { digest: digests[index] };
      } else {
        const ai = event as WorkspaceCostEvent;
        const old = previous && "phases" in previous ? previous : undefined;
        if (
          old &&
          (old.scope !== scope ||
            old.provider !== ai.provider ||
            old.purpose !== ai.purpose)
        ) {
          day.recordingGaps++;
          ack.rejected++;
          await tx.put(DAY_KEY + dayName, day);
          continue;
        }
        if (old?.phases[ai.phase]) {
          if (old.phases[ai.phase] === digests[index]) ack.duplicates++;
          else {
            day.recordingGaps++;
            ack.rejected++;
            await tx.put(DAY_KEY + dayName, day);
          }
          continue;
        }
        if (
          !old &&
          body.producer === "telegram-polish" &&
          ai.phase !== "started"
        ) {
          day.recordingGaps++;
          ack.rejected++;
          await tx.put(DAY_KEY + dayName, day);
          continue;
        }
        if (old) addReceipt(day, old, -1);
        const nextReceipt: Receipt = old ?? {
          producer: body.producer as CostProducer,
          scope,
          day: dayName,
          startedAt: event.at,
          provider: ai.provider,
          model: ai.requestedModel ?? ai.model,
          purpose: ai.purpose,
          phases: {},
        };
        if (!old && ai.phase !== "started") day.recordingGaps++;
        nextReceipt.phases[ai.phase] = digests[index];
        if (ai.phase === "provider-finished") {
          nextReceipt.terminal = ai;
          nextReceipt.model = ai.model;
        }
        if (ai.phase === "consumer-finished")
          nextReceipt.consumer = ai.consumerOutcome;
        addReceipt(day, nextReceipt, 1);
        next = nextReceipt;
      }
      const bytes = JSON.stringify(next).length,
        oldBytes = previous ? JSON.stringify(previous).length : 0;
      if (meta.receiptBytes + bytes - oldBytes > 33_554_432)
        throw new HttpError(503, "Cost recording capacity reached.");
      meta.receiptBytes += bytes - oldBytes;
      if (!previous) {
        meta.receipts++;
        await tx.put(
          (resource ? RESOURCE_EXPIRY : EXPIRY) +
            String(
              Date.parse(event.at) + (resource ? RESOURCE_REPLAY_MS : 62 * DAY),
            ).padStart(16, "0") +
            ":" +
            key,
          key,
        );
      }
      day.updatedAt = new Date(now).toISOString();
      if (JSON.stringify(day).length > 32768)
        throw new HttpError(503, "Cost recording capacity reached.");
      await tx.put(key, next);
      await tx.put(DAY_KEY + dayName, day);
      ack.accepted++;
    }
    meta.lastAt = new Date(now).toISOString();
    await tx.put(META, meta);
  });
  const nextAlarm = Math.min(
    now + DAY,
    ...(resource
      ? events.map((event) => Date.parse(event.at) + RESOURCE_REPLAY_MS)
      : []),
    resourceCleanup?.backlog ? now + 1000 : Infinity,
    resourceCleanup?.nextResourceAt ?? Infinity,
  );
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > nextAlarm) await storage.setAlarm(nextAlarm);
  return json(ack);
}

/** Only request-meter replay hashes expire here. AI receipts and daily totals stay intact. */
async function pruneResourceCostReceipts(
  storage: DurableObjectStorage,
  now: number,
) {
  const cursor = await storage.get<string>(RESOURCE_CURSOR);
  if (cursor && (!cursor.startsWith(EXPIRY) || cursor.length > 512))
    throw new HttpError(503, "Invalid resource replay cursor.");
  const [expired, legacy] = await Promise.all([
    storage.list<string>({
      prefix: RESOURCE_EXPIRY,
      end: RESOURCE_EXPIRY + String(now).padStart(16, "0"),
      limit: 128,
    }),
    storage.list<string>({
      prefix: EXPIRY,
      ...(cursor ? { startAfter: cursor } : {}),
      end:
        EXPIRY + String(now + 62 * DAY - RESOURCE_REPLAY_MS).padStart(16, "0"),
      limit: 128,
    }),
  ]);
  if (expired.size || legacy.size)
    await storage.transaction(async (tx) => {
      const meta = await tx.get<{ receipts: number; receiptBytes: number }>(
        META,
      );
      let changed = false;
      for (const [expiry, key] of [...expired, ...legacy]) {
        if (
          typeof key !== "string" ||
          !key.startsWith(ATTEMPT + "resource:") ||
          !UUID.test(key.slice((ATTEMPT + "resource:").length)) ||
          !expiry.endsWith(":" + key)
        )
          continue;
        const row = await tx.get<{ digest?: unknown }>(key);
        if (
          row &&
          (Object.keys(row).join() !== "digest" ||
            typeof row.digest !== "string" ||
            !HASH.test(row.digest))
        )
          continue;
        if (row) {
          const bytes = JSON.stringify(row).length;
          if (
            !meta ||
            !Number.isSafeInteger(meta.receipts) ||
            meta.receipts < 1 ||
            !Number.isSafeInteger(meta.receiptBytes) ||
            meta.receiptBytes < bytes
          )
            throw new HttpError(503, "Invalid resource replay inventory.");
          meta.receipts--;
          meta.receiptBytes -= bytes;
          changed = true;
        }
        await tx.delete([expiry, key]);
      }
      if (changed && meta) await tx.put(META, meta);
      if (legacy.size) {
        const last = [...legacy.keys()].at(-1)!;
        const current = await tx.get<string>(RESOURCE_CURSOR);
        if (!current || last > current) await tx.put(RESOURCE_CURSOR, last);
      }
    });
  const first = await storage.list({ prefix: RESOURCE_EXPIRY, limit: 1 });
  const expiry = first.size
    ? Number([...first.keys()][0].slice(RESOURCE_EXPIRY.length).split(":")[0])
    : null;
  return {
    backlog: expired.size === 128 || legacy.size === 128,
    nextResourceAt:
      expiry !== null && Number.isSafeInteger(expiry)
        ? Math.max(now + 1000, expiry)
        : null,
  };
}
export async function pruneWorkspaceCosts(
  storage: DurableObjectStorage,
  now: number,
) {
  const resources = await pruneResourceCostReceipts(storage, now);
  const expired = await storage.list<string>({
    prefix: EXPIRY,
    end: EXPIRY + String(now).padStart(16, "0"),
    limit: 128,
  });
  if (expired.size)
    await storage.transaction(async (tx) => {
      const meta = await tx.get<{ receipts: number; receiptBytes: number }>(
        META,
      );
      for (const [expiry, key] of expired) {
        const row = await tx.get(key);
        if (row && meta) {
          meta.receipts--;
          meta.receiptBytes -= JSON.stringify(row).length;
        }
        await tx.delete([expiry, key]);
      }
      if (meta) await tx.put(META, meta);
    });
  const old = await storage.list({
    prefix: DAY_KEY,
    end: DAY_KEY + new Date(now - 400 * DAY).toISOString().slice(0, 10),
    limit: 64,
  });
  if (old.size) await storage.delete([...old.keys()]);
  return {
    active: (await storage.list({ prefix: DAY_KEY, limit: 1 })).size > 0,
    backlog: resources.backlog || expired.size === 128 || old.size === 64,
    nextResourceAt: resources.nextResourceAt,
  };
}
