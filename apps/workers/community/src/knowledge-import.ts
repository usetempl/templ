import { advanceBrainStorage, requireBrainUploadAdmission, syncBrainStorageBytes } from "./brain-storage";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { KNOWLEDGE_LIMITS } from "@templ/chat/protocol-profile";
import { hideAmbiguousHex } from "@templ/chat/support-safety";
import { checkedPageUrl } from "./knowledge-ingest";
import {
  importRowRefusal,
  IMPORT_REASON,
  type ImportRow,
} from "./support-import-parser";
import { chunkText, getSource, replaceChunks, sourceCount } from "./support-knowledge-kb";
import {
  KnowledgeError,
  randomHex,
  type KnowledgeDb,
} from "./support-knowledge-schema";
import type { KnowledgeRequest } from "./support-knowledge";

/** Stores only screened source fields and searchable chunks, in one transaction. */
export async function knowledgeImport(
  db: KnowledgeDb,
  request: KnowledgeRequest,
  now: number,
): Promise<unknown | undefined> {
  if (request.op !== "knowledge.import") return undefined;
  const delegatedEditor = (request.actor.role === "staff" || request.actor.role === "lead") &&
    request.actor.workspaceAdmin === true;
  if (request.actor.role !== "manager" && !delegatedEditor)
    throw new KnowledgeError(
      403,
      "admin-only",
      "Ask a workspace admin for access.",
    );
  const rows = request.args.rows;
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > FEATURE_LIMITS.knowledgeImportRowsPerFile
  )
    throw new KnowledgeError(
      400,
      "import-count",
      "Choose a file within the import limit.",
    );
  if (sourceCount(db) + rows.length > KNOWLEDGE_LIMITS.sources)
    throw new KnowledgeError(
      409,
      "knowledge-limit",
      "Remove a knowledge source before importing this file.",
    );
  const checked = await Promise.all(rows.map(async (value): Promise<ImportRow> => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      (value.url !== undefined && typeof value.url !== "string")
    )
      throw new KnowledgeError(
        400,
        "invalid-row",
        IMPORT_REASON["invalid-row"],
      );
    const refusal = await importRowRefusal(value, "knowledge");
    if (refusal) throw new KnowledgeError(422, refusal, IMPORT_REASON[refusal]);
    return {
      ...value,
      title: hideAmbiguousHex(value.title),
      body: hideAmbiguousHex(value.body),
      url: value.url && hideAmbiguousHex(value.url) === value.url ? checkedPageUrl(value.url) : undefined,
    };
  }));
  if (
    checked.reduce(
      (sum, row) =>
        sum +
        new TextEncoder().encode(row.title + row.body + (row.url ?? ""))
          .byteLength,
      0,
    ) > KNOWLEDGE_LIMITS.pageBytes
  )
    throw new KnowledgeError(
      413,
      "import-size",
      "This file is too large. Split it into smaller files.",
    );
  const uploadBytes = checked.map((row) => chunkText(row.body).reduce(
    (total, text) => total + new TextEncoder().encode(text).byteLength, 0,
  ));
  return db.transaction(() => {
    advanceBrainStorage(db, now);
    requireBrainUploadAdmission(db, request.actor.principal, uploadBytes.reduce((total, bytes) => total + bytes, 0), request.args.storageGrant, now,
      delegatedEditor);
    const sources = checked.map((row, index) => {
      const id = `kb-${randomHex(8)}`;
      db.sql.exec(
        "INSERT INTO kb_sources (id, kind, title, url, era, visibility, addresses, status, updated_at, origin) VALUES (?, 'doc', ?, ?, 'current', 'member-safe', '[]', 'ready', ?, 'upload')",
        id,
        row.title,
        row.url ?? null,
        now,
      );
      replaceChunks(db, id, row.title, row.body);
      db.sql.exec("INSERT INTO kb_upload_bytes (source_id, bytes) VALUES (?, ?)", id, uploadBytes[index]);
      return getSource(db, id);
    });
    syncBrainStorageBytes(db);
    return { added: sources.length, sources };
  });
}
