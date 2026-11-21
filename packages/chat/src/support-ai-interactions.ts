/** Shared, deterministic checks for the optional hosted answer workflow. */
export const AI_INTERACTION_POLICY = "bounded-v1" as const;
export const HOSTED_SOCIAL_REPLIES = Object.freeze({
  thanks: "You're welcome.",
  smallTalk: "I'm here to help. What can I help you with?",
  offTopic: "I can help with questions about this app. What would you like to know?",
});
export type AiInteraction = {
  policy: typeof AI_INTERACTION_POLICY;
  kind: "answer" | "clarify" | "faq";
  knowledgeVersion: string;
};
export function checkedAiInteraction(value: unknown): AiInteraction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join() === "kind,knowledgeVersion,policy" &&
    row.policy === AI_INTERACTION_POLICY &&
    ["answer", "clarify", "faq"].includes(String(row.kind)) &&
    typeof row.knowledgeVersion === "string" && /^[a-f0-9]{64}$/.test(row.knowledgeVersion)
    ? row as AiInteraction : null;
}
export const normalizeFaqQuestion = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[?!.]+$/, "");
/** A clarification asks for one detail; it cannot add a claim, link or step. */
export function isBoundedClarification(text: unknown): text is string {
  return typeof text === "string" && new TextEncoder().encode(text).byteLength <= 300 &&
    /^(?:what|which|where|when|how|did|does|do|is|are|can|could|would|have|has|was|were)\b/i.test(text) &&
    text.endsWith("?") && (text.match(/\?/g) ?? []).length === 1 &&
    !/\b(?:seeds?|recovery|private|passwords?|passcodes?|credentials?|signature|approve|approval)\b/i.test(text) &&
    !/[\n.!;:]|https?:|www\.|\b0x[0-9a-f]+\b|\d/i.test(text);
}
