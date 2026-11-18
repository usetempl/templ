import { getAddress, isAddress, type Address, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { isChatChainId, type ChatChainId } from "@templ/chat/chains";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  WALLET_LINK_RESOURCE_PREFIXES,
  WALLET_LINK_STATEMENT,
  type AccountWallets,
  type ProvenWallet,
} from "@templ/chat/wallets";
import { chatMutation } from "./chat-api";
import { communityFetch } from "./community-client";
import { SITE } from "./release-public";
import type { useWallet } from "./wallet";

/** Account wallet requests bind the signed-in principal, so a changed session
 * cannot link a wallet to the wrong account. Removing a wallet ends the sessions
 * it opened. This module never asks for a private key. */
export const WALLETS_UNREADABLE = "Your wallets could not be read.";
export const CHALLENGE_UNVERIFIED = "The wallet request could not be verified.";
export const CHALLENGE_CLOCK_OFF =
  "This wallet request expired, or your device clock is over 5 minutes off. Try again.";
/** The worker issues the challenge expiry from its own clock, `NONCE_TTL`
 * (five minutes) ahead; the browser accepts a clock that differs from the
 * worker's by up to `CLOCK_SKEW_MS` either way. */
const NONCE_LIFETIME_MS = 5 * 60_000;
export const CLOCK_SKEW_MS = 5 * 60_000;

export type WalletChallenge = { message: string; expiresAt: number };

const lower = (value: string) => value.toLowerCase() as Address;
const isLowerAddress = (value: unknown): value is Address =>
  typeof value === "string" &&
  /^0x[0-9a-f]{40}$/.test(value) &&
  isAddress(value);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function isProvenWallet(value: unknown): value is ProvenWallet {
  const w = value as Partial<ProvenWallet> | null;
  return (
    !!w &&
    typeof w === "object" &&
    isLowerAddress(w.address) &&
    (w.kind === "eoa" || w.kind === "contract") &&
    isChatChainId(w.chainId) &&
    isIso(w.provenAt) &&
    typeof w.primary === "boolean"
  );
}
/** Fails closed: a response that does not carry the full shape is unreadable,
 * so the screen never renders a partial wallet list as the whole account. */
export function validAccountWallets(raw: unknown): AccountWallets {
  const value = raw as Partial<AccountWallets> | null;
  const principalId = normalizeChatPrincipal(value?.principalId);
  if (
    !value ||
    typeof value !== "object" ||
    !principalId ||
    !Array.isArray(value.wallets) ||
    !value.wallets.every(isProvenWallet) ||
    !Number.isSafeInteger(value.walletRevision) ||
    (value.walletRevision as number) < 0
  )
    throw new Error(WALLETS_UNREADABLE);
  // Only the fields the page reads leave this check.
  return {
    principalId,
    wallets: value.wallets.map((w) => ({ ...w })),
    walletRevision: value.walletRevision as number,
  };
}

export function readAccountWallets(
  account: ChatPrincipalId,
  signal?: AbortSignal,
): Promise<AccountWallets> {
  const params = new URLSearchParams({ expectedPrincipalId: account });
  return communityFetch<unknown>(
    `/auth/wallets?${params}`,
    undefined,
    signal,
  ).then(validAccountWallets);
}

/** Step one of adding a wallet: the worker writes a SIWE challenge for the
 * exact address and network the person chose, bound to this account. */
export async function requestWalletChallenge(
  account: ChatPrincipalId | undefined,
  input: { address: Address; chainId: ChatChainId },
  assertCurrent?: () => void,
): Promise<WalletChallenge> {
  if (!isAddress(input.address)) throw new Error("Choose a wallet to add.");
  if (!isChatChainId(input.chainId))
    throw new Error("Choose a supported wallet network.");
  return chatMutation<unknown>(
    account,
    "/auth/wallets/nonce",
    { address: lower(input.address), chainId: input.chainId },
    assertCurrent,
  ).then(validWalletChallenge);
}
/** The challenge response shape; anything else is unusable. */
export function validWalletChallenge(raw: unknown): WalletChallenge {
  const value = raw as Partial<WalletChallenge> | null;
  if (
    !value ||
    typeof value.message !== "string" ||
    value.message.length > 4096 ||
    !Number.isSafeInteger(value.expiresAt)
  )
    throw new Error(CHALLENGE_UNVERIFIED);
  return { message: value.message, expiresAt: value.expiresAt as number };
}

/** The browser signs only a challenge the worker wrote for this address, this
 * network and this account, with the site origin and the link statement. */
export function checkWalletChallenge(
  challenge: WalletChallenge,
  expected: {
    address: Address;
    chainId: ChatChainId;
    principalId: ChatPrincipalId;
  },
  now = Date.now(),
) {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(challenge.message);
  } catch {
    throw new Error(CHALLENGE_UNVERIFIED);
  }
  const origin = new URL(SITE.origin);
  if (
    parsed.address?.toLowerCase() !== expected.address.toLowerCase() ||
    parsed.chainId !== expected.chainId ||
    parsed.domain !== origin.host ||
    parsed.uri !== origin.origin ||
    parsed.scheme !== "https" ||
    parsed.version !== "1" ||
    parsed.statement !== WALLET_LINK_STATEMENT ||
    !parsed.nonce ||
    !parsed.expirationTime ||
    parsed.expirationTime.getTime() !== challenge.expiresAt ||
    parsed.notBefore ||
    parsed.requestId ||
    parsed.resources?.[0] !==
      `${WALLET_LINK_RESOURCE_PREFIXES.principal}${expected.principalId}`
  )
    throw new Error(CHALLENGE_UNVERIFIED);
  // The expiry is the worker's clock plus the nonce lifetime. A device clock
  // off by more than the tolerance would make every challenge look expired
  // or too far ahead, so that case gets its own sentence instead of the
  // generic one; the worker still enforces the real lifetime when the
  // signature is verified.
  const issuedAt = parsed.expirationTime.getTime() - NONCE_LIFETIME_MS;
  if (Math.abs(issuedAt - now) > CLOCK_SKEW_MS)
    throw new Error(CHALLENGE_CLOCK_OFF);
}

export async function verifyWalletChallenge(
  account: ChatPrincipalId | undefined,
  input: { message: string; signature: Hex },
  assertCurrent?: () => void,
): Promise<AccountWallets> {
  if (!/^0x[0-9a-f]+$/i.test(input.signature) || input.signature.length % 2)
    throw new Error("Invalid wallet signature.");
  return chatMutation<unknown>(
    account,
    "/auth/wallets/verify",
    { message: input.message, signature: input.signature },
    assertCurrent,
  ).then(validAccountWallets);
}

/** The whole add-a-wallet flow the account page runs. The person
 * picks the wallet in their wallet app; the browser checks the challenge and
 * signs only when the selected wallet still matches the one it asked for. */
export const WALLET_CHANGED_ERROR =
  "Your wallet account changed. Start again with the wallet you want to add.";
export async function addWalletWithSignature(
  account: ChatPrincipalId,
  wallet: Pick<ReturnType<typeof useWallet>, "account" | "connect" | "ready">,
  chainId: ChatChainId,
  latestAccount: () => Address | undefined = () => wallet.account,
): Promise<AccountWallets> {
  const connected = wallet.account ?? (await wallet.connect());
  const requested = getAddress(connected);
  const assertCurrent = () => {
    if (latestAccount()?.toLowerCase() !== requested.toLowerCase())
      throw new Error(WALLET_CHANGED_ERROR);
  };
  const signer = await wallet.ready(chainId);
  assertCurrent();
  if (signer.account.address.toLowerCase() !== requested.toLowerCase())
    throw new Error(WALLET_CHANGED_ERROR);
  const challenge = await requestWalletChallenge(
    account,
    { address: requested, chainId },
    assertCurrent,
  );
  assertCurrent();
  checkWalletChallenge(challenge, {
    address: requested,
    chainId,
    principalId: account,
  });
  const signature = await signer.signMessage({
    account: signer.account,
    message: challenge.message,
  });
  assertCurrent();
  return verifyWalletChallenge(
    account,
    { message: challenge.message, signature },
    assertCurrent,
  );
}

export async function removeAccountWallet(
  account: ChatPrincipalId | undefined,
  address: Address,
  assertCurrent?: () => void,
): Promise<AccountWallets> {
  if (!isAddress(address)) throw new Error("Choose a wallet to remove.");
  return chatMutation<unknown>(
    account,
    "/auth/wallets/remove",
    { address: lower(address) },
    assertCurrent,
  ).then(validAccountWallets);
}
