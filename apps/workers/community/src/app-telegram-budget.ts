import { MANAGED_AGENT_LIMITS } from "@templ/chat/managed-agent";
import { standardAiUsageUsdNanos } from "@templ/chat/standard-usage";
import type {
  AppDraftAttempt,
  AppDraftBudgetInput,
  AppDraftBudgetResult,
  AppDraftConfiguration,
} from "@templ/chat/app-telegram-drafts";
import type {
  CostIngestAck,
  WorkspaceCostEvent,
} from "@templ/chat/workspace-costs";
import { prepaidAiMaximum, PREPAID_AI_LIMITS } from "./product-prepaid-ai";
import { recordWorkspaceCost } from "./workspace-cost-recording";
import { featureOn, workspaceFeatureEnvFor } from "./workspace-flags";
import { sha256Hex, type Env } from "./common";

export const APP_TELEGRAM_WORKSPACE = "";
export const APP_DRAFT_TRIAL_COST_WORKSPACE =
  "";
export const APP_DRAFT_OUTPUT_TOKENS = 2048;
// The same existing company meter used by the native runner. No new namespace or budget.
const COMPANY_METER = "managed-spend:v1";
const MODEL = "gpt-6.1-sol";
const DAY = 86_400_000;
type BudgetEnv = Env & {
  SUPPORT_KNOWLEDGE?: DurableObjectNamespace;
  COST_METRICS?: DurableObjectNamespace;
  MANAGED_AGENT_GATEWAY_ID?: string;
  MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
};
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMON = [
  "workspace",
  "attemptId",
  "startedAt",
  "requestBytes",
  "requestSha256",
];
const TERMINAL = ["finishedAt", "model", "transportOutcome", "consumerOutcome"];
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const positive = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) > 0;
const acknowledged = (value: CostIngestAck) =>
  !value.unavailable &&
  value.rejected === 0 &&
  value.accepted + value.duplicates === 1;
const refused = (): AppDraftBudgetResult => ({
  admitted: false,
  recorded: false,
});

export async function appDraftConfiguration(
  env: BudgetEnv,
  workspace: string,
  internalTrial?: true,
): Promise<AppDraftConfiguration | null> {
  if (
    workspace !== APP_TELEGRAM_WORKSPACE ||
    (internalTrial !== undefined && internalTrial !== true) ||
    !env.SUPPORT_KNOWLEDGE ||
    !env.COST_METRICS ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")
  )
    return null;
  const cap = Number(env.MANAGED_AGENT_SPEND_CAP_USD_CENTS);
  if (
    !Number.isSafeInteger(cap) ||
    cap < MANAGED_AGENT_LIMITS.reserveCentsPerCall ||
    cap > 50_000
  )
    return null;
  try {
    const scoped = await workspaceFeatureEnvFor(env, workspace);
    if (
      !featureOn(scoped, undefined, "aiDrafts") ||
      (internalTrial !== true &&
        !featureOn(scoped, undefined, "appTelegramDrafts"))
    )
      return null;
  } catch {
    return null;
  }
  return {
    gatewayId: env.MANAGED_AGENT_GATEWAY_ID!,
    model: MODEL,
    maxOutputTokens: APP_DRAFT_OUTPUT_TOKENS,
  };
}

function checkedInput(raw: unknown, now: number): AppDraftBudgetInput | null {
  if (!object(raw) || !["start", "finish"].includes(String(raw.op)))
    return null;
  const finish = raw.op === "finish";
  const required = ["op", ...COMMON, ...(finish ? TERMINAL : [])];
  if (
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some(
      (key) =>
        ![
          ...required,
          "inputTokens",
          "internalTrial",
          ...(finish ? ["usage"] : []),
        ].includes(key),
    ) ||
    raw.workspace !== APP_TELEGRAM_WORKSPACE ||
    !UUID.test(String(raw.attemptId)) ||
    !iso(raw.startedAt) ||
    Date.parse(raw.startedAt) > now + 60_000 ||
    Date.parse(raw.startedAt) < now - (finish ? 62 : 1) * DAY ||
    (raw.inputTokens !== undefined &&
      (!positive(raw.inputTokens) ||
        Number(raw.inputTokens) > PREPAID_AI_LIMITS.modelContextTokens)) ||
    !positive(raw.requestBytes) ||
    Number(raw.requestBytes) > PREPAID_AI_LIMITS.requestBytes ||
    !SHA.test(String(raw.requestSha256)) ||
    (Object.hasOwn(raw, "internalTrial") && raw.internalTrial !== true)
  )
    return null;
  if (
    finish &&
    (!iso(raw.finishedAt) ||
      Date.parse(raw.finishedAt) < Date.parse(raw.startedAt) ||
      Date.parse(raw.finishedAt) > now + 60_000 ||
      Date.parse(raw.finishedAt) < now - 62 * DAY ||
      ![MODEL, "unknown"].includes(String(raw.model)) ||
      !["completed", "failed", "cancelled", "timeout"].includes(
        String(raw.transportOutcome),
      ) ||
      !["draft", "failed", "discarded"].includes(String(raw.consumerOutcome)))
  )
    return null;
  if (raw.usage !== undefined) {
    if (
      !object(raw.usage) ||
      [
        "inputTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
        "outputTokens",
      ].some((key) => !Object.hasOwn(raw.usage as object, key)) ||
      Object.keys(raw.usage).some(
        (key) =>
          ![
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
            "reasoningTokens",
          ].includes(key),
      ) ||
      Object.values(raw.usage).some(
        (value) =>
          value !== null &&
          (!Number.isSafeInteger(value) ||
            Number(value) < 0 ||
            Number(value) > 1e12),
      )
    )
      return null;
  }
  if (
    finish &&
    raw.transportOutcome === "cancelled" &&
    (raw.model !== "unknown" ||
      raw.usage !== undefined ||
      raw.consumerOutcome !== "discarded")
  )
    return null;
  return raw as AppDraftBudgetInput;
}

function attemptMetadata(input: AppDraftAttempt) {
  return {
    workspace: input.workspace,
    attemptId: input.attemptId,
    startedAt: input.startedAt,
    inputTokens: input.inputTokens,
    requestBytes: input.requestBytes,
    requestSha256: input.requestSha256,
    internalTrial: input.internalTrial === true,
    model: MODEL,
    maxOutputTokens: APP_DRAFT_OUTPUT_TOKENS,
  };
}

/** Only the bridge service binding calls this. Records provider costs, never a retail charge or cash debit. */
export async function appDraftBudget(
  env: BudgetEnv,
  raw: unknown,
): Promise<AppDraftBudgetResult> {
  const input = checkedInput(raw, Date.now());
  if (!input || !env.SUPPORT_KNOWLEDGE || !env.COST_METRICS) return refused();
  const maximum = BigInt(
    prepaidAiMaximum(APP_DRAFT_OUTPUT_TOKENS, 1, input.inputTokens),
  );
  // The gateway can omit exact counts. Reserve its full exposure in that case;
  // this operating hold never substitutes for actual customer cost metadata.
  const hold = Math.max(
    MANAGED_AGENT_LIMITS.reserveCentsPerCall,
    Number((maximum + 9_999_999n) / 10_000_000n),
  );
  if (!Number.isSafeInteger(hold) || hold > 50_000) return refused();
  const month = input.startedAt.slice(0, 7);
  const scope = await sha256Hex(JSON.stringify(attemptMetadata(input)));
  const meter = env.SUPPORT_KNOWLEDGE.get(
    env.SUPPORT_KNOWLEDGE.idFromName(COMPANY_METER),
  );
  const spend = async (op: "reserve" | "settle" | "release", cents: number) => {
    const response = await meter.fetch(
      new Request("https://knowledge.internal/managed/spend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({
          op,
          month,
          id: input.attemptId,
          cents,
          scope,
          ...(op === "reserve"
            ? { cap: Number(env.MANAGED_AGENT_SPEND_CAP_USD_CENTS) }
            : {}),
        }),
      }),
    );
    if (!response.ok) return null;
    const result = await response.json<{ ok?: unknown }>();
    return typeof result.ok === "boolean" ? result.ok : null;
  };
  const costWorkspace = input.internalTrial
    ? APP_DRAFT_TRIAL_COST_WORKSPACE
    : APP_TELEGRAM_WORKSPACE;
  const base = {
    schemaVersion: 1 as const,
    attemptId: input.attemptId,
    provider: "cloudflare" as const,
    requestedModel: MODEL,
    purpose: input.internalTrial ? ("other" as const) : ("draft" as const),
  };
  const record = async (event: Omit<WorkspaceCostEvent, keyof typeof base>) =>
    acknowledged(
      await recordWorkspaceCost(
        env,
        costWorkspace,
        "telegram-polish",
        { ...base, ...event },
        scope,
      ),
    );
  try {
    if (input.op === "start") {
      if (
        !(await appDraftConfiguration(
          env,
          input.workspace,
          input.internalTrial,
        ))
      )
        return refused();
      const admitted = await spend("reserve", hold);
      if (admitted === null) return refused();
      if (
        !(await record({
          at: input.startedAt,
          phase: "started",
          model: "unknown",
        }))
      ) {
        if (admitted) await spend("release", 0);
        return refused();
      }
      if (admitted) return { admitted: true, recorded: true, month };
      // A cap refusal is terminal for this scoped ID. These events say no provider call occurred.
      const provider = await record({
        at: input.startedAt,
        phase: "provider-finished",
        model: "unknown",
        transportOutcome: "cancelled",
      });
      const consumer =
        provider &&
        (await record({
          at: input.startedAt,
          phase: "consumer-finished",
          model: "unknown",
          consumerOutcome: "cancelled",
        }));
      return { admitted: false, recorded: Boolean(consumer), month };
    }
    // The bridge can prove cancellation only before dispatch. Close even an unacknowledged reserve;
    // this scoped terminal receipt prevents a delayed or repeated start from dispatching later.
    if (input.transportOutcome === "cancelled") {
      if ((await spend("release", 0)) !== true) return refused();
      if (
        !(await record({
          at: input.startedAt,
          phase: "started",
          model: "unknown",
        }))
      )
        return refused();
      const provider = await record({
        at: input.startedAt,
        phase: "provider-finished",
        model: "unknown",
        transportOutcome: "cancelled",
      });
      const consumer =
        provider &&
        (await record({
          at: input.startedAt,
          phase: "consumer-finished",
          model: "unknown",
          consumerOutcome: "cancelled",
        }));
      return { admitted: false, recorded: Boolean(consumer), month };
    }
    // Preserve known provider observations even if the result was unusable. Unknown usage never becomes a guessed customer charge.
    const usage = input.usage;
    const actual =
      input.model === MODEL && usage
        ? standardAiUsageUsdNanos(MODEL, usage, 1)
        : null;
    const bounded =
      actual !== null &&
      usage &&
      Number(usage.inputTokens) > 0 &&
      Number(usage.outputTokens) > 0 &&
      Number(usage.inputTokens) <=
        (input.inputTokens ?? PREPAID_AI_LIMITS.modelContextTokens) &&
      Number(usage.outputTokens) <= APP_DRAFT_OUTPUT_TOKENS &&
      BigInt(actual) <= maximum;
    const cents = bounded
      ? Number((BigInt(actual!) + 9_999_999n) / 10_000_000n)
      : hold;
    if ((await spend("settle", cents)) !== true) return refused();
    const provider = await record({
      at: input.finishedAt,
      phase: "provider-finished",
      model: input.model,
      transportOutcome: input.transportOutcome,
      ...(usage
        ? {
            usage: {
              ...usage,
              reasoningTokens: usage.reasoningTokens ?? null,
              billableUnits: null,
            },
          }
        : {}),
    });
    if (!provider) return refused();
    const consumer = await record({
      at: input.finishedAt,
      phase: "consumer-finished",
      model: input.model,
      consumerOutcome:
        bounded && input.transportOutcome === "completed"
          ? input.consumerOutcome
          : "failed",
    });
    return { admitted: false, recorded: consumer, month };
  } catch {
    return refused();
  }
}
