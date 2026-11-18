/** A root-approved synthetic opening while ordinary new cases stay legacy.
 * This is no role grant, key approval, live policy or exemption from billing. */
import {EncryptionProtocolError, OWN_SUPPORT_ENDPOINT, object, opaqueId, parseCase, utf8, type E2eeCase, type EncryptionProfile} from "@templ/e2ee/protocol";
import {verifySignature} from "@templ/e2ee/verify";
import {principal} from "./principal";
import type {OwnSetupRelease} from "@templ/e2ee/own-setup";

export const OWN_QUALIFICATION_KEY = "support-encryption-own-qualification-v1";
export type OwnQualificationGrant = {case: E2eeCase; member: string; clientId: string; initialAiMode: "off" | "answers"; until: number};
export type OwnQualification = {v: 1; revision: number; policyRevision: number; profileSignature: string; grant: OwnQualificationGrant | null; actor: string; changedAt: number; ownRelease?: OwnSetupRelease};
type Policy = {revision: number; on: boolean; profile: EncryptionProfile};
type Store = Pick<DurableObjectTransaction, "get" | "put">;
const fail = (): never => {throw new EncryptionProtocolError("encryption-scope-changed");};
export function ownQualificationBytes(profile: EncryptionProfile, policyRevision: number, revision: number, grant: OwnQualificationGrant | null) {
  return utf8(JSON.stringify(["templ:own-support:synthetic-opening:v1", profile.rootKey, profile.signature, policyRevision, revision,
    grant && [grant.case.environment, grant.case.workspace, grant.case.conversation, grant.case.caseSeq, grant.member, grant.clientId, grant.initialAiMode, grant.until]]));
}
export async function checkedOwnQualification(input: unknown, policy: Policy, previous: OwnQualification | undefined, now: number) {
  if (policy.on || policy.profile.custody !== "templ-own-support") fail();
  const body = object(input, ["revision", "grant", "signature"], ["confirmed"]);
  if (body.revision !== (previous?.revision ?? 0) + 1) fail();
  let grant: OwnQualificationGrant | null = null;
  if (body.grant !== null) {
    const value = object(body.grant, ["case", "member", "clientId", "initialAiMode", "until"]);
    const scope = parseCase(value.case), member = principal(value.member);
    if (!member || scope.workspace !== OWN_SUPPORT_ENDPOINT.workspace || scope.environment !== "production" || scope.caseSeq !== 1 ||
        !["off", "answers"].includes(String(value.initialAiMode)) || !Number.isSafeInteger(value.until) ||
        Number(value.until) <= now || Number(value.until) > now + 60 * 60_000) fail();
    grant = {case: scope, member, clientId: opaqueId(value.clientId), initialAiMode: value.initialAiMode as "off" | "answers", until: Number(value.until)};
  }
  if (!await verifySignature(policy.profile.rootKey, String(body.signature), ownQualificationBytes(policy.profile, policy.revision, Number(body.revision), grant))) fail();
  return {revision: Number(body.revision), grant};
}
export function ownQualificationAllows(value: OwnQualification | undefined, policy: Policy | undefined, opening: {id: string; principal: string; case?: E2eeCase; initialAiMode?: "off"}, now: number) {
  const grant = value?.grant;
  return Boolean(grant && policy && !policy.on && policy.profile.custody === "templ-own-support" &&
    value.policyRevision === policy.revision && value.profileSignature === policy.profile.signature &&
    grant.until > now && grant.member === opening.principal && grant.clientId === opening.id &&
    grant.initialAiMode === (opening.initialAiMode ?? "answers") &&
    (!opening.case || (grant.case.environment === opening.case.environment && grant.case.workspace === opening.case.workspace &&
      grant.case.conversation === opening.case.conversation && grant.case.caseSeq === opening.case.caseSeq)));
}
/** Keep only the replay-protection revision once the grant ends. */
export async function forgetOwnQualification(storage: Store, now: number, scope?: {conversation: string; caseSeq?: number}) {
  const value = await storage.get<OwnQualification>(OWN_QUALIFICATION_KEY);
  if (!value?.grant || (scope
    ? value.grant.case.conversation !== scope.conversation || (scope.caseSeq !== undefined && value.grant.case.caseSeq !== scope.caseSeq)
    : value.grant.until > now)) return 0;
  await storage.put(OWN_QUALIFICATION_KEY, {...value, grant: null, changedAt: now});
  return 1;
}
export async function ownQualificationAlarm(storage: Store, now: number) {
  const value = await storage.get<OwnQualification>(OWN_QUALIFICATION_KEY);
  if (!value?.grant) return null;
  if (value.grant.until > now) return value.grant.until;
  await forgetOwnQualification(storage, now);
  return null;
}
