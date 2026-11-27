import type { ChatMessage } from "@templ/chat/index";
import type { SupportAiProvenance } from "@templ/chat/support-drafts";
import type { KnowledgeContextPage } from "@templ/chat/knowledge";
import { HOSTED_SOCIAL_REPLIES, isBoundedClarification, normalizeFaqQuestion } from "@templ/chat/support-ai-interactions";
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import { hostedPrepaidPrincipal } from "./product-prepaid-ai";
import { HttpError } from "./common";
import { featureOn, supportKnowledgeOn } from "./workspace-flags";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { storageReadGrant, type StorageBillingEnv } from "./brain-storage-billing";
import { AI_CLARIFICATION_PREFIX, PROVENANCE_PREFIX } from "./support-drafts";
import { messageKey } from "./message-store";
import { messageTextHash } from "./message-retries";
import type { ConversationContext, TeamConversationRecord } from "./team-conversations";
import type { SupportRecord } from "./support-workflow";

const refused = () => new HttpError(409, "The AI answer context changed. A person can review the case.", undefined, "ai-interaction-changed");
const socialTexts = new Set<string>(Object.values(HOSTED_SOCIAL_REPLIES));
function isSocialReply(context: ConversationContext, record: TeamConversationRecord, author: unknown, text?: string) {
  if (text === "Hi! How can we help?") return true;
  if (!text || !socialTexts.has(text) || !context.isBot || context.appOrigin !== "https://usetempl.com" || record.room !== context.room) return false;
  if (text === HOSTED_SOCIAL_REPLIES.offTopic && typeof author === "string" && author === context.viewer.principalId && context.registeredBots?.includes(context.viewer.principalId)) return true;
  if (record.room !== `room:${OWN_SUPPORT_ENDPOINT.workspace}`) return false;
  const principal = hostedPrepaidPrincipal(record.room.slice(5));
  return principal !== null && author === principal && context.registeredBots?.includes(principal) === true;
}
/** A new workflow can never turn a stale, revoked or cross-workspace read into a reply. */
export async function assertAiInteractionReply(storage: DurableObjectTransaction, input: {
  context: ConversationContext; record: TeamConversationRecord; data: SupportRecord;
  caseSeq: number; text: string; provenance: SupportAiProvenance | null; body: Record<string, unknown>;
}) {
  const { context, record, data, provenance, text } = input;
  const interaction = provenance?.interaction;
  const enabled = await featureOn(context.mediaEnv, storage, "aiInteractionImprovements");
  // Existing native managed replies have their own receipt and one-question enforcement.
  if (enabled && provenance?.reason === "clarifying-question" && !isSocialReply(context, record, context.viewer.principalId, text) && !provenance.grounding && interaction?.kind !== "clarify")
    throw refused();
  if (!interaction) return;
  if (!enabled || !supportKnowledgeOn(context.mediaEnv) || input.caseSeq < 1) throw refused();
  if (interaction.kind === "clarify") {
    if (!isBoundedClarification(text)) throw refused();
    if (await storage.get(`${AI_CLARIFICATION_PREFIX}${record.id}:${input.caseSeq}`))
      throw new HttpError(409, "The AI already asked a question. A person needs to answer next.", undefined, "clarify-used");
    const rows = await storage.list<{ case?: number; ai?: { reason?: string }; text?: string }>({ prefix: `${PROVENANCE_PREFIX}${record.id}:`, limit: 1000 });
    if (rows.size >= 1000) throw refused();
    for (const [key, row] of rows) {
      if (row.case !== input.caseSeq || row.ai?.reason !== "clarifying-question") continue;
      const message = await storage.get<ChatMessage>(messageKey(record.id, Number(key.split(":").at(-1))));
      if (!isSocialReply(context, record, message?.author, message?.text))
        throw new HttpError(409, "The AI already asked a question. A person needs to answer next.", undefined, "clarify-used");
    }
  }
  const env = context.mediaEnv as unknown as KnowledgeEnv;
  const grant = await storageReadGrant(storage, context.mediaEnv as StorageBillingEnv, context.now);
  let page = await knowledgeCall<KnowledgeContextPage>(env, context.room, "knowledge.context",
    { principal: context.viewer.principalId!, role: "bot" }, { storageGrant: grant, version: interaction.knowledgeVersion });
  if (page.version !== interaction.knowledgeVersion) throw refused();
  if (interaction.kind !== "faq") return;
  // Only the first uncontextualized member message can use the direct FAQ path.
  const latest = input.body.ifLatest as { id?: unknown } | undefined;
  if (record.messageCount !== 1 || data.context !== null || typeof latest?.id !== "string" || !/^\d+$/.test(latest.id)) throw refused();
  const message = await storage.get<ChatMessage>(messageKey(record.id, Number(latest.id)));
  if (!message || message.author !== record.member) throw refused();
  const matches = [];
  const cursors = new Set<string>();
  let chars = 0;
  for (;;) {
    if (!Array.isArray(page.hits) || page.hits.length > 64) throw refused();
    for (const hit of page.hits) {
      chars += hit.title.length + hit.excerpt.length;
      if (chars > 200_000) throw refused();
      if (hit.kind === "faq" && normalizeFaqQuestion(hit.title) === normalizeFaqQuestion(message.text)) matches.push(hit);
    }
    if (page.nextCursor === null) break;
    if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor)) throw refused();
    cursors.add(page.nextCursor);
    page = await knowledgeCall<KnowledgeContextPage>(env, context.room, "knowledge.context",
      { principal: context.viewer.principalId!, role: "bot" }, { storageGrant: grant, version: interaction.knowledgeVersion, after: page.nextCursor });
    if (page.version !== interaction.knowledgeVersion) throw refused();
  }
  if (matches.length !== 1 || matches[0].era !== "current" || matches[0].visibility !== "member-safe" || matches[0].excerpt !== text ||
      provenance?.sources.length !== 1 || provenance.sources[0].id !== `kb.${(await messageTextHash(matches[0].sourceId)).slice(0, 24)}` ||
      provenance.sources[0].title !== matches[0].title.slice(0, 120) || /\d|[%$€£]|https?:|www\./i.test(text)) throw refused();
}
