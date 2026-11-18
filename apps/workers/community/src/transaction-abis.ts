import {
  parseAbi,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import type { ChatChainId } from "@templ/chat/chains";
import { PRODUCT_PAYMENT_ASSETS } from "@templ/chat/product-payment-assets";

/** The read-only decoder: the ABIs it always knows and the addresses it may
 * label without asking anyone.
 *
 * A builtin ABI is matched by selector before any hosted lookup, so the
 * common approvals, transfers, wraps, Permit2 grants, Multicall3 bundles and
 * Uniswap Universal Router bundles decode offline. Two standards sharing a
 * selector (ERC-20 and ERC-721 `approve`, `transferFrom`; ERC-721 and
 * ERC-1155 `setApprovalForAll`) share one entry with neutral argument names;
 * the target facts say which asset it is. Labels are a fixed list of
 * addresses whose identity is known for certain; anything not listed shows
 * its address, never a guessed name. */
export type BuiltinAbiGroup =
  | "erc20"
  | "erc721"
  | "erc1155"
  | "weth"
  | "permit2"
  | "multicall3"
  | "universal-router"
  | "wrapper";
export type BuiltinFunction = { group: BuiltinAbiGroup; fn: AbiFunction };

const erc20 = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
  "function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
const erc721 = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
]);
const erc1155 = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
]);
const weth = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
]);
const permit2 = parseAbi([
  "struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }",
  "struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }",
  "struct PermitBatch { PermitDetails[] details; address spender; uint256 sigDeadline; }",
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct SignatureTransferDetails { address to; uint256 requestedAmount; }",
  "struct AllowanceTransferDetails { address from; address to; uint160 amount; address token; }",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function permit(address owner, PermitSingle permitSingle, bytes signature)",
  "function permit(address owner, PermitBatch permitBatch, bytes signature)",
  "function permitTransferFrom(PermitTransferFrom permit, SignatureTransferDetails transferDetails, address owner, bytes signature)",
  "function transferFrom(address from, address to, uint160 amount, address token)",
  "function transferFrom(AllowanceTransferDetails[] transferDetails)",
]);
const multicall3 = parseAbi([
  "struct Call { address target; bytes callData; }",
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate(Call[] calls) payable returns (uint256 blockNumber, bytes[] returnData)",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)",
  "function tryAggregate(bool requireSuccess, Call[] calls) payable returns (Result[] returnData)",
]);
const universalRouter = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "function execute(bytes commands, bytes[] inputs) payable",
]);
/** The account-abstraction wrapper shape (`execute(address,uint256,bytes)`);
 * its inner call decodes one level down. */
const wrapper = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
]);

const functions = (abi: readonly unknown[]): AbiFunction[] =>
  abi.filter(
    (item): item is AbiFunction =>
      (item as { type?: string }).type === "function",
  );
/** Builtin groups in match order: the first group whose function decodes wins. */
export const BUILTIN_ABIS: readonly {
  group: BuiltinAbiGroup;
  functions: readonly AbiFunction[];
}[] = [
  { group: "erc20", functions: functions(erc20) },
  { group: "erc721", functions: functions(erc721) },
  { group: "erc1155", functions: functions(erc1155) },
  { group: "weth", functions: functions(weth) },
  { group: "permit2", functions: functions(permit2) },
  { group: "multicall3", functions: functions(multicall3) },
  { group: "universal-router", functions: functions(universalRouter) },
  { group: "wrapper", functions: functions(wrapper) },
];
const bySelector = new Map<Hex, BuiltinFunction[]>();
for (const { group, functions: items } of BUILTIN_ABIS)
  for (const fn of items) {
    const selector = toFunctionSelector(fn);
    const list = bySelector.get(selector) ?? [];
    // A function repeated within one group needs only one copy.
    if (
      !list.some((entry) => entry.group === group && entry.fn.name === fn.name)
    )
      list.push({ group, fn });
    bySelector.set(selector, list);
  }
/** Every builtin function with this selector, in group order. */
export function builtinFunctions(selector: Hex): readonly BuiltinFunction[] {
  return bySelector.get(selector.toLowerCase() as Hex) ?? [];
}

/* ---------------------------------------------------------------------- */
/* Uniswap Universal Router commands                                        */
/* ---------------------------------------------------------------------- */

/** One byte per command; the low six bits pick the command and 0x80 lets it
 * revert without failing the bundle. The input layouts follow the router's
 * Dispatcher. Commands not listed here show as unreadable. */
export const UNIVERSAL_ROUTER_COMMANDS: Readonly<
  Record<number, { name: string; params: readonly AbiParameter[] }>
> = {
  0x00: {
    name: "V3_SWAP_EXACT_IN",
    params: [
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "bytes" },
      { name: "payerIsUser", type: "bool" },
    ],
  },
  0x01: {
    name: "V3_SWAP_EXACT_OUT",
    params: [
      { name: "recipient", type: "address" },
      { name: "amountOut", type: "uint256" },
      { name: "amountInMax", type: "uint256" },
      { name: "path", type: "bytes" },
      { name: "payerIsUser", type: "bool" },
    ],
  },
  0x02: {
    name: "PERMIT2_TRANSFER_FROM",
    params: [
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint160" },
    ],
  },
  0x03: {
    name: "PERMIT2_PERMIT_BATCH",
    params: [
      {
        name: "permitBatch",
        type: "tuple",
        components: [
          {
            name: "details",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
  },
  0x04: {
    name: "SWEEP",
    params: [
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amountMin", type: "uint256" },
    ],
  },
  0x05: {
    name: "TRANSFER",
    params: [
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
      { name: "value", type: "uint256" },
    ],
  },
  0x06: {
    name: "PAY_PORTION",
    params: [
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
      { name: "bips", type: "uint256" },
    ],
  },
  0x08: {
    name: "V2_SWAP_EXACT_IN",
    params: [
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "payerIsUser", type: "bool" },
    ],
  },
  0x09: {
    name: "V2_SWAP_EXACT_OUT",
    params: [
      { name: "recipient", type: "address" },
      { name: "amountOut", type: "uint256" },
      { name: "amountInMax", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "payerIsUser", type: "bool" },
    ],
  },
  0x0a: {
    name: "PERMIT2_PERMIT",
    params: [
      {
        name: "permitSingle",
        type: "tuple",
        components: [
          {
            name: "details",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
  },
  0x0b: {
    name: "WRAP_ETH",
    params: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  0x0c: {
    name: "UNWRAP_WETH",
    params: [
      { name: "recipient", type: "address" },
      { name: "amountMin", type: "uint256" },
    ],
  },
  0x0d: {
    name: "PERMIT2_TRANSFER_FROM_BATCH",
    params: [
      {
        name: "batchDetails",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "token", type: "address" },
        ],
      },
    ],
  },
  0x0e: {
    name: "BALANCE_CHECK_ERC20",
    params: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "minBalance", type: "uint256" },
    ],
  },
  0x10: {
    name: "V4_SWAP",
    params: [
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" },
    ],
  },
  0x21: {
    name: "EXECUTE_SUB_PLAN",
    params: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
    ],
  },
};
export const UNIVERSAL_ROUTER_COMMAND_MASK = 0x3f;

/* ---------------------------------------------------------------------- */
/* Labels                                                                   */
/* ---------------------------------------------------------------------- */

export type KnownAddress = {
  label: string;
  /** Token decimals when the address is a token whose decimals are certain. */
  decimals?: number;
};
/** Deployed at the same address on every supported network. */
export const PERMIT2_ADDRESS: Address =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const MULTICALL3_ADDRESS: Address =
  "0xcA11bde05977b3631167028862bE2a173976CA11";
const everywhere: Record<string, KnownAddress> = {
  [PERMIT2_ADDRESS]: { label: "Permit2" },
  [MULTICALL3_ADDRESS]: { label: "Multicall3" },
};
/** Addresses whose identity is certain. A token here also carries its
 * decimals so an amount formats even when the chain read is unavailable. */
const perChain: Record<ChatChainId, Record<string, KnownAddress>> = {
  1: {
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": {
      label: "USDT",
      decimals: 6,
    },
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
      label: "WETH",
      decimals: 18,
    },
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": {
      label: "DAI",
      decimals: 18,
    },
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD": {
      label: "Uniswap Universal Router",
    },
  },
  8453: {
    "0x4200000000000000000000000000000000000006": {
      label: "WETH",
      decimals: 18,
    },
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD": {
      label: "Uniswap Universal Router",
    },
  },
  56: {
    "0x55d398326f99059fF775485246999027B3197955": {
      label: "USDT",
      decimals: 18,
    },
    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c": {
      label: "WBNB",
      decimals: 18,
    },
  },
  4663: {},
};
const lower = (entries: Record<string, KnownAddress>) =>
  Object.fromEntries(
    Object.entries(entries).map(([address, entry]) => [
      address.toLowerCase(),
      entry,
    ]),
  );
const known: Record<ChatChainId, Record<string, KnownAddress>> = {
  1: {},
  8453: {},
  56: {},
  4663: {},
};
for (const chainId of [1, 8453, 56, 4663] as const) {
  known[chainId] = lower({
    ...everywhere,
    ...perChain[chainId],
    ...Object.fromEntries(
      Object.values(PRODUCT_PAYMENT_ASSETS[chainId]).map((asset) => [
        asset.address,
        { label: asset.label, decimals: asset.decimals },
      ]),
    ),
  });
}
/** What Templ knows for certain about an address on a chain, or null. */
export function knownAddress(
  chainId: ChatChainId,
  address: string,
): KnownAddress | null {
  return known[chainId]?.[address.toLowerCase()] ?? null;
}
