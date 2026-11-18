import {
  agreeSolanaStatus,
  solanaStatusView,
  solanaTransactionView,
} from "@templ/chat/diagnosis/solana-normalize";
import type {
  SolanaDiagnosisInput,
  SolanaHeight,
  SolanaStatusFact,
  SolanaTxFact,
  UnavailableReason,
  ProviderObservations,
} from "@templ/chat/diagnosis/types";
import { observePair, pairFailure, type ReadProblem } from "./agree";
import type { DiagnosisRunPlan } from "./plan";
import type { DiagnosisRpc } from "./rpc";

/** Solana checks use the configured source policy. Independent sources must agree.
 * Signature status and transaction reads preserve that policy; logs pass through as
 * the chain reported them and never interpreted beyond the engine's reviewed
 * tables. Honest limits: no ABI-level decoding, token balances only, no
 * Solana smart-wallet facts. */

/** Heights both providers report within two blocks; the lower pair wins. */
const HEIGHT_TOLERANCE = 2;

function epochHeight(raw: unknown): { blockHeight: number; slot: number } {
  if (!raw || typeof raw !== "object") throw new Error("epoch info");
  const { blockHeight, absoluteSlot } = raw as Record<string, unknown>;
  if (
    typeof blockHeight !== "number" ||
    !Number.isSafeInteger(blockHeight) ||
    blockHeight < 0 ||
    typeof absoluteSlot !== "number" ||
    !Number.isSafeInteger(absoluteSlot) ||
    absoluteSlot < 0
  )
    throw new Error("epoch info");
  return { blockHeight, slot: absoluteSlot };
}

async function agreedHeight(
  rpc: DiagnosisRpc,
): Promise<{ ok: true; height: SolanaHeight } | ({ ok: false } & ReadProblem)> {
  const pair = await rpc.both("getEpochInfo", [{ commitment: "confirmed" }]);
  const failure = pairFailure(pair);
  if (failure) return { ok: false, reason: failure };
  try {
    const [a, b] = pair.map((side) => epochHeight(side.result));
    if (
      pair.length === 2 &&
      Math.abs(a.blockHeight - b.blockHeight) > HEIGHT_TOLERANCE
    )
      return {
        ok: false,
        reason: "providers-disagree",
        observations: observePair(pair),
      };
    const lower = pair.length === 1 || a.blockHeight <= b.blockHeight ? a : b;
    return {
      ok: true,
      height: {
        ...lower,
        at: new Date(rpc.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    };
  } catch {
    return { ok: false, reason: "provider-error" };
  }
}

function statusEntry(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") throw new Error("status");
  const value = (raw as { value?: unknown }).value;
  if (!Array.isArray(value) || value.length !== 1) throw new Error("status");
  return value[0];
}

async function agreedStatus(
  rpc: DiagnosisRpc,
  signature: string,
): Promise<
  { ok: true; status: SolanaStatusFact } | ({ ok: false } & ReadProblem)
> {
  const pair = await rpc.both("getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  // A status needs its own two-call reduce: one provider's sighting of a
  // processed signature is a fact ("seen by one"), not a failure.
  if (pair.some((side) => side.failed === "budget"))
    return { ok: false, reason: "budget" };
  const views = pair.map((side) => {
    if (side.failed || side.error) return undefined;
    try {
      return solanaStatusView(statusEntry(side.result));
    } catch {
      return undefined;
    }
  });
  if (views.some((view) => view === undefined))
    return { ok: false, reason: "provider-error" };
  try {
    if (pair.length === 1) {
      const value = views[0];
      const status: SolanaStatusFact = !value
        ? { kind: "agreed", found: false }
        : value.commitment === "processed"
          ? { kind: "seen", by: ["primary"], ...value, commitment: "processed" }
          : {
              kind: "agreed",
              found: true,
              ...value,
              commitment: value.commitment,
            };
      return { ok: true, status };
    }
    return {
      ok: true,
      status: agreeSolanaStatus(views[0] ?? null, views[1] ?? null),
    };
  } catch {
    return {
      ok: false,
      reason: "providers-disagree",
      observations: observePair(pair),
    };
  }
}

async function agreedTransaction(
  rpc: DiagnosisRpc,
  signature: string,
  commitment: "confirmed" | "finalized",
): Promise<
  { ok: true; tx: SolanaTxFact | null } | ({ ok: false } & ReadProblem)
> {
  const pair = await rpc.both("getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    },
  ]);
  const failure = pairFailure(pair);
  if (failure) return { ok: false, reason: failure };
  if (pair.length === 1) {
    if (pair[0].result === null) return { ok: true, tx: null };
    try {
      return {
        ok: true,
        tx: solanaTransactionView(pair[0].result, commitment),
      };
    } catch {
      return { ok: false, reason: "provider-error" };
    }
  }
  const [a, b] = pair.map((side) => side.result ?? null);
  if (a === null && b === null) return { ok: true, tx: null };
  if (a === null || b === null)
    return {
      ok: false,
      reason: "providers-disagree",
      observations: observePair(pair),
    };
  try {
    const left = solanaTransactionView(a, commitment);
    const right = solanaTransactionView(b, commitment);
    if (JSON.stringify(left) !== JSON.stringify(right))
      return {
        ok: false,
        reason: "providers-disagree",
        observations: observePair(pair),
      };
    return { ok: true, tx: left };
  } catch {
    return { ok: false, reason: "provider-error" };
  }
}

const ZERO_HEIGHT = (at: string): SolanaHeight => ({
  blockHeight: 0,
  slot: 0,
  at,
});

/** The Solana input for one signature. Heights are read before the status,
 * so "expired" is decided on a height the status read already saw. */
export async function readSolanaInput(
  plan: DiagnosisRunPlan,
  rpc: DiagnosisRpc | null,
  archival: boolean,
): Promise<SolanaDiagnosisInput> {
  if (plan.subject.kind !== "solana") throw new Error("not a Solana subject");
  const signature = plan.subject.signature;
  const base = {
    v: 1 as const,
    kind: "solana" as const,
    checkedAt: plan.checkedAt,
    hint: plan.hint,
    wallet: plan.wallet,
    profile: null,
    signature,
    providers: { archival },
    previous: plan.solana?.previous ?? null,
  };
  const unavailable = (
    reason: UnavailableReason | "providers-disagree",
    current?: SolanaHeight,
    observations?: ProviderObservations,
  ): SolanaDiagnosisInput => {
    const now =
      current ?? plan.solana?.firstCheck ?? ZERO_HEIGHT(plan.checkedAt);
    const first = plan.solana?.firstCheck ?? now;
    return {
      ...base,
      unavailable:
        reason === "providers-disagree" ? null : { reason, network: "solana" },
      ...(reason === "providers-disagree" && observations
        ? { disagreement: { network: "solana" as const, observations } }
        : {}),
      status: { kind: "agreed", found: false },
      tx: null,
      heights: {
        firstCheck: first.blockHeight <= now.blockHeight ? first : now,
        current: now,
      },
    };
  };
  if (!rpc) return unavailable("not-configured");
  const height = await agreedHeight(rpc);
  if (!height.ok)
    return unavailable(height.reason, undefined, height.observations);
  const current = height.height;
  const firstCheck =
    plan.solana?.firstCheck &&
    plan.solana.firstCheck.blockHeight <= current.blockHeight
      ? plan.solana.firstCheck
      : current;
  const status = await agreedStatus(rpc, signature);
  if (!status.ok)
    return unavailable(status.reason, current, status.observations);
  let tx: SolanaTxFact | null = null;
  if (status.status.kind === "agreed" && status.status.found) {
    const read = await agreedTransaction(
      rpc,
      signature,
      status.status.commitment,
    );
    if (!read.ok) return unavailable(read.reason, current, read.observations);
    tx = read.tx;
  }
  return {
    ...base,
    unavailable: null,
    status: status.status,
    tx,
    heights: { firstCheck, current },
  };
}
