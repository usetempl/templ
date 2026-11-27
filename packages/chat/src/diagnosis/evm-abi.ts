import {
  decodeAbiParameters,
  decodeErrorResult,
  decodeEventLog,
  parseAbi,
  parseAbiItem,
  type Abi,
  type AbiParameter,
} from "viem";
import { sanitizeText } from "./format";
import { PERMIT2, isKnownWeth } from "./known-addresses";
import type {
  AbiParameterFact,
  EvmAbiErrorItem,
  EvmLogFact,
  EvmNetwork,
  FailureReason,
  Hex,
} from "./types";

/** Builtin error selectors, signatures and reasons. */
export const BUILTIN_ERRORS: readonly {
  selector: Hex;
  signature: string;
  reason: FailureReason;
}[] = [
  {
    selector: "0xe450d38c",
    signature:
      "ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)",
    reason: "balance",
  },
  {
    selector: "0xfb8f41b2",
    signature:
      "ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)",
    reason: "allowance",
  },
  {
    selector: "0x96c6fd1e",
    signature: "ERC20InvalidSender(address sender)",
    reason: "other",
  },
  {
    selector: "0xec442f05",
    signature: "ERC20InvalidReceiver(address receiver)",
    reason: "other",
  },
  {
    selector: "0xe602df05",
    signature: "ERC20InvalidApprover(address approver)",
    reason: "other",
  },
  {
    selector: "0x94280d62",
    signature: "ERC20InvalidSpender(address spender)",
    reason: "other",
  },
  {
    selector: "0x5274afe7",
    signature: "SafeERC20FailedOperation(address token)",
    reason: "transfer-failed",
  },
  {
    selector: "0x79012fb2",
    signature:
      "ERC4626ExceededMaxDeposit(address receiver,uint256 assets,uint256 max)",
    reason: "vault-limit",
  },
  {
    selector: "0x284ff667",
    signature:
      "ERC4626ExceededMaxMint(address receiver,uint256 shares,uint256 max)",
    reason: "vault-limit",
  },
  {
    selector: "0xfe9cceec",
    signature:
      "ERC4626ExceededMaxWithdraw(address owner,uint256 assets,uint256 max)",
    reason: "vault-limit",
  },
  {
    selector: "0xb94abeec",
    signature:
      "ERC4626ExceededMaxRedeem(address owner,uint256 shares,uint256 max)",
    reason: "vault-limit",
  },
  {
    selector: "0xd81b2f2e",
    signature: "AllowanceExpired(uint256 deadline)",
    reason: "allowance",
  },
  {
    selector: "0xf96fb071",
    signature: "InsufficientAllowance(uint256 amount)",
    reason: "allowance",
  },
  {
    selector: "0xcd21db4f",
    signature: "SignatureExpired(uint256 signatureDeadline)",
    reason: "signature",
  },
  { selector: "0x756688fe", signature: "InvalidNonce()", reason: "signature" },
  {
    selector: "0x8baa579f",
    signature: "InvalidSignature()",
    reason: "signature",
  },
  {
    selector: "0x39d35496",
    signature: "V3TooLittleReceived()",
    reason: "slippage",
  },
  {
    selector: "0x739dbe52",
    signature: "V3TooMuchRequested()",
    reason: "slippage",
  },
  {
    selector: "0x849eaf98",
    signature: "V2TooLittleReceived()",
    reason: "slippage",
  },
  {
    selector: "0x8ab0bc16",
    signature: "V2TooMuchRequested()",
    reason: "slippage",
  },
  {
    selector: "0x8b063d73",
    signature:
      "V4TooLittleReceived(uint256 minAmountOutReceived,uint256 amountReceived)",
    reason: "slippage",
  },
  {
    selector: "0x12bacdd3",
    signature:
      "V4TooMuchRequested(uint256 maxAmountInRequested,uint256 amountRequested)",
    reason: "slippage",
  },
  { selector: "0x316cf0eb", signature: "V3InvalidSwap()", reason: "other" },
  {
    selector: "0x5bf6f916",
    signature: "TransactionDeadlinePassed()",
    reason: "deadline",
  },
  {
    selector: "0xbfb22adf",
    signature: "DeadlinePassed(uint256 deadline)",
    reason: "deadline",
  },
  {
    selector: "0x2c4029e9",
    signature: "ExecutionFailed(uint256 commandIndex,bytes message)",
    reason: "other",
  },
  { selector: "0xd93c0665", signature: "EnforcedPause()", reason: "paused" },
  {
    selector: "0x118cdaa7",
    signature: "OwnableUnauthorizedAccount(address account)",
    reason: "unauthorized",
  },
  {
    selector: "0x3ee5aeb5",
    signature: "ReentrancyGuardReentrantCall()",
    reason: "other",
  },
];
export const ERROR_STRING_SELECTOR = "0x08c379a0";
export const PANIC_SELECTOR = "0x4e487b71";
const EXECUTION_FAILED = "0x2c4029e9";
const BUILTIN_ABI = parseAbi(
  BUILTIN_ERRORS.map((item) => `error ${item.signature}`),
) as Abi;

/** Event signatures; EVENT_TOPICS holds their topics. */
export const EVENT_SIGNATURES = {
  transfer: "Transfer(address indexed from,address indexed to,uint256 value)",
  approval:
    "Approval(address indexed owner,address indexed spender,uint256 value)",
  approvalForAll:
    "ApprovalForAll(address indexed owner,address indexed operator,bool approved)",
  wethDeposit: "Deposit(address indexed dst,uint256 wad)",
  wethWithdrawal: "Withdrawal(address indexed src,uint256 wad)",
  permit2Approval:
    "Approval(address indexed owner,address indexed token,address indexed spender,uint160 amount,uint48 expiration)",
  permit2Permit:
    "Permit(address indexed owner,address indexed token,address indexed spender,uint160 amount,uint48 expiration,uint48 nonce)",
  vaultDeposit:
    "Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  vaultWithdraw:
    "Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
  swapV2:
    "Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  swapV3:
    "Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  swapV4:
    "Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
  cctpV1:
    "DepositForBurn(uint64 indexed nonce,address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller)",
  cctpV2:
    "DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)",
  acrossV3:
    "V3FundsDeposited(address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint32 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,address indexed depositor,address recipient,address exclusiveRelayer,bytes message)",
  across:
    "FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)",
  userOperation:
    "UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
  userOperationRevert:
    "UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)",
} as const;
export const EVENT_TOPICS: Readonly<
  Record<keyof typeof EVENT_SIGNATURES, Hex>
> = {
  transfer:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval:
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  approvalForAll:
    "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
  wethDeposit:
    "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
  wethWithdrawal:
    "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
  permit2Approval:
    "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b",
  permit2Permit:
    "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec",
  vaultDeposit:
    "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
  vaultWithdraw:
    "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
  swapV2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  swapV3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  swapV4: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  cctpV1: "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0",
  cctpV2: "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5",
  acrossV3:
    "0xa123dc29aebf7d0c3322c8eeb5b999e859f39937950ed31056532713d0de396f",
  across: "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3",
  userOperation:
    "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f",
  userOperationRevert:
    "0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201",
};
const BRIDGE_EVENTS = {
  cctpV1: parseAbiItem(`event ${EVENT_SIGNATURES.cctpV1}`),
  cctpV2: parseAbiItem(`event ${EVENT_SIGNATURES.cctpV2}`),
  acrossV3: parseAbiItem(`event ${EVENT_SIGNATURES.acrossV3}`),
  across: parseAbiItem(`event ${EVENT_SIGNATURES.across}`),
};

export const PANIC_CODES: Readonly<Record<string, string>> = {
  "0x00": "generic compiler panic",
  "0x01": "assert failed",
  "0x11": "arithmetic overflow or underflow",
  "0x12": "division by zero",
  "0x21": "invalid enum value",
  "0x22": "bad storage byte array",
  "0x31": "pop on an empty array",
  "0x32": "array index out of bounds",
  "0x41": "out of memory",
  "0x51": "call to an uninitialized function",
};

/** Error(string) texts, case-insensitive, first match wins. */
export const REVERT_STRING_PATTERNS: readonly [RegExp, FailureReason][] = [
  [
    /too little received|insufficient[_ ]output[_ ]amount|excessive[_ ]input[_ ]amount|too much requested|slippage|return amount is not enough/i,
    "slippage",
  ],
  [/transaction too old|\bexpired\b|deadline/i, "deadline"],
  [/insufficient allowance|exceeds allowance|allowance/i, "allowance"],
  [/exceeds balance|insufficient balance|insufficient funds/i, "balance"],
  [
    /transfer_from_failed|transferhelper|\bstf\b|transfer failed/i,
    "transfer-failed",
  ],
  [/paused/i, "paused"],
  [
    /not owner|unauthori[sz]ed|caller is not|only owner|access denied|forbidden/i,
    "unauthorized",
  ],
  [/invalid signature|signature expired|invalid permit/i, "signature"],
];

/** Custom error names from verified sources, first match wins. */
export const ERROR_NAME_PATTERNS: readonly [RegExp, FailureReason][] = [
  [
    /toolittle|insufficientoutput|slippage|minamount|minout|toomuchrequested|excessiveinput/i,
    "slippage",
  ],
  [/deadline|expired/i, "deadline"],
  [/allowance/i, "allowance"],
  [/insufficient(balance|funds)|exceedsbalance/i, "balance"],
  [/paused/i, "paused"],
  [
    /unauthori[sz]ed|notowner|onlyowner|accessdenied|forbidden|notallowed/i,
    "unauthorized",
  ],
  [/signature|nonce/i, "signature"],
];

export function classifyRevertString(text: string): FailureReason {
  for (const [pattern, reason] of REVERT_STRING_PATTERNS)
    if (pattern.test(text)) return reason;
  return "other";
}

export function classifyErrorName(
  name: string,
  extra: readonly [RegExp, FailureReason][] = [],
): FailureReason {
  for (const [pattern, reason] of [...ERROR_NAME_PATTERNS, ...extra])
    if (pattern.test(name)) return reason;
  return "other";
}

export const isUnlimitedAllowance = (value: bigint) => value >= 2n ** 255n;
export const isUnlimitedPermit2Amount = (value: bigint) => value >= 2n ** 159n;

export type DecodedArg = { name: string; type: string; value: string };
export type DecodedRevert =
  | { kind: "no-data" }
  | { kind: "error-string"; text: string; reason: FailureReason }
  | {
      kind: "panic";
      code: string;
      meaning: string | null;
      reason: FailureReason;
    }
  | {
      kind: "custom-known";
      name: string;
      args: DecodedArg[];
      reason: FailureReason;
      /** ExecutionFailed only: the failing Universal Router command. */
      commandIndex: number | null;
      inner: DecodedRevert | null;
    }
  | {
      kind: "custom-verified";
      name: string;
      args: DecodedArg[];
      reason: FailureReason;
    }
  | { kind: "unknown-selector"; selector: Hex };

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TYPE =
  /^(?:address|bool|string|bytes(?:[1-9]|[12][0-9]|3[0-2])?|u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|tuple)(?:\[(?:[1-9][0-9]{0,3})?\])*$/;

function validParameter(item: AbiParameterFact, depth: number): boolean {
  if (!(item.name === "" || NAME.test(item.name)) || !TYPE.test(item.type))
    return false;
  const isTuple = item.type.startsWith("tuple");
  if (!isTuple) return item.components === undefined;
  return (
    depth < 4 &&
    Array.isArray(item.components) &&
    item.components.length > 0 &&
    item.components.length <= 32 &&
    item.components.every((child) => validParameter(child, depth + 1))
  );
}

/** Keeps the well-formed error items of a verified ABI. */
export function validErrorItems(items: readonly EvmAbiErrorItem[]): Abi {
  return items.filter(
    (item) =>
      item.type === "error" &&
      NAME.test(item.name) &&
      item.inputs.length <= 32 &&
      item.inputs.every((input) => validParameter(input, 0)),
  ) as unknown as Abi;
}

function argValue(type: string, value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (type === "string") return sanitizeText(value, 200);
    const text = value.toLowerCase();
    return text.length > 66 ? `${text.slice(0, 66)}…` : text;
  }
  if (typeof value === "number") return String(value);
  try {
    return sanitizeText(
      JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item,
      ) ?? "",
      200,
    );
  } catch {
    return "unreadable";
  }
}

function decodeArgs(
  inputs: readonly AbiParameter[],
  args: readonly unknown[] | undefined,
): DecodedArg[] {
  return inputs.map((input, index) => ({
    name: input.name ?? "",
    type: input.type,
    value: argValue(input.type, args?.[index]),
  }));
}

/** Decodes revert data in this order: empty, Error(string), Panic(uint256),
 * builtin custom errors (ExecutionFailed is unwrapped once), verified error
 * items, else an unknown selector. */
export function decodeRevert(
  data: Hex,
  errorAbi: readonly EvmAbiErrorItem[] | null,
  unwrap = true,
): DecodedRevert {
  const hex = data.toLowerCase() as Hex;
  if (hex === "0x") return { kind: "no-data" };
  const selector = (hex.length >= 10 ? hex.slice(0, 10) : hex) as Hex;
  const body = `0x${hex.slice(10)}` as Hex;
  if (selector === ERROR_STRING_SELECTOR)
    try {
      const [text] = decodeAbiParameters([{ type: "string" }], body);
      const clean = sanitizeText(text, 200);
      return {
        kind: "error-string",
        text: clean,
        reason: classifyRevertString(clean),
      };
    } catch {
      return { kind: "unknown-selector", selector };
    }
  if (selector === PANIC_SELECTOR)
    try {
      const [value] = decodeAbiParameters([{ type: "uint256" }], body);
      const code = `0x${value.toString(16).padStart(2, "0")}`;
      return {
        kind: "panic",
        code,
        meaning: Object.prototype.hasOwnProperty.call(PANIC_CODES, code)
          ? PANIC_CODES[code]
          : null,
        reason: value === 0x11n ? "arithmetic" : "other",
      };
    } catch {
      return { kind: "unknown-selector", selector };
    }
  const builtin = BUILTIN_ERRORS.find((item) => item.selector === selector);
  if (builtin && (unwrap || selector !== EXECUTION_FAILED))
    try {
      const decoded = decodeErrorResult({ abi: BUILTIN_ABI, data: hex });
      const inputs =
        decoded.abiItem.type === "error" ? decoded.abiItem.inputs : [];
      const args = decodeArgs(inputs, decoded.args as readonly unknown[]);
      if (selector === EXECUTION_FAILED) {
        const [index, message] = decoded.args as readonly [bigint, Hex];
        const inner = decodeRevert(message, errorAbi, false);
        return {
          kind: "custom-known",
          name: decoded.errorName,
          args,
          reason: "reason" in inner ? inner.reason : "other",
          commandIndex: index <= 255n ? Number(index) : null,
          inner,
        };
      }
      return {
        kind: "custom-known",
        name: decoded.errorName,
        args,
        reason: builtin.reason,
        commandIndex: null,
        inner: null,
      };
    } catch {
      return { kind: "unknown-selector", selector };
    }
  const verified = errorAbi ? validErrorItems(errorAbi) : [];
  if (verified.length > 0)
    try {
      const decoded = decodeErrorResult({ abi: verified, data: hex });
      const inputs =
        decoded.abiItem.type === "error" ? decoded.abiItem.inputs : [];
      return {
        kind: "custom-verified",
        name: decoded.errorName,
        args: decodeArgs(inputs, decoded.args as readonly unknown[]),
        reason: classifyErrorName(decoded.errorName),
      };
    } catch {
      // Not in the verified items, or the data does not match them.
    }
  return { kind: "unknown-selector", selector };
}

export type Movement = {
  kind: "erc20" | "erc721" | "native" | "weth-in" | "weth-out";
  /** Token contract, or null for the chain's native coin. */
  token: Hex | null;
  from: Hex | null;
  to: Hex | null;
  amount: bigint;
  tokenId: bigint | null;
  /** Position in receipt.logs, or null for tx.value. */
  log: number | null;
};
export type ApprovalEvent = {
  kind: "erc20" | "permit2" | "for-all";
  token: Hex;
  owner: Hex;
  spender: Hex;
  /** Null for ApprovalForAll. */
  amount: bigint | null;
  unlimited: boolean;
  log: number;
};
export type VaultEvent = {
  kind: "deposit" | "withdraw";
  vault: Hex;
  sender: Hex;
  owner: Hex;
  receiver: Hex | null;
  assets: bigint;
  shares: bigint;
  log: number;
};
export type BridgeEvent = {
  protocol: "CCTP" | "CCTP v2" | "Across";
  contract: Hex;
  token: Hex | null;
  amount: bigint | null;
  depositor: Hex | null;
  destination:
    | { kind: "cctp-domain"; domain: number }
    | { kind: "chain"; chainId: bigint };
  log: number;
};
export type UserOpEvent = {
  hash: Hex;
  sender: Hex;
  success: boolean;
  log: number;
  logIndex: string;
};
export type UserOpRevert = { hash: Hex; sender: Hex; reason: Hex; log: number };
export type DecodedLogs = {
  movements: Movement[];
  approvals: ApprovalEvent[];
  vaults: VaultEvent[];
  swaps: number[];
  bridges: BridgeEvent[];
  userOps: UserOpEvent[];
  userOpReverts: UserOpRevert[];
};

const topicAddress = (topic: Hex) => `0x${topic.slice(26)}` as Hex;
const dataBytes = (data: Hex) => (data.length - 2) / 2;
function word(data: Hex, index: number): bigint {
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}
const addressTopic = (topic: Hex) => /^0x0{24}[0-9a-f]{40}$/.test(topic);

/** Reads the movements and events the rules use. Unknown logs are ignored,
 * and a log that does not match the exact topic count and data size of its
 * event is ignored too. */
export function decodeLogs(
  network: EvmNetwork,
  logs: readonly EvmLogFact[],
  entryPoint: Hex | null,
): DecodedLogs {
  const out: DecodedLogs = {
    movements: [],
    approvals: [],
    vaults: [],
    swaps: [],
    bridges: [],
    userOps: [],
    userOpReverts: [],
  };
  logs.forEach((log, position) => {
    const [topic0, ...rest] = log.topics;
    const bytes = dataBytes(log.data);
    const addressTopics = rest.every(addressTopic);
    switch (topic0) {
      case EVENT_TOPICS.transfer:
        if (rest.length === 2 && bytes === 32 && addressTopics)
          out.movements.push({
            kind: "erc20",
            token: log.address,
            from: topicAddress(rest[0]),
            to: topicAddress(rest[1]),
            amount: word(log.data, 0),
            tokenId: null,
            log: position,
          });
        else if (
          rest.length === 3 &&
          bytes === 0 &&
          addressTopic(rest[0]) &&
          addressTopic(rest[1])
        )
          out.movements.push({
            kind: "erc721",
            token: log.address,
            from: topicAddress(rest[0]),
            to: topicAddress(rest[1]),
            amount: 1n,
            tokenId: BigInt(rest[2]),
            log: position,
          });
        return;
      case EVENT_TOPICS.wethDeposit:
      case EVENT_TOPICS.wethWithdrawal:
        if (
          rest.length === 1 &&
          bytes === 32 &&
          addressTopics &&
          isKnownWeth(network, log.address)
        ) {
          const deposit = topic0 === EVENT_TOPICS.wethDeposit;
          out.movements.push({
            kind: deposit ? "weth-in" : "weth-out",
            token: log.address,
            from: deposit ? null : topicAddress(rest[0]),
            to: deposit ? topicAddress(rest[0]) : null,
            amount: word(log.data, 0),
            tokenId: null,
            log: position,
          });
        }
        return;
      case EVENT_TOPICS.approval:
        if (rest.length === 2 && bytes === 32 && addressTopics) {
          const amount = word(log.data, 0);
          out.approvals.push({
            kind: "erc20",
            token: log.address,
            owner: topicAddress(rest[0]),
            spender: topicAddress(rest[1]),
            amount,
            unlimited: isUnlimitedAllowance(amount),
            log: position,
          });
        }
        return;
      case EVENT_TOPICS.permit2Approval:
      case EVENT_TOPICS.permit2Permit:
        if (
          log.address === PERMIT2 &&
          rest.length === 3 &&
          addressTopics &&
          bytes === (topic0 === EVENT_TOPICS.permit2Permit ? 96 : 64)
        ) {
          const amount = word(log.data, 0);
          out.approvals.push({
            kind: "permit2",
            token: topicAddress(rest[1]),
            owner: topicAddress(rest[0]),
            spender: topicAddress(rest[2]),
            amount,
            unlimited: isUnlimitedPermit2Amount(amount),
            log: position,
          });
        }
        return;
      case EVENT_TOPICS.approvalForAll:
        if (
          rest.length === 2 &&
          bytes === 32 &&
          addressTopics &&
          word(log.data, 0) !== 0n
        )
          out.approvals.push({
            kind: "for-all",
            token: log.address,
            owner: topicAddress(rest[0]),
            spender: topicAddress(rest[1]),
            amount: null,
            unlimited: true,
            log: position,
          });
        return;
      case EVENT_TOPICS.vaultDeposit:
        if (rest.length === 2 && bytes === 64 && addressTopics)
          out.vaults.push({
            kind: "deposit",
            vault: log.address,
            sender: topicAddress(rest[0]),
            owner: topicAddress(rest[1]),
            receiver: null,
            assets: word(log.data, 0),
            shares: word(log.data, 1),
            log: position,
          });
        return;
      case EVENT_TOPICS.vaultWithdraw:
        if (rest.length === 3 && bytes === 64 && addressTopics)
          out.vaults.push({
            kind: "withdraw",
            vault: log.address,
            sender: topicAddress(rest[0]),
            receiver: topicAddress(rest[1]),
            owner: topicAddress(rest[2]),
            assets: word(log.data, 0),
            shares: word(log.data, 1),
            log: position,
          });
        return;
      case EVENT_TOPICS.swapV2:
      case EVENT_TOPICS.swapV3:
      case EVENT_TOPICS.swapV4:
        out.swaps.push(position);
        return;
      case EVENT_TOPICS.cctpV1:
      case EVENT_TOPICS.cctpV2:
      case EVENT_TOPICS.acrossV3:
      case EVENT_TOPICS.across: {
        const bridge = decodeBridge(log, position);
        if (bridge) out.bridges.push(bridge);
        return;
      }
      case EVENT_TOPICS.userOperation:
        if (
          entryPoint &&
          log.address === entryPoint &&
          rest.length === 3 &&
          bytes === 128 &&
          addressTopic(rest[1])
        )
          out.userOps.push({
            hash: rest[0],
            sender: topicAddress(rest[1]),
            success: word(log.data, 1) !== 0n,
            log: position,
            logIndex: log.logIndex,
          });
        return;
      case EVENT_TOPICS.userOperationRevert:
        if (
          entryPoint &&
          log.address === entryPoint &&
          rest.length === 2 &&
          addressTopic(rest[1])
        )
          try {
            const [, reason] = decodeAbiParameters(
              [{ type: "uint256" }, { type: "bytes" }],
              log.data,
            );
            out.userOpReverts.push({
              hash: rest[0],
              sender: topicAddress(rest[1]),
              reason: reason.toLowerCase() as Hex,
              log: position,
            });
          } catch {
            // Malformed revert reason: the operation still shows as failed.
          }
        return;
      default:
        return;
    }
  });
  return out;
}

const bytes32Address = (value: Hex) =>
  /^0x0{24}[0-9a-f]{40}$/.test(value.toLowerCase())
    ? (`0x${value.slice(26).toLowerCase()}` as Hex)
    : null;

function decodeBridge(log: EvmLogFact, position: number): BridgeEvent | null {
  const topic0 = log.topics[0];
  try {
    if (topic0 === EVENT_TOPICS.cctpV1 || topic0 === EVENT_TOPICS.cctpV2) {
      const event =
        topic0 === EVENT_TOPICS.cctpV1
          ? BRIDGE_EVENTS.cctpV1
          : BRIDGE_EVENTS.cctpV2;
      const decoded = decodeEventLog({
        abi: [event],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      const args = decoded.args as unknown as {
        burnToken: Hex;
        amount: bigint;
        depositor: Hex;
        destinationDomain: number;
      };
      return {
        protocol: topic0 === EVENT_TOPICS.cctpV1 ? "CCTP" : "CCTP v2",
        contract: log.address,
        token: args.burnToken.toLowerCase() as Hex,
        amount: args.amount,
        depositor: args.depositor.toLowerCase() as Hex,
        destination: {
          kind: "cctp-domain",
          domain: Number(args.destinationDomain),
        },
        log: position,
      };
    }
    const event =
      topic0 === EVENT_TOPICS.acrossV3
        ? BRIDGE_EVENTS.acrossV3
        : BRIDGE_EVENTS.across;
    const decoded = decodeEventLog({
      abi: [event],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    const args = decoded.args as unknown as {
      inputToken: Hex;
      inputAmount: bigint;
      destinationChainId: bigint;
      depositor: Hex;
    };
    const token =
      topic0 === EVENT_TOPICS.acrossV3
        ? (args.inputToken.toLowerCase() as Hex)
        : bytes32Address(args.inputToken);
    const depositor =
      topic0 === EVENT_TOPICS.acrossV3
        ? (args.depositor.toLowerCase() as Hex)
        : bytes32Address(args.depositor);
    return {
      protocol: "Across",
      contract: log.address,
      token,
      amount: args.inputAmount,
      depositor,
      destination: { kind: "chain", chainId: args.destinationChainId },
      log: position,
    };
  } catch {
    return null;
  }
}
