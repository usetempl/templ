import {caseOf, EncryptionProtocolError, OWN_SUPPORT_ENDPOINT, parseRecoveredRecordKey, recoveredKeyBytes,
  type EncryptionProfile, type RecoveredRecordKey} from "@templ/e2ee/protocol";
import {encryptedRecordDigest, verifyCertificate, verifySignature} from "@templ/e2ee/verify";
import type {EncryptedTransportOptions} from "@templ/e2ee/transport";

type Recover = NonNullable<EncryptedTransportOptions["recover"]>;
/** Cache only signed, device-encrypted key envelopes, never plaintext or raw
 * keys. Transport still fetches the current directory and retained ciphertext
 * and verifies/decrypts every returned row on each read. */
export function createOwnRecoveryCache(options: {
  profile: EncryptionProfile;
  recover: Recover;
  active: () => boolean;
  signal: AbortSignal;
  now?: () => number;
}) {
  const {profile} = options, now = options.now ?? Date.now;
  if (profile.custody !== "templ-own-support" || profile.workspace !== OWN_SUPPORT_ENDPOINT.workspace ||
      profile.environment !== OWN_SUPPORT_ENDPOINT.environment || profile.clientOrigin !== OWN_SUPPORT_ENDPOINT.clientOrigin ||
      profile.serviceOrigin !== OWN_SUPPORT_ENDPOINT.serviceOrigin) throw new EncryptionProtocolError();
  const entries = new Map<string, Promise<RecoveredRecordKey>>();
  let closed = false;
  const current = () => {if (closed || options.signal.aborted || !options.active()) throw new DOMException("Navigation changed", "AbortError");};
  const close = () => {closed = true; entries.clear(); options.signal.removeEventListener("abort", close);};
  options.signal.addEventListener("abort", close, {once: true});
  if (options.signal.aborted) close();
  const recover: Recover = async (row, identity, authorizationRevision) => {
    current();
    await verifyCertificate(profile, identity.certificate, now());
    const digest = await encryptedRecordDigest(row.record);
    current();
    const key = JSON.stringify([identity.account, identity.revision, identity.certificate.signature,
      caseOf(row.record.scope), row.record.scope.audience, row.sequence, digest, authorizationRevision]);
    const existing = entries.get(key);
    if (existing) {
      const pack = await existing;
      current();
      if (pack.expiresAt > now() + 5_000 && identity.certificate.expiresAt > now()) return structuredClone(pack);
      if (entries.get(key) === existing) entries.delete(key);
      return recover(row, identity, authorizationRevision);
    }
    const operation = (async () => {
      const pack = parseRecoveredRecordKey(await options.recover(row, identity, authorizationRevision));
      current();
      if (pack.recipient.signature !== identity.certificate.signature || pack.recordDigest !== digest ||
          pack.authorizationRevision !== authorizationRevision || pack.issuedAt > now() || pack.expiresAt <= now() ||
          JSON.stringify(caseOf(identity.certificate)) !== JSON.stringify(caseOf(row.record.scope)) ||
          !identity.certificate.audiences.includes(row.record.scope.audience) ||
          !await verifySignature(profile.validationKey, pack.signature, recoveredKeyBytes(pack)))
        throw new EncryptionProtocolError("encryption-integrity");
      current();
      return pack;
    })();
    while (entries.size >= 64) entries.delete(entries.keys().next().value!);
    entries.set(key, operation);
    try {const pack = await operation; current(); return structuredClone(pack);}
    catch (error) {if (entries.get(key) === operation) entries.delete(key); throw error;}
  };
  return {recover, close};
}
