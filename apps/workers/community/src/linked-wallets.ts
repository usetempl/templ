import { bitcoinAccountAvailable } from "./bitcoin-account-availability";
import { isHex, recoverMessageAddress, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import {
  DEFAULT_CHAT_AUTH_CHAIN_ID,
  isChatChainId,
  isSupportSiweChainId,
  type ChatChainId,
  type SupportSiweChainId,
} from "@templ/chat/chains";
import {
  isAuthMethod,
  type AuthMethod,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  ACCOUNT_METHOD_LIMITS,
  WALLET_LINK_RESOURCE_PREFIXES,
  WALLET_LINK_STATEMENT,
  type AccountWallets,
  type ProvenWallet,
} from "@templ/chat/wallets";
import {
  accountIdentity,
  ensureAccount,
  identityStore,
  LINKED_WALLETS_PREFIX,
  requireAnotherWallet,
  type AccountIdentity,
} from "./account-identity";
import type { AuthData } from "./auth-record";
import { walletAuthChain } from "./chain-config";
import type { verifyWallet } from "./chain";
import {
  address,
  config,
  cookie,
  HttpError,
  json,
  NONCE_COOKIE,
  NONCE_TTL,
  randomToken,
  readCookie,
  readJson,
  record,
  SESSION_COOKIE,
  type Env,
} from "./common";
import { principal } from "./principal";
import { requestPrefetch, started, timed } from "./request-context";
import { recordCostMetric } from "./cost-observability";
import { sessionCacheKey } from "./session-key";
import { sessionPrincipals, type ServiceSession } from "./service-principals";

/** Several proven wallets on one canonical
 * account. Every wallet link is a fresh SIWE (ERC-1271 on Robinhood only)
 * proof bound to this account, this session and the current wallet revision;
 * one EVM address belongs to at most one account at a time. Every
 * proven wallet also signs in to the account (`wallet-login` in
 * account-identity.ts); the wallet that signed a session in is its
 * `X-Verified-Wallet`. Wallet authority still needs the SIWE proof of the
 * current session. Any change bumps the account's linked revision and the
 * session's wallet revision; removing a wallet ends the sessions it signed
 * in. */
export { LINKED_WALLETS_PREFIX } from "./account-identity";
export const WALLET_OWNER_PREFIX = "identity-wallet:";
const PROFILE_PREFIX = "identity-profile:";
export const MAX_PROVEN_WALLETS = ACCOUNT_METHOD_LIMITS.wallets;
export const WALLET_LINKED_ELSEWHERE_ERROR =
  "That wallet is linked to another Templ account. Remove it there first.";
/** The wallet is an account of its own (it has signed in before); there is
 * no remove action for that, so the copy says what the product offers. */
export const WALLET_OWN_ACCOUNT_ERROR =
  "That wallet already signs in to Templ on its own. Sign in with it to link the other way.";
export const WALLET_LIMIT_ERROR = `This account already has ${MAX_PROVEN_WALLETS} wallets. Remove one first.`;
export const WALLET_ALREADY_LINKED_ERROR =
  "That wallet is already on this account.";
export const WALLET_NOT_LINKED_ERROR = "That wallet is not on this account.";
/** A wallet that left the account no longer opens sessions. */
export const REMOVED_METHOD_ERROR =
  "That wallet was removed from the account. Sign in again.";
export const WALLETS_UNAVAILABLE_ERROR =
  "Account wallets are temporarily unavailable.";
export const LINKED_WALLET_ROUTES = [
  "/auth/wallets",
  "/auth/wallets/nonce",
  "/auth/wallets/verify",
  "/auth/wallets/remove",
] as const;
const LINKED_OPS = [
  "identity-read",
  "wallets-read",
  "wallet-check",
  "wallet-add",
  "wallet-remove",
] as const;

/** Identity DO record under `identity-linked-wallets:<canonical>`. Linked
 * wallets exclude the primary (sign-in or adopted) wallet, which the account
 * identity already names; `primary` keeps the facts the worker last verified
 * for it (seeded from the session's proven wallet identity on every read). */
export type StoredLinkedWallet = {
  address: Address;
  kind: "eoa" | "contract";
  chainId: ChatChainId;
  provenAt: number;
};
export type LinkedWalletsRecord = {
  wallets: StoredLinkedWallet[];
  primary?: StoredLinkedWallet;
  revision: number;
  /** Vault delegation data. Kept as stored and never read. */
  vaults?: unknown[];
};
export type LinkedWalletSet = {
  principalId: ChatPrincipalId;
  wallets: ProvenWallet[];
  revision: number;
};
type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
const linkedKey = (id: ChatPrincipalId) => `${LINKED_WALLETS_PREFIX}${id}`;
const ownerKey = (wallet: Address) => `${WALLET_OWNER_PREFIX}${wallet}`;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const iso = (ms: number) => new Date(ms).toISOString();

function checkedWallet(raw: unknown): StoredLinkedWallet | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as StoredLinkedWallet;
  return typeof value.address === "string" &&
    /^0x[0-9a-f]{40}$/.test(value.address) &&
    (value.kind === "eoa" || value.kind === "contract") &&
    isChatChainId(value.chainId) &&
    natural(value.provenAt)
    ? value
    : null;
}
function checkedRecord(raw: unknown): LinkedWalletsRecord {
  const empty: LinkedWalletsRecord = { wallets: [], revision: 0 };
  if (!raw || typeof raw !== "object") return empty;
  const value = raw as LinkedWalletsRecord;
  const wallets = Array.isArray(value.wallets)
    ? value.wallets
        .map(checkedWallet)
        .filter((w): w is StoredLinkedWallet => !!w)
    : [];
  const primary = checkedWallet(value.primary) ?? undefined;
  return {
    wallets: wallets.slice(0, MAX_PROVEN_WALLETS),
    ...(primary ? { primary } : {}),
    revision: natural(value.revision) ? value.revision : 0,
    ...(Array.isArray(value.vaults) ? { vaults: value.vaults } : {}),
  };
}
/** The current canonical account record. Linked-wallet state is never read
 * from an alias: an alias proves identity, but it cannot supply token
 * authority or import a second wallet set. */
async function loadRecord(storage: Storage, identity: AccountIdentity) {
  return checkedRecord(await storage.get(linkedKey(identity.principalId)));
}
async function saveRecord(
  storage: Storage,
  identity: AccountIdentity,
  record: LinkedWalletsRecord,
) {
  record.revision += 1;
  await storage.put(linkedKey(identity.principalId), record);
  return record;
}
/** Addresses this account has proven: the primary wallet first, then links.
 * The primary's kind and chain default to the worker's conservative
 * assumption (a contract on Robinhood) until a session proves otherwise. */
function walletView(
  identity: AccountIdentity,
  record: LinkedWalletsRecord,
): ProvenWallet[] {
  const primary = identity.wallet;
  const linked = record.wallets.filter((w) => w.address !== primary);
  return [
    ...(primary
      ? [
          {
            address: primary,
            kind:
              record.primary?.address === primary
                ? record.primary.kind
                : "contract",
            chainId:
              record.primary?.address === primary
                ? record.primary.chainId
                : 4663,
            provenAt: iso(
              record.primary?.address === primary ? record.primary.provenAt : 0,
            ),
            primary: true,
          } satisfies ProvenWallet,
        ]
      : []),
    ...linked.map((w) => ({
      address: w.address,
      kind: w.kind,
      chainId: w.chainId,
      provenAt: iso(w.provenAt),
      primary: false,
    })),
  ];
}
export async function readLinkedWallets(
  storage: Storage,
  identity: AccountIdentity,
): Promise<LinkedWalletSet> {
  const record = await loadRecord(storage, identity);
  return {
    principalId: identity.principalId,
    wallets: walletView(identity, record),
    revision: record.revision,
  };
}
/** Keeps the primary wallet's facts current from the session the worker just
 * verified. Written only when they are missing or changed (a proof on another
 * network, an EOA that was assumed to be a contract), never with a revision
 * bump: the linked set itself did not change. */
async function seedPrimary(
  storage: Storage,
  identity: AccountIdentity,
  record: LinkedWalletsRecord,
  raw: unknown,
  now: number,
) {
  if (!raw || typeof raw !== "object" || !identity.wallet) return;
  const facts = raw as { address?: unknown; kind?: unknown; chainId?: unknown };
  if (
    facts.address !== identity.wallet ||
    (facts.kind !== "eoa" && facts.kind !== "contract") ||
    !isChatChainId(facts.chainId)
  )
    return;
  const current = record.primary;
  if (
    current?.address === identity.wallet &&
    current.kind === facts.kind &&
    current.chainId === facts.chainId
  )
    return;
  record.primary = {
    address: identity.wallet,
    kind: facts.kind,
    chainId: facts.chainId,
    provenAt: now,
  };
  await storage.put(linkedKey(identity.principalId), record);
}
async function ownerOf(storage: Storage, wallet: Address) {
  const owner = await storage.get<string>(ownerKey(wallet));
  return owner ? principal(owner) : null;
}
/** Frees a wallet's owner index when it names this account or its retained
 * wallet alias, so the wallet can sign in or join another account. */
async function releaseOwner(
  storage: Storage,
  identity: AccountIdentity,
  wallet: Address,
) {
  const owner = await ownerOf(storage, wallet);
  if (owner && identity.servicePrincipals.includes(owner))
    await storage.delete(ownerKey(wallet));
}
/** A wallet may join this account only while no other account holds it: no
 * owner index, no historical wallet profile of its own, or an index that
 * already names this account or its retained wallet alias. A wallet whose
 * index names itself, or that has a profile of its own, is its own account:
 * that gets its own message, since there is nothing to remove elsewhere. */
async function requireLinkable(
  storage: Storage,
  identity: AccountIdentity,
  wallet: Address,
) {
  const owner = await ownerOf(storage, wallet);
  if (owner && !identity.servicePrincipals.includes(owner))
    throw new HttpError(
      409,
      owner === wallet
        ? WALLET_OWN_ACCOUNT_ERROR
        : WALLET_LINKED_ELSEWHERE_ERROR,
    );
  if (
    !owner &&
    !identity.servicePrincipals.includes(wallet) &&
    (await storage.get(`${PROFILE_PREFIX}${wallet}`)) !== undefined
  )
    throw new HttpError(409, WALLET_OWN_ACCOUNT_ERROR);
}
function walletFacts(body: Record<string, unknown>): StoredLinkedWallet {
  const kind = body.kind;
  if (kind !== "eoa" && kind !== "contract")
    throw new HttpError(400, "Invalid wallet proof.");
  if (!isChatChainId(body.chainId))
    throw new HttpError(400, "Choose a supported wallet network.");
  if (!natural(body.provenAt))
    throw new HttpError(400, "Invalid wallet proof.");
  return {
    address: address(body.address),
    kind,
    chainId: body.chainId,
    provenAt: body.provenAt,
  };
}

/** Identity DO operations. Runs inside the identity transaction; the caller
 * (auth-record.ts) dispatches `/identity` bodies whose op belongs here. */
export async function linkedWalletsRequest(
  storage: Storage,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  const identity = await accountIdentity(storage, principal(body.principalId));
  const view = async () => json(await readLinkedWallets(storage, identity));
  switch (body.op) {
    case "identity-read":
      return json({
        identity,
        linked: await readLinkedWallets(storage, identity),
      });
    case "wallets-read": {
      const record = await loadRecord(storage, identity);
      await seedPrimary(storage, identity, record, body.primary, now);
      return json(await readLinkedWallets(storage, identity));
    }
    case "wallet-check": {
      const wallet = address(body.address);
      const record = await loadRecord(storage, identity);
      if (
        wallet === identity.wallet ||
        record.wallets.some((w) => w.address === wallet)
      )
        throw new HttpError(409, WALLET_ALREADY_LINKED_ERROR);
      if (walletView(identity, record).length >= MAX_PROVEN_WALLETS)
        throw new HttpError(409, WALLET_LIMIT_ERROR);
      await requireLinkable(storage, identity, wallet);
      return view();
    }
    case "wallet-add": {
      const facts = walletFacts(body);
      // The primary wallet is never a linked entry; its facts come from the
      // session that proves it. A bare wallet adding a second
      // wallet becomes an account, with the first wallet as its alias.
      const owner = await ensureAccount(storage, identity);
      const record = await loadRecord(storage, owner);
      if (
        facts.address === owner.wallet ||
        record.wallets.some((w) => w.address === facts.address)
      )
        throw new HttpError(409, WALLET_ALREADY_LINKED_ERROR);
      if (walletView(owner, record).length >= MAX_PROVEN_WALLETS)
        throw new HttpError(409, WALLET_LIMIT_ERROR);
      await requireLinkable(storage, owner, facts.address);
      record.wallets.push(facts);
      await storage.put(ownerKey(facts.address), owner.principalId);
      await saveRecord(storage, owner, record);
      return json(await readLinkedWallets(storage, owner));
    }
    case "wallet-remove": {
      // Any wallet leaves while another wallet, EVM or Solana,
      // remains on the account.
      const wallet = address(body.address);
      const record = await loadRecord(storage, identity);
      const primary =
        wallet === identity.wallet ||
        identity.servicePrincipals.includes(wallet);
      if (!primary && !record.wallets.some((w) => w.address === wallet))
        throw new HttpError(404, WALLET_NOT_LINKED_ERROR);
      await requireAnotherWallet(
        storage,
        identity,
        "wallets",
        body.bitcoinAvailable === true,
      );
      record.wallets = record.wallets.filter((w) => w.address !== wallet);
      if (record.primary?.address === wallet) delete record.primary;
      await releaseOwner(storage, identity, wallet);
      if (!primary) {
        await saveRecord(storage, identity, record);
        return view();
      }
      // The original alias leaves: its history stays under its own id and
      // the wallet can sign in on its own again.
      const updated: AccountIdentity = {
        ...identity,
        wallet: null,
        servicePrincipals: [identity.principalId],
      };
      await storage.put(`${PROFILE_PREFIX}${identity.principalId}`, updated);
      await saveRecord(storage, updated, record);
      return json(await readLinkedWallets(storage, updated));
    }
    default:
      throw new HttpError(400, "Invalid account operation.");
  }
}
/** `/identity` dispatch for the ops above; other ops fall through to
 * account-identity.ts. Reads a clone so the fall-through can read the body. */
export async function linkedWalletsRecordRequest(
  request: Request,
  state: DurableObjectState,
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/identity" ||
    request.method !== "POST"
  )
    return null;
  const body = await readJson(request.clone(), 8192);
  if (!LINKED_OPS.includes(body.op as (typeof LINKED_OPS)[number])) return null;
  return state.storage.transaction((storage) =>
    linkedWalletsRequest(storage, body, Date.now()),
  );
}

/** AuthRecord `/wallets/revision`: bumps the session's wallet revision after
 * a linked-set change so every lease key derived from it changes. Works for
 * EVM and Solana wallet sessions; the sign-in authority itself is untouched. */
export async function bumpWalletRevision(
  storage: Pick<DurableObjectTransaction, "get" | "put">,
  body: Record<string, unknown>,
  now: number,
  key = "record",
): Promise<Response> {
  const expectedRevision = body.expectedRevision;
  const expected = Array.isArray(body.expectedPrincipalIds)
    ? body.expectedPrincipalIds.map(principal)
    : [principal(body.expectedPrincipalId)];
  if (!natural(expectedRevision))
    throw new HttpError(400, "Invalid wallet authorization revision.");
  const entry = await storage.get<AuthData>(key);
  if (
    !entry ||
    entry.expiresAt <= now ||
    !Number.isSafeInteger(entry.authorizationExpiresAt) ||
    entry.authorizationExpiresAt! <= now ||
    !Number.isSafeInteger(entry.walletRevision) ||
    !isAuthMethod(entry.authMethod) ||
    entry.nonce ||
    entry.message
  )
    return json({ error: "Session expired." }, 401);
  if (!entry.principalId || !expected.includes(principal(entry.principalId)))
    return json(
      { error: "This wallet request belongs to another account." },
      403,
    );
  if (entry.walletRevision !== expectedRevision)
    return json({ error: "Your sign-in changed. Try again." }, 409);
  // A session opened by a bare wallet follows its minted account.
  const canonical =
    typeof body.canonicalPrincipalId === "string"
      ? principal(body.canonicalPrincipalId)
      : null;
  const previous = principal(entry.principalId);
  if (
    canonical &&
    canonical !== previous &&
    (!canonical.startsWith("account:") || previous.startsWith("account:"))
  )
    return json(
      { error: "This wallet request belongs to another account." },
      403,
    );
  const updated: AuthData = {
    ...entry,
    ...(canonical && canonical !== previous
      ? { principalId: canonical, servicePrincipals: [canonical, previous] }
      : {}),
    walletRevision: expectedRevision + 1,
  };
  await storage.put(key, updated);
  return json(updated);
}

/** Worker-side call that keeps the identity object's 400/404/409 messages. */
export async function linkedWalletsCall<T = LinkedWalletSet>(
  env: Env,
  body: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await timed(
      env,
      "identity",
      identityStore(env).fetch(
        new Request("https://internal/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  } catch {
    throw new HttpError(503, WALLETS_UNAVAILABLE_ERROR);
  }
  if (!response.ok) {
    const error = (
      await response
        .json<{ error?: string }>()
        .catch((): { error?: string } => ({}))
    ).error;
    if ([400, 404, 409, 503].includes(response.status) && error)
      throw new HttpError(response.status, error);
    throw new HttpError(503, WALLETS_UNAVAILABLE_ERROR);
  }
  return response.json<T>();
}
/** The identity plus its linked set in one round trip for `currentSession`. */
export async function sessionIdentity(env: Env, principalId: ChatPrincipalId) {
  try {
    return await linkedWalletsCall<{
      identity: AccountIdentity;
      linked: LinkedWalletSet;
    }>(env, {
      op: "identity-read",
      principalId,
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) throw error;
    throw new HttpError(503, "Account details are temporarily unavailable.");
  }
}
/** `sessionIdentity` with the read latency counters. */
export function measuredSessionIdentity(
  env: Env,
  principalId: ChatPrincipalId,
) {
  const identityStarted = Date.now();
  return sessionIdentity(env, principalId).finally(() => {
    const elapsed = Date.now() - identityStarted;
    recordCostMetric(env, "identityReads");
    recordCostMetric(
      env,
      elapsed < 100
        ? "identityUnder100"
        : elapsed < 500
          ? "identityUnder500"
          : elapsed < 1000
            ? "identityUnder1000"
            : "identityOver1000",
    );
  });
}
/** Starts the identity read for a principal the request names in its hint.
 * `currentSession` uses it only when the session record names exactly this
 * principal. */
export function prefetchSessionIdentity(
  env: Env,
  principalId: ChatPrincipalId,
) {
  requestPrefetch(env).identity = {
    principalId,
    read: started(measuredSessionIdentity(env, principalId)),
  };
}
/** The network a verified SIWE proof named: one widget sign-in may bind
 * (the app's own challenges use a subset of these). A proof that names none
 * reads as the app's default, as walletAuthChain always has. */
function siweChain(
  value: unknown = DEFAULT_CHAT_AUTH_CHAIN_ID,
): SupportSiweChainId {
  if (!isSupportSiweChainId(value))
    throw new HttpError(400, "Choose a supported wallet network.");
  return value;
}
/** What a verified SIWE proof says about its wallet. The wallet
 * is an EOA when the signature recovers to it; otherwise a contract wallet
 * whose proof was verified through ERC-1271 on SMART_WALLET_AUTH_CHAIN_ID.
 * The chain is the one the server-chosen message named. */
export async function provenWalletFacts(
  message: string,
  signature: Hex,
  wallet: Address,
): Promise<{ kind: "eoa" | "contract"; chainId: SupportSiweChainId }> {
  let kind: "eoa" | "contract" = "contract";
  try {
    if (
      (await recoverMessageAddress({ message, signature })).toLowerCase() ===
      wallet
    )
      kind = "eoa";
  } catch {
    /* A smart-wallet proof was verified through ERC-1271 on
       SMART_WALLET_AUTH_CHAIN_ID. */
  }
  return { kind, chainId: siweChain(parseSiweMessage(message).chainId) };
}
/** A session stays open only while the wallet that opened it is
 * still on the account. A stored session of an unknown kind ends with 401; an
 * EVM wallet session whose wallet left an account ends with 401; a Solana
 * session whose attached EVM wallet left is detached from it and continues
 * without EVM wallet authority. Bare wallets have nothing to remove, so their
 * sessions are never touched here. (`currentSession` ends a Solana session
 * whose own wallet left.) */
export async function enforceSessionMethod(
  env: Env,
  token: string,
  data: AuthData,
  read: Awaited<ReturnType<typeof sessionIdentity>>,
): Promise<AuthData> {
  const sessionRecord = await record(env, "session", token);
  const end = async () => {
    await sessionRecord.fetch(internalPost("/revoke", {}));
    throw new HttpError(401, REMOVED_METHOD_ERROR);
  };
  if (!isAuthMethod(data.authMethod)) return end();
  const method = data.authMethod;
  if (!data.address || !read.identity.principalId.startsWith("account:"))
    return data;
  // A widget contract wallet is never a linked wallet;
  // its account is bound to that chain and address, and to nothing else.
  if (data.contractChain !== undefined)
    return read.identity.contract?.chainId === data.contractChain &&
      read.identity.contract.address === data.address &&
      data.widgetScope
      ? data
      : end();
  if (walletSignsIn(read.linked, address(data.address))) return data;
  if (method === "wallet") return end();
  const detached = await sessionRecord.fetch(
    internalPost("/wallet/detach", {
      expectedPrincipalId: data.principalId,
      expectedRevision: data.walletRevision,
    }),
  );
  if (!detached.ok)
    throw new HttpError(
      detached.status === 409 ? 409 : 503,
      "Wallet authorization changed. Try again.",
    );
  return detached.json<AuthData>();
}
export function accountWalletsView(linked: LinkedWalletSet): AccountWallets {
  return {
    principalId: linked.principalId,
    wallets: linked.wallets,
    walletRevision: linked.revision,
  };
}

/** What the worker's session carries from the linked set. */
export type LinkedSession = ServiceSession & {
  token: string;
  address: Address | null;
  authMethod: AuthMethod;
  expiresAt: number;
  walletRevision: number;
  /** The facts the worker verified for the sign-in wallet on this read. */
  walletIdentity?: {
    address: Address;
    kind: "eoa" | "contract";
    chainId: SupportSiweChainId;
  };
  wallets?: ProvenWallet[];
};
/** Whether `wallet` still belongs to the account's proven set
 * (its original alias or a linked wallet). A session opened or extended by a
 * wallet that left the account ends on its next read. */
export function walletSignsIn(
  linked: Pick<LinkedSetView, "wallets">,
  wallet: Address | null | undefined,
) {
  return !!wallet && linked.wallets.some((w) => w.address === wallet);
}
type LinkedSetView = { wallets: { address: Address }[] };
export type LinkedWalletRouteAuth<S extends LinkedSession = LinkedSession> = {
  session: () => Promise<S>;
  guard: (body: Record<string, unknown>, session: S) => void;
  verifyWallet: typeof verifyWallet;
};
const internalPost = (path: string, body: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
export async function bumpSessionRevision<S extends LinkedSession>(
  env: Env,
  session: S,
  canonicalPrincipalId?: ChatPrincipalId,
) {
  const changed = await (
    await record(env, "session", session.token)
  ).fetch(
    internalPost("/wallets/revision", {
      expectedPrincipalIds: sessionPrincipals(session),
      expectedRevision: session.walletRevision,
      ...(canonicalPrincipalId ? { canonicalPrincipalId } : {}),
    }),
  );
  if (!changed.ok)
    throw new HttpError(
      changed.status === 409
        ? 409
        : changed.status === 403
          ? 403
          : changed.status === 401
            ? 401
            : 503,
      changed.status === 401
        ? "Your chat session has expired. Sign in again."
        : "Your sign-in changed. Try again.",
    );
}

/** `GET /auth/wallets` and `POST /auth/wallets/nonce|verify|remove`.
 * Returns null for any other path. */
export async function linkedWalletsRoute<S extends LinkedSession>(
  request: Request,
  env: Env,
  auth: LinkedWalletRouteAuth<S>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname as (typeof LINKED_WALLET_ROUTES)[number];
  if (!LINKED_WALLET_ROUTES.includes(path)) return null;
  if (
    path === "/auth/wallets"
      ? request.method !== "GET"
      : request.method !== "POST"
  )
    throw new HttpError(404, "Not found.");
  const session = await auth.session();
  const cfg = config(env);
  const current = async () =>
    accountWalletsView(
      await linkedWalletsCall(env, {
        op: "wallets-read",
        principalId: session.principalId,
        // Widget sessions never reach these routes; an app session's proof
        // names one of the app's own networks.
        ...(session.walletIdentity &&
        isChatChainId(session.walletIdentity.chainId)
          ? { primary: session.walletIdentity }
          : {}),
      }),
    );
  if (path === "/auth/wallets") {
    const expected = url.searchParams.get("expectedPrincipalId");
    if (expected !== null)
      auth.guard({ expectedPrincipalId: expected }, session);
    return json(await current());
  }
  const body = await readJson(request, 12_288);
  auth.guard(body, session);
  const sessionKey = await sessionCacheKey(session.token);
  if (path === "/auth/wallets/nonce") {
    const wallet = address(body.address);
    const chainId = walletAuthChain(body.chainId);
    await linkedWalletsCall(env, {
      op: "wallet-check",
      principalId: session.principalId,
      address: wallet,
    });
    const nonce = randomToken();
    const now = Date.now();
    const expiresAt = Math.min(now + NONCE_TTL, session.expiresAt);
    const message = createSiweMessage({
      address: wallet,
      chainId,
      domain: cfg.origin.host,
      scheme: "https",
      uri: cfg.origin.origin,
      version: "1",
      nonce,
      statement: WALLET_LINK_STATEMENT,
      resources: [
        `${WALLET_LINK_RESOURCE_PREFIXES.principal}${session.principalId}`,
        `${WALLET_LINK_RESOURCE_PREFIXES.session}${sessionKey}`,
        `${WALLET_LINK_RESOURCE_PREFIXES.walletRevision}${session.walletRevision}`,
      ],
      issuedAt: new Date(now),
      expirationTime: new Date(expiresAt),
    });
    const challenge: AuthData = {
      address: wallet,
      principalId: session.principalId,
      purpose: "wallet-add",
      sessionKey,
      walletRevision: session.walletRevision,
      message,
      nonce,
      expiresAt,
    };
    const saved = await (
      await record(env, "nonce", nonce)
    ).fetch(internalPost("/create", challenge));
    if (!saved.ok)
      throw new HttpError(503, "Could not create a wallet challenge.");
    return json({ message, expiresAt }, 200, {
      "Set-Cookie": cookie(
        NONCE_COOKIE,
        nonce,
        Math.floor((expiresAt - now) / 1000),
      ),
    });
  }
  if (path === "/auth/wallets/verify") {
    if (
      typeof body.message !== "string" ||
      typeof body.signature !== "string" ||
      !isHex(body.signature) ||
      body.signature.length > 8194
    )
      throw new HttpError(400, "Invalid signed message.");
    const nonce = readCookie(request, NONCE_COOKIE);
    if (!nonce) throw new HttpError(401, "Request a new wallet challenge.");
    const consumed = await (
      await record(env, "nonce", nonce)
    ).fetch(internalPost("/consume", {}));
    if (!consumed.ok)
      throw new HttpError(
        consumed.status === 401 ? 401 : 503,
        "Request a new wallet challenge.",
      );
    const challenge = await consumed.json<AuthData>();
    // Exact message equality binds the server-chosen chain, origin, address,
    // statement, resources and times; the resources bind this account.
    if (
      challenge.purpose !== "wallet-add" ||
      challenge.principalId !== session.principalId ||
      challenge.sessionKey !== sessionKey ||
      challenge.walletRevision !== session.walletRevision ||
      challenge.nonce !== nonce ||
      challenge.message !== body.message ||
      !(await auth.verifyWallet(
        env,
        body.message,
        body.signature as Hex,
        address(challenge.address),
        nonce,
      ))
    )
      throw new HttpError(
        401,
        "Signature does not match this account's wallet challenge.",
      );
    const wallet = address(challenge.address);
    const added = await linkedWalletsCall(env, {
      op: "wallet-add",
      principalId: session.principalId,
      address: wallet,
      ...(await provenWalletFacts(body.message, body.signature as Hex, wallet)),
      provenAt: Date.now(),
    });
    if ((session.authMethod === "solana" || session.authMethod === "bitcoin") && !session.address) {
      // A non-EVM wallet session gains the EVM wallet it
      // just proved as its verified wallet, with this proof, until the
      // session ends. Wallet authority never comes from a stored link.
      const attached = await (
        await record(env, "session", session.token)
      ).fetch(
        internalPost("/wallet/attach", {
          expectedPrincipalId: session.principalId,
          expectedRevision: session.walletRevision,
          address: wallet,
          expiresAt: session.expiresAt,
          authorization: { message: body.message, signature: body.signature },
        }),
      );
      if (!attached.ok)
        throw new HttpError(
          attached.status === 401 ? 401 : attached.status === 403 ? 403 : 409,
          "Your sign-in changed. Try again.",
        );
    } else await bumpSessionRevision(env, session, added.principalId);
    return json(await current(), 200, {
      "Set-Cookie": cookie(NONCE_COOKIE, "", 0),
    });
  }
  if (path === "/auth/wallets/remove") {
    // Any wallet leaves while another wallet remains; the
    // session it signed in ends now, and every other one on its next read.
    const wallet = address(body.address);
    await linkedWalletsCall(env, {
      op: "wallet-remove",
      bitcoinAvailable: await bitcoinAccountAvailable(env),
      principalId: session.principalId,
      address: wallet,
    });
    if (session.address === wallet && session.authMethod === "wallet") {
      await (
        await record(env, "session", session.token)
      ).fetch(internalPost("/revoke", {}));
      return json({ ...(await current()), sessionEnded: true }, 200, {
        "Set-Cookie": cookie(SESSION_COOKIE, "", 0),
      });
    }
    if (session.address === wallet) {
      // A Solana session attached this wallet; it is detached.
      const detached = await (
        await record(env, "session", session.token)
      ).fetch(
        internalPost("/wallet/detach", {
          expectedPrincipalId: session.principalId,
          expectedRevision: session.walletRevision,
        }),
      );
      if (!detached.ok)
        throw new HttpError(
          detached.status === 401 ? 401 : detached.status === 403 ? 403 : 409,
          "Your sign-in changed. Try again.",
        );
    } else await bumpSessionRevision(env, session);
    return json(await current());
  }
  throw new HttpError(404, "Not found.");
}
