import {
  recoverMessageAddress,
  hashMessage,
  isErc6492Signature,
  isErc8010Signature,
  parseErc6492Signature,
  parseErc8010Signature,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { authorizationClient } from "./rpc-consensus";
import {
  parseSiweMessage,
  validateSiweMessage,
  verifySiweMessage,
} from "viem/siwe";
import {
  config,
  HEALTH_CHAIN_ID,
  HttpError,
  SMART_WALLET_AUTH_CHAIN_ID,
  type Env,
} from "./common";
import {
  isChatChainId,
  isSupportSiweChainId,
  type ChatChainId,
} from "@templ/chat/chains";
import { authorizationEndpoints, type ChainRpcEnv } from "./chain-rpc";
import {
  smartWalletsOffered,
  type WidgetSessionEnv,
} from "./widget-session-config";

/** The networks where the support widget signs in a
 * contract wallet (ERC-1271, and ERC-6492 before it is deployed): Ethereum
 * and Katana. Each proof binds its chain, and a contract wallet signs in to
 * an account kept for that chain and address alone, so a contract at the
 * same address on another chain claims nothing. Solana has no equivalent;
 * Solana smart wallets can't sign messages and fail closed. */
export const WIDGET_SMART_WALLET_CHAINS = [1, 747474] as const;
export type WidgetSmartWalletChain = (typeof WIDGET_SMART_WALLET_CHAINS)[number];
export const isWidgetSmartWalletChain = (
  value: unknown,
): value is WidgetSmartWalletChain =>
  WIDGET_SMART_WALLET_CHAINS.some((id) => id === value);
const KEY = /^[A-Za-z0-9_-]{8,256}$/;
/** Katana's keyed pair, exactly: Alchemy first, dRPC to confirm. */
function katanaEndpoints(env: WidgetSessionEnv & ChainRpcEnv) {
  const vars = env as unknown as Record<string, unknown>;
  const first = vars.KATANA_AUTH_RPC_URL,
    second = vars.KATANA_CONFIRMATION_RPC_URL;
  const keyed = (value: unknown, prefix: string) =>
    typeof value === "string" &&
    value.startsWith(prefix) &&
    KEY.test(value.slice(prefix.length))
      ? value
      : null;
  const primary = keyed(first, "https://katana-mainnet.g.alchemy.com/v2/");
  const confirmation = keyed(second, "https://lb.drpc.live/katana/");
  if (!primary || !confirmation)
    throw new HttpError(503, "Independent chain verification is being set up.");
  return [primary, confirmation] as const;
}
/** Two independent providers agreeing on one of the widget's smart-wallet
 * chains. */
export function smartWalletClient(
  env: Env,
  chainId: WidgetSmartWalletChain,
  finality: "finalized" | "latest",
) {
  return authorizationClient(env, finality, chainId as ChatChainId, {
    endpoints:
      chainId === 747474
        ? katanaEndpoints(env as ChainRpcEnv & WidgetSessionEnv)
        : authorizationEndpoints(env as ChainRpcEnv, 1),
  });
}
/** A widget sign-in by a contract wallet on Ethereum or Katana: the SIWE
 * text the service issued, checked at one finalized block both providers
 * agree on, through ERC-1271 or, before deployment, ERC-6492. Off unless
 * Templ turned widget smart wallets on. */
export async function verifyWidgetSmartWallet(
  env: Env,
  input: {
    message: string;
    signature: Hex;
    address: Address;
    nonce: string;
    domain: string;
    scheme: string;
  },
  client?: PublicClient,
) {
  const chainId = parseSiweMessage(input.message).chainId;
  if (
    !smartWalletsOffered(env as WidgetSessionEnv) ||
    !isWidgetSmartWalletChain(chainId)
  )
    return false;
  const reader = client ?? smartWalletClient(env, chainId, "finalized");
  const agreed = await chainAndBlock(reader);
  if (agreed.chainId !== chainId)
    throw new HttpError(503, "Wallet network is unavailable.");
  return verifySiweMessage(reader, {
    message: input.message,
    signature: input.signature,
    address: input.address,
    nonce: input.nonce,
    domain: input.domain,
    scheme: input.scheme,
    blockNumber: agreed.blockNumber,
  });
}

/** Settles a read without throwing, so reads started together are judged in
 * the order the checks run. */
const settled = <T>(
  promise: Promise<T>,
): Promise<{ value: T } | { error: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
/** The agreed chain ID and block number, read together. The chain ID is
 * judged first, so a wrong network is still the error it reports. */
async function chainAndBlock(client: PublicClient) {
  const [chainId, blockNumber] = await Promise.all([
    settled(client.getChainId()),
    settled(client.getBlockNumber()),
  ]);
  if ("error" in chainId) throw chainId.error;
  if ("error" in blockNumber) throw blockNumber.error;
  return { chainId: chainId.value, blockNumber: blockNumber.value };
}
/** /health: both providers of the app's sign-in chain agree on it. */
export async function verifiedChain(
  env: Env,
  client: PublicClient = authorizationClient(env, "finalized", HEALTH_CHAIN_ID),
) {
  config(env);
  const { chainId, blockNumber } = await chainAndBlock(client);
  if (chainId !== HEALTH_CHAIN_ID)
    throw new HttpError(503, "Community network is unavailable.");
  return { blockNumber };
}
export async function verifyWallet(
  env: Env,
  message: string,
  signature: Hex,
  wallet: Address,
  nonce: string,
  client: PublicClient = authorizationClient(
    env,
    "finalized",
    SMART_WALLET_AUTH_CHAIN_ID,
  ),
) {
  const parsed = parseSiweMessage(message);
  const origin = config(env).origin;
  if (
    !isChatChainId(parsed.chainId) ||
    parsed.uri !== origin.origin ||
    !validateSiweMessage({
      message: parsed,
      address: wallet,
      nonce,
      domain: origin.host,
      scheme: "https",
    })
  )
    return false;
  try {
    if (
      (await recoverMessageAddress({ message, signature })).toLowerCase() ===
      wallet.toLowerCase()
    )
      return true;
  } catch {
    /* Smart-wallet signatures require the current chain verifier. */
  }
  // Raw-address principals are global EOA identities. Contract accounts at the
  // same address can have different owners on different chains; never let one
  // claim the existing Robinhood principal through another network's ERC-1271.
  if (parsed.chainId !== SMART_WALLET_AUTH_CHAIN_ID)
    throw new HttpError(
      403,
      "Smart-wallet sign-in is available on Robinhood Chain only.",
    );
  const { chainId, blockNumber } = await chainAndBlock(client);
  if (chainId !== SMART_WALLET_AUTH_CHAIN_ID)
    throw new HttpError(503, "Wallet network is unavailable.");
  return verifySiweMessage(client, {
    message,
    signature,
    address: wallet,
    nonce,
    domain: config(env).origin.host,
    scheme: "https",
    blockNumber,
  });
}
/** An ERC-6492 (undeployed) or ERC-8010 wrapped signature: its authority
 * comes from a simulation of the wallet's setup, so it signs in for one
 * hour and never starts a remembered sign-in. */
export const isCounterfactualSignature = (signature: Hex) =>
  isErc6492Signature(signature) || isErc8010Signature(signature);
/** A remembered bearer never outlives the wallet's current signing authority.
 * An EOA proof may name any network widget sign-in binds (an EOA key is the
 * same authority on every chain); a contract-wallet proof counts only on the
 * smart-wallet chain, where its ERC-1271 result is read again. */
export async function verifySessionAuthority(
  env: Env,
  wallet: Address,
  proof?: { message: string; signature: Hex },
  client?: PublicClient,
) {
  const proofChain = proof
    ? parseSiweMessage(proof.message).chainId
    : SMART_WALLET_AUTH_CHAIN_ID;
  if (!isSupportSiweChainId(proofChain)) return false;
  // A widget contract wallet on Ethereum or Katana counts only while Templ
  // has widget smart wallets on; turning them off ends those sessions.
  const widgetChain =
    proofChain !== SMART_WALLET_AUTH_CHAIN_ID &&
    isWidgetSmartWalletChain(proofChain) &&
    smartWalletsOffered(env as WidgetSessionEnv);
  if (proof) {
    try {
      // An EOA key remains authority for that address; no RPC or fresh signature is needed.
      if (
        (await recoverMessageAddress(proof)).toLowerCase() ===
        wallet.toLowerCase()
      )
        return true;
    } catch {
      /* Contract-wallet signatures need the current ERC-1271 result. */
    }
  }
  if (proofChain !== SMART_WALLET_AUTH_CHAIN_ID && !widgetChain) return false;
  client ??= widgetChain
    ? smartWalletClient(env, proofChain as WidgetSmartWalletChain, "latest")
    : authorizationClient(env, "latest", SMART_WALLET_AUTH_CHAIN_ID);
  // Initial SIWE may use counterfactual setup, but remembered authority must
  // come from the deployed wallet now. Never replay its setup during a recheck.
  let signature: Hex | undefined;
  if (proof)
    try {
      signature = parseErc6492Signature(
        parseErc8010Signature(proof.signature).signature,
      ).signature;
    } catch {
      signature = undefined;
    }
  const counterfactual = proof && isCounterfactualSignature(proof.signature);
  const blockNumber = await client.getBlockNumber();
  // viem.verifyMessage converts CallExecutionError (including provider outages)
  // to false. A direct read preserves uncertainty instead of revoking a valid
  // session. Only an actual non-magic return proves invalid signing authority.
  const checkSignature = (message: string, signature: Hex) =>
    settled(
      client.readContract({
        address: wallet,
        abi: parseAbi([
          "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)",
        ]),
        functionName: "isValidSignature",
        args: [hashMessage(message), signature],
        blockNumber,
      }),
    );
  // The signature check starts with the code read at the same block; the
  // code decides first, and with no code the check's result is ignored. A
  // counterfactual proof waits for the code, so an undeployed wallet never
  // gets a signature call.
  const early =
    proof && signature && !counterfactual
      ? checkSignature(proof.message, signature)
      : undefined;
  const code = await settled(client.getCode({ address: wallet, blockNumber }));
  if ("error" in code) throw code.error;
  if (!code.value || code.value === "0x") {
    // A widget wallet not deployed yet keeps the ERC-6492 proof its sign-in
    // simulated for that one-hour session only, like an EOA's signature.
    // It never gets a remembered sign-in (isCounterfactualSignature), so
    // nothing longer rests on the simulation; once the wallet is deployed,
    // ERC-1271 decides as for any contract wallet.
    if (counterfactual && widgetChain) return true;
    if (counterfactual)
      throw new HttpError(
        503,
        "Deploy your smart wallet to resume this sign-in.",
      );
    return !proof;
  }
  if (!proof) return false;
  if (!signature)
    throw new HttpError(
      503,
      "Your wallet signature cannot be checked right now.",
    );
  const magic = await (early ?? checkSignature(proof.message, signature));
  if ("error" in magic) throw magic.error;
  return magic.value.toLowerCase() === "0x1626ba7e";
}
