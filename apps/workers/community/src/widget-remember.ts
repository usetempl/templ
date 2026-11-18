/** Remembered widget sign-in.
 *
 * A member who signs the widget's remember statement gets a family: one
 * record in the "remember" auth shards, keyed by sha256(familyId), holding
 * the original proof, the workspace and website it belongs to, the epoch of
 * the workspace's settings at creation and a generation. The browser keeps
 * `familyId.secret(g)`. Resuming trades the current secret for a normal
 * one-hour widget session built from the original proof and moves the family
 * to g + 1. The previous secret within a minute of the rotation answers the
 * same next secret; an older one, or the previous one after that minute,
 * ends the family.
 *
 * Secrets are never stored. The worker derives a per-family key from the
 * WIDGET_REMEMBER_KEY secret and the family id and hands only that to the
 * shard; the shard derives secret(g) from it. Rotating the worker secret
 * therefore ends every family. The family never outlives 30 days from the
 * signature, and a remembered session grants nothing a one-hour widget
 * session doesn't. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  WIDGET_REMEMBER_CREDENTIAL,
  WIDGET_REMEMBER_DAYS,
  type WidgetWallet,
} from "@templ/chat/widget-wallet";
import {
  AUTH_RECORD_HEADER,
  config,
  json,
  record,
  type Env,
} from "./common";
import type { WidgetScope } from "./support-widget";
import type { WidgetSessionEnv } from "./widget-session-config";
import { sameWidgetScope } from "./widget-frame";

export const REMEMBER_TTL_MS = WIDGET_REMEMBER_DAYS * 86_400_000;
/** Two tabs resuming at once, or a lost answer retried, share one rotation. */
export const REMEMBER_GRACE_MS = 60_000;

export type RememberedFamily = {
  purpose: "widget-remembered";
  widgetScope: WidgetScope;
  /** The account at sign-in; resume checks it is still the account's. */
  principalId: ChatPrincipalId;
  servicePrincipals: ChatPrincipalId[];
  network: "evm" | "solana";
  /** EVM: the proven wallet. Solana: null, with solanaAddress set. */
  address: `0x${string}` | null;
  solanaAddress?: string;
  authMethod: "wallet" | "solana";
  authorization?: { message: string; signature: `0x${string}` };
  solanaAuthorization?: { message: string; signature: string };
  /** A contract wallet's chain. */
  contractChain?: number;
  /** The signature's time; never changes. */
  authenticatedAt: number;
  /** authenticatedAt + 30 days; never changes. */
  expiresAt: number;
  /** The workspace's rememberEpoch when the family was made. */
  epoch: number;
  generation: number;
  /** When the family last moved a generation; 0 at creation. */
  rotatedAt: number;
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const bytesOf = (value: string) =>
  new Uint8Array(value.match(/../g)!.map((pair) => parseInt(pair, 16)));
async function hmac(keyHex: string, text: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytesOf(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}
/** Equal-length hex compared without an early exit. */
export function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** The family's own key: HMAC of the family id under the worker secret. */
export function familyKey(masterHex: string, familyId: string) {
  return hmac(masterHex, `templ-widget-remember-v1\n${familyId}`);
}
/** The secret of one generation, from the family's key. */
export function generationSecret(familyKeyHex: string, generation: number) {
  return hmac(familyKeyHex, `generation\n${generation}`);
}
export function parseRememberCredential(value: unknown) {
  if (typeof value !== "string" || !WIDGET_REMEMBER_CREDENTIAL.test(value))
    return null;
  const [familyId, secret] = value.split(".");
  return { familyId, secret };
}
const HEX64 = /^[0-9a-f]{64}$/;

/** The family's shard by the family hash a session keeps, for sign-out. */
function familyShard(env: Env, hash: string) {
  const shard = env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${config(env).namespace}:auth-shard:v1:remember:${hash[0]}`,
    ),
  );
  return {
    fetch(path: string, body: unknown) {
      return shard.fetch(
        new Request(`https://internal${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [AUTH_RECORD_HEADER]: hash,
          },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}
const post = (path: string, body: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Makes a family for a session verify just wrote. Returns the credential
 * and its expiry, or null when anything failed: the member is still signed
 * in, without staying signed in. */
export async function createFamily(
  env: Env & WidgetSessionEnv,
  familyId: string,
  input: Omit<
    RememberedFamily,
    "purpose" | "expiresAt" | "generation" | "rotatedAt"
  >,
): Promise<{ credential: string; expiresAt: number } | null> {
  try {
    const family: RememberedFamily = {
      ...input,
      purpose: "widget-remembered",
      expiresAt: input.authenticatedAt + REMEMBER_TTL_MS,
      generation: 1,
      rotatedAt: 0,
    };
    const created = await (
      await record(env, "remember", familyId)
    ).fetch(post("/create", family));
    if (!created.ok) return null;
    const secret = await generationSecret(
      await familyKey(env.WIDGET_REMEMBER_KEY!, familyId),
      1,
    );
    return { credential: `${familyId}.${secret}`, expiresAt: family.expiresAt };
  } catch {
    return null;
  }
}

export type ResumeOutcome =
  | { ok: true; family: RememberedFamily; credential: string }
  | {
      ok: false;
      status: 401 | 409 | 503;
      reason:
        | "remember-ended"
        | "remember-reused"
        | "remember-other-wallet"
        | "remember-unavailable";
    };

/** The shard transaction for one resume. */
export async function resumeFamily(
  env: Env & WidgetSessionEnv,
  credential: { familyId: string; secret: string },
  input: { scope: WidgetScope; epoch: number; claim: WidgetWallet; now: number },
): Promise<ResumeOutcome> {
  const key = await familyKey(env.WIDGET_REMEMBER_KEY!, credential.familyId);
  const answer = await (
    await record(env, "remember", credential.familyId)
  ).fetch(
    post("/remember/resume", {
      familyKey: key,
      secret: credential.secret,
      scope: input.scope,
      epoch: input.epoch,
      claim: input.claim,
    }),
  );
  if (answer.status === 200) {
    const { family, generation } = await answer.json<{
      family: RememberedFamily;
      generation: number;
    }>();
    return {
      ok: true,
      family,
      credential: `${credential.familyId}.${await generationSecret(key, generation)}`,
    };
  }
  if (answer.status === 401 || answer.status === 409) {
    const { reason } = await answer
      .json<{ reason?: string }>()
      .catch(() => ({ reason: undefined }));
    if (answer.status === 409) return { ok: false, status: 409, reason: "remember-other-wallet" };
    return {
      ok: false,
      status: 401,
      reason: reason === "remember-reused" ? "remember-reused" : "remember-ended",
    };
  }
  return { ok: false, status: 503, reason: "remember-unavailable" };
}

/** Ends the family behind a credential when it is current or one back and
 * belongs to this website and workspace. Answers nothing either way. */
export async function forgetFamily(
  env: Env & WidgetSessionEnv,
  credential: { familyId: string; secret: string },
  scope: WidgetScope,
) {
  const key = await familyKey(env.WIDGET_REMEMBER_KEY!, credential.familyId);
  const answer = await (
    await record(env, "remember", credential.familyId)
  ).fetch(
    post("/remember/forget", { familyKey: key, secret: credential.secret, scope }),
  );
  await answer.body?.cancel();
}
/** Ends a family by the hash a remembered session keeps. */
export async function endFamily(env: Env, hash: string) {
  if (!HEX64.test(hash)) return;
  const answer = await familyShard(env, hash).fetch("/revoke", {});
  await answer.body?.cancel();
}

/* ---------------------------------------------------------------------- */
/* Shard side                                                              */
/* ---------------------------------------------------------------------- */

type ShardStorage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
const isFamily = (value: unknown): value is RememberedFamily => {
  const family = value as RememberedFamily | undefined;
  return (
    !!family &&
    family.purpose === "widget-remembered" &&
    Number.isSafeInteger(family.generation) &&
    family.generation >= 1 &&
    Number.isSafeInteger(family.rotatedAt) &&
    Number.isSafeInteger(family.expiresAt) &&
    Number.isSafeInteger(family.epoch) &&
    typeof family.widgetScope?.room === "string" &&
    typeof family.widgetScope?.origin === "string"
  );
};
/** Same workspace, website and side of Templ's frame (widget-frame.ts). */
const sameScope = (family: RememberedFamily, scope: unknown) =>
  sameWidgetScope(family.widgetScope, scope as WidgetScope | undefined);
const sameWallet = (family: RememberedFamily, claim: unknown) => {
  const wallet = claim as WidgetWallet | undefined;
  if (!wallet || wallet.network !== family.network) return false;
  return family.network === "solana"
    ? wallet.address === family.solanaAddress
    : wallet.address === family.address;
};
/** Which generation a presented secret names, from the newest back: 0 is
 * current, 1 the previous one, and so on to three back; -1 is none. */
async function presentedGeneration(
  family: RememberedFamily,
  familyKeyHex: string,
  secret: string,
) {
  for (let back = 0; back <= 3 && family.generation - back >= 1; back++)
    if (
      sameSecret(
        await generationSecret(familyKeyHex, family.generation - back),
        secret,
      )
    )
      return back;
  return -1;
}
const refused = (status: 401 | 409, reason: string) =>
  json({ error: "Sign in again.", reason }, status);

/** `/remember/resume` and `/remember/forget` on one family record, inside
 * the shard's transaction. `drop` deletes the record and its index row. */
export async function rememberRecordRequest(
  storage: ShardStorage,
  path: string,
  key: string,
  body: Record<string, unknown>,
  drop: (family: RememberedFamily) => Promise<void>,
  now: number,
): Promise<Response | null> {
  if (path !== "/remember/resume" && path !== "/remember/forget") return null;
  const familyKeyHex = typeof body.familyKey === "string" ? body.familyKey : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!HEX64.test(familyKeyHex) || !HEX64.test(secret))
    return json({ error: "Invalid record." }, 400);
  const family = await storage.get<unknown>(key);
  if (path === "/remember/forget") {
    if (isFamily(family) && sameScope(family, body.scope)) {
      const back = await presentedGeneration(family, familyKeyHex, secret);
      if (back === 0 || back === 1) await drop(family);
    }
    return json({ ok: true });
  }
  if (!isFamily(family) || family.expiresAt <= now)
    return refused(401, "remember-ended");
  // The secret first: a caller without it learns nothing about the family.
  const back = await presentedGeneration(family, familyKeyHex, secret);
  if (back < 0) return refused(401, "remember-ended");
  const grace = back === 1 && now - family.rotatedAt <= REMEMBER_GRACE_MS;
  if (back > 0 && !grace) {
    await drop(family);
    return refused(401, "remember-reused");
  }
  if (!sameScope(family, body.scope)) return refused(401, "remember-ended");
  if (!Number.isSafeInteger(body.epoch) || family.epoch < Number(body.epoch)) {
    await drop(family);
    return refused(401, "remember-ended");
  }
  if (!sameWallet(family, body.claim))
    return refused(409, "remember-other-wallet");
  if (back === 0) {
    const rotated: RememberedFamily = {
      ...family,
      generation: family.generation + 1,
      rotatedAt: now,
    };
    await storage.put(key, rotated);
    return json({ family: rotated, generation: rotated.generation });
  }
  // Within the grace: the same next secret again, and nothing changes.
  return json({ family, generation: family.generation });
}
