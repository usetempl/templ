import { isSolanaAddress } from "../solana";
import { isEvmNetwork, parseNetwork } from "./networks";
import { DiagnosisInputError } from "./rules";
import type {
  DiagnosisNetwork,
  EvmNetwork,
  Hex,
  ProviderRole,
  Quantity,
  UnavailableReason,
} from "./types";

/** Small fail-closed validators shared by the input and stored-record
 * parsers. Each returns the checked value or throws DiagnosisInputError. */

export type Obj = Record<string, unknown>;
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
export const HASH = /^0x[0-9a-f]{64}$/;
export const ADDRESS = /^0x[0-9a-f]{40}$/;
export const DATA = /^0x(?:[0-9a-f]{2})*$/;
export const SELECTOR = /^0x[0-9a-f]{8}$/;
export const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
export const COMMAND = /^[A-Z0-9_]{1,40}$/;
export const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .+&()-]{0,39}$/u;
export const SYMBOL = /^[A-Za-z0-9.+-]{1,12}$/;
export const DIGITS = /^\d{1,20}$/;
export const SOL_NAME = /^[A-Za-z]{1,64}$/;
export const TYPE = /^[A-Za-z0-9]{1,48}$/;
export const PROGRAM = /^[a-z0-9-]{1,48}$/;
export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]*$/;
export const UNAVAILABLE: readonly UnavailableReason[] = [
  "provider-error",
  "budget",
  "not-configured",
  "stale-head",
];
export const HINT_SOURCES = [
  "member-context",
  "wallet-chain",
  "explorer-link",
  "staff",
];
export const CONTRACT_KINDS = [
  "vault",
  "router",
  "bridge",
  "token",
  "staking",
  "other",
];
export const METHOD_GROUPS = [
  "erc20",
  "erc721",
  "erc1155",
  "weth",
  "permit2",
  "multicall3",
  "universal-router",
  "wrapper",
  "verified",
];
export const ABI_SOURCES = ["sourcify", "blockscout", "etherscan"];
export const INFO_KEYS = [
  "source",
  "destination",
  "authority",
  "owner",
  "delegate",
  "mint",
  "amount",
  "lamports",
];

export function fail(code: DiagnosisInputError["code"], path: string): never {
  throw new DiagnosisInputError(code, path);
}
export const isObj = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const has = (value: Obj, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

/** An object with exactly these keys (optional keys may be absent). */
export function obj(
  value: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Obj {
  if (!isObj(value)) fail("input-shape", path);
  for (const key of Object.keys(value))
    if (!keys.includes(key) && !optional.includes(key))
      fail("input-shape", `${path}/${key}`);
  for (const key of keys)
    if (!has(value, key)) fail("input-shape", `${path}/${key}`);
  return value;
}
export function list(
  value: unknown,
  path: string,
  max: number,
  min = 0,
): unknown[] {
  if (!Array.isArray(value)) fail("input-shape", path);
  if (value.length > max) fail("input-limits", path);
  if (value.length < min) fail("input-shape", path);
  return value;
}
export function text(
  value: unknown,
  path: string,
  pattern: RegExp | null,
  max = 200,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (pattern && !pattern.test(value))
  )
    fail("input-shape", path);
  return value;
}
export function oneOf<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
): T {
  if (
    typeof value !== "string" ||
    !(options as readonly string[]).includes(value)
  )
    fail("input-shape", path);
  return value as T;
}
export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("input-shape", path);
  return value;
}
export function int(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    fail("input-shape", path);
  return value;
}
export const nullable = <T>(
  value: unknown,
  read: (item: unknown) => T,
): T | null => (value === null ? null : read(value));
export const quantity = (value: unknown, path: string) =>
  text(value, path, QUANTITY, 66) as Quantity;
export const hash = (value: unknown, path: string) =>
  text(value, path, HASH, 66) as Hex;
export const address = (value: unknown, path: string) =>
  text(value, path, ADDRESS, 42) as Hex;
export function data(value: unknown, path: string, maxBytes: number): Hex {
  if (typeof value !== "string" || !DATA.test(value)) fail("input-shape", path);
  if (value.length > maxBytes * 2 + 2) fail("input-limits", path);
  return value as Hex;
}
export const iso = (value: unknown, path: string) => text(value, path, ISO, 24);
export function network(value: unknown, path: string): DiagnosisNetwork {
  const parsed = parseNetwork(value);
  if (!parsed) fail("input-network", path);
  return parsed;
}
export function evmNetwork(value: unknown, path: string): EvmNetwork {
  if (!isEvmNetwork(value)) fail("input-network", path);
  return value;
}
export function roles(value: unknown, path: string): ProviderRole[] {
  const items = list(value, path, 2, 1).map((item, index) =>
    oneOf(item, `${path}/${index}`, ["primary", "confirmation"] as const),
  );
  if (new Set(items).size !== items.length) fail("input-shape", path);
  return items;
}
export function solAddress(value: unknown, path: string): string {
  if (!isSolanaAddress(value)) fail("input-shape", path);
  return value;
}
export function walletAddress(
  net: DiagnosisNetwork,
  value: unknown,
  path: string,
): string {
  return net === "solana" ? solAddress(value, path) : address(value, path);
}
export const big = (value: string) => BigInt(value);
