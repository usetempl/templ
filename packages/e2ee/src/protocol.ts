import { SUPPORT_HANDOFF_REASONS, type SupportHandoffReason } from "@templ/chat/support";
/** Public wire data only. No decryption operation or private key belongs in
 * this module: the Templ relay uses the same strict parsing as customer clients. */
export const E2EE_SUITE = "P256-HKDF-SHA256-AES256GCM" as const;
export const E2EE_POLICY = "customer-only-v1" as const;
export const OWN_SUPPORT_POLICY = "templ-own-support-v1" as const;
/** This is a first-party support endpoint, not an operator/customer exception.
 * Profile and receipt signatures bind this mode. Customer origins stay separate. */
export const OWN_SUPPORT_ENDPOINT = Object.freeze({
  environment: "production" as const,
  workspace: "01a0fe6b-fccc-7633-b0e8-bcb29c000ebb",
  clientOrigin: "https://secure-support.usetempl.com",
  serviceOrigin: "https://secure-support.usetempl.com",
});
/** Exact existing Own hosted agent. It grants no role by itself. */
export const OWN_SUPPORT_AI_PRINCIPAL = "0xf8a112e144a7dbb7f3397df7160ac3bb4be5c9d5" as const;
export const E2EE_LIMITS = {
  innerBytes: 16_384,
  textBytes: 4_000,
  wireBytes: 32_768,
  recipients: 32,
  receiptLifetimeMs: 5 * 60_000,
  certificateLifetimeMs: 24 * 60 * 60_000,
} as const;
export const E2EE_PURPOSES = [
  "member-message",
  "team-message",
  "note",
  "context",
  "draft",
  "evidence",
  "follow-up",
  "tags",
  "attachment",
] as const;
export type E2eePurpose = (typeof E2EE_PURPOSES)[number];
export type E2eeAudience = "conversation" | "team" | "ai-draft";
export type E2eeEnvironment = "production" | "staging" | "local";
export type E2eeEndpointKind =
  | "member"
  | "team"
  | "specialist"
  | "ai"
  | "customer-service";
export type E2eeCase = {
  environment: E2eeEnvironment;
  workspace: string;
  conversation: string;
  caseSeq: number;
};
export type E2eeScope = E2eeCase & {
  audience: E2eeAudience;
  epoch: number;
  authorizationRevision: number;
  policyRevision: number;
  rosterDigest: string;
};
type EncryptionProfileFields = {
  v: 1;
  environment: E2eeEnvironment;
  workspace: string;
  revision: number;
  clientOrigin: string;
  serviceOrigin: string;
  rootKey: string;
  validationKey: string;
  recoveryKey: string;
  /** Opaque ID of the customer recovery recipient, not a Templ principal. */
  recoveryRecipient: string;
  signature: string;
};
export type CustomerEncryptionProfile = EncryptionProfileFields & {
  custody: "customer";
};
export type OwnSupportEncryptionProfile = EncryptionProfileFields & {
  custody: "templ-own-support";
};
export type EncryptionProfile =
  | CustomerEncryptionProfile
  | OwnSupportEncryptionProfile;
export const validationPolicy = (profile: EncryptionProfile) =>
  profile.custody === "customer" ? E2EE_POLICY : OWN_SUPPORT_POLICY;
export function ownNativeDeviceRevocationBytes(
  profile: Pick<OwnSupportEncryptionProfile, "environment" | "workspace" | "rootKey">, device: string, at: number,
) {
  return utf8(JSON.stringify([
    "templ:e2ee:own-native-device-revocation:v1", profile.environment,
    profile.workspace, profile.rootKey, opaqueId(device), integer(at, 0),
  ]));
}
export function ownAuthorityCheckpointBytes(rootKey: string, revision: number, digest: string) {
  decoded(rootKey, 65);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new EncryptionProtocolError();
  return utf8(JSON.stringify([
    "templ:e2ee:own-authority-checkpoint:v1", OWN_SUPPORT_ENDPOINT.environment,
    OWN_SUPPORT_ENDPOINT.workspace, rootKey, integer(revision, 0), digest,
  ]));
}
export type EndpointCertificate = E2eeCase & {
  v: 1;
  id: string;
  actor: string;
  kind: E2eeEndpointKind;
  audiences: E2eeAudience[];
  encryptionKey: string;
  signingKey: string;
  issuedAt: number;
  expiresAt: number;
  /** The customer's independent approval, never a Templ session ID. */
  grant: string;
  /** Current native authority checkpoint, independently approved by the issuer.
   * Absent only on retained v1 certificates made before checkpoint binding. */
  authorizationGrant?: string;
  signature: string;
};
export type EncryptedRecord = {
  v: 1;
  suite: typeof E2EE_SUITE;
  scope: E2eeScope;
  id: string;
  sender: string;
  purpose: E2eePurpose;
  replyIntent: "answer" | "update" | null;
  nonce: string;
  ciphertext: string;
  recipients: { id: string; encapsulatedKey: string; encryptedKey: string }[];
  certificate: EndpointCertificate;
  signature: string;
};
export type OwnAiValidation = {
  v: 1;
  /** Hash of fresh native authority, latest ciphertext and approved sources. */
  stateDigest: string;
  latestSequence: number;
  latestDigest: string;
  disposition: "answer" | "clarify" | "greeting" | "hold" | "handoff" | "draft";
  handoff?: SupportHandoffReason;
  /** An answer is linked to the private verification record already retained. */
  draft?: {sequence: number; recordDigest: string};
};
export type ValidationReceipt = {
  v: 1;
  policy: typeof E2EE_POLICY | typeof OWN_SUPPORT_POLICY;
  workspace: string;
  environment: E2eeEnvironment;
  profileRevision: number;
  recordDigest: string;
  issuedAt: number;
  expiresAt: number;
  innerBytes: number;
  textBytes: number;
  diagnostics: boolean;
  ai?: OwnAiValidation;
  signature: string;
};
export type RecoveredRecordKey = {
  v: 1;
  recordDigest: string;
  recipient: EndpointCertificate;
  issuedAt: number;
  expiresAt: number;
  authorizationRevision: number;
  encapsulatedKey: string;
  encryptedKey: string;
  signature: string;
};

export class EncryptionProtocolError extends Error {
  constructor(
    readonly code:
      | "invalid-encrypted-data"
      | "customer-custody-required"
      | "encryption-integrity"
      | "encryption-scope-changed" = "invalid-encrypted-data",
  ) {
    super(
      code === "customer-custody-required"
        ? "Encrypted support requires customer-controlled keys and services."
        : code === "encryption-scope-changed"
          ? "The case changed. Refresh its encryption information before sending."
          : code === "encryption-integrity"
            ? "The encrypted record could not be verified."
            : "Invalid encrypted support data.",
    );
  }
}
export const invalid = (): never => {
  throw new EncryptionProtocolError();
};
export const utf8 = (text: string) => new TextEncoder().encode(text);
export const bytesOf = (text: string) => utf8(text).byteLength;
export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decoded(
  value: unknown,
  minimum: number,
  maximum = minimum,
): ReturnType<typeof Uint8Array.from> {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return invalid();
  let bytes: ReturnType<typeof Uint8Array.from>;
  try {
    bytes = Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return invalid();
  }
  if (
    bytes.byteLength < minimum ||
    bytes.byteLength > maximum ||
    base64url(bytes) !== value
  )
    return invalid();
  return bytes;
}
export function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    ) ||
    keys.some((key) => !(key in record))
  )
    return invalid();
  return record;
}
export function integer(
  value: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : invalid();
}
export function digestValue(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : invalid();
}
export function opaqueId(value: unknown): string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
    ? value
    : invalid();
}
export function publicKey(value: unknown): string {
  const bytes = decoded(value, 65);
  if (bytes[0] !== 4) return invalid();
  return value as string;
}
const environment = (value: unknown): E2eeEnvironment =>
  value === "production" || value === "staging" || value === "local"
    ? value
    : invalid();
const audience = (value: unknown): E2eeAudience =>
  value === "conversation" || value === "team" || value === "ai-draft"
    ? value
    : invalid();
export function customerOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 253) return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === "usetempl.com" ||
    url.hostname.endsWith(".usetempl.com") ||
    url.hostname === "templ.fun" ||
    url.hostname.endsWith(".templ.fun") ||
    url.hostname === "templ.vip" ||
    url.hostname.endsWith(".templ.vip")
  )
    throw new EncryptionProtocolError("customer-custody-required");
  return url.origin;
}
export function parseCustomerProfile(
  value: unknown,
): CustomerEncryptionProfile {
  const profile = parseEncryptionProfile(value);
  if (profile.custody !== "customer")
    throw new EncryptionProtocolError("customer-custody-required");
  return profile;
}
export function parseEncryptionProfile(value: unknown): EncryptionProfile {
  const row = object(value, [
    "v",
    "custody",
    "environment",
    "workspace",
    "revision",
    "clientOrigin",
    "serviceOrigin",
    "rootKey",
    "validationKey",
    "recoveryKey",
    "recoveryRecipient",
    "signature",
  ]);
  if (
    row.v !== 1 ||
    !["customer", "templ-own-support"].includes(String(row.custody))
  )
    throw new EncryptionProtocolError("customer-custody-required");
  const own = row.custody === "templ-own-support";
  if (
    own &&
    Object.entries(OWN_SUPPORT_ENDPOINT).some(
      ([key, expected]) => row[key] !== expected,
    )
  )
    throw new EncryptionProtocolError("customer-custody-required");
  decoded(row.signature, 64);
  return {
    v: 1,
    custody: own ? "templ-own-support" : "customer",
    environment: environment(row.environment),
    workspace: opaqueId(row.workspace),
    revision: integer(row.revision),
    clientOrigin: own
      ? OWN_SUPPORT_ENDPOINT.clientOrigin
      : customerOrigin(row.clientOrigin),
    serviceOrigin: own
      ? OWN_SUPPORT_ENDPOINT.serviceOrigin
      : customerOrigin(row.serviceOrigin),
    rootKey: publicKey(row.rootKey),
    validationKey: publicKey(row.validationKey),
    recoveryKey: publicKey(row.recoveryKey),
    recoveryRecipient: opaqueId(row.recoveryRecipient),
    signature: row.signature as string,
  };
}
export function parseCase(value: unknown): E2eeCase {
  const row = object(value, [
    "environment",
    "workspace",
    "conversation",
    "caseSeq",
  ]);
  if (
    typeof row.conversation !== "string" ||
    !/^tc-[a-f0-9]{32}$/.test(row.conversation)
  )
    return invalid();
  return {
    environment: environment(row.environment),
    workspace: opaqueId(row.workspace),
    conversation: row.conversation,
    caseSeq: integer(row.caseSeq, 1, 0x7fffffff),
  };
}
export function caseOf(value: E2eeCase): E2eeCase {
  return {
    environment: value.environment,
    workspace: value.workspace,
    conversation: value.conversation,
    caseSeq: value.caseSeq,
  };
}
export function parseScope(value: unknown): E2eeScope {
  const row = object(value, [
    "environment",
    "workspace",
    "conversation",
    "caseSeq",
    "audience",
    "epoch",
    "authorizationRevision",
    "policyRevision",
    "rosterDigest",
  ]);
  return {
    ...parseCase(caseOf(row as E2eeCase)),
    audience: audience(row.audience),
    epoch: integer(row.epoch),
    authorizationRevision: integer(row.authorizationRevision, 0),
    policyRevision: integer(row.policyRevision),
    rosterDigest: digestValue(row.rosterDigest),
  };
}
export function parseCertificate(value: unknown): EndpointCertificate {
  const row = object(
    value,
    [
      "v",
      "environment",
      "workspace",
      "conversation",
      "caseSeq",
      "id",
      "actor",
      "kind",
      "audiences",
      "encryptionKey",
      "signingKey",
      "issuedAt",
      "expiresAt",
      "grant",
      "signature",
    ],
    ["authorizationGrant"],
  );
  if (
    row.v !== 1 ||
    !["member", "team", "specialist", "ai", "customer-service"].includes(
      row.kind as string,
    ) ||
    !Array.isArray(row.audiences) ||
    !row.audiences.length ||
    row.audiences.length > 3 ||
    new Set(row.audiences).size !== row.audiences.length
  )
    return invalid();
  const audiences = row.audiences.map(audience);
  if (
    (row.kind === "member" && audiences.some((a) => a !== "conversation")) ||
    (row.kind === "ai" && audiences.includes("team"))
  )
    return invalid();
  const issuedAt = integer(row.issuedAt, 0),
    expiresAt = integer(
      row.expiresAt,
      issuedAt + 1,
      issuedAt + E2EE_LIMITS.certificateLifetimeMs,
    );
  decoded(row.signature, 64);
  return {
    v: 1,
    ...parseCase(caseOf(row as E2eeCase)),
    id: opaqueId(row.id),
    actor: digestValue(row.actor),
    kind: row.kind as E2eeEndpointKind,
    audiences,
    encryptionKey: publicKey(row.encryptionKey),
    signingKey: publicKey(row.signingKey),
    issuedAt,
    expiresAt,
    grant: opaqueId(row.grant),
    ...(row.authorizationGrant !== undefined
      ? { authorizationGrant: digestValue(row.authorizationGrant) }
      : {}),
    signature: row.signature as string,
  };
}
export function parseEncryptedRecord(value: unknown): EncryptedRecord {
  const serialized = JSON.stringify(value);
  if (
    typeof serialized !== "string" ||
    bytesOf(serialized) > E2EE_LIMITS.wireBytes
  )
    return invalid();
  const row = object(value, [
    "v",
    "suite",
    "scope",
    "id",
    "sender",
    "purpose",
    "replyIntent",
    "nonce",
    "ciphertext",
    "recipients",
    "certificate",
    "signature",
  ]);
  if (
    row.v !== 1 ||
    row.suite !== E2EE_SUITE ||
    !E2EE_PURPOSES.includes(row.purpose as E2eePurpose) ||
    !Array.isArray(row.recipients) ||
    !row.recipients.length ||
    row.recipients.length > E2EE_LIMITS.recipients ||
    ![null, "answer", "update"].includes(row.replyIntent as null)
  )
    return invalid();
  const scope = parseScope(row.scope),
    certificate = parseCertificate(row.certificate);
  if (row.purpose !== "team-message" && row.replyIntent !== null)
    return invalid();
  if (
    (row.purpose === "member-message" ||
      row.purpose === "team-message" ||
      row.purpose === "context") &&
    scope.audience !== "conversation"
  )
    return invalid();
  if (
    ["note", "evidence", "follow-up", "tags"].includes(row.purpose as string) &&
    scope.audience !== "team"
  )
    return invalid();
  if (row.purpose === "draft" && scope.audience !== "ai-draft")
    return invalid();
  decoded(row.nonce, 12);
  decoded(row.ciphertext, 17, E2EE_LIMITS.innerBytes + 16);
  decoded(row.signature, 64);
  const recipients = row.recipients.map((value) => {
    const recipient = object(value, ["id", "encapsulatedKey", "encryptedKey"]);
    decoded(recipient.encapsulatedKey, 65);
    decoded(recipient.encryptedKey, 48);
    return {
      id: opaqueId(recipient.id),
      encapsulatedKey: recipient.encapsulatedKey as string,
      encryptedKey: recipient.encryptedKey as string,
    };
  });
  if (
    new Set(recipients.map((r) => r.id)).size !== recipients.length ||
    recipients.some((r, i) => i > 0 && recipients[i - 1].id >= r.id) ||
    row.sender !== certificate.id ||
    !certificate.audiences.includes(scope.audience) ||
    JSON.stringify(caseOf(certificate)) !== JSON.stringify(caseOf(scope))
  )
    return invalid();
  return {
    v: 1,
    suite: E2EE_SUITE,
    scope,
    id: opaqueId(row.id),
    sender: certificate.id,
    purpose: row.purpose as E2eePurpose,
    replyIntent: row.replyIntent as EncryptedRecord["replyIntent"],
    nonce: row.nonce as string,
    ciphertext: row.ciphertext as string,
    recipients,
    certificate,
    signature: row.signature as string,
  };
}
export function parseOwnAiValidation(value: unknown): OwnAiValidation {
  const raw = object(value, ["v", "stateDigest", "latestSequence", "latestDigest", "disposition"], ["draft", "handoff"]);
  if (raw.v !== 1 || !["answer", "clarify", "greeting", "hold", "handoff", "draft"].includes(String(raw.disposition))) return invalid();
  if (raw.handoff !== undefined && !SUPPORT_HANDOFF_REASONS.includes(raw.handoff as SupportHandoffReason)) return invalid();
  let draft: OwnAiValidation["draft"];
  if (raw.draft !== undefined) {
    const row = object(raw.draft, ["sequence", "recordDigest"]);
    draft = {sequence: integer(row.sequence, 1), recordDigest: digestValue(row.recordDigest)};
  }
  return {v: 1, stateDigest: digestValue(raw.stateDigest), latestSequence: integer(raw.latestSequence, 1),
    latestDigest: digestValue(raw.latestDigest), disposition: raw.disposition as OwnAiValidation["disposition"],
    ...(draft ? {draft} : {}), ...(raw.handoff === undefined ? {} : {handoff: raw.handoff as SupportHandoffReason})};
}
export function parseValidationReceipt(value: unknown): ValidationReceipt {
  const row = object(value, [
    "v",
    "policy",
    "workspace",
    "environment",
    "profileRevision",
    "recordDigest",
    "issuedAt",
    "expiresAt",
    "innerBytes",
    "textBytes",
    "diagnostics",
    "signature",
  ], ["ai"]);
  if (
    row.v !== 1 ||
    (row.policy !== E2EE_POLICY && row.policy !== OWN_SUPPORT_POLICY) ||
    typeof row.diagnostics !== "boolean"
  )
    return invalid();
  const issuedAt = integer(row.issuedAt, 0),
    expiresAt = integer(
      row.expiresAt,
      issuedAt + 1,
      issuedAt + E2EE_LIMITS.receiptLifetimeMs,
    );
  decoded(row.signature, 64);
  return {
    v: 1,
    policy: row.policy as ValidationReceipt["policy"],
    workspace: opaqueId(row.workspace),
    environment: environment(row.environment),
    profileRevision: integer(row.profileRevision),
    recordDigest: digestValue(row.recordDigest),
    issuedAt,
    expiresAt,
    innerBytes: integer(row.innerBytes, 1, E2EE_LIMITS.innerBytes),
    textBytes: integer(row.textBytes, 0, E2EE_LIMITS.textBytes),
    diagnostics: row.diagnostics,
    ...(row.ai === undefined ? {} : {ai: parseOwnAiValidation(row.ai)}),
    signature: row.signature as string,
  };
}
export function parseRecoveredRecordKey(value: unknown): RecoveredRecordKey {
  const row = object(value, [
    "v",
    "recordDigest",
    "recipient",
    "issuedAt",
    "expiresAt",
    "authorizationRevision",
    "encapsulatedKey",
    "encryptedKey",
    "signature",
  ]);
  if (row.v !== 1) return invalid();
  const issuedAt = integer(row.issuedAt, 0);
  decoded(row.encapsulatedKey, 65);
  decoded(row.encryptedKey, 48);
  decoded(row.signature, 64);
  return {
    v: 1,
    recordDigest: digestValue(row.recordDigest),
    recipient: parseCertificate(row.recipient),
    issuedAt,
    expiresAt: integer(
      row.expiresAt,
      issuedAt + 1,
      issuedAt + E2EE_LIMITS.receiptLifetimeMs,
    ),
    authorizationRevision: integer(row.authorizationRevision, 0),
    encapsulatedKey: row.encapsulatedKey as string,
    encryptedKey: row.encryptedKey as string,
    signature: row.signature as string,
  };
}
const caseTuple = (c: E2eeCase) => [
  c.environment,
  c.workspace,
  c.conversation,
  c.caseSeq,
];
export const profileBytes = (p: EncryptionProfile) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:customer-profile:v1",
      p.v,
      p.custody,
      p.environment,
      p.workspace,
      p.revision,
      p.clientOrigin,
      p.serviceOrigin,
      p.rootKey,
      p.validationKey,
      p.recoveryKey,
      p.recoveryRecipient,
    ]),
  );
export const certificateBytes = (c: EndpointCertificate) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:customer-certificate:v1",
      c.v,
      ...caseTuple(c),
      c.id,
      c.actor,
      c.kind,
      c.audiences,
      c.encryptionKey,
      c.signingKey,
      c.issuedAt,
      c.expiresAt,
      c.grant,
      ...(c.authorizationGrant !== undefined ? [c.authorizationGrant] : []),
    ]),
  );
export const headerBytes = (
  r: Omit<EncryptedRecord, "nonce" | "ciphertext" | "recipients" | "signature">,
) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:record:v1",
      r.v,
      r.suite,
      ...caseTuple(r.scope),
      r.scope.audience,
      r.scope.epoch,
      r.scope.authorizationRevision,
      r.scope.policyRevision,
      r.scope.rosterDigest,
      r.id,
      r.sender,
      r.purpose,
      r.replyIntent,
    ]),
  );
// The author authenticates the content and its full scope. The customer
// service constructs every recipient's package from that same record key,
// then certifies the final package list in its validation receipt.
export const authorBytes = (r: EncryptedRecord) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:author:v1",
      base64url(headerBytes(r)),
      r.nonce,
      r.ciphertext,
      base64url(certificateBytes(r.certificate)),
      r.certificate.signature,
    ]),
  );
export const recordBytes = (r: EncryptedRecord) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:record-packages:v1",
      base64url(authorBytes(r)),
      r.recipients.map((recipient) => [
        recipient.id,
        recipient.encapsulatedKey,
        recipient.encryptedKey,
      ]),
    ]),
  );
export const receiptBytes = (r: ValidationReceipt) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:validation:v1",
      r.v,
      r.policy,
      r.workspace,
      r.environment,
      r.profileRevision,
      r.recordDigest,
      r.issuedAt,
      r.expiresAt,
      r.innerBytes,
      r.textBytes,
      r.diagnostics,
      ...(r.ai === undefined ? [] : [["own-ai-v1", parseOwnAiValidation(r.ai)]]),
    ]),
  );
export const recoveredKeyBytes = (r: RecoveredRecordKey) =>
  utf8(
    JSON.stringify([
      "templ:e2ee:recovered-key:v1",
      r.v,
      r.recordDigest,
      base64url(certificateBytes(r.recipient)),
      r.recipient.signature,
      r.issuedAt,
      r.expiresAt,
      r.authorizationRevision,
      r.encapsulatedKey,
      r.encryptedKey,
    ]),
  );
export function sameScope(a: E2eeScope, b: E2eeScope): boolean {
  return (
    JSON.stringify([
      ...caseTuple(a),
      a.audience,
      a.epoch,
      a.authorizationRevision,
      a.policyRevision,
      a.rosterDigest,
    ]) ===
    JSON.stringify([
      ...caseTuple(b),
      b.audience,
      b.epoch,
      b.authorizationRevision,
      b.policyRevision,
      b.rosterDigest,
    ])
  );
}
