/** Own AI verification stays at the approved endpoint. Only content-free
 * signed decisions leave it; private source/provenance text stays encrypted. */
import { checkedProvenance, type SupportAiProvenance } from "@templ/chat/support-drafts";
import { checkCitations, findFigures, hasCitationMarkers, stripCitationMarkers } from "@templ/chat/support-citations";
import { proveFaqCitationsFromSources } from "@templ/chat/support-faq-citations";
import { isBoundedClarification, normalizeFaqQuestion } from "@templ/chat/support-ai-interactions";
import { readCustomerRecord } from "@templ/e2ee/customer";
import { parseOwnAiDraft, ownAiVerifierBytes, ownAiReceipt, type OwnAiContext } from "@templ/e2ee/own-ai-protocol";
import { EncryptionProtocolError, object, caseOf, type EncryptedRecord, type OwnAiValidation, type OwnSupportEncryptionProfile } from "@templ/e2ee/protocol";
import { encryptedRecordDigest, sha256, verifySignature } from "@templ/e2ee/verify";
import type { StoredEncryptedRecord } from "@templ/e2ee/relay";
import { caseBase, type NativeRequest } from "./native-api";

const refused = (): never => {throw new EncryptionProtocolError("encryption-scope-changed");};
type Input = {
  profile: OwnSupportEncryptionProfile; record: EncryptedRecord; content: unknown;
  native: NativeRequest; recoveryKeys: CryptoKeyPair; verifierKey: string;
  draft?: OwnAiValidation["draft"];
};
async function readRow(input: Input, sequence: number, digest: string, audience: "conversation" | "ai-draft") {
  const ref = caseOf(input.record.scope);
  const page = await input.native<{records: StoredEncryptedRecord[]}>(`${caseBase(ref)}/history?audience=${audience}&after=${sequence - 1}&limit=1`);
  if (!Array.isArray(page.records) || page.records.length !== 1) return refused();
  const row = page.records[0];
  if (row.sequence !== sequence || row.record.scope.audience !== audience || caseBase(caseOf(row.record.scope)) !== caseBase(ref) ||
      await encryptedRecordDigest(row.record) !== digest) return refused();
  return row;
}
async function readContext(input: Input) {
  const context = await input.native<OwnAiContext>(`${caseBase(caseOf(input.record.scope))}/ai-context`);
  const {stateDigest, ...value} = context;
  if (context.v !== 1 || caseBase(context.case) !== caseBase(caseOf(input.record.scope)) ||
      context.authorizationGrant !== input.record.certificate.authorizationGrant || !context.latest.member ||
      stateDigest !== await sha256(new TextEncoder().encode(JSON.stringify(value)))) return refused();
  return context;
}
async function reviewDraft(input: Input, context: OwnAiContext): Promise<OwnAiValidation> {
  const content = parseOwnAiDraft(input.content), verification = content.verification;
  if (input.draft || verification.stateDigest !== context.stateDigest ||
      content.replyTo !== String(context.latest.sequence) ||
      !await verifySignature(input.verifierKey, verification.proof, ownAiVerifierBytes(input.profile, input.record, content))) return refused();
  // The signing process runs the existing independent model/source verifier.
  // Its signature is distinct from the AI's message/device signing key.
  const latest = await readRow(input, context.latest.sequence, context.latest.recordDigest, "conversation");
  const member = await readCustomerRecord({profile: input.profile, ...latest, recoveryKeys: input.recoveryKeys,
    authorize: async () => (await readContext(input)).stateDigest === context.stateDigest,
    consume: async value => object(value, ["text"], ["context", "contextConsent", "replyTo"]),
  });
  let provenance: SupportAiProvenance | null = null;
  if (verification.provenance !== null) provenance = checkedProvenance(verification.provenance);
  // Managed-native grounding receipts have their own verifier and cannot be
  // imported as proof into this hosted-agent protocol.
  if (provenance?.grounding) return refused();
  const diagnoses = new Set(context.diagnoses.map(row => row.id));
  if (provenance?.sources.some(source => source.kind === "diagnosis" && !diagnoses.has(source.id))) return refused();
  const hasFacts = hasCitationMarkers(verification.sent) || findFigures(stripCitationMarkers(verification.sent).text).length > 0;
  let check = checkCitations(verification.sent, hasFacts && context.citations !== "unreadable" ? context.citations : [], context.diagnoses);
  if (hasFacts && context.citations === "unreadable") check = {...check, ok: false, problems: [{kind: "evidence-unreadable"}]};
  if (hasFacts) check = await proveFaqCitationsFromSources(check, provenance, context.knowledge.hits);
  if (check.problems.some(problem => problem.kind === "unknown-diagnosis")) return refused();
  if (check.text !== content.text) return refused();
  const disposition = verification.disposition;
  if (disposition === "greeting") {
    if (provenance?.reason !== "clarifying-question" || content.text !== "Hi! How can we help?" || typeof member.text !== "string" ||
        !/^(?:hi|hello|hey|gm|good (?:morning|afternoon|evening))[.!?]{0,3}$/i.test(member.text.replace(/\s+/g, " ").trim())) return refused();
    // A final “hi” cannot hide an earlier support question in the same turn.
    // Refuse a turn too long to prove within this bounded read.
    const after = Math.max(0, context.latest.sequence - 50);
    const page = await input.native<{records: StoredEncryptedRecord[]}>(`${caseBase(context.case)}/history?audience=conversation&after=${after}&limit=50`);
    if (!Array.isArray(page.records) || page.records.length > 50 || page.records.at(-1)?.sequence !== context.latest.sequence) return refused();
    let complete = after === 0;
    for (const row of [...page.records].reverse()) {
      if (row.record.purpose !== "member-message") {complete = true; break;}
      await readCustomerRecord({profile: input.profile, ...row, recoveryKeys: input.recoveryKeys,
        authorize: async () => (await readContext(input)).stateDigest === context.stateDigest,
        consume: async value => {
          const content = object(value, ["text"], ["context", "contextConsent", "replyTo"]);
          if (typeof content.text !== "string" || !/^(?:hi|hello|hey|gm|good (?:morning|afternoon|evening))[.!?]{0,3}$/i.test(content.text.replace(/\s+/g, " ").trim())) return refused();
        }});
    }
    if (!complete) return refused();
  } else if (disposition === "clarify") {
    if (provenance?.reason !== "clarifying-question" || !isBoundedClarification(content.text) || context.clarificationUsed ||
        (context.interactionPolicy && provenance.interaction?.kind !== "clarify")) return refused();
  } else if (disposition === "answer") {
    if (!(provenance?.reason === "answer" || provenance?.reason === "quote" && verification.handoff === "quote") ||
        !provenance.sources.length || (context.citationSetting === "hold" && !check.ok)) return refused();
  } else if (!["hold", "handoff", "draft"].includes(disposition)) return refused();
  if (provenance?.interaction) {
    if (!context.interactionPolicy || provenance.interaction.knowledgeVersion !== context.knowledge.version) return refused();
    if (provenance.interaction.kind === "faq") {
      const matches = context.knowledge.hits.filter(hit => hit.kind === "faq" && normalizeFaqQuestion(hit.title) === normalizeFaqQuestion(String(member.text)));
      if (context.messageCount !== 1 || member.context !== undefined || matches.length !== 1 ||
          matches[0].excerpt !== content.text || provenance.sources.length !== 1 ||
          provenance.sources[0].id !== `kb.${(await sha256(new TextEncoder().encode(matches[0].sourceId))).slice(0, 24)}` ||
          provenance.sources[0].title !== matches[0].title.slice(0, 120) || /\d|[%$€£]|https?:|www\./i.test(content.text)) return refused();
    }
  }
  if (context.mode === "drafts" && ["answer", "clarify", "greeting"].includes(disposition)) return refused();
  return ownAiReceipt(context, disposition, undefined, verification.handoff);
}
export async function validateOwnAiRecord(input: Input): Promise<OwnAiValidation> {
  const context = await readContext(input);
  let result: OwnAiValidation;
  if (input.record.purpose === "draft" && input.record.scope.audience === "ai-draft") result = await reviewDraft(input, context);
  else {
    if (input.record.purpose !== "team-message" || input.record.scope.audience !== "conversation" ||
        context.mode !== "answers" || !input.draft) return refused();
    const row = await readRow(input, input.draft.sequence, input.draft.recordDigest, "ai-draft"), ai = row.receipt.ai;
    if (row.record.certificate.kind !== "ai" || row.record.certificate.actor !== input.record.certificate.actor ||
        row.record.purpose !== "draft" || !ai || ai.draft || ai.stateDigest !== context.stateDigest ||
        row.receipt.expiresAt <= Date.now() || !["answer", "clarify", "greeting"].includes(ai.disposition)) return refused();
    const content = object(input.content, ["text", "replyTo"]);
    await readCustomerRecord({profile: input.profile, ...row, recoveryKeys: input.recoveryKeys,
      authorize: async () => (await readContext(input)).stateDigest === context.stateDigest,
      consume: async value => {
        const approved = parseOwnAiDraft(value);
        if (content.text !== approved.text || content.replyTo !== String(context.latest.sequence)) return refused();
      },
    });
    result = ownAiReceipt(context, ai.disposition, input.draft, ai.handoff);
  }
  if ((await readContext(input)).stateDigest !== context.stateDigest) return refused();
  return result;
}
