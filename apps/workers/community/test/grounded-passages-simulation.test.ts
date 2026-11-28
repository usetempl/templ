import { expect, it } from "vitest";
import { groundedPassages } from "../src/managed-agent/grounded";
import { addSource, recordFetch } from "../src/support-knowledge-kb";
import { ensureSchema } from "../src/support-knowledge-schema";
import { knowledgeTestDb } from "./knowledge-sqlite";

const BOUND = 60 * 1024;
const START = Date.UTC(2026, 10, 27, 12);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

it("keeps desk FAQs available beside matching manuals when a translated question shares no search terms", async () => {
  const db = knowledgeTestDb();
  ensureSchema(db, START);
  try {
    const faqs = Array.from({ length: 52 }, (_, i) => {
      const { id } = addSource(db, { kind: "faq", title: `Short member answer ${i}`, text: `Self-custody guide topic ${i}. The member keeps the account keys.` }, START);
      return `kb:${id}-1`;
    });
    const hidden = addSource(db, { kind: "faq", title: "Private exception", text: "Team answer.", visibility: "staff-only" }, START);
    for (let i = 0; i < 32; i++) {
      const { id } = addSource(db, { kind: "doc", url: `https://help.example/manual-${i}` }, START);
      const text = Array.from({ length: 8 }, (_, j) => (`Rollup settlement manual ${i}, section ${j}, includes finality and operator conditions. `).repeat(10)).join("\n\n");
      recordFetch(db, id, { kind: "text", title: `Rollup settlement ${i}`, text, etag: null, sha256: (i + 1).toString(16).padStart(64, "0") }, START);
    }
    const neighbor = await groundedPassages(db, null, START, "rollup settlement manual");
    expect(neighbor.hits.filter(hit => hit.kind === "faq").length).toBeLessThan(faqs.length);
    for (const question of ["rollup settlement manual", "ما المقصود بالحفظ الذاتي؟", "手数料の仕組みは？"]) {
      const context = await groundedPassages(db, null, START, question, true);
      const selected = new Set(context.hits.map(hit => hit.sourceId));
      expect(faqs.every(id => selected.has(id))).toBe(true);
      expect(selected.has(`kb:${hidden.id}-1`)).toBe(false);
      expect(context.hits.some(hit => hit.kind === "doc")).toBe(true);
      expect(context.version).toBe(neighbor.version);
      expect(bytes(context.hits)).toBeLessThanOrEqual(BOUND);
    }
  } finally {
    db.raw.close();
  }
});
