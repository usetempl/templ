import {
  MANAGED_AGENT_LIMITS,
  MANAGED_ANSWER_SCHEMA,
  checkedManagedAnswer,
} from "@templ/chat/managed-agent";
import {
  standardAiUsageUsdNanos,
  type StandardAiTokenUsage,
} from "@templ/chat/standard-usage";
import type {
  WorkspaceCostEvent,
  WorkspaceCostUsage,
} from "@templ/chat/workspace-costs";
import { readBytes, sha256Hex } from "../common";
import { PREPAID_AI_LIMITS } from "../product-prepaid-ai";
import type { ModelCaller } from "./anthropic";
import type { RoomClient } from "./room-client";
import { HANDOFF_LEARNING_SCHEMA, checkedHandoffLearningResult } from "@templ/chat/support-learning";

export const PREPAID_GPT_MODEL = "gpt-6.1-sol";
export const PREPAID_GPT_REQUEST_BYTES = 96 * 1024;
type GptBinding = Pick<Ai, "run"> & Partial<Pick<Ai, "gateway">>;
type CountedRequest = {
  model: string;
  instructions: string;
  input: unknown;
  reasoning: unknown;
  tools: unknown[];
  text: unknown;
  truncation: "disabled";
};

type CountDiagnostic = {
  inputTokens: number | null;
  reason:
    | "supported"
    | "binding-unavailable"
    | "http-error"
    | "invalid-response"
    | "timeout"
    | "transport-error";
  status: number | null;
  errorName: string | null;
};
// Never return provider error messages, URLs, response bodies or arbitrary names.
function countErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return [
    "Error",
    "TypeError",
    "SyntaxError",
    "AbortError",
    "TimeoutError",
    "AiGatewayInternalError",
    "InferenceUpstreamError",
  ].includes(name)
    ? name
    : "unknown";
}

async function diagnosePrepaidGptInput(
  ai: GptBinding,
  gatewayId: string,
  body: CountedRequest,
): Promise<CountDiagnostic> {
  const diagnostic: CountDiagnostic = {
    inputTokens: null,
    reason: "binding-unavailable",
    status: null,
    errorName: null,
  };
  if (!ai.gateway) return diagnostic;
  const signal = AbortSignal.timeout(5_000);
  try {
    diagnostic.reason = "transport-error";
    const response = await ai.gateway(gatewayId).run(
      {
        provider: "openai",
        endpoint: "responses/input_tokens",
        headers: { "Content-Type": "application/json" },
        // These are every input-affecting field accepted by the count endpoint.
        // Output limit, Standard service tier and storage/stream settings affect no input tokens.
        query: {
          model: body.model,
          instructions: body.instructions,
          input: body.input,
          reasoning: body.reasoning,
          tools: body.tools,
          text: body.text,
          truncation: body.truncation,
        },
      },
      {
        signal,
        gateway: {
          id: gatewayId,
          collectLog: false,
          skipCache: true,
          requestTimeoutMs: 5_000,
          retries: { maxAttempts: 1 },
        },
      },
    );
    diagnostic.status = response.status;
    if (!response.ok) {
      diagnostic.reason = "http-error";
      await response.body?.cancel();
      return diagnostic;
    }
    diagnostic.reason = "invalid-response";
    const value = JSON.parse(
      new TextDecoder().decode(await readBytes(response, 2_048)),
    );
    if (
      value?.object === "response.input_tokens" &&
      Number.isSafeInteger(value.input_tokens) &&
      value.input_tokens > 0 &&
      value.input_tokens <= PREPAID_AI_LIMITS.modelContextTokens
    ) {
      diagnostic.inputTokens = value.input_tokens;
      diagnostic.reason = "supported";
    }
  } catch (error) {
    diagnostic.errorName = countErrorName(error);
    if (signal.aborted) diagnostic.reason = "timeout";
  }
  return diagnostic;
}

/** OpenAI counts model framing and the structured-output schema, not an estimate of text bytes. */
export async function countPrepaidGptInput(
  ai: GptBinding,
  gatewayId: string,
  body: CountedRequest,
): Promise<number | null> {
  // An unavailable counting route never substitutes a guessed token count.
  return (await diagnosePrepaidGptInput(ai, gatewayId, body)).inputTokens;
}
const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1e12
    ? Number(value)
    : null;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function gptUsage(raw: unknown): StandardAiTokenUsage {
  const usage = record(raw),
    input = record(usage.input_tokens_details),
    output = record(usage.output_tokens_details);
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: count(input.cached_tokens),
    cacheWriteInputTokens: count(input.cache_write_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningTokens: count(output.reasoning_tokens),
  };
}
function costUsage(usage: StandardAiTokenUsage): WorkspaceCostUsage {
  return {
    ...usage,
    reasoningTokens: usage.reasoningTokens ?? null,
    billableUnits: null,
  };
}

/** One fixed, text-only request; counting and inference share this complete material. */
export function prepaidGptRequest(system: string, user: string, format: "answer" | "handoff-learning" = "answer") {
  return {
    model: PREPAID_GPT_MODEL,
    instructions: system,
    input: [{ role: "user", content: [{ type: "input_text", text: user }] }],
    max_output_tokens: MANAGED_AGENT_LIMITS.maxOutputTokens,
    reasoning: { effort: "medium" },
    service_tier: "default",
    store: false,
    stream: false,
    truncation: "disabled" as const,
    tools: [],
    text: {
      format: {
        type: "json_schema",
        name: format === "handoff-learning" ? "support_learning" : "support_answer",
        strict: true,
        schema: format === "handoff-learning" ? HANDOFF_LEARNING_SCHEMA : MANAGED_ANSWER_SCHEMA,
      },
    },
  };
}

/** Fixed noncustomer input. Its route must require the current Templ operator; no inference or billing writes. */
export async function probePrepaidGptCount(ai: GptBinding, gatewayId: string) {
  const body = prepaidGptRequest(
    "Use only the supplied support facts.",
    "What is a vault?",
  );
  const serialized = JSON.stringify(body);
  const diagnostic = await diagnosePrepaidGptInput(ai, gatewayId, body);
  return {
    model: PREPAID_GPT_MODEL,
    supported: diagnostic.inputTokens !== null,
    ...diagnostic,
    requestBytes: new TextEncoder().encode(serialized).length,
    requestSha256: await sha256Hex(serialized),
  };
}

type InferenceHold = {
  attemptId: string; requestBytes: number; model: string; maxOutputTokens: number;
  requestSha256: string; inputTokens?: number;
};
type InferenceSettlement = {
  attemptId: string; model: string; usage: StandardAiTokenUsage | null; outcome: "completed" | "failed";
};
export type GptFunding = {
  reserve(input: InferenceHold): Promise<boolean>;
  settle(input: InferenceSettlement): Promise<{ available: boolean }>;
};
type GptOptions = {
  ai: GptBinding;
  gatewayId: string;
  observeCost?(event: WorkspaceCostEvent): void;
};

/** Each paid call reserves against the workspace's existing rate card. */
export function prepaidGptCaller(input: GptOptions & { billing: RoomClient }): ModelCaller {
  return fundedGptCaller(input, {
    async reserve(request) {
      const held = await input.billing.post("/private/prepaid-ai/reserve", request);
      return held.status === 200 && held.body.mode === "prepaid" && held.body.admitted === true;
    },
    async settle(request) {
      const settled = await input.billing.post("/private/prepaid-ai/settle", request);
      if (settled.status !== 200) throw new Error("billing-settlement-pending");
      return { available: settled.body.unavailable !== true || settled.body.absorbedOverHold === true };
    },
  });
}

export function fundedGptCaller(input: GptOptions, funding: GptFunding): ModelCaller {
  return async ({ system, user, format = "answer", purpose = "other", onCostAttempt }) => {
    const body = prepaidGptRequest(system, user, format);
    const serialized = JSON.stringify(body),
      requestBytes = new TextEncoder().encode(serialized).length;
    if (requestBytes > PREPAID_GPT_REQUEST_BYTES)
      return {
        kind: "failed",
        reason: "request-too-large",
        usage: null,
        providerAttempted: false,
      };
    const inputTokens = await countPrepaidGptInput(
      input.ai,
      input.gatewayId,
      body,
    );
    const attemptId = crypto.randomUUID();
    let held;
    try {
      held = await funding.reserve({
        attemptId,
        requestBytes,
        model: PREPAID_GPT_MODEL,
        maxOutputTokens: body.max_output_tokens,
        requestSha256: await sha256Hex(serialized),
        ...(inputTokens === null ? {} : { inputTokens }),
      });
    } catch {
      return {
        kind: "failed",
        reason: "billing-unavailable",
        usage: null,
        providerAttempted: false,
      };
    }
    if (!held)
      return {
        kind: "failed",
        reason: "prepaid-admission-refused",
        usage: null,
        providerAttempted: false,
      };

    const started = Date.now();
    const base = {
      schemaVersion: 1 as const,
      attemptId,
      provider: "cloudflare" as const,
      requestedModel: PREPAID_GPT_MODEL,
      purpose,
    };
    const emit = (
      event: Omit<WorkspaceCostEvent, keyof typeof base | "at">,
    ) => {
      try {
        input.observeCost?.({
          ...base,
          ...event,
          at: new Date().toISOString(),
        });
      } catch {
        /* Reporting does not control the call. */
      }
    };
    emit({ phase: "started", model: "unknown" });
    let model = "unknown",
      usage: StandardAiTokenUsage | null = null;
    try {
      onCostAttempt?.((consumerOutcome) =>
        emit({ phase: "consumer-finished", model, consumerOutcome }),
      );
    } catch {
      /* Cost reporting is optional. */
    }
    let result: Record<string, unknown> = {},
      outcome: "completed" | "failed" = "failed";
    const signal = AbortSignal.timeout(MANAGED_AGENT_LIMITS.callTimeoutMs);
    try {
      result = record(
        await input.ai.run(
          "openai/gpt-6.1-sol" as Parameters<Ai["run"]>[0],
          body as never,
          {
            signal,
            gateway: {
              id: input.gatewayId,
              collectLog: false,
              skipCache: true,
              requestTimeoutMs: MANAGED_AGENT_LIMITS.callTimeoutMs,
              retries: { maxAttempts: 1 },
            },
          },
        ),
      );
      model = typeof result.model === "string" ? result.model : "unknown";
      usage = gptUsage(result.usage);
      if (result.status === "completed" && model === PREPAID_GPT_MODEL)
        outcome = "completed";
    } catch {
      /* Terminal failure releases this hold and records absorbed exposure. */
    }
    const providerCompleted = result.status === "completed";
    const standardTier =
      result.service_tier === undefined || result.service_tier === "default";
    let parsed: unknown = null,
      failure = signal.aborted ? "timeout" : "provider",
      refused = false;
    if (outcome === "completed" && standardTier) {
      const blocks = Array.isArray(result.output)
        ? result.output.flatMap((item) => {
            const row = record(item);
            return row.type === "message" && Array.isArray(row.content)
              ? row.content.map(record)
              : [];
          })
        : [];
      refused = blocks.some((item) => item.type === "refusal");
      const text = blocks
        .filter(
          (item) =>
            item.type === "output_text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("");
      try {
        const value = JSON.parse(text);
        const ids = record(value).sources;
        parsed = format === "handoff-learning"
          ? checkedHandoffLearningResult(value) ? value : null
          : checkedManagedAnswer(value, {
          sourceIds: new Set(
            Array.isArray(ids)
              ? ids.filter((id): id is string => typeof id === "string")
              : [],
          ),
        });
      } catch {
        failure = "invalid-answer";
      }
    }
    const pricedUsage =
      model === PREPAID_GPT_MODEL && standardTier && usage
        ? standardAiUsageUsdNanos(model, usage)
        : null;
    const validUsage =
      pricedUsage !== null &&
      usage!.inputTokens! <=
        (inputTokens ?? PREPAID_AI_LIMITS.modelContextTokens) &&
      usage!.outputTokens! <= body.max_output_tokens;
    if (!validUsage && outcome === "completed" && standardTier)
      failure = "usage-unavailable";
    if (!standardTier || refused || parsed === null || !validUsage)
      outcome = "failed";
    emit({
      phase: "provider-finished",
      model,
      transportOutcome: providerCompleted
        ? "completed"
        : signal.aborted
          ? "timeout"
          : "failed",
      durationMs: Date.now() - started,
      ...(usage ? { usage: costUsage(usage) } : {}),
    });
    let settled;
    try {
      settled = await funding.settle({
        attemptId,
        model,
        usage,
        outcome,
      });
    } catch {
      return {
        kind: "failed",
        reason: "billing-settlement-pending",
        usage: null,
      };
    }
    const standardUsage =
      model === PREPAID_GPT_MODEL && standardTier ? usage : null;
    if (refused) return { kind: "refusal", usage: {}, standardUsage };
    if (
      outcome !== "completed" ||
      !settled.available
    )
      return { kind: "failed", reason: failure, usage: null, standardUsage };
    return { kind: "answer", value: parsed, model, usage: {}, standardUsage };
  };
}
