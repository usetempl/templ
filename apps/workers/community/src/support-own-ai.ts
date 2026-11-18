/** Public native authority and source facts for Own's isolated verifier.
 * This module has no decryption key and never accepts answer plaintext. */
import { OWN_SUPPORT_ENDPOINT, OWN_SUPPORT_AI_PRINCIPAL, EncryptionProtocolError, caseOf, object, type EncryptedRecord, type ValidationReceipt, type E2eeCase } from "@templ/e2ee/protocol";
import { encryptedCaseStateKey, readEncryptedAudienceRecord, type RelayCaseState } from "@templ/e2ee/relay";
import { encryptedRecordDigest, sha256 } from "@templ/e2ee/verify";
import type { OwnAiContext } from "@templ/e2ee/own-ai-protocol";
import type { KnowledgeContextPage, WorkspaceAiGuidance } from "@templ/chat/knowledge";
import { checkedWorkspaceAiGuidance } from "@templ/chat/knowledge";
import { SUPPORT_DRAFT_LIMITS } from "@templ/chat/support-drafts";
import { HttpError, roomKey } from "./common";
import { botsFromSettings } from "./bots";
import { nativeEncryptionGrant } from "./support-encryption-access";
import { supportRecord, readAiState, supportSettings, writeHandoff } from "./support-workflow";
import { citationRows } from "./support-evidence-store";
import { citableDiagnoses, enabledFromHeader, DIAGNOSIS_NETWORKS_HEADER } from "./support-diagnosis";
import { citationSetting, AI_CLARIFICATION_PREFIX } from "./support-drafts";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { storageReadGrant, type StorageBillingEnv } from "./brain-storage-billing";
import { featureOn, supportKnowledgeOn } from "./workspace-flags";
import type { ConversationContext, TeamConversationRecord } from "./team-conversations";
import type { ChatPrincipalId } from "@templ/chat/principal";

const refused = () => new HttpError(409, "The AI answer context changed. A person can review the case.", undefined, "ai-interaction-changed");
import { OWN_AI_CONTROL_PREFIX } from "./support-own-ai-control";
export { OWN_AI_CONTROL_PREFIX } from "./support-own-ai-control";
const controlKey = (ref: E2eeCase, suffix: string) => `${OWN_AI_CONTROL_PREFIX}${ref.conversation}:${ref.caseSeq}:${suffix}`;
export async function ownEncryptedAiReader(storage: Pick<DurableObjectTransaction, "get">, record: TeamConversationRecord, aliases: readonly ChatPrincipalId[]) {
  if (roomKey(record.room) !== `room:${OWN_SUPPORT_ENDPOINT.workspace}` || !aliases.includes(OWN_SUPPORT_AI_PRINCIPAL)) return false;
  const settings = await storage.get<object>("chat-settings");
  if (!settings || !botsFromSettings(settings).some(bot => bot.principalId === OWN_SUPPORT_AI_PRINCIPAL)) return false;
  const seq = (await supportRecord(storage, record)).caseSeq ?? 0;
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey({environment: "production", workspace: OWN_SUPPORT_ENDPOINT.workspace, conversation: record.id, caseSeq: seq}));
  return Boolean(state && !state.deleted && state.profile.custody === "templ-own-support" &&
    state.profile.workspace === OWN_SUPPORT_ENDPOINT.workspace && state.profile.environment === "production");
}

export async function ownAiContext(storage: DurableObjectTransaction, context: ConversationContext, record: TeamConversationRecord, ref: E2eeCase): Promise<OwnAiContext> {
  if (context.appOrigin !== "https://usetempl.com" || context.viewer.principalId !== OWN_SUPPORT_AI_PRINCIPAL ||
      !context.isBot || !context.registeredBots?.includes(OWN_SUPPORT_AI_PRINCIPAL) ||
      !(await ownEncryptedAiReader(storage, record, context.aliases)) ||
      context.viewer.banned || context.viewer.mutedUntil || record.stopped) throw refused();
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey(ref)), data = await supportRecord(storage, record);
  if (!state || state.deleted || state.profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT ||
      data.caseSeq !== ref.caseSeq || record.state !== "open") throw refused();
  const {effective} = await readAiState(storage, record, data);
  if (effective.mode === "off" || (effective.mode === "answers" && (record.handoff || record.assignment))) throw refused();
  const latest = await readEncryptedAudienceRecord(storage, ref, "conversation", state.acceptedByAudience.conversation);
  if (!latest) throw new EncryptionProtocolError("encryption-integrity");
  if (!supportKnowledgeOn(context.mediaEnv)) throw refused();
  const env = context.mediaEnv as unknown as KnowledgeEnv, actor = {principal: context.viewer.principalId, role: "bot" as const};
  const storageGrant = await storageReadGrant(storage, context.mediaEnv as StorageBillingEnv, context.now);
  let version: string | undefined, after: string | undefined, chars = 0;
  const hits: KnowledgeContextPage["hits"] = [], cursors = new Set<string>(), ids = new Set<string>();
  do {
    const page = await knowledgeCall<KnowledgeContextPage>(env, context.room, "knowledge.context", actor,
      {storageGrant, ...(version ? {version} : {}), ...(after ? {after} : {})});
    if (!/^[a-f0-9]{64}$/.test(page.version) || (version && page.version !== version) || !Array.isArray(page.hits) || page.hits.length > 64) throw refused();
    version = page.version;
    for (const hit of page.hits) {
      if (hit.era !== "current" || hit.visibility !== "member-safe" || ids.has(hit.sourceId) ||
          typeof hit.title !== "string" || typeof hit.excerpt !== "string") throw refused();
      ids.add(hit.sourceId); chars += hit.title.length + hit.excerpt.length;
      if (chars > 200_000 || hits.length >= 4096) throw refused();
      hits.push(hit);
    }
    if (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor))) throw refused();
    after = page.nextCursor ?? undefined;
    if (after) cursors.add(after);
  } while (after);
  const raw = await knowledgeCall<WorkspaceAiGuidance>(env, context.room, "knowledge.guidance.get", actor);
  if (!checkedWorkspaceAiGuidance(raw)) throw refused();
  const interactionPolicy = await featureOn(context.mediaEnv, storage, "aiInteractionImprovements");
  const guidance: WorkspaceAiGuidance = {text: raw.text, revision: raw.revision, ...(interactionPolicy ? {interactionPolicy: "bounded-v1"} : {})};
  const value: Omit<OwnAiContext, "stateDigest"> = {
    v: 1, case: ref, authorizationGrant: await nativeEncryptionGrant(storage, {
      environment: "production", workspace: OWN_SUPPORT_ENDPOINT.workspace,
      principal: context.viewer.principalId, aliases: context.aliases,
    }), conversationRevision: record.revision,
    latest: {sequence: latest.sequence, recordDigest: await encryptedRecordDigest(latest.record), member: latest.record.purpose === "member-message"},
    mode: effective.mode, clarificationUsed: Boolean(await storage.get(`${AI_CLARIFICATION_PREFIX}${record.id}:${ref.caseSeq}`)),
    interactionPolicy, messageCount: record.messageCount,
    citations: await citationRows(storage, record.id, ref.caseSeq, "agent"),
    diagnoses: await citableDiagnoses(storage, record.id, enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER))),
    citationSetting: citationSetting(await supportSettings(storage)),
    knowledge: {version: version!, hits, guidance},
  };
  return {...value, stateDigest: await sha256(new TextEncoder().encode(JSON.stringify(value)))};
}

/** An interrupted approved AI turn may request a person using metadata only.
 * This never admits an answer, changes consent or creates a usage charge. */
export async function abandonOwnAiTurn(storage: DurableObjectTransaction, context: ConversationContext, record: TeamConversationRecord, ref: E2eeCase, value: unknown) {
  const body = object(value, ["stateDigest", "latestSequence", "latestDigest"]);
  const current = await ownAiContext(storage, context, record, ref);
  if (!current.latest.member || body.stateDigest !== current.stateDigest ||
      body.latestSequence !== current.latest.sequence || body.latestDigest !== current.latest.recordDigest) throw refused();
  const data = await supportRecord(storage, record);
  if (!record.handoff && data.requestedAt !== null)
    await writeHandoff(storage, context, record, data,
      {at: context.now, reason: "unsure", by: "agent", requestAt: data.requestedAt});
}

/** Runs after receipt verification and before admission, in the same native
 * transaction as storage/counters. A valid signature never freezes authority. */
export async function acceptOwnAiProof(storage: DurableObjectTransaction, context: ConversationContext, record: TeamConversationRecord, encrypted: EncryptedRecord, receipt: ValidationReceipt) {
  const ref = caseOf(encrypted.scope), proof = receipt.ai;
  if (!proof || encrypted.certificate.kind !== "ai" || encrypted.replyIntent !== null ||
      !["team-message", "draft"].includes(encrypted.purpose)) throw refused();
  const current = await ownAiContext(storage, context, record, ref);
  if (!current.latest.member || proof.stateDigest !== current.stateDigest ||
      proof.latestSequence !== current.latest.sequence || proof.latestDigest !== current.latest.recordDigest) throw refused();
  const draftKey = controlKey(ref, `draft:${proof.latestDigest}`), countKey = controlKey(ref, "open-drafts");
  const existing = await storage.get<{id: string; digest: string; sequence: number; delivered: boolean}>(draftKey);
  const open = await storage.get<number>(countKey) ?? 0;
  if (!Number.isSafeInteger(open) || open < 0) throw new EncryptionProtocolError("encryption-integrity");
  if (encrypted.purpose === "draft") {
    const previous = existing ? await readEncryptedAudienceRecord(storage, ref, "ai-draft", existing.sequence) : null;
    const replacing = Boolean(existing && !existing.delivered && previous?.receipt.ai && previous.receipt.ai.stateDigest !== proof.stateDigest);
    if (proof.draft || (existing && !replacing) || (!replacing && open >= SUPPORT_DRAFT_LIMITS.draftsPerCase) ||
        (current.mode === "drafts" && ["answer", "clarify", "greeting"].includes(proof.disposition))) throw refused();
    const state = await storage.get<RelayCaseState>(encryptedCaseStateKey(ref));
    if (!state) throw refused();
    await storage.put(draftKey, {id: encrypted.id, digest: await encryptedRecordDigest(encrypted),
      sequence: state.acceptedByAudience["ai-draft"] + 1, delivered: false});
    await storage.put(countKey, open + (replacing ? 0 : 1));
  } else {
    if (current.mode !== "answers" || !proof.draft || !existing || existing.delivered ||
        existing.digest !== proof.draft.recordDigest || existing.sequence !== proof.draft.sequence ||
        !["answer", "clarify", "greeting"].includes(proof.disposition)) throw refused();
    const prior = await readEncryptedAudienceRecord(storage, ref, "ai-draft", proof.draft.sequence);
    if (!prior || prior.record.id !== existing.id || prior.record.certificate.actor !== encrypted.certificate.actor ||
        prior.receipt.ai?.stateDigest !== proof.stateDigest || prior.receipt.ai?.disposition !== proof.disposition ||
        prior.receipt.ai?.handoff !== proof.handoff || prior.receipt.expiresAt <= context.now) throw refused();
    await storage.put(draftKey, {...existing, delivered: true});
    await storage.put(countKey, Math.max(0, open - 1));
    if (proof.disposition === "clarify") {
      if (current.clarificationUsed) throw refused();
      await storage.put(`${AI_CLARIFICATION_PREFIX}${record.id}:${ref.caseSeq}`, {encryptedRecordId: encrypted.id});
    }
  }
}
