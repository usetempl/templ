import {
  parseBitcoinAddress,
  readBitcoinAddress,
  readBitcoinTransaction,
  type BitcoinActivity,
  type BitcoinTxFacts,
} from "./crypto-chain-read-bitcoin";
import {
  checkedAt,
  MAX_ITEMS,
  readContext,
  type CryptoChain,
  type CryptoChainReadDeps,
} from "./crypto-chain-read-egress";
import {
  parseEthereumAddress,
  readEthereumAddress,
  readEthereumTransaction,
  type EthereumActivity,
  type EthereumTxFacts,
} from "./crypto-chain-read-ethereum";
import type { AddressReadBody, TxReadBody } from "./crypto-chain-read-notes";
import {
  parseSolanaAddress,
  parseSolanaSignature,
  readSolanaAddress,
  readSolanaTransaction,
  type SolanaActivity,
  type SolanaTxFacts,
} from "./crypto-chain-read-solana";
import type { GuardResult } from "./tx-diagnosis/key-guard";

/** Read-only public lookups for the crypto desk: one Bitcoin, Ethereum or
 * Solana mainnet transaction, or an address's recent activity. Bad input is
 * refused before anything leaves Templ. Provider trouble is reported, never
 * thrown. The caller decides when a lookup runs and for which accepted
 * value. */

export {
  CRYPTO_PROVIDERS,
  createCryptoProviderState,
  type CryptoAgreement,
  type CryptoChain,
  type CryptoChainReadDeps,
  type CryptoProviderId,
  type CryptoProviderState,
  type CryptoSourceReport,
} from "./crypto-chain-read-egress";
export { CRYPTO_READ_NOTES, type CryptoReadNote } from "./crypto-chain-read-notes";
export type { BitcoinActivity, BitcoinActivityItem, BitcoinTxFacts } from "./crypto-chain-read-bitcoin";
export type {
  EthereumActivity,
  EthereumActivityTransfer,
  EthereumActivityTx,
  EthereumTokenTransfer,
  EthereumTxFacts,
} from "./crypto-chain-read-ethereum";
export type {
  SolanaActivity,
  SolanaActivityItem,
  SolanaAddressChange,
  SolanaTokenChange,
  SolanaTxError,
  SolanaTxFacts,
} from "./crypto-chain-read-solana";

type Hex = `0x${string}`;

/** A bare 32-byte hex value can be a private key, so a Bitcoin or Ethereum
 * ID needs evidence before it is sent anywhere. */
export type CryptoTxEvidence =
  /** The exact explorer link the visitor pasted. It is parsed, never
   * fetched, and must name the same chain and ID. */
  | { kind: "permalink"; url: string }
  /** Ethereum only: the caller's binding of the transaction check's key
   * guard (checkEvmKeyGuard). It runs once, before any request; anything but
   * "clear" refuses. */
  | { kind: "key-guard"; check: (hash: Hex) => Promise<GuardResult> };

export type CryptoTxQuery =
  | { chain: "bitcoin"; txid: string; evidence: CryptoTxEvidence }
  | { chain: "ethereum"; hash: string; evidence: CryptoTxEvidence }
  /** A 64-byte keypair is found locally and refused. */
  | { chain: "solana"; signature: string };

export type CryptoAddressQuery = {
  chain: CryptoChain;
  address: string;
  /** Items to return, 1 to 10. Default 10. */
  limit?: number;
};

export type CryptoReadRefusal =
  | "invalid-id"
  | "invalid-address"
  | "unsupported-chain"
  /** A Bitcoin or Ethereum ID without accepted evidence. */
  | "evidence-required"
  /** The link names another chain or ID. */
  | "evidence-mismatch"
  | "key-suspected"
  /** The key guard could not decide. Nothing is sent. */
  | "key-guard-unavailable"
  /** A Solana 64-byte secret key. */
  | "keypair"
  /** A Bitcoin WIF, BIP-38 or extended private key given as an address. */
  | "private-key";

type Refused = { kind: "refused"; chain: CryptoChain; reason: CryptoReadRefusal };
type Read<Chain extends CryptoChain, Body> = { kind: "read"; chain: Chain; checkedAt: string } & Body;

export type CryptoTxRead =
  | Refused
  | (Read<"bitcoin", TxReadBody<BitcoinTxFacts>> & { id: string })
  | (Read<"ethereum", TxReadBody<EthereumTxFacts>> & { id: Hex })
  | (Read<"solana", TxReadBody<SolanaTxFacts>> & { id: string });

export type CryptoAddressRead =
  | Refused
  | (Read<"bitcoin", AddressReadBody<BitcoinActivity>> & { address: string })
  | (Read<"ethereum", AddressReadBody<EthereumActivity>> & { address: Hex })
  | (Read<"solana", AddressReadBody<SolanaActivity>> & { address: string });

/** Explorer hosts whose /tx/ links are accepted as evidence. */
const PERMALINK_HOSTS: Readonly<Record<string, "bitcoin" | "ethereum">> = {
  "mempool.space": "bitcoin",
  "blockstream.info": "bitcoin",
  "etherscan.io": "ethereum",
  "www.etherscan.io": "ethereum",
  "eth.blockscout.com": "ethereum",
};

/** The transaction a vetted mainnet explorer link names: https, an exact
 * host, the path /tx/<id> with an optional trailing slash, no query. A
 * fragment is ignored. Testnet paths and other hosts give null. */
export function parseCryptoTxPermalink(
  input: string,
): { chain: "bitcoin"; txid: string } | { chain: "ethereum"; hash: Hex } | null {
  if (typeof input !== "string" || input.length > 300) return null;
  const text = input.trim();
  if (!/^\S+$/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search)
    return null;
  const chain = Object.hasOwn(PERMALINK_HOSTS, url.hostname) ? PERMALINK_HOSTS[url.hostname] : null;
  const id = /^\/tx\/((?:0x)?[0-9a-fA-F]{64})\/?$/.exec(url.pathname)?.[1];
  if (!chain || !id) return null;
  if (chain === "bitcoin")
    return id.startsWith("0x") ? null : { chain, txid: id.toLowerCase() };
  return id.startsWith("0x") ? { chain, hash: id.toLowerCase() as Hex } : null;
}

/** The normalized address egress would use, or why it is refused. Nothing
 * is sent. */
export async function parseCryptoAddress(
  chain: CryptoChain,
  value: string,
): Promise<
  | { ok: true; address: string }
  | { ok: false; reason: "invalid-address" | "private-key" | "keypair" }
> {
  if (chain === "bitcoin") return parseBitcoinAddress(value);
  if (chain === "ethereum") return parseEthereumAddress(value);
  if (chain === "solana") return parseSolanaAddress(value);
  return { ok: false, reason: "invalid-address" };
}

const refused = (chain: CryptoChain, reason: CryptoReadRefusal): Refused => ({
  kind: "refused",
  chain,
  reason,
});

/** The evidence check for a bare 32-byte ID. Runs before any request. */
async function evidenceRefusal(
  chain: "bitcoin" | "ethereum",
  id: string,
  evidence: CryptoTxEvidence | undefined,
): Promise<CryptoReadRefusal | null> {
  if (evidence?.kind === "permalink") {
    const link = parseCryptoTxPermalink(evidence.url);
    if (!link) return "evidence-required";
    const linked = link.chain === "bitcoin" ? link.txid : link.hash;
    return link.chain === chain && linked === id ? null : "evidence-mismatch";
  }
  // Only Ethereum has a key guard; a Bitcoin ID needs its link.
  if (chain !== "ethereum" || evidence?.kind !== "key-guard" || typeof evidence.check !== "function")
    return "evidence-required";
  let guard: GuardResult | undefined;
  try {
    guard = await evidence.check(id as Hex);
  } catch {
    return "key-guard-unavailable";
  }
  if (guard?.outcome === "suspected") return "key-suspected";
  return guard?.outcome === "clear" ? null : "key-guard-unavailable";
}

export async function readCryptoTransaction(
  query: CryptoTxQuery,
  deps: CryptoChainReadDeps = {},
): Promise<CryptoTxRead> {
  if (query?.chain === "bitcoin") {
    const txid = typeof query.txid === "string" ? query.txid.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(txid)) return refused("bitcoin", "invalid-id");
    const refusal = await evidenceRefusal("bitcoin", txid, query.evidence);
    if (refusal) return refused("bitcoin", refusal);
    const ctx = readContext(deps);
    const at = checkedAt(ctx);
    return {
      kind: "read",
      chain: "bitcoin",
      id: txid,
      checkedAt: at,
      ...(await readBitcoinTransaction(ctx, txid)),
    };
  }
  if (query?.chain === "ethereum") {
    const hash = typeof query.hash === "string" ? query.hash.trim().toLowerCase() : "";
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return refused("ethereum", "invalid-id");
    const refusal = await evidenceRefusal("ethereum", hash, query.evidence);
    if (refusal) return refused("ethereum", refusal);
    const ctx = readContext(deps);
    const at = checkedAt(ctx);
    return {
      kind: "read",
      chain: "ethereum",
      id: hash as Hex,
      checkedAt: at,
      ...(await readEthereumTransaction(ctx, hash as Hex)),
    };
  }
  if (query?.chain === "solana") {
    const parsed = await parseSolanaSignature(query.signature);
    if (!parsed.ok) return refused("solana", parsed.reason);
    const ctx = readContext(deps);
    const at = checkedAt(ctx);
    return {
      kind: "read",
      chain: "solana",
      id: parsed.signature,
      checkedAt: at,
      ...(await readSolanaTransaction(ctx, parsed.signature)),
    };
  }
  // Only an untyped caller reaches this line.
  const chain = (query as { chain: CryptoChain } | null)?.chain as CryptoChain;
  return refused(chain, "unsupported-chain");
}

export async function readCryptoAddressActivity(
  query: CryptoAddressQuery,
  deps: CryptoChainReadDeps = {},
): Promise<CryptoAddressRead> {
  const chain = query?.chain;
  if (chain !== "bitcoin" && chain !== "ethereum" && chain !== "solana")
    return refused(chain, "unsupported-chain");
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.min(MAX_ITEMS, Math.max(1, Math.floor(query.limit)))
      : MAX_ITEMS;
  const parsed = await parseCryptoAddress(chain, query.address);
  if (!parsed.ok) return refused(chain, parsed.reason);
  const ctx = readContext(deps);
  const at = checkedAt(ctx);
  if (chain === "bitcoin")
    return {
      kind: "read",
      chain,
      address: parsed.address,
      checkedAt: at,
      ...(await readBitcoinAddress(ctx, parsed.address, limit)),
    };
  if (chain === "ethereum")
    return {
      kind: "read",
      chain,
      address: parsed.address as Hex,
      checkedAt: at,
      ...(await readEthereumAddress(ctx, parsed.address as Hex, limit)),
    };
  return {
    kind: "read",
    chain,
    address: parsed.address,
    checkedAt: at,
    ...(await readSolanaAddress(ctx, parsed.address, limit)),
  };
}
