/** A learner may append only to its workspace's own Learned FAQ collection.
 * Original sources are never edited or retired. Conflicts create private
 * review entries and revision-bound warnings on the original source. */
import { checkedHandoffLearningResult, type HandoffLearningEntry, type LearnedFaqCorrectionSource } from "@templ/chat/support-learning";
import { asksForSecret, screenTeamText } from "@templ/chat/support-safety";
import { detectStoredSecret } from "./secret-guard";
import type { StorageUploadGrant } from "./brain-storage";
import { addSource, readKnowledgeContext, removeSource, sourceRow } from "./support-knowledge-kb";
import { genericText } from "./support-knowledge-telegram";
import { KnowledgeError, randomHex, readMeta, sha256Hex, writeMeta, type KnowledgeDb } from "./support-knowledge-schema";
import type { KnowledgeActor } from "./support-knowledge";

export type { HandoffLearningEntry } from "@templ/chat/support-learning";
export const KNOWLEDGE_LEARNING_LIMITS = { facts: 200, receipts: 2_000, provenancePerFact: 200 } as const;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE = /^kb-[a-f0-9]{16}$/;
const ROOT = "knowledge.learning.collection";
const OWNED = "knowledge.learning.source:";
const FACT = "knowledge.learning.fact:";
const RECEIPT = "knowledge.learning.receipt:";
const WARNINGS = "knowledge.learning.conflicts:";
const FORGOTTEN = "knowledge.learning.forgotten:";
// Room learning jobs expire after 24 hours. Keep deletion fences for twice
// that lifetime without keeping per-case provenance indefinitely.
const FORGOTTEN_LIFETIME = 2 * 86_400_000;
type LearnedOwner = {
  kind: "entry";
  parentId: string;
  reviewRequired: boolean;
  generatedUpdatedAt: string;
  factHash: string;
  sourceTokens: string[];
  conflicts: HandoffLearningEntry["conflicts"];
  paused?: { at: string; reason: string; sourceUpdatedAt: string; by: string };
};
type Warning = { entryId: string; quote: string; reason: string; sourceUpdatedAt: string; sourceGeneration: string | null };
export type KnowledgeLearningResult = {
  operationId: string;
  recordedAt: string;
  collectionId: string | null;
  entries: { sourceId: string; updatedAt: string; reviewRequired: boolean; deduplicated: boolean }[];
};
function invalid(): never {
  throw new KnowledgeError(400, "knowledge-learning-invalid", "Use valid learned FAQ entries.");
}
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).sort().join() === [...fields].sort().join();
const normalize = (value: string) => value.normalize("NFC").trim();
const factText = (value: string) => normalize(value).replace(/\s+/g, " ");
function jsonMeta<T>(db: KnowledgeDb, key: string): T | null {
  try { return JSON.parse(readMeta(db, key) ?? "null") as T | null; }
  catch { return null; }
}
function countMeta(db: KnowledgeDb, prefix: string): number {
  return Number(db.sql.exec("SELECT COUNT(*) AS n FROM meta WHERE key >= ? AND key < ?", prefix, prefix.slice(0, -1) + ";").toArray()[0]?.n ?? 0);
}
function capacity(): never {
  throw new KnowledgeError(409, "knowledge-learning-capacity", "The Learned FAQ reached its limit. Existing knowledge was kept.");
}
function pruneForgotten(db: KnowledgeDb, now: number) {
  for (const row of db.sql.exec("SELECT key, value FROM meta WHERE key >= ? AND key < ?", FORGOTTEN, FORGOTTEN.slice(0, -1) + ";").toArray()) {
    const at = Number(row.value);
    if (Number.isSafeInteger(at) && now - at >= FORGOTTEN_LIFETIME)
      db.sql.exec("DELETE FROM meta WHERE key = ?", String(row.key));
  }
}
function authority(actor: KnowledgeActor) {
  if (actor.learningAuthorized !== true || !["staff", "bot"].includes(actor.role))
    throw new KnowledgeError(403, "knowledge-learning-authority", "This knowledge change needs a current human handoff answer.");
}

/** Normalizes the canonical payload, then screens every field for private details. */
export function checkedLearningEntries(value: unknown): HandoffLearningEntry[] {
  if (!checkedHandoffLearningResult({ entries: value })) invalid();
  return (value as HandoffLearningEntry[]).map((entry) => {
    const normalized: HandoffLearningEntry = {
      question: normalize(entry.question), answer: normalize(entry.answer),
      conflicts: entry.conflicts.map((conflict) => ({
        sourceId: conflict.sourceId, updatedAt: conflict.updatedAt,
        quote: normalize(conflict.quote), reason: normalize(conflict.reason),
      })),
    };
    for (const field of [normalized.question, normalized.answer, ...normalized.conflicts.flatMap((conflict) => [conflict.quote, conflict.reason])]) {
      try { genericText(field); }
      catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        throw new KnowledgeError(422, "knowledge-learning-private", "Use general product facts without private case details.");
      }
      if (asksForSecret(field) || screenTeamText(field))
        throw new KnowledgeError(422, "knowledge-learning-unsafe", "Learned knowledge cannot request secrets, signatures or transactions.");
    }
    return normalized;
  });
}
export async function learningPayloadHash(value: { sourceToken: string; entries: unknown; expectedKnowledgeVersion?: unknown }): Promise<string> {
  if (!HASH.test(value.sourceToken)) invalid();
  const entries = checkedLearningEntries(value.entries);
  if ((entries.length > 0 || value.expectedKnowledgeVersion !== undefined) &&
    (typeof value.expectedKnowledgeVersion !== "string" || !HASH.test(value.expectedKnowledgeVersion))) invalid();
  return sha256Hex(JSON.stringify({ sourceToken: value.sourceToken, expectedKnowledgeVersion: value.expectedKnowledgeVersion ?? null, entries }));
}
/** Every content replacement advances its per-source generation, including
 * replacements made within the same millisecond. Keep this snapshot across
 * the asynchronous version hash so a concurrent source write cannot slip in. */
function sourceSnapshot(db: KnowledgeDb): string {
  return JSON.stringify(db.sql.exec("SELECT s.*, (SELECT value FROM meta WHERE key = 'knowledge.context.source:' || s.id) AS generation FROM kb_sources s ORDER BY s.id").toArray());
}
function collection(db: KnowledgeDb, now: number): string {
  const id = readMeta(db, ROOT);
  if (id && SOURCE.test(id) && sourceRow(db, id)?.origin === "learning") return id;
  const source = addSource(db, { kind: "faq", title: "Learned FAQ", text: "General product facts confirmed by the team in support answers.", visibility: "staff-only" }, now);
  db.sql.exec("UPDATE kb_sources SET origin = 'learning' WHERE id = ?", source.id);
  writeMeta(db, ROOT, source.id);
  writeMeta(db, OWNED + source.id, JSON.stringify({ kind: "collection", reviewRequired: false }));
  return source.id;
}
function validateConflicts(db: KnowledgeDb, entries: HandoffLearningEntry[]) {
  for (const entry of entries) for (const conflict of entry.conflicts) {
    const source = sourceRow(db, conflict.sourceId);
    const text = db.sql.exec("SELECT text FROM kb_chunks WHERE source_id = ? ORDER BY seq", conflict.sourceId).toArray().map((row) => String(row.text)).join("\n\n");
    if (!source || source.era !== "current" || source.visibility !== "member-safe" || source.status !== "ready" || source.archived_at !== null ||
      new Date(source.updated_at).toISOString() !== conflict.updatedAt || !text.includes(conflict.quote))
      throw new KnowledgeError(409, "knowledge-learning-stale-source", "A conflicting source changed. Read the current knowledge before learning this answer.");
  }
}
function warnings(db: KnowledgeDb, id: string): Warning[] {
  const value = jsonMeta<Warning[]>(db, WARNINGS + id);
  return Array.isArray(value) ? value : [];
}

const CORRECTION_REASONS = ["wrong-facts", "wrong-product", "wrong-metric-or-window", "unsupported-claim", "unsafe"];
function correctionAuthority(actor: KnowledgeActor, write = false) {
  if (actor.learningCorrectionAuthorized !== true || actor.role === "bot" ||
    (write && actor.role !== "manager" && actor.workspaceAdmin !== true))
    throw new KnowledgeError(403, "knowledge-learning-correction-authority", "Ask a workspace Admin to review learned knowledge.");
}
function correctionInput(args: Record<string, unknown>) {
  if (!Array.isArray(args.sources) || args.sources.length > 8 ||
      !args.sources.every((id) => typeof id === "string" && /^(?:kb\.[a-f0-9]{24}|kb:kb-[a-f0-9]{16}-[1-9][0-9]{0,2})$/.test(id)) ||
      !Number.isSafeInteger(args.replyAt) || Number(args.replyAt) < 0) invalid();
  return { sources: new Set(args.sources as string[]), replyAt: Number(args.replyAt) };
}
/** The room supplies saved reply provenance, never a caller-selected source.
 * Admin-edited facts need ordinary source review; an old reply cannot pause
 * newer knowledge through this shortcut. No private case text is retained. */
export async function learnedReplyCorrectionSources(
  db: KnowledgeDb, actor: KnowledgeActor, args: Record<string, unknown>,
): Promise<{ sources: LearnedFaqCorrectionSource[] }> {
  correctionAuthority(actor);
  if (!exact(args, ["sources", "replyAt"])) invalid();
  const input = correctionInput(args), sources: LearnedFaqCorrectionSource[] = [];
  if (!input.sources.size) return { sources };
  const rows = db.sql.exec("SELECT c.id AS chunk_id, s.id AS source_id FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE s.origin = 'learning' AND s.parent IS NOT NULL ORDER BY s.id, c.seq").toArray();
  const matched = new Set<string>();
  for (const row of rows) {
    const chunk = `kb:${row.chunk_id}`;
    if (input.sources.has(chunk) || input.sources.has(`kb.${(await sha256Hex(chunk)).slice(0, 24)}`)) matched.add(String(row.source_id));
  }
  for (const id of matched) {
    const row = sourceRow(db, id), owner = jsonMeta<LearnedOwner>(db, OWNED + id);
    if (!row || owner?.kind !== "entry" || row.origin !== "learning" || row.kind !== "faq" ||
        row.era !== "current" || row.archived_at !== null || row.status !== "ready" ||
        new Date(row.updated_at).toISOString() !== owner.generatedUpdatedAt ||
        (!owner.paused && row.updated_at > input.replyAt)) continue;
    const generation = readMeta(db, "knowledge.context.source:" + id);
    if (!generation || !/^[a-f0-9]{32}$/.test(generation)) continue;
    sources.push({ id, title: row.title, updatedAt: new Date(row.updated_at).toISOString(), generation,
      pausedAt: owner.paused?.sourceUpdatedAt === owner.generatedUpdatedAt && row.visibility === "staff-only" ? owner.paused.at : null });
  }
  return { sources };
}

/** Pause only the exact automatic entry reviewed from a labeled AI reply.
 * Visibility changes immediately invalidate member retrieval/context versions.
 * Original text, source provenance and privacy-deletion eligibility survive. */
export async function quarantineLearnedReplySource(
  db: KnowledgeDb, actor: KnowledgeActor, args: Record<string, unknown>, now: number,
): Promise<{ paused: true; sourceId: string; pausedAt: string; source: LearnedFaqCorrectionSource }> {
  correctionAuthority(actor, true);
  if (!exact(args, ["sources", "replyAt", "id", "ifUpdatedAt", "ifGeneration", "reason"]) ||
      typeof args.id !== "string" || !SOURCE.test(args.id) ||
      typeof args.ifUpdatedAt !== "string" || typeof args.ifGeneration !== "string" ||
      !CORRECTION_REASONS.includes(String(args.reason)) || !Number.isSafeInteger(now)) invalid();
  const preview = await learnedReplyCorrectionSources(db, actor, { sources: args.sources, replyAt: args.replyAt });
  const source = preview.sources.find((entry) => entry.id === args.id);
  return db.transaction(() => {
    const row = sourceRow(db, String(args.id)), owner = jsonMeta<LearnedOwner>(db, OWNED + args.id);
    if (!source || !row || owner?.kind !== "entry" || source.updatedAt !== args.ifUpdatedAt || source.generation !== args.ifGeneration ||
        new Date(row.updated_at).toISOString() !== args.ifUpdatedAt || readMeta(db, "knowledge.context.source:" + args.id) !== args.ifGeneration)
      throw new KnowledgeError(409, "knowledge-learning-correction-stale", "This learned answer changed. Review it again before pausing it.");
    if (source.pausedAt) return { paused: true, sourceId: source.id, pausedAt: source.pausedAt, source };
    const updatedAt = new Date(Math.max(now, row.updated_at + 1)).toISOString();
    const generation = randomHex(16);
    db.sql.exec("UPDATE kb_sources SET visibility = 'staff-only', updated_at = ? WHERE id = ?", Date.parse(updatedAt), source.id);
    writeMeta(db, "knowledge.context.source:" + source.id, generation);
    owner.reviewRequired = true;
    owner.generatedUpdatedAt = updatedAt;
    owner.paused = { at: new Date(now).toISOString(), reason: String(args.reason), sourceUpdatedAt: updatedAt, by: actor.principal };
    writeMeta(db, OWNED + source.id, JSON.stringify(owner));
    return { paused: true, sourceId: source.id, pausedAt: owner.paused.at,
      source: { ...source, updatedAt, generation, pausedAt: owner.paused.at } };
  });
}

export async function learningKnowledgeOperation(
  db: KnowledgeDb, actor: KnowledgeActor, args: Record<string, unknown>, now: number,
): Promise<KnowledgeLearningResult> {
  authority(actor);
  if (!exact(args, ["operationId", "payloadHash", "sourceToken", "entries", ...(args.expectedKnowledgeVersion === undefined ? [] : ["expectedKnowledgeVersion"]), ...(args.storageGrant === undefined ? [] : ["storageGrant"])]) ||
    typeof args.operationId !== "string" || !HASH.test(args.operationId) ||
    typeof args.payloadHash !== "string" || !HASH.test(args.payloadHash) ||
    typeof args.sourceToken !== "string" || !HASH.test(args.sourceToken) || !Number.isSafeInteger(now)) invalid();
  const sourceToken = args.sourceToken, entries = checkedLearningEntries(args.entries);
  const payloadHash = await learningPayloadHash({ sourceToken, expectedKnowledgeVersion: args.expectedKnowledgeVersion, entries });
  if (payloadHash !== args.payloadHash)
    throw new KnowledgeError(409, "knowledge-learning-hash", "The learned FAQ does not match its saved content.");
  for (const entry of entries) for (const field of [entry.question, entry.answer, ...entry.conflicts.flatMap((conflict) => [conflict.quote, conflict.reason])])
    if (await detectStoredSecret(field))
      throw new KnowledgeError(422, "knowledge-learning-secret", "Learned knowledge cannot contain secrets.");
  const fingerprints = await Promise.all(entries.map((entry) => sha256Hex(JSON.stringify({
    question: factText(entry.question).toLowerCase(), answer: factText(entry.answer),
    // A disputed fact cannot deduplicate into an already published FAQ entry.
    conflicts: entry.conflicts.map(({ sourceId, updatedAt, quote }) => ({ sourceId, updatedAt, quote: factText(quote) })),
  }))));
  const replay = jsonMeta<{ payloadHash: string; result: KnowledgeLearningResult }>(db, RECEIPT + args.operationId);
  if (replay) {
    if (readMeta(db, FORGOTTEN + sourceToken) !== null)
      throw new KnowledgeError(410, "knowledge-learning-forgotten", "Learning from this case was removed.");
    if (replay.payloadHash !== payloadHash)
      throw new KnowledgeError(409, "knowledge-learning-reused", "This learning operation already has different content.");
    return replay.result;
  }
  const sourceState = sourceSnapshot(db);
  const currentVersion = entries.length ? (await readKnowledgeContext(db, { storageGrant: args.storageGrant as StorageUploadGrant | null, now })).version : null;
  return db.transaction(() => {
    pruneForgotten(db, now);
    if (readMeta(db, FORGOTTEN + sourceToken) !== null)
      throw new KnowledgeError(410, "knowledge-learning-forgotten", "Learning from this case was removed.");
    const previous = jsonMeta<{ payloadHash: string; result: KnowledgeLearningResult }>(db, RECEIPT + args.operationId);
    if (previous) {
      if (previous.payloadHash !== payloadHash)
        throw new KnowledgeError(409, "knowledge-learning-reused", "This learning operation already has different content.");
      return previous.result;
    }
    if (entries.length && (currentVersion !== args.expectedKnowledgeVersion || sourceSnapshot(db) !== sourceState))
      throw new KnowledgeError(409, "knowledge-learning-stale-knowledge", "Knowledge changed. Read the current sources before learning this answer.");
    if (countMeta(db, RECEIPT) >= KNOWLEDGE_LEARNING_LIMITS.receipts) capacity();
    validateConflicts(db, entries);
    let collectionId: string | null = null;
    const recorded: KnowledgeLearningResult["entries"] = [];
    entries.forEach((entry, index) => {
      const factHash = fingerprints[index], existingId = readMeta(db, FACT + factHash);
      const owner = existingId ? jsonMeta<LearnedOwner>(db, OWNED + existingId) : null;
      const existing = existingId ? sourceRow(db, existingId) : null;
      if (existing && existing.origin === "learning" && owner?.kind === "entry" && owner.factHash === factHash &&
        new Date(existing.updated_at).toISOString() === owner.generatedUpdatedAt) {
        if (!owner.sourceTokens.includes(sourceToken)) {
          if (owner.sourceTokens.length >= KNOWLEDGE_LEARNING_LIMITS.provenancePerFact) capacity();
          owner.sourceTokens.push(sourceToken);
          writeMeta(db, OWNED + existing.id, JSON.stringify(owner));
        }
        collectionId = owner.parentId;
        recorded.push({ sourceId: existing.id, updatedAt: owner.generatedUpdatedAt, reviewRequired: owner.reviewRequired, deduplicated: true });
        return;
      }
      const facts = Number(db.sql.exec("SELECT COUNT(*) AS n FROM kb_sources WHERE origin = 'learning' AND parent IS NOT NULL").toArray()[0]?.n ?? 0);
      if (facts >= KNOWLEDGE_LEARNING_LIMITS.facts) capacity();
      collectionId ??= collection(db, now);
      const reviewRequired = entry.conflicts.length > 0;
      const source = addSource(db, {
        kind: "faq", title: entry.question, text: entry.answer, parent: collectionId,
        visibility: reviewRequired ? "staff-only" : "member-safe",
      }, now);
      db.sql.exec("UPDATE kb_sources SET origin = 'learning' WHERE id = ?", source.id);
      const owned: LearnedOwner = { kind: "entry", parentId: collectionId, reviewRequired, generatedUpdatedAt: source.updatedAt, factHash, sourceTokens: [sourceToken], conflicts: entry.conflicts };
      writeMeta(db, OWNED + source.id, JSON.stringify(owned));
      writeMeta(db, FACT + factHash, source.id);
      for (const conflict of entry.conflicts) {
        const sourceGeneration = readMeta(db, "knowledge.context.source:" + conflict.sourceId);
        const current = warnings(db, conflict.sourceId).filter((warning) => warning.sourceUpdatedAt === conflict.updatedAt && warning.sourceGeneration === sourceGeneration);
        if (!current.some((warning) => warning.entryId === source.id && warning.quote === conflict.quote))
          current.push({ entryId: source.id, quote: conflict.quote, reason: conflict.reason, sourceUpdatedAt: conflict.updatedAt, sourceGeneration });
        writeMeta(db, WARNINGS + conflict.sourceId, JSON.stringify(current));
      }
      recorded.push({ sourceId: source.id, updatedAt: source.updatedAt, reviewRequired, deduplicated: false });
    });
    const result: KnowledgeLearningResult = { operationId: String(args.operationId), recordedAt: new Date(now).toISOString(), collectionId, entries: recorded };
    writeMeta(db, RECEIPT + args.operationId, JSON.stringify({ payloadHash, sourceToken, result }));
    return result;
  });
}

/** A case privacy/deletion request removes only untouched automatic content.
 * An Admin's later edit is preserved, and shared facts retain other origins. */
export function forgetLearningKnowledge(
  db: KnowledgeDb, actor: KnowledgeActor, args: Record<string, unknown>, now: number,
): { forgotten: true; removed: number; retained: number } {
  authority(actor);
  if (!exact(args, ["sourceToken"]) || typeof args.sourceToken !== "string" || !HASH.test(args.sourceToken) || !Number.isSafeInteger(now)) invalid();
  const sourceToken = args.sourceToken;
  return db.transaction(() => {
    pruneForgotten(db, now);
    writeMeta(db, FORGOTTEN + sourceToken, String(now));
    let removed = 0, retained = 0;
    const rows = db.sql.exec("SELECT key, value FROM meta WHERE key >= ? AND key < ?", OWNED, OWNED.slice(0, -1) + ";").toArray();
    for (const row of rows) {
      const id = String(row.key).slice(OWNED.length), owner = jsonMeta<LearnedOwner>(db, String(row.key));
      if (owner?.kind !== "entry" || !owner.sourceTokens.includes(sourceToken)) continue;
      owner.sourceTokens = owner.sourceTokens.filter((token) => token !== sourceToken);
      const source = sourceRow(db, id);
      if (owner.sourceTokens.length || (source && (source.origin !== "learning" || new Date(source.updated_at).toISOString() !== owner.generatedUpdatedAt))) {
        retained++;
        writeMeta(db, OWNED + id, JSON.stringify(owner));
        continue;
      }
      if (source) { removeSource(db, { id }); removed++; }
      db.sql.exec("DELETE FROM meta WHERE key = ?", OWNED + id);
      if (readMeta(db, FACT + owner.factHash) === id) db.sql.exec("DELETE FROM meta WHERE key = ?", FACT + owner.factHash);
      for (const conflict of owner.conflicts) {
        const current = warnings(db, conflict.sourceId).filter((warning) => warning.entryId !== id);
        if (current.length) writeMeta(db, WARNINGS + conflict.sourceId, JSON.stringify(current));
        else db.sql.exec("DELETE FROM meta WHERE key = ?", WARNINGS + conflict.sourceId);
      }
    }
    // Receipts contain no case text, but their opaque provenance is no longer needed.
    for (const row of db.sql.exec("SELECT key, value FROM meta WHERE key >= ? AND key < ?", RECEIPT, RECEIPT.slice(0, -1) + ";").toArray()) {
      const receipt = jsonMeta<{ sourceToken?: string }>(db, String(row.key));
      if (receipt?.sourceToken === sourceToken) db.sql.exec("DELETE FROM meta WHERE key = ?", String(row.key));
    }
    return { forgotten: true, removed, retained };
  });
}
