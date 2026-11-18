import { privateKeyToAddress } from "viem/accounts";
import type { Hex } from "@templ/chat/diagnosis/types";
import { base58Decode } from "@templ/chat/solana";
import { agreedValue, type ReadFailure } from "./agree";
import { agreedLatestHead } from "./heads";
import type { DiagnosisChain } from "./chains";
import type { DiagnosisRpc } from "./rpc";
import { solanaBytesAreKeypair } from "@templ/chat/support-secret-check";
export { solanaBytesAreKeypair } from "@templ/chat/support-secret-check";

/** A pasted private key looks like a transaction hash (32 bytes) or a Solana
 * signature (64 bytes). Before any value leaves Templ, the guard decides
 * whether it is a key:
 *  - Solana: 64 bytes whose first half derives the second half is an Ed25519
 *    keypair. Decided locally; nothing is sent.
 *  - EVM: 32 bytes that are a valid secp256k1 scalar derive an address. Only
 *    that address is read (nonce and balance at an agreed head) on the guard
 *    networks. A used address means a key. A read that fails ends the run
 *    without sending the value.
 * Known gap: a key whose wallet was never used on a guard network, or holds
 * only tokens, passes. */
export type GuardResult =
  | { outcome: "clear" }
  | { outcome: "suspected" }
  | { outcome: "unavailable"; reason: ReadFailure };

const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

/** The address a 32-byte value would control, or null when it cannot be a
 * key (zero, or at least the curve order). */
export function evmKeyAddress(value: Hex): Hex | null {
  if (!/^0x[0-9a-f]{64}$/.test(value)) return null;
  const scalar = BigInt(value);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) return null;
  return privateKeyToAddress(value).toLowerCase() as Hex;
}

/** True when a base58 value decodes to 64 bytes that are an Ed25519 secret
 * key followed by its own public key (the Solana keypair format). A real
 * signature never has that shape. */
export async function isSolanaKeypair(value: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value);
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  try {
    return await solanaBytesAreKeypair(bytes);
  } catch {
    // A runtime that cannot derive the key must not wave the value through.
    return true;
  }
}

/** Guard networks: the hint network, the member's signed and claimed wallet
 * chains, Ethereum and Base, kept to the enabled ones, at most four. */
export function guardNetworks(
  enabled: readonly DiagnosisChain[],
  wanted: readonly string[],
): DiagnosisChain[] {
  const order = [...wanted, "eip155:1", "eip155:8453"];
  const out: DiagnosisChain[] = [];
  for (const network of order) {
    const chain = enabled.find((item) => item.network === network);
    if (chain && !out.includes(chain)) out.push(chain);
    if (out.length === 4) break;
  }
  return out;
}

/** Reads the derived address on every guard network in parallel. */
export async function checkEvmKeyGuard(
  value: Hex,
  rpcs: readonly { chain: DiagnosisChain; rpc: DiagnosisRpc }[],
): Promise<GuardResult> {
  const address = evmKeyAddress(value);
  if (!address) return { outcome: "clear" };
  if (!rpcs.length) return { outcome: "unavailable", reason: "provider-error" };
  const results = await Promise.all(
    rpcs.map(async ({ chain, rpc }): Promise<GuardResult> => {
      const head = await agreedLatestHead(rpc, chain.maxHeadAgeSeconds);
      if (!head.ok) return { outcome: "unavailable", reason: head.reason };
      const at = { blockHash: head.block.hash, requireCanonical: true };
      const quantity = (raw: unknown) => {
        if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(raw))
          throw new Error("quantity");
        return BigInt(raw).toString();
      };
      const [nonce, balance] = await Promise.all([
        rpc.both("eth_getTransactionCount", [address, at]),
        rpc.both("eth_getBalance", [address, at]),
      ]);
      const n = agreedValue(nonce, quantity);
      const b = agreedValue(balance, quantity);
      if (n.kind === "agreed" && n.value !== "0")
        return { outcome: "suspected" };
      if (b.kind === "agreed" && b.value !== "0")
        return { outcome: "suspected" };
      if (n.kind !== "agreed")
        return { outcome: "unavailable", reason: n.reason };
      if (b.kind !== "agreed")
        return { outcome: "unavailable", reason: b.reason };
      return { outcome: "clear" };
    }),
  );
  if (results.some((result) => result.outcome === "suspected"))
    return { outcome: "suspected" };
  const failed = results.find((result) => result.outcome === "unavailable");
  return failed ?? { outcome: "clear" };
}
