import { base58Decode } from "../solana";
import { SOLANA_PROGRAMS } from "./known-addresses";
import type { FailureReason, SolanaInstructionFact } from "./types";

/** SPL Token and Token-2022 custom codes, from `TokenError` in
 * solana-program-library token/program/src/error.rs (tag token-v4.0.0).
 * Token-2022 keeps the same numbering for these codes. */
export const SPL_TOKEN_ERRORS: Readonly<
  Record<number, { name: string; reason: FailureReason }>
> = {
  0: { name: "NotRentExempt", reason: "rent" },
  1: { name: "InsufficientFunds", reason: "balance" },
  2: { name: "InvalidMint", reason: "other" },
  3: { name: "MintMismatch", reason: "other" },
  4: { name: "OwnerMismatch", reason: "unauthorized" },
  17: { name: "AccountFrozen", reason: "paused" },
  18: { name: "MintDecimalsMismatch", reason: "other" },
};
/** System program custom codes (`SystemError`). */
export const SYSTEM_ERRORS: Readonly<
  Record<number, { name: string; reason: FailureReason }>
> = {
  0: { name: "AccountAlreadyInUse", reason: "other" },
  1: { name: "ResultWithNegativeLamports", reason: "balance" },
};
/** Jupiter Aggregator v6. Other codes come from its Anchor log line. */
export const JUPITER_ERRORS: Readonly<
  Record<number, { name: string; reason: FailureReason }>
> = {
  6001: { name: "SlippageToleranceExceeded", reason: "slippage" },
};

/** Extra Anchor name patterns, checked after ERROR_NAME_PATTERNS. */
export const ANCHOR_NAME_PATTERNS: readonly [RegExp, FailureReason][] = [
  [/frozen|disabled/i, "paused"],
  [/constraint(has|owner|signer)|invalid(owner|authority)/i, "unauthorized"],
];

/** Runtime instruction errors (InstructionError with a name). */
export function builtinInstructionReason(
  name: string,
  computeExceeded: boolean,
): FailureReason {
  if (name === "InsufficientFunds") return "balance";
  if (name === "ComputationalBudgetExceeded") return "compute";
  if (name === "ProgramFailedToComplete" && computeExceeded) return "compute";
  if (name === "MissingRequiredSignature") return "signature";
  return "other";
}

/** Transaction-level errors. */
export function transactionErrorReason(name: string): FailureReason {
  if (name === "InsufficientFundsForFee") return "fee-balance";
  if (name === "InsufficientFundsForRent") return "rent";
  return "other";
}

/** The custom-code table for a program, or null. */
export function programErrorTable(
  programId: string,
): Readonly<Record<number, { name: string; reason: FailureReason }>> | null {
  if (
    programId === SOLANA_PROGRAMS.splToken ||
    programId === SOLANA_PROGRAMS.token2022
  )
    return SPL_TOKEN_ERRORS;
  if (programId === SOLANA_PROGRAMS.system) return SYSTEM_ERRORS;
  if (programId === SOLANA_PROGRAMS.jupiterV6) return JUPITER_ERRORS;
  return null;
}

export type ProgramFailure = {
  programId: string;
  line: number;
  custom: number | null;
};
export type AnchorFailure = {
  programId: string | null;
  line: number;
  name: string;
  code: number;
  message: string;
};
export type ProgramText = {
  programId: string | null;
  line: number;
  text: string;
};
export type ProgramLogs = {
  /** In log order; the first entry is the innermost failing program. */
  failures: ProgramFailure[];
  anchor: AnchorFailure[];
  texts: ProgramText[];
  computeExceeded: boolean;
  invoked: string[];
};

const ID = "([1-9A-HJ-NP-Za-km-z]{32,44})";
const INVOKE = new RegExp(`^Program ${ID} invoke \\[\\d{1,3}\\]$`);
const SUCCESS = new RegExp(`^Program ${ID} success$`);
const FAILED = new RegExp(`^Program ${ID} failed: (.*)$`);
const CUSTOM = /custom program error: 0x([0-9a-fA-F]{1,8})\b/;
const ANCHOR =
  /^Program log: AnchorError (?:thrown in \S+|occurred|caused by account: \w+)\. Error Code: (\w{1,64})\. Error Number: (\d{1,10})\. Error Message: (.{1,200}?)\.?$/;
const COMPUTE = /exceeded CUs meter|exceeded maximum compute/;
const PROGRAM_ERROR_TEXT = /^Program log: Error: (.{1,200})/;

/** Reads program logs with an invoke stack. Anchor errors and "Error:" texts
 * attach to the program on top of the stack. */
export function parseProgramLogs(lines: readonly string[]): ProgramLogs {
  const stack: string[] = [];
  const out: ProgramLogs = {
    failures: [],
    anchor: [],
    texts: [],
    computeExceeded: false,
    invoked: [],
  };
  lines.forEach((line, index) => {
    if (COMPUTE.test(line)) out.computeExceeded = true;
    let match = INVOKE.exec(line);
    if (match) {
      stack.push(match[1]);
      if (!out.invoked.includes(match[1])) out.invoked.push(match[1]);
      return;
    }
    match = SUCCESS.exec(line);
    if (match) {
      if (stack[stack.length - 1] === match[1]) stack.pop();
      return;
    }
    match = FAILED.exec(line);
    if (match) {
      const custom = CUSTOM.exec(match[2]);
      out.failures.push({
        programId: match[1],
        line: index,
        custom: custom ? parseInt(custom[1], 16) : null,
      });
      if (stack[stack.length - 1] === match[1]) stack.pop();
      return;
    }
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    match = ANCHOR.exec(line);
    if (match) {
      out.anchor.push({
        programId: top,
        line: index,
        name: match[1],
        code: Number(match[2]),
        message: match[3],
      });
      return;
    }
    match = PROGRAM_ERROR_TEXT.exec(line);
    if (match) out.texts.push({ programId: top, line: index, text: match[1] });
  });
  return out;
}

export type ComputeBudget = {
  limit: number | null;
  limitIndex: number | null;
  price: bigint | null;
  priceIndex: number | null;
};

/** SetComputeUnitLimit (first byte 2, u32 little-endian) and
 * SetComputeUnitPrice (first byte 3, u64 little-endian, micro-lamports per
 * unit), as laid out in @solana/web3.js COMPUTE_BUDGET_INSTRUCTION_LAYOUTS. */
export function decodeComputeBudget(
  instructions: readonly SolanaInstructionFact[],
): ComputeBudget {
  const out: ComputeBudget = {
    limit: null,
    limitIndex: null,
    price: null,
    priceIndex: null,
  };
  instructions.forEach((instruction, index) => {
    if (
      instruction.programId !== SOLANA_PROGRAMS.computeBudget ||
      !instruction.data
    )
      return;
    let bytes: Uint8Array;
    try {
      bytes = base58Decode(instruction.data);
    } catch {
      return;
    }
    if (bytes[0] === 2 && bytes.length === 5) {
      out.limit =
        bytes[1] + bytes[2] * 0x100 + bytes[3] * 0x10000 + bytes[4] * 0x1000000;
      out.limitIndex = index;
    } else if (bytes[0] === 3 && bytes.length === 9) {
      let price = 0n;
      for (let byte = 8; byte >= 1; byte--)
        price = (price << 8n) + BigInt(bytes[byte]);
      out.price = price;
      out.priceIndex = index;
    }
  });
  return out;
}
