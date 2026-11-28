import { encodeWidgetSolanaSignature } from "@templ/chat/widget-wallet";
import { createSiweMessage } from "viem/siwe";
import { base58Encode, createSolanaSignInMessage } from "@templ/chat/solana";

/** Production-shaped wallet session for worker route tests with an injected
 * authority verifier. The signature is deliberately inert; the test's
 * verifier owns the cryptographic boundary while the worker still parses the
 * exact SIWE fields and canonical principal binding used in production. */
export function walletSessionFixture(
  address: string,
  expiresAt = Date.now() + 30 * 86_400_000,
) {
  const principalId = address.toLowerCase();
  const message = createSiweMessage({
    address: principalId as `0x${string}`,
    chainId: 4663,
    domain: "templ.vip",
    uri: "https://templ.vip",
    version: "1",
    nonce: "fixture1",
    issuedAt: new Date(),
    expirationTime: new Date(expiresAt),
  });
  return {
    principalId,
    servicePrincipals: [principalId],
    address: principalId,
    authenticatedAt: Date.now(),
    authMethod: "wallet" as const,
    expiresAt,
    authorizationExpiresAt: expiresAt,
    walletAuthorizationExpiresAt: expiresAt,
    walletRevision: 0,
    authorization: { message, signature: "0x12" },
  };
}

/** Production-shaped Solana session for worker route tests. A throwaway
 * Ed25519 key signs a Sign In With Solana text, which the worker verifies
 * again on every read, and `identity` (the identity object's storage) gets
 * the records that list that wallet on `principalId`'s account: its profile
 * and the `identity-solana:` index. An existing profile keeps its fields. */
export async function solanaSessionFixture(input: {
  principalId: string;
  identity: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<unknown>;
  };
  origin?: string;
  expiresAt?: number;
}) {
  const origin = new URL(input.origin ?? "https://templ.vip");
  const expiresAt = input.expiresAt ?? Date.now() + 30 * 86_400_000;
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const solanaAddress = base58Encode(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
  );
  const message = createSolanaSignInMessage({
    domain: origin.host,
    address: solanaAddress,
    uri: origin.origin,
    nonce: "fixture1",
    statement: "Sign in to your Templ chat.",
    issuedAt: new Date(),
    expirationTime: new Date(expiresAt),
  });
  const signature = encodeWidgetSolanaSignature(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        new TextEncoder().encode(message),
      ),
    ),
  );
  const profileKey = `identity-profile:${input.principalId}`;
  const profile = ((await input.identity.get(profileKey)) as
    | Record<string, unknown>
    | undefined) ?? {
    principalId: input.principalId,
    servicePrincipals: [input.principalId],
    wallet: null,
    email: null,
    emailKey: null,
    emailVerifiedAt: null,
  };
  await input.identity.put(profileKey, {
    ...profile,
    solana: [
      ...((profile.solana as unknown[] | undefined) ?? []),
      { address: solanaAddress, linkedAt: Date.now() },
    ],
  });
  await input.identity.put(
    `identity-solana:${solanaAddress}`,
    input.principalId,
  );
  return {
    principalId: input.principalId,
    servicePrincipals: [input.principalId],
    address: null,
    solanaAddress,
    solanaAuthorization: { message, signature },
    authenticatedAt: Date.now(),
    authMethod: "solana" as const,
    expiresAt,
    authorizationExpiresAt: expiresAt,
    walletRevision: 0,
  };
}

type ShardEntry = {
  storage: {
    data: Map<string, unknown>;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<unknown>;
  };
  instance: { fetch(request: Request): Promise<Response> };
};
/** One sharded auth record in a test namespace, found from the token in a
 * cookie (or the bare token): its shard's storage viewed through
 * `record:<hash>`, and a fetch that names the record the way the worker's
 * `record()` does. */
export async function shardRecord(
  objects: Map<string, ShardEntry>,
  cookieOrToken: string,
  kind: "session" | "nonce" | "guest" = "session",
) {
  const token = /(?:^|=)([0-9a-f]{64})(?:;|$)/.exec(cookieOrToken)?.[1];
  if (!token) throw new Error("No record token in the cookie.");
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const entry = [...objects].find(([name]) =>
    name.endsWith(`:auth-shard:v1:${kind}:${hash[0]}`),
  )?.[1];
  if (!entry) throw new Error(`No ${kind} shard for this token.`);
  const key = `record:${hash}`;
  return {
    key,
    hash,
    storage: entry.storage,
    get: <T = any>() => entry.storage.get(key) as Promise<T | undefined>,
    put: (value: unknown) => entry.storage.put(key, value),
    has: () => entry.storage.data.has(key),
    fetch(request: Request) {
      const headers = new Headers(request.headers);
      headers.set("X-Auth-Record", hash);
      return entry.instance.fetch(new Request(request, { headers }));
    },
  };
}
