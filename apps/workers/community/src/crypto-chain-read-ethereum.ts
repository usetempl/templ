import { EVENT_TOPICS } from "@templ/chat/diagnosis/evm-abi";
import { knownEvmToken } from "@templ/chat/diagnosis/known-addresses";
import { formatUnits, isAddress } from "viem";
import {
  agree,
  blockscout,
  checkIdentity,
  CryptoEgressRefused,
  fail,
  invalid,
  isoSeconds,
  isRecord,
  rpc,
  sameFacts,
  sourceReports,
  type EthereumRpcProvider,
  type Observed,
  type ReadContext,
} from "./crypto-chain-read-egress";
import {
  addressReadNotes,
  txReadNotes,
  type AddressReadBody,
  type CryptoReadNote,
  type TxReadBody,
  type TxResult,
} from "./crypto-chain-read-notes";

/** Ethereum mainnet. A transaction is read from two public JSON-RPC
 * operators and must agree; address history comes from Blockscout alone,
 * because JSON-RPC has no history method. Amounts are wei or a token's raw
 * units. */

const PROVIDERS: readonly EthereumRpcProvider[] = ["publicnode", "drpc"];
/** Token transfers listed per transaction; the count is always given. */
const LISTED = 20;
/** Blockscout's first page holds up to 50 items. */
const PAGE_MAX = 100;

type Hex = `0x${string}`;

export type EthereumTokenTransfer = {
  token: Hex;
  /** From Templ's reviewed list, never from the contract. */
  label: string | null;
  from: Hex;
  to: Hex;
  amountRaw: string;
  /** Only for a reviewed token. */
  amount: string | null;
};

export type EthereumTxFacts = {
  chain: "ethereum";
  hash: Hex;
  state: "succeeded" | "failed" | "pending";
  from: Hex;
  to: Hex | null;
  contractCreated: Hex | null;
  nonce: string;
  valueWei: string;
  valueEth: string;
  /** False when the transaction failed, is pending, or sends no ETH. */
  valueMoved: boolean;
  /** gasUsed × effective gas price, plus blob gas. Paid even on failure;
   * null while pending. */
  feeWei: string | null;
  feeEth: string | null;
  gasUsed: string | null;
  blockNumber: number | null;
  blockHash: Hex | null;
  blockTime: string | null;
  /** From the provider's own tip; the lower count when two providers agree. */
  confirmations: number | null;
  /** The called function's 4-byte selector; null for a plain ETH send. */
  selector: Hex | null;
  /** ERC-20 Transfer logs, the first 20. Empty when the transaction failed. */
  tokenTransfers: EthereumTokenTransfer[];
  tokenTransferCount: number;
  otherLogCount: number;
};

export type EthereumActivityTx = {
  hash: Hex;
  state: "succeeded" | "failed" | "pending";
  blockNumber: number | null;
  time: string | null;
  from: Hex;
  to: Hex | null;
  direction: "in" | "out" | "self";
  valueWei: string;
  valueEth: string;
  valueMoved: boolean;
  /** Paid by `from`, also when the transaction failed; null while pending. */
  feeWei: string | null;
  feeEth: string | null;
};
export type EthereumActivityTransfer = EthereumTokenTransfer & {
  hash: Hex;
  logIndex: number;
  blockNumber: number | null;
  time: string | null;
  direction: "in" | "out" | "self";
};
export type EthereumActivity = {
  chain: "ethereum";
  transactions: EthereumActivityTx[];
  /** ERC-20 transfers only; NFT transfers are left out. */
  tokenTransfers: EthereumActivityTransfer[];
  history: {
    transactions: { shown: number; complete: boolean };
    tokenTransfers: { shown: number; complete: boolean };
  };
};

/** An address, checksum-checked when mixed case (EIP-55), lowercased. */
export function parseEthereumAddress(
  value: string,
): { ok: true; address: Hex } | { ok: false; reason: "invalid-address" } {
  const text = typeof value === "string" ? value.trim() : "";
  const hex = text.slice(2);
  const unchecked = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  return /^0x[0-9a-fA-F]{40}$/.test(text) && (unchecked || isAddress(text, { strict: true }))
    ? { ok: true, address: text.toLowerCase() as Hex }
    : { ok: false, reason: "invalid-address" };
}

const quantity = (raw: unknown) =>
  typeof raw === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(raw) ? BigInt(raw) : invalid("quantity");
const safe = (value: bigint) =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : invalid("number");
const address = (raw: unknown) =>
  typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw)
    ? (raw.toLowerCase() as Hex)
    : invalid("address");
const hash32 = (raw: unknown) =>
  typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw)
    ? (raw.toLowerCase() as Hex)
    : invalid("hash");
const bytes = (raw: unknown) =>
  typeof raw === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(raw)
    ? (raw.toLowerCase() as Hex)
    : invalid("data");
const absent = (raw: unknown) => raw === null || raw === undefined;
const eth = (wei: bigint) => formatUnits(wei, 18);

type RpcTx = {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: bigint;
  nonce: bigint;
  input: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  gasPrice: bigint | null;
};
function rpcTx(raw: unknown): RpcTx {
  if (!isRecord(raw)) return invalid("tx");
  const blockNumber = absent(raw.blockNumber) ? null : quantity(raw.blockNumber);
  const blockHash = absent(raw.blockHash) ? null : hash32(raw.blockHash);
  if ((blockNumber === null) !== (blockHash === null)) invalid("tx block");
  if (!absent(raw.chainId) && quantity(raw.chainId) !== 1n) invalid("chain id");
  return {
    hash: hash32(raw.hash),
    from: address(raw.from),
    to: absent(raw.to) ? null : address(raw.to),
    value: quantity(raw.value),
    nonce: quantity(raw.nonce),
    input: bytes(raw.input),
    blockNumber,
    blockHash,
    gasPrice: absent(raw.gasPrice) ? null : quantity(raw.gasPrice),
  };
}

type RpcLog = { address: Hex; topics: Hex[]; data: Hex };
type RpcReceipt = {
  hash: Hex;
  succeeded: boolean;
  from: Hex | null;
  to: Hex | null | undefined;
  contractAddress: Hex | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  blobFee: bigint;
  blockNumber: bigint;
  blockHash: Hex;
  logs: RpcLog[];
};
function rpcReceipt(raw: unknown): RpcReceipt {
  if (!isRecord(raw)) return invalid("receipt");
  const status = quantity(raw.status);
  if (status > 1n) invalid("status");
  if (!Array.isArray(raw.logs)) return invalid("logs");
  const logs = raw.logs.map((log: unknown): RpcLog => {
    if (!isRecord(log) || !Array.isArray(log.topics) || log.topics.length > 4 || log.removed === true)
      return invalid("log");
    return { address: address(log.address), topics: log.topics.map(hash32), data: bytes(log.data) };
  });
  // A reverted transaction leaves no logs.
  if (status === 0n && logs.length) invalid("failed logs");
  return {
    hash: hash32(raw.transactionHash),
    succeeded: status === 1n,
    from: absent(raw.from) ? null : address(raw.from),
    to: raw.to === undefined ? undefined : raw.to === null ? null : address(raw.to),
    contractAddress: absent(raw.contractAddress) ? null : address(raw.contractAddress),
    gasUsed: quantity(raw.gasUsed),
    effectiveGasPrice: absent(raw.effectiveGasPrice) ? null : quantity(raw.effectiveGasPrice),
    blobFee:
      absent(raw.blobGasUsed) || absent(raw.blobGasPrice)
        ? 0n
        : quantity(raw.blobGasUsed) * quantity(raw.blobGasPrice),
    blockNumber: quantity(raw.blockNumber),
    blockHash: hash32(raw.blockHash),
    logs,
  };
}

const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/;
const topicAddress = (topic: Hex) => `0x${topic.slice(26)}` as Hex;

function token(tokenAddress: Hex, raw: bigint, from: Hex, to: Hex): EthereumTokenTransfer {
  const known = knownEvmToken("eip155:1", tokenAddress);
  return {
    token: tokenAddress,
    label: known?.label ?? null,
    from,
    to,
    amountRaw: raw.toString(),
    amount: known ? formatUnits(raw, known.decimals) : null,
  };
}

function txFacts(
  tx: RpcTx,
  receipt: RpcReceipt | null,
  blockTime: bigint | null,
  tip: bigint | null,
): EthereumTxFacts {
  const transfers: EthereumTokenTransfer[] = [];
  let tokenTransferCount = 0,
    otherLogCount = 0;
  for (const log of receipt?.logs ?? []) {
    const [topic, from, to] = log.topics;
    if (
      topic === EVENT_TOPICS.transfer &&
      log.topics.length === 3 &&
      log.data.length === 66 &&
      ADDRESS_TOPIC.test(from) &&
      ADDRESS_TOPIC.test(to)
    ) {
      tokenTransferCount++;
      if (transfers.length < LISTED)
        transfers.push(token(log.address, BigInt(log.data), topicAddress(from), topicAddress(to)));
    } else otherLogCount++;
  }
  const price = receipt ? (receipt.effectiveGasPrice ?? tx.gasPrice ?? invalid("gas price")) : null;
  const fee = receipt && price !== null ? receipt.gasUsed * price + receipt.blobFee : null;
  const state = receipt ? (receipt.succeeded ? "succeeded" : "failed") : "pending";
  return {
    chain: "ethereum",
    hash: tx.hash,
    state,
    from: tx.from,
    to: tx.to,
    contractCreated: receipt?.contractAddress ?? null,
    nonce: tx.nonce.toString(),
    valueWei: tx.value.toString(),
    valueEth: eth(tx.value),
    valueMoved: state === "succeeded" && tx.value > 0n,
    feeWei: fee === null ? null : fee.toString(),
    feeEth: fee === null ? null : eth(fee),
    gasUsed: receipt ? receipt.gasUsed.toString() : null,
    blockNumber: tx.blockNumber === null ? null : safe(tx.blockNumber),
    blockHash: tx.blockHash,
    blockTime: blockTime === null ? null : isoSeconds(blockTime),
    confirmations: tip === null || tx.blockNumber === null ? null : safe(tip - tx.blockNumber + 1n),
    selector: tx.input.length >= 10 ? (tx.input.slice(0, 10) as Hex) : null,
    tokenTransfers: transfers,
    tokenTransferCount,
    otherLogCount,
  };
}

const voided = <T>(ctx: ReadContext, provider: EthereumRpcProvider): Observed<T> => ({
  provider,
  ok: false,
  failure: fail(ctx, provider, { outcome: "invalid-response" }).failure,
});

async function observeTx(
  ctx: ReadContext,
  provider: EthereumRpcProvider,
  hash: Hex,
): Promise<Observed<TxResult<EthereumTxFacts>>> {
  const [identity, txReply, receiptReply] = await Promise.all([
    checkIdentity(ctx, provider),
    rpc(ctx, provider, { method: "eth_getTransactionByHash", hash }),
    rpc(ctx, provider, { method: "eth_getTransactionReceipt", hash }),
  ]);
  if (identity || !txReply.ok || !receiptReply.ok) return voided(ctx, provider);
  try {
    const tx = txReply.result === null ? null : rpcTx(txReply.result);
    const receipt = receiptReply.result === null ? null : rpcReceipt(receiptReply.result);
    if (!tx) {
      if (receipt) invalid("receipt without transaction");
      return { provider, ok: true, value: { found: false } };
    }
    if (tx.hash !== hash) invalid("hash");
    if (!receipt) {
      if (tx.blockNumber !== null) invalid("mined without receipt");
      return { provider, ok: true, value: { found: true, tx: txFacts(tx, null, null, null) } };
    }
    if (
      receipt.hash !== hash ||
      receipt.blockHash !== tx.blockHash ||
      receipt.blockNumber !== tx.blockNumber ||
      (receipt.from !== null && receipt.from !== tx.from) ||
      (receipt.to !== undefined && receipt.to !== tx.to)
    )
      invalid("receipt");
    const [blockReply, tipReply] = await Promise.all([
      rpc(ctx, provider, { method: "eth_getBlockByHash", hash: receipt.blockHash }),
      rpc(ctx, provider, { method: "eth_blockNumber" }),
    ]);
    if (!blockReply.ok || !tipReply.ok) return voided(ctx, provider);
    const block = isRecord(blockReply.result) ? blockReply.result : invalid("block");
    if (
      hash32(block.hash) !== receipt.blockHash ||
      quantity(block.number) !== receipt.blockNumber
    )
      invalid("block");
    const tip = quantity(tipReply.result);
    if (tip < receipt.blockNumber) invalid("tip");
    return {
      provider,
      ok: true,
      value: { found: true, tx: txFacts(tx, receipt, quantity(block.timestamp), tip) },
    };
  } catch (error) {
    if (error instanceof CryptoEgressRefused) throw error;
    return voided(ctx, provider);
  }
}

const withoutTip = (result: TxResult<EthereumTxFacts>) =>
  result.found ? { ...result.tx, confirmations: null } : result;

export async function readEthereumTransaction(
  ctx: ReadContext,
  hash: Hex,
): Promise<TxReadBody<EthereumTxFacts>> {
  const observed = await Promise.all(PROVIDERS.map((provider) => observeTx(ctx, provider, hash)));
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
  if (value && !value.found) notes.add("ethereum-mainnet-only");
  if (value?.found) {
    const tx = value.tx;
    if (tx.state === "failed") notes.add("failed-fee-charged");
    if (tx.state === "pending") notes.add("pending-no-fee-yet");
    if (tx.selector !== null) notes.add("internal-transfers-not-shown");
    transferNotes(tx.tokenTransfers, notes);
    if (tx.tokenTransferCount > tx.tokenTransfers.length) notes.add("items-capped");
  }
  return {
    agreement,
    result: value,
    observations: observations.map(({ provider, value }) => ({ provider, result: value })),
    sources,
    notes: [...notes],
  };
}

function transferNotes(transfers: readonly EthereumTokenTransfer[], notes: Set<CryptoReadNote>) {
  if (transfers.some((transfer) => transfer.label === null)) notes.add("unreviewed-token");
  if (transfers.some((transfer) => transfer.amountRaw === "0")) notes.add("zero-value-token-transfer");
}

/** The first present field. Blockscout instances name some fields
 * differently between releases. */
function field(record: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (Object.hasOwn(record, name)) return record[name];
  return undefined;
}
const party = (raw: unknown) => (isRecord(raw) ? address(raw.hash) : invalid("party"));
const digits = (raw: unknown) =>
  typeof raw === "string" && /^\d{1,78}$/.test(raw) ? BigInt(raw) : invalid("digits");
const blockOf = (raw: unknown) => {
  if (absent(raw)) return null;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  return invalid("block");
};
const timeOf = (raw: unknown) => {
  if (absent(raw)) return null;
  const at = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? isoSeconds(Math.floor(at / 1000)) : invalid("time");
};
const directionOf = (from: Hex, to: Hex | null, self: Hex) =>
  from === self && to === self ? "self" : from === self ? "out" : "in";

function page(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > PAGE_MAX)
    return invalid("page");
  const next = body.next_page_params;
  if (next !== null && next !== undefined && !isRecord(next)) invalid("next page");
  return { items: body.items as unknown[], more: isRecord(next) };
}

function activityTx(raw: unknown, self: Hex): EthereumActivityTx | null {
  if (!isRecord(raw)) return invalid("transaction");
  const from = party(raw.from);
  const to = absent(raw.to) ? null : party(raw.to);
  const created = absent(raw.created_contract) ? null : party(raw.created_contract);
  if (from !== self && to !== self && created !== self) return null;
  const state =
    raw.status === "ok"
      ? "succeeded"
      : raw.status === "error"
        ? "failed"
        : absent(raw.status)
          ? "pending"
          : invalid("status");
  const blockNumber = blockOf(field(raw, "block_number", "block"));
  if (state !== "pending" && blockNumber === null) invalid("mined without block");
  const value = digits(raw.value);
  const fee =
    state !== "pending" && isRecord(raw.fee) && raw.fee.type === "actual" ? digits(raw.fee.value) : null;
  if (state !== "pending" && fee === null) invalid("fee");
  return {
    hash: hash32(raw.hash),
    state,
    blockNumber,
    time: timeOf(raw.timestamp),
    from,
    to,
    direction: directionOf(from, to, self),
    valueWei: value.toString(),
    valueEth: eth(value),
    valueMoved: state === "succeeded" && value > 0n,
    feeWei: fee === null ? null : fee.toString(),
    feeEth: fee === null ? null : eth(fee),
  };
}

/** An ERC-20 transfer involving the address, "nft" for other token
 * standards, or null when the item does not involve the address. */
function activityTransfer(raw: unknown, self: Hex): EthereumActivityTransfer | "nft" | null {
  if (!isRecord(raw) || !isRecord(raw.token)) return invalid("transfer");
  const from = party(raw.from);
  const to = party(raw.to);
  if (from !== self && to !== self) return null;
  if (raw.token.type !== "ERC-20") return "nft";
  const tokenAddress = address(field(raw.token, "address_hash", "address"));
  const total = isRecord(raw.total) ? digits(raw.total.value) : invalid("total");
  const logIndex = field(raw, "log_index");
  const index =
    typeof logIndex === "number" && Number.isSafeInteger(logIndex) && logIndex >= 0
      ? logIndex
      : typeof logIndex === "string" && /^\d{1,9}$/.test(logIndex)
        ? Number(logIndex)
        : invalid("log index");
  return {
    ...token(tokenAddress, total, from, to),
    hash: hash32(field(raw, "transaction_hash", "tx_hash")),
    logIndex: index,
    blockNumber: blockOf(field(raw, "block_number", "block")),
    time: timeOf(raw.timestamp),
    direction: directionOf(from, to, self),
  };
}

export async function readEthereumAddress(
  ctx: ReadContext,
  self: Hex,
  limit: number,
): Promise<AddressReadBody<EthereumActivity>> {
  const [txReply, transferReply] = await Promise.all([
    blockscout(ctx, "transactions", self),
    blockscout(ctx, "token-transfers", self),
  ]);
  let observed: Observed<EthereumActivity>;
  let unrelated = false;
  if (!txReply.ok && !transferReply.ok) {
    observed = { provider: "blockscout", ok: false, failure: txReply.failure };
  } else
    try {
      const txPage = txReply.ok && txReply.found ? page(txReply.body) : { items: [], more: !txReply.ok };
      const transferPage = transferReply.ok && transferReply.found ? page(transferReply.body) : { items: [], more: !transferReply.ok };
      const transactions: EthereumActivityTx[] = [];
      for (const raw of txPage.items) {
        const item = activityTx(raw, self);
        if (item) transactions.push(item);
        else unrelated = true;
      }
      const tokenTransfers: EthereumActivityTransfer[] = [];
      for (const raw of transferPage.items) {
        const item = activityTransfer(raw, self);
        if (item === null) unrelated = true;
        else if (item !== "nft") tokenTransfers.push(item);
      }
      observed = {
        provider: "blockscout",
        ok: true,
        value: {
          chain: "ethereum",
          transactions: transactions.slice(0, limit),
          tokenTransfers: tokenTransfers.slice(0, limit),
          history: {
            transactions: {
              shown: Math.min(limit, transactions.length),
              complete: !txPage.more && !unrelated && transactions.length <= limit,
            },
            tokenTransfers: {
              shown: Math.min(limit, tokenTransfers.length),
              complete: !transferPage.more && !unrelated && tokenTransfers.length <= limit,
            },
          },
        },
      };
    } catch (error) {
      if (error instanceof CryptoEgressRefused) throw error;
      observed = {
        provider: "blockscout",
        ok: false,
        failure: fail(ctx, "blockscout", { outcome: "invalid-response" }).failure,
      };
    }
  const { agreement, value } = agree([observed], sameFacts);
  const sources = sourceReports(
    ctx,
    [observed],
    (activity) => activity.transactions.length + activity.tokenTransfers.length > 0,
  );
  const notes = addressReadNotes(agreement, sources);
  notes.add("ethereum-mainnet-only");
  if (value) {
    const { history } = value;
    if (!txReply.ok) notes.add("ordinary-history-unavailable");
    if (!transferReply.ok) notes.add("token-history-unavailable");
    if (!history.transactions.complete || !history.tokenTransfers.complete) notes.add("history-partial");
    if (value.transactions.some((item) => item.state === "failed")) notes.add("failed-fee-charged");
    if (value.transactions.some((item) => item.state === "pending")) notes.add("pending-no-fee-yet");
    transferNotes(value.tokenTransfers, notes);
    notes.add("internal-transfers-not-shown");
    notes.add("free-text-omitted");
  }
  return { agreement, activity: value, sources, notes: [...notes] };
}
