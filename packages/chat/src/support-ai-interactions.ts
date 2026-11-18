/** Shared, deterministic checks for the optional hosted answer workflow. */
export const AI_INTERACTION_POLICY = "bounded-v1" as const;
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
