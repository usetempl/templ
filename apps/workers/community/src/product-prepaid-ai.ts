import {
  PRODUCT_STANDARD_AI_RATES,
  PRODUCT_STANDARD_PRICES,
} from "@templ/chat/plans";
import {
  standardAiUsageUsdNanos,
  captureStandardAiRate,
  checkedStandardAiRate,
  type StandardAiRate,
  type StandardAiTokenUsage,
} from "@templ/chat/standard-usage";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError, sha256Hex } from "./common";
import {
  readPrepaidAccount,
  readPrepaidPeriod,
  reserveAi,
  settleAi,
} from "./product-prepaid";
import {
  standardPlanView,
  syncPrepaidStandardUsage,
} from "./product-standard-plan";
import {
  PRODUCT_STATE_KEY,
  readProductState,
  productMode,
} from "./product-entitlements";
import { activeProductOrderForm } from "./product-order-forms";
import { activeUsageAgreement } from "./product-usage-billing";
import type { TemplStaffEnv } from "./templ-staff";

type Storage = Pick<DurableObjectTransaction, "get" | "put">;
export const PREPAID_AI_LIMITS = {
  requestBytes: 96 * 1024,
  maxOutputTokens: 8_000,
  modelContextTokens: 1_050_000,
  concurrent: 2,
  attemptsPerMinute: 30,
  absorbedPerPeriod: 3,
  orphanAfterMs: 15 * 60_000,
  fallbackCustomerHoldUsdNanos: "1000000000",
} as const;
const ATTEMPT = "product-prepaid-ai-envelope-v1:";
const CIRCUIT = "product-prepaid-ai-circuit-v1:";
const PENDING = "product-prepaid-ai-pending-v1";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: Record<string, unknown>,
  keys: string[],
  optional: string[] = [],
) =>
  keys.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => keys.includes(key) || optional.includes(key),
  );
const invalid = () => new HttpError(400, "AI billing request is invalid.");
const unavailable = () =>
  new HttpError(503, "AI billing could not be verified.");
export type PrepaidAiReserve = {
  attemptId: string;
  requestBytes: number;
  maxOutputTokens: number;
  model: "gpt-6.1-sol";
  requestSha256?: string;
  /** Exact provider count of this request, including its schema and framing. Absent means full-context hold. */
  inputTokens?: number;
};
export type PrepaidAiSettlement = {
  attemptId: string;
  model: string;
  usage: StandardAiTokenUsage | null;
  outcome: "completed" | "failed" | "cancelled";
};
type Envelope = PrepaidAiReserve &
  StandardAiRate & {
    customerHoldPolicy?: "bounded_risk_v1";
    periodId: string;
    scopeSha256: string;
    at: number;
    maximumUsdNanos: string;
    aiRateCardVersion: string;
    terminal: {
      payloadSha256: string;
      at: number;
      chargedUsdNanos: string | null;
      reason: "provider" | "orphan" | "customer-hold";
    } | null;
  };
type Circuit = {
  pending: string[];
  minute: number;
  attempts: number;
  absorbed: number;
};
function checkedEnvelope(value: unknown): Envelope {
  if (
    !object(value) ||
    !exact(
      value,
      [
        "attemptId",
        "requestBytes",
        "maxOutputTokens",
        "model",
        "periodId",
        "scopeSha256",
        "at",
        "maximumUsdNanos",
        ...(Object.hasOwn(value, "aiRateBasisPoints")
          ? ["aiRateBasisPoints"]
          : ["aiRateMultiplier"]),
        "aiRateCardVersion",
        "terminal",
      ],
      ["requestSha256", "inputTokens", "customerHoldPolicy"],
    ) ||
    (value.customerHoldPolicy !== undefined &&
      (value.customerHoldPolicy !== "bounded_risk_v1" ||
        value.inputTokens !== undefined)) ||
    !UUID.test(String(value.attemptId)) ||
    !/^\d{16}$/.test(String(value.periodId)) ||
    !SHA.test(String(value.scopeSha256)) ||
    !integer(value.at) ||
    typeof value.maximumUsdNanos !== "string" ||
    !/^[1-9][0-9]{0,29}$/.test(value.maximumUsdNanos) ||
    value.model !== PRODUCT_STANDARD_AI_RATES.model ||
    !checkedStandardAiRate(value) ||
    typeof value.aiRateCardVersion !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,120}$/.test(value.aiRateCardVersion) ||
    !integer(value.requestBytes) ||
    value.requestBytes > PREPAID_AI_LIMITS.requestBytes ||
    !integer(value.maxOutputTokens) ||
    value.maxOutputTokens < 16 ||
    value.maxOutputTokens > PREPAID_AI_LIMITS.maxOutputTokens ||
    (value.requestSha256 !== undefined &&
      !SHA.test(String(value.requestSha256))) ||
    (value.inputTokens !== undefined &&
      (!integer(value.inputTokens) ||
        value.inputTokens < 1 ||
        value.inputTokens > PREPAID_AI_LIMITS.modelContextTokens ||
        !SHA.test(String(value.requestSha256)))) ||
    !(
      value.terminal === null ||
      (object(value.terminal) &&
        exact(value.terminal, [
          "payloadSha256",
          "at",
          "chargedUsdNanos",
          "reason",
        ]) &&
        ["provider", "orphan", "customer-hold"].includes(
          String(value.terminal.reason),
        ) &&
        SHA.test(String(value.terminal.payloadSha256)) &&
        (value.terminal.reason !== "customer-hold" ||
          (value.customerHoldPolicy === "bounded_risk_v1" &&
            value.terminal.chargedUsdNanos === null)) &&
        integer(value.terminal.at) &&
        (value.terminal.chargedUsdNanos === null ||
          (typeof value.terminal.chargedUsdNanos === "string" &&
            /^(?:0|[1-9][0-9]{0,29})$/.test(value.terminal.chargedUsdNanos))))
    )
  )
    throw unavailable();
  return value as Envelope;
}
async function circuit(storage: Storage, period: string): Promise<Circuit> {
  const saved = await storage.get<Circuit>(CIRCUIT + period);
  if (saved === undefined)
    return { pending: [], minute: 0, attempts: 0, absorbed: 0 };
  if (
    !saved ||
    !Array.isArray(saved.pending) ||
    saved.pending.length > PREPAID_AI_LIMITS.concurrent ||
    saved.pending.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(saved.pending).size !== saved.pending.length ||
    !integer(saved.minute) ||
    !integer(saved.attempts) ||
    !integer(saved.absorbed)
  )
    throw unavailable();
  return saved;
}
async function pendingAttempts(storage: Storage): Promise<string[]> {
  const saved = await storage.get<string[]>(PENDING);
  if (saved === undefined) return [];
  if (
    !Array.isArray(saved) ||
    saved.length > PREPAID_AI_LIMITS.concurrent ||
    saved.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(saved).size !== saved.length
  )
    throw unavailable();
  return saved;
}
/** A timed-out attempt is retained as an absorbed loss. Late usage never becomes customer debt. */
async function resolveOrphans(storage: Storage, now: number) {
  const pending = await pendingAttempts(storage);
  const retained: string[] = [];
  for (const id of pending) {
    const row = checkedEnvelope(await storage.get(ATTEMPT + id));
    if (row.attemptId !== id || row.terminal) throw unavailable();
    if (now < row.at + PREPAID_AI_LIMITS.orphanAfterMs) {
      retained.push(id);
      continue;
    }
    await settleAi(storage, {
      attemptId: id,
      actualRetailUsdNanos: null,
      at: now,
    });
    await syncPrepaidStandardUsage(storage, row.periodId, now);
    row.terminal = {
      payloadSha256: await sha256Hex("orphan-absorbed"),
      at: now,
      chargedUsdNanos: null,
      reason: "orphan",
    };
    const state = await circuit(storage, row.periodId);
    state.pending = state.pending.filter((attempt) => attempt !== id);
    state.absorbed++;
    await storage.put(ATTEMPT + id, row);
    await storage.put(CIRCUIT + row.periodId, state);
  }
  await storage.put(PENDING, retained);
  return retained;
}
/** Fixed hosted capabilities use these existing service principals. No payload chooses a workspace. */
export function hostedPrepaidPrincipal(
  workspace: string,
): ChatPrincipalId | null {
  const principals: Record<string, string> = {};
  return (principals[workspace] as ChatPrincipalId | undefined) ?? null;
}
/** An operating hold, never a customer charge. Missing provider counts retain the full-context bound. */
export function prepaidAiMaximum(
  maxOutputTokens: number,
  rate: number | StandardAiRate = PRODUCT_STANDARD_PRICES,
  inputTokens: number = PREPAID_AI_LIMITS.modelContextTokens,
): string {
  if (
    !integer(inputTokens) ||
    inputTokens < 1 ||
    inputTokens > PREPAID_AI_LIMITS.modelContextTokens
  )
    throw unavailable();
  const maximum = standardAiUsageUsdNanos(
    PRODUCT_STANDARD_AI_RATES.model,
    {
      inputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: inputTokens,
      outputTokens: maxOutputTokens,
    },
    rate,
  );
  if (maximum === null) throw unavailable();
  return maximum;
}
export async function prepaidAiMode(
  storage: Storage,
  now: number,
  env: TemplStaffEnv = {},
) {
  const account = await readPrepaidAccount(storage);
  if (account.mode !== "prepaid")
    return { mode: "custom" as const, period: null };
  const view = await standardPlanView(storage, now);
  const period = view.period
    ? await readPrepaidPeriod(storage, view.period.id)
    : null;
  if (period) return { mode: "prepaid" as const, period };
  if (
    view.status === "paid" &&
    view.period &&
    ["manual-payment", "founder-approved"].includes(view.period.source)
  )
    return { mode: "custom" as const, period: null };
  if (await storage.get(PRODUCT_STATE_KEY)) {
    const retained = productMode(await readProductState(storage, now, env));
    if (retained === "funded" || retained === "exempt")
      return { mode: "custom" as const, period: null };
  }
  if (
    (await activeProductOrderForm(storage, now)) ||
    (await activeUsageAgreement(storage, now, env))
  )
    return { mode: "custom" as const, period: null };
  return { mode: "prepaid" as const, period: null };
}
/** Caller authenticates the current workspace agent. Run in the same Room transaction as the hold. */
export async function reservePrepaidAi(
  storage: Storage,
  input: unknown,
  principal: ChatPrincipalId,
  now: number,
  env: TemplStaffEnv = {},
) {
  if (
    !object(input) ||
    !exact(
      input,
      ["attemptId", "requestBytes", "maxOutputTokens", "model"],
      ["requestSha256", "inputTokens"],
    ) ||
    !UUID.test(String(input.attemptId)) ||
    input.model !== PRODUCT_STANDARD_AI_RATES.model ||
    !integer(input.requestBytes) ||
    input.requestBytes < 1 ||
    input.requestBytes > PREPAID_AI_LIMITS.requestBytes ||
    !integer(input.maxOutputTokens) ||
    input.maxOutputTokens < 16 ||
    input.maxOutputTokens > PREPAID_AI_LIMITS.maxOutputTokens ||
    (input.requestSha256 !== undefined &&
      !SHA.test(String(input.requestSha256))) ||
    (input.inputTokens !== undefined &&
      (!integer(input.inputTokens) ||
        input.inputTokens < 1 ||
        input.inputTokens > PREPAID_AI_LIMITS.modelContextTokens ||
        !SHA.test(String(input.requestSha256)))) ||
    !integer(now)
  )
    throw invalid();
  const pending = await resolveOrphans(storage, now);
  const { mode, period } = await prepaidAiMode(storage, now, env);
  if (mode === "custom")
    return { mode, admitted: true, attemptId: input.attemptId };
  if (!period || now < period.startsAt || now >= period.endsAt)
    throw new HttpError(
      402,
      "Start a paid month before using Templ AI.",
      undefined,
      "prepaid-period-required",
    );
  if (
    period.aiRateCardVersion !== PRODUCT_STANDARD_AI_RATES.version ||
    !(
      period.aiRateMultiplier === 2 ||
      period.aiRateBasisPoints === PRODUCT_STANDARD_PRICES.aiRateBasisPoints
    )
  )
    throw unavailable();
  const key = ATTEMPT + input.attemptId;
  if (await storage.get(key))
    throw new HttpError(
      409,
      "This AI attempt already has a reservation.",
      undefined,
      "prepaid-attempt-used",
    );
  const state = await circuit(storage, period.id);
  if (
    pending.length >= PREPAID_AI_LIMITS.concurrent ||
    state.absorbed + state.pending.length >= PREPAID_AI_LIMITS.absorbedPerPeriod
  )
    throw new HttpError(
      503,
      "AI usage needs review before another request.",
      undefined,
      "prepaid-ai-held",
    );
  const minute = Math.floor(now / 60_000);
  if (state.minute !== minute) {
    state.minute = minute;
    state.attempts = 0;
  }
  if (state.attempts >= PREPAID_AI_LIMITS.attemptsPerMinute)
    throw new HttpError(
      429,
      "Wait before another AI request.",
      60,
      "prepaid-ai-paced",
    );
  let maximumUsdNanos = prepaidAiMaximum(
    input.maxOutputTokens,
    period,
    input.inputTokens as number | undefined,
  );
  let customerHoldPolicy: "bounded_risk_v1" | undefined;
  if (input.inputTokens === undefined) {
    const view = await standardPlanView(storage, now);
    if (
      view.status === "paid" &&
      view.period?.id === period.id &&
      view.period.source === "verified-payment" &&
      view.period.workspaceMonthlyCents ===
        PRODUCT_STANDARD_PRICES.workspaceMonthlyUsdCents
    ) {
      const account = await readPrepaidAccount(storage);
      const available =
        BigInt(period.includedAiAvailableUsdNanos) +
        BigInt(account.cashAvailableUsdNanos);
      const cap = BigInt(PREPAID_AI_LIMITS.fallbackCustomerHoldUsdNanos);
      if (available <= 0n)
        throw new HttpError(
          402,
          "Add prepaid credit to cover this AI request.",
          undefined,
          "prepaid-credit-required",
        );
      maximumUsdNanos = (available < cap ? available : cap).toString();
      customerHoldPolicy = "bounded_risk_v1";
    }
  }
  await reserveAi(storage, {
    attemptId: input.attemptId as string,
    periodId: period.id,
    maxRetailUsdNanos: maximumUsdNanos,
    at: now,
  });
  const row: Envelope = {
    ...(input as PrepaidAiReserve),
    ...(customerHoldPolicy ? { customerHoldPolicy } : {}),
    periodId: period.id,
    scopeSha256: await sha256Hex(principal),
    at: now,
    maximumUsdNanos,
    ...captureStandardAiRate(period),
    aiRateCardVersion: period.aiRateCardVersion,
    terminal: null,
  };
  state.pending.push(row.attemptId);
  state.attempts++;
  await storage.put(PENDING, [...pending, row.attemptId]);
  await storage.put(key, row);
  await storage.put(CIRCUIT + period.id, state);
  return {
    mode,
    admitted: true,
    attemptId: row.attemptId,
    reservedUsdNanos: maximumUsdNanos,
  };
}
/** Exact terminal replay is harmless. Unknown usage is absorbed, never guessed or charged later. */
export async function settlePrepaidAi(
  storage: Storage,
  input: unknown,
  principal: ChatPrincipalId,
  now: number,
  env: TemplStaffEnv = {},
) {
  if (
    !object(input) ||
    !exact(input, ["attemptId", "model", "usage", "outcome"]) ||
    !UUID.test(String(input.attemptId)) ||
    typeof input.model !== "string" ||
    input.model.length > 96 ||
    !["completed", "failed", "cancelled"].includes(String(input.outcome)) ||
    !(
      input.usage === null ||
      (object(input.usage) &&
        Object.keys(input.usage).every((key) =>
          [
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
            "reasoningTokens",
          ].includes(key),
        ))
    ) ||
    !integer(now)
  )
    throw invalid();
  const stored = await storage.get(ATTEMPT + input.attemptId);
  if (stored === undefined) {
    if ((await prepaidAiMode(storage, now, env)).mode === "custom")
      return { mode: "custom" as const, attemptId: input.attemptId };
    throw new HttpError(409, "Reserve this AI attempt before recording usage.");
  }
  const row = checkedEnvelope(stored);
  if (row.scopeSha256 !== (await sha256Hex(principal)) || now < row.at)
    throw new HttpError(403, "AI attempt belongs to another service.");
  const payloadSha256 = await sha256Hex(
    JSON.stringify({
      model: input.model,
      usage: input.usage,
      outcome: input.outcome,
    }),
  );
  if (row.terminal) {
    if (
      row.terminal.reason !== "orphan" &&
      row.terminal.payloadSha256 !== payloadSha256
    )
      throw new HttpError(
        409,
        "This AI attempt already records different usage.",
      );
    return {
      mode: "prepaid" as const,
      attemptId: row.attemptId,
      chargedUsdNanos: row.terminal.chargedUsdNanos,
      unavailable: row.terminal.chargedUsdNanos === null,
      ...(row.terminal.reason === "customer-hold"
        ? { absorbedOverHold: true }
        : {}),
    };
  }
  const usage = input.usage as StandardAiTokenUsage | null;
  let chargedUsdNanos =
    input.outcome === "completed" &&
    usage &&
    input.model === row.model &&
    row.aiRateCardVersion === PRODUCT_STANDARD_AI_RATES.version
      ? standardAiUsageUsdNanos(input.model, usage, row)
      : null;
  if (
    chargedUsdNanos !== null &&
    (usage!.inputTokens! >
      (row.inputTokens ?? PREPAID_AI_LIMITS.modelContextTokens) ||
      usage!.outputTokens! > row.maxOutputTokens)
  )
    chargedUsdNanos = null;
  const absorbedOverHold =
    chargedUsdNanos !== null &&
    BigInt(chargedUsdNanos) > BigInt(row.maximumUsdNanos) &&
    row.customerHoldPolicy === "bounded_risk_v1";
  if (
    chargedUsdNanos !== null &&
    BigInt(chargedUsdNanos) > BigInt(row.maximumUsdNanos)
  )
    chargedUsdNanos = null;
  await settleAi(storage, {
    attemptId: row.attemptId,
    actualRetailUsdNanos: chargedUsdNanos,
    at: now,
  });
  await syncPrepaidStandardUsage(storage, row.periodId, now);
  row.terminal = {
    payloadSha256,
    at: now,
    chargedUsdNanos,
    reason: absorbedOverHold ? "customer-hold" : "provider",
  };
  const pending = await pendingAttempts(storage);
  if (!pending.includes(row.attemptId)) throw unavailable();
  await storage.put(
    PENDING,
    pending.filter((id) => id !== row.attemptId),
  );
  const state = await circuit(storage, row.periodId);
  state.pending = state.pending.filter((id) => id !== row.attemptId);
  if (chargedUsdNanos === null) state.absorbed++;
  await storage.put(ATTEMPT + row.attemptId, row);
  await storage.put(CIRCUIT + row.periodId, state);
  return {
    mode: "prepaid" as const,
    attemptId: row.attemptId,
    chargedUsdNanos,
    unavailable: chargedUsdNanos === null,
    ...(absorbedOverHold ? { absorbedOverHold: true } : {}),
  };
}
