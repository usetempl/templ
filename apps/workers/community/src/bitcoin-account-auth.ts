import { bitcoinAccountAvailable } from "./bitcoin-account-availability";
import {
  bitcoinAccountMessage,
  validateBitcoinAccountChallenge,
  type BitcoinAccountChallenge,
} from "@templ/chat/bitcoin-account-auth";
import type { ChatSession } from "@templ/chat/principal";
import type { AuthData } from "./auth-record";
import type { AccountIdentity } from "./account-identity";
import { accountMethodsView } from "./account-methods";
import {
  canonicalBitcoinProofAddress,
  verifyBitcoinWalletProof,
} from "./bitcoin-wallet-proof";
import { connectCode, connectRequest, requireConnectEnabled } from "./connect";
import {
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
  SESSION_TTL,
  siteOrigins,
  type Env,
} from "./common";
import { linkedWalletsCall } from "./linked-wallets";
import { sessionCacheKey } from "./session-key";

type Current = ChatSession & { token: string };
type Auth<S extends Current> = {
  session: () => Promise<S>;
  preview: (body: Record<string, unknown>, session: S) => Promise<void>;
  guard: (body: Record<string, unknown>, session: S) => void;
  saveNonce: (nonce: string, data: AuthData) => Promise<void>;
  startSession: (token: string, data: AuthData) => Promise<ChatSession>;
};
function walletAddress(value: unknown): string {
  const result = canonicalBitcoinProofAddress(value);
  if (!result)
    throw new HttpError(
      400,
      "Use a Bitcoin mainnet SegWit or Taproot address.",
    );
  return result;
}
function signatureInput(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 155) return false;
  const base64 = raw.startsWith("smp") ? raw.slice(3) : raw;
  try {
    return !!base64 && btoa(atob(base64)) === base64;
  } catch {
    return false;
  }
}

/** Recheck the original login consent and the exact wallet registration.
 * Removing and re-adding the same key creates a new registration. */
export function bitcoinSessionAuthorized(
  data: AuthData,
  account: AccountIdentity,
  origin: string,
) {
  const proof = data.bitcoinAuthorization;
  if (
    !proof ||
    data.authMethod !== "bitcoin" ||
    !data.bitcoinAddress ||
    data.widgetScope ||
    data.purpose !== undefined ||
    data.guestClaim !== undefined ||
    data.contractChain !== undefined ||
    data.solanaAddress ||
    data.solanaAuthorization ||
    data.principalId !== account.principalId ||
    !account.bitcoin?.some(
      (wallet) =>
        wallet.address === data.bitcoinAddress &&
        wallet.credentialId === proof.credentialId,
    )
  )
    return false;
  const c = proof.challenge;
  if (
    !c ||
    (c.purpose !== "login" && c.purpose !== "connect") ||
    c.origin !== origin ||
    c.address !== data.bitcoinAddress ||
    c.connectCode !== data.connectCode ||
    !Number.isSafeInteger(data.authenticatedAt) ||
    data.authenticatedAt! < c.issuedAt ||
    data.authenticatedAt! >= c.expiresAt
  )
    return false;
  try {
    return verifyBitcoinWalletProof(
      c.address,
      bitcoinAccountMessage(c),
      proof.signature,
    );
  } catch {
    return false;
  }
}

export async function bitcoinAccountRoute<S extends Current>(
  request: Request,
  env: Env,
  auth: Auth<S>,
) {
  const url = new URL(request.url);
  const path = url.pathname;
  function previewVersion(body: Record<string, unknown>) {
    const version = env.CF_VERSION_METADATA?.id;
    if (
      env.APP_ORIGIN !== "https://usetempl.com" ||
      env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED !== "true" ||
      typeof version !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(version) ||
      body.workerVersion !== version
    )
      throw new HttpError(404, "Sign-in preview is not available.");
    return version;
  }
  async function authorizePreview(body: Record<string, unknown>, actor: S) {
    await auth.preview(body, actor);
    if (!actor.principalId.startsWith("account:"))
      throw new HttpError(403, "Use an existing test account.");
  }
  if (path === "/auth/bitcoin/preview/capability" && request.method === "GET") {
    const body = {
      expectedPrincipalId: url.searchParams.get("expectedPrincipalId"),
      workspaceId: url.searchParams.get("workspaceId"),
      workerVersion: url.searchParams.get("workerVersion"),
      confirmed: true,
    };
    const workerVersion = previewVersion(body);
    await authorizePreview(body, await auth.session());
    return json({ eligible: true, workerVersion });
  }
  const match =
    /^\/auth\/bitcoin\/(preview\/)?(nonce|verify|attach\/nonce|attach\/verify|remove)$/.exec(
      path,
    );
  if (!match || request.method !== "POST")
    throw new HttpError(404, "Not found.");
  const [, preview, route] = match;
  if (preview && route === "remove") throw new HttpError(404, "Not found.");
  const available = await bitcoinAccountAvailable(env);
  if (
    route !== "remove" &&
    (preview ? env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED !== "true" : !available)
  )
    throw new HttpError(404, "Bitcoin account sign-in is unavailable.");
  const origin = siteOrigins(env).appOrigin;
  const actor =
    preview || route.startsWith("attach/") || route === "remove"
      ? await auth.session()
      : null;
  const session =
    route.startsWith("attach/") || route === "remove" ? actor : null;
  const body = await readJson(request, 4096);
  if (preview && actor) {
    previewVersion(body);
    if (body.connectCode !== undefined)
      throw new HttpError(400, "Use a test account sign-in challenge.");
    await authorizePreview(body, actor);
  } else if (actor) auth.guard(body, actor);
  const previewSession =
    preview && actor
      ? await sessionCacheKey(
          [actor.token, body.workspaceId, body.workerVersion].join(":"),
        )
      : undefined;
  const methods = (current: Current) =>
    accountMethodsView(env, {
      principalId: current.principalId,
      address:
        current.bitcoinAddress ?? current.solanaAddress ?? current.address,
    });
  if (route === "remove" && session) {
    await linkedWalletsCall(env, {
      op: "bitcoin-remove",
      bitcoinAvailable: available,
      principalId: session.principalId,
      address: walletAddress(body.address),
    });
    return json({ ok: true, methods: await methods(session) });
  }
  const sessionHash = session
    ? await sessionCacheKey(session.token)
    : undefined;
  if (route === "nonce" || route === "attach/nonce") {
    const address = walletAddress(body.address);
    if (session && body.connectCode !== undefined)
      throw new HttpError(400, "Invalid wallet link request.");
    const code =
      body.connectCode === undefined
        ? undefined
        : connectCode(body.connectCode);
    let deadline = session?.expiresAt ?? Infinity;
    if (code) {
      requireConnectEnabled(env);
      const connection = await connectRequest(env, { op: "read", code });
      deadline = connection.expiresAt;
    }
    const issuedAt = Date.now();
    const expiresAt = Math.min(issuedAt + NONCE_TTL, deadline);
    if (expiresAt <= issuedAt)
      throw new HttpError(401, "Request a new challenge.");
    const nonce = randomToken();
    const challenge: BitcoinAccountChallenge = {
      origin,
      address,
      nonce,
      issuedAt,
      expiresAt,
      ...(session
        ? ({
            purpose: "attach",
            principalId: session.principalId,
            sessionHash,
          } as const)
        : code
          ? ({ purpose: "connect", connectCode: code } as const)
          : ({ purpose: "login" } as const)),
    };
    const message = bitcoinAccountMessage(challenge);
    await auth.saveNonce(nonce, {
      address: null,
      purpose: session ? "bitcoin-attach" : "bitcoin-login",
      bitcoinChallenge: challenge,
      ...(previewSession ? { bitcoinPreviewSession: previewSession } : {}),
      message,
      nonce,
      expiresAt,
    });
    return json({ message, expiresAt, challenge }, 200, {
      "Set-Cookie": cookie(
        NONCE_COOKIE,
        nonce,
        Math.floor((expiresAt - issuedAt) / 1000),
      ),
    });
  }
  if (
    typeof body.message !== "string" ||
    body.message.length > 1024 ||
    !signatureInput(body.signature)
  )
    throw new HttpError(400, "Invalid signed message.");
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!nonce || !/^[a-f0-9]{64}$/.test(nonce))
    throw new HttpError(401, "Request a new challenge.");
  const consumed = await (
    await record(env, "nonce", nonce)
  ).fetch(new Request("https://internal/consume", { method: "POST" }));
  if (consumed.status === 401)
    throw new HttpError(401, "Challenge expired or already used.");
  if (!consumed.ok)
    throw new HttpError(503, "Sign-in is temporarily unavailable.");
  const stored = await consumed.json<AuthData>();
  const c = stored.bitcoinChallenge;
  const authenticatedAt = Date.now();
  if (
    stored.bitcoinPreviewSession !== previewSession ||
    stored.purpose !== (session ? "bitcoin-attach" : "bitcoin-login") ||
    !c ||
    stored.nonce !== nonce ||
    c.nonce !== nonce ||
    stored.message !== body.message ||
    c.sessionHash !== sessionHash ||
    !validateBitcoinAccountChallenge(
      { challenge: c, message: body.message, expiresAt: stored.expiresAt },
      {
        origin,
        address: c.address,
        purpose: session ? "attach" : c.connectCode ? "connect" : "login",
        ...(session
          ? { principalId: session.principalId }
          : { connectCode: c.connectCode }),
      },
      authenticatedAt,
    ) ||
    !verifyBitcoinWalletProof(c.address, body.message, body.signature)
  )
    throw new HttpError(401, "Signature does not match the challenge.");
  if (session) {
    await linkedWalletsCall(env, {
      op: "bitcoin-link",
      principalId: session.principalId,
      address: c.address,
    });
    return json(
      { ok: true, address: c.address, methods: await methods(session) },
      200,
      { "Set-Cookie": cookie(NONCE_COOKIE, "", 0) },
    );
  }
  if (c.connectCode) requireConnectEnabled(env);
  const { identity } = await linkedWalletsCall<{
    identity: AccountIdentity | null;
  }>(
    env,
    preview && actor
      ? {
          op: "bitcoin-preview-login",
          address: c.address,
          principalId: actor.principalId,
        }
      : { op: "bitcoin-login", address: c.address },
  );
  if (!identity && preview)
    throw new HttpError(
      403,
      "Use the Bitcoin wallet linked to this test account.",
    );
  if (!identity)
    throw new HttpError(503, "Account details are temporarily unavailable.");
  const credential = identity.bitcoin?.find(
    (wallet) => wallet.address === c.address,
  );
  if (!credential)
    throw new HttpError(503, "Account details are temporarily unavailable.");
  const token = randomToken();
  const expiresAt = authenticatedAt + SESSION_TTL;
  const data: AuthData = {
    address: null,
    bitcoinAddress: c.address,
    principalId: identity.principalId,
    servicePrincipals: identity.servicePrincipals,
    authMethod: "bitcoin",
    authenticatedAt,
    expiresAt,
    authorizationExpiresAt: expiresAt,
    walletRevision: 0,
    bitcoinAuthorization: {
      challenge: c,
      signature: body.signature,
      credentialId: credential.credentialId,
    },
  };
  if (c.connectCode) {
    await connectRequest(env, {
      op: "claim",
      code: c.connectCode,
      principalId: identity.principalId,
      sessionHash: await sessionCacheKey(token),
    });
    data.connectCode = c.connectCode;
  }
  const view = await auth.startSession(token, data);
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    cookie(SESSION_COOKIE, token, SESSION_TTL / 1000),
  );
  headers.append("Set-Cookie", cookie(NONCE_COOKIE, "", 0));
  return json(view, 200, headers);
}
