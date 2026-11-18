import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  isSupportSiweChainId,
  type SupportSiweChainId,
} from "@templ/chat/chains";
import {
  PROFILE_CHANGES_PER_DAY,
  profileMediaHash,
  profileUpdate,
  type MemberProfile,
} from "@templ/chat/profiles";
import { address, HttpError, json, readJson, type Env } from "./common";
import { principal } from "./principal";
import { timed } from "./request-context";
import { normalizeEmailValue } from "./email-normalize";
import { TEAM_INVITE_ACTIVE_LIMIT } from "./team-invites";

/** Public-by-content profile kept beside the private credential indexes.
 * `updatedAt` is a millisecond timestamp; the public projection renders ISO. */
export type StoredProfile = {
  displayName: string | null;
  avatar: string | null;
  agent: boolean;
  updatedAt: number;
};
/** A Solana wallet proven for this account. Timestamps are milliseconds. */
export type StoredSolanaWallet = { address: string; linkedAt: number };
type StoredWalletProof = {
  kind: "eoa" | "contract";
  chainId: SupportSiweChainId;
};
function walletProof(value: unknown): value is StoredWalletProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as StoredWalletProof;
  return (
    (proof.kind === "eoa" || proof.kind === "contract") &&
    isSupportSiweChainId(proof.chainId)
  );
}
/** Private credential indexes. Historical chat records retain their original
 * principal. `email` is the optional alert address. `emailLogin` is a
 * separate proved sign-in credential; its index never adopts alert-linked
 * accounts. Retired credential fields remain unread. */
export type AccountIdentity = {
  principalId: ChatPrincipalId;
  servicePrincipals: ChatPrincipalId[];
  wallet: `0x${string}` | null;
  /** Facts from the primary wallet's verified sign-in. */
  walletProof?: StoredWalletProof;
  email: string | null;
  emailKey: string | null;
  emailVerifiedAt: number | null;
  /** Private sign-in proof. Never projected as a member profile or alias. */
  emailLogin?: {
    emailKey: string;
    email: string;
    verifiedAt: number;
    revision: number;
  };
  /** Absent until the account sets a name, avatar or agent flag. */
  profile?: StoredProfile;
  /** Solana wallets on the account, absent until one is proven. */
  solana?: StoredSolanaWallet[];
  /** A contract wallet that signed in to the support
   * widget on one chain. The account belongs to that chain and address
   * alone; no other chain, key or alias reaches it. */
  contract?: { chainId: number; address: `0x${string}` };
};
export type PendingEmailTeamInvitation = {
  workspace: string;
  inviteId: string;
  expiresAt: number;
};
const pendingEmailInvitesPrefix = (key: string) =>
  `team-email-invites-v1:${key}:`;
const pendingEmailLocatorKey = (
  key: string,
  invite: PendingEmailTeamInvitation,
) => `${pendingEmailInvitesPrefix(key)}${invite.workspace}:${invite.inviteId}`;
const pendingEmailInviteKey = (workspace: string, inviteId: string) =>
  `team-email-invite-v1:${workspace}:${inviteId}`;
const emailInviteUnavailable = () =>
  new HttpError(503, "Team invitations are temporarily unavailable.");
const validPendingEmailInvite = (
  value: unknown,
): value is PendingEmailTeamInvitation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const invite = value as PendingEmailTeamInvitation;
  return (
    Object.keys(invite).sort().join(",") === "expiresAt,inviteId,workspace" &&
    typeof invite.workspace === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      invite.workspace,
    ) &&
    typeof invite.inviteId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      invite.inviteId,
    ) &&
    Number.isSafeInteger(invite.expiresAt) &&
    invite.expiresAt > 0
  );
};
async function pendingEmailInvites(
  storage: DurableObjectTransaction,
  emailKey: string,
  now: number,
) {
  // Bound each sign-in batch without limiting invitations in other workspaces.
  const prefix = pendingEmailInvitesPrefix(emailKey);
  const cursorKey = `team-email-invite-cursor-v1:${emailKey}`;
  const cursor = await storage.get<unknown>(cursorKey);
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || !cursor.startsWith(prefix))
  )
    throw emailInviteUnavailable();
  let entries = await storage.list<unknown>({
    prefix,
    ...(cursor ? { startAfter: cursor as string } : {}),
    limit: TEAM_INVITE_ACTIVE_LIMIT,
  });
  if (!entries.size && cursor)
    entries = await storage.list<unknown>({
      prefix,
      limit: TEAM_INVITE_ACTIVE_LIMIT,
    });
  const last = [...entries.keys()].at(-1);
  if (last) await storage.put(cursorKey, last);
  else await storage.delete(cursorKey);
  const active: PendingEmailTeamInvitation[] = [];
  for (const [key, entry] of entries) {
    if (
      !validPendingEmailInvite(entry) ||
      key !== pendingEmailLocatorKey(emailKey, entry)
    )
      throw emailInviteUnavailable();
    if (entry.expiresAt > now) active.push(entry);
    else {
      await storage.delete(key);
      await storage.delete(
        pendingEmailInviteKey(entry.workspace, entry.inviteId),
      );
    }
  }
  return active;
}
async function pendingEmailInvitationRecord(
  storage: DurableObjectTransaction,
  body: Record<string, unknown>,
  now: number,
) {
  if (body.op === "team-email-pending") {
    const id = principal(body.principalId);
    const account = await accountIdentity(storage, id);
    if (
      !id.startsWith("account:") ||
      !account.emailLogin ||
      account.emailLogin.emailKey !== body.emailKey ||
      account.principalId !== id
    )
      throw new HttpError(403, "Use your verified email account.");
    return json({
      invitations: await pendingEmailInvites(
        storage,
        account.emailLogin.emailKey,
        now,
      ),
    });
  }
  if (body.op === "team-email-register") {
    if (
      typeof body.emailKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.emailKey) ||
      !validPendingEmailInvite(body.invitation) ||
      body.invitation.expiresAt <= now ||
      body.invitation.expiresAt > now + 168 * 3_600_000
    )
      throw new HttpError(400, "Invalid team invitation.");
    const invitation = body.invitation;
    const key = pendingEmailInviteKey(
      invitation.workspace,
      invitation.inviteId,
    );
    const previous = await storage.get<unknown>(key);
    if (previous !== undefined && previous !== body.emailKey)
      throw emailInviteUnavailable();
    const locator = pendingEmailLocatorKey(body.emailKey, invitation);
    const old = await storage.get<unknown>(locator);
    if (
      old !== undefined &&
      (!validPendingEmailInvite(old) || old.expiresAt !== invitation.expiresAt)
    )
      throw emailInviteUnavailable();
    await storage.put({ [key]: body.emailKey, [locator]: invitation });
    return json({ ok: true });
  }
  if (body.op === "team-email-remove") {
    const entry = {
      workspace: body.workspace,
      inviteId: body.inviteId,
      expiresAt: 1,
    };
    if (!validPendingEmailInvite(entry))
      throw new HttpError(400, "Invalid team invitation.");
    const key = pendingEmailInviteKey(entry.workspace, entry.inviteId);
    const emailKey = await storage.get<unknown>(key);
    if (emailKey === undefined) return json({ ok: true });
    if (typeof emailKey !== "string" || !/^[a-f0-9]{64}$/.test(emailKey))
      throw emailInviteUnavailable();
    await storage.delete(pendingEmailLocatorKey(emailKey, entry));
    await storage.delete(key);
    return json({ ok: true });
  }
  throw new HttpError(400, "Invalid account operation.");
}

/** The private index is a locator. Only the Room invitation transaction grants access. */
export async function pendingEmailInvitationRequest(
  env: Env,
  body: Record<string, unknown>,
  signal = AbortSignal.timeout(10_000),
) {
  const response = await identityStore(env).fetch(
    new Request("https://internal/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
  if (!response.ok) throw emailInviteUnavailable();
  return response.json<{
    invitations?: PendingEmailTeamInvitation[];
    ok?: boolean;
  }>();
}

export const PROFILE_HISTORY_LIMIT = 10;
export const PROFILE_CHANGE_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_PROFILE_LOOKUP = 50;
const profileChangesKey = (id: ChatPrincipalId) => `profile-changes-v1:${id}`;
const profileHistoryKey = (id: ChatPrincipalId) => `profile-history-v1:${id}`;
export type ProfileHistoryEntry = { at: number; displayName: string | null };
function validStoredProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    (profile.displayName === null || typeof profile.displayName === "string") &&
    (profile.avatar === null ||
      (typeof profile.avatar === "string" &&
        profileMediaHash(profile.avatar) !== null)) &&
    typeof profile.agent === "boolean" &&
    Number.isSafeInteger(profile.updatedAt)
  );
}
/** The only shape that leaves the identity object for other members: never
 * email, emailKey, emailVerifiedAt, emailLogin or the wallet. `id` is the id the caller
 * asked about, so a linked wallet alias shows the account's profile without
 * disclosing the canonical account it belongs to. */
export function publicProfile(
  identity: Pick<AccountIdentity, "principalId" | "profile">,
  id: ChatPrincipalId = identity.principalId,
): MemberProfile {
  const profile = identity.profile;
  return {
    principalId: id,
    displayName: profile?.displayName ?? null,
    avatar: profile?.avatar ?? null,
    agent: profile?.agent ?? false,
    updatedAt: profile ? new Date(profile.updatedAt).toISOString() : null,
  };
}
const conflict = () =>
  new HttpError(
    409,
    "That sign-in belongs to another Templ account. Sign in to that account instead.",
  );
// One account holds up to five EVM wallets and up to five Solana
// wallets, and any of them signs in. Passkey (`identity-passkeys:`,
// `identity-passkey:`) and X (`identity-x:`) records written before sign-in
// became wallet-only stay in storage untouched; nothing reads them.
export const LINKED_WALLETS_PREFIX = "identity-linked-wallets:";
export const LAST_WALLET_ERROR = "Keep at least one wallet to sign in.";
export const MAX_ACCOUNT_WALLETS = 5;
// Solana wallets: up to five per account, indexed by public key, each one
// signs in; one key belongs to one account.
export const SOLANA_INDEX_PREFIX = "identity-solana:";
export const MAX_ACCOUNT_SOLANA_WALLETS = 5;
export const SOLANA_ELSEWHERE_ERROR =
  "That Solana wallet belongs to another Templ account.";
export const SOLANA_ALREADY_ON_ACCOUNT_ERROR =
  "This Solana wallet is already on the account.";
export const SOLANA_NOT_ON_ACCOUNT_ERROR =
  "That Solana wallet is not on this account.";
export const SOLANA_LIMIT_ERROR = `This account already has ${MAX_ACCOUNT_SOLANA_WALLETS} Solana wallets. Remove one first.`;
const solanaIndexKey = (address: string) => `${SOLANA_INDEX_PREFIX}${address}`;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function validStoredSolana(value: unknown): value is StoredSolanaWallet[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ACCOUNT_SOLANA_WALLETS &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as StoredSolanaWallet).address === "string" &&
        SOLANA_ADDRESS.test((entry as StoredSolanaWallet).address) &&
        Number.isSafeInteger((entry as StoredSolanaWallet).linkedAt),
    ) &&
    new Set(value.map((entry) => (entry as StoredSolanaWallet).address))
      .size === value.length
  );
}
/** One alert address per account; `email-account:<key>` names the account
 * that verified it. */
export const EMAIL_ELSEWHERE_ERROR =
  "This email is on another Templ account. Remove it there first.";
export const EMAIL_ALREADY_SET_ERROR =
  "This account already has an alert email. Remove it first.";
export const NO_ALERT_EMAIL_ERROR = "This account has no alert email.";
const profileKey = (id: ChatPrincipalId) => `identity-profile:${id}`;
/** What the identity writers need; the linked-wallet module calls them with
 * the same narrowed storage view. */
type WritableStorage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
const isAccount = (id: ChatPrincipalId) => id.startsWith("account:");
/** Every opaque account id is minted here. */
export const newAccountId = () =>
  `account:${crypto.randomUUID()}` as ChatPrincipalId;
const empty = (id: ChatPrincipalId): AccountIdentity => ({
  principalId: id,
  servicePrincipals: [id],
  wallet: id.startsWith("account:") ? null : address(id),
  email: null,
  emailKey: null,
  emailVerifiedAt: null,
});
export function identityStore(env: Env) {
  return env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(`email-auth:v1:${env.APP_ORIGIN}`),
  );
}
export async function identityRequest(env: Env, body: Record<string, unknown>) {
  const response = await timed(
    env,
    body.op === "wallet-login" || body.op === "solana-login"
      ? "identity-login"
      : "identity",
    identityStore(env).fetch(
      new Request("https://internal/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
  if (!response.ok)
    throw new HttpError(
      response.status === 409 ? 409 : 503,
      response.status === 409
        ? conflict().message
        : "Account details are temporarily unavailable.",
    );
  return response.json<AccountIdentity>();
}
/** Credential invariants fail closed with 503. The public `profile` field is
 * cosmetic and non-authoritative, so a malformed one (including an avatar on
 * a host this deployment no longer serves) is treated as absent: the name and
 * avatar are hidden while sign-in, wallet links and profile reads keep working.
 * The next profile write replaces it. */
function validProfile(value: AccountIdentity, id: ChatPrincipalId) {
  const aliases = value.servicePrincipals;
  if (
    value.principalId !== id ||
    !Array.isArray(aliases) ||
    aliases[0] !== id ||
    aliases.length < 1 ||
    aliases.length > 2 ||
    (aliases.length === 2 &&
      (!id.startsWith("account:") ||
        principal(aliases[1]).startsWith("account:") ||
        aliases[1] !== value.wallet)) ||
    (value.wallet !== null && address(value.wallet) !== value.wallet) ||
    (value.walletProof !== undefined && !walletProof(value.walletProof)) ||
    (value.email !== null &&
      (typeof value.email !== "string" ||
        !value.emailKey ||
        !value.emailVerifiedAt)) ||
    (value.emailLogin !== undefined &&
      (!isAccount(id) || !validEmailLogin(value.emailLogin)))
  )
    throw new HttpError(503, "Account details are temporarily unavailable.");
  const { profile, solana, ...credentials } = value;
  if (solana !== undefined && !validStoredSolana(solana))
    throw new HttpError(503, "Account details are temporarily unavailable.");
  const identity: AccountIdentity = {
    ...credentials,
    servicePrincipals: aliases,
  };
  if (solana !== undefined) identity.solana = solana;
  if (validStoredProfile(profile)) identity.profile = profile;
  return identity;
}
async function rawProfile(
  storage: Pick<DurableObjectTransaction, "get">,
  id: ChatPrincipalId,
) {
  const value = await storage.get<AccountIdentity>(profileKey(id));
  if (!value) return empty(id);
  const identity = validProfile(value, id);
  if (
    identity.emailLogin &&
    (await storage.get(
      `${EMAIL_LOGIN_INDEX_PREFIX}${identity.emailLogin.emailKey}`,
    )) !== id
  )
    throw new HttpError(503, "Account details are temporarily unavailable.");
  return identity;
}
export async function accountIdentity(
  storage: Pick<DurableObjectTransaction, "get">,
  id: ChatPrincipalId,
) {
  if (!id.startsWith("account:")) {
    const canonical = await storage.get<ChatPrincipalId>(
      `identity-wallet:${id}`,
    );
    if (canonical && canonical !== id) {
      const target = principal(canonical);
      if (!target.startsWith("account:")) throw conflict();
      const profile = await rawProfile(storage, target);
      if (profile.wallet !== id || !profile.servicePrincipals.includes(id))
        throw conflict();
      return profile;
    }
  }
  return rawProfile(storage, id);
}
/** A bare EVM wallet gains its second wallet: the account id is minted now
 * and the wallet stays the account's original alias, so its history and
 * permissions follow it. The wallet's own profile bytes are left in place,
 * and its alert address now names the account. */
export async function mintAccount(
  storage: WritableStorage,
  wallet: `0x${string}`,
): Promise<AccountIdentity> {
  const owner = await storage.get<ChatPrincipalId>(`identity-wallet:${wallet}`);
  if (owner && owner !== wallet) throw conflict();
  const historical = await rawProfile(storage, wallet);
  const id = newAccountId();
  const minted: AccountIdentity = {
    ...historical,
    principalId: id,
    servicePrincipals: [id, wallet],
    wallet,
  };
  await storage.put(`identity-wallet:${wallet}`, id);
  await storage.put(profileKey(id), minted);
  if (historical.emailKey)
    await storage.put(`email-account:${historical.emailKey}`, id);
  return minted;
}
/** The identity as an account: itself, or the account minted for a bare wallet. */
export async function ensureAccount(
  storage: WritableStorage,
  identity: AccountIdentity,
) {
  if (isAccount(identity.principalId) || !identity.wallet) return identity;
  return mintAccount(storage, identity.wallet);
}
/** How many wallets sign in to this account: every proven EVM wallet (the
 * original alias plus linked wallets, wherever the record still lives) and
 * every Solana wallet. Removal always leaves one wallet, of either kind. */
export async function countWallets(
  storage: Pick<DurableObjectTransaction, "get">,
  identity: AccountIdentity,
) {
  const wallets = new Set<string>();
  if (identity.wallet) wallets.add(identity.wallet);
  for (const id of identity.servicePrincipals) {
    const raw = await storage.get<{ wallets?: unknown }>(
      `${LINKED_WALLETS_PREFIX}${id}`,
    );
    if (!raw || !Array.isArray(raw.wallets)) continue;
    for (const entry of raw.wallets) {
      const value = (entry as { address?: unknown } | null)?.address;
      if (typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value))
        wallets.add(value);
    }
  }
  return {
    wallets: Math.min(wallets.size, MAX_ACCOUNT_WALLETS),
    solana: identity.solana?.length ?? 0,
  };
}
/** Throws 409 when removing one wallet would leave the account none. */
export async function requireAnotherWallet(
  storage: Pick<DurableObjectTransaction, "get">,
  identity: AccountIdentity,
) {
  const count = await countWallets(storage, identity);
  if (count.wallets + count.solana <= 1)
    throw new HttpError(409, LAST_WALLET_ERROR);
}
const EMAIL_LOGIN_INDEX_PREFIX = "identity-email-login:";
const validEmailLogin = (
  value: unknown,
): value is NonNullable<AccountIdentity["emailLogin"]> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as NonNullable<AccountIdentity["emailLogin"]>;
  return (
    typeof proof.emailKey === "string" &&
    /^[a-f0-9]{64}$/.test(proof.emailKey) &&
    typeof proof.email === "string" &&
    normalizeEmailValue(proof.email) === proof.email &&
    Number.isSafeInteger(proof.verifiedAt) &&
    proof.verifiedAt > 0 &&
    Number.isSafeInteger(proof.revision) &&
    proof.revision >= 0
  );
};
/** A consumed sign-in code resolves only the dedicated login index. Alert
 * email indexes and retired email account records grant no sign-in access. */
export async function emailSignInIdentity(
  storage: WritableStorage,
  input: { emailKey: string; email: string },
  now: number,
): Promise<AccountIdentity> {
  if (
    !/^[a-f0-9]{64}$/.test(input.emailKey) ||
    normalizeEmailValue(input.email) !== input.email ||
    !Number.isSafeInteger(now) ||
    now <= 0
  )
    throw new HttpError(400, "Invalid email sign-in proof.");
  const key = `${EMAIL_LOGIN_INDEX_PREFIX}${input.emailKey}`;
  const known = await storage.get<unknown>(key);
  let identity: AccountIdentity;
  if (known !== undefined) {
    const id = normalizeChatPrincipal(known);
    if (!id || !isAccount(id)) throw conflict();
    identity = await rawProfile(storage, id);
    if (
      identity.emailLogin?.emailKey !== input.emailKey ||
      identity.emailLogin.email !== input.email
    )
      throw conflict();
  } else {
    identity = empty(newAccountId());
  }
  const updated: AccountIdentity = {
    ...identity,
    emailLogin: {
      emailKey: input.emailKey,
      email: input.email,
      verifiedAt: now,
      revision: identity.emailLogin?.revision ?? 0,
    },
  };
  await storage.put(profileKey(identity.principalId), updated);
  await storage.put(key, identity.principalId);
  return updated;
}
/** Sets the account's alert address in the same transaction that consumed
 * its one-time code. The code proves the mailbox; the session proves the
 * account. It never changes the account, adopts a wallet or merges two
 * accounts: an address another account verified answers 409. */
export async function claimAlertEmail(
  storage: DurableObjectTransaction,
  input: { emailKey: string; email: string; principalId: ChatPrincipalId },
  now: number,
) {
  const identity = await accountIdentity(storage, input.principalId);
  const indexed = await storage.get<ChatPrincipalId>(
    `email-account:${input.emailKey}`,
  );
  if (indexed && !identity.servicePrincipals.includes(principal(indexed)))
    throw new HttpError(409, EMAIL_ELSEWHERE_ERROR);
  if (identity.emailKey && identity.emailKey !== input.emailKey)
    throw new HttpError(409, EMAIL_ALREADY_SET_ERROR);
  const updated: AccountIdentity = {
    ...identity,
    email: input.email,
    emailKey: input.emailKey,
    emailVerifiedAt: now,
  };
  await storage.put(profileKey(identity.principalId), updated);
  await storage.put(`email-account:${input.emailKey}`, identity.principalId);
  return updated;
}
async function recentProfileChanges(
  storage: Pick<DurableObjectTransaction, "get">,
  id: ChatPrincipalId,
  now: number,
) {
  const stamps = (await storage.get<number[]>(profileChangesKey(id))) ?? [];
  return stamps.filter(
    (at) => Number.isSafeInteger(at) && at > now - PROFILE_CHANGE_WINDOW_MS,
  );
}
const changesLeft = (recent: number[]) =>
  Math.max(0, PROFILE_CHANGES_PER_DAY - recent.length);
/** The session's own profile plus how many changes remain in the sliding day. */
async function readOwnProfile(
  storage: Pick<DurableObjectTransaction, "get">,
  id: ChatPrincipalId,
  now: number,
) {
  const identity = await accountIdentity(storage, id);
  const recent = await recentProfileChanges(storage, identity.principalId, now);
  return { ...publicProfile(identity), changesLeftToday: changesLeft(recent) };
}
/** Applies a validated update under the daily change window. Unchanged
 * writes cost nothing. Display-name history is operator evidence only. */
async function writeOwnProfile(
  storage: DurableObjectTransaction,
  id: ChatPrincipalId,
  update: unknown,
  now: number,
) {
  let change;
  try {
    change = profileUpdate(update);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const identity = await accountIdentity(storage, id);
  const current: StoredProfile = identity.profile ?? {
    displayName: null,
    avatar: null,
    agent: false,
    updatedAt: 0,
  };
  const next: StoredProfile = {
    displayName:
      change.displayName === undefined
        ? current.displayName
        : change.displayName,
    avatar: change.avatar === undefined ? current.avatar : change.avatar,
    agent: change.agent === undefined ? current.agent : change.agent,
    updatedAt: now,
  };
  const recent = await recentProfileChanges(storage, identity.principalId, now);
  if (
    identity.profile &&
    next.displayName === current.displayName &&
    next.avatar === current.avatar &&
    next.agent === current.agent
  )
    return {
      ...publicProfile(identity),
      changesLeftToday: changesLeft(recent),
    };
  if (recent.length >= PROFILE_CHANGES_PER_DAY)
    throw new HttpError(
      429,
      "You can change your profile 3 times a day.",
      Math.max(
        1,
        Math.ceil((recent[0] + PROFILE_CHANGE_WINDOW_MS - now) / 1000),
      ),
    );
  const updated: AccountIdentity = { ...identity, profile: next };
  const stamps = [...recent, now];
  await storage.put(profileKey(identity.principalId), updated);
  await storage.put(profileChangesKey(identity.principalId), stamps);
  if (next.displayName !== current.displayName) {
    const history =
      (await storage.get<ProfileHistoryEntry[]>(
        profileHistoryKey(identity.principalId),
      )) ?? [];
    await storage.put(
      profileHistoryKey(identity.principalId),
      [...history, { at: now, displayName: next.displayName }].slice(
        -PROFILE_HISTORY_LIMIT,
      ),
    );
  }
  return { ...publicProfile(updated), changesLeftToday: changesLeft(stamps) };
}
/** Public projection for up to 50 ids. Ids without a saved profile are
 * omitted; a wallet alias resolves to its account's profile but is returned
 * under the id that was asked for. */
async function publicProfiles(
  storage: Pick<DurableObjectTransaction, "get">,
  input: unknown,
) {
  if (!Array.isArray(input) || input.length > MAX_PROFILE_LOOKUP)
    throw new HttpError(
      400,
      `Request up to ${MAX_PROFILE_LOOKUP} profiles at a time.`,
    );
  const seen = new Set<ChatPrincipalId>();
  const profiles: MemberProfile[] = [];
  for (const raw of input) {
    const id = principal(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    let identity: AccountIdentity;
    try {
      identity = await accountIdentity(storage, id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) continue;
      throw error;
    }
    if (identity.profile) profiles.push(publicProfile(identity, id));
  }
  return { profiles };
}
/** A wallet that was added to an account (not its original
 * alias) signs in to that account. The owner index must name an account
 * whose linked record lists the wallet; anything else fails closed. A record
 * still kept under a bare wallet's own id mints that wallet's account first. */
async function linkedWalletOwner(
  storage: DurableObjectTransaction,
  wallet: `0x${string}`,
): Promise<AccountIdentity | null> {
  const owner = await storage.get<ChatPrincipalId>(`identity-wallet:${wallet}`);
  if (!owner || owner === wallet) return null;
  const target = principal(owner);
  const identity = isAccount(target)
    ? await rawProfile(storage, target)
    : await accountIdentity(storage, target);
  if (identity.wallet === wallet && identity.servicePrincipals.includes(wallet))
    return null;
  let listed = false;
  for (const id of identity.servicePrincipals) {
    const raw = await storage.get<{ wallets?: { address?: unknown }[] }>(
      `${LINKED_WALLETS_PREFIX}${id}`,
    );
    if (raw?.wallets?.some((entry) => entry?.address === wallet)) listed = true;
  }
  if (!listed) throw conflict();
  return ensureAccount(storage, identity);
}
/** Drops the account's alert address. It is not a way in, so removal needs
 * no other method. */
async function removeAlertEmail(
  storage: DurableObjectTransaction,
  id: ChatPrincipalId,
) {
  const identity = await accountIdentity(storage, id);
  if (!identity.email || !identity.emailKey)
    throw new HttpError(404, NO_ALERT_EMAIL_ERROR);
  const indexed = await storage.get<ChatPrincipalId>(
    `email-account:${identity.emailKey}`,
  );
  if (indexed && identity.servicePrincipals.includes(principal(indexed)))
    await storage.delete(`email-account:${identity.emailKey}`);
  const updated: AccountIdentity = {
    ...identity,
    email: null,
    emailKey: null,
    emailVerifiedAt: null,
  };
  await storage.put(profileKey(identity.principalId), updated);
  return updated;
}
/** Solana sign-in: the public key resolves to its account, or a new account
 * is minted with the wallet as its only method. An index that names an
 * account not listing the key fails closed. */
async function solanaLogin(
  storage: WritableStorage,
  raw: unknown,
  now: number,
): Promise<{ identity: AccountIdentity; created: boolean }> {
  if (typeof raw !== "string" || !SOLANA_ADDRESS.test(raw))
    throw new HttpError(400, "Invalid Solana wallet.");
  const owner = await storage.get<ChatPrincipalId>(solanaIndexKey(raw));
  if (owner) {
    const identity = await accountIdentity(storage, principal(owner));
    if (!identity.solana?.some((entry) => entry.address === raw))
      throw conflict();
    return { identity, created: false };
  }
  const id = newAccountId();
  const minted: AccountIdentity = {
    ...empty(id),
    solana: [{ address: raw, linkedAt: now }],
  };
  await storage.put(profileKey(id), minted);
  await storage.put(solanaIndexKey(raw), id);
  return { identity: minted, created: true };
}
/** Link: adds a proven Solana wallet to the session's account. A key owned
 * elsewhere is refused, never merged; a bare EVM wallet gains its account id. */
async function solanaLink(
  storage: WritableStorage,
  id: ChatPrincipalId,
  raw: unknown,
  now: number,
) {
  if (typeof raw !== "string" || !SOLANA_ADDRESS.test(raw))
    throw new HttpError(400, "Invalid Solana wallet.");
  const identity = await accountIdentity(storage, id);
  if (identity.solana?.some((entry) => entry.address === raw))
    throw new HttpError(409, SOLANA_ALREADY_ON_ACCOUNT_ERROR);
  if ((identity.solana?.length ?? 0) >= MAX_ACCOUNT_SOLANA_WALLETS)
    throw new HttpError(409, SOLANA_LIMIT_ERROR);
  const owner = await storage.get<ChatPrincipalId>(solanaIndexKey(raw));
  if (owner && !identity.servicePrincipals.includes(principal(owner)))
    throw new HttpError(409, SOLANA_ELSEWHERE_ERROR);
  const account = await ensureAccount(storage, identity);
  const updated: AccountIdentity = {
    ...account,
    solana: [...(account.solana ?? []), { address: raw, linkedAt: now }],
  };
  await storage.put(profileKey(account.principalId), updated);
  await storage.put(solanaIndexKey(raw), account.principalId);
  return updated;
}
/** Lookup only: the account a proven Solana wallet signs in to, or null for
 * a key no account proved. An index entry whose account no longer lists the
 * key reads as null too. It never mints, links or merges; the manager's
 * staff grant is its only caller. */
async function solanaOwner(
  storage: Pick<DurableObjectTransaction, "get">,
  raw: unknown,
): Promise<ChatPrincipalId | null> {
  if (typeof raw !== "string" || !SOLANA_ADDRESS.test(raw))
    throw new HttpError(400, "Invalid Solana wallet.");
  const owner = await storage.get<ChatPrincipalId>(solanaIndexKey(raw));
  if (!owner) return null;
  const identity = await accountIdentity(storage, principal(owner));
  return isAccount(identity.principalId) &&
    identity.solana?.some((entry) => entry.address === raw)
    ? identity.principalId
    : null;
}
/** Removal keeps at least one wallet on the account. */
async function solanaRemove(
  storage: WritableStorage,
  id: ChatPrincipalId,
  raw: unknown,
) {
  if (typeof raw !== "string" || !SOLANA_ADDRESS.test(raw))
    throw new HttpError(400, "Invalid Solana wallet.");
  const identity = await accountIdentity(storage, id);
  if (!identity.solana?.some((entry) => entry.address === raw))
    throw new HttpError(404, SOLANA_NOT_ON_ACCOUNT_ERROR);
  await requireAnotherWallet(storage, identity);
  const indexed = await storage.get<ChatPrincipalId>(solanaIndexKey(raw));
  if (indexed && identity.servicePrincipals.includes(principal(indexed)))
    await storage.delete(solanaIndexKey(raw));
  const rest = identity.solana.filter((entry) => entry.address !== raw);
  const updated: AccountIdentity = { ...identity };
  if (rest.length) updated.solana = rest;
  else delete updated.solana;
  await storage.put(profileKey(identity.principalId), updated);
  return updated;
}
export async function identityRecordRequest(
  request: Request,
  state: DurableObjectState,
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/identity" ||
    request.method !== "POST"
  )
    return null;
  // Fifty principal ids plus the envelope fit well inside this bound.
  const body = await readJson(request, 8192);
  const now = Date.now();
  return state.storage.transaction(async (storage) => {
    if (
      [
        "team-email-pending",
        "team-email-register",
        "team-email-remove",
      ].includes(String(body.op))
    )
      return pendingEmailInvitationRecord(storage, body, now);
    if (body.op === "read")
      return json(await accountIdentity(storage, principal(body.principalId)));
    if (body.op === "profile-read")
      return json(
        await readOwnProfile(storage, principal(body.principalId), Date.now()),
      );
    if (body.op === "profile-write")
      return json(
        await writeOwnProfile(
          storage,
          principal(body.principalId),
          body.update,
          Date.now(),
        ),
      );
    if (body.op === "profiles")
      return json(await publicProfiles(storage, body.principalIds));
    if (body.op === "wallet-login") {
      const wallet = address(body.wallet);
      const proof = { kind: body.kind, chainId: body.chainId };
      if (!walletProof(proof))
        throw new HttpError(400, "Invalid wallet proof.");
      const linked = await linkedWalletOwner(storage, wallet);
      if (linked) {
        const key = `${LINKED_WALLETS_PREFIX}${linked.principalId}`;
        const record = await storage.get<{
          wallets: ({
            address: string;
            provenAt: number;
          } & StoredWalletProof)[];
        }>(key);
        const entry = record?.wallets.find((value) => value.address === wallet);
        if (
          entry &&
          (entry.kind !== proof.kind || entry.chainId !== proof.chainId)
        ) {
          Object.assign(entry, proof, { provenAt: now });
          await storage.put(key, record);
        }
        return json(linked);
      }
      const profile = await accountIdentity(storage, wallet);
      if (profile.wallet && profile.wallet !== wallet) throw conflict();
      const updated = { ...profile, wallet, walletProof: proof };
      // A repeat sign-in stores nothing: each record is written only when
      // it would change.
      const mapping = `identity-wallet:${wallet}`;
      if ((await storage.get(mapping)) !== profile.principalId)
        await storage.put(mapping, profile.principalId);
      if (
        JSON.stringify(await storage.get(profileKey(profile.principalId))) !==
        JSON.stringify(updated)
      )
        await storage.put(profileKey(profile.principalId), updated);
      return json(updated);
    }
    if (body.op === "alert-email-remove")
      return json(await removeAlertEmail(storage, principal(body.principalId)));
    if (body.op === "solana-login")
      return json(await solanaLogin(storage, body.address, now));
    if (body.op === "contract-login") {
      // A widget contract wallet, verified by the worker on this chain: its
      // own account, found by chain and address, never linked or merged.
      const chainId = body.chainId;
      if (chainId !== 1 && chainId !== 747474)
        throw new HttpError(400, "Invalid account operation.");
      const wallet = address(body.address);
      const mapping = `identity-contract:eip155:${chainId}:${wallet}`;
      const known = normalizeChatPrincipal(await storage.get(mapping));
      if (known) {
        const identity = await rawProfile(storage, known);
        if (
          identity.contract?.chainId !== chainId ||
          identity.contract.address !== wallet
        )
          throw conflict();
        return json(identity);
      }
      const id = newAccountId();
      const created: AccountIdentity = {
        ...empty(id),
        contract: { chainId, address: wallet },
      };
      await storage.put(mapping, id);
      await storage.put(profileKey(id), created);
      return json(created);
    }
    if (body.op === "solana-link")
      return json(
        await solanaLink(
          storage,
          principal(body.principalId),
          body.address,
          now,
        ),
      );
    if (body.op === "solana-owner")
      return json({ principalId: await solanaOwner(storage, body.address) });
    if (body.op === "wallet-owner") {
      if (body.network === "solana")
        return json({ principalId: await solanaOwner(storage, body.address) });
      const wallet = address(body.address);
      const owner = normalizeChatPrincipal(
        await storage.get(`identity-wallet:${wallet}`),
      );
      if (!owner) return json({ principalId: null });
      const identity = await accountIdentity(storage, owner);
      const permitsNetwork = (proof: unknown) =>
        walletProof(proof) &&
        (proof.kind === "eoa" || proof.chainId === body.network);
      const links = await storage.get<{
        wallets?: {
          address?: string;
          kind?: string;
          chainId?: number;
          provenAt?: number;
        }[];
      }>(`${LINKED_WALLETS_PREFIX}${identity.principalId}`);
      const held =
        (identity.wallet === wallet && permitsNetwork(identity.walletProof)) ||
        Boolean(
          links?.wallets?.some(
            (entry) =>
              entry.address === wallet &&
              entry.address !== identity.wallet &&
              Number.isSafeInteger(entry.provenAt) &&
              entry.provenAt! >= 0 &&
              permitsNetwork(entry),
          ),
        );
      return json({ principalId: held ? identity.principalId : null });
    }
    if (body.op === "solana-remove")
      return json(
        await solanaRemove(storage, principal(body.principalId), body.address),
      );
    throw new HttpError(400, "Invalid account operation.");
  });
}
