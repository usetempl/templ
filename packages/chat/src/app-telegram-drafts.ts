import type { StandardAiTokenUsage } from "./standard-usage";

/** Immutable metadata for one inference. It contains no case or provider credential. */
export type AppDraftAttempt = {
  workspace: string;
  attemptId: string;
  startedAt: string;
  /** Exact provider count, including framing. Absent means a full-context operating hold. */
  inputTokens?: number;
  requestBytes: number;
  requestSha256: string;
  /** Private operator synthetic jobs only. Uses Templ's ledger and permits qualification before customer enablement. */
  internalTrial?: true;
};
export type AppDraftBudgetInput =
  | (AppDraftAttempt & { op: "start" })
  | (AppDraftAttempt & {
      op: "finish";
      finishedAt: string;
      model: "gpt-6.1-sol" | "unknown";
      usage?: StandardAiTokenUsage;
      /** cancelled means proven no dispatch, with unknown model, no usage and discarded consumer. */
      transportOutcome: "completed" | "failed" | "cancelled" | "timeout";
      consumerOutcome: "draft" | "failed" | "discarded";
    });
export type AppDraftBudgetResult = {
  admitted: boolean;
  recorded: boolean;
  month?: string;
};
export type AppDraftConfiguration = {
  gatewayId: string;
  model: "gpt-6.1-sol";
  maxOutputTokens: 2048;
};
