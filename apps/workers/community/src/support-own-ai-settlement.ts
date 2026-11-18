/** Resolve only an original Own AI envelope after case access is withdrawn.
 * This capability can deny a send or acknowledge its existing outcome. It
 * grants no case read, enrollment, key, replacement write or model call. */
import {OWN_SUPPORT_ENDPOINT, OWN_SUPPORT_AI_PRINCIPAL, EncryptionProtocolError, caseOf, object, type EncryptionProfile} from "@templ/e2ee/protocol";
import {verifyAcceptedRecord, encryptedRecordDigest} from "@templ/e2ee/verify";
import {encryptedCaseStateKey, encryptedCaseDeletionKey, encryptedOutcomeCheckpoint,
  encryptedOutcomeCheckpointKey, encryptedOutcomeCoverageKey, type RelayCaseState, type RelayOutcomeCoverage, type RelayStorage} from "@templ/e2ee/relay";
import {roomKey} from "./common";
import type {ConversationContext} from "./team-conversations";

export async function settleOwnAiEnvelope(storage: RelayStorage, context: ConversationContext, profile: EncryptionProfile | undefined, value: unknown) {
  const refuse = (): never => {throw new EncryptionProtocolError("encryption-integrity");};
  if (context.appOrigin !== "https://usetempl.com" || roomKey(context.room) !== `room:${OWN_SUPPORT_ENDPOINT.workspace}` ||
      context.viewer.principalId !== OWN_SUPPORT_AI_PRINCIPAL || profile?.custody !== "templ-own-support" ||
      profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT) return refuse();
  const body = object(value, ["encryptedRecord", "validationReceipt"]);
  const record = await verifyAcceptedRecord(profile, body.encryptedRecord, body.validationReceipt);
  if (record.certificate.kind !== "ai" || !["draft", "team-message"].includes(record.purpose)) return refuse();
  const ref = caseOf(record.scope), digest = await encryptedRecordDigest(record);
  const outcome = await encryptedOutcomeCheckpoint(storage, ref, record.id);
  if (outcome) {
    if (outcome.principal !== OWN_SUPPORT_AI_PRINCIPAL || (outcome.state === "accepted" && outcome.digest !== digest)) return refuse();
    return {state: outcome.state, id: record.id, digest};
  }
  // A retained deletion decision is terminal even after content and all
  // readers have been removed. An absent/unreadable case alone proves nothing.
  if (await storage.get(encryptedCaseDeletionKey(ref))) return {state: "fenced", id: record.id, digest};
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey(ref));
  const coverage = await storage.get<RelayOutcomeCoverage>(encryptedOutcomeCoverageKey(ref));
  if (!state || !coverage || state.profile.signature !== profile.signature ||
      JSON.stringify(coverage.case) !== JSON.stringify(ref)) return refuse();
  const fences = Math.max(state.fences, coverage.fences);
  if (!Number.isSafeInteger(fences) || fences < 0 || fences >= 256) return refuse();
  // The same native transaction serializes this fence with submit and restore.
  await storage.put(encryptedOutcomeCheckpointKey(ref, record.id), {state: "fenced", principal: OWN_SUPPORT_AI_PRINCIPAL});
  await storage.put(encryptedOutcomeCoverageKey(ref), {...coverage, fences: fences + 1});
  await storage.put(encryptedCaseStateKey(ref), {...state, fences: fences + 1});
  return {state: "fenced", id: record.id, digest};
}
