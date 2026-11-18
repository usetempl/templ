/** Shared FAQ-number proof. Callers supply only current, authorized native
 * sources; a title or source ID supplied by an answer grants no evidence. */
import type { CitationCheck } from "./support-citations";
import type { SupportAiProvenance } from "./support-drafts";
export type FaqCitationSource = {
  sourceId: string; kind: string; era: string; visibility: string;
  title: string; excerpt: string; archivedAt?: unknown; url?: unknown;
};
export async function proveFaqCitationsFromSources(check: CitationCheck, provenance: SupportAiProvenance | null, hits: readonly FaqCitationSource[]): Promise<CitationCheck> {
  const sources = provenance?.sources ?? [];
  if (!provenance || !["answer", "draft"].includes(provenance.reason) || !sources.length ||
      sources.some(source => source.kind !== "doc" || source.url || !/^kb\.[0-9a-f]{24}$/.test(source.id)) ||
      !check.problems.some(problem => problem.kind === "uncited-figure")) return check;
  const known = new Map<string, FaqCitationSource>();
  for (const hit of hits) {
    if (hit.kind !== "faq" || hit.era !== "current" || hit.visibility !== "member-safe" || hit.archivedAt || hit.url) continue;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hit.sourceId)));
    const id = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
    known.set(`kb.${id}`, hit);
  }
  if (sources.some(source => known.get(source.id)?.title.slice(0, 120) !== source.title)) return check;
  const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim());
  const approved = new Set(sources.flatMap(source => sentences(known.get(source.id)!.excerpt)));
  const said = sentences(check.text);
  const problems = check.problems.filter(problem => problem.kind !== "uncited-figure" || !approved.has(said[problem.sentence - 1]));
  return {...check, problems, ok: problems.length === 0};
}
