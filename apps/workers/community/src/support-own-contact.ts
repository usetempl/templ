/** Own contact email is opt-in case metadata, never message or AI content. */
import {OWN_SUPPORT_ENDPOINT, object, opaqueId, type E2eeCase} from "@templ/e2ee/protocol";
import {encryptedOutcomeCheckpoint, readEncryptedAudienceRecord, type RelayStorage} from "@templ/e2ee/relay";
import {parseSupportLeadInput, SupportLeadError} from "@templ/chat/support-lead";
import {encryptedRecordDigest} from "@templ/e2ee/verify";
import {HttpError, json} from "./common";
import {screenSupportLeadText} from "./secret-guard";
import {supportRecord} from "./support-workflow";
import type {ConversationContext, TeamConversationRecord} from "./team-conversations";

export async function ownContact(storage: DurableObjectTransaction, context: ConversationContext,
  ref: E2eeCase, record: TeamConversationRecord, writable: boolean) {
  const missing = () => new HttpError(404, "Contact request not found.");
  if (context.isBot || ref.workspace !== OWN_SUPPORT_ENDPOINT.workspace || ref.environment !== "production" ||
      context.mediaEnv.TEMPL_SUPPORT_WORKSPACE !== ref.workspace ||
      context.headers.get("X-Support-Widget") !== "member" ||
      context.headers.get("X-Support-Widget-Origin") !== OWN_SUPPORT_ENDPOINT.clientOrigin ||
      !["GET", "POST"].includes(context.method)) throw missing();
  const data = await supportRecord(storage, record), current = data.ownContactSubmission?.revision ?? 0;
  if (data.caseSeq !== ref.caseSeq) throw missing();
  if (context.method === "GET") return json({revision: current, hasEmail: Boolean(data.lead?.email), writable});
  const input = object(context.body, ["email", "clientId", "messageId", "expectedRevision", "confirmed"]);
  if (input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) throw missing();
  const clientId = opaqueId(input.clientId), messageId = opaqueId(input.messageId);
  let contact;
  try {contact = parseSupportLeadInput({kind: "email", email: input.email});}
  catch (error) {if (error instanceof SupportLeadError) throw new HttpError(400, error.message); throw error;}
  if (contact.kind !== "email") throw missing();
  await screenSupportLeadText(contact.email);
  const outcome = await encryptedOutcomeCheckpoint(storage as RelayStorage, ref, messageId);
  if (outcome?.state !== "accepted" || !context.aliases.includes(outcome.principal as typeof context.aliases[number])) throw missing();
  const row = await readEncryptedAudienceRecord(storage as RelayStorage, ref, "conversation", outcome.sequence);
  if (!row || row.record.id !== messageId || row.record.purpose !== "member-message" || row.record.certificate.kind !== "member") throw missing();
  if (await encryptedRecordDigest(row.record) !== outcome.digest) throw missing();
  const fingerprint = JSON.stringify({caseSeq: ref.caseSeq, messageId, email: contact.email});
  const previous = data.ownContactSubmission;
  if (previous?.clientId === clientId) {
    if (previous.input !== fingerprint) throw new HttpError(409, "This contact retry changed. Review the email again.");
    return json({saved: true, revision: current});
  }
  if (input.expectedRevision !== current || current >= Number.MAX_SAFE_INTEGER)
    throw new HttpError(409, "The contact request changed. Review the email again.");
  data.lead = {...data.lead, email: contact.email, submittedAt: new Date(context.now).toISOString()};
  data.ownContactSubmission = {clientId, input: fingerprint, revision: current + 1};
  // The ordinary workflow reader exposes lead metadata only to a current
  // human team member. Existing case deletion removes this same record.
  await storage.put(`support-workflow-v1:${record.id}`, data);
  return json({saved: true, revision: current + 1});
}
