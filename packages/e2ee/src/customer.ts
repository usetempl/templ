/** Run this code only in independently customer-controlled infrastructure.
 * The relay imports ./verify instead and receives no private key or plaintext. */
import { detectSupportSecret } from "@templ/chat/support-secret-check";
import { screenTeamText } from "@templ/chat/support-safety";
import { parseSupportContextInput } from "@templ/chat/support-context";
import {
  SUPPORT_APP_FIELDS,
  SUPPORT_DIAGNOSTIC_FIELDS,
} from "@templ/chat/support-app-context";
import {
  validationPolicy,
  E2EE_LIMITS,
  EncryptionProtocolError,
  bytesOf,
  certificateBytes,
  object,
  profileBytes,
  receiptBytes,
  parseCertificate,
  parseCustomerProfile,
  parseScope,
  parseOwnAiValidation,
  sameScope,
  caseOf,
  recoveredKeyBytes,
  type CustomerEncryptionProfile,
  type EncryptionProfile,
  type OwnSupportEncryptionProfile,
  type EndpointCertificate,
  type EncryptedRecord,
  type E2eeScope,
  type ValidationReceipt,
  type OwnAiValidation,
  type RecoveredRecordKey,
} from "./protocol";
import {
  decryptWithRecordKey,
  unwrapRecordKey,
  wrapRecordKey,
  exportPublic,
  sign,
  type EndpointKeys,
} from "./endpoint-crypto";
import {
  encryptedRecordDigest,
  recipientRosterDigest,
  verifyAcceptedRecord,
  verifyCertificate,
  verifyCustomerProfile,
  verifyEncryptionProfile,
  verifyRecordAuthor,
  verifySignature,
} from "./verify";
export {
  endpointKeys as createCustomerKeys,
  exportPublic,
} from "./endpoint-crypto";

export class CustomerContentRefusal extends Error {
  constructor(
    readonly reason:
      | "secret-refused"
      | "unsafe-ask"
      | "invalid-content"
      | "customer-approval-required",
  ) {
    super(
      reason === "secret-refused"
        ? "This looks like a recovery phrase or private key. Remove it before sending."
        : reason === "unsafe-ask"
          ? "Remove the request for credentials, signing or a transaction."
          : reason === "customer-approval-required"
            ? "Approval from the customer's own identity or device system is required."
            : "Check the support content before sending.",
    );
  }
}

/** Key ownership is established in the customer's own setup. A Templ session,
 * role change or resume link is deliberately not an accepted proof type. */
export type CustomerApproval = {
  source: "customer-identity" | "existing-device";
  grant: string;
  certificate: Omit<EndpointCertificate, "signature">;
};
export async function issueCustomerCertificate(input: {
  profile: EncryptionProfile;
  rootSigningKey: CryptoKey;
  /** This callback must independently authenticate the customer-held proof.
   * It runs outside Templ and may not accept a Templ token as its sole proof. */
  approve: () => Promise<CustomerApproval | null>;
}): Promise<EndpointCertificate> {
  await verifyEncryptionProfile(input.profile, input.profile.rootKey);
  const approval = await input.approve();
  if (
    !approval ||
    !["customer-identity", "existing-device"].includes(approval.source) ||
    approval.certificate.grant !== approval.grant ||
    approval.certificate.workspace !== input.profile.workspace ||
    approval.certificate.environment !== input.profile.environment
  )
    throw new CustomerContentRefusal("customer-approval-required");
  const certificate = { ...approval.certificate, signature: "" };
  certificate.signature = await sign(
    input.rootSigningKey,
    certificateBytes(certificate),
  );
  const parsed = parseCertificate(certificate);
  if (
    !(await verifySignature(
      input.profile.rootKey,
      parsed.signature,
      certificateBytes(parsed),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  return parsed;
}
export async function signCustomerProfile(input: {
  profile: Omit<CustomerEncryptionProfile, "signature">;
  rootSigningKey: CryptoKey;
}): Promise<CustomerEncryptionProfile> {
  const profile = { ...input.profile, signature: "" };
  profile.signature = await sign(input.rootSigningKey, profileBytes(profile));
  return verifyCustomerProfile(parseCustomerProfile(profile), profile.rootKey);
}
/** Only the separately scoped first-party endpoint uses this signer. */
export async function signOwnSupportProfile(input: {
  profile: Omit<OwnSupportEncryptionProfile, "signature">;
  rootSigningKey: CryptoKey;
}): Promise<OwnSupportEncryptionProfile> {
  const profile = { ...input.profile, signature: "" };
  profile.signature = await sign(input.rootSigningKey, profileBytes(profile));
  const verified = await verifyEncryptionProfile(profile, profile.rootKey);
  if (verified.custody !== "templ-own-support")
    throw new EncryptionProtocolError("customer-custody-required");
  return verified;
}

const badContent = (): never => {
  throw new CustomerContentRefusal("invalid-content");
};
function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return badContent();
  return value as Record<string, unknown>;
}
function strictApp(value: unknown) {
  const app = exact(value, SUPPORT_APP_FIELDS);
  for (const [field, keys] of Object.entries({
    product: ["key", "label", "address", "network"],
    shown: ["value", "metric", "period", "asOf"],
    error: ["code", "message"],
    failure: ["kind", "at", "asset", "amount"],
    sdk: ["widget", "api"],
    viewport: ["width", "height"],
    screen: ["width", "height"],
    connection: ["online", "effectiveType", "saveData"],
  })) {
    if (app[field] !== undefined) exact(app[field], keys);
  }
  const shown = app.shown as Record<string, unknown> | undefined,
    failure = app.failure as Record<string, unknown> | undefined;
  if (shown?.metric !== undefined) exact(shown.metric, ["key", "label"]);
  if (failure?.asset !== undefined)
    exact(failure.asset, ["symbol", "address", "network"]);
}
function strictContext(value: unknown) {
  const context = exact(value, [
    "network",
    "chainId",
    "transactionHash",
    "transactions",
    "description",
    "app",
    "snapshots",
  ]);
  if (context.app !== undefined) strictApp(context.app);
  if (context.transactions !== undefined) {
    if (!Array.isArray(context.transactions)) return badContent();
    for (const transaction of context.transactions)
      exact(transaction, ["hash", "network", "chainId"]);
  }
  if (context.snapshots !== undefined) {
    if (!Array.isArray(context.snapshots)) return badContent();
    for (const raw of context.snapshots) {
      const snapshot = exact(raw, [
        "id",
        "capturedAt",
        "wallet",
        "network",
        "app",
        "failure",
        "sdk",
        "transactions",
      ]);
      exact(snapshot.wallet, ["level", "address"]);
      if (snapshot.app !== undefined) strictApp(snapshot.app);
      if (snapshot.failure !== undefined) {
        const failure = exact(snapshot.failure, [
          "kind",
          "at",
          "asset",
          "amount",
        ]);
        if (failure.asset !== undefined)
          exact(failure.asset, ["symbol", "address", "network"]);
      }
      if (snapshot.sdk !== undefined) exact(snapshot.sdk, ["widget", "api"]);
      if (snapshot.transactions !== undefined) {
        if (!Array.isArray(snapshot.transactions)) return badContent();
        for (const transaction of snapshot.transactions)
          exact(transaction, ["hash", "network", "chainId"]);
      }
    }
  }
  try {
    parseSupportContextInput(context);
  } catch {
    return badContent();
  }
}
/** Scan every string, including fields a future parser might otherwise drop.
 * Byte/depth limits are checked before recursion or cryptographic derivation. */
async function screenValues(
  value: unknown,
  team: boolean,
  depth = 0,
): Promise<void> {
  if (depth > 8) return badContent();
  if (typeof value === "string") {
    if (await detectSupportSecret(value))
      throw new CustomerContentRefusal("secret-refused");
    if (team && screenTeamText(value))
      throw new CustomerContentRefusal("unsafe-ask");
  } else if (Array.isArray(value)) {
    if (value.length > 128) return badContent();
    for (const item of value) await screenValues(item, team, depth + 1);
  } else if (value && typeof value === "object") {
    if (Object.keys(value).length > 128) return badContent();
    for (const [key, item] of Object.entries(value)) {
      await screenValues(key, team, depth + 1);
      await screenValues(item, team, depth + 1);
    }
  }
}
async function validateContent(
  record: EncryptedRecord,
  value: unknown,
): Promise<number> {
  const message =
    record.purpose === "member-message" || record.purpose === "team-message";
  let textBytes = 0;
  if (message || ["note", "draft"].includes(record.purpose)) {
    const content = object(
      value,
      ["text"],
      message ? ["context", "contextConsent", "replyTo"] :
        record.purpose === "draft" && record.certificate.kind === "ai" ? ["replyTo", "verification"] : ["replyTo"],
    );
    if (
      typeof content.text !== "string" ||
      !content.text.trim() ||
      bytesOf(content.text) > E2EE_LIMITS.textBytes
    )
      return badContent();
    textBytes = bytesOf(content.text);
    if (
      content.replyTo !== undefined &&
      (typeof content.replyTo !== "string" ||
        !/^[1-9][0-9]{0,14}$/.test(content.replyTo))
    )
      return badContent();
    if (content.contextConsent !== undefined && content.contextConsent !== true)
      return badContent();
    if (content.context !== undefined) {
      if (
        record.purpose !== "member-message" ||
        content.contextConsent !== true
      )
        return badContent();
      strictContext(content.context);
    }
  } else if (record.purpose === "context") {
    const content = object(value, ["context", "contextConsent"]);
    if (content.contextConsent !== true) return badContent();
    strictContext(content.context);
  } else {
    // Required integrations get a dedicated reviewed inner schema. Refusing
    // an unimplemented path is safer than storing hidden plaintext fields.
    return badContent();
  }
  await screenValues(value, record.certificate.kind !== "member");
  return textBytes;
}

/** Validate one immutable, independently authorized encrypted record. No
 * model call is needed, and plaintext is never returned to the caller. */
export async function validateCustomerRecord(input: {
  profile: EncryptionProfile;
  pinnedRoot: string;
  record: unknown;
  scope: E2eeScope;
  recoveryKeys: CryptoKeyPair;
  validationPrivateKey: CryptoKey;
  recipients: readonly EndpointCertificate[];
  /** Must check current customer approval and current native case access.
   * A stale Templ permission snapshot alone is insufficient. */
  authorize: (
    certificate: EndpointCertificate,
    scope: E2eeScope,
  ) => Promise<boolean>;
  /** Only the separately approved Own verifier can bind AI policy decisions.
   * Every other caller remains unable to validate an AI record. */
  validateOwnAi?: (record: EncryptedRecord, content: unknown) => Promise<OwnAiValidation>;
  now?: number;
}): Promise<{ record: EncryptedRecord; receipt: ValidationReceipt }> {
  const now = input.now ?? Date.now(),
    profile = await verifyEncryptionProfile(input.profile, input.pinnedRoot);
  const record = await verifyRecordAuthor(profile, input.record, now),
    scope = parseScope(input.scope);
  if (
    !sameScope(record.scope, scope) ||
    !(await input.authorize(record.certificate, scope))
  )
    throw new CustomerContentRefusal("customer-approval-required");
  if (
    !input.recipients.length ||
    input.recipients.length >= E2EE_LIMITS.recipients ||
    new Set(input.recipients.map((c) => c.id)).size !==
      input.recipients.length ||
    !input.recipients.some(
      (c) =>
        c.id === record.sender && c.signature === record.certificate.signature,
    ) ||
    (await recipientRosterDigest(profile, input.recipients)) !==
      scope.rosterDigest
  )
    throw new EncryptionProtocolError("encryption-scope-changed");
  for (const raw of input.recipients) {
    const certificate = parseCertificate(raw);
    await verifyCertificate(profile, certificate, now);
    if (
      certificate.conversation !== scope.conversation ||
      certificate.caseSeq !== scope.caseSeq ||
      !certificate.audiences.includes(scope.audience) ||
      !(await input.authorize(certificate, scope))
    )
      throw new CustomerContentRefusal("customer-approval-required");
  }
  const recordKey = await unwrapRecordKey(
    record,
    profile.recoveryRecipient,
    input.recoveryKeys,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptWithRecordKey(record, recordKey);
    if (plaintext.byteLength > E2EE_LIMITS.innerBytes) return badContent();
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      );
    } catch {
      return badContent();
    }
    const textBytes = await validateContent(record, value);
    let ai: OwnAiValidation | undefined;
    if (record.certificate.kind === "ai" && profile.custody === "templ-own-support") {
      if (!input.validateOwnAi) return badContent();
      ai = parseOwnAiValidation(await input.validateOwnAi(record, value));
    }
    const context = (
      value as { context?: { app?: object; snapshots?: { app?: object }[] } }
    ).context;
    const diagnostics = [
      context?.app,
      ...(context?.snapshots ?? []).map((snapshot) => snapshot.app),
    ].some(
      (app) =>
        app &&
        SUPPORT_DIAGNOSTIC_FIELDS.some((field) => Object.hasOwn(app, field)),
    );
    record.recipients = await wrapRecordKey(record, recordKey, [
      { id: profile.recoveryRecipient, publicKey: profile.recoveryKey },
      ...input.recipients.map((certificate) => ({
        id: certificate.id,
        publicKey: certificate.encryptionKey,
      })),
    ]);
    const receipt: ValidationReceipt = {
      v: 1,
      policy: validationPolicy(profile),
      workspace: profile.workspace,
      environment: profile.environment,
      profileRevision: profile.revision,
      recordDigest: await encryptedRecordDigest(record),
      issuedAt: now,
      expiresAt: now + E2EE_LIMITS.receiptLifetimeMs,
      innerBytes: plaintext.byteLength,
      textBytes,
      diagnostics,
      ...(ai ? {ai} : {}),
      signature: "",
    };
    receipt.signature = await sign(
      input.validationPrivateKey,
      receiptBytes(receipt),
    );
    if (
      !(await verifySignature(
        profile.validationKey,
        receipt.signature,
        receiptBytes(receipt),
      ))
    )
      throw new EncryptionProtocolError("encryption-integrity");
    return { record, receipt };
  } finally {
    recordKey.fill(0);
    plaintext?.fill(0);
  }
}

/** Endpoint-only retained read. Native code must independently fetch the
 * currently readable retained row before calling; possession of a recovery
 * key never resurrects a caller-supplied deleted row. */
export async function readCustomerRecord<T>(input: {
  profile: EncryptionProfile; record: EncryptedRecord; receipt: ValidationReceipt;
  recoveryKeys: CryptoKeyPair; authorize: () => Promise<boolean>;
  consume: (content: unknown) => Promise<T>;
}): Promise<T> {
  const record = await verifyAcceptedRecord(input.profile, input.record, input.receipt);
  if (!await input.authorize()) throw new CustomerContentRefusal("customer-approval-required");
  const key = await unwrapRecordKey(record, input.profile.recoveryRecipient, input.recoveryKeys);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await decryptWithRecordKey(record, key);
    if (bytes.byteLength > E2EE_LIMITS.innerBytes) return badContent();
    const content: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    return await input.consume(content);
  } finally {key.fill(0); bytes?.fill(0);}
}

/** Public setup values only. Private keys never enter the profile. */
export async function customerPublicKeys(
  root: EndpointKeys,
  validation: EndpointKeys,
  recovery: EndpointKeys,
) {
  return {
    rootKey: await exportPublic(root.signing.publicKey),
    validationKey: await exportPublic(validation.signing.publicKey),
    recoveryKey: await exportPublic(recovery.encryption.publicKey),
  };
}

/** Recovery is a customer endpoint operation. A Templ account reset, email
 * resume link or freshly granted staff role is never a recovery proof. */
export async function recoverCustomerRecord(input: {
  profile: EncryptionProfile;
  pinnedRoot: string;
  record: unknown;
  receipt: unknown;
  certificate: EndpointCertificate;
  recoveryKeys: CryptoKeyPair;
  validationPrivateKey: CryptoKey;
  authorizationRevision: number;
  approve: () => Promise<{
    source: CustomerApproval["source"];
    grant: string;
  } | null>;
  canRead: (
    certificate: EndpointCertificate,
    record: EncryptedRecord,
  ) => Promise<boolean>;
  now?: number;
}): Promise<RecoveredRecordKey> {
  const now = input.now ?? Date.now(),
    profile = await verifyEncryptionProfile(input.profile, input.pinnedRoot);
  const record = await verifyAcceptedRecord(
      profile,
      input.record,
      input.receipt,
    ),
    certificate = parseCertificate(input.certificate);
  await verifyCertificate(profile, certificate, now);
  const approval = await input.approve();
  if (
    !approval ||
    !["customer-identity", "existing-device"].includes(approval.source) ||
    approval.grant !== certificate.grant ||
    JSON.stringify(caseOf(certificate)) !==
      JSON.stringify(caseOf(record.scope)) ||
    !certificate.audiences.includes(record.scope.audience) ||
    !(await input.canRead(certificate, record))
  )
    throw new CustomerContentRefusal("customer-approval-required");
  const key = await unwrapRecordKey(
    record,
    profile.recoveryRecipient,
    input.recoveryKeys,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptWithRecordKey(record, key);
    const [wrapped] = await wrapRecordKey(record, key, [
      { id: certificate.id, publicKey: certificate.encryptionKey },
    ]);
    const pack: RecoveredRecordKey = {
      v: 1,
      recordDigest: await encryptedRecordDigest(record),
      recipient: certificate,
      issuedAt: now,
      expiresAt: now + E2EE_LIMITS.receiptLifetimeMs,
      authorizationRevision: input.authorizationRevision,
      encapsulatedKey: wrapped.encapsulatedKey,
      encryptedKey: wrapped.encryptedKey,
      signature: "",
    };
    pack.signature = await sign(
      input.validationPrivateKey,
      recoveredKeyBytes(pack),
    );
    if (
      !(await verifySignature(
        profile.validationKey,
        pack.signature,
        recoveredKeyBytes(pack),
      ))
    )
      throw new EncryptionProtocolError("encryption-integrity");
    return pack;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
