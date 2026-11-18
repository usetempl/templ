import { evmBlockView } from "@templ/chat/diagnosis/evm-normalize";
import type { AgreedBlock, Quantity } from "@templ/chat/diagnosis/types";
import { agreed, observePair, pairFailure, type ReadProblem } from "./agree";
import type { DiagnosisRpc } from "./rpc";

export type HeadRead =
  | { ok: true; block: AgreedBlock }
  | ({ ok: false } & ReadProblem);

const BLOCK_VERDICT = ["number", "hash", "timestamp"] as const;
const BLOCK_DISPLAY = ["baseFeePerGas"] as const;
const toQuantity = (value: bigint) => `0x${value.toString(16)}` as Quantity;

/** One block by number, agreed by both providers. */
export async function agreedBlockByNumber(
  rpc: DiagnosisRpc,
  number: Quantity,
): Promise<HeadRead> {
  const pair = await rpc.both("eth_getBlockByNumber", [number, false]);
  const read = agreed(pair, evmBlockView, BLOCK_VERDICT, BLOCK_DISPLAY);
  if (read.kind === "agreed") return { ok: true, block: read.value };
  if (read.kind === "unavailable")
    return { ok: false, reason: read.reason, observations: read.observations };
  if (read.kind === "both-null") return { ok: false, reason: "provider-error" };
  return {
    ok: false,
    reason: "providers-disagree",
    observations: observePair(pair),
  };
}

/** The agreed head for a tag. Both providers answer; the lower number is
 * re-read on both by number so a provider one block ahead still agrees.
 * `latest` must be at most maxHeadAgeSeconds old (and not more than 30 s in
 * the future). */
export async function agreedLatestHead(
  rpc: DiagnosisRpc,
  maxHeadAgeSeconds: number,
): Promise<HeadRead> {
  const pair = await rpc.both("eth_getBlockByNumber", ["latest", false]);
  const failure = pairFailure(pair);
  if (failure) return { ok: false, reason: failure };
  let views;
  try {
    views = pair.map((side) => evmBlockView(side.result));
  } catch {
    return { ok: false, reason: "provider-error" };
  }
  const [a, b] = views;
  let head: HeadRead;
  if (pair.length === 1) head = { ok: true, block: a };
  else if (a.number === b.number)
    head =
      a.hash === b.hash && a.timestamp === b.timestamp
        ? {
            ok: true,
            block:
              a.baseFeePerGas === b.baseFeePerGas
                ? a
                : { ...a, baseFeePerGas: null },
          }
        : {
            ok: false,
            reason: "providers-disagree",
            observations: observePair(pair),
          };
  else {
    const lower = BigInt(a.number) < BigInt(b.number) ? a.number : b.number;
    head = await agreedBlockByNumber(rpc, lower);
  }
  if (!head.ok) return head;
  const age =
    Math.floor(rpc.now() / 1000) - Number(BigInt(head.block.timestamp));
  if (age > maxHeadAgeSeconds || age < -30)
    return { ok: false, reason: "stale-head" };
  return head;
}

/** `safe` or `finalized`. A chain that doesn't serve the tag (an error on
 * either side) gives null, which the engine reads as "finality unknown". */
export async function agreedTagHead(
  rpc: DiagnosisRpc,
  tag: "safe" | "finalized",
): Promise<AgreedBlock | null> {
  const pair = await rpc.both("eth_getBlockByNumber", [tag, false]);
  if (pairFailure(pair)) return null;
  let views;
  try {
    views = pair.map((side) => evmBlockView(side.result));
  } catch {
    return null;
  }
  const [a, b] = views;
  if (pair.length === 1) return a;
  if (a.number === b.number)
    return a.hash === b.hash
      ? {
          ...a,
          baseFeePerGas:
            a.baseFeePerGas === b.baseFeePerGas ? a.baseFeePerGas : null,
        }
      : null;
  const lower = BigInt(a.number) < BigInt(b.number) ? a.number : b.number;
  const read = await agreedBlockByNumber(rpc, lower);
  return read.ok ? read.block : null;
}

export const parentNumber = (number: Quantity) =>
  toQuantity(BigInt(number) > 0n ? BigInt(number) - 1n : 0n);
export const chainIdQuantity = (id: number) => toQuantity(BigInt(id));

/** eth_chainId on both providers must be the table's id. */
export async function chainIdMatches(
  rpc: DiagnosisRpc,
  id: number,
): Promise<{ ok: true } | ({ ok: false } & ReadProblem)> {
  const pair = await rpc.both("eth_chainId", []);
  const failure = pairFailure(pair);
  if (failure) return { ok: false, reason: failure };
  const expected = chainIdQuantity(id);
  const ok = pair.every(
    (side) =>
      typeof side.result === "string" && side.result.toLowerCase() === expected,
  );
  if (!ok)
    console.warn(
      "TEMPL_DIAGNOSIS_READ",
      JSON.stringify({ chain: id, problem: "wrong-chain" }),
    );
  return ok ? { ok: true } : { ok: false, reason: "provider-error" };
}
