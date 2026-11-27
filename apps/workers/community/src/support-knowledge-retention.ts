/** What the room's retention sweep does for answer quality and eval
 * copies (called from support-retention.ts).
 *
 * - Before a thread's rows go: the eval copies saved from it lose their
 *   link (once per thread; a failure never holds the deletion, and the
 *   lead's eval list clears a stale link later), then the thread's quality
 *   records with their review queue and reported-answer rows go, a bounded
 *   number per call.
 * - Every eval copy, run and import in the workspace's SupportKnowledge
 *   object, the protocol profile and the knowledge base go with the
 *   workspace when it is deleted. */
import type { RetentionHolds } from "./safety";
import {
  knowledgeCall,
  type KnowledgeEnv,
} from "./support-knowledge-client";
import {
  QUALITY_PREFIX,
  REVIEW_QUEUE_PREFIX,
  answerReportKey,
  checkedQuality,
  storedAnswerReports,
} from "./support-quality";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
export type KnowledgeRetention = {
  /** Clears the source link of the thread's eval copies. */
  unlink(room: string, thread: string): Promise<void>;
};
/** The thread whose eval copies were last unlinked. */
export const KNOWLEDGE_UNLINKED_KEY = "support-knowledge-unlinked-v1";
const THREAD = /^tc-[0-9a-f]{32}$/;
const RETENTION_ACTOR = { principal: "retention", role: "staff" } as const;

export function knowledgeRetention(env: KnowledgeEnv): KnowledgeRetention {
  return {
    async unlink(room, thread) {
      // Without the object there is nothing to unlink; the call's 503 is
      // caught by the sweep like any other failure.
      await knowledgeCall(env, room, "evals.unlink", RETENTION_ACTOR, {
        threads: [thread],
      });
    },
  };
}

/** Deletes a thread's quality records with their review queue and
 * reported-answer rows, at most `budget` keys. Returns the keys deleted; the
 * sweep calls again while it returns more than zero. */
export async function deleteThreadQuality(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  if (!THREAD.test(thread) || budget <= 0) return 0;
  const rows = await storage.list<unknown>({
    prefix: `${QUALITY_PREFIX}${thread}:`,
    limit: budget,
  });
  let deleted = 0;
  for (const [key, raw] of rows) {
    const seqText = key.slice(key.lastIndexOf(":") + 1);
    const seq = Number(seqText);
    const q = /^[0-9]{8}$/.test(seqText)
      ? checkedQuality(raw, thread, seq)
      : null;
    for (const report of storedAnswerReports(q)) {
      if (await storage.delete(answerReportKey(thread, seq, report))) deleted++;
      if (deleted >= budget) return deleted;
    }
    if (q?.review) {
      const queue = `${REVIEW_QUEUE_PREFIX}${String(q.review.sampledAt).padStart(16, "0")}:${thread}:${seqText}`;
      if (await storage.delete(queue)) deleted++;
      if (deleted >= budget) return deleted;
    }
    // The key itself, readable or not, so the sweep always moves on.
    if (await storage.delete(key)) deleted++;
    if (deleted >= budget) return deleted;
  }
  return deleted;
}

/** Runs before the pending thread's rows go, after the hold recheck. */
export async function retainThreadQuality(
  storage: Storage,
  thread: string,
  budget: number,
  knowledge: KnowledgeRetention | undefined,
): Promise<number> {
  if (knowledge && (await storage.get(KNOWLEDGE_UNLINKED_KEY)) !== thread) {
    const record = await storage.get<{ room?: unknown }>(
      `conversation-v1:${thread}`,
    );
    if (typeof record?.room === "string")
      await knowledge.unlink(record.room, thread).catch(() =>
        console.warn(
          JSON.stringify({ event: "TEMPL_SUPPORT_EVAL_UNLINK_FAILED" }),
        ),
      );
    await storage.put(KNOWLEDGE_UNLINKED_KEY, thread);
  }
  return deleteThreadQuality(storage, thread, budget);
}

