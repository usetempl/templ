import { connectRecordRequest, expireConnectRequests } from "./connect";
import { releaseActivationRecordRequest } from "./release-activation";
import {
  connectCaptureRecordRequest,
  expireConnectCaptures,
} from "./connect-trial-capture";
import { supportEntryRecord } from "./hosted-support";
import { widgetConfigRecord, type WidgetScope } from "./support-widget";
import { sameWidgetScope } from "./widget-frame";
import { flushWorkspaceSteps, type FunnelEnv } from "./funnel-metrics";
import { receiveWidgetOnboardingScope } from "./onboarding-metrics";
import { messageBudgetRequest, expireMessageBudget } from "./message-budget";
import { searchBudgetRequest, expireSearchBudget } from "./search-budget";
import {
  address,
  AUTH_RECORD_HEADER,
  HttpError,
  json,
  readJson,
  SESSION_TTL,
  type Env,
} from "./common";
import { principal } from "./principal";
import {
  rememberRecordRequest,
  type RememberedFamily,
} from "./widget-remember";
import {
  isAuthMethod,
  type AuthMethod,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type {
  WidgetWallet,
  WidgetWalletNetwork,
} from "@templ/chat/widget-wallet";
import { readStoredWidgetWallet } from "@templ/chat/widget-wallet";
import { emailRecordRequest, expireEmailLedger } from "./email-alerts";
import { emailDeliveryRecordRequest } from "./email-delivery";
import { identityRecordRequest } from "./account-identity";
import { accountMethodsRecordRequest } from "./account-methods";
import {
  bumpWalletRevision,
  linkedWalletsRecordRequest,
} from "./linked-wallets";

export type AuthData = {
  address: string | null;
  principalId?: ChatPrincipalId;
  servicePrincipals?: ChatPrincipalId[];
  /** "wallet" (EVM) or "solana", or "guest" inside one support widget; every
   * wallet resolves to the same account principal. A stored session of a
   * kind outside that list fails `isAuthMethod` and is refused. */
  authMethod?: AuthMethod;
  /** Email sign-in uses a separate mailbox credential, never the alert address. */
  emailSignInKey?: string;
  emailSignInRevision?: number;
  expiresAt: number;
  /** Set only after an actual sign-in proof; never extended by session renewal. */
  authenticatedAt?: number;
  authorizationExpiresAt?: number;
  authorization?: { message: string; signature: `0x${string}` };
  /** A "solana" session holds the signing wallet and its Sign In With Solana proof.
   * Every read verifies that proof. App and widget proofs use canonical padded base64.
   * Each challenge names the signing wallet. */
  solanaAddress?: string;
  solanaAuthorization?: { message: string; signature: string };
  /** A widget-login challenge or widget session: the wallet family that
   * signs, "evm" (SIWE, `address` set) or "solana" (SIWS, `address` null and
   * `solanaAddress` set). Records written before Solana widget sign-in have
   * none and are EVM. */
  network?: WidgetWalletNetwork;
  message?: string;
  nonce?: string;
  walletAuthorizationExpiresAt?: number;
  walletRevision?: number;
  /** Wallet-add challenges are bound to one account, session
   * and wallet revision. */
  widgetScope?: WidgetScope;
  /** A "guest" widget session: the wallet the visitor's app reported, on EVM
   * or Solana. It is a claim, never proof, and never copied into `address`
   * or `solanaAddress`. Records written before Solana claims hold
   * `{address, chainId}` with no network; read it through
   * `readStoredWidgetWallet`. */
  guestClaim?:
    | WidgetWallet
    | { network?: undefined; address: string; chainId: number };
  /** The guest agreed to share the app-reported wallet. */
  walletConsent?: true;
  /** The member chose to ask because their wallet would not connect. */
  walletUnavailable?: true;
  guestCredentialHash?: string;
  /** A widget-login challenge made from a guest session: only that same
   * guest session can redeem it, with its own bearer, which moves the guest's
   * thread. SIWE and SIWS challenges alike. */
  guestPrincipal?: ChatPrincipalId;
  /** A guest can share a proof in one Standard conversation, including the next one they start. */
  shareConversation?: string;
  sharedWallet?: WidgetWallet;
  purpose?:
    | "widget-wallet-share"
    | "widget-login"
    | "widget-session"
    | "widget-guest"
    | "wallet-add"
    | "solana-login"
    | "solana-attach"
    | "email-session";
  sessionKey?: string;
  /** One install request explicitly bound to this account sign-in. */
  connectCode?: string;
  /** A widget-login challenge that asked to stay signed in and was offered
   * the remember statement. */
  remember?: true;
  /** A widget session made by or with a remembered sign-in: sha256 of its
   * family id, which sign-out uses to end the family. */
  remembered?: string;
  /** That family's epoch. A workspace whose epoch moved past it refuses the
   * session at its next request. */
  rememberEpoch?: number;
  /** A guest credential made after a passed visitor check. */
  guestCheck?: "turnstile";
  /** A guest credential: the hashes and expiries of the widget sessions it
   * started. Moving the guest into Templ's frame ends each of them. */
  sessions?: GuestSession[];
  /** A session ended before its expiry: its hash can't be created again
   * until then, and every read refuses it. */
  ended?: true;
  /** A widget session of a contract wallet, verified
   * through ERC-1271 or ERC-6492 on this chain. Its account is kept for this
   * chain and address alone (`AccountIdentity.contract`). */
  contractChain?: number;
};
export type GuestSession = { hash: string; expiresAt: number };
/** Live widget sessions one guest credential may hold at once. */
export const GUEST_SESSION_LIMIT = 50;
const EXPIRY_PREFIX = "expires:";
const SWEEP_BATCH = 500;
/** `expires:<13-digit ms>:<hash>` sorts by time. */
const expiryKey = (expiresAt: number, hash: string) =>
  `${EXPIRY_PREFIX}${String(expiresAt).padStart(13, "0")}:${hash}`;
/** The time this shard last asked the platform to sweep. */
const ARMED_KEY = "expires-alarm";
/** Moves the alarm earlier only; a later expiry never postpones a sweep. A
 * stored time already past has fired, is about to, or its sweep failed:
 * asking for it again sweeps now, and the sweep re-arms from the index. */
async function armEarlier(
  storage: Pick<DurableObjectTransaction, "get" | "put" | "setAlarm">,
  at: number,
) {
  const armed = await storage.get<number>(ARMED_KEY);
  if (armed === undefined || armed > at) {
    await storage.put(ARMED_KEY, at);
    await storage.setAlarm(at);
  } else if (armed <= Date.now()) await storage.setAlarm(armed);
}
function guestSession(body: Record<string, unknown>): GuestSession | null {
  const { hash, expiresAt } = body;
  return typeof hash === "string" &&
    /^[0-9a-f]{64}$/.test(hash) &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > Date.now() &&
    expiresAt <= Date.now() + SESSION_TTL
    ? { hash, expiresAt }
    : null;
}
/** Hashed challenge, session and guest records, sharded 16 ways per kind by
 * the first hex digit of the hash, plus the per-token objects earlier
 * releases created; never public. */
export class AuthRecord {
  /** A workspace's widget settings object may hold onboarding steps it has
   * not sent yet: unknown after a restart, then known from each flush. */
  private funnelUnsent = true;
  private funnelRequested = false;
  private funnelTask: Promise<void> | null = null;
  constructor(
    private state: DurableObjectState,
    private env: FunnelEnv & Partial<Env> = {},
  ) {}
  /** Sends marked steps after the response; a failed send waits for the next
   * widget request. */
  private reportFunnel() {
    this.funnelRequested = true;
    if (this.funnelTask) return;
    const task = (async () => {
      while (this.funnelRequested) {
        this.funnelRequested = false;
        this.funnelUnsent = !(await flushWorkspaceSteps(
          this.state.storage,
          this.env,
        ));
        if (this.funnelUnsent) return;
      }
    })()
      .catch(() => {
        this.funnelUnsent = true;
      })
      .finally(() => {
        this.funnelTask = null;
      });
    this.funnelTask = task;
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(task);
  }
  async fetch(request: Request) {
    try {
      const path = new URL(request.url).pathname;
      // A sharded record: the worker names its hash. Only record operations
      // are served under that header.
      const keyed = request.headers.get(AUTH_RECORD_HEADER);
      if (keyed !== null) {
        if (!/^[0-9a-f]{64}$/.test(keyed))
          throw new HttpError(400, "Invalid record.");
        return (
          (await this.recordRequest(request, path, keyed)) ??
          json({ error: "Not found." }, 404)
        );
      }
      const activation = await releaseActivationRecordRequest(
        request,
        this.state,
        this.env,
      );
      if (activation) return activation;
      const connect = await connectRecordRequest(request, this.state);
      if (connect) return connect;
      const capture = await connectCaptureRecordRequest(
        request,
        this.state,
        this.env as Env,
      );
      if (capture) return capture;
      const entry = await supportEntryRecord(request, this.state.storage);
      if (entry) return entry;
      if (path === "/widget-onboarding" && request.method === "POST") {
        const response = await receiveWidgetOnboardingScope(
          this.state.storage,
          await readJson(request, 512),
        );
        this.reportFunnel();
        return response;
      }
      const widget = await widgetConfigRecord(request, this.state.storage);
      if (widget) {
        if (widget.marked || this.funnelUnsent) this.reportFunnel();
        return widget.response;
      }
      if (request.method === "POST" && path === "/message-budget") {
        const body = await readJson(request);
        return await this.state.storage.transaction((storage) =>
          messageBudgetRequest(storage, body),
        );
      }
      if (request.method === "POST" && path === "/search-budget") {
        const body = await readJson(request);
        return await this.state.storage.transaction((storage) =>
          searchBudgetRequest(storage, body),
        );
      }
      const linkedResponse = await linkedWalletsRecordRequest(
        request,
        this.state,
      );
      if (linkedResponse) return linkedResponse;
      const methodsResponse = await accountMethodsRecordRequest(
        request,
        this.state,
      );
      if (methodsResponse) return methodsResponse;
      const identityResponse = await identityRecordRequest(request, this.state);
      if (identityResponse) return identityResponse;
      if (path === "/wallets/revision")
        return (
          (await this.recordRequest(request, path, null)) ??
          json({ error: "Not found." }, 404)
        );
      const deliveryResponse = await emailDeliveryRecordRequest(
        request,
        this.state,
      );
      if (deliveryResponse) return deliveryResponse;
      const emailResponse = await emailRecordRequest(request, this.state);
      if (emailResponse) return emailResponse;
      return (
        (await this.recordRequest(request, path, null)) ??
        json({ error: "Not found." }, 404)
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Authentication storage unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
        error instanceof HttpError && error.retryAfterSeconds
          ? { "Retry-After": String(error.retryAfterSeconds) }
          : {},
      );
    }
  }
  /** Record operations on one key: `record:<hash>` inside a shard, or the
   * single `record` of a per-token object. A
   * sharded record also keeps an expiry index entry for the alarm sweep. */
  private async recordRequest(
    request: Request,
    path: string,
    hash: string | null,
  ): Promise<Response | null> {
    if (request.method !== "POST") return null;
    const key = hash ? `record:${hash}` : "record";
    const index = (expiresAt: number) =>
      hash ? expiryKey(expiresAt, hash) : null;
    if (hash && path.startsWith("/remember/")) {
      // A remembered sign-in family: resume and forget run in one
      // transaction with the rotation they decide.
      const body = await readJson(request);
      return await this.state.storage.transaction((storage) =>
        rememberRecordRequest(
          storage,
          path,
          key,
          body,
          async (family: RememberedFamily) => {
            await storage.delete(key);
            if (Number.isSafeInteger(family.expiresAt))
              await storage.delete(index(family.expiresAt)!);
          },
          Date.now(),
        ),
      );
    }
    if (path === "/wallets/revision") {
      // A linked-set change ends every lease keyed to this session.
      const body = await readJson(request);
      return await this.state.storage.transaction((storage) =>
        bumpWalletRevision(storage, body, Date.now(), key),
      );
    }
    if (["/wallet/attach", "/wallet/detach"].includes(path)) {
      const body = await readJson(request);
      const expectedPrincipalId = principal(body.expectedPrincipalId);
      const expectedRevision = body.expectedRevision;
      if (
        !Number.isSafeInteger(expectedRevision) ||
        Number(expectedRevision) < 0
      )
        throw new HttpError(400, "Invalid wallet authorization revision.");
      return await this.state.storage.transaction(async (storage) => {
        const entry = await storage.get<AuthData>(key);
        const now = Date.now();
        if (
          !entry ||
          entry.expiresAt <= now ||
          !Number.isSafeInteger(entry.authorizationExpiresAt) ||
          entry.authorizationExpiresAt! <= now ||
          !Number.isSafeInteger(entry.authenticatedAt) ||
          !Number.isSafeInteger(entry.walletRevision) ||
          entry.nonce ||
          entry.message
        )
          return json({ error: "Session expired." }, 401);
        // Only a Solana session attaches a proven EVM wallet: an EVM
        // session already has one, a guest never holds one, and a stored
        // session of any other kind gains nothing.
        if (
          entry.authMethod !== "solana" ||
          entry.principalId !== expectedPrincipalId
        )
          return json(
            { error: "This wallet request belongs to another account." },
            403,
          );
        if (entry.walletRevision !== expectedRevision)
          return json(
            { error: "Wallet authorization changed. Try again." },
            409,
          );
        let updated: AuthData = {
          ...entry,
          address: null,
          walletRevision: Number(expectedRevision) + 1,
        };
        delete updated.authorization;
        delete updated.walletAuthorizationExpiresAt;
        if (path === "/wallet/attach") {
          const expiresAt = body.expiresAt;
          const proof = body.authorization as
            | Record<string, unknown>
            | undefined;
          if (
            typeof expiresAt !== "number" ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= now ||
            expiresAt >
              Math.min(entry.expiresAt, entry.authorizationExpiresAt!) ||
            !proof ||
            typeof proof.message !== "string" ||
            proof.message.length > 4096 ||
            typeof proof.signature !== "string" ||
            !/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(proof.signature)
          )
            throw new HttpError(400, "Invalid wallet authorization.");
          updated = {
            ...updated,
            address: address(body.address),
            authorization: {
              message: proof.message,
              signature: proof.signature as `0x${string}`,
            },
            walletAuthorizationExpiresAt: expiresAt,
          };
        }
        await storage.put(key, updated);
        return json(updated);
      });
    }
    if (path === "/create") {
      const body = await readJson(request);
      if (typeof body.expiresAt !== "number" || body.expiresAt <= Date.now())
        throw new HttpError(400, "Invalid expiry.");
      const expiresAt = body.expiresAt;
      const created = await this.state.storage.transaction(async (storage) => {
        if (await storage.get(key)) return false;
        await storage.put(key, body);
        const indexed = index(expiresAt);
        if (indexed) {
          await storage.put(indexed, 1);
          await armEarlier(storage, expiresAt);
        } else await storage.setAlarm(expiresAt);
        return true;
      });
      return json({ ok: created }, created ? 201 : 409);
    }
    if (path === "/bind-shared-wallet") {
      const body = await readJson(request);
      if (typeof body.conversation !== "string" || !/^tc-[0-9a-f]{32}$/.test(body.conversation))
        throw new HttpError(400, "Choose a conversation.");
      const conversation = body.conversation;
      return this.state.storage.transaction(async storage => {
        const grant = await storage.get<AuthData>(key);
        const scope = body.scope as WidgetScope | undefined;
        if (!grant || grant.ended || grant.purpose !== "widget-wallet-share" || !grant.sharedWallet ||
          grant.expiresAt <= Date.now() || grant.guestPrincipal !== body.guest ||
          !sameWidgetScope(grant.widgetScope, scope) || grant.widgetScope?.hosted !== scope?.hosted ||
          (grant.shareConversation !== "next" && grant.shareConversation !== conversation))
          throw new HttpError(403, "Verify your wallet again for this conversation.");
        if (grant.shareConversation === "next") await storage.put(key, { ...grant, shareConversation: conversation });
        return json(grant.sharedWallet);
      });
    }
    if (path === "/consume" || path === "/read") {
      const value = await this.state.storage.transaction(async (storage) => {
        const entry = await storage.get<AuthData>(key);
        if (!entry || entry.ended) return null;
        if (path === "/consume" || entry.expiresAt <= Date.now()) {
          await storage.delete(key);
          const indexed = index(entry.expiresAt);
          if (indexed) await storage.delete(indexed);
        }
        return entry.expiresAt > Date.now() ? entry : null;
      });
      return value
        ? json(value)
        : json({ error: "Session or challenge expired." }, 401);
    }
    if (hash && path === "/guest/session") {
      // A guest credential notes a widget session it started, so moving the
      // guest can end it. A consumed or expired credential notes nothing.
      const body = await readJson(request);
      const session = guestSession(body);
      if (!session) throw new HttpError(400, "Invalid session.");
      const claim =
        body.guestClaim === undefined
          ? null
          : readStoredWidgetWallet(body.guestClaim);
      if (
        (body.guestClaim !== undefined &&
          (!claim || body.walletConsent !== true)) ||
        (body.stopSharing !== undefined && (body.stopSharing !== true || claim))
      )
        throw new HttpError(400, "Invalid wallet.");
      return await this.state.storage.transaction(async (storage) => {
        const entry = await storage.get<AuthData>(key);
        const now = Date.now();
        if (
          !entry ||
          entry.expiresAt <= now ||
          entry.purpose !== "widget-guest"
        )
          return json({ error: "Session or challenge expired." }, 401);
        const sessions = (entry.sessions ?? []).filter(
          (live) => live.expiresAt > now,
        );
        if (sessions.length >= GUEST_SESSION_LIMIT)
          return json(
            { error: "Too many open support chats. Try again later." },
            429,
          );
        const updated: AuthData = {
          ...entry,
          ...(claim ? { guestClaim: claim, walletConsent: true as const } : {}),
          sessions: [...sessions, session],
        };
        if (claim) delete updated.walletUnavailable;
        if (body.stopSharing === true) {
          delete updated.guestClaim;
          delete updated.walletConsent;
        }
        await storage.put(key, updated);
        return json({ ok: true });
      });
    }
    if (hash && path === "/end") {
      // Ends a session and keeps its hash taken until the session would
      // have expired, so a create still in flight can't bring it back.
      const body = await readJson(request);
      const until = body.expiresAt;
      if (
        typeof until !== "number" ||
        !Number.isSafeInteger(until) ||
        until > Date.now() + SESSION_TTL
      )
        throw new HttpError(400, "Invalid expiry.");
      await this.state.storage.transaction(async (storage) => {
        const entry = await storage.get<AuthData>(key);
        if (entry && Number.isSafeInteger(entry.expiresAt))
          await storage.delete(index(entry.expiresAt)!);
        const expiresAt = Math.max(until, entry?.expiresAt ?? 0);
        if (expiresAt <= Date.now()) {
          await storage.delete(key);
          return;
        }
        await storage.put(key, {
          address: null,
          expiresAt,
          ended: true,
        } satisfies AuthData);
        await storage.put(index(expiresAt)!, 1);
        await armEarlier(storage, expiresAt);
      });
      return json({ ok: true });
    }
    if (path === "/revoke") {
      await this.state.storage.transaction(async (storage) => {
        if (hash) {
          const entry = await storage.get<AuthData>(key);
          const indexed =
            entry && Number.isSafeInteger(entry.expiresAt)
              ? index(entry.expiresAt)
              : null;
          if (indexed) await storage.delete(indexed);
        }
        await storage.delete(key);
      });
      return json({ ok: true });
    }
    if (path === "/renew") {
      const body = await readJson(request);
      const expiresAt = body.expiresAt;
      if (
        typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > Date.now() + SESSION_TTL
      )
        throw new HttpError(400, "Invalid expiry.");
      const value = await this.state.storage.transaction(async (storage) => {
        const entry = await storage.get<AuthData>(key);
        // Renewal never creates a session or revives a revoked/expired one.
        if (
          !entry ||
          entry.expiresAt <= Date.now() ||
          !Number.isSafeInteger(entry.authenticatedAt) ||
          !Number.isSafeInteger(entry.walletRevision) ||
          !isAuthMethod(entry.authMethod) ||
          !entry.principalId ||
          entry.nonce ||
          entry.message
        )
          return null;
        const authorizationExpiresAt = entry.authorizationExpiresAt;
        if (!Number.isSafeInteger(authorizationExpiresAt)) return null;
        if (authorizationExpiresAt! <= Date.now()) return null;
        const renewed = {
          ...entry,
          authorizationExpiresAt: authorizationExpiresAt!,
          expiresAt: Math.min(
            authorizationExpiresAt!,
            Math.max(entry.expiresAt, expiresAt),
          ),
        };
        await storage.put(key, renewed);
        const indexed = index(renewed.expiresAt);
        if (indexed) {
          if (renewed.expiresAt !== entry.expiresAt)
            await storage.delete(index(entry.expiresAt)!);
          await storage.put(indexed, 1);
          await armEarlier(storage, renewed.expiresAt);
        } else await storage.setAlarm(renewed.expiresAt);
        return renewed;
      });
      return value ? json(value) : json({ error: "Session expired." }, 401);
    }
    return null;
  }
  /** Deletes sharded records whose stored expiry has passed, in bounded
   * batches, then re-arms at the earliest remaining index entry. A renewed
   * record keeps its data: only its stale index entry goes. */
  private async sweepRecords() {
    const storage = this.state.storage;
    // Nothing is indexed: the fired time is forgotten, so the next record
    // arms a sweep of its own.
    if (!(await storage.list({ prefix: EXPIRY_PREFIX, limit: 1 })).size) {
      await storage.delete(ARMED_KEY);
      return;
    }
    await storage.transaction(async (tx) => {
      const now = Date.now();
      const due = await tx.list({
        prefix: EXPIRY_PREFIX,
        end: `${EXPIRY_PREFIX}${String(now + 1).padStart(13, "0")}`,
        limit: SWEEP_BATCH,
      });
      for (const indexed of due.keys()) {
        const hash = indexed.slice(-64);
        const entry = await tx.get<AuthData>(`record:${hash}`);
        if (entry && entry.expiresAt <= now) await tx.delete(`record:${hash}`);
        else if (entry && Number.isSafeInteger(entry.expiresAt))
          await tx.put(expiryKey(entry.expiresAt, hash), 1);
        await tx.delete(indexed);
      }
      const next = await tx.list({ prefix: EXPIRY_PREFIX, limit: 1 });
      const first = [...next.keys()][0];
      if (first === undefined) {
        await tx.delete(ARMED_KEY);
        return;
      }
      const at = Number(first.slice(EXPIRY_PREFIX.length, -65));
      const armAt =
        due.size === SWEEP_BATCH || !Number.isSafeInteger(at) || at <= now
          ? now + 1000
          : at;
      await tx.put(ARMED_KEY, armAt);
      await tx.setAlarm(armAt);
    });
  }
  async alarm() {
    const connect = await expireConnectRequests(this.state.storage);
    await expireConnectCaptures(this.state.storage);
    if (connect) return;
    if (await expireSearchBudget(this.state.storage)) return;
    if (await expireMessageBudget(this.state.storage)) return;
    await expireEmailLedger(this.state.storage);
    await this.sweepRecords();
    // A per-token object holds one `record`.
    if (
      (await this.state.storage.list({ prefix: EXPIRY_PREFIX, limit: 1 })).size
    )
      return;
    await this.state.storage.transaction(async (storage) => {
      const entry = await storage.get<AuthData>("record");
      if (entry && entry.expiresAt > Date.now())
        await storage.setAlarm(entry.expiresAt);
      else await storage.delete("record");
    });
  }
}
