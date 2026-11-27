/** Keys and secrets for alert destinations. One worker secret,
 * `WEBHOOK_SECRET_KEY` (64 hex, 32 bytes), encrypts every destination's
 * URL, token or signing secret with AES-GCM. The additional data names the
 * room, the destination and its kind, so a row copied to another workspace
 * or kind does not decrypt. Plaintext exists only inside the settings route
 * and the send adapter; it is never returned, logged, audited or exported. */

export type AlertSecretBox = { kv: 1; iv: string; ct: string };
export type AlertCryptoEnv = { WEBHOOK_SECRET_KEY?: string };

const KEY = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export class AlertSecretUnreadable extends Error {
  constructor() {
    super("alert secret unreadable");
    this.name = "AlertSecretUnreadable";
  }
}

export function alertKeyConfigured(env: AlertCryptoEnv): boolean {
  return typeof env.WEBHOOK_SECRET_KEY === "string" && KEY.test(env.WEBHOOK_SECRET_KEY);
}
function keyBytes(env: AlertCryptoEnv): Uint8Array {
  if (!alertKeyConfigured(env)) throw new AlertSecretUnreadable();
  const hex = env.WEBHOOK_SECRET_KEY!;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function fromBase64(value: string): Uint8Array {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const alertAad = (room: string, destId: string, kind: string) =>
  `alert-dest:${room}:${destId}:${kind}:1`;

async function aesKey(env: AlertCryptoEnv) {
  return crypto.subtle.importKey("raw", keyBytes(env), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function sealAlertSecret(
  env: AlertCryptoEnv,
  aad: string,
  plaintext: unknown,
): Promise<AlertSecretBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    await aesKey(env),
    encoder.encode(JSON.stringify(plaintext)),
  );
  return { kv: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}
/** The decrypted JSON, or `AlertSecretUnreadable` for a missing key, a
 * wrong key, other additional data or a damaged box. */
export async function openAlertSecret<T>(
  env: AlertCryptoEnv,
  aad: string,
  box: unknown,
): Promise<T> {
  try {
    const value = box as AlertSecretBox;
    if (
      !value ||
      value.kv !== 1 ||
      typeof value.iv !== "string" ||
      typeof value.ct !== "string"
    )
      throw new AlertSecretUnreadable();
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(value.iv),
        additionalData: encoder.encode(aad),
      },
      await aesKey(env),
      fromBase64(value.ct),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new AlertSecretUnreadable();
  }
}

async function hmacRaw(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(data)),
  );
}
/** The stored hash of a Telegram confirmation code. */
export async function alertCodeHash(
  env: AlertCryptoEnv,
  destId: string,
  code: string,
): Promise<string> {
  return hex(await hmacRaw(keyBytes(env), `telegram-code:${destId}:${code}`));
}
/** Constant-time comparison of two equal-length strings. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Six random digits, uniform. */
export function confirmationCode(): string {
  const values = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(values);
    // Reject the top slice so the modulo stays uniform.
    if (values[0] < 4_294_000_000) return String(values[0] % 1_000_000).padStart(6, "0");
  }
}
/** A Standard Webhooks signing secret: `whsec_` + base64 of 32 random
 * bytes. */
export function newSigningSecret(): string {
  return `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}
/** Standard Webhooks: `v1,<base64 HMAC-SHA256(secret, "<id>.<ts>.<body>")>`
 * where the key is the base64 decode of the secret after `whsec_`. */
export async function standardWebhookSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = fromBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  return `v1,${toBase64(await hmacRaw(key, `${id}.${timestamp}.${body}`))}`;
}
export async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
/** A keyed hex HMAC-SHA256 under an arbitrary text secret. */
export async function keyedHex(secret: string, value: string): Promise<string> {
  return hex(await hmacRaw(encoder.encode(secret), value));
}
/** 32 random bytes, base64url without padding. */
export function randomToken(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
