import { DIAGNOSIS_LIMITS, DiagnosisInputError } from "./rules";
import type {
  AgreedBlock,
  EvmCodeFact,
  EvmLogFact,
  EvmReceiptFact,
  EvmTxFact,
  Hex,
  Quantity,
} from "./types";

/** RPC views for diagnosis. Every hex string comes out lowercase.
 * A bad value throws DiagnosisInputError("input-shape"). */

type ObjectValue = Record<string, unknown>;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const INPUT_BYTES = 131_072;

const isObject = (value: unknown): value is ObjectValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isQuantity = (value: unknown): value is string =>
  typeof value === "string" && QUANTITY.test(value);
const isData = (value: unknown, bytes: number): value is string =>
  typeof value === "string" &&
  DATA.test(value) &&
  value.length <= bytes * 2 + 2;
const isAddressText = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS.test(value);
const isHashText = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const lower = <T extends string>(value: string) => value.toLowerCase() as T;
const optionalQuantity = (value: unknown): Quantity | null => {
  if (value === undefined || value === null) return null;
  if (!isQuantity(value)) shape("quantity");
  return lower<Quantity>(value);
};

function shape(detail: string): never {
  throw new DiagnosisInputError("input-shape", detail);
}

function normalized(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("0x"))
    return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalized(value[key])]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

export function evmBlockView(raw: unknown): AgreedBlock {
  if (
    !isObject(raw) ||
    !isQuantity(raw.number) ||
    !isHashText(raw.hash) ||
    !isHashText(raw.stateRoot) ||
    !isHashText(raw.parentHash) ||
    !isQuantity(raw.timestamp) ||
    !(raw.transactionsRoot === undefined || isHashText(raw.transactionsRoot)) ||
    !(raw.receiptsRoot === undefined || isHashText(raw.receiptsRoot)) ||
    !(raw.gasLimit === undefined || isQuantity(raw.gasLimit)) ||
    !(raw.gasUsed === undefined || isQuantity(raw.gasUsed)) ||
    !(raw.baseFeePerGas === undefined || isQuantity(raw.baseFeePerGas))
  )
    shape("block");
  return {
    number: lower(raw.number),
    hash: lower(raw.hash),
    timestamp: lower(raw.timestamp),
    baseFeePerGas: optionalQuantity(raw.baseFeePerGas),
  };
}

export type EvmTxView = {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: Quantity;
  input: Hex;
  nonce: Quantity;
  blockHash: Hex | null;
  blockNumber: Quantity | null;
  transactionIndex: Quantity | null;
  gas: Quantity;
  type: Quantity | null;
  gasPrice: Quantity | null;
  maxFeePerGas: Quantity | null;
  maxPriorityFeePerGas: Quantity | null;
  chainId: Quantity | null;
};

export function evmTxView(raw: unknown): EvmTxView {
  if (
    !isObject(raw) ||
    !isHashText(raw.hash) ||
    !isAddressText(raw.from) ||
    !(raw.to === null || raw.to === undefined || isAddressText(raw.to)) ||
    !isQuantity(raw.value) ||
    !isQuantity(raw.nonce) ||
    !isQuantity(raw.gas) ||
    !isData(raw.input, INPUT_BYTES) ||
    !(raw.blockHash === null || isHashText(raw.blockHash)) ||
    !(raw.blockNumber === null || isQuantity(raw.blockNumber)) ||
    !(raw.transactionIndex === null || isQuantity(raw.transactionIndex))
  )
    shape("transaction");
  return {
    hash: lower(raw.hash),
    from: lower(raw.from),
    to: typeof raw.to === "string" ? lower<Hex>(raw.to) : null,
    value: lower(raw.value),
    input: lower(raw.input),
    nonce: lower(raw.nonce),
    blockHash: raw.blockHash === null ? null : lower<Hex>(raw.blockHash),
    blockNumber:
      raw.blockNumber === null ? null : lower<Quantity>(raw.blockNumber),
    transactionIndex:
      raw.transactionIndex === null
        ? null
        : lower<Quantity>(raw.transactionIndex),
    gas: lower(raw.gas),
    type: optionalQuantity(raw.type),
    gasPrice: optionalQuantity(raw.gasPrice),
    maxFeePerGas: optionalQuantity(raw.maxFeePerGas),
    maxPriorityFeePerGas: optionalQuantity(raw.maxPriorityFeePerGas),
    chainId: optionalQuantity(raw.chainId),
  };
}

export type EvmLogView = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: Quantity;
  transactionHash: Hex;
  transactionIndex: Quantity;
  blockHash: Hex;
  blockNumber: Quantity;
  removed: false;
};

export function evmLogView(raw: unknown): EvmLogView {
  if (
    !isObject(raw) ||
    !isAddressText(raw.address) ||
    !Array.isArray(raw.topics) ||
    raw.topics.length > 4 ||
    !raw.topics.every(isHashText) ||
    !isData(raw.data, INPUT_BYTES) ||
    !isQuantity(raw.logIndex) ||
    !isQuantity(raw.transactionIndex) ||
    !isHashText(raw.blockHash) ||
    !isHashText(raw.transactionHash) ||
    !isQuantity(raw.blockNumber) ||
    !(raw.removed === undefined || typeof raw.removed === "boolean")
  )
    shape("log");
  if (raw.removed === true)
    throw new DiagnosisInputError("input-agreement", "removed log");
  return {
    address: lower(raw.address),
    topics: (raw.topics as string[]).map((topic) => lower<Hex>(topic)),
    data: lower(raw.data),
    logIndex: lower(raw.logIndex),
    transactionHash: lower(raw.transactionHash),
    transactionIndex: lower(raw.transactionIndex),
    blockHash: lower(raw.blockHash),
    blockNumber: lower(raw.blockNumber),
    removed: false,
  };
}

/** Keeps logs in order while there are at most 256 and the running size
 * (32 bytes per topic plus data bytes) stays within 131,072. A log with more
 * than 16,384 data bytes is kept with its first 16,384 bytes and counts as
 * truncated. Deterministic, so both providers' capped views compare equal. */
export function capEvmLogs<T extends { topics: readonly string[]; data: Hex }>(
  logs: readonly T[],
): { logs: T[]; logsTotal: number; logsTruncated: boolean } {
  const kept: T[] = [];
  let truncated = false;
  let running = 0;
  for (const log of logs) {
    if (kept.length >= DIAGNOSIS_LIMITS.logs) {
      truncated = true;
      break;
    }
    let data = log.data;
    const bytes = (data.length - 2) / 2;
    if (bytes > DIAGNOSIS_LIMITS.logDataBytes) {
      data = data.slice(0, 2 + DIAGNOSIS_LIMITS.logDataBytes * 2) as Hex;
      truncated = true;
    }
    running += log.topics.length * 32 + (data.length - 2) / 2;
    if (running > DIAGNOSIS_LIMITS.logBytes) {
      truncated = true;
      break;
    }
    kept.push(data === log.data ? log : { ...log, data });
  }
  return { logs: kept, logsTotal: logs.length, logsTruncated: truncated };
}

export type EvmReceiptView = {
  transactionHash: Hex;
  from: Hex;
  to: Hex | null;
  contractAddress: Hex | null;
  status: "0x0" | "0x1";
  blockHash: Hex;
  blockNumber: Quantity;
  transactionIndex: Quantity;
  gasUsed: Quantity;
  cumulativeGasUsed: Quantity | null;
  effectiveGasPrice: Quantity | null;
  type: Quantity | null;
  logs: EvmLogView[];
  logsTotal: number;
  logsTruncated: boolean;
};

/** No log-count failure: logs are capped instead. */
export function evmReceiptView(raw: unknown): EvmReceiptView {
  if (
    !isObject(raw) ||
    !isHashText(raw.transactionHash) ||
    !isAddressText(raw.from) ||
    !(raw.to === null || raw.to === undefined || isAddressText(raw.to)) ||
    !(
      raw.contractAddress === null ||
      raw.contractAddress === undefined ||
      isAddressText(raw.contractAddress)
    ) ||
    !(raw.status === "0x0" || raw.status === "0x1") ||
    !isHashText(raw.blockHash) ||
    !isQuantity(raw.blockNumber) ||
    !isQuantity(raw.transactionIndex) ||
    !isQuantity(raw.gasUsed) ||
    !Array.isArray(raw.logs)
  )
    shape("receipt");
  const capped = capEvmLogs(raw.logs.map(evmLogView));
  return {
    transactionHash: lower(raw.transactionHash),
    from: lower(raw.from),
    to: typeof raw.to === "string" ? lower<Hex>(raw.to) : null,
    contractAddress:
      typeof raw.contractAddress === "string"
        ? lower<Hex>(raw.contractAddress)
        : null,
    status: raw.status,
    blockHash: lower(raw.blockHash),
    blockNumber: lower(raw.blockNumber),
    transactionIndex: lower(raw.transactionIndex),
    gasUsed: lower(raw.gasUsed),
    cumulativeGasUsed: optionalQuantity(raw.cumulativeGasUsed),
    effectiveGasPrice: optionalQuantity(raw.effectiveGasPrice),
    type: optionalQuantity(raw.type),
    ...capped,
  };
}

/** Compares two providers' views. Verdict fields must be equal. Display
 * fields must be equal when both sides have them; a field only one side has
 * becomes null and is listed in `dropped`. */
export function agreeViews<T extends object>(
  a: T,
  b: T,
  verdictFields: readonly (keyof T & string)[],
  displayFields: readonly (keyof T & string)[],
): { view: T; dropped: string[] } {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const field of verdictFields)
    if (!equal(left[field] ?? null, right[field] ?? null))
      throw new DiagnosisInputError("input-agreement", field);
  const view: Record<string, unknown> = { ...left };
  const dropped: string[] = [];
  for (const field of displayFields) {
    const x = left[field] ?? null;
    const y = right[field] ?? null;
    if (x !== null && y !== null) {
      if (!equal(x, y)) throw new DiagnosisInputError("input-agreement", field);
    } else if (x !== null || y !== null) {
      view[field] = null;
      dropped.push(field);
    }
  }
  return { view: view as T, dropped };
}

export function evmTxFact(view: EvmTxView): EvmTxFact {
  const inputBytes = (view.input.length - 2) / 2;
  return {
    hash: view.hash,
    from: view.from,
    to: view.to,
    nonce: view.nonce,
    value: view.value,
    inputSelector: inputBytes >= 4 ? (view.input.slice(0, 10) as Hex) : null,
    inputBytes,
    gas: view.gas,
    type: view.type,
    gasPrice: view.gasPrice,
    maxFeePerGas: view.maxFeePerGas,
    maxPriorityFeePerGas: view.maxPriorityFeePerGas,
    blockHash: view.blockHash,
    blockNumber: view.blockNumber,
    transactionIndex: view.transactionIndex,
  };
}

export function evmReceiptFact(view: EvmReceiptView): EvmReceiptFact {
  const logs: EvmLogFact[] = view.logs.map((log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    logIndex: log.logIndex,
  }));
  return {
    transactionHash: view.transactionHash,
    from: view.from,
    to: view.to,
    contractAddress: view.contractAddress,
    status: view.status,
    blockHash: view.blockHash,
    blockNumber: view.blockNumber,
    transactionIndex: view.transactionIndex,
    gasUsed: view.gasUsed,
    cumulativeGasUsed: view.cumulativeGasUsed ?? view.gasUsed,
    effectiveGasPrice: view.effectiveGasPrice,
    logs,
    logsTotal: view.logsTotal,
    logsTruncated: view.logsTruncated,
  };
}

/** "0x" is no code; 0xef0100 followed by 20 bytes is an EIP-7702 delegation;
 * anything else is a contract. */
export function codeKind(code: string): Pick<EvmCodeFact, "kind" | "delegate"> {
  if (!isData(code, 24_576 * 2)) shape("code");
  const text = code.toLowerCase();
  if (text === "0x") return { kind: "none", delegate: null };
  if (/^0xef0100[0-9a-f]{40}$/.test(text))
    return { kind: "delegated", delegate: `0x${text.slice(8)}` as Hex };
  return { kind: "contract", delegate: null };
}
