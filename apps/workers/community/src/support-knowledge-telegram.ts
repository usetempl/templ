import { asksForSecret } from "@templ/chat/support-safety";
import { KNOWLEDGE_LIMITS } from "@templ/chat/knowledge";
import { checkedPageUrl } from "./knowledge-ingest";
import { detectStoredSecret } from "./secret-guard";
import {
  addSource,
  getSource,
  getFaq,
  sourceCount,
  updateSource,
} from "./support-knowledge-kb";
import {
  KnowledgeError,
  readMeta,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "./support-knowledge-schema";
import type { KnowledgeActor } from "./support-knowledge";

export type TelegramKnowledgeChange =
  | { kind: "add-faq"; title: string; text: string }
  | { kind: "add-doc"; url: string; title: string }
  | { kind: "deprecate"; sourceId: string; ifUpdatedAt: string };
type Payload = { actorId: string; changes: TelegramKnowledgeChange[] };
export type TelegramKnowledgeResult = {
  operationId: string;
  recordedAt: string;
  changes: {
    kind: TelegramKnowledgeChange["kind"];
    sourceId: string;
    updatedAt: string;
  }[];
};
const HASH = /^[a-f0-9]{64}$/;
const RECEIPT = "knowledge.telegram:";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).sort().join() === [...fields].sort().join();
function invalid(): never {
  throw new KnowledgeError(
    400,
    "knowledge-telegram-invalid",
    "Use a valid knowledge change.",
  );
}
function privateText(): never {
  throw new KnowledgeError(
    422,
    "knowledge-telegram-private",
    "Use general product facts without private case details.",
  );
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) invalid();
  const normalized = value.normalize("NFC").trim();
  // eslint-disable-next-line no-control-regex
  if (
    !normalized ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  )
    invalid();
  return normalized;
}
/** General reusable knowledge must not carry private case details. */
export function genericText(value: string) {
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /\b0x[a-f0-9]{40}(?:[a-f0-9]{24})?\b/i.test(value) ||
    /\b[a-f0-9]{64}\b/i.test(value) ||
    /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/.test(value) ||
    /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/i.test(value) ||
    /\btc-[a-f0-9]{32}\b|\b(?:case|ticket|thread|conversation)\s*(?:(?:id\s*[:=]?|#)\s*[a-z0-9_-]+|[0-9]{1,16}\b)/i.test(
      value,
    ) ||
    /\b(?:principalId|accountId|conversationId|threadId|caseSeq|telegram_id|actorId)\b|\b(?:account|user|member|telegram)\s+(?:id\s*[:=#]?|#)\s*[0-9]+/i.test(
      value,
    ) ||
    /\+\d[\d ().-]{6,}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\(\d{3}\)\s*\d{3}[-. ]?\d{4}\b/.test(
      value,
    ) ||
    /\b(?:phone|mobile|telephone|whatsapp)\s*(?:number)?\s*[:=]\s*\d[\d ().-]{5,}/i.test(
      value,
    ) ||
    /\b(?:api[-_ ]?key|access[-_ ]?token|bot[-_ ]?token|password|authorization)\s*(?:is\s+)?[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b(?:my|their|this|that)\s+(?:account|wallet|deposit|withdrawal|transaction|ticket|case|email|balance)\b/i.test(
      value,
    ) ||
    /\b(?:customer|member|user|person|account holder)\s+(?:named|called)\s+\p{L}/iu.test(
      value,
    ) ||
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:deposited|withdrew|emailed|paid|said|asked)\b/.test(
      value,
    )
  )
    privateText();
  for (const raw of value.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi) ?? []) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[.,;!?)]*$/, ""));
      checkedPageUrl(url.toString());
    } catch {
      privateText();
    }
    if (
      url!.search ||
      /\/(?:cases?|tickets?|threads?|conversations?|accounts?|wallets?|tx|transactions?)\//i.test(
        url!.pathname,
      )
    )
      privateText();
  }
}
function payload(value: unknown): Payload {
  if (
    !object(value) ||
    !exact(value, ["actorId", "changes"]) ||
    typeof value.actorId !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(value.actorId) ||
    !Number.isSafeInteger(Number(value.actorId)) ||
    !Array.isArray(value.changes) ||
    value.changes.length < 1 ||
    value.changes.length > 3
  )
    invalid();
  const changes = value.changes.map((raw: unknown): TelegramKnowledgeChange => {
    if (!object(raw)) invalid();
    if (raw.kind === "add-faq" && exact(raw, ["kind", "title", "text"])) {
      const title = text(raw.title, KNOWLEDGE_LIMITS.titleChars),
        answer = text(raw.text, KNOWLEDGE_LIMITS.faqChars);
      genericText(title);
      genericText(answer);
      return { kind: "add-faq", title, text: answer };
    }
    if (raw.kind === "add-doc" && exact(raw, ["kind", "url", "title"])) {
      const title = text(raw.title, KNOWLEDGE_LIMITS.titleChars),
        rawUrl = text(raw.url, 2048);
      genericText(title);
      genericText(rawUrl);
      return { kind: "add-doc", url: checkedPageUrl(rawUrl), title };
    }
    if (
      raw.kind === "deprecate" &&
      exact(raw, ["kind", "sourceId", "ifUpdatedAt"]) &&
      typeof raw.sourceId === "string" &&
      /^kb-[a-f0-9]{16}$/.test(raw.sourceId) &&
      typeof raw.ifUpdatedAt === "string" &&
      Number.isFinite(Date.parse(raw.ifUpdatedAt)) &&
      new Date(raw.ifUpdatedAt).toISOString() === raw.ifUpdatedAt
    )
      return {
        kind: "deprecate",
        sourceId: raw.sourceId,
        ifUpdatedAt: raw.ifUpdatedAt,
      };
    return invalid();
  });
  const targets = changes
    .filter((change) => change.kind === "deprecate")
    .map((change) => change.sourceId);
  if (new Set(targets).size !== targets.length) invalid();
  return { actorId: value.actorId, changes };
}
/** Hash the normalized payload with this exact key order. Operation IDs remain separate. */
export async function telegramKnowledgePayloadHash(
  value: Payload,
): Promise<string> {
  return sha256Hex(JSON.stringify(payload(value)));
}
const factText = (value: string) =>
  value.normalize("NFC").replace(/\s+/g, " ").trim();
function currentFaq(db: KnowledgeDb, title: string, answer: string) {
  const rows = db.sql
    .exec(
      "SELECT id, title FROM kb_sources WHERE kind = 'faq' AND era = 'current' AND visibility = 'member-safe' AND archived_at IS NULL AND status = 'ready' AND origin <> 'upload' ORDER BY id LIMIT ?",
      KNOWLEDGE_LIMITS.sources,
    )
    .toArray();
  for (const row of rows) {
    if (
      factText(String(row.title)).toLowerCase() !==
      factText(title).toLowerCase()
    )
      continue;
    const source = getFaq(db, String(row.id));
    if (factText(source.text) === factText(answer)) return source;
  }
  return null;
}
export async function telegramKnowledgeOperation(
  db: KnowledgeDb,
  actor: KnowledgeActor,
  args: Record<string, unknown>,
  now: number,
): Promise<TelegramKnowledgeResult> {
  if (actor.role !== "staff" || actor.telegramAuthorized !== true)
    throw new KnowledgeError(
      403,
      "knowledge-telegram-authority",
      "This knowledge change needs the current Telegram connection.",
    );
  if (
    !object(args) ||
    !exact(args, ["operationId", "payloadHash", "actorId", "changes"]) ||
    typeof args.operationId !== "string" ||
    !HASH.test(args.operationId) ||
    typeof args.payloadHash !== "string" ||
    !HASH.test(args.payloadHash) ||
    !Number.isSafeInteger(now)
  )
    invalid();
  const checked = payload({ actorId: args.actorId, changes: args.changes });
  const hash = await sha256Hex(JSON.stringify(checked));
  if (hash !== args.payloadHash)
    throw new KnowledgeError(
      409,
      "knowledge-telegram-hash",
      "The knowledge change does not match its saved content.",
    );
  for (const change of checked.changes) {
    if (change.kind === "deprecate") continue;
    for (const value of change.kind === "add-faq"
      ? [change.title, change.text]
      : [change.title, change.url]) {
      if (asksForSecret(value) || (await detectStoredSecret(value)))
        throw new KnowledgeError(
          422,
          "knowledge-telegram-secret",
          "Knowledge cannot contain secrets or ask users to share them.",
        );
    }
  }
  return db.transaction(() => {
    const key = RECEIPT + args.operationId,
      previous = readMeta(db, key);
    if (previous !== null) {
      const receipt = JSON.parse(previous) as {
        payloadHash: string;
        result: TelegramKnowledgeResult;
      };
      if (receipt.payloadHash !== hash)
        throw new KnowledgeError(
          409,
          "knowledge-telegram-reused",
          "This knowledge operation already has different content.",
        );
      return receipt.result;
    }
    const audit: {
      sourceId: string;
      previousUpdatedAt: string;
      previousEra: string;
      previousStatus: string;
      previousTitle: string;
      previousText?: string;
    }[] = [];
    const changes = checked.changes.map((change) => {
      if (change.kind !== "deprecate") {
        const matching =
          change.kind === "add-faq"
            ? currentFaq(db, change.title, change.text)
            : null;
        if (matching)
          return {
            kind: change.kind,
            sourceId: matching.id,
            updatedAt: matching.updatedAt,
          };
        if (sourceCount(db) >= KNOWLEDGE_LIMITS.sources)
          throw new KnowledgeError(
            409,
            "knowledge-limit",
            "The knowledge base holds up to 500 sources.",
          );
        const source = addSource(
          db,
          change.kind === "add-faq"
            ? {
                kind: "faq",
                title: change.title,
                text: change.text,
                era: "current",
                visibility: "member-safe",
              }
            : {
                kind: "doc",
                title: change.title,
                url: change.url,
                era: "current",
                visibility: "member-safe",
              },
          now,
        );
        return {
          kind: change.kind,
          sourceId: source.id,
          updatedAt: source.updatedAt,
        };
      }
      const source = getSource(db, change.sourceId);
      if (
        source.era !== "current" ||
        source.visibility !== "member-safe" ||
        source.archivedAt !== null ||
        source.updatedAt !== change.ifUpdatedAt
      )
        throw new KnowledgeError(
          409,
          "knowledge-telegram-stale",
          "This knowledge source changed. Read it again before replacing it.",
        );
      audit.push({
        sourceId: source.id,
        previousUpdatedAt: source.updatedAt,
        previousEra: source.era,
        previousStatus: source.status,
        previousTitle: source.title,
        ...(source.kind === "faq"
          ? { previousText: getFaq(db, source.id).text }
          : {}),
      });
      const updated = updateSource(
        db,
        { id: source.id, era: "legacy", ifUpdatedAt: change.ifUpdatedAt },
        Math.max(now, Date.parse(source.updatedAt) + 1),
      );
      return {
        kind: change.kind,
        sourceId: updated.id,
        updatedAt: updated.updatedAt,
      };
    });
    const result = {
      operationId: args.operationId as string,
      recordedAt: new Date(now).toISOString(),
      changes,
    };
    writeMeta(
      db,
      key,
      JSON.stringify({
        payloadHash: hash,
        actorId: checked.actorId,
        by: actor.principal,
        audit,
        result,
      }),
    );
    return result;
  });
}
