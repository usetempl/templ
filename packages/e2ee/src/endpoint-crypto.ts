/** This module runs only at approved decryption endpoints. Never import it
 * into the Templ relay, another customer's hosted AI or the main app server.
 * Templ's own support endpoint uses its separately scoped Own profile. */
import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import {
  base64url,
  decoded,
  EncryptionProtocolError,
  headerBytes,
  authorBytes,
  utf8,
  type EncryptedRecord,
} from "./protocol";
import { sha256 } from "./verify";

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
export type EndpointKeys = {
  encryption: CryptoKeyPair;
  signing: CryptoKeyPair;
};
export async function endpointKeys(): Promise<EndpointKeys> {
  const [encryption, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]),
  ]);
  return { encryption, signing };
}
export async function exportPublic(key: CryptoKey): Promise<string> {
  if (key.type !== "public")
    throw new EncryptionProtocolError("encryption-integrity");
  return base64url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}
export async function sign(key: CryptoKey, data: Uint8Array): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        Uint8Array.from(data),
      ),
    ),
  );
}
const keyInfo = utf8("templ:e2ee:record-key:v1");
export async function wrapAad(
  record: EncryptedRecord,
  recipient: string,
): Promise<Uint8Array> {
  return utf8(
    JSON.stringify([
      "templ:e2ee:record-key-wrap:v1",
      base64url(headerBytes(record)),
      record.nonce,
      await sha256(decoded(record.ciphertext, 17, 16_400)),
      recipient,
    ]),
  );
}
export async function encryptForRecipients(
  record: EncryptedRecord,
  plaintext: Uint8Array,
  recipients: { id: string; publicKey: string }[],
  signingKey: CryptoKey,
): Promise<EncryptedRecord> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    record.nonce = base64url(iv);
    record.ciphertext = base64url(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: Uint8Array.from(headerBytes(record)),
            tagLength: 128,
          },
          key,
          Uint8Array.from(plaintext),
        ),
      ),
    );
    record.recipients = await wrapRecordKey(record, rawKey, recipients);
    record.signature = await sign(signingKey, authorBytes(record));
    return record;
  } finally {
    rawKey.fill(0);
  }
}
export async function wrapRecordKey(
  record: EncryptedRecord,
  rawKey: Uint8Array,
  recipients: { id: string; publicKey: string }[],
): Promise<EncryptedRecord["recipients"]> {
  return Promise.all(
    [...recipients]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(async (recipient) => {
        const publicKey = await suite.kem.deserializePublicKey(
          decoded(recipient.publicKey, 65),
        );
        // A fresh single-shot HPKE context for every recipient and operation.
        // No mutable nonce/counter context survives a send, retry or restart.
        const wrapped = await suite.seal(
          { recipientPublicKey: publicKey, info: keyInfo },
          rawKey,
          await wrapAad(record, recipient.id),
        );
        return {
          id: recipient.id,
          encapsulatedKey: base64url(new Uint8Array(wrapped.enc)),
          encryptedKey: base64url(new Uint8Array(wrapped.ct)),
        };
      }),
  );
}
export async function unwrapRecordKey(
  record: EncryptedRecord,
  recipientId: string,
  keys: CryptoKeyPair,
): Promise<Uint8Array> {
  const recipient = record.recipients.find((item) => item.id === recipientId);
  if (!recipient) throw new EncryptionProtocolError("encryption-integrity");
  try {
    const keyBytes = new Uint8Array(
      await suite.open(
        {
          recipientKey: keys,
          enc: decoded(recipient.encapsulatedKey, 65),
          info: keyInfo,
        },
        decoded(recipient.encryptedKey, 48),
        await wrapAad(record, recipientId),
      ),
    );
    if (keyBytes.length !== 32) throw new Error("invalid key size");
    return keyBytes;
  } catch {
    throw new EncryptionProtocolError("encryption-integrity");
  }
}
export async function decryptWithRecordKey(
  record: EncryptedRecord,
  keyBytes: Uint8Array,
): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyBytes),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decoded(record.nonce, 12),
          additionalData: Uint8Array.from(headerBytes(record)),
          tagLength: 128,
        },
        key,
        decoded(record.ciphertext, 17, 16_400),
      ),
    );
  } catch {
    throw new EncryptionProtocolError("encryption-integrity");
  }
}
export async function decryptAtEndpoint(
  record: EncryptedRecord,
  recipientId: string,
  keys: CryptoKeyPair,
): Promise<Uint8Array> {
  const keyBytes = await unwrapRecordKey(record, recipientId, keys);
  try {
    return await decryptWithRecordKey(record, keyBytes);
  } finally {
    keyBytes.fill(0);
  }
}
