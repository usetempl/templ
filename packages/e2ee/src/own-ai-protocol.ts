/** Native source snapshot for Own's approved verifier. Contains existing
 * authorized source facts and ciphertext identities, never decrypted chat. */
import type { CitationRow, CitableDiagnosis } from "@templ/chat/support-citations";
import type { KnowledgeContextHit, WorkspaceAiGuidance } from "@templ/chat/knowledge";
import type { E2eeCase } from "./protocol";
import { OWN_SUPPORT_ENDPOINT, utf8, object, bytesOf, decoded, parseOwnAiValidation, type OwnSupportEncryptionProfile, type OwnAiValidation } from "./protocol";
export type OwnAiContext = {
  v: 1;
  case: E2eeCase;
  authorizationGrant: string;
  conversationRevision: number;
  latest: {sequence: number; recordDigest: string; member: boolean};
  mode: "answers" | "drafts";
  clarificationUsed: boolean;
  interactionPolicy: boolean;
  messageCount: number;
  citations: CitationRow[] | "unreadable";
  diagnoses: CitableDiagnosis[];
  citationSetting: "off" | "hold";
  knowledge: {version: string; hits: KnowledgeContextHit[]; guidance: WorkspaceAiGuidance};
  stateDigest: string;
};
export type OwnAiDraftVerification = {
  v: 1;
  stateDigest: string;
  sent: string;
  provenance: unknown;
  disposition: OwnAiValidation["disposition"];
  handoff?: OwnAiValidation["handoff"];
  summary?: string;
  /** Signed by the approved verifier after its actual source check. */
  proof: string;
};
export function ownAiVerifierBytes(profile: OwnSupportEncryptionProfile, record: {scope: E2eeCase; id: string}, content: {text: string; verification: OwnAiDraftVerification}) {
  const verification = content.verification;
  return utf8(JSON.stringify(["templ:own-support:ai-verifier:v1", OWN_SUPPORT_ENDPOINT.serviceOrigin,
    profile.signature, record.scope.environment, record.scope.workspace, record.scope.conversation, record.scope.caseSeq,
    record.id, content.text, verification.v, verification.stateDigest, verification.sent,
    verification.provenance, verification.disposition, verification.summary ?? null, verification.handoff ?? null]));
}
export function ownAiReceipt(context: OwnAiContext, disposition: OwnAiValidation["disposition"], draft?: OwnAiValidation["draft"], handoff?: OwnAiValidation["handoff"]): OwnAiValidation {
  return parseOwnAiValidation({v: 1, stateDigest: context.stateDigest, latestSequence: context.latest.sequence,
    latestDigest: context.latest.recordDigest, disposition, ...(draft ? {draft} : {}), ...(handoff ? {handoff} : {})});
}
export function parseOwnAiDraft(value: unknown) {
  const content = object(value, ["text", "verification"], ["replyTo"]);
  const verification = object(content.verification, ["v", "stateDigest", "sent", "provenance", "disposition", "proof"], ["summary", "handoff"]);
  if (typeof content.text !== "string" || typeof verification.sent !== "string" ||
      verification.v !== 1 || typeof verification.proof !== "string" ||
      !content.text.trim() || bytesOf(content.text) > 4000 || bytesOf(verification.sent) > 4000 ||
      (content.replyTo !== undefined && (typeof content.replyTo !== "string" || !/^[1-9][0-9]{0,15}$/.test(content.replyTo))) ||
      (verification.summary !== undefined && (typeof verification.summary !== "string" || bytesOf(verification.summary) > 500))) throw new Error("Invalid encrypted AI draft");
  decoded(verification.proof, 64);
  parseOwnAiValidation({v: verification.v, stateDigest: verification.stateDigest, latestSequence: 1,
    latestDigest: "0".repeat(64), disposition: verification.disposition, ...(verification.handoff ? {handoff: verification.handoff} : {})});
  return content as unknown as {text: string; replyTo?: string; verification: OwnAiDraftVerification};
}
