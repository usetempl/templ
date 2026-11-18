import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { RPC_METHOD_CU, type RpcBudgetMethod } from "../usage-ledger";

/** Read limits of one transaction check. */
export const DIAGNOSIS_READ_LIMITS = {
  /** From the plan's checkedAt: a staff or agent run. */
  staffDeadlineMs: 20_000,
  /** Jobs run inside the 30 s waitUntil window. */
  jobDeadlineMs: 25_000,
  probeNetworks: 8,
  /** Other networks read for recipient code when tx.to has none. */
  otherCodeNetworks: 3,
  /** Key-guard networks: hint ∪ member wallet chains ∪ {1, 8453}. */
  guardNetworks: 4,
  tokens: 16,
  abiLookups: 2,
  receiptMaxBytes: 8 * 1024 * 1024,
  /** Wait before repeating a split read once. */
  retryWaitMs: 1_500,
} as const;

/** Provider requests one run may send, per side and including retries. The read layer stops at the cap and marks what is left
 * unavailable with reason "budget". */
export const RPC_CALLS_PER_RUN = FEATURE_LIMITS.rpcCallsPerRun;
/** Upper bound of Workers subrequests per provider attempt: the fetch and
 * the reserve, attempt and settle calls in the service and room budgets. */
export const SUBREQUESTS_PER_RPC_CALL = 7;
// Workers allow 1,000 subrequests per invocation; a run stays under 700
// (tx-diagnosis-read.test.ts checks every run against that ceiling).

/** What a run spent; logged and stored, never shown to members. */
export type RunMeter = {
  /** Provider requests the read layer asked for, per side. */
  calls: number;
  /** Actual fetch attempts, retries included. */
  attempts: number;
  primaryCu: number;
  confirmationAttempts: number;
  budgetLimited: boolean;
  readonly cap: number;
};

export function createRunMeter(cap: number = RPC_CALLS_PER_RUN): RunMeter {
  return {
    calls: 0,
    attempts: 0,
    primaryCu: 0,
    confirmationAttempts: 0,
    budgetLimited: false,
    cap,
  };
}

export function chargeAttempt(
  meter: RunMeter,
  role: "primary" | "confirmation",
  method: string | readonly string[],
) {
  meter.attempts += 1;
  if (role === "primary")
    for (const name of typeof method === "string" ? [method] : method)
      meter.primaryCu += Object.hasOwn(RPC_METHOD_CU, name)
        ? RPC_METHOD_CU[name as RpcBudgetMethod]
        : 0;
  else meter.confirmationAttempts += 1;
}

export function meterSubrequests(meter: RunMeter) {
  return meter.attempts * SUBREQUESTS_PER_RPC_CALL;
}
