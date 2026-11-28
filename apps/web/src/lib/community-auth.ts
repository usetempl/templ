import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import {
  isAuthMethod,
  normalizeChatPrincipal,
  type AuthMethod,
  type ChatPrincipalId,
  type ChatSession,
  normalizeServicePrincipals,
} from "@templ/chat/principal";
import { parseSiweMessage } from "viem/siwe";
import {
  DEFAULT_CHAT_AUTH_CHAIN_ID,
  isChatChainId,
  type ChatChainId,
} from "@templ/chat/chains";
import { CommunityApiError, communityFetch } from "./community-client";
import type { useWallet } from "./wallet";
import {
  checkWalletChallenge,
  validAccountWallets,
  validWalletChallenge,
} from "./wallet-links";
import {
  base58Decode,
  isSolanaAddress,
  parseSolanaSignInMessage,
} from "@templ/chat/solana";
import { SITE } from "./release-public";
import type { SolanaSigner } from "./solana-wallet";
import type { BitcoinSigner } from "./bitcoin-wallet";
import { isBitcoinAccountAddress, validateBitcoinAccountChallenge } from "@templ/chat/bitcoin-account-auth";
import { setPrincipalHintSession } from "./principal-hint";
import { dropDevicePushAlerts } from "./push-device";

type Ready = ReturnType<typeof useWallet>["ready"];
/** A session opened with an EVM or a Solana wallet signature;
 * every wallet on an account resolves to the same account. */
export type { AuthMethod };
export type CommunitySession = ChatSession;
export type ChatCapabilities = {
  wallet: boolean;
  emailSignIn: boolean;
  /** Solana sign-in needs no provider. */
  solana: { signIn: boolean };
  bitcoin?: { signIn: boolean };
};
const SESSION_CHECK_INTERVAL = 5 * 60_000;
let remembered: { session: CommunitySession; checkedAt: number } | undefined;
let revision = 0;
let checking: Promise<CommunitySession | undefined> | undefined;
let signing:
  | {
      account: string;
      revision: number;
      connectCode?: string;
      promise: Promise<void>;
    }
  | undefined;
let authenticationRevision = 0;
let verifying: Promise<CommunitySession> | undefined;
let messageWalletSigning:
  | { revision: number; promise: Promise<unknown> }
  | undefined;
let emailOperation: Promise<unknown> | undefined;
let emailChallengeRevision: number | undefined;
let attaching: Promise<CommunitySession> | undefined;
let detaching: Promise<CommunitySession> | undefined;
let ending: Promise<void> | undefined;
let logoutRequested = false;
const sessionListeners = new Set<() => void>();
const SESSION_EVENT = "templ:community-session";
const receivedEvents = new Set<string>();
let sessionChannel: BroadcastChannel | undefined;
function receiveSessionEvent(value: unknown) {
  if (!value || typeof value !== "object") return;
  const event = value as { kind?: string; id?: string };
  if (
    (event.kind !== "logout" && event.kind !== "changed") ||
    typeof event.id !== "string" ||
    event.id.length > 100 ||
    receivedEvents.has(event.id)
  )
    return;
  receivedEvents.add(event.id);
  while (receivedEvents.size > 32)
    receivedEvents.delete(receivedEvents.values().next().value!);
  if (event.kind === "logout") void requestSignOut(false).catch(() => {});
  else {
    ++authenticationRevision;
    invalidateCommunitySession();
  }
}
function publishSessionEvent(kind: "logout" | "changed") {
  const event = { kind, id: crypto.randomUUID() };
  try {
    sessionChannel?.postMessage(event);
  } catch {
    /* Storage events provide a second transport. */
  }
  try {
    window.localStorage.setItem(SESSION_EVENT, JSON.stringify(event));
  } catch {
    /* In-memory sessions still work when storage is unavailable. */
  }
}
if (typeof window !== "undefined") {
  if (typeof window.BroadcastChannel !== "undefined") {
    try {
      sessionChannel = new window.BroadcastChannel(SESSION_EVENT);
      sessionChannel.addEventListener("message", (event) =>
        receiveSessionEvent(event.data),
      );
    } catch {
      /* Storage events work without BroadcastChannel. */
    }
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_EVENT || !event.newValue) return;
    try {
      receiveSessionEvent(JSON.parse(event.newValue));
    } catch {
      /* Ignore unrelated or malformed storage events. */
    }
  });
}

export const communitySessionRevision = () => revision;
export function subscribeCommunitySession(listener: () => void) {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
export function sessionMatches(
  session: CommunitySession,
  principal?: ChatPrincipalId,
) {
  return (
    !principal || session.principalId.toLowerCase() === principal.toLowerCase()
  );
}
export function sameCommunitySession(expected: CommunitySession, actual?: CommunitySession) {
  return (
    actual?.principalId === expected.principalId &&
    actual.authenticatedAt === expected.authenticatedAt &&
    actual.authMethod === expected.authMethod &&
    actual.walletRevision === expected.walletRevision &&
    actual.address === expected.address &&
    actual.solanaAddress === expected.solanaAddress &&
    actual.bitcoinAddress === expected.bitcoinAddress
  );
}
export function peekCommunitySession(account?: ChatPrincipalId) {
  const session = remembered?.session;
  return !logoutRequested &&
    session &&
    session.expiresAt > Date.now() &&
    sessionMatches(session, account)
    ? session
    : undefined;
}
setPrincipalHintSession(() => peekCommunitySession());
const sessionChanged = () => {
  ++revision;
  sessionListeners.forEach((listener) => listener());
};

export function validatedSession(raw: unknown): CommunitySession {
  if (!raw || typeof raw !== "object")
    throw new Error("The signed-in session could not be verified.");
  const value = raw as Partial<CommunitySession>;
  const authMethod = value.authMethod;
  const principalId = normalizeChatPrincipal(value.principalId);
  const servicePrincipals = principalId
    ? normalizeServicePrincipals(principalId, value.servicePrincipals)
    : null;
  const address =
    value.address &&
    isAddress(value.address) &&
    value.address.toLowerCase() !== zeroAddress
      ? getAddress(value.address)
      : null;
  const solanaAddress = isSolanaAddress(value.solanaAddress)
    ? value.solanaAddress
    : null;
  const bitcoinAddress = isBitcoinAccountAddress(value.bitcoinAddress)
    ? value.bitcoinAddress
    : null;
  // A wallet session names the wallet that signed it in. A bare wallet account
  // is that wallet; an opaque account may be signed in by any of its proven
  // wallets, which the worker verified, so the alias list is not the test.
  if (
    (value.address != null && !address) ||
    !principalId ||
    !servicePrincipals ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt! <= Date.now() ||
    !Number.isSafeInteger(value.authenticatedAt) ||
    value.authenticatedAt! <= 0 ||
    value.authenticatedAt! > Date.now() ||
    !Number.isSafeInteger(value.walletRevision) ||
    value.walletRevision! < 0 ||
    !isAuthMethod(authMethod) || authMethod === "guest" ||
    (value.solanaAddress != null && !solanaAddress) ||
    (value.bitcoinAddress != null && (!bitcoinAddress || authMethod !== "bitcoin")) ||
    (authMethod === "bitcoin" && (!bitcoinAddress || solanaAddress || !principalId.startsWith("account:"))) ||
    (authMethod === "solana" &&
      (!solanaAddress || !principalId.startsWith("account:"))) ||
    (authMethod === "email" &&
      (!principalId.startsWith("account:") ||
        value.emailSignIn !== true ||
        value.address !== null ||
        value.walletAuthorizationExpiresAt !== null ||
        solanaAddress)) ||
    (authMethod === "wallet" &&
      (!address ||
        (!principalId.startsWith("account:") &&
          principalId !== address.toLowerCase())))
  )
    throw new Error("The signed-in session could not be verified.");
  const capability = value.walletAuthorizationExpiresAt;
  // A non-wallet session carries wallet authority only for as long as the worker says.
  if (
    capability === undefined ||
    !(
      capability === null ||
      (Number.isSafeInteger(capability) &&
        capability! > 0 &&
        (authMethod === "wallet" || capability! <= value.expiresAt!))
    ) ||
    (authMethod === "wallet" &&
      (capability === null || capability < value.expiresAt!)) ||
    (authMethod !== "wallet" && address && capability === null)
  )
    throw new Error("The wallet authorization could not be verified.");
  return {
    principalId,
    servicePrincipals,
    authMethod,
    ...(authMethod === "email" ? { emailSignIn: true as const } : {}),
    address:
      authMethod !== "wallet" && (!capability || capability <= Date.now())
        ? null
        : address,
    expiresAt: value.expiresAt!,
    authenticatedAt: value.authenticatedAt!,
    walletRevision: value.walletRevision!,
    walletAuthorizationExpiresAt: capability,
    ...(solanaAddress ? { solanaAddress } : {}),
    ...(bitcoinAddress ? { bitcoinAddress } : {}),
  };
}
async function settledSession(raw: unknown): Promise<CommunitySession> {
  const authenticatedAt = (raw as Partial<CommunitySession> | null)
    ?.authenticatedAt;
  const ahead = (authenticatedAt ?? 0) - Date.now();
  if (Number.isSafeInteger(authenticatedAt) && ahead > 0 && ahead <= 1_000)
    await new Promise<void>((resolve) => setTimeout(resolve, ahead));
  return validatedSession(raw);
}

export function rememberCommunitySession(session: CommunitySession) {
  remembered = { session: validatedSession(session), checkedAt: Date.now() };
  sessionChanged();
  if (typeof window !== "undefined") publishSessionEvent("changed");
}
/** Cache only server-confirmed identity/expiry; the HttpOnly cookie stays with the browser.
 * Every private case request checks the session and current access on the server. */
export function invalidateCommunitySession() {
  remembered = undefined;
  sessionChanged();
  // Keep an outstanding HTTP check tracked until it settles: its Set-Cookie
  // header must arrive before a replacement sign-in, even if its metadata is stale.
}
export function readCommunitySession(
  force = false,
  expectedAccount?: ChatPrincipalId,
): Promise<CommunitySession | undefined> {
  if (logoutRequested)
    return signOutCommunity().then(() =>
      readCommunitySession(force, expectedAccount),
    );
  if (attaching) return attaching;
  if (emailOperation)
    return emailOperation
      .catch(() => {})
      .then(() => readCommunitySession(force, expectedAccount));
  // Session responses can renew the shared cookie. Do not let a check started
  // during signing arrive after /auth/verify and replace the new cookie.
  if (signing && signing.revision === authenticationRevision)
    return signing.promise
      .catch(() => {})
      .then(() => readCommunitySession(force, expectedAccount));
  if (messageWalletSigning && messageWalletSigning.revision === authenticationRevision)
    return messageWalletSigning.promise
      .catch(() => {})
      .then(() => readCommunitySession(force, expectedAccount));
  return checkCommunitySession(force, expectedAccount);
}
function checkCommunitySession(
  force = false,
  expectedAccount?: ChatPrincipalId,
): Promise<CommunitySession | undefined> {
  if (detaching) return detaching;
  if (verifying) return verifying;
  return fetchCommunitySession(force, expectedAccount);
}
/** The cookie check itself; wallet add and remove call it while they hold
 * the `attaching` or `detaching` slot, so it does not wait on those. */
function fetchCommunitySession(
  force = false,
  expectedAccount?: ChatPrincipalId,
): Promise<CommunitySession | undefined> {
  const now = Date.now();
  if (
    !force &&
    remembered &&
    sessionMatches(remembered.session, expectedAccount) &&
    remembered.session.expiresAt > now &&
    now - remembered.checkedAt < SESSION_CHECK_INTERVAL
  )
    return Promise.resolve(remembered.session);
  if (checking) return checking;
  const started = revision;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const task = communityFetch<CommunitySession>(
    "/auth/session",
    undefined,
    controller.signal,
  )
    .then(async (value) => {
      const session = await settledSession(value);
      if (started === revision) {
        const changed =
          !sameCommunitySession(session, remembered?.session) ||
          JSON.stringify(remembered?.session.servicePrincipals) !==
            JSON.stringify(session.servicePrincipals);
        remembered = { session, checkedAt: Date.now() };
        if (changed) sessionChanged();
      }
      return session;
    })
    .catch((error: unknown) => {
      if (error instanceof CommunityApiError && error.status === 401) {
        if (started === revision && remembered) invalidateCommunitySession();
        return undefined;
      }
      // A timeout or unavailable service does not revoke a remembered session.
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      if (checking === task) checking = undefined;
    });
  checking = task;
  return task;
}

export async function readChatCapabilities(): Promise<ChatCapabilities> {
  const result =
    await communityFetch<Partial<ChatCapabilities>>("/auth/capabilities");
  return {
    wallet: result.wallet === true,
    emailSignIn: result.emailSignIn === true,
    solana: { signIn: result.solana?.signIn === true },
    ...(result.bitcoin?.signIn === true ? { bitcoin: { signIn: true } } : {}),
  };
}

export type EmailSignInChallenge = {
  ok: true;
  expiresAt: number;
  resendAfter: number;
};
function assertEmailOperationAvailable() {
  if (
    emailOperation ||
    verifying ||
    signing ||
    messageWalletSigning ||
    attaching ||
    detaching ||
    logoutRequested
  )
    throw new Error("Wait for the current sign-in.");
}
export async function startEmailCommunitySignIn(
  email: string,
  requestId: string,
): Promise<EmailSignInChallenge> {
  assertEmailOperationAvailable();
  const started = authenticationRevision;
  const task = (async () => {
    await checking?.catch(() => {});
    if (started !== authenticationRevision)
      throw new Error("Sign-in was canceled.");
    const result = await communityFetch<EmailSignInChallenge>(
      "/auth/email/login/start",
      { email, requestId },
    );
    if (started !== authenticationRevision)
      throw new Error("Sign-in was canceled.");
    if (
      result.ok !== true ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= Date.now() ||
      !Number.isSafeInteger(result.resendAfter) ||
      result.resendAfter > result.expiresAt
    )
      throw new Error("Request a new email code.");
    emailChallengeRevision = started;
    return result;
  })();
  emailOperation = task;
  try {
    return await task;
  } finally {
    if (emailOperation === task) emailOperation = undefined;
  }
}
export async function verifyEmailCommunitySignIn(
  email: string,
  code: string,
): Promise<CommunitySession> {
  assertEmailOperationAvailable();
  const started = authenticationRevision;
  if (emailChallengeRevision !== started)
    throw new Error("Request a new email code.");
  const task = (async () => {
    await checking?.catch(() => {});
    if (started !== authenticationRevision)
      throw new Error("Sign-in was canceled.");
    const result = await communityFetch<unknown>("/auth/email/login/verify", {
      email,
      code,
    }).then(settledSession);
    if (started !== authenticationRevision)
      throw new Error("Sign-in was canceled.");
    if (result.authMethod !== "email" || result.emailSignIn !== true)
      throw new Error("Your email sign-in could not be verified.");
    emailChallengeRevision = undefined;
    rememberCommunitySession(result);
    return result;
  })();
  emailOperation = task;
  try {
    return await task;
  } finally {
    if (emailOperation === task) emailOperation = undefined;
  }
}

// Sign In With Solana: the worker writes the text for the exact wallet, the
// wallet signs it, and the worker checks the Ed25519 signature. The browser
// signs only a text it parsed and found addressed to this site and wallet.
export const SOLANA_SIGN_IN_STATEMENT = "Sign in to your Templ chat.";
const CONNECT_SIGN_IN_STATEMENT = "Connect this app to your Templ workspace.";
export const SOLANA_ATTACH_STATEMENT =
  "Add this Solana wallet to your Templ account.";
export const SOLANA_CHALLENGE_UNVERIFIED =
  "The sign-in request could not be verified.";
function solanaSignInSignature(signature: string): string {
  const bytes = base58Decode(signature);
  if (bytes.length !== 64)
    throw new Error("The wallet did not sign the message.");
  return btoa(String.fromCharCode(...bytes));
}
export function checkSolanaChallenge(
  message: string,
  expected: {
    address: string;
    statement: string;
    /** For an attach challenge: the account it must be bound to. */
    principalId?: ChatPrincipalId;
    connectCode?: string;
  },
  now = Date.now(),
) {
  const parsed = parseSolanaSignInMessage(message);
  const origin = new URL(SITE.origin);
  const connectUri = expected.connectCode
    ? connectSignInUri(expected.connectCode)
    : undefined;
  if (
    !parsed ||
    parsed.address !== expected.address ||
    parsed.domain !== origin.host ||
    parsed.uri !== origin.origin ||
    parsed.statement !== expected.statement ||
    !Number.isFinite(Date.parse(parsed.expirationTime)) ||
    Date.parse(parsed.expirationTime) <= now ||
    (expected.principalId !== undefined &&
      parsed.resources[0] !== `urn:templ:principal:${expected.principalId}`) ||
    (connectUri !== undefined &&
      (parsed.resources.length !== 1 ||
        parsed.resources[0] !== connectUri ||
        !/^[A-Za-z0-9]{8,128}$/.test(parsed.nonce) ||
        !Number.isFinite(Date.parse(parsed.issuedAt))))
  )
    throw new Error(SOLANA_CHALLENGE_UNVERIFIED);
}
export type BitcoinPreview = {
  expectedPrincipalId: ChatPrincipalId;
  workspaceId: string;
  workerVersion: string;
};
export async function verifyBitcoinPreview(scope: BitcoinPreview, signal?: AbortSignal) {
  const params = new URLSearchParams(scope);
  const result = await communityFetch<{ eligible: boolean; workerVersion: string }>(
    `/auth/bitcoin/preview/capability?${params}`, undefined, signal,
  );
  return result.eligible === true && result.workerVersion === scope.workerVersion;
}

type MessageWallet = "bitcoin" | "solana";
type ConnectMessageWallet = () => Promise<Pick<SolanaSigner, "address" | "signMessage">>;

export function signInWithSolana(connect: () => Promise<SolanaSigner>, connectCode?: string) {
  return withMessageWallet(() => authenticateMessageWallet("solana", connect, connectCode));
}

export function signInWithBitcoin(connect: () => Promise<BitcoinSigner>, connectCode?: string) {
  return withMessageWallet(() => authenticateMessageWallet("bitcoin", connect, connectCode));
}

export function previewBitcoinAccount(
  operation: "add" | "sign-in",
  scope: BitcoinPreview,
  connect: () => Promise<BitcoinSigner>,
) {
  return withMessageWallet(async () => {
    if (peekCommunitySession()?.principalId !== scope.expectedPrincipalId ||
        !await verifyBitcoinPreview(scope))
      throw new Error("Bitcoin sign-in preview is unavailable.");
    if (operation === "add") {
      await attachMessageWallet("bitcoin", scope.expectedPrincipalId, connect, scope);
    } else {
      await authenticateMessageWallet("bitcoin", connect, undefined, scope);
    }
  });
}

async function withMessageWallet<T>(operation: () => Promise<T>): Promise<T> {
  if (
    verifying ||
    signing ||
    messageWalletSigning ||
    emailOperation ||
    attaching ||
    detaching ||
    logoutRequested
  )
    throw new Error("Wait for the current sign-in.");
  const entry = {
    revision: authenticationRevision,
    promise: operation(),
  };
  messageWalletSigning = entry;
  try {
    return await entry.promise;
  } finally {
    if (messageWalletSigning === entry) messageWalletSigning = undefined;
  }
}

async function authenticateMessageWallet(
  network: MessageWallet,
  connect: ConnectMessageWallet,
  connectCode?: string,
  preview?: BitcoinPreview,
): Promise<CommunitySession> {
  const route = preview ? "/auth/bitcoin/preview" : `/auth/${network}`;
  const started = authenticationRevision;
  const assertCurrent = () => {
    if (started !== authenticationRevision ||
        (preview && peekCommunitySession()?.principalId !== preview.expectedPrincipalId))
      throw new Error("Sign-in was canceled.");
  };
  // A session read can renew its cookie. It settles before a valid signed-in session;
  // reads started during this operation wait until verification finishes.
  await checking?.catch(() => {});
  assertCurrent();
  const signer = await connect();
  assertCurrent();
  const challenge = await communityFetch<{ message: string }>(
    `${route}/nonce`,
    { address: signer.address, ...(connectCode ? { connectCode } : {}), ...(preview && { ...preview, confirmed: true }) },
  );
  assertCurrent();
  const { message } = challenge;
  const signature = await signWalletChallenge(network, signer, challenge, { connectCode });
  assertCurrent();
  const task = communityFetch<unknown>(`${route}/verify`, {
    message,
    signature,
    ...(preview && { ...preview, confirmed: true }),
  }).then(settledSession);
  verifying = task;
  let session: CommunitySession;
  try {
    session = await task;
  } finally {
    if (verifying === task) verifying = undefined;
  }
  assertCurrent();
  if (
    session.authMethod !== network ||
    (preview && session.principalId !== preview.expectedPrincipalId) ||
    (network === "bitcoin" && (session.address !== null || session.walletAuthorizationExpiresAt !== null)) ||
    (network === "bitcoin" ? session.bitcoinAddress : session.solanaAddress) !== signer.address
  )
    throw new Error("The signed-in account could not be verified.");
  rememberCommunitySession(session);
  return session;
}
async function signWalletChallenge(
  network: MessageWallet,
  signer: Awaited<ReturnType<ConnectMessageWallet>>,
  challenge: { message: string },
  expected: { principalId?: ChatPrincipalId; connectCode?: string },
) {
  const { message } = challenge;
  if (network === "bitcoin") {
    if (!validateBitcoinAccountChallenge(challenge, {
      origin: window.location.origin,
      address: signer.address,
      purpose: expected.principalId ? "attach" : expected.connectCode ? "connect" : "login",
      ...expected,
    })) throw new Error("The wallet request expired or changed. Try again.");
    return signer.signMessage(message);
  }
  checkSolanaChallenge(message, {
    address: signer.address,
    statement: expected.principalId ? SOLANA_ATTACH_STATEMENT :
      expected.connectCode ? CONNECT_SIGN_IN_STATEMENT : SOLANA_SIGN_IN_STATEMENT,
    ...expected,
  });
  return solanaSignInSignature(await signer.signMessage(message));
}

export function attachSolanaWallet(principal: ChatPrincipalId, connect: () => Promise<SolanaSigner>) {
  return withMessageWallet(() => attachMessageWallet("solana", principal, connect));
}

export function attachBitcoinWallet(principal: ChatPrincipalId, connect: () => Promise<BitcoinSigner>) {
  return withMessageWallet(() => attachMessageWallet("bitcoin", principal, connect));
}

async function attachMessageWallet(
  network: MessageWallet,
  principal: ChatPrincipalId,
  connect: ConnectMessageWallet,
  preview?: BitcoinPreview,
): Promise<{ address: string; methods: unknown }> {
  const route = preview ? "/auth/bitcoin/preview/attach" : `/auth/${network}/attach`;
  const started = authenticationRevision;
  const previous = await fetchCommunitySession(true);
  if (!previous || previous.principalId !== principal)
    throw new Error("Sign in before adding a wallet.");
  const assertCurrent = () => {
    if (
      started !== authenticationRevision ||
      peekCommunitySession()?.principalId !== previous.principalId
    )
      throw new Error("The signed-in account changed. Try again.");
  };
  assertCurrent();
  const signer = await connect();
  assertCurrent();
  const challenge = await communityFetch<{ message: string }>(
    `${route}/nonce`,
    { address: signer.address, expectedPrincipalId: previous.principalId, ...(preview && { ...preview, confirmed: true }) },
  );
  assertCurrent();
  const { message } = challenge;
  const signature = await signWalletChallenge(network, signer, challenge, { principalId: previous.principalId });
  assertCurrent();
  const result = await communityFetch<{
    ok?: boolean;
    address?: string;
    methods?: unknown;
  }>(`${route}/verify`, {
    message,
    signature,
    expectedPrincipalId: previous.principalId,
    ...(preview && { ...preview, confirmed: true }),
  });
  assertCurrent();
  if (result?.ok !== true || result.address !== signer.address)
    throw new Error("The wallet connection could not be verified.");
  return { address: result.address, methods: result.methods };
}

/** Removes the EVM wallet a Solana session attached through the shared wallet
 * route, then reads the session back: the worker names the next proven
 * wallet, or none. A wallet session cannot remove the wallet that signed it
 * in; signing out is the way to drop that one. */
export function detachCommunityWallet(): Promise<CommunitySession> {
  if (detaching) return detaching;
  if (messageWalletSigning || emailOperation)
    return Promise.reject(new Error("Wait for the current sign-in."));
  const previous = peekCommunitySession();
  if (!previous) return Promise.reject(new Error("Sign in first."));
  if (previous.authMethod === "wallet")
    return Promise.reject(
      new Error("Sign out to disconnect the wallet that signed you in."),
    );
  if (!previous.address)
    return Promise.reject(new Error("This account has no wallet to remove."));
  const removed = previous.address.toLowerCase() as Address;
  const started = authenticationRevision;
  const task = (async () => {
    await checking?.catch(() => {});
    await verifying?.catch(() => {});
    if (started !== authenticationRevision)
      throw new Error("The account changed. Sign in again.");
    const wallets = validAccountWallets(
      await communityFetch<unknown>("/auth/wallets/remove", {
        address: removed,
        expectedPrincipalId: previous.principalId,
      }),
    );
    if (
      started !== authenticationRevision ||
      wallets.principalId !== previous.principalId ||
      wallets.wallets.some((entry) => entry.address === removed)
    )
      throw new Error("The account changed. Sign in again.");
    const session = await fetchCommunitySession(true);
    if (
      !session ||
      started !== authenticationRevision ||
      session.principalId !== previous.principalId ||
      session.address?.toLowerCase() === removed
    )
      throw new Error("The account changed. Sign in again.");
    return session;
  })();
  detaching = task;
  void task
    .finally(() => {
      if (detaching === task) detaching = undefined;
    })
    .catch(() => {});
  return task;
}

function connectSignInUri(code: string) {
  if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code))
    throw new Error(
      "This connect code is invalid. Ask your AI tool for a new link.",
    );
  return `${SITE.origin}/connect/${code}`;
}

async function authenticate(
  account: Address,
  ready: Ready,
  fresh = false,
  connectCode?: string,
) {
  const connectUri = connectCode ? connectSignInUri(connectCode) : undefined;
  const started = authenticationRevision;
  const assertCurrent = () => {
    if (started !== authenticationRevision)
      throw new Error("Sign-in was canceled when you disconnected.");
  };
  // Recheck the cookie before any interactive request, even if its soft cache expired.
  // The private entry point waits for any earlier check but does not wait on
  // this sign-in itself. Public checks are held until this operation completes.
  // The wallet's readiness check runs meanwhile; the nonce request still waits
  // for both, so no challenge is asked for before the cookie check settles.
  const readiness = ready();
  readiness.catch(() => {});
  const existing = await checkCommunitySession(true);
  assertCurrent();
  if (
    !fresh &&
    !connectCode &&
    existing?.authMethod === "wallet" &&
    existing.address?.toLowerCase() === account.toLowerCase()
  )
    return;
  const signer = await readiness;
  assertCurrent();
  const chainId = signer.chain?.id ?? DEFAULT_CHAT_AUTH_CHAIN_ID;
  if (!isChatChainId(chainId))
    throw new Error("Choose a supported wallet network.");
  const { message } = await communityFetch<{ message: string }>("/auth/nonce", {
    address: account,
    chainId,
    ...(connectCode ? { connectCode } : {}),
  });
  assertCurrent();
  const parsed = parseSiweMessage(message);
  if (
    parsed.domain !== new URL(SITE.origin).host ||
    parsed.uri !== SITE.origin ||
    parsed.scheme !== "https" ||
    parsed.chainId !== chainId ||
    parsed.address?.toLowerCase() !== account.toLowerCase() ||
    parsed.statement !==
      (connectCode
        ? CONNECT_SIGN_IN_STATEMENT
        : "Sign in to your Templ chat.") ||
    (connectUri !== undefined &&
      (parsed.resources?.length !== 1 ||
        parsed.resources[0] !== connectUri ||
        !/^[A-Za-z0-9]{8,128}$/.test(parsed.nonce ?? "") ||
        !parsed.issuedAt ||
        !Number.isFinite(parsed.issuedAt.getTime()))) ||
    !parsed.expirationTime ||
    !Number.isFinite(parsed.expirationTime.getTime()) ||
    parsed.expirationTime.getTime() <= Date.now()
  )
    throw new Error("The sign-in request could not be verified.");
  if (signer.account.address.toLowerCase() !== account.toLowerCase())
    throw new Error("Your wallet account changed. Start again.");
  const signature = await signer.signMessage({
    account: signer.account,
    message,
  });
  assertCurrent();
  // Selection may change while the wallet prompt is open. Never replace another
  // account's cookie using a signature that just finished for the previous account.
  const current = await ready();
  assertCurrent();
  if (
    current.account.address.toLowerCase() !== account.toLowerCase() ||
    (current.chain?.id ?? DEFAULT_CHAT_AUTH_CHAIN_ID) !== chainId
  )
    throw new Error("Your wallet account changed. Start again.");
  const request = communityFetch<CommunitySession>("/auth/verify", {
    message,
    signature,
  }).then(settledSession);
  verifying = request;
  let session: CommunitySession;
  try {
    session = await request;
  } finally {
    if (verifying === request) verifying = undefined;
  }
  assertCurrent();
  if (session.address?.toLowerCase() !== account.toLowerCase())
    throw new Error("The signed-in account could not be verified.");
  rememberCommunitySession(session);
}

/** Adds an EVM wallet to the signed-in account through the shared wallet
 * route (`/auth/wallets/nonce` and `/auth/wallets/verify`), for an EVM or a
 * Solana session, then reads the session back so its verified wallet
 * reflects the account. */
export function attachCommunityWallet(
  account: Address,
  ready: Ready,
  chainId?: ChatChainId,
  expectedPrincipal?: ChatPrincipalId,
): Promise<CommunitySession> {
  if (attaching)
    return Promise.reject(new Error("Wait for the wallet connection."));
  const task = attachWallet(account, ready, chainId, expectedPrincipal);
  attaching = task;
  void task
    .finally(() => {
      if (attaching === task) attaching = undefined;
    })
    .catch(() => {});
  return task;
}
async function attachWallet(
  account: Address,
  ready: Ready,
  network?: ChatChainId,
  expectedPrincipal?: ChatPrincipalId,
) {
  if (
    signing ||
    messageWalletSigning ||
    emailOperation ||
    verifying ||
    detaching ||
    logoutRequested
  )
    throw new Error("Wait for the current sign-in.");
  const previous = await fetchCommunitySession(true);
  if (!previous) throw new Error("Sign in before adding a wallet.");
  if (expectedPrincipal && previous.principalId !== expectedPrincipal)
    throw new Error("The signed-in account changed. Try again.");
  if (previous.address?.toLowerCase() === account.toLowerCase())
    return previous;
  const started = authenticationRevision;
  const assertCurrent = () => {
    if (
      started !== authenticationRevision ||
      peekCommunitySession()?.principalId !== previous.principalId
    )
      throw new Error("The signed-in account changed. Try again.");
  };
  const signer = await ready(network);
  assertCurrent();
  const chainId = network ?? signer.chain?.id ?? DEFAULT_CHAT_AUTH_CHAIN_ID;
  if (!isChatChainId(chainId))
    throw new Error("Choose a supported wallet network.");
  if (signer.account.address.toLowerCase() !== account.toLowerCase())
    throw new Error("Your wallet changed. Try again.");
  const lowered = account.toLowerCase() as Address;
  const challenge = validWalletChallenge(
    await communityFetch<unknown>("/auth/wallets/nonce", {
      address: lowered,
      chainId,
      expectedPrincipalId: previous.principalId,
    }),
  );
  assertCurrent();
  checkWalletChallenge(challenge, {
    address: account,
    chainId,
    principalId: previous.principalId,
  });
  const signature = await signer.signMessage({
    account: signer.account,
    message: challenge.message,
  });
  assertCurrent();
  const selected = await ready(network);
  if (
    selected.account.address.toLowerCase() !== account.toLowerCase() ||
    (network ?? selected.chain?.id ?? DEFAULT_CHAT_AUTH_CHAIN_ID) !== chainId
  )
    throw new Error("Your wallet changed. Try again.");
  const wallets = validAccountWallets(
    await communityFetch<unknown>("/auth/wallets/verify", {
      message: challenge.message,
      signature,
      expectedPrincipalId: previous.principalId,
    }),
  );
  assertCurrent();
  if (
    !sameAccount(previous.principalId, wallets.principalId, wallets.wallets) ||
    !wallets.wallets.some((entry) => entry.address === lowered)
  )
    throw new Error("The wallet connection could not be verified.");
  const session = await fetchCommunitySession(true);
  // The remembered session now carries the account the worker answered with,
  // which for a bare wallet is the account minted a moment ago.
  if (
    started !== authenticationRevision ||
    !session ||
    session.principalId !== wallets.principalId ||
    !sameAccount(previous.principalId, session.principalId, wallets.wallets)
  )
    throw new Error("The wallet connection could not be verified.");
  return session;
}
/** A bare wallet gains its account id when a second wallet joins it: the
 * worker answers with the minted `account:` principal and lists the wallet
 * that was the principal until now. Anything else is another account. */
function sameAccount(
  previous: ChatPrincipalId,
  next: ChatPrincipalId,
  wallets: { address: Address }[],
) {
  return (
    next === previous ||
    (!previous.startsWith("account:") &&
      next.startsWith("account:") &&
      wallets.some((entry) => entry.address === previous.toLowerCase()))
  );
}

/** One interactive challenge at a time: its nonce cookie is shared by all rooms. */
export function signInCommunity(
  account: Address,
  ready: Ready,
  fresh = false,
  connectCode?: string,
): Promise<void> {
  if (logoutRequested)
    return signOutCommunity().then(() =>
      signInCommunity(account, ready, fresh, connectCode),
    );
  if (attaching || messageWalletSigning || emailOperation || (verifying && !signing))
    return Promise.reject(new Error("Wait for the current sign-in."));
  if (signing) {
    if (signing.revision !== authenticationRevision)
      return Promise.reject(
        new Error("Close the previous wallet request, then sign in again."),
      );
    if (signing.connectCode !== connectCode)
      return Promise.reject(new Error("Wait for the current sign-in."));
    if (signing.account === account.toLowerCase()) return signing.promise;
    const started = authenticationRevision;
    return signing.promise
      .catch(() => {})
      .then(() => {
        if (started !== authenticationRevision)
          throw new Error("Sign-in was canceled when you disconnected.");
        return signInCommunity(account, ready, fresh, connectCode);
      });
  }
  const entry = {
    account: account.toLowerCase(),
    revision: authenticationRevision,
    connectCode,
    promise: authenticate(account, ready, fresh, connectCode),
  };
  signing = entry;
  const finished = () => {
    if (signing === entry) signing = undefined;
  };
  void entry.promise.then(finished, finished);
  return entry.promise;
}

/** Explicit user disconnect only. Route changes and provider events do not revoke the cookie. */
export function signOutCommunity(): Promise<void> {
  return requestSignOut(true);
}
function requestSignOut(broadcast: boolean): Promise<void> {
  if (ending) return ending;
  ++authenticationRevision;
  logoutRequested = true;
  invalidateCommunitySession();
  if (broadcast && typeof window !== "undefined") publishSessionEvent("logout");
  // A signed-out device stops getting workspace push alerts.
  void dropDevicePushAlerts();
  const task = (async () => {
    // Set-Cookie responses must settle before revocation. A wallet prompt does
    // not need to finish: the revision above prevents its later verification.
    await checking?.catch(() => {});
    await verifying?.catch(() => {});
    await emailOperation?.catch(() => {});
    emailChallengeRevision = undefined;
    await detaching?.catch(() => {});
    await communityFetch("/auth/logout", {});
    invalidateCommunitySession();
    logoutRequested = false;
  })();
  ending = task;
  const finished = () => {
    if (ending === task) ending = undefined;
  };
  void task.then(finished, finished);
  return task;
}
