/** Plaintext is opened only by the isolated support endpoint's deterministic
 * checker. HTTP replies contain certificates, key wraps or screened receipts. */
import {
  OwnSupportAuthority,
  type OwnAuthorityStorage,
  type OwnDeviceKeys,
} from "@templ/e2ee/own-authority";
import {
  recoverCustomerRecord,
  validateCustomerRecord,
} from "@templ/e2ee/customer";
import type { CustomerKeyVault } from "@templ/e2ee/backup";
import {
  EncryptionProtocolError,
  object,
  integer,
  caseOf,
  parseCase,
  parseScope,
  parseCertificate,
  parseEncryptedRecord,
  sameScope,
  type E2eeCase,
  type E2eeScope,
  type EndpointCertificate,
  type OwnSupportEncryptionProfile,
  type OwnAiValidation,
} from "@templ/e2ee/protocol";
import {
  encryptedRecordDigest,
  verifyEncryptionProfile,
} from "@templ/e2ee/verify";
import type { StoredEncryptedRecord } from "@templ/e2ee/relay";
import { OwnAuthorityJournal, type AuthoritySnapshot } from "./authority-journal";
import { caseBase, nativeEnrollment, type NativeRequest } from "./native-api";
import { validateOwnAiRecord } from "./ai-check";
import { parseOwnAiValidation } from "@templ/e2ee/protocol";
import type {OwnKeyPhase} from "./diagnostics";

type Directory = {
  profile: OwnSupportEncryptionProfile;
  scope: E2eeScope;
  recipients: EndpointCertificate[];
};
export type OwnOperation =
  | "challenge"
  | "enroll"
  | "revoke-device"
  | "validate"
  | "recover";
function refuse(): never {
  throw new EncryptionProtocolError("encryption-scope-changed");
}
function keys(value: unknown) {
  const result = object(value, ["encryptionKey", "signingKey"]);
  if (
    typeof result.encryptionKey !== "string" ||
    typeof result.signingKey !== "string"
  )
    refuse();
  return result as { encryptionKey: string; signingKey: string };
}
function enrollment(value: unknown) {
  const input = object(
    value,
    ["challenge", "possession"],
    ["walletApproval", "deviceApproval"],
  );
  if (
    typeof input.challenge !== "string" ||
    typeof input.possession !== "string"
  )
    refuse();
  if (input.walletApproval) {
    const wallet = object(input.walletApproval, ["address", "signature"]);
    if (
      typeof wallet.address !== "string" ||
      !/^0x[a-fA-F0-9]{40}$/.test(wallet.address) ||
      typeof wallet.signature !== "string" ||
      !/^0x[a-fA-F0-9]{130}$/.test(wallet.signature)
    )
      refuse();
  }
  if (input.deviceApproval) {
    const device = object(input.deviceApproval, ["device", "signature"]);
    keys(device.device);
    if (typeof device.signature !== "string") refuse();
  }
  return input as Parameters<OwnSupportAuthority["enroll"]>[1];
}
async function directory(
  native: NativeRequest,
  ref: E2eeCase,
  profile: OwnSupportEncryptionProfile,
  audience: E2eeScope["audience"],
): Promise<Directory> {
  const value = object(
    await native(`${caseBase(ref)}/directory?audience=${audience}`),
    ["profile", "scope", "recipients"],
  );
  const checked = await verifyEncryptionProfile(value.profile, profile.rootKey);
  const scope = parseScope(value.scope);
  if (
    checked.signature !== profile.signature ||
    caseBase(ref) !==
      caseBase(
        parseCase({
          environment: scope.environment,
          workspace: scope.workspace,
          conversation: scope.conversation,
          caseSeq: scope.caseSeq,
        }),
      ) ||
    scope.audience !== audience ||
    !Array.isArray(value.recipients)
  )
    refuse();
  return { profile, scope, recipients: value.recipients.map(parseCertificate) };
}
export async function ownOperation(input: {
  operation: OwnOperation;
  body: unknown;
  profile: OwnSupportEncryptionProfile;
  keys: CustomerKeyVault;
  journal: OwnAuthorityJournal;
  restoredSnapshot?: AuthoritySnapshot;
  native: NativeRequest;
  approvedAi?: OwnDeviceKeys;
  aiVerifierKey?: string;
  phase?: (value: OwnKeyPhase) => void;
}) {
  const body = object(input.body, ["case", "value"]),
    ref = parseCase(body.case);
  caseBase(ref);
  input.phase?.("journal-start");
  const snapshot = await input.journal.flushRevocations(input.restoredSnapshot);
  let validation: {record: ReturnType<typeof parseEncryptedRecord>; wrapped: Record<string, unknown> | null} | undefined;
  if (input.operation === "validate") {
    const raw = body.value;
    const wrapped = raw !== null && typeof raw === "object" && Object.hasOwn(raw, "record")
      ? object(raw, ["record"], ["draft"])
      : null;
    const record = parseEncryptedRecord(wrapped ? wrapped.record : raw);
    if (caseBase(ref) !== caseBase(caseOf(record.scope))) refuse();
    validation = {record, wrapped};
  }
  input.phase?.("native-authorization");
  // Both reads enforce native access. Join the current author and roster
  // before screening, then recheck both and the journal before returning.
  const [native, initialDirectory] = await Promise.all([
    nativeEnrollment(input.native, ref, input.profile),
    validation ? directory(input.native, ref, input.profile, validation.record.scope.audience) : undefined,
  ]);
  const authorityFor = (storage: OwnAuthorityStorage) =>
    new OwnSupportAuthority(storage, input.profile, input.keys.root.privateKey, input.approvedAi);
  const control = input.operation === "revoke-device" ||
    (input.operation === "challenge" || input.operation === "enroll"
      ? (storage: Pick<OwnAuthorityStorage, "get">) => {
        // The classifier cannot write. These authority methods only inspect the
        // proof's device and existing challenge, so pass no writer.
        const values = authorityFor({...storage, put: async () => refuse(), delete: async () => refuse()});
        return input.operation === "challenge" ? values.knownDevice(native, keys(body.value))
          : values.knownEnrollment(native, enrollment(body.value).challenge);
      } : false);
  input.phase?.("journal-read");
  const result = await input.journal.transact(async (storage) => {
    const authority = authorityFor(storage);
    input.phase?.("device-approval");
    if (input.operation === "challenge")
      return authority.challenge(native, body.value);
    if (input.operation === "enroll") {
      const certificate = await authority.enroll(
        native,
        enrollment(body.value),
      );
      const current = await nativeEnrollment(input.native, ref, input.profile);
      if (!(await authority.approved(certificate, current))) refuse();
      return certificate;
    }
    if (input.operation === "revoke-device") {
      const value = object(body.value, ["challenge", "target", "signature"]);
      if (
        typeof value.challenge !== "string" ||
        typeof value.signature !== "string"
      )
        refuse();
      return authority.requestRevocation(native, {
        challenge: value.challenge,
        target: keys(value.target),
        signature: value.signature,
      });
    }
    if (input.operation === "validate") {
      if (!validation || !initialDirectory || Boolean(validation.wrapped) !== (native.kind === "ai")) return refuse();
      const {record, wrapped: value} = validation, current = initialDirectory;
      let draft: OwnAiValidation["draft"];
      if (value?.draft !== undefined) draft = parseOwnAiValidation({v: 1, stateDigest: "0".repeat(64), latestSequence: 1,
        latestDigest: "0".repeat(64), disposition: "draft", draft: value.draft}).draft;
      input.phase?.("validation-approval");
      if (!(await authority.approved(record.certificate, native))) refuse();
      input.phase?.("validation-record");
      const checked = await validateCustomerRecord({
        profile: input.profile,
        pinnedRoot: input.profile.rootKey,
        record,
        scope: current.scope,
        recipients: current.recipients,
        recoveryKeys: input.keys.recovery,
        validationPrivateKey: input.keys.validation.privateKey,
        authorize: (certificate) => authority.approved(certificate),
        ...(native.kind === "ai" && input.aiVerifierKey ? {validateOwnAi: (candidate: typeof record, content: unknown) => validateOwnAiRecord({
          profile: input.profile, record: candidate, content, native: input.native,
          recoveryKeys: input.keys.recovery, verifierKey: input.aiVerifierKey!, ...(draft ? {draft} : {}),
        })} : {}),
      });
      input.phase?.("validation-final");
      const [latest, next] = await Promise.all([
        nativeEnrollment(input.native, ref, input.profile),
        directory(input.native, ref, input.profile, record.scope.audience),
      ]);
      if (
        !(await authority.approved(record.certificate, latest)) ||
        !sameScope(current.scope, next.scope)
      )
        refuse();
      input.phase?.("journal-finish");
      return checked;
    }
    if (input.operation === "recover") {
      input.phase?.("recovery-approval");
      const value = object(body.value, [
        "certificate",
        "sequence",
        "recordDigest",
        "audience",
      ]);
      const certificate = parseCertificate(value.certificate),
        sequence = integer(value.sequence, 1);
      if (
        typeof value.recordDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.recordDigest) ||
        !["conversation", "team", "ai-draft"].includes(
          String(value.audience),
        ) ||
        !(await authority.approved(certificate, native))
      )
        refuse();
      const audience = value.audience as E2eeScope["audience"];
      // Both native reads authorize this caller independently. Their results
      // remain unusable until the fresh final native and journal checks pass.
      input.phase?.("recovery-read");
      const [current, retained] = await Promise.all([
        directory(input.native, ref, input.profile, audience),
        input.native(`${caseBase(ref)}/history?audience=${audience}&after=${sequence - 1}&limit=1`),
      ]);
      input.phase?.("recovery-recipient");
      if (
        !current.recipients.some(
          (recipient) => recipient.id === certificate.id && recipient.signature === certificate.signature,
        )
      ) refuse();
      // Never trust a caller-supplied old row: native retention stays required.
      input.phase?.("recovery-record");
      const history = object(retained, ["records", "nextAfter"]);
      if (!Array.isArray(history.records) || history.records.length !== 1)
        refuse();
      const row = history.records[0] as StoredEncryptedRecord;
      if (
        row.sequence !== sequence ||
        row.record.scope.audience !== audience ||
        (await encryptedRecordDigest(row.record)) !== value.recordDigest
      )
        refuse();
      input.phase?.("recovery-wrap");
      const recovered = await recoverCustomerRecord({
        profile: input.profile,
        pinnedRoot: input.profile.rootKey,
        record: row.record,
        receipt: row.receipt,
        certificate,
        recoveryKeys: input.keys.recovery,
        validationPrivateKey: input.keys.validation.privateKey,
        authorizationRevision: current.scope.authorizationRevision,
        approve: async () =>
          (await authority.approved(certificate, native))
            ? { source: "existing-device", grant: certificate.grant }
            : null,
        canRead: async (recipient, record) =>
          recipient.id === certificate.id &&
          recipient.signature === certificate.signature &&
          record.scope.audience === audience &&
          (await encryptedRecordDigest(record)) === value.recordDigest &&
          current.recipients.some(
            (approved) => approved.signature === recipient.signature,
          ),
      });
      input.phase?.("recovery-final");
      const latest = await nativeEnrollment(input.native, ref, input.profile);
      const next = await directory(
        input.native,
        ref,
        input.profile,
        audience,
      );
      if (
        !(await authority.approved(certificate, latest)) ||
        !sameScope(current.scope, next.scope)
      )
        refuse();
      input.phase?.("journal-finish");
      return recovered;
    }
    return refuse();
  }, control, input.operation === "recover" || input.operation === "validate", snapshot);
  if (input.operation === "revoke-device") {
    // The journal committed the local denial before either network step.
    await input.journal.flushRevocations();
    return { revoked: true };
  }
  return result;
}
