/** Customer-origin client. Private CryptoKeys stay at that origin. Templ
 * receives only the returned encrypted record and customer validation receipt. */
import {
  E2EE_LIMITS,
  E2EE_SUITE,
  EncryptionProtocolError,
  bytesOf,
  caseOf,
  parseCertificate,
  parseEncryptedRecord,
  parseScope,
  sameScope,
  utf8,
  type EncryptionProfile,
  type E2eeScope,
  type E2eePurpose,
  parseRecoveredRecordKey,
  recoveredKeyBytes,
  type EndpointCertificate,
  type EncryptedRecord,
} from "./protocol";
import {
  verifyCertificate,
  verifyEncryptionProfile,
  verifyAcceptedRecord,
  verifySignature,
  encryptedRecordDigest,
} from "./verify";
import {
  endpointKeys,
  exportPublic,
  encryptForRecipients,
  decryptAtEndpoint,
  type EndpointKeys,
} from "./endpoint-crypto";
export {
  endpointKeys as createEndpointKeys,
  exportPublic,
} from "./endpoint-crypto";
export type { EndpointKeys } from "./endpoint-crypto";

export async function encryptRecord(input: {
  profile: EncryptionProfile;
  pinnedRoot: string;
  scope: E2eeScope;
  certificate: EndpointCertificate;
  keys: EndpointKeys;
  purpose: E2eePurpose;
  content: unknown;
  recipients: { certificate: EndpointCertificate }[];
  id?: string;
  replyIntent?: "answer" | "update" | null;
  now?: number;
}): Promise<EncryptedRecord> {
  const now = input.now ?? Date.now();
  const profile = await verifyEncryptionProfile(
      input.profile,
      input.pinnedRoot,
    ),
    scope = parseScope(input.scope);
  const certificate = parseCertificate(input.certificate);
  await verifyCertificate(profile, certificate, now);
  if (
    JSON.stringify(caseOf(certificate)) !== JSON.stringify(caseOf(scope)) ||
    !certificate.audiences.includes(scope.audience) ||
    certificate.signingKey !==
      (await exportPublic(input.keys.signing.publicKey)) ||
    certificate.encryptionKey !==
      (await exportPublic(input.keys.encryption.publicKey))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const serialized = JSON.stringify(input.content);
  if (
    typeof serialized !== "string" ||
    bytesOf(serialized) > E2EE_LIMITS.innerBytes ||
    !serialized.length ||
    input.recipients.length > E2EE_LIMITS.recipients - 1
  )
    throw new EncryptionProtocolError();
  const recipients = new Map<string, string>([
    [profile.recoveryRecipient, profile.recoveryKey],
    [certificate.id, certificate.encryptionKey],
  ]);
  for (const { certificate: raw } of input.recipients) {
    const other = parseCertificate(raw);
    await verifyCertificate(profile, other, now);
    if (
      JSON.stringify(caseOf(other)) !== JSON.stringify(caseOf(scope)) ||
      !other.audiences.includes(scope.audience)
    )
      throw new EncryptionProtocolError("encryption-scope-changed");
    const prior = recipients.get(other.id);
    if (prior && prior !== other.encryptionKey)
      throw new EncryptionProtocolError("encryption-integrity");
    recipients.set(other.id, other.encryptionKey);
  }
  if (
    recipients.size > E2EE_LIMITS.recipients ||
    certificate.id === profile.recoveryRecipient
  )
    throw new EncryptionProtocolError();
  const record: EncryptedRecord = {
    v: 1,
    suite: E2EE_SUITE,
    scope,
    id: input.id ?? crypto.randomUUID(),
    sender: certificate.id,
    purpose: input.purpose,
    replyIntent: input.replyIntent ?? null,
    nonce: "",
    ciphertext: "",
    recipients: [],
    certificate,
    signature: "",
  };
  return parseEncryptedRecord(
    await encryptForRecipients(
      record,
      utf8(serialized),
      [...recipients].map(([id, publicKey]) => ({ id, publicKey })),
      input.keys.signing.privateKey,
    ),
  );
}

export async function decryptRecord(input: {
  profile: EncryptionProfile;
  pinnedRoot: string;
  record: unknown;
  receipt: unknown;
  scope: E2eeScope;
  recipientId: string;
  keys: EndpointKeys;
}): Promise<unknown> {
  const profile = await verifyEncryptionProfile(
    input.profile,
    input.pinnedRoot,
  );
  const record = await verifyAcceptedRecord(
    profile,
    input.record,
    input.receipt,
  );
  if (!sameScope(record.scope, input.scope))
    throw new EncryptionProtocolError("encryption-scope-changed");
  const plaintext = await decryptAtEndpoint(
    record,
    input.recipientId,
    input.keys.encryption,
  );
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    throw new EncryptionProtocolError("encryption-integrity");
  } finally {
    plaintext.fill(0);
  }
}
export async function decryptRecoveredRecord(input: {
  profile: EncryptionProfile;
  pinnedRoot: string;
  record: unknown;
  receipt: unknown;
  recoveredKey: unknown;
  certificate: EndpointCertificate;
  keys: EndpointKeys;
  authorizationRevision: number;
  now?: number;
}): Promise<unknown> {
  const now = input.now ?? Date.now(),
    profile = await verifyEncryptionProfile(input.profile, input.pinnedRoot);
  const record = await verifyAcceptedRecord(
      profile,
      input.record,
      input.receipt,
    ),
    pack = parseRecoveredRecordKey(input.recoveredKey);
  await verifyCertificate(profile, input.certificate, now);
  if (
    pack.recipient.signature !== input.certificate.signature ||
    pack.recordDigest !== (await encryptedRecordDigest(record)) ||
    pack.issuedAt > now ||
    pack.expiresAt <= now ||
    pack.authorizationRevision !== input.authorizationRevision ||
    !input.certificate.audiences.includes(record.scope.audience) ||
    JSON.stringify(caseOf(input.certificate)) !==
      JSON.stringify(caseOf(record.scope)) ||
    !(await verifySignature(
      profile.validationKey,
      pack.signature,
      recoveredKeyBytes(pack),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const plaintext = await decryptAtEndpoint(
    {
      ...record,
      recipients: [
        {
          id: input.certificate.id,
          encapsulatedKey: pack.encapsulatedKey,
          encryptedKey: pack.encryptedKey,
        },
      ],
    },
    input.certificate.id,
    input.keys.encryption,
  );
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    throw new EncryptionProtocolError("encryption-integrity");
  } finally {
    plaintext.fill(0);
  }
}

/** Origin-local device material can be saved using structured-clone storage.
 * There is intentionally no private-key export or Templ recovery API. */
export const createBrowserEndpoint = endpointKeys;
