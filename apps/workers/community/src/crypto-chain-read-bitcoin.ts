import { base58Decode } from "@templ/chat/solana";
import { formatUnits, sha256 } from "viem";
import {
  agree,
  CryptoEgressRefused,
  esplora,
  fail,
  invalid,
  isoSeconds,
  isRecord,
  sameFacts,
  sourceReports,
  type CryptoProviderId,
  type EsploraProvider,
  type Observed,
  type ReadContext,
} from "./crypto-chain-read-egress";
import {
  addressReadNotes,
  txReadNotes,
  type ActivityAgreement,
  type AddressReadBody,
  type TxReadBody,
  type TxResult,
} from "./crypto-chain-read-notes";

/** Bitcoin mainnet through two Esplora operators. Amounts are satoshis. An
 * Esplora answer is used only when its fee equals its inputs minus its
 * outputs. */

const PROVIDERS: readonly EsploraProvider[] = ["mempool.space", "blockstream.info"];
/** Inputs and outputs listed per transaction; the counts are always given. */
const LISTED = 20;
/** Esplora's address page: up to 50 unconfirmed and 25 confirmed. */
const PAGE_UNCONFIRMED = 50;
const PAGE_CONFIRMED = 25;
const TXID = /^[0-9a-f]{64}$/;
/** Shape of an address in an Esplora answer. Display only, never sent. */
const ANSWER_ADDRESS = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[02-9ac-hj-np-z]{11,71})$/;

export type BitcoinTxFacts = {
  chain: "bitcoin";
  txid: string;
  /** Unconfirmed transactions can still be replaced or dropped. */
  state: "confirmed" | "unconfirmed";
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: string | null;
  /** From the provider's own tip; the lower count when two providers agree. */
  confirmations: number | null;
  coinbase: boolean;
  feeSats: string;
  feeBtc: string;
  vsize: number;
  /** Satoshis per virtual byte, one decimal. */
  feeRateSatVb: string;
  inputCount: number;
  outputCount: number;
  /** The first 20. A coinbase input has no address or value. */
  inputs: { address: string | null; valueSats: string | null }[];
  /** The first 20. OP_RETURN and non-standard outputs have no address. */
  outputs: {
    address: string | null;
    valueSats: string;
    kind: "address" | "op_return" | "other";
  }[];
  totalOutSats: string;
  totalOutBtc: string;
};

export type BitcoinActivityItem = {
  txid: string;
  state: "confirmed" | "unconfirmed";
  blockHeight: number | null;
  blockTime: string | null;
  /** Paid to this address by the transaction's outputs. */
  receivedSats: string;
  /** Spent from this address by the transaction's inputs. */
  sentSats: string;
  /** receivedSats minus sentSats; negative when the address paid. */
  netSats: string;
  netBtc: string;
  /** The whole transaction's fee, paid by its inputs. */
  feeSats: string;
  seenBy: CryptoProviderId[];
  agreement: ActivityAgreement;
  /** Only on conflict: each provider's view of the state. */
  observations?: {
    provider: CryptoProviderId;
    state: "confirmed" | "unconfirmed";
    blockHeight: number | null;
  }[];
};
export type BitcoinActivity = {
  chain: "bitcoin";
  items: BitcoinActivityItem[];
  history: { shown: number; complete: boolean };
};

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: readonly number[]) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) check ^= generator[bit];
  }
  return check;
}

function fiveToEight(data: readonly number[]): number[] | null {
  let accumulator = 0,
    bits = 0;
  const out: number[] = [];
  for (const value of data) {
    accumulator = ((accumulator << 5) | value) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0 ? null : out;
}

/** BIP-173 and BIP-350: version 0 with a 20- or 32-byte program (P2WPKH,
 * P2WSH), version 1 with 32 bytes (P2TR). Lowercase, or null. */
function segwitAddress(value: string): string | null {
  if (value.length < 14 || value.length > 74) return null;
  const lower = value.toLowerCase();
  if (value !== lower && value !== value.toUpperCase()) return null;
  if (!lower.startsWith("bc1")) return null;
  const data = [...lower.slice(3)].map((char) => BECH32.indexOf(char));
  if (data.length < 7 || data.some((digit) => digit < 0)) return null;
  // The human-readable part "bc", expanded for the checksum.
  const check = polymod([3, 3, 0, 2, 3, ...data]);
  const version = data[0];
  if (check !== (version === 0 ? 1 : BECH32M_CONST)) return null;
  const program = fiveToEight(data.slice(1, -6));
  if (!program) return null;
  if (version === 0 && (program.length === 20 || program.length === 32)) return lower;
  if (version === 1 && program.length === 32) return lower;
  return null;
}

function base58Payload(value: string): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value);
  } catch {
    return null;
  }
  if (bytes.length < 5) return null;
  const payload = bytes.slice(0, -4);
  const checksum = sha256(sha256(payload, "bytes"), "bytes");
  for (let index = 0; index < 4; index++)
    if (checksum[index] !== bytes[payload.length + index]) return null;
  return payload;
}

/** Extended private key versions: xprv, yprv, zprv, Yprv, Zprv. */
const EXTENDED_PRIVATE = new Set([0x0488ade4, 0x049d7878, 0x04b2430c, 0x0295b005, 0x02aa7a99]);

/** A mainnet P2PKH, P2SH, P2WPKH, P2WSH or P2TR address. A WIF key, a BIP-38
 * key or an extended private key reads "private-key" so the reply can warn. */
export function parseBitcoinAddress(
  value: string,
): { ok: true; address: string } | { ok: false; reason: "invalid-address" | "private-key" } {
  if (typeof value !== "string" || value.length > 120)
    return { ok: false, reason: "invalid-address" };
  const text = value.trim();
  if (/^bc1/i.test(text)) {
    const address = segwitAddress(text);
    return address ? { ok: true, address } : { ok: false, reason: "invalid-address" };
  }
  const payload = /^[1-9A-HJ-NP-Za-km-z]{25,115}$/.test(text) ? base58Payload(text) : null;
  if (!payload) return { ok: false, reason: "invalid-address" };
  if (payload.length === 21 && (payload[0] === 0x00 || payload[0] === 0x05))
    return { ok: true, address: text };
  const version = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
  const privateKey =
    (payload[0] === 0x80 && (payload.length === 33 || payload.length === 34)) ||
    (payload.length === 39 && payload[0] === 0x01 && (payload[1] === 0x42 || payload[1] === 0x43)) ||
    (payload.length === 78 && EXTENDED_PRIVATE.has(version));
  return { ok: false, reason: privateKey ? "private-key" : "invalid-address" };
}

type Parsed = {
  txid: string;
  state: "confirmed" | "unconfirmed";
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: string | null;
  coinbase: boolean;
  feeSats: number;
  vsize: number;
  inputs: { address: string | null; valueSats: number | null }[];
  outputs: { address: string | null; valueSats: number; kind: "address" | "op_return" | "other" }[];
};

const integer = (value: unknown, min = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min
    ? value
    : invalid("integer");

function answerAddress(record: Record<string, unknown>): string | null {
  const value = record.scriptpubkey_address;
  if (value === undefined || value === null) return null;
  return typeof value === "string" && ANSWER_ADDRESS.test(value) ? value : invalid("address");
}

/** One Esplora transaction, checked field by field. */
function esploraTx(raw: unknown): Parsed {
  if (!isRecord(raw)) return invalid("tx");
  const txid = typeof raw.txid === "string" && TXID.test(raw.txid) ? raw.txid : invalid("txid");
  const weight = integer(raw.weight, 1);
  const fee = integer(raw.fee);
  if (!Array.isArray(raw.vin) || !raw.vin.length || !Array.isArray(raw.vout) || !raw.vout.length)
    return invalid("io");
  const coinbase = raw.vin.some(
    (input: unknown) => isRecord(input) && input.is_coinbase === true,
  );
  if (coinbase && raw.vin.length !== 1) invalid("coinbase");
  const inputs = raw.vin.map((input: unknown) => {
    if (!isRecord(input) || typeof input.is_coinbase !== "boolean") return invalid("vin");
    if (input.is_coinbase) return { address: null, valueSats: null };
    if (!isRecord(input.prevout)) return invalid("prevout");
    return { address: answerAddress(input.prevout), valueSats: integer(input.prevout.value) };
  });
  const outputs = raw.vout.map((output: unknown) => {
    if (!isRecord(output) || typeof output.scriptpubkey_type !== "string") return invalid("vout");
    const address = answerAddress(output);
    const kind: "address" | "op_return" | "other" = address
      ? "address"
      : output.scriptpubkey_type === "op_return"
        ? "op_return"
        : "other";
    return { address, valueSats: integer(output.value), kind };
  });
  const totalIn = inputs.reduce((sum, input) => sum + (input.valueSats ?? 0), 0);
  const totalOut = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  if (!coinbase && totalIn - totalOut !== fee) invalid("fee");
  const status = raw.status;
  if (!isRecord(status) || typeof status.confirmed !== "boolean") return invalid("status");
  const confirmed = status.confirmed;
  const blockHash = confirmed
    ? typeof status.block_hash === "string" && TXID.test(status.block_hash)
      ? status.block_hash
      : invalid("block hash")
    : null;
  return {
    txid,
    state: confirmed ? "confirmed" : "unconfirmed",
    blockHeight: confirmed ? integer(status.block_height) : null,
    blockHash,
    blockTime: confirmed ? isoSeconds(integer(status.block_time, 1)) : null,
    coinbase,
    feeSats: coinbase ? 0 : fee,
    vsize: Math.ceil(weight / 4),
    inputs,
    outputs,
  };
}

const btc = (sats: number | bigint) => formatUnits(BigInt(sats), 8);

function txFacts(parsed: Parsed, confirmations: number | null): BitcoinTxFacts {
  const tenths = (BigInt(parsed.feeSats) * 20n + BigInt(parsed.vsize)) / (2n * BigInt(parsed.vsize));
  const totalOut = parsed.outputs.reduce((sum, output) => sum + output.valueSats, 0);
  return {
    chain: "bitcoin",
    txid: parsed.txid,
    state: parsed.state,
    blockHeight: parsed.blockHeight,
    blockHash: parsed.blockHash,
    blockTime: parsed.blockTime,
    confirmations,
    coinbase: parsed.coinbase,
    feeSats: String(parsed.feeSats),
    feeBtc: btc(parsed.feeSats),
    vsize: parsed.vsize,
    feeRateSatVb: `${tenths / 10n}.${tenths % 10n}`,
    inputCount: parsed.inputs.length,
    outputCount: parsed.outputs.length,
    inputs: parsed.inputs.slice(0, LISTED).map((input) => ({
      address: input.address,
      valueSats: input.valueSats === null ? null : String(input.valueSats),
    })),
    outputs: parsed.outputs.slice(0, LISTED).map((output) => ({
      address: output.address,
      valueSats: String(output.valueSats),
      kind: output.kind,
    })),
    totalOutSats: String(totalOut),
    totalOutBtc: btc(totalOut),
  };
}

const voided = <T>(ctx: ReadContext, provider: EsploraProvider): Observed<T> => ({
  provider,
  ok: false,
  failure: fail(ctx, provider, { outcome: "invalid-response" }).failure,
});

async function observeTx(
  ctx: ReadContext,
  provider: EsploraProvider,
  txid: string,
): Promise<Observed<TxResult<BitcoinTxFacts>>> {
  const reply = await esplora(ctx, provider, { route: "tx", txid });
  if (!reply.ok) return { provider, ok: false, failure: reply.failure };
  if (!reply.found) return { provider, ok: true, value: { found: false } };
  try {
    const parsed = esploraTx(reply.body);
    if (parsed.txid !== txid) invalid("txid");
    if (parsed.blockHeight === null)
      return { provider, ok: true, value: { found: true, tx: txFacts(parsed, null) } };
    const tip = await esplora(ctx, provider, { route: "tip-height" });
    if (!tip.ok) return { provider, ok: false, failure: tip.failure };
    const height = tip.body as number;
    if (height < parsed.blockHeight) invalid("tip");
    return {
      provider,
      ok: true,
      value: { found: true, tx: txFacts(parsed, height - parsed.blockHeight + 1) },
    };
  } catch (error) {
    if (error instanceof CryptoEgressRefused) throw error;
    return voided(ctx, provider);
  }
}

const withoutTip = (result: TxResult<BitcoinTxFacts>) =>
  result.found ? { ...result.tx, confirmations: null } : result;

export async function readBitcoinTransaction(
  ctx: ReadContext,
  txid: string,
): Promise<TxReadBody<BitcoinTxFacts>> {
  const observed = await Promise.all(PROVIDERS.map((provider) => observeTx(ctx, provider, txid)));
  const { agreement, value, observations } = agree(
    observed,
    (a, b) => sameFacts(withoutTip(a), withoutTip(b)),
    (a, b) => {
      if (!a.found || !b.found) return a;
      const counts = [a.tx.confirmations, b.tx.confirmations].filter(
        (count): count is number => count !== null,
      );
      return { found: true, tx: { ...a.tx, confirmations: counts.length ? Math.min(...counts) : null } };
    },
  );
  const sources = sourceReports(ctx, observed, (result) => result.found);
  const notes = txReadNotes(agreement, sources, value);
  if (value?.found) {
    if (value.tx.state === "unconfirmed") notes.add("unconfirmed-can-change");
    if (value.tx.inputCount > LISTED || value.tx.outputCount > LISTED) notes.add("items-capped");
  }
  return {
    agreement,
    result: value,
    observations: observations.map(({ provider, value }) => ({ provider, result: value })),
    sources,
    notes: [...notes],
  };
}

type AddressView = { items: Omit<BitcoinActivityItem, "seenBy" | "agreement">[]; complete: boolean };

function involvement(parsed: Parsed, address: string) {
  let received = 0,
    sent = 0;
  for (const output of parsed.outputs) if (output.address === address) received += output.valueSats;
  for (const input of parsed.inputs)
    if (input.address === address) sent += input.valueSats ?? 0;
  const involved =
    parsed.outputs.some((output) => output.address === address) ||
    parsed.inputs.some((input) => input.address === address);
  return involved ? { received, sent } : null;
}

async function observeAddress(
  ctx: ReadContext,
  provider: EsploraProvider,
  address: string,
): Promise<Observed<AddressView>> {
  const reply = await esplora(ctx, provider, { route: "address-txs", address });
  if (!reply.ok) return { provider, ok: false, failure: reply.failure };
  try {
    const body = reply.body;
    if (!Array.isArray(body) || body.length > PAGE_UNCONFIRMED + PAGE_CONFIRMED) return invalid("txs");
    let unconfirmed = 0;
    const items = body.map((raw: unknown) => {
      const parsed = esploraTx(raw);
      const amounts = involvement(parsed, address) ?? invalid("unrelated transaction");
      if (parsed.state === "unconfirmed") unconfirmed++;
      return {
        txid: parsed.txid,
        state: parsed.state,
        blockHeight: parsed.blockHeight,
        blockTime: parsed.blockTime,
        receivedSats: String(amounts.received),
        sentSats: String(amounts.sent),
        netSats: String(amounts.received - amounts.sent),
        netBtc: btc(amounts.received - amounts.sent),
        feeSats: String(parsed.feeSats),
      };
    });
    if (new Set(items.map((item) => item.txid)).size !== items.length) invalid("duplicate");
    const confirmed = items.length - unconfirmed;
    return {
      provider,
      ok: true,
      value: { items, complete: unconfirmed < PAGE_UNCONFIRMED && confirmed < PAGE_CONFIRMED },
    };
  } catch (error) {
    if (error instanceof CryptoEgressRefused) throw error;
    return voided(ctx, provider);
  }
}

/** Unconfirmed first, then the highest block first. */
const newestFirst = (a: { blockHeight: number | null }, b: { blockHeight: number | null }) =>
  (b.blockHeight ?? Infinity) - (a.blockHeight ?? Infinity) || 0;

export async function readBitcoinAddress(
  ctx: ReadContext,
  address: string,
  limit: number,
): Promise<AddressReadBody<BitcoinActivity>> {
  const observed = await Promise.all(
    PROVIDERS.map((provider) => observeAddress(ctx, provider, address)),
  );
  const sources = sourceReports(ctx, observed, (view) => view.items.length > 0);
  const answered = observed.filter(
    (item): item is Extract<Observed<AddressView>, { ok: true }> => item.ok,
  );
  if (!answered.length)
    return {
      agreement: "unavailable",
      activity: null,
      sources,
      notes: [...addressReadNotes("unavailable", sources)],
    };
  const views = new Map<string, { provider: CryptoProviderId; item: AddressView["items"][number] }[]>();
  for (const { provider, value } of answered)
    for (const item of value.items) {
      const seen = views.get(item.txid);
      if (seen) seen.push({ provider, item });
      else views.set(item.txid, [{ provider, item }]);
    }
  const merged = [...views.values()]
    .map((seen): BitcoinActivityItem => {
      const seenBy = seen.map((view) => view.provider);
      if (seen.length === 1 || sameFacts(seen[0].item, seen[1].item))
        return {
          ...seen[0].item,
          seenBy,
          agreement: seen.length === 1 ? "single" : "agreed",
        };
      // The views differ while blocks propagate. The less final one is shown.
      const shown = seen.find((view) => view.item.state === "unconfirmed") ?? seen[0];
      return {
        ...shown.item,
        seenBy,
        agreement: "conflict",
        observations: seen.map(({ provider, item }) => ({
          provider,
          state: item.state,
          blockHeight: item.blockHeight,
        })),
      };
    })
    .sort(newestFirst);
  const items = merged.slice(0, limit);
  const complete = answered.every(({ value }) => value.complete) && merged.length <= limit;
  const agreement =
    answered.length === 2 && items.every((item) => item.agreement === "agreed")
      ? "agreed"
      : items.some((item) => item.agreement === "conflict")
        ? "conflict"
        : "single";
  const notes = addressReadNotes(agreement, sources);
  if (!complete) notes.add("history-partial");
  if (items.some((item) => item.state === "unconfirmed")) notes.add("unconfirmed-can-change");
  return {
    agreement,
    activity: { chain: "bitcoin", items, history: { shown: items.length, complete } },
    sources,
    notes: [...notes],
  };
}
