import { MANAGED_AGENT_LIMITS, spendMonth } from "@templ/chat/managed-agent";
import { standardAiUsageUsdNanos } from "@templ/chat/standard-usage";
import { prepaidAiMaximum, PREPAID_AI_LIMITS } from "../product-prepaid-ai";
import { gptUsage, PREPAID_GPT_MODEL } from "./gpt";
import { TEMPL_SPEND_OBJECT } from "./knowledge-hooks";

export type AiConnectionProbeResult = {
  connected: boolean;
  reason:
    | "connected"
    | "binding-unavailable"
    | "budget-unavailable"
    | "provider-unavailable"
    | "timeout"
    | "model-mismatch"
    | "tier-mismatch"
    | "invalid-response"
    | "usage-unavailable"
    | "settlement-pending";
  model: "gpt-6.1-sol" | "unknown";
  tier: "default" | "unreported" | "other";
  usageComplete: boolean;
};
type ProbeEnv = {
  AI?: Pick<Ai, "run">;
  SUPPORT_KNOWLEDGE?: DurableObjectNamespace;
  MANAGED_AGENT_GATEWAY_ID?: string;
  MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
};
export const PROVIDER_PROBE_TIMEOUT_MS = 20_000;
const OUTPUT_TOKENS = 512;
export function providerProbeHoldCents() {
  return Number(
    (BigInt(prepaidAiMaximum(MANAGED_AGENT_LIMITS.maxOutputTokens, 1)) +
      9_999_999n) /
      10_000_000n,
  );
}
class ProbeTimeout extends Error {}
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProbeTimeout());
        }, ms);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new ProbeTimeout();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One operator-requested synthetic inference. Only Templ's global provider budget changes. */
export async function probeAiConnection(
  env: ProbeEnv,
): Promise<AiConnectionProbeResult> {
  const result: AiConnectionProbeResult = {
    connected: false,
    reason: "binding-unavailable",
    model: "unknown",
    tier: "unreported",
    usageComplete: false,
  };
  if (
    !env.AI ||
    !env.SUPPORT_KNOWLEDGE ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")
  )
    return result;
  const cap = Number(env.MANAGED_AGENT_SPEND_CAP_USD_CENTS),
    hold = providerProbeHoldCents();
  result.reason = "budget-unavailable";
  if (!Number.isSafeInteger(cap) || cap < hold || cap > 50_000) return result;
  const meter = env.SUPPORT_KNOWLEDGE.get(
    env.SUPPORT_KNOWLEDGE.idFromName(TEMPL_SPEND_OBJECT),
  );
  const month = spendMonth(Date.now()),
    id = crypto.randomUUID();
  const spend = (op: "reserve" | "settle", cents: number) =>
    bounded(async (signal) => {
      const response = await meter.fetch(
        "https://knowledge.internal/managed/spend",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op,
            month,
            id,
            cents,
            ...(op === "reserve" ? { cap } : {}),
          }),
          signal,
        },
      );
      if (!response.ok) throw new Error("probe-budget");
      return (await response.json<{ ok?: boolean }>()).ok === true;
    }, 5_000);
  try {
    if (!(await spend("reserve", hold))) return result;
  } catch {
    return result;
  }

  let cents = hold;
  try {
    const raw = object(
      await bounded(
        (signal) =>
          env.AI!.run(
            "openai/gpt-6.1-sol" as Parameters<Ai["run"]>[0],
            {
              model: PREPAID_GPT_MODEL,
              instructions:
                "This is a connection check. Reply with exactly OK.",
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: "Check the connection." },
                  ],
                },
              ],
              max_output_tokens: OUTPUT_TOKENS,
              reasoning: { effort: "medium" },
              service_tier: "default",
              store: false,
              stream: false,
              truncation: "disabled",
              tools: [],
              text: { format: { type: "text" } },
            } as never,
            {
              signal,
              gateway: {
                id: env.MANAGED_AGENT_GATEWAY_ID!,
                collectLog: false,
                skipCache: true,
                requestTimeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
                retries: { maxAttempts: 1 },
              },
            },
          ) as Promise<unknown>,
        PROVIDER_PROBE_TIMEOUT_MS,
      ),
    );
    result.model =
      raw.model === PREPAID_GPT_MODEL ? PREPAID_GPT_MODEL : "unknown";
    result.tier =
      raw.service_tier === "default"
        ? "default"
        : raw.service_tier === undefined
          ? "unreported"
          : "other";
    const usage = gptUsage(raw.usage);
    const priced =
      raw.status === "completed" &&
      result.model === PREPAID_GPT_MODEL &&
      result.tier === "default"
        ? standardAiUsageUsdNanos(PREPAID_GPT_MODEL, usage, 1)
        : null;
    result.usageComplete =
      priced !== null &&
      usage.inputTokens! <= PREPAID_AI_LIMITS.modelContextTokens &&
      usage.outputTokens! <= OUTPUT_TOKENS;
    if (result.usageComplete)
      cents = Number((BigInt(priced!) + 9_999_999n) / 10_000_000n);
    if (cents > hold) {
      cents = hold;
      result.usageComplete = false;
    }
    const answer =
      Array.isArray(raw.output) &&
      raw.output.some((item) => {
        const row = object(item);
        return (
          row.type === "message" &&
          Array.isArray(row.content) &&
          row.content.some((part) => {
            const block = object(part);
            return (
              block.type === "output_text" &&
              typeof block.text === "string" &&
              block.text.trim() === "OK"
            );
          })
        );
      });
    result.reason =
      result.model === "unknown"
        ? "model-mismatch"
        : result.tier !== "default"
          ? "tier-mismatch"
          : raw.status !== "completed" || !answer
            ? "invalid-response"
            : !result.usageComplete
              ? "usage-unavailable"
              : "connected";
    result.connected = result.reason === "connected";
  } catch (error) {
    result.reason =
      error instanceof ProbeTimeout ? "timeout" : "provider-unavailable";
  }
  try {
    if (!(await spend("settle", cents))) throw new Error("probe-settlement");
  } catch {
    result.connected = false;
    result.reason = "settlement-pending";
  }
  return result;
}
