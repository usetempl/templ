import { base58Decode } from "../solana";
import type {
  DetectedTransactionRef,
  EvmNetwork,
  Hex,
  TransactionRef,
} from "./types";

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** A Solana signature is base58 text of 64 to 88 characters that decodes to
 * exactly 64 bytes. Leading zero bytes make shorter valid values. */
export function isSolanaSignature(value: string): boolean {
  if (!SIGNATURE.test(value)) return false;
  try {
    return base58Decode(value).length === 64;
  } catch {
    return false;
  }
}

/** One EVM transaction hash or Solana signature, or null. */
export function parseTransactionRef(value: string): TransactionRef | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (EVM_HASH.test(text))
    return { kind: "evm", hash: text.toLowerCase() as Hex };
  if (isSolanaSignature(text)) return { kind: "solana", signature: text };
  return null;
}

/** Explorer hosts whose /tx/ links name an EVM network. */
const EVM_EXPLORERS: Readonly<Record<string, EvmNetwork>> = {
  "etherscan.io": "eip155:1",
  "optimistic.etherscan.io": "eip155:10",
  "bscscan.com": "eip155:56",
  "polygonscan.com": "eip155:137",
  "explorer.zksync.io": "eip155:324",
  "basescan.org": "eip155:8453",
  "arbiscan.io": "eip155:42161",
  "snowtrace.io": "eip155:43114",
  "lineascan.build": "eip155:59144",
  "blastscan.io": "eip155:81457",
  "scrollscan.com": "eip155:534352",
  "robinhoodchain.blockscout.com": "eip155:4663",
};
const SOLANA_EXPLORERS = new Set(["solscan.io", "explorer.solana.com"]);
const LINK =
  /https:\/\/([A-Za-z0-9.-]{1,253})\/tx\/([0-9A-Za-z]{1,100})(?![0-9A-Za-z])(\?[^\s#"'<>]*)?/gi;
const MAX_REFS = 5;

/** Transaction references found only in explorer links (https, a known host
 * with an optional www. prefix, a /tx/ path). Bare hex and bare base58 in
 * message text are never returned: a 32-byte EVM private key and a 64-byte
 * Solana secret key have the shapes of a hash and a signature. */
export function detectTransactionRefs(text: string): DetectedTransactionRef[] {
  const refs: DetectedTransactionRef[] = [];
  const seen = new Set<string>();
  if (typeof text !== "string") return refs;
  for (const match of text.matchAll(LINK)) {
    if (refs.length >= MAX_REFS) break;
    const host = match[1].toLowerCase().replace(/^www\./, "");
    const value = match[2];
    const query = match[3] ?? "";
    let ref: DetectedTransactionRef | null = null;
    if (Object.prototype.hasOwnProperty.call(EVM_EXPLORERS, host)) {
      if (EVM_HASH.test(value))
        ref = {
          kind: "evm",
          hash: value.toLowerCase() as Hex,
          network: EVM_EXPLORERS[host],
        };
    } else if (SOLANA_EXPLORERS.has(host) && isSolanaSignature(value)) {
      const cluster = /[?&]cluster=(devnet|testnet)(?:&|$)/i.exec(query);
      ref = {
        kind: "solana",
        signature: value,
        cluster: cluster
          ? (cluster[1].toLowerCase() as "devnet" | "testnet")
          : null,
      };
    }
    if (!ref) continue;
    const key =
      ref.kind === "evm"
        ? `${ref.network}:${ref.hash}`
        : `solana:${ref.signature}:${ref.cluster ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}
