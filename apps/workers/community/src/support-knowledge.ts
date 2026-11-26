import { websiteUrl } from "./website-brand";
import { telegramKnowledgeOperation } from "./support-knowledge-telegram";
import { learningKnowledgeOperation, forgetLearningKnowledge, learnedReplyCorrectionSources, quarantineLearnedReplySource } from "./support-knowledge-learning";
import { queueKnowledgeResources } from "./workspace-resource-observations";
import { type StorageUploadGrant, advanceBrainStorage, authorizeStorageBilling, brainStorageView, stopStorageBilling, storageBillingSnapshot, syncBrainStorageBytes } from "./brain-storage";
import { featureOn, workspaceFeatureEnvFor, type WorkspaceFlagEnv } from "./workspace-flags";// Screened knowledge file imports.
// Imported files use the source and chunk store after the room checks editing access.
import { knowledgeImport } from "./knowledge-import";
import { detectStoredSecret } from "./secret-guard";
/** SupportKnowledge: one SQLite Durable Object per workspace for the eval
 * store, the protocol profile and the knowledge base.
 *
 * Reachability: only the workspace's room object calls it, through
 * `knowledgeCall` (support-knowledge-client.ts) with the id
 * `knowledge:<room>`. The public fetch handler has no path to this binding.
 * The room has already checked the caller's current access; this object
 * keeps the actor only for `updated_by` fields and never re-derives
 * authority. It binds itself to the first room that calls it and refuses
 * any other.
 *
 * Its own alarm runs retention once a day, applies scheduled registry
 * syncs and refreshes docs pages that are due (a few per run). */
import {
  checkedEvalRunInput,
  type EvalOrigin,
} from "@templ/chat/support-eval";
import { KNOWLEDGE_LIMITS } from "@templ/chat/protocol-profile";
import { checkedWorkspaceAiGuidance } from "@templ/chat/knowledge";
import { AI_GUIDANCE_KEY, readWorkspaceAiGuidance } from "./support-knowledge-guidance";
import {
  checkedRegistryUrl,
  checkedPageUrl,
  fetchPage,
  fetchRegistry,
  fetchSitemap,
  REGISTRY_REASON_TEXT,
  type IngestDependencies,
} from "./knowledge-ingest";
import {
  deleteEval,
  deleteEvalsBySource,
  evalCounts,
  evalLinks,
  evalRetention,
  evalsBySource,
  exportEvals,
  getEval,
  getEvalRun,
  importEvals,
  listEvalRuns,
  listEvals,
  postEvalRun,
  purgeEvals,
  saveEval,
  unlinkEvals,
  updateEval,
} from "./support-knowledge-evals";
import {
  addSource,
  dueSources,
  getSource,
  getFaq,
  listSources,
  nextDue,
  queryKnowledgeBase,
  readKnowledgeContext,
  recordFetch,
  removeSource,
  sourceRow,
  sourceVisibilities,
  updateSource,
  type KnowledgeQueryArgs,
} from "./support-knowledge-kb";
import {
  addImportRows,
  applyImport,
  applyRegistryRows,
  deleteProfileEntry,
  getProfileAbi,
  listMetrics,
  listProfile,
  logSync,
  lookupProfile,
  previewImport,
  profileRetention,
  profileSettings,
  profileSlice,
  putProfileAbi,
  readRegistry,
  registryRows,
  setProfileSettings,
  startImport,
  syncLog,
  upsertProfileEntry,
  writeMetric,
  writeRegistry,
} from "./support-knowledge-profile";
import {
  corpusOperation,
  corpusReadRequest,
  corpusRetention,
} from "./support-knowledge-corpus";
import {
  managedAlarm,
  managedKnowledgeFetch,
  type ManagedKnowledgeEnv,
} from "./managed-agent/knowledge-hooks";
import {
  DAY_MS,
  KnowledgeError,
  ensureSchema,
  purgeAll,
  readMeta,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "./support-knowledge-schema";

export type KnowledgeActor = {
  principal: string;
  role: "manager" | "lead" | "staff" | "bot";
  workspaceAdmin?: true;
  /** Set only by the room after current Telegram connection and case checks. */
  telegramAuthorized?: true;
  /** Set only by the room after current handoff, human-answer and feature checks. */
  learningAuthorized?: true;
  /** Set by the room only after the flag, saved wrong label and reply provenance checks. */
  learningCorrectionAuthorized?: true;
};
export type KnowledgeRequest = {
  room: string;
  op: string;
  actor: KnowledgeActor;
  args: Record<string, unknown>;
};
export const KNOWLEDGE_OPS = [
  "evals.save",
  "evals.get",
  "evals.list",
  "evals.update",
  "evals.delete",
  "evals.bySource",
  "evals.deleteBySource",
  "evals.unlink",
  "evals.links",
  "evals.import",
  "evals.export",
  "evals.count",
  "evals.runs.post",
  "evals.runs.list",
  "evals.runs.get",
  "profile.get",
  "profile.settings.set",
  "profile.list",
  "profile.upsert",
  "profile.delete",
  "profile.lookup",
  "profile.slice",
  "profile.import.start",
  "profile.import.rows",
  "profile.import.preview",
  "profile.import.apply",
  "profile.registry.set",
  "profile.registry.sync",
  "profile.registry.apply",
  "profile.registry.log",
  "profile.abi.put",
  "profile.abi.get",
  "profile.metrics.list",
  "profile.metrics.write",
  "knowledge.storage.authorize",
  "knowledge.storage.stop",
  "knowledge.storage.snapshot",
  "knowledge.storage.get",
  "knowledge.guidance.get",
  "knowledge.guidance.set",
  "knowledge.list",
  "knowledge.get",
  "knowledge.add",
  "knowledge.previewSite",
  "knowledge.sitemap",
  "knowledge.update",
  "knowledge.remove",
  "knowledge.refresh",
  "knowledge.query",
  "knowledge.context",
  "knowledge.telegram",
  "knowledge.learning.apply",
  "knowledge.learning.forget",
  "knowledge.learning.corrections",
  "knowledge.learning.quarantine",
  "sources.visibility",
  "purge",
] as const;
export type KnowledgeOp = (typeof KNOWLEDGE_OPS)[number];

/** A room id as the room object names itself: `room:<workspace uuid>`,
 * lowercase. Anything else is refused before the object binds to it, so a
 * mis-addressed call can't create an empty object that answers nothing. */
const ROOM = /^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/** The next daily registry run: 03:00 UTC plus up to 30 minutes. */
function nextRegistryRun(now: number): number {
  const day = new Date(now);
  let at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 3);
  if (at <= now) at += DAY_MS;
  return at + Math.floor(Math.random() * 30 * 60_000);
}

/** Runs one registry sync and records it. Scheduled syncs have no person
 * behind them, so the sync log is their record. */
export async function runRegistrySync(
  db: KnowledgeDb,
  trigger: "manual" | "schedule",
  now: number,
  dependencies: IngestDependencies = {},
  force = false,
) {
  const registry = readRegistry(db);
  if (!registry)
    throw new KnowledgeError(404, "registry-missing", "Add your registry address first.");
  const fetched = await fetchRegistry(registry.url, force ? null : registry.etag, dependencies);
  let result;
  if (fetched.kind === "unchanged")
    result = {
      at: new Date(now).toISOString(),
      trigger,
      result: "unchanged" as const,
      added: 0,
      changed: 0,
      missing: 0,
      conflicts: 0,
    };
  else if (fetched.kind === "failed")
    result = {
      at: new Date(now).toISOString(),
      trigger,
      result: fetched.reason,
      added: 0,
      changed: 0,
      missing: 0,
      conflicts: 0,
    };
  else {
    const rows = registryRows(fetched.text, fetched.contentType);
    result = rows
      ? applyRegistryRows(db, { rows, trigger, force }, now)
      : {
          at: new Date(now).toISOString(),
          trigger,
          result: "registry-format" as const,
          added: 0,
          changed: 0,
          missing: 0,
          conflicts: 0,
        };
    if (result.result === "paused") {
      writeMeta(db, "profile.registry.pending", JSON.stringify({ text: fetched.text, contentType: fetched.contentType }));
    } else db.sql.exec("DELETE FROM meta WHERE key = 'profile.registry.pending'");
    if (result.result !== "paused" && fetched.etag) registry.etag = fetched.etag;
  }
  registry.lastSyncAt = now;
  registry.lastResult = result;
  registry.nextSyncAt = registry.schedule === "daily" ? nextRegistryRun(now + 60_000) : null;
  writeRegistry(db, registry);
  logSync(db, result, now);
  return result;
}
/** "Apply this sync": the paused file applies as it was read. */
export function applyPausedRegistry(db: KnowledgeDb, now: number) {
  const pending = readMeta(db, "profile.registry.pending");
  const registry = readRegistry(db);
  if (!pending || !registry)
    throw new KnowledgeError(409, "registry-not-paused", "There is no paused sync to apply.");
  const { text, contentType } = JSON.parse(pending) as { text: string; contentType: string };
  const rows = registryRows(text, contentType);
  if (!rows) throw new KnowledgeError(409, "registry-format", "The paused file can't be read again.");
  const result = applyRegistryRows(db, { rows, trigger: "manual", force: true }, now);
  db.sql.exec("DELETE FROM meta WHERE key = 'profile.registry.pending'");
  registry.lastResult = result;
  registry.lastSyncAt = now;
  writeRegistry(db, registry);
  logSync(db, result, now);
  return result;
}

async function refreshSource(
  db: KnowledgeDb,
  id: string,
  now: number,
  dependencies: IngestDependencies,
  includeBrand = false,
  findSuggestion = false,
) {
  const row = sourceRow(db, id);
  if (!row || row.kind !== "doc" || row.origin === "upload" || !row.url) return;
  const page = await fetchPage(row.url, includeBrand || findSuggestion ? null : row.etag, dependencies, includeBrand, findSuggestion);
  if (page.kind === "text")
    recordFetch(
      db,
      id,
      { ...page, sha256: await sha256Hex(page.text) },
      now,
    );
  else recordFetch(db, id, page, now);
  return page;
}

/** Reads the manager starts (adding a page or a sitemap, Refresh) fetch
 * at once, at most this many an hour for a workspace; past that, added
 * pages wait for the object's alarm. One page refreshes at most every ten
 * minutes by hand. */
export const MANUAL_FETCHES_PER_HOUR = 20;
const MANUAL_REFRESH_GAP_MS = 10 * 60_000;
const HOUR = 3_600_000;
function takeManualFetch(db: KnowledgeDb, now: number): boolean {
  const hour = Math.floor(now / HOUR);
  let count = 0;
  try {
    const stored = JSON.parse(readMeta(db, "manual-fetches") ?? "null") as {
      hour?: unknown;
      count?: unknown;
    } | null;
    if (stored?.hour === hour && Number.isSafeInteger(stored.count)) count = stored.count as number;
  } catch {
    count = 0;
  }
  if (count >= MANUAL_FETCHES_PER_HOUR) return false;
  writeMeta(db, "manual-fetches", JSON.stringify({ hour, count: count + 1 }));
  return true;
}
const nextHourSeconds = (now: number) =>
  Math.max(1, Math.ceil(((Math.floor(now / HOUR) + 1) * HOUR - now) / 1000));

/** Every operation, after the schema check and the room binding. */
export async function knowledgeOperation(
  db: KnowledgeDb,
  request: KnowledgeRequest,
  now: number,
  dependencies: IngestDependencies = {},
): Promise<unknown> {
  ensureSchema(db, now);
  if (typeof request.room !== "string" || !ROOM.test(request.room))
    throw new KnowledgeError(400, "knowledge-room", "Unknown workspace.");
  const bound = readMeta(db, "room");
  if (bound === null) writeMeta(db, "room", request.room);
  else if (bound !== request.room) {
    console.error("TEMPL_KNOWLEDGE_ROOM_MISMATCH");
    throw new KnowledgeError(500, "knowledge-room", "Support knowledge is unavailable.");
  }
  // The improvement copy's ops (support-knowledge-corpus.ts).
  {
    const corpus = corpusOperation(db, request, now);
    if (corpus !== undefined) return corpus;
  }
  // Store screened file rows without the upload.
  // This runs after the object has checked its bound workspace.
  const textFields = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(textFields) : [];
  const runMetadata = request.op === "evals.runs.post" && request.args.input && typeof request.args.input === "object" ? Object.fromEntries(Object.entries(request.args.input).filter(([key]) => key !== "results")) : null;
  const checkedFields = ["knowledge.add", "knowledge.previewSite", "knowledge.update"].includes(request.op)
    ? [request.args.title, request.args.text, request.args.url]
    : ["evals.save", "evals.update", "evals.import"].includes(request.op)
      ? [request.args.body, request.args.cases] : [runMetadata];
  if ((await Promise.all(textFields(checkedFields).map((value) => detectStoredSecret(value)))).some(Boolean))
    throw new KnowledgeError(422, "secret-refused", "This looks like a private key or recovery phrase, so it wasn't saved.");
  const imported = await knowledgeImport(db, request, now);
  if (imported !== undefined) return imported;
  const { args, actor } = request;
  const people = actor.role !== "bot";
  const editor = actor.role === "manager" ||
    ((actor.role === "staff" || actor.role === "lead") && actor.workspaceAdmin === true);
  if (["profile.settings.set", "profile.upsert", "profile.delete", "profile.import.start",
    "profile.import.rows", "profile.import.preview", "profile.import.apply", "profile.registry.set",
    "profile.registry.sync", "profile.registry.apply", "profile.abi.put", "profile.metrics.write"].includes(request.op) && !editor)
    throw new KnowledgeError(403, "admin-only", "Only workspace admins can change the protocol profile.");
  const by = typeof actor.principal === "string" ? actor.principal.slice(0, 80) : "unknown";
  switch (request.op as KnowledgeOp) {
    case "evals.save":
      return saveEval(
        db,
        {
          body: args.body,
          origin: (["reply-label", "review", "manual"].includes(String(args.origin))
            ? args.origin
            : "manual") as EvalOrigin,
          sourceLink: typeof args.sourceLink === "string" ? args.sourceLink : null,
          savedBy: by,
          cap: Number(args.cap) || 50,
        },
        now,
      );
    case "evals.get":
      return getEval(db, { id: args.id });
    case "evals.list":
      return listEvals(db, args);
    case "evals.update":
      return updateEval(db, { id: args.id, action: args.action, body: args.body }, now);
    case "evals.delete":
      return deleteEval(db, { id: args.id });
    case "evals.bySource":
      return evalsBySource(db, { thread: args.thread, seq: args.seq });
    case "evals.deleteBySource":
      return deleteEvalsBySource(db, { thread: args.thread });
    case "evals.unlink":
      return unlinkEvals(db, { threads: args.threads });
    case "evals.links":
      return evalLinks(db, { limit: args.limit });
    case "evals.import":
      return importEvals(db, { cases: args.cases, cap: args.cap, savedBy: by }, now);
    case "evals.export":
      return exportEvals(db, args as Parameters<typeof exportEvals>[1]);
    case "evals.count":
      return evalCounts(db);
    case "evals.runs.post": {
      const input = checkedEvalRunInput(args.input);
      if (!input)
        throw new KnowledgeError(400, "eval-run-invalid", "Send results for cases from this workspace's eval set.");
      return postEvalRun(db, { input, poster: people ? "person" : "agent" }, now);
    }
    case "evals.runs.list":
      return listEvalRuns(db, { after: args.after });
    case "evals.runs.get":
      return getEvalRun(db, { id: args.id });
    case "profile.get":
      return { ...profileSettings(db, people), log: people ? syncLog(db) : [] };
    case "profile.settings.set":
      return setProfileSettings(db, args);
    case "profile.list":
      return listProfile(db, args, people);
    case "profile.upsert":
      return upsertProfileEntry(db, { contract: args.contract }, by, now);
    case "profile.delete":
      return deleteProfileEntry(db, { network: args.network, address: args.address });
    case "profile.lookup":
      return lookupProfile(db, { refs: args.refs }, people);
    case "profile.slice":
      return profileSlice(db, { network: args.network, addresses: args.addresses });
    case "profile.import.start":
      return startImport(db, now);
    case "profile.import.rows":
      return addImportRows(db, { ...args, importId: args.importId }, now);
    case "profile.import.preview":
      return previewImport(db, { importId: args.importId, mode: args.mode }, now);
    case "profile.import.apply":
      return applyImport(db, { importId: args.importId, mode: args.mode }, by, now);
    case "profile.registry.set": {
      if (args.url === null) {
        writeRegistry(db, null);
        return { registry: null };
      }
      const url = checkedRegistryUrl(args.url);
      const schedule = args.schedule === "manual" ? "manual" : "daily";
      const current = readRegistry(db);
      writeRegistry(db, {
        url,
        schedule,
        etag: current?.url === url ? current.etag : null,
        lastSyncAt: current?.url === url ? current.lastSyncAt : null,
        lastResult: current?.url === url ? current.lastResult : null,
        nextSyncAt: schedule === "daily" ? nextRegistryRun(now) : null,
      });
      return { registry: profileSettings(db).registry };
    }
    case "profile.registry.sync": {
      const registry = readRegistry(db);
      if (
        registry?.lastSyncAt &&
        registry.lastResult?.trigger === "manual" &&
        now - registry.lastSyncAt < 3_600_000 &&
        args.force !== true
      )
        throw new KnowledgeError(429, "registry-rate", "Sync again in an hour.", {
          retryAfterSeconds: Math.ceil((registry.lastSyncAt + 3_600_000 - now) / 1000),
        });
      const result = await runRegistrySync(db, "manual", now, dependencies);
      if (result.result.startsWith("registry-"))
        throw new KnowledgeError(
          502,
          result.result,
          `Templ couldn't read the registry: ${REGISTRY_REASON_TEXT[result.result] ?? "it didn't answer"}.`,
          { result },
        );
      return { result };
    }
    case "profile.registry.apply":
      return { result: applyPausedRegistry(db, now) };
    case "profile.registry.log":
      return { log: syncLog(db) };
    case "profile.abi.put": {
      // An ABI can arrive in parts: a room request carries at most 24 KB.
      const part = args.part as
        | { id?: unknown; index?: unknown; count?: unknown; text?: unknown }
        | undefined;
      if (!part) return putProfileAbi(db, args as Parameters<typeof putProfileAbi>[1], now);
      const id = String(part.id ?? "");
      const index = Number(part.index);
      const count = Number(part.count);
      if (
        !/^[0-9a-f]{16}$/.test(id) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 16 ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= count ||
        typeof part.text !== "string"
      )
        throw new KnowledgeError(400, "profile-abi", "Upload the ABI again.");
      writeMeta(db, `abi-part:${id}:${index}`, JSON.stringify({ at: now, text: part.text }));
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const stored = readMeta(db, `abi-part:${id}:${i}`);
        if (stored === null) return { received: index + 1, count };
        parts.push((JSON.parse(stored) as { text: string }).text);
      }
      db.sql.exec("DELETE FROM meta WHERE key >= ? AND key < ?", `abi-part:${id}:`, `abi-part:${id};`);
      let abi: unknown;
      try {
        abi = JSON.parse(parts.join(""));
      } catch {
        throw new KnowledgeError(400, "profile-abi", "Upload the ABI as a JSON array.");
      }
      return putProfileAbi(db, { network: args.network, address: args.address, abi }, now);
    }
    case "profile.abi.get":
      return getProfileAbi(db, { id: args.id });
    case "profile.metrics.list":
      return listMetrics(db, people);
    case "profile.metrics.write":
      return writeMetric(db, { action: args.action, metric: args.metric }, now);
    case "knowledge.storage.authorize":
      if (actor.role !== "manager") throw new KnowledgeError(404, "knowledge-op", "Not found.");
      return authorizeStorageBilling(db, args.record as Parameters<typeof authorizeStorageBilling>[1], now);
    case "knowledge.storage.stop":
      if (actor.role !== "manager") throw new KnowledgeError(404, "knowledge-op", "Not found.");
      return stopStorageBilling(db, String(args.scope), now);
    case "knowledge.storage.snapshot":
      if (actor.role !== "manager") throw new KnowledgeError(404, "knowledge-op", "Not found.");
      return storageBillingSnapshot(db, String(args.scope), now);
    case "knowledge.storage.get":
      if (actor.role !== "manager") throw new KnowledgeError(404, "knowledge-op", "Not found.");
      return brainStorageView(db, now);
    case "knowledge.guidance.get":
      if (!editor && actor.role !== "bot")
        throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      return readWorkspaceAiGuidance(db);
    case "knowledge.guidance.set": {
      if (!editor)
        throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      if (!checkedWorkspaceAiGuidance({ text: args.text, revision: 0 }))
        throw new KnowledgeError(400, "guidance-invalid", "Use up to 4,000 characters for AI guidance.");
      const text = String(args.text).trim();
      if (await detectStoredSecret(text))
        throw new KnowledgeError(422, "secret-refused", "This looks like a private key or recovery phrase, so it wasn't saved.");
      const current = await readWorkspaceAiGuidance(db);
      if (current.revision >= Number.MAX_SAFE_INTEGER)
        throw new KnowledgeError(503, "guidance-unavailable", "AI guidance is unavailable. Try again later.");
      const value = { text, revision: current.revision + 1 };
      writeMeta(db, AI_GUIDANCE_KEY, JSON.stringify(value));
      return value;
    }
    case "knowledge.list":
      return listSources(db, {
        after: args.after,
        q: args.q,
        kind: args.kind,
        status: args.status,
      });
    case "knowledge.get":
      if (!editor) throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      return getFaq(db, args.id);
    case "knowledge.previewSite": {
      if (!editor) throw new KnowledgeError(403, "admin-only", "Access denied.");
      const url = websiteUrl(args.url);
      const previous = db.sql.exec("SELECT id FROM kb_sources WHERE url = ?", url).toArray()[0];
      const id = previous ? String(previous.id) : addSource(db, { kind: "doc", url }, now).id;
      const cached = readMeta(db, "onboarding.site.v2");
      if (cached) return JSON.parse(cached);
      if (!takeManualFetch(db, now)) throw new KnowledgeError(429, "fetch-limit", "Try again later.");
      const home = await refreshSource(db, id, now, dependencies, true);
      const scanned = home && "brand" in home ? home.brand : undefined;
      let suggestion: string | undefined;
      let ready = getSource(db, id)?.status === "ready";
      if (scanned) {
        const results = await Promise.all(scanned.docs.map(async (link) => {
          if (await detectStoredSecret(link) || !takeManualFetch(db, now)) return;
          const existing = db.sql.exec("SELECT id FROM kb_sources WHERE url = ?", link).toArray()[0];
          const docId = existing ? String(existing.id) : addSource(db, { kind: "doc", url: link }, now).id;
          return refreshSource(db, docId, now, dependencies, false, true);
        }));
        for (const doc of results) {
          if (doc?.kind === "text") {
            suggestion ||= doc.suggestion;
            ready = true;
          }
        }
      }
      const brand = scanned && { name: scanned.name, accent: scanned.accent, logo: scanned.logo };
      const result = { ready, brand, suggestion: suggestion || (home?.kind === "text" ? home.suggestion : undefined) };
      writeMeta(db, "onboarding.site.v2", JSON.stringify(result));
      return result;
    }
    case "knowledge.add": {
      if (!editor) throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      const source = addSource(
        db,
        {
          ...args,
          kind: args.kind,
          ...(args.kind === "doc" ? { url: checkedPageUrl(args.url) } : {}),
        },
        now,
      );
      // A page is read at once, so the editor sees it work or fail; past
      // the hourly budget it waits for the alarm (still "pending").
      if (source.kind === "doc" && takeManualFetch(db, now))
        await refreshSource(db, source.id, now, dependencies);
      return getSource(db, source.id);
    }
    case "knowledge.sitemap": {
      if (!editor) throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      const url = checkedPageUrl(args.url);
      if (!takeManualFetch(db, now))
        throw new KnowledgeError(
          429,
          "knowledge-fetch-rate",
          "Templ has read enough pages for this hour. Add the sitemap again later.",
          { retryAfterSeconds: nextHourSeconds(now) },
        );
      const pages = await fetchSitemap(url, dependencies);
      let added = 0;
      for (const page of pages) {
        try {
          addSource(
            db,
            {
              kind: "doc",
              url: page,
              era: args.era,
              visibility: args.visibility,
              addresses: args.addresses,
            },
            now + added * 1000,
          );
          added++;
        } catch (error) {
          if (error instanceof KnowledgeError && error.reason === "knowledge-limit") break;
        }
      }
      return { found: pages.length, added };
    }
    case "knowledge.update":
      if (!editor) throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      return updateSource(db, { ...args, id: args.id }, now);
    case "knowledge.remove":
      if (!editor) throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      return db.transaction(() => {
        advanceBrainStorage(db, now);
        const removed = removeSource(db, { id: args.id });
        db.sql.exec("DELETE FROM kb_upload_bytes WHERE source_id = ?", String(args.id));
        syncBrainStorageBytes(db);
        return removed;
      });
    case "knowledge.refresh": {
      if (!editor) throw new KnowledgeError(403, "admin-only", "Ask a workspace admin for access.");
      const source = getSource(db, args.id);
      const row = sourceRow(db, source.id);
      if (row?.kind !== "doc" || row.origin === "upload") return source;
      if (row.last_fetch_at !== null && now - row.last_fetch_at < MANUAL_REFRESH_GAP_MS)
        throw new KnowledgeError(429, "knowledge-refresh-rate", "Templ just read this page. Refresh it again in a few minutes.", {
          retryAfterSeconds: Math.ceil((row.last_fetch_at + MANUAL_REFRESH_GAP_MS - now) / 1000),
        });
      if (takeManualFetch(db, now)) await refreshSource(db, source.id, now, dependencies);
      // Past the hourly budget the alarm reads it next.
      else db.sql.exec("UPDATE kb_sources SET next_fetch_at = ? WHERE id = ?", now, source.id);
      return getSource(db, source.id);
    }
    case "knowledge.telegram":
      return telegramKnowledgeOperation(db, actor, args, now);
    case "knowledge.learning.apply":
      return learningKnowledgeOperation(db, actor, args, now);
    case "knowledge.learning.forget":
      return forgetLearningKnowledge(db, actor, args, now);
    case "knowledge.learning.corrections":
      return learnedReplyCorrectionSources(db, actor, args);
    case "knowledge.learning.quarantine":
      return quarantineLearnedReplySource(db, actor, args, now);
    case "knowledge.context":
      return readKnowledgeContext(db, { after: args.after, version: args.version, storageGrant: args.storageGrant as StorageUploadGrant | null, now });
    case "knowledge.query":
      return {
        hits: queryKnowledgeBase(db, {
          ...(args as unknown as KnowledgeQueryArgs),
          audience: people && args.audience === "team" ? "team" : "member",
          now,
        }),
      };
    case "sources.visibility":
      return { visibility: sourceVisibilities(db, args.ids, args.storageGrant, now) };
    case "purge":
      return purgeEvals(db);
    default:
      throw new KnowledgeError(404, "knowledge-op", "Not found.");
  }
}

/** Daily retention, scheduled registry syncs and due page refreshes. */
export async function knowledgeAlarm(
  db: KnowledgeDb,
  now: number,
  dependencies: IngestDependencies = {},
  features: WorkspaceFlagEnv = {},
): Promise<number> {
  ensureSchema(db, now);
  db.transaction(() => advanceBrainStorage(db, now));
  const lastRetention = Number(readMeta(db, "retention.at")) || 0;
  if (now - lastRetention >= DAY_MS - 60_000) {
    evalRetention(db, now);
    profileRetention(db, now);
    corpusRetention(db, now);
    writeMeta(db, "retention.at", String(now));
  }
  const registry = readRegistry(db);
  if (featureOn(features, undefined, "protocolProfile") && registry?.schedule === "daily" && registry.nextSyncAt !== null && registry.nextSyncAt <= now)
    await runRegistrySync(db, "schedule", now, dependencies).catch(() => undefined);
  if (featureOn(features, undefined, "quality") || featureOn(features, undefined, "managedAgent"))
  for (const row of dueSources(db, now, KNOWLEDGE_LIMITS.fetchesPerRun))
    await refreshSource(db, row.id, now, dependencies);
  return nextAlarm(db, now);
}
export function nextAlarm(db: KnowledgeDb, now: number): number {
  const candidates = [now + DAY_MS];
  const due = nextDue(db);
  if (due !== null) candidates.push(due);
  const registry = readRegistry(db);
  if (registry?.nextSyncAt) candidates.push(registry.nextSyncAt);
  return Math.max(now + 60_000, Math.min(...candidates));
}

export class SupportKnowledge {
  private db: KnowledgeDb;
  private resourceReadOps = 0;
  private resourceWriteOps = 0;
  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {
    this.db = {
      sql: {
        exec: (query, ...bindings) => {
          const cursor = state.storage.sql.exec(query, ...bindings);
          // SQL API call counts are not provider-billed rows or storage bytes.
          if ((this.env as { COST_METRICS?: unknown } | undefined)?.COST_METRICS) {
            if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) this.resourceReadOps++;
            else if (/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i.test(query)) this.resourceWriteOps++;
          }
          return cursor;
        },
      },
      transaction: (fn) => state.storage.transactionSync(fn),
    };
  }
  private reportResources(requests: number) {
    const input = { requests, readOps: this.resourceReadOps, writeOps: this.resourceWriteOps };
    this.resourceReadOps = 0;
    this.resourceWriteOps = 0;
    queueKnowledgeResources(this.state, this.env as object, input);
  }
  async fetch(request: Request): Promise<Response> {
    try { return await this.respond(request); }
    finally { this.reportResources(1); }
  }
  private async respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Managed AI: the room's managed ops, Templ's spend
    // meter and nothing else under /managed/.
    const managed = await managedKnowledgeFetch(this.state, this.db, request, this.env as ManagedKnowledgeEnv);
    if (managed) return managed;
    if (request.method === "POST" && url.pathname === "/purge-workspace")
      return this.purgeWorkspace(request);
    // A corpus reader's rows, for the operator route only.
    if (request.method === "POST" && url.pathname === "/corpus/read")
      return this.corpusRead(request);
    if (request.method !== "POST" || url.pathname !== "/op")
      return json({ error: "Not found." }, 404);
    let body: KnowledgeRequest;
    try {
      body = (await request.json()) as KnowledgeRequest;
    } catch {
      return json({ error: "Not found." }, 404);
    }
    let stage: "operation" | "alarm-plan" | "alarm-read" | "alarm-write" | "response" = "operation";
    try {
      const result = await knowledgeOperation(this.db, body, Date.now());
      stage = "alarm-plan";
      const next = nextAlarm(this.db, Date.now());
      stage = "alarm-read";
      const current = await this.state.storage.getAlarm();
      if (current === null || current > next) {
        stage = "alarm-write";
        await this.state.storage.setAlarm(next);
      }
      stage = "response";
      return json(result);
    } catch (error) {
      if (error instanceof KnowledgeError)
        return json(
          { error: error.message, reason: error.reason, ...error.extra },
          error.status,
        );
      console.error("TEMPL_KNOWLEDGE_FAILURE", {
        op: KNOWLEDGE_OPS.includes(body?.op as KnowledgeOp) ? body.op : "unknown",
        stage,
      });
      return json(
        { error: "Support knowledge is unavailable. Try again in a minute.", reason: "knowledge-unavailable" },
        503,
      );
    }
  }
  /** Workspace deletion: every eval copy, run, profile entry and
   * knowledge source goes. Answers `{ done }`; a different workspace than
   * the one this object belongs to is refused. */
  private async purgeWorkspace(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as { workspace?: unknown };
      const room = `room:${String(body.workspace ?? "")}`;
      ensureSchema(this.db, Date.now());
      const bound = readMeta(this.db, "room");
      if (bound !== null && bound !== room) {
        console.error("TEMPL_KNOWLEDGE_ROOM_MISMATCH");
        return json({ done: false }, 409);
      }
      purgeAll(this.db);
      await this.state.storage.deleteAlarm();
      return json({ done: true });
    } catch {
      console.error("TEMPL_KNOWLEDGE_FAILURE", { op: "purge-workspace" });
      return json({ done: false }, 503);
    }
  }
  /** `/corpus/read`: rows without refs for the operator corpus route. It
   * reads this object only and never reaches the room. */
  private async corpusRead(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      ensureSchema(this.db, Date.now());
      return json(corpusReadRequest(this.db, body));
    } catch (error) {
      if (error instanceof KnowledgeError)
        return json({ error: error.message, reason: error.reason }, error.status);
      console.error("TEMPL_KNOWLEDGE_FAILURE", { op: "corpus-read" });
      return json({ error: "Support knowledge is unavailable.", reason: "knowledge-unavailable" }, 503);
    }
  }
  async alarm() {
    try {
      const room = readMeta(this.db, "room");
      let features: WorkspaceFlagEnv = {};
      if (room?.startsWith("room:")) {
        try {
          features = await workspaceFeatureEnvFor(this.env as ManagedKnowledgeEnv, room.slice(5));
        } catch {
          console.error("TEMPL_KNOWLEDGE_FEATURES_UNAVAILABLE");
        }
      }
      let next = await knowledgeAlarm(this.db, Date.now(), {}, features);
      // Managed AI jobs run in this alarm too.
      const managed = await managedAlarm(
        this.db,
        this.env as ManagedKnowledgeEnv,
        Date.now(),
        (promise) => this.state.waitUntil(promise),
      ).catch(() => Date.now() + 60_000);
      if (managed !== null) next = Math.min(next, managed);
      await this.state.storage.setAlarm(next);
    } catch {
      console.error("TEMPL_KNOWLEDGE_ALARM_FAILED");
      await this.state.storage.setAlarm(Date.now() + 60 * 60_000);
    } finally {
      this.reportResources(0);
    }
  }
}
