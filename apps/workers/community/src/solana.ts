/** Solana (SVM) primitives for the worker: base58, the Sign In With Solana
 * message, Ed25519 verification through WebCrypto, and reads through two
 * independently operated RPC providers that must agree (Solana payments).
 * Nothing here signs, sends or holds a key. */
import {
  base58Decode,
  base58Encode,
  createSolanaSignInMessage,
  isSolanaAddress,
  parseSolanaSignInMessage,
  type ParsedSolanaSignIn,
  type SolanaSignInFields,
} from "@templ/chat/solana";
import { HttpError, type Env } from "./common";
import { decodeWidgetSolanaSignature } from "@templ/chat/widget-wallet";

export { base58Decode, base58Encode, isSolanaAddress };

export function solanaAddress(value: unknown): string {
  if (!isSolanaAddress(value))
    throw new HttpError(400, "Invalid Solana wallet.");
  return value;
}

export {
  createSolanaSignInMessage,
  parseSolanaSignInMessage,
  type ParsedSolanaSignIn,
  type SolanaSignInFields,
};

/** Reads 64 Ed25519 signature bytes from canonical padded base64. */
export function decodeSolanaSignature(value: unknown): Uint8Array | null {
  return decodeWidgetSolanaSignature(value);
}
/** Ed25519 verification of a UTF-8 message by the address's public key. */
export async function verifySolanaSignature(
  message: string,
  signature: Uint8Array,
  address: string,
): Promise<boolean> {
  if (!isSolanaAddress(address) || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      base58Decode(address),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/** Runtime secrets, explicit like the EVM networks: a keyed primary provider
 * and an independent confirmation provider. Neither is copied from another
 * network. */
export type SolanaRpcEnv = Env & {
  SOLANA_AUTH_RPC_URL?: string;
  SOLANA_CONFIRMATION_RPC_URL?: string;
};
const PROVIDER_KEY = /^[A-Za-z0-9_-]{8,256}$/;
const keyedPath = (
  value: string,
  hostname: string,
  prefix: string,
): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    const pathPrefix = prefix ? `/${prefix}/` : "/";
    const key = url.pathname.startsWith(pathPrefix)
      ? url.pathname.slice(pathPrefix.length)
      : "";
    const canonical = `https://${hostname}${pathPrefix}${key}`;
    return value === canonical &&
      url.href === canonical &&
      PROVIDER_KEY.test(key)
      ? canonical
      : null;
  } catch {
    return null;
  }
};
const keyedHelius = (value: string): string | null => {
  try {
    const url = new URL(value);
    const keys = url.searchParams.getAll("api-key");
    const key = keys.length === 1 ? keys[0] : "";
    const canonical = `https://mainnet.helius-rpc.com/?api-key=${key}`;
    return url.href === canonical &&
      value === canonical &&
      PROVIDER_KEY.test(key)
      ? canonical
      : null;
  } catch {
    return null;
  }
};
function checkedSolanaUrl(
  value: string | undefined,
  { drpc = false }: { drpc?: boolean } = {},
): string | null {
  if (!value) return null;
  return (
    keyedHelius(value) ??
    keyedPath(value, "solana-mainnet.g.alchemy.com", "v2") ??
    keyedPath(value, "solana-mainnet.core.chainstack.com", "") ??
    (drpc ? keyedPath(value, "lb.drpc.live", "solana") : null)
  );
}
/** Both Solana providers, or a 503 that says the network is being set up. */
export function solanaEndpoints(env: SolanaRpcEnv): readonly [string, string] {
  if (!env.SOLANA_AUTH_RPC_URL || !env.SOLANA_CONFIRMATION_RPC_URL)
    throw new HttpError(503, "Solana verification is being set up.");
  const first = checkedSolanaUrl(env.SOLANA_AUTH_RPC_URL);
  const second = checkedSolanaUrl(env.SOLANA_CONFIRMATION_RPC_URL, {
    drpc: true,
  });
  if (!first || !second || new URL(first).hostname === new URL(second).hostname)
    throw new HttpError(503, "Solana verification is not configured.");
  return [first, second] as const;
}
