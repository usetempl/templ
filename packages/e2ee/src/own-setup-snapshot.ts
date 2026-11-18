/** Authenticated, short-lived export for the independent Own setup signer. */
import {EncryptionProtocolError, decoded, integer, object, utf8, type OwnSupportEncryptionProfile} from "./protocol";
import {sha256, verifyEncryptionProfile, verifySignature} from "./verify";
import {ownSetupExpectedBytes, parseOwnSetupStatus, type OwnSetupStatus} from "./own-setup";

export const OWN_SETUP_SNAPSHOT_LIMIT = 3 * 1024 * 1024;
export type OwnSetupSnapshot = {v: 1; profile: OwnSupportEncryptionProfile; status: OwnSetupStatus;
  checkpointAt: number; issuedAt: number; expiresAt: number; journal: {etag: string; bytes: string}; signature: string};
const fail = (): never => {throw new EncryptionProtocolError("encryption-scope-changed");};
export async function ownSetupSnapshotBytes(value: Omit<OwnSetupSnapshot, "signature">) {
  const state = value.status;
  return utf8(JSON.stringify(["templ:own-support:setup-snapshot:v1", value.profile.rootKey, value.profile.signature,
    state.principal, ownSetupExpectedBytes(state), state.available, state.newCases, state.appliedDigest,
    value.checkpointAt, value.issuedAt, value.expiresAt, value.journal.etag, await sha256(decoded(value.journal.bytes, 17, 2 * 1024 * 1024))]));
}
export async function verifyOwnSetupSnapshot(input: unknown, pinnedRoot: string, now = Date.now()): Promise<OwnSetupSnapshot> {
  const raw = object(input, ["v", "profile", "status", "checkpointAt", "issuedAt", "expiresAt", "journal", "signature"]);
  const profile = await verifyEncryptionProfile(raw.profile, pinnedRoot), status = parseOwnSetupStatus(raw.status);
  const checkpointAt = integer(raw.checkpointAt, 0), issuedAt = integer(raw.issuedAt, 0), expiresAt = integer(raw.expiresAt, 0);
  const journal = object(raw.journal, ["etag", "bytes"]);
  if (raw.v !== 1 || profile.custody !== "templ-own-support" || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 60_000 ||
    checkpointAt > issuedAt || issuedAt - checkpointAt > 60_000 || !status.authority ||
    (status.profileSignature !== null && status.profileSignature !== profile.signature) ||
    typeof journal.etag !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(journal.etag) ||
    await sha256(decoded(journal.bytes, 17, 2 * 1024 * 1024)) !== status.authority.digest) fail();
  const value = {v: 1 as const, profile: profile as OwnSupportEncryptionProfile, status, checkpointAt, issuedAt, expiresAt,
    journal: {etag: journal.etag as string, bytes: journal.bytes as string}, signature: String(raw.signature)};
  if (!await verifySignature(pinnedRoot, value.signature, await ownSetupSnapshotBytes(value))) fail();
  return value;
}
