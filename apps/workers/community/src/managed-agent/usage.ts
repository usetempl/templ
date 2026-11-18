import type { WorkspaceCostEvent, WorkspaceCostUsage } from "@templ/chat/workspace-costs";

const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1e12 ? Number(value) : null;
export const costModel = (value: unknown): string => typeof value === "string" && value.length <= 96 && (value === "unknown" || /^(?:@cf\/[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9._:-]*|[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)+)$/.test(value)) ? value : "unknown";
export function anthropicUsage(value: unknown): WorkspaceCostUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: count(usage.cache_read_input_tokens),
    cacheWriteInputTokens: count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningTokens: null,
    billableUnits: null,
  };
}

/** The callback schedules private accounting; it never controls the model call. */
export function managedAttempt(requestedModel: string, purpose: WorkspaceCostEvent["purpose"], observe?: (event: WorkspaceCostEvent) => void) {
  const id = crypto.randomUUID(), started = Date.now();
  const base = { schemaVersion: 1 as const, attemptId: id, provider: "anthropic" as const, requestedModel, purpose };
  const emit = (event: Omit<WorkspaceCostEvent, keyof typeof base | "at">) => {
    try { observe?.({ ...base, at: new Date().toISOString(), ...event }); } catch { /* Fail open. */ }
  };
  emit({ phase: "started", model: "unknown" });
  let actualModel = "unknown";
  return {
    provider(transportOutcome: NonNullable<WorkspaceCostEvent["transportOutcome"]>, body?: { model?: unknown; usage?: unknown }) {
      actualModel = costModel(body?.model);
      emit({ phase: "provider-finished", model: actualModel, transportOutcome, usage: anthropicUsage(body?.usage), durationMs: Math.max(0, Date.now() - started) });
    },
    consumer(consumerOutcome: NonNullable<WorkspaceCostEvent["consumerOutcome"]>) {
      emit({ phase: "consumer-finished", model: actualModel, consumerOutcome });
    },
  };
}
