import { isSolanaAddress } from "../solana";
import { DIAGNOSIS_LIMITS, DiagnosisInputError } from "./rules";
import type {
  ProviderRole,
  SolanaCommitment,
  SolanaInstructionFact,
  SolanaStatusFact,
  SolanaTokenBalanceFact,
  SolanaTxError,
  SolanaTxFact,
} from "./types";

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const NAME = /^[A-Za-z]{1,64}$/;
const COMMITMENTS: readonly SolanaCommitment[] = [
  "processed",
  "confirmed",
  "finalized",
];
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TYPE = /^[A-Za-z0-9]{1,48}$/;
const DIGITS = /^\d{1,20}$/;
const INFO_KEYS = [
  "source",
  "destination",
  "authority",
  "owner",
  "delegate",
  "mint",
  "amount",
  "lamports",
] as const;

function shape(detail: string): never {
  throw new DiagnosisInputError("input-shape", detail);
}
const isIndex = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;

function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : isObject(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sorted(item[key])]),
          )
        : item;
  try {
    return JSON.stringify(sorted(value)) ?? "null";
  } catch {
    return "unreadable";
  }
}

/** meta.err or a status err, as the engine's error shape. */
export function solanaTxError(raw: unknown): SolanaTxError {
  if (typeof raw === "string" && NAME.test(raw))
    return { kind: "transaction", name: raw };
  if (isObject(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 1 && keys[0] === "InstructionError") {
      const pair = raw.InstructionError;
      if (Array.isArray(pair) && pair.length === 2 && isIndex(pair[0], 255)) {
        const [index, error] = pair as [number, unknown];
        if (typeof error === "string" && NAME.test(error))
          return {
            kind: "instruction",
            index,
            error: { kind: "builtin", name: error },
          };
        if (isObject(error)) {
          const names = Object.keys(error);
          if (names.length === 1 && names[0] === "Custom") {
            if (isIndex(error.Custom, 0xffffffff))
              return {
                kind: "instruction",
                index,
                error: { kind: "custom", code: error.Custom },
              };
          } else if (names.length === 1 && NAME.test(names[0]))
            return {
              kind: "instruction",
              index,
              error: { kind: "builtin", name: names[0] },
            };
        }
      }
    }
    if (keys.length === 1 && keys[0] === "InsufficientFundsForRent") {
      const detail = raw.InsufficientFundsForRent;
      if (isObject(detail) && isIndex(detail.account_index, 255))
        return {
          kind: "insufficient-funds-for-rent",
          accountIndex: detail.account_index,
        };
    }
  }
  return { kind: "unknown", raw: canonical(raw).slice(0, 200) };
}

export type SolanaStatusView = {
  slot: number;
  commitment: SolanaCommitment;
  err: SolanaTxError | null;
} | null;

/** One getSignatureStatuses value entry. */
export function solanaStatusView(raw: unknown): SolanaStatusView {
  if (raw === null) return null;
  if (
    !isObject(raw) ||
    !isIndex(raw.slot, Number.MAX_SAFE_INTEGER) ||
    !COMMITMENTS.includes(raw.confirmationStatus as SolanaCommitment)
  )
    shape("signature status");
  return {
    slot: raw.slot,
    commitment: raw.confirmationStatus as SolanaCommitment,
    err:
      raw.err === null || raw.err === undefined ? null : solanaTxError(raw.err),
  };
}

const rank = (commitment: SolanaCommitment) => COMMITMENTS.indexOf(commitment);

/** Both null: agreed not found. Both confirmed or finalized with the same
 * slot and error: agreed, at the lower commitment. Anything processed, or
 * only one provider: seen. Two sightings with different slots or errors
 * contradict each other and throw. */
export function agreeSolanaStatus(
  primary: SolanaStatusView,
  confirmation: SolanaStatusView,
): SolanaStatusFact {
  if (!primary && !confirmation) return { kind: "agreed", found: false };
  if (primary && confirmation) {
    if (
      primary.slot !== confirmation.slot ||
      canonical(primary.err) !== canonical(confirmation.err)
    )
      throw new DiagnosisInputError("input-agreement", "status");
    const lowest =
      rank(primary.commitment) <= rank(confirmation.commitment)
        ? primary.commitment
        : confirmation.commitment;
    if (lowest !== "processed")
      return {
        kind: "agreed",
        found: true,
        slot: primary.slot,
        commitment: lowest,
        err: primary.err,
      };
    return {
      kind: "seen",
      by: ["primary", "confirmation"],
      slot: primary.slot,
      commitment: "processed",
      err: primary.err,
    };
  }
  const one = (primary ?? confirmation)!;
  const by: ProviderRole[] = primary ? ["primary"] : ["confirmation"];
  return {
    kind: "seen",
    by,
    slot: one.slot,
    commitment: "processed",
    err: one.err,
  };
}

const address = (value: unknown): string => {
  if (!isSolanaAddress(value)) shape("solana address");
  return value;
};

function lamports(value: unknown): { text: string; exact: boolean } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    shape("lamports");
  return Number.isSafeInteger(value)
    ? { text: String(value), exact: true }
    : { text: "0", exact: false };
}

function instructionView(raw: unknown): SolanaInstructionFact {
  if (!isObject(raw)) shape("instruction");
  const programId = address(raw.programId);
  const program =
    typeof raw.program === "string" && /^[a-z0-9-]{1,48}$/.test(raw.program)
      ? raw.program
      : null;
  let type: string | null = null;
  let info: SolanaInstructionFact["info"] = null;
  if (isObject(raw.parsed)) {
    if (typeof raw.parsed.type === "string" && TYPE.test(raw.parsed.type))
      type = raw.parsed.type;
    const source = raw.parsed.info;
    if (isObject(source)) {
      const picked: Record<string, string> = {};
      for (const key of INFO_KEYS) {
        let value: unknown = source[key];
        if (key === "amount" && value === undefined) {
          const tokenAmount = source.tokenAmount;
          if (isObject(tokenAmount)) value = tokenAmount.amount;
        }
        if (value === undefined) continue;
        if (key === "amount" || key === "lamports") {
          if (typeof value === "number" && Number.isSafeInteger(value))
            value = String(value);
          if (typeof value === "string" && DIGITS.test(value))
            picked[key] = value;
        } else if (isSolanaAddress(value)) picked[key] = value;
      }
      info = picked;
    }
  }
  const data =
    typeof raw.data === "string" &&
    raw.data.length <= 1_700 &&
    (raw.data === "" || BASE58.test(raw.data))
      ? raw.data
      : null;
  return { programId, program, type, info, data };
}

function tokenBalances(
  raw: unknown,
  accounts: number,
): SolanaTokenBalanceFact[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) shape("token balances");
  if (raw.length > DIAGNOSIS_LIMITS.solanaTokenBalances)
    throw new DiagnosisInputError("input-limits", "token balances");
  return raw.map((item: unknown) => {
    if (!isObject(item) || !isIndex(item.accountIndex, accounts - 1))
      shape("token balance");
    const amount = isObject(item.uiTokenAmount) ? item.uiTokenAmount : null;
    if (
      !amount ||
      typeof amount.amount !== "string" ||
      !DIGITS.test(amount.amount) ||
      !isIndex(amount.decimals, 255)
    )
      shape("token amount");
    return {
      accountIndex: item.accountIndex,
      mint: address(item.mint),
      owner:
        item.owner === undefined || item.owner === null
          ? null
          : address(item.owner),
      programId:
        item.programId === undefined || item.programId === null
          ? null
          : address(item.programId),
      amount: amount.amount,
      decimals: amount.decimals,
    };
  });
}

/** One getTransaction(sig, {encoding: "jsonParsed",
 * maxSupportedTransactionVersion: 0}) result, as the engine's fact. */
export function solanaTransactionView(
  raw: unknown,
  commitment: "confirmed" | "finalized",
): SolanaTxFact {
  if (!isObject(raw) || !isObject(raw.meta) || !isObject(raw.transaction))
    shape("transaction");
  const meta = raw.meta;
  const message = raw.transaction.message;
  if (!isObject(message)) shape("message");
  if (!isIndex(raw.slot, Number.MAX_SAFE_INTEGER)) shape("slot");
  const blockTime =
    raw.blockTime === null || raw.blockTime === undefined
      ? null
      : isIndex(raw.blockTime, Number.MAX_SAFE_INTEGER)
        ? raw.blockTime
        : shape("block time");
  const version =
    raw.version === undefined || raw.version === "legacy"
      ? ("legacy" as const)
      : raw.version === 0
        ? (0 as const)
        : shape("version");
  if (!Array.isArray(message.accountKeys)) shape("account keys");
  if (message.accountKeys.length > DIAGNOSIS_LIMITS.solanaAccounts)
    throw new DiagnosisInputError("input-limits", "accounts");
  const accountKeys = message.accountKeys.map((key: unknown) => {
    if (
      !isObject(key) ||
      typeof key.signer !== "boolean" ||
      typeof key.writable !== "boolean"
    )
      shape("account key");
    const source: "transaction" | "lookupTable" =
      key.source === "lookupTable" ? "lookupTable" : "transaction";
    return {
      pubkey: address(key.pubkey),
      signer: key.signer,
      writable: key.writable,
      source,
    };
  });
  if (!Array.isArray(message.instructions)) shape("instructions");
  if (message.instructions.length > DIAGNOSIS_LIMITS.solanaInstructions)
    throw new DiagnosisInputError("input-limits", "instructions");
  const innerProgramIds: string[] = [];
  if (Array.isArray(meta.innerInstructions))
    for (const group of meta.innerInstructions) {
      if (!isObject(group) || !Array.isArray(group.instructions))
        shape("inner instructions");
      for (const inner of group.instructions) {
        if (!isObject(inner)) shape("inner instruction");
        const id = address(inner.programId);
        if (
          !innerProgramIds.includes(id) &&
          innerProgramIds.length < DIAGNOSIS_LIMITS.solanaInnerPrograms
        )
          innerProgramIds.push(id);
      }
    }
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== accountKeys.length ||
    meta.postBalances.length !== accountKeys.length
  )
    shape("balances");
  const pre = meta.preBalances.map(lamports);
  const post = meta.postBalances.map(lamports);
  const fee = lamports(meta.fee);
  if (!fee.exact) shape("fee");
  const lines = meta.logMessages;
  if (!(lines === null || lines === undefined || Array.isArray(lines)))
    shape("log messages");
  const logs = (lines ?? []).map((line: unknown) => {
    if (typeof line !== "string") shape("log line");
    return line;
  });
  const logMessages = logs
    .slice(0, DIAGNOSIS_LIMITS.solanaLogLines)
    .map((line) => line.slice(0, DIAGNOSIS_LIMITS.solanaLogLineChars));
  const logsTruncated =
    logs.length > DIAGNOSIS_LIMITS.solanaLogLines ||
    logs.some(
      (line) =>
        line.length > DIAGNOSIS_LIMITS.solanaLogLineChars ||
        line === "Log truncated",
    );
  if (
    typeof message.recentBlockhash !== "string" ||
    !isSolanaAddress(message.recentBlockhash)
  )
    shape("blockhash");
  const units = meta.computeUnitsConsumed;
  return {
    slot: raw.slot,
    blockTime,
    version,
    commitment,
    err:
      meta.err === null || meta.err === undefined
        ? null
        : solanaTxError(meta.err),
    fee: fee.text,
    computeUnitsConsumed:
      units === null || units === undefined
        ? null
        : isIndex(units, Number.MAX_SAFE_INTEGER)
          ? units
          : shape("compute units"),
    accountKeys,
    recentBlockhash: message.recentBlockhash,
    instructions: message.instructions.map(instructionView),
    innerProgramIds,
    balances: {
      exact:
        pre.every((item) => item.exact) && post.every((item) => item.exact),
      pre: pre.map((item) => item.text),
      post: post.map((item) => item.text),
    },
    preTokenBalances: tokenBalances(meta.preTokenBalances, accountKeys.length),
    postTokenBalances: tokenBalances(
      meta.postTokenBalances,
      accountKeys.length,
    ),
    logMessages,
    logsTruncated,
  };
}
