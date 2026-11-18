/** A wrong AI reply can lead a current Admin to pause only the exact
 * automatic FAQ entry it cited. Labels alone never change knowledge. */
import { checkedProvenance } from "@templ/chat/support-drafts";
import type { LearnedFaqCorrectionSource, LearnedFaqCorrectionView } from "@templ/chat/support-learning";
import { HttpError } from "./common";
import { provenanceKey, type StoredProvenance } from "./support-drafts";
import { readMessage } from "./message-store";
import { knowledgeActor, knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { caseForMessage, readQuality, type QualityViewer } from "./support-quality";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import type { ConversationContext, TeamConversationRecord } from "./team-conversations";
import { featureOn } from "./workspace-flags";

export const LEARNED_CORRECTION_REASONS = ["wrong-facts", "wrong-product", "wrong-metric-or-window", "unsupported-claim", "unsafe"] as const;
type Storage = DurableObjectTransaction;
const unavailable = () => new HttpError(404, "Learned answer review is unavailable.");
export async function learnedCorrectionAvailable(storage: Storage, context: ConversationContext, viewer: QualityViewer) {
  return !viewer.bot && await featureOn(context.mediaEnv, storage, "handoffLearning");
}

export async function learnedReplyCorrection(
  storage: Storage, env: KnowledgeEnv, context: ConversationContext,
  viewer: QualityViewer, record: TeamConversationRecord,
): Promise<LearnedFaqCorrectionView> {
  if (!await learnedCorrectionAvailable(storage, context, viewer)) throw unavailable();
  const message = Number(context.body.message);
  if (!Number.isSafeInteger(message) || !/^[1-9][0-9]{0,14}$/.test(String(context.body.message)))
    throw new HttpError(400, "Choose an AI reply to review.");
  const { read, author, createdAt } = await caseForMessage(storage, record, message);
  const quality = await readQuality(storage, record.id, read.seq);
  const label = quality?.labels.find((entry) => entry.message === message && entry.bot);
  const reason = label && LEARNED_CORRECTION_REASONS.find((item) => label.labels.includes(item));
  if (!reason) throw new HttpError(409, "Save a problem label on this AI reply before reviewing its learned sources.", undefined, "learning-review-label");
  const provenance = await storage.get<StoredProvenance>(provenanceKey(record.id, message));
  const reply = await readMessage(storage, record.id, message);
  let sources: string[] = [];
  if (reply?.revision === 1 && provenance?.v === 1 && provenance.kind === "reply" && provenance.case === read.seq &&
      provenance.author === author && provenance.at === createdAt && provenance.ai) {
    try {
      sources = checkedProvenance(provenance.ai).sources
        .map((source) => source.id)
        .filter((id) => /^(?:kb\.[a-f0-9]{24}|kb:kb-[a-f0-9]{16}-[1-9][0-9]{0,2})$/.test(id));
    } catch { /* A malformed historical receipt conveys no source authority. */ }
  }
  const actor = { ...knowledgeActor(viewer), learningCorrectionAuthorized: true as const };
  const args = { sources, replyAt: createdAt };
  if (context.body.action === "pause-learned-source") {
    if (!viewer.admin) throw new HttpError(403, "Ask a workspace Admin to pause learned knowledge.", undefined, "admin-only");
    requireWorkspaceAdminHeaders(context.headers, viewer.manager, context.body.confirmed, context.now);
    const result = await knowledgeCall<{ paused: true; sourceId: string; pausedAt: string; source: LearnedFaqCorrectionSource }>(env, context.room, "knowledge.learning.quarantine", actor, {
      ...args, id: context.body.sourceId, ifUpdatedAt: context.body.ifUpdatedAt,
      ifGeneration: context.body.ifGeneration, reason,
    });
    context.pendingAudit.push({ actor: viewer.principal, action: "support.settings", target: record.id,
      after: { op: "pause-learned-faq", caseSeq: read.seq, message, sourceId: result.sourceId, sourceUpdatedAt: context.body.ifUpdatedAt } });
    return { canPause: true, sources: [result.source] };
  }
  const result = await knowledgeCall<{ sources: LearnedFaqCorrectionSource[] }>(env, context.room, "knowledge.learning.corrections", actor, args);
  return { canPause: viewer.admin, sources: result.sources };
}
