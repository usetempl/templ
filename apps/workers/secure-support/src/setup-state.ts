import {base64url, EncryptionProtocolError, type OwnSupportEncryptionProfile} from "@templ/e2ee/protocol";
import {parseOwnSetupStatus} from "@templ/e2ee/own-setup";
import {ownSetupSnapshotBytes, verifyOwnSetupSnapshot, type OwnSetupSnapshot} from "@templ/e2ee/own-setup-snapshot";
import {restoreOwnVault, readAuthoritySnapshot, type AuthorityObjectStore, type NativeAuthorityControl} from "./authority-journal";
import type {NativeRequest} from "./native-api";
import type {CustomerKeyBackup} from "@templ/e2ee/backup";

/** A manager may export current public authority plus an encrypted journal.
 * Current native permission is checked before keys are opened and again before
 * the snapshot is signed. The export carries no session or private key. */
export async function exportOwnSetupState(input: {
  profile: OwnSupportEncryptionProfile; request: NativeRequest; backup: () => Promise<CustomerKeyBackup>;
  backupWrappingKey: CryptoKey; authorityWrappingKey: CryptoKey; store: AuthorityObjectStore; native: NativeAuthorityControl;
}): Promise<OwnSetupSnapshot> {
  const readStatus = async () => parseOwnSetupStatus(await input.request("/conversations/encryption/setup"));
  const first = await readStatus();
  const {keys} = await restoreOwnVault({...input, backup: await input.backup()});
  const status = await readStatus();
  if (first.principal !== status.principal) throw new EncryptionProtocolError();
  const current = await readAuthoritySnapshot({...input, wrappingKey: input.authorityWrappingKey});
  const stored = await input.store.read();
  const checked = await readStatus(), latest = await input.native.read(), finalStored = await input.store.read();
  if (!stored || !finalStored || !current.native.authority ||
    JSON.stringify(status) !== JSON.stringify(checked) ||
    status.permissionRevision !== current.native.permissionRevision || status.deletionRevision !== current.native.deletionRevision ||
    JSON.stringify(status.authority) !== JSON.stringify(current.native.authority) ||
    latest.permissionRevision !== current.native.permissionRevision || latest.deletionRevision !== current.native.deletionRevision ||
    JSON.stringify(latest.authority) !== JSON.stringify(current.native.authority) ||
    stored.etag !== current.etag || finalStored.etag !== stored.etag ||
    base64url(finalStored.bytes) !== base64url(stored.bytes)) throw new EncryptionProtocolError();
  const issuedAt = Date.now();
  const unsigned = {v: 1 as const, profile: input.profile, status, checkpointAt: current.native.at, issuedAt, expiresAt: issuedAt + 60_000,
    journal: {etag: stored.etag, bytes: base64url(stored.bytes)}};
  const signature = base64url(new Uint8Array(await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, keys.root.privateKey, await ownSetupSnapshotBytes(unsigned))));
  return verifyOwnSetupSnapshot({...unsigned, signature}, input.profile.rootKey);
}
