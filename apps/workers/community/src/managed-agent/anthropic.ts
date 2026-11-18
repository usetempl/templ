import {
  MANAGED_AGENT_LIMITS,
  MANAGED_AGENT_MODEL,
  MANAGED_ANSWER_SCHEMA,
  type ManagedUsage,
} from "@templ/chat/managed-agent";
import type { WorkspaceCostEvent } from "@templ/chat/workspace-costs";
import { managedAttempt } from "./usage";
import { HANDOFF_LEARNING_SCHEMA } from "@templ/chat/support-learning";

export type ManagedModelEnv = {
  AI?: Pick<Ai, "run">;
  MANAGED_AGENT_GATEWAY_ID?: string;
  ANTHROPIC_API_KEY?: string;
};

export function managedModelAvailable(env: ManagedModelEnv): boolean {
  return Boolean(
    (env.AI && /^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")) ||
    env.ANTHROPIC_API_KEY,
  );
}

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ModelRequest = {
  system: string;
  user: string;
  /** Internal task selector. Ordinary answers retain their pinned schema. */
  format?: "answer" | "handoff-learning";
  purpose?: WorkspaceCostEvent["purpose"];
  onCostAttempt?: (consumer: (outcome: NonNullable<WorkspaceCostEvent["consumerOutcome"]>) => void) => void;
};
export type ModelResult =
  | { kind: "answer"; value: unknown; usage: ManagedUsage; model: string; standardUsage?: import("@templ/chat/standard-usage").StandardAiTokenUsage | null }
  | { kind: "refusal"; usage: ManagedUsage; standardUsage?: import("@templ/chat/standard-usage").StandardAiTokenUsage | null }
  | { kind: "failed"; reason: string; usage: ManagedUsage | null; standardUsage?: import("@templ/chat/standard-usage").StandardAiTokenUsage | null; /** Set only by a trusted caller before inference, never from model output. */ providerAttempted?: false };
export type ModelCaller = (request: ModelRequest) => Promise<ModelResult>;

type ApiResponse = {
  model?: string;
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  usage?: ManagedUsage;
};

/** One Anthropic Messages call. The native binding uses the existing gateway.
 * Private inputs bypass gateway logs and caches. Tests inject both transports. */
export function anthropicCaller(input: (
  | { apiKey: string; fetch?: typeof fetch }
  | { ai: Pick<Ai, "run">; gatewayId: string }
) & { timeoutMs?: number; observeCost?: (event: WorkspaceCostEvent) => void }): ModelCaller {
  return async ({ system, user, format = "answer", purpose = "other", onCostAttempt }) => {
    const request = {
      model: MANAGED_AGENT_MODEL,
      max_tokens: MANAGED_AGENT_LIMITS.maxOutputTokens,
      ...("ai" in input
        ? { system }
        : {
            fallbacks: "default",
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          }),
      messages: [{ role: "user", content: user }],
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: format === "handoff-learning" ? HANDOFF_LEARNING_SCHEMA : MANAGED_ANSWER_SCHEMA,
        },
      },
    };
    const timeoutMs = input.timeoutMs ?? MANAGED_AGENT_LIMITS.callTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    let body: ApiResponse;
    let cost: ReturnType<typeof managedAttempt>;
    try { cost = managedAttempt(MANAGED_AGENT_MODEL, purpose, input.observeCost); }
    catch { cost = { provider() {}, consumer() {} }; }
    try { onCostAttempt?.((outcome) => cost.consumer(outcome)); } catch { /* Accounting is optional. */ }
    try {
      if ("ai" in input) {
        body = await input.ai.run(`anthropic/${MANAGED_AGENT_MODEL}`, request, {
          signal,
          extraHeaders: { "anthropic-beta": FALLBACK_BETA },
          gateway: {
            id: input.gatewayId,
            collectLog: false,
            skipCache: true,
            requestTimeoutMs: timeoutMs,
            retries: { maxAttempts: 1 },
          },
        }) as ApiResponse;
      } else {
        const response = await (input.fetch ?? fetch)(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": input.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": FALLBACK_BETA,
          },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          cost.provider("failed");
          return { kind: "failed", reason: `status-${response.status}`, usage: null };
        }
        body = await response.json() as ApiResponse;
      }
    } catch (error) {
      cost.provider(signal.aborted ? "timeout" : "failed");
      return {
        kind: "failed",
        reason: (error as { name?: string })?.name === "TimeoutError" ? "timeout" : "network",
        usage: null,
      };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      cost.provider("failed");
      return { kind: "failed", reason: "invalid-response", usage: null };
    }
    cost.provider("completed", body);
    const usage = body.usage ?? {};
    if (body.stop_reason === "refusal") return { kind: "refusal", usage };
    if (body.stop_reason !== "end_turn")
      return { kind: "failed", reason: body.stop_reason ?? "no-stop-reason", usage };
    const text = (Array.isArray(body.content) ? body.content : [])
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    try {
      return {
        kind: "answer",
        value: JSON.parse(text),
        usage,
        model: typeof body.model === "string" ? body.model : MANAGED_AGENT_MODEL,
      };
    } catch {
      return { kind: "failed", reason: "not-json", usage };
    }
  };
}
