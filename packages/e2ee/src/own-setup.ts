/** Public Own setup approvals and a separate revision-bound stop operation.
 * Neither approves a device. Customer custody is separate. */
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { EncryptionProtocolError, OWN_SUPPORT_ENDPOINT, decoded, integer, object, opaqueId, parseCase, utf8,
  type E2eeCase, type OwnSupportEncryptionProfile } from "./protocol";
import { sha256, verifyEncryptionProfile, verifySignature } from "./verify";

export type OwnSetupGrant = {case: E2eeCase; member: string; clientId: string; initialAiMode: "off" | "answers"; until: number};
export type OwnSetupCheckpoint = {permissionRevision: number; deletionRevision: number; authority: {revision: number; digest: string} | null};
export type OwnSetupExpected = OwnSetupCheckpoint & {policyRevision: number; qualificationRevision: number; setupRevision: number; profileSignature: string | null};
export type OwnSetupRelease = {currentWorkerVersion: string; previousWorkerVersion: string; webVersion: string; currentActivationDigest: string; previousActivationDigest: string};
export type OwnSetupAuthorization = {
  v: 1; action: "prepare" | "activate"; profile: OwnSupportEncryptionProfile; principal: string;
  expected: OwnSetupExpected; issuedAt: number; expiresAt: number; evidenceSha256: string;
  grant: OwnSetupGrant | null; release: OwnSetupRelease; signature: string;
};
export type OwnSetupStatus = OwnSetupExpected & {v: 1; principal: string; available: boolean; newCases: "legacy" | "encrypted"; appliedDigest: string | null};
const fail = (): never => {throw new EncryptionProtocolError("encryption-scope-changed");};
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail();
export function parseOwnSetupRelease(input: unknown): OwnSetupRelease {
  const value = object(input, ["currentWorkerVersion", "previousWorkerVersion", "webVersion", "currentActivationDigest", "previousActivationDigest"]);
  const version = (item: unknown) => typeof item === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item) ? item : fail();
  const result = {currentWorkerVersion: version(value.currentWorkerVersion), previousWorkerVersion: version(value.previousWorkerVersion), webVersion: version(value.webVersion),
    currentActivationDigest: digest(value.currentActivationDigest), previousActivationDigest: digest(value.previousActivationDigest)};
  if (result.currentWorkerVersion === result.previousWorkerVersion || result.currentActivationDigest === result.previousActivationDigest) fail();
  return result;
}
export function ownSetupPrincipal(value: unknown) {
  const result = normalizeChatPrincipal(value);
  if (!result || result !== value) return fail();
  return result;
}
export function parseOwnSetupExpected(input: unknown): OwnSetupExpected {
  const value = object(input, ["policyRevision", "qualificationRevision", "setupRevision", "profileSignature", "permissionRevision", "deletionRevision", "authority"]);
  let authority: OwnSetupCheckpoint["authority"] = null;
  if (value.authority !== null) {
    const anchor = object(value.authority, ["revision", "digest"]);
    authority = {revision: integer(anchor.revision, 0), digest: digest(anchor.digest)};
  }
  if (value.profileSignature !== null) decoded(value.profileSignature, 64);
  return {policyRevision: integer(value.policyRevision, 0), qualificationRevision: integer(value.qualificationRevision, 0),
    setupRevision: integer(value.setupRevision, 0), profileSignature: value.profileSignature as string | null,
    permissionRevision: integer(value.permissionRevision, 0), deletionRevision: integer(value.deletionRevision, 0), authority};
}
export function parseOwnSetupStatus(input: unknown): OwnSetupStatus {
  const value = object(input, ["v", "principal", "available", "newCases", "appliedDigest", "policyRevision", "qualificationRevision", "setupRevision", "profileSignature", "permissionRevision", "deletionRevision", "authority"]);
  const {v, principal, available, newCases, appliedDigest, ...expected} = value;
  if (v !== 1 || typeof available !== "boolean" || !["legacy", "encrypted"].includes(String(newCases))) fail();
  return {...parseOwnSetupExpected(expected), v: 1, principal: ownSetupPrincipal(principal), available: available as boolean,
    newCases: newCases as OwnSetupStatus["newCases"], appliedDigest: appliedDigest === null ? null : digest(appliedDigest)};
}
export function ownSetupExpected(status: OwnSetupStatus): OwnSetupExpected {
  const {v: _v, principal: _principal, available: _available, newCases: _newCases, appliedDigest: _digest, ...expected} = status;
  return parseOwnSetupExpected(expected);
}
export function ownSetupExpectedBytes(value: OwnSetupExpected) {
  return [value.policyRevision, value.qualificationRevision, value.setupRevision, value.profileSignature,
    value.permissionRevision, value.deletionRevision, value.authority && [value.authority.revision, value.authority.digest]];
}
export function ownSetupBytes(value: Omit<OwnSetupAuthorization, "signature">) {
  const grant = value.grant;
  return utf8(JSON.stringify(["templ:own-support:setup-authorization:v1", OWN_SUPPORT_ENDPOINT.environment, OWN_SUPPORT_ENDPOINT.workspace,
    value.profile.rootKey, value.profile.signature, value.principal, value.action, ownSetupExpectedBytes(value.expected), value.issuedAt, value.expiresAt, value.evidenceSha256,
    [value.release.currentWorkerVersion, value.release.previousWorkerVersion, value.release.webVersion, value.release.currentActivationDigest, value.release.previousActivationDigest],
    grant && [grant.case.environment, grant.case.workspace, grant.case.conversation, grant.case.caseSeq, grant.member, grant.clientId, grant.initialAiMode, grant.until]]));
}
export async function ownSetupDigest(value: OwnSetupAuthorization) {
  return sha256(utf8(JSON.stringify([new TextDecoder().decode(ownSetupBytes(value)), value.signature])));
}
export async function verifyOwnSetupAuthorization(input: unknown, pinnedRoot: string, now = Date.now(), allowExpired = false): Promise<OwnSetupAuthorization> {
  const raw = object(input, ["v", "action", "profile", "principal", "expected", "issuedAt", "expiresAt", "evidenceSha256", "grant", "release", "signature"]);
  const profile = await verifyEncryptionProfile(raw.profile, pinnedRoot);
  if (raw.v !== 1 || profile.custody !== "templ-own-support" || !["prepare", "activate"].includes(String(raw.action))) fail();
  const issuedAt = integer(raw.issuedAt, 0), expiresAt = integer(raw.expiresAt, 0);
  if (issuedAt > now || expiresAt <= issuedAt || expiresAt - issuedAt > 3_600_000 || (!allowExpired && expiresAt <= now)) fail();
  let grant: OwnSetupGrant | null = null;
  if (raw.grant !== null) {
    const value = object(raw.grant, ["case", "member", "clientId", "initialAiMode", "until"]), scope = parseCase(value.case);
    const until = integer(value.until, 0);
    if (scope.environment !== OWN_SUPPORT_ENDPOINT.environment || scope.workspace !== OWN_SUPPORT_ENDPOINT.workspace || scope.caseSeq !== 1 ||
      !["off", "answers"].includes(String(value.initialAiMode)) || until <= issuedAt || until > expiresAt) fail();
    grant = {case: scope, member: ownSetupPrincipal(value.member), clientId: opaqueId(value.clientId), initialAiMode: value.initialAiMode as "off" | "answers", until};
  }
  if ((raw.action === "prepare") !== Boolean(grant)) fail();
  const value = {v: 1 as const, action: raw.action as OwnSetupAuthorization["action"], profile: profile as OwnSupportEncryptionProfile,
    principal: ownSetupPrincipal(raw.principal), expected: parseOwnSetupExpected(raw.expected), issuedAt, expiresAt,
    evidenceSha256: digest(raw.evidenceSha256), grant, release: parseOwnSetupRelease(raw.release), signature: String(raw.signature)};
  if (!await verifySignature(pinnedRoot, value.signature, ownSetupBytes(value))) fail();
  return value;
}

/** Separate from bounded setup grants: this signs only the existing off-policy
 * wire format. It has no time expiry and is usable only at its next revision
 * by a current manager. It cannot enable encryption or grant any reader. */
export type OwnStopAuthorization = {v: 1; action: "stop"; profile: OwnSupportEncryptionProfile; revision: number; signature: string};
export function ownStopBytes(profile: OwnSupportEncryptionProfile, revision: number) {
  return utf8(JSON.stringify(["templ:e2ee:own-support-policy:v1", profile.workspace, profile.environment, profile.signature, revision, false]));
}
export async function verifyOwnStopAuthorization(input: unknown, pinnedRoot: string): Promise<OwnStopAuthorization> {
  const raw = object(input, ["v", "action", "profile", "revision", "signature"]);
  const profile = await verifyEncryptionProfile(raw.profile, pinnedRoot);
  if (raw.v !== 1 || raw.action !== "stop" || profile.custody !== "templ-own-support" ||
    profile.workspace !== OWN_SUPPORT_ENDPOINT.workspace || profile.environment !== OWN_SUPPORT_ENDPOINT.environment) fail();
  const ownProfile = profile as OwnSupportEncryptionProfile;
  const revision = integer(raw.revision, 1), signature = String(raw.signature);
  if (!await verifySignature(pinnedRoot, signature, ownStopBytes(ownProfile, revision))) fail();
  return {v: 1, action: "stop", profile: ownProfile, revision, signature};
}
