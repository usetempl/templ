/** The wallet a support-widget visitor names or proves: an EVM account on an
 * EIP-155 chain, or a Solana account. The worker, the room, the widget and
 * the inbox read the same shape through these functions. They are pure:
 * nothing here signs, reads a chain or grants access. A wallet a guest's app
 * reports stays a claim; only the worker's checked sign-in proof makes a
 * wallet verified.
 *
 * Wire forms, fixed for every package that reads them:
 * - a guest claim (`POST /widget/:ws/auth/guest` `wallet`) and a sign-in
 *   request (`POST /widget/:ws/auth/nonce` body) are a `WidgetWallet`; a
 *   value without `network` is EVM, as widgets built before Solana sign-in
 *   send it;
 * - the worker's room call `/private/support/widget-verify` carries the
 *   proven wallet as flat fields beside the principals:
 *   `{ guest, wallet, aliases, network, address, chainId?, origin,
 *   authenticatedAt }`, where `wallet` is the account principal and
 *   `network`, `address` and `chainId` read back through `parseWidgetWallet`;
 * - headers the worker builds for the room use CAIP-10 (`formatCaip10`);
 * - a Solana widget signature is strict padded base64 of 64 bytes
 *   (`decodeWidgetSolanaSignature`). */
import type { TeamConversation } from "./index";
import { isEip155ChainId } from "./chains";
import { isSolanaAddress } from "./solana";

export const WIDGET_WALLET_NETWORKS = ["evm", "solana"] as const;
export type WidgetWalletNetwork = (typeof WIDGET_WALLET_NETWORKS)[number];

export type WalletIdentification = { enabled: boolean; evm: boolean; solana: boolean };
export type WalletIdentificationPolicy = WalletIdentification & { bitcoin?: boolean };
export const DEFAULT_WALLET_IDENTIFICATION: WalletIdentification = { enabled: true, evm: true, solana: true };

export function sharedWalletAddresses(
  conversation?: Pick<TeamConversation, "verifiedWalletAddresses" | "verifiedWalletAddress" | "verifiedBitcoinWalletAddresses">,
  fallback?: string,
): string[] {
  const first = conversation?.verifiedWalletAddress ?? fallback;
  const other = conversation?.verifiedWalletAddresses ?? (first ? [first] : []);
  return conversation?.verifiedBitcoinWalletAddresses?.length ? [...other, ...conversation.verifiedBitcoinWalletAddresses] : other;
}

export function readWalletIdentification(value: unknown): WalletIdentification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { enabled, evm, solana } = value as Record<string, unknown>;
  return Object.keys(value).length === 3 && typeof enabled === "boolean" &&
    typeof evm === "boolean" && typeof solana === "boolean" ? { enabled, evm, solana } : null;
}
export type EvmWidgetWallet = {
  network: "evm";
  /** Lowercase, never the zero address. */
  address: `0x${string}`;
  chainId: number;
};
export type SolanaWidgetWallet = {
  network: "solana";
  /** Base58 of a 32-byte public key, case kept as the wallet reports it. */
  address: string;
};
export type WidgetWallet = EvmWidgetWallet | SolanaWidgetWallet;

/** CAIP-2 name of Solana mainnet (its genesis hash, cut to 32 characters).
 * Widget sign-in names only mainnet: the Sign In With Solana text carries
 * `Chain ID: mainnet`. */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** The statement in every widget sign-in challenge, SIWE and SIWS alike. The
 * widget compares it before asking a wallet to sign. */
export const WIDGET_SIGN_IN_STATEMENT =
  "Sign in to this protocol's support on Templ. This does not send a transaction.";
export const WIDGET_WALLET_SHARE_STATEMENT =
  "Share my verified wallet address with the support team in this conversation. This signature proves I control the wallet.";
/** How long a remembered widget sign-in lasts, counted from the signature. */
export const WIDGET_REMEMBER_DAYS = 30;
/** The statement of a challenge that also asks to stay signed in: today's
 * statement word for word, then the line the wallet shows before signing.
 * The worker offers it only when remembered sign-in is available and the
 * widget asked; the widget accepts it only when it asked. */
export const WIDGET_REMEMBER_STATEMENT =
  "Sign in to this protocol's support on Templ. This does not send a transaction. You'll stay signed in on this site for 30 days, or until you sign out.";
/** A remembered sign-in key as the browser keeps it: a family id and the
 * current secret. */
export const WIDGET_REMEMBER_CREDENTIAL = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
/** A development origin on this computer: localhost, 127.0.0.1 or [::1],
 * over http or https, with any port. The widget talks to it only when the
 * Templ allows development origins; it is never
 * offered a remembered sign-in, since every local project on a port shares
 * one storage. */
export function isLoopbackOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
/** The one resource a widget sign-in challenge lists: the workspace it signs
 * in to, on the app's origin. */
export const widgetSignInResource = (appOrigin: string, workspace: string) =>
  `${appOrigin}/rooms/${workspace}`;

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const EVM_ADDRESS_ANY_CASE = /^0x[0-9a-fA-F]{40}$/;
// A literal, so bundles that import one name from here drop the rest.
const EVM_ZERO = "0x0000000000000000000000000000000000000000";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isWidgetWalletNetwork(
  value: unknown,
): value is WidgetWalletNetwork {
  return WIDGET_WALLET_NETWORKS.some((network) => network === value);
}

/** A wallet in canonical form, as the worker stores and forwards it: an
 * explicit network; for EVM a lowercase, non-zero address and an EIP-155
 * chain id; for Solana an address that decodes to 32 bytes and no chain id.
 * Other keys on the value are ignored. Anything else is null. */
export function parseWidgetWallet(value: unknown): WidgetWallet | null {
  if (!isObject(value)) return null;
  if (value.network === "evm")
    return typeof value.address === "string" &&
      EVM_ADDRESS.test(value.address) &&
      value.address !== EVM_ZERO &&
      isEip155ChainId(value.chainId)
      ? {
          network: "evm",
          address: value.address as `0x${string}`,
          chainId: value.chainId,
        }
      : null;
  if (value.network === "solana")
    return value.chainId === undefined && isSolanaAddress(value.address)
      ? { network: "solana", address: value.address }
      : null;
  return null;
}

/** Why a wallet a widget sent was refused: a network Templ can't read, or an
 * address that doesn't fit its network. */
export type WidgetWalletClaimRefusal = "invalid-network" | "invalid-claim";
/** A wallet as a widget sends it, for a guest claim or a sign-in request.
 * `network` is "evm" or "solana"; without it the value is EVM. An EVM address
 * may use any case and comes back lowercase. A Solana value never carries a
 * chain id. */
export function parseWidgetWalletClaim(
  value: unknown,
):
  | { ok: true; wallet: WidgetWallet }
  | { ok: false; reason: WidgetWalletClaimRefusal } {
  if (!isObject(value)) return { ok: false, reason: "invalid-claim" };
  const network = value.network === undefined ? "evm" : value.network;
  if (network === "evm") {
    if (!isEip155ChainId(value.chainId))
      return { ok: false, reason: "invalid-network" };
    const wallet = parseWidgetWallet({
      network,
      chainId: value.chainId,
      address:
        typeof value.address === "string" &&
        EVM_ADDRESS_ANY_CASE.test(value.address)
          ? value.address.toLowerCase()
          : null,
    });
    return wallet
      ? { ok: true, wallet }
      : { ok: false, reason: "invalid-claim" };
  }
  if (network === "solana") {
    if (value.chainId !== undefined)
      return { ok: false, reason: "invalid-network" };
    const wallet = parseWidgetWallet({ network, address: value.address });
    return wallet
      ? { ok: true, wallet }
      : { ok: false, reason: "invalid-claim" };
  }
  return { ok: false, reason: "invalid-network" };
}

/** A wallet read from storage. Records written before Solana sign-in hold
 * `{address, chainId}` with no network: they read as EVM. Anything that
 * doesn't fit is null, and the caller treats the record as unreadable. */
export function readStoredWidgetWallet(value: unknown): WidgetWallet | null {
  if (isObject(value) && value.network === undefined)
    return parseWidgetWallet({
      network: "evm",
      address: value.address,
      chainId: value.chainId,
    });
  return parseWidgetWallet(value);
}

export function sameWidgetWallet(a: WidgetWallet, b: WidgetWallet): boolean {
  return (
    a.network === b.network &&
    a.address === b.address &&
    (a.network !== "evm" || b.network !== "evm" || a.chainId === b.chainId)
  );
}

/** CAIP-10 account id: `eip155:<chainId>:<0x address>` or
 * `solana:<mainnet genesis>:<base58 address>`. */
export function formatCaip10(wallet: WidgetWallet): string {
  return wallet.network === "evm"
    ? `eip155:${wallet.chainId}:${wallet.address}`
    : `${SOLANA_MAINNET_CAIP2}:${wallet.address}`;
}
const EIP155_ACCOUNT = /^eip155:([1-9][0-9]{0,15}):(0x[0-9a-f]{40})$/;
/** The inverse of `formatCaip10`, exactly: a lowercase EVM address, a chain
 * id without leading zeros, Solana mainnet only. Anything else is null. */
export function parseCaip10(value: unknown): WidgetWallet | null {
  if (typeof value !== "string") return null;
  const evm = EIP155_ACCOUNT.exec(value);
  if (evm)
    return parseWidgetWallet({
      network: "evm",
      chainId: Number(evm[1]),
      address: evm[2],
    });
  const prefix = `${SOLANA_MAINNET_CAIP2}:`;
  return value.startsWith(prefix)
    ? parseWidgetWallet({
        network: "solana",
        address: value.slice(prefix.length),
      })
    : null;
}

/** A Solana widget signature as sent: the 64 Ed25519 bytes in standard,
 * padded base64, 88 characters ending in "==". */
export const WIDGET_SOLANA_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
/** Reads exactly 64 signature bytes from canonical padded base64, or returns null.
 * App and widget sign-in use the same encoding. */
export function decodeWidgetSolanaSignature(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !WIDGET_SOLANA_SIGNATURE.test(value))
    return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  return bytes.length === 64 && encodeWidgetSolanaSignature(bytes) === value
    ? bytes
    : null;
}
/** Padded base64 of a 64-byte Ed25519 signature, as the widget sends it. */
export function encodeWidgetSolanaSignature(bytes: Uint8Array): string {
  if (bytes.length !== 64)
    throw new TypeError("A Solana signature is 64 bytes.");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
