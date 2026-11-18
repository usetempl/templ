import { checkedWorkspaceAiGuidance, type WorkspaceAiGuidance } from "@templ/chat/knowledge";
import { detectStoredSecret } from "./secret-guard";
import { KnowledgeError, readMeta, type KnowledgeDb } from "./support-knowledge-schema";

export const AI_GUIDANCE_KEY = "ai-guidance";

/** Read only this bound workspace's validated manager guidance. */
export async function readWorkspaceAiGuidance(
  db: KnowledgeDb,
  room?: string,
): Promise<WorkspaceAiGuidance> {
  if (room !== undefined && readMeta(db, "room") !== room)
    throw new KnowledgeError(503, "guidance-unavailable", "AI guidance is unavailable. Try again later.");
  const raw = readMeta(db, AI_GUIDANCE_KEY);
  if (raw === null) return { text: "", revision: 0 };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (!checkedWorkspaceAiGuidance(value) || await detectStoredSecret(value.text))
    throw new KnowledgeError(503, "guidance-unavailable", "AI guidance is unavailable. Try again later.");
  return value;
}
