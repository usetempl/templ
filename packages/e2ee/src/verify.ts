/** The only crypto entry point permitted in Templ's relay: public-key
 * verification. This module cannot decrypt, unwrap, sign or export a key. */
import {
  EncryptionProtocolError,
  E2EE_LIMITS,
  base64url,
  bytesOf,
  decoded,
  profileBytes,
  certificateBytes,
  authorBytes,
  recordBytes,
  receiptBytes,
  parseCustomerProfile,
  parseEncryptionProfile,
  validationPolicy,
  parseEncryptedRecord,
  parseValidationReceipt,
  sameScope,
  type CustomerEncryptionProfile,
  type EncryptionProfile,
  type EncryptedRecord,
  type E2eeScope,
  type EndpointCertificate,
  type ValidationReceipt,
} from "./protocol";

export async function sha256(value: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function publicSigningKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decoded(raw, 65),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}
export async function verifySignature(
  raw: string,
  signature: string,
  data: Uint8Array,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await publicSigningKey(raw),
      decoded(signature, 64),
      Uint8Array.from(data),
    );
  } catch {
    return false;
  }
}
export async function verifyCustomerProfile(
  value: unknown,
  pinnedRoot: string,
): Promise<CustomerEncryptionProfile> {
  const profile = parseCustomerProfile(value);
  await verifyEncryptionProfile(profile, pinnedRoot);
  return profile;
}
export async function verifyEncryptionProfile(
  value: unknown,
  pinnedRoot: string,
): Promise<EncryptionProfile> {
  const profile = parseEncryptionProfile(value);
  if (
    profile.rootKey !== pinnedRoot ||
    new Set([profile.rootKey, profile.validationKey, profile.recoveryKey])
      .size !== 3 ||
    !(await verifySignature(
      pinnedRoot,
      profile.signature,
      profileBytes(profile),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  // Validate the remaining curve points before they become active public keys.
  try {
    await publicSigningKey(profile.validationKey);
    await crypto.subtle.importKey(
      "raw",
      decoded(profile.recoveryKey, 65),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new EncryptionProtocolError("encryption-integrity");
  }
  return profile;
}
export async function encryptedRecordDigest(
  record: EncryptedRecord,
): Promise<string> {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify([base64url(recordBytes(record)), record.signature]),
    ),
  );
}
export async function recipientRosterDigest(
  profile: EncryptionProfile,
  certificates: readonly EndpointCertificate[],
): Promise<string> {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify([
        profile.custody === "customer"
          ? "templ:e2ee:roster:v1"
          : "templ:e2ee:own-support-roster:v1",
        ...(profile.custody === "customer" ? [] : [profile.signature]),
        profile.workspace,
        profile.environment,
        profile.revision,
        profile.recoveryRecipient,
        profile.recoveryKey,
        [...certificates]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((c) => [base64url(certificateBytes(c)), c.signature]),
      ]),
    ),
  );
}
export async function verifyCertificate(
  profile: EncryptionProfile,
  certificate: EndpointCertificate,
  at: number,
): Promise<void> {
  if (
    certificate.workspace !== profile.workspace ||
    certificate.environment !== profile.environment ||
    certificate.issuedAt > at ||
    certificate.expiresAt <= at ||
    !(await verifySignature(
      profile.rootKey,
      certificate.signature,
      certificateBytes(certificate),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
}
function allowedPurpose(record: EncryptedRecord): boolean {
  const kind = record.certificate.kind,
    purpose = record.purpose;
  if (kind === "member")
    return (
      purpose === "member-message" ||
      purpose === "context" ||
      (purpose === "attachment" && record.scope.audience === "conversation")
    );
  if (kind === "team")
    return purpose !== "member-message" && purpose !== "context";
  if (kind === "ai") return purpose === "team-message" || purpose === "draft";
  if (kind === "specialist")
    return (
      purpose === "note" ||
      purpose === "evidence" ||
      purpose === "follow-up" ||
      (purpose === "attachment" && record.scope.audience === "team")
    );
  // Custody/validation services do not impersonate a member or team author.
  return false;
}
export async function verifyRecordAuthor(
  profile: EncryptionProfile,
  value: unknown,
  at: number,
): Promise<EncryptedRecord> {
  const record = parseEncryptedRecord(value);
  await verifyCertificate(profile, record.certificate, at);
  if (
    !allowedPurpose(record) ||
    !record.recipients.some(
      (recipient) => recipient.id === profile.recoveryRecipient,
    ) ||
    !record.recipients.some((recipient) => recipient.id === record.sender) ||
    record.sender === profile.recoveryRecipient ||
    !(await verifySignature(
      record.certificate.signingKey,
      record.signature,
      authorBytes(record),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  return record;
}
export async function verifySubmission(input: {
  profile: EncryptionProfile;
  pinnedRoot: string;
  record: unknown;
  receipt: unknown;
  scope: E2eeScope;
  actor: string;
  now: number;
}): Promise<{
  record: EncryptedRecord;
  receipt: ValidationReceipt;
  digest: string;
}> {
  const profile = await verifyEncryptionProfile(
    input.profile,
    input.pinnedRoot,
  );
  const record = await verifyRecordAuthor(profile, input.record, input.now);
  const receipt = parseValidationReceipt(input.receipt);
  if (
    !sameScope(record.scope, input.scope) ||
    record.certificate.actor !== input.actor
  )
    throw new EncryptionProtocolError("encryption-scope-changed");
  const digest = await encryptedRecordDigest(record);
  const actualInnerBytes =
    decoded(record.ciphertext, 17, E2EE_LIMITS.innerBytes + 16).byteLength - 16;
  if (
    receipt.policy !== validationPolicy(profile) ||
    (receipt.ai !== undefined && (profile.custody !== "templ-own-support" || record.certificate.kind !== "ai")) ||
    (profile.custody === "templ-own-support" && record.certificate.kind === "ai" && receipt.ai === undefined) ||
    receipt.workspace !== profile.workspace ||
    receipt.environment !== profile.environment ||
    receipt.profileRevision !== profile.revision ||
    receipt.recordDigest !== digest ||
    receipt.issuedAt > input.now ||
    receipt.expiresAt <= input.now ||
    receipt.innerBytes !== actualInnerBytes ||
    (record.purpose.endsWith("message") && receipt.textBytes < 1) ||
    bytesOf(JSON.stringify(record)) > E2EE_LIMITS.wireBytes ||
    !(await verifySignature(
      profile.validationKey,
      receipt.signature,
      receiptBytes(receipt),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  return { record, receipt, digest };
}
/** Check an original accepted record without treating a receipt's delivery
 * expiry as history expiry. No private key is used by this operation. */
export async function verifyAcceptedRecord(
  profile: EncryptionProfile,
  recordValue: unknown,
  receiptValue: unknown,
): Promise<EncryptedRecord> {
  profile = await verifyEncryptionProfile(profile, profile.rootKey);
  const receipt = parseValidationReceipt(receiptValue);
  const record = await verifyRecordAuthor(
    profile,
    recordValue,
    receipt.issuedAt,
  );
  if (
    receipt.policy !== validationPolicy(profile) ||
    (receipt.ai !== undefined && (profile.custody !== "templ-own-support" || record.certificate.kind !== "ai")) ||
    (profile.custody === "templ-own-support" && record.certificate.kind === "ai" && receipt.ai === undefined) ||
    receipt.workspace !== profile.workspace ||
    receipt.environment !== profile.environment ||
    receipt.profileRevision !== profile.revision ||
    receipt.recordDigest !== (await encryptedRecordDigest(record)) ||
    receipt.innerBytes !==
      decoded(record.ciphertext, 17, E2EE_LIMITS.innerBytes + 16).length - 16 ||
    !(await verifySignature(
      profile.validationKey,
      receipt.signature,
      receiptBytes(receipt),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  return record;
}
