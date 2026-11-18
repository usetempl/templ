import { agreeViews } from "@templ/chat/diagnosis/evm-normalize";
import { DIAGNOSIS_LIMITS } from "@templ/chat/diagnosis/rules";
import type {
  Hex,
  ProviderObservations,
  UnavailableReason,
} from "@templ/chat/diagnosis/types";
import type { Pair, Side } from "./rpc";

export type ReadFailure = UnavailableReason | "providers-disagree";
export type ReadProblem = {
  reason: ReadFailure;
  observations?: ProviderObservations;
};

function observationValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const preferred = [
      "status",
      "err",
      "confirmationStatus",
      "value",
      "slot",
      "blockNumber",
      "blockHash",
      "transactionHash",
      "hash",
    ];
    value = Object.fromEntries(
      [...new Set([...preferred, ...Object.keys(row)])]
        .filter((key) => key in row)
        .map((key) => [key, row[key]]),
    );
  }
  return JSON.stringify(value).slice(0, DIAGNOSIS_LIMITS.observationChars);
}

export function observePair(pair: Pair): ProviderObservations {
  if (pair.length !== 2)
    throw new Error("Independent observations need two sources");
  return pair.map((side, index) => ({
    provider: index === 0 ? "primary" : "confirmation",
    value: observationValue(side.error ?? side.result ?? null),
  })) as ProviderObservations;
}
export type Agreed<T> =
  | { kind: "agreed"; value: T; dropped: string[] }
  | { kind: "both-null" }
  /** One provider returned null and the other a value. */
  | {
      kind: "split";
      present: ("primary" | "confirmation")[];
      observations: ProviderObservations;
    }
  | ({ kind: "unavailable" } & ReadProblem);

/** Why a side gave no usable result: its own failure, or a JSON-RPC error. */
export function sideFailure(side: Side): "budget" | "provider-error" | null {
  if (side.failed === "budget") return "budget";
  if (side.failed || side.error || !("result" in side)) return "provider-error";
  return null;
}
/** Budget wins over provider-error: a budget refusal is what the room
 * explains to staff. */
export function pairFailure(pair: Pair): "budget" | "provider-error" | null {
  const reasons = pair.map(sideFailure);
  if (reasons.includes("budget")) return "budget";
  return reasons.includes("provider-error") ? "provider-error" : null;
}

/** Every configured source returned valid data. With two sources their verdict
 * fields must agree. Single-source provenance travels with the final input. */
export function agreed<T extends object>(
  pair: Pair,
  view: (raw: unknown) => T,
  verdict: readonly (keyof T & string)[],
  display: readonly (keyof T & string)[],
): Agreed<T> {
  const failure = pairFailure(pair);
  if (failure) return { kind: "unavailable", reason: failure };
  if (pair.length === 1) {
    if (pair[0].result === null) return { kind: "both-null" };
    try {
      return { kind: "agreed", value: view(pair[0].result), dropped: [] };
    } catch {
      return { kind: "unavailable", reason: "provider-error" };
    }
  }
  const [a, b] = pair.map((side) => side.result ?? null);
  if (a === null && b === null) return { kind: "both-null" };
  if (a === null || b === null)
    return {
      kind: "split",
      present: [a === null ? "confirmation" : "primary"],
      observations: observePair(pair),
    };
  let left: T;
  let right: T;
  try {
    left = view(a);
    right = view(b);
  } catch {
    return { kind: "unavailable", reason: "provider-error" };
  }
  try {
    const { view: value, dropped } = agreeViews(left, right, verdict, display);
    return { kind: "agreed", value, dropped };
  } catch {
    return {
      kind: "unavailable",
      reason: "providers-disagree",
      observations: observePair(pair),
    };
  }
}

/** A validated value; independent sources must return it identically. */
export function agreedValue<T>(
  pair: Pair,
  reduce: (raw: unknown) => T,
): { kind: "agreed"; value: T } | ({ kind: "unavailable" } & ReadProblem) {
  const failure = pairFailure(pair);
  if (failure) return { kind: "unavailable", reason: failure };
  try {
    const [a, b] = pair.map((side) => reduce(side.result));
    if (pair.length === 1) return { kind: "agreed", value: a };
    if (JSON.stringify(a) !== JSON.stringify(b))
      return {
        kind: "unavailable",
        reason: "providers-disagree",
        observations: observePair(pair),
      };
    return { kind: "agreed", value: a };
  } catch {
    return { kind: "unavailable", reason: "provider-error" };
  }
}

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const REVERT_DATA_BYTES = 16_384;

/** A revert reply: code 3, or -32000/-32015 with a message saying revert.
 * Returns its data (lowercase, "0x" when absent); null for a side that is
 * not a revert; "call-error" for a revert whose data is not hex or is too
 * long. Provider dialects are parsed, never compared. */
export function revertData(side: Side): Hex | "call-error" | null {
  const error = side.error;
  if (!error || side.failed) return null;
  const message = typeof error.message === "string" ? error.message : "";
  const isRevert =
    error.code === 3 ||
    ((error.code === -32000 || error.code === -32015) &&
      /revert/i.test(message));
  if (!isRevert) return null;
  if (error.data === undefined || error.data === null) return "0x";
  if (
    typeof error.data !== "string" ||
    !HEX_DATA.test(error.data) ||
    error.data.length > REVERT_DATA_BYTES * 2 + 2
  )
    return "call-error";
  return error.data.toLowerCase() as Hex;
}

export type ReplayOutcome =
  | { kind: "reverted"; data: Hex }
  | { kind: "succeeded" }
  | {
      kind: "unavailable";
      reason: "providers-disagree" | "provider-error" | "budget" | "call-error";
      observations?: ProviderObservations;
    };

/** Replay each configured source once; compare independent replies when present. */
export function replayOutcome(pair: Pair): ReplayOutcome {
  const failed = pair.find((side) => side.failed);
  if (failed)
    return {
      kind: "unavailable",
      reason: pair.some((side) => side.failed === "budget")
        ? "budget"
        : "provider-error",
    };
  const reverts = pair.map(revertData);
  if (reverts.includes("call-error"))
    return { kind: "unavailable", reason: "call-error" };
  const results = pair.map((side) => !side.error && "result" in side);
  if (results.every(Boolean)) return { kind: "succeeded" };
  if (pair.length === 1)
    return reverts[0] !== null
      ? { kind: "reverted", data: reverts[0] as Hex }
      : { kind: "unavailable", reason: "provider-error" };
  if (reverts[0] !== null && reverts[1] !== null)
    return reverts[0] === reverts[1]
      ? { kind: "reverted", data: reverts[0] as Hex }
      : {
          kind: "unavailable",
          reason: "providers-disagree",
          observations: observePair(pair),
        };
  // One revert and one result, or a revert beside another error.
  if (
    (reverts[0] !== null && results[1]) ||
    (reverts[1] !== null && results[0])
  )
    return {
      kind: "unavailable",
      reason: "providers-disagree",
      observations: observePair(pair),
    };
  return { kind: "unavailable", reason: "provider-error" };
}
