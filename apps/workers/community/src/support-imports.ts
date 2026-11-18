import { SUPPORT_LIMITS, type SupportSavedReply } from "@templ/chat/support";
import {
  detectSecret,
  hideAmbiguousHex,
  screenTeamText,
} from "@templ/chat/support-safety";
import { HttpError, json } from "./common";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import {
  parseSupportImport,
  importRowRefusal,
  type ImportPreviewRow,
} from "./support-import-parser";
import { parseKnowledgeImport } from "./knowledge-ingest";
import {
  knowledgeActor,
  knowledgeCall,
  type KnowledgeEnv,
} from "./support-knowledge-client";
import {
  qualityViewer,
  toolsNotFound,
  leadOnly,
  peopleOnly,
} from "./support-quality";
import type { ConversationContext } from "./team-conversations";
import { supportKnowledgeOn } from "./workspace-flags";
import { storageUploadGrant, type StorageBillingEnv } from "./brain-storage-billing";

const REPLIES = "support-saved-reply-v1:";
const PREVIEW = "support-replies-import-v1:";
const hash = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

/** Import routes recheck current team access before parsing any file. */
export async function supportImportRoute(
  storage: DurableObjectTransaction,
  context: ConversationContext,
): Promise<Response | null> {
  const match = /^\/conversations\/(knowledge|saved-replies)\/import$/.exec(
    context.pathname,
  );
  if (!match) return null;
  const viewer = qualityViewer(context);
  if (!viewer || context.method !== "POST") throw toolsNotFound();
  if (viewer.bot) throw peopleOnly();
  const body = context.body;
  if (match[1] === "knowledge") {
    if (!supportKnowledgeOn(context.mediaEnv)) throw toolsNotFound();
    if (!viewer.admin)
      throw new HttpError(403, "Ask a workspace admin for access.", undefined, "admin-only");
    if (!viewer.manager) requireWorkspaceAdminHeaders(context.headers, false, true, context.now);
    const rows = await parseKnowledgeImport(body.filename, body.content);
    const storageGrant = await storageUploadGrant(
      storage,
      context.mediaEnv as unknown as StorageBillingEnv,
      viewer.principal,
      context.now,
      viewer.admin && !viewer.manager && !viewer.bot,
    );
    const result = await knowledgeCall(
      context.mediaEnv as unknown as KnowledgeEnv,
      context.room,
      "knowledge.import",
      knowledgeActor(viewer),
      { rows, storageGrant },
    );
    context.pendingAudit.push({
      actor: viewer.principal,
      action: "support.settings",
      target: "knowledge",
      after: { op: "import", added: rows.length },
    });
    return json(result, 201);
  }
  if (!viewer.lead) throw leadOnly();
  if (context.headers.get("X-Support-Workflow") !== "true")
    throw new HttpError(503, "Support tools are being tested.");
  const rows = parseSupportImport(body.filename, body.content, "saved-replies");
  const existing = [
    ...(
      await storage.list<SupportSavedReply>({
        prefix: REPLIES,
        limit: SUPPORT_LIMITS.savedReplies + 1,
      })
    ).values(),
  ];
  const titles = new Set(
    existing.map((reply) => reply.title.trim().toLowerCase()),
  );
  const preview: ImportPreviewRow[] = [];
  const added: SupportSavedReply[] = [];
  for (const row of rows) {
    const refusal = await importRowRefusal(row, "saved-replies");
    const title =
      detectSecret(row.title) || screenTeamText(row.title)
        ? `Row ${row.row}`
        : hideAmbiguousHex(row.title);
    if (refusal)
      preview.push({ row: row.row, title, status: "refuse", reason: refusal });
    else if (titles.has(row.title.toLowerCase()))
      preview.push({
        row: row.row,
        title,
        status: "skip",
        reason: "duplicate",
      });
    else if (existing.length + added.length >= SUPPORT_LIMITS.savedReplies)
      preview.push({
        row: row.row,
        title,
        status: "refuse",
        reason: "capacity",
      });
    else {
      titles.add(row.title.toLowerCase());
      preview.push({ row: row.row, title, status: "add" });
      added.push({
        id: crypto.randomUUID(),
        title,
        text: hideAmbiguousHex(row.body),
        ...(row.shortcut ? { shortcut: row.shortcut } : {}),
        updatedAt: new Date(context.now).toISOString(),
      });
    }
  }
  const digest = await hash(
    JSON.stringify({ filename: body.filename, content: body.content }),
  );
  const key = `${PREVIEW}${viewer.principal}`;
  const counts = {
    added: added.length,
    skipped: preview.filter((row) => row.status === "skip").length,
    refused: preview.filter((row) => row.status === "refuse").length,
  };
  if (body.action === "preview") {
    await storage.put(key, { digest });
    return json({ rows: preview, counts, digest });
  }
  if (
    body.action !== "confirm" ||
    body.confirmed !== true ||
    body.digest !== digest ||
    (await storage.get<{ digest: string }>(key))?.digest !== digest
  )
    throw new HttpError(
      409,
      "Preview this file before importing it.",
      undefined,
      "import-preview",
    );
  for (const reply of added) await storage.put(`${REPLIES}${reply.id}`, reply);
  await storage.delete(key);
  context.pendingAudit.push({
    actor: viewer.principal,
    action: "support.replies.import",
    after: counts,
  });
  return json({ rows: preview, counts, replies: [...existing, ...added] }, 201);
}
