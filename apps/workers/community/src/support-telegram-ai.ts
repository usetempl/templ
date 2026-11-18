import type { ChatMessage, ChatPrincipalId } from "@templ/chat/index";
import { standardPlanView } from "./product-standard-plan";
import type {
  TelegramAiHelpJob,
  TelegramAiHelpResult,
} from "@templ/chat/support-telegram-ai";
import { personRequest } from "@templ/chat/person-intent";
import { readStoredSupportContext } from "@templ/chat/support-context";
import { HttpError, json, sha256Hex } from "./common";
import {
  MESSAGE_BUDGET_AVAILABLE_HEADER,
  withMessageBudget,
} from "./message-budget";
import {
  checkedNativeTelegram,
  nativeTelegramApproved,
  NATIVE_TELEGRAM_KEY,
  type NativeTelegramRecord,
} from "./native-telegram-access";
import {
  productMode,
  readProductState,
  readProductSupport,
  standardPlanForState,
} from "./product-entitlements";
import {
  detectStoredSecret,
  refusePhrase,
  refuseTeamText,
} from "./secret-guard";
import { assertLatest, parseIfLatest, type IfLatest } from "./support-handoff";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { KnowledgeError } from "./support-knowledge-schema";
import {
  telegramKnowledgePayloadHash,
  type TelegramKnowledgeChange,
  type TelegramKnowledgeResult,
} from "./support-knowledge-telegram";
import { readAiState, supportRecord } from "./support-workflow";
import { templAiPrincipal } from "./templ-ai-principal";
import { featureOn } from "./workspace-flags";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
type Result = TelegramAiHelpResult;
/** Private case state. Keeping the content on its parent record also keeps
 * conversation deletion and legal retention in charge of this content. */
export type TelegramAiHelp = {
  assist?: true;
  schemaVersion: 1;
  id: string;
  conversation: string;
  revision: number;
  stage: "summary" | "answer";
  status: "pending" | "ready" | "waiting" | "completed";
  latest: IfLatest;
  handoffAt: number;
  requestAt: number;
  caseSeq: number;
  createdAt: number;
  approvalId: string;
  relay: ChatPrincipalId;
  relayNonce: string | null;
  bot: ChatPrincipalId;
  controlHash: string;
  turnHash: string;
  replies: { actorId: string; text: string }[];
  receipts: { updateId: string; hash: string }[];
  result?: Result;
  resultHash?: string;
  sent?: { clientId: string; textHash: string; approvedBy?: string };
  learning?: TelegramKnowledgeResult;
};
type Deps = {
  team: boolean;
  authorize: (
    id: string,
  ) => Promise<{ record: TeamConversationRecord; role: "member" | "team" }>;
  send: (
    id: string,
    body: Record<string, unknown>,
    headers: Headers,
  ) => Promise<Response | null>;
};
export const TELEGRAM_AI_PATH =
  /^\/conversations\/(?:telegram-ai|tc-[a-f0-9]{32}\/telegram-ai)$/;
const THREAD_PATH = /^\/conversations\/(tc-[a-f0-9]{32})\/telegram-ai$/;
const INDEX = "support-telegram-ai-pending-v1:";
const LIMIT = 1000;
const PAGE = 20;
const RUNNER = "support-telegram-ai-runner-v1";
const RUNNER_SEEN_MS = 5 * 60_000;
const REPLIES = 8;
const MAX_AGE = 24 * 60 * 60_000;
const UUID7 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INTEGER = /^[1-9][0-9]{0,15}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const invalid = () =>
  new HttpError(
    400,
    "Use a valid Telegram help action.",
    undefined,
    "telegram-ai-invalid",
  );
const stale = () =>
  new HttpError(
    409,
    "This case changed. Read it again before continuing.",
    undefined,
    "telegram-ai-stale",
  );
const unavailable = () =>
  new HttpError(
    409,
    "This case needs a direct team reply.",
    undefined,
    "telegram-ai-ineligible",
  );
const hidden = () => new HttpError(404, "Support tools not found.");
const recordKey = (id: string) => `conversation-v1:${id}`;
const indexKey = (job: TelegramAiHelp) =>
  `${INDEX}${String(job.createdAt).padStart(16, "0")}:${job.conversation}`;

function view(job: TelegramAiHelp | null): TelegramAiHelpJob | null {
  if (!job) return null;
  return {
    ...(job.assist ? { assist: true as const } : {}),
    id: job.id,
    conversation: job.conversation,
    revision: job.revision,
    stage: job.stage,
    status: job.status,
    latest: job.latest,
    handoffAt: new Date(job.handoffAt).toISOString(),
    caseSeq: job.caseSeq,
    replies: job.replies,
    ...(job.result ? { result: job.result } : {}),
  };
}
async function save(
  storage: Storage,
  record: TeamConversationRecord,
  job: TelegramAiHelp,
) {
  if (new TextEncoder().encode(JSON.stringify(job)).length > 48 * 1024)
    throw new HttpError(
      413,
      "This help request is full. Reply directly to the user.",
    );
  await storage.put(recordKey(record.id), { ...record, telegramAi: job });
  if (job.status === "pending")
    await storage.put(indexKey(job), { conversation: record.id, id: job.id });
  else await storage.delete(indexKey(job));
}
async function relay(storage: Storage, context: ConversationContext) {
  const row = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  if (
    !row?.relayPrincipalId ||
    row.status !== "active" ||
    !(await nativeTelegramApproved(storage, context.mediaEnv, {
      workspaceId: row.workspaceId,
      approvalId: row.approvalId,
      relayPrincipalId: row.relayPrincipalId,
    }))
  )
    throw hidden();
  return row as NativeTelegramRecord & { relayPrincipalId: ChatPrincipalId };
}
async function currentBot(
  context: ConversationContext,
): Promise<ChatPrincipalId | null> {
  for (const principal of context.registeredBots ?? [])
    if (
      (await templAiPrincipal(context.room, [principal])) === principal &&
      (await context.isSupportStaff?.(principal))
    )
      return principal;
  return null;
}
function integer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    INTEGER.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
async function safeText(value: unknown, max: number, empty = true) {
  if (typeof value !== "string" || value.length > max) throw invalid();
  const text = value.normalize("NFC").trim();
  if (
    (!empty && !text) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  )
    throw invalid();
  await refusePhrase(text, "saved");
  refuseTeamText(text);
  return text;
}
/** The public-information loop never handles an account, money, privacy,
 * secret or explicit-person request, even if an earlier AI called it unsure. */
async function memberTurn(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  requestedAt: number,
  assist = false,
) {
  const entries = await storage.list<ChatMessage>({
    prefix: `channel-message:${record.id}:`,
    reverse: true,
    limit: 65,
  });
  const members = [record.member, ...(record.formerMembers ?? [])];
  const rows: ChatMessage[] = [];
  let started = false;
  for (const row of entries.values()) {
    if (
      !Number.isFinite(Date.parse(row.createdAt)) ||
      Date.parse(row.createdAt) < requestedAt
    )
      break;
    if (members.includes(row.author as ChatPrincipalId)) {
      started = true;
      rows.push(row);
    } else if (started) break;
    else if (
      !(context.bots ?? context.registeredBots ?? []).includes(
        row.author as ChatPrincipalId,
      )
    )
      return null;
    if (rows.length > 32) return null;
  }
  if (!rows.length) return null;
  const text = rows
    .reverse()
    .map((row) => row.text)
    .join("\n");
  if (
    text.length > 16_000 ||
    (!assist &&
      (personRequest(text) ||
        text.split(/(?<=[.!?])\s+|\n+/).some(personRequest))) ||
    /\b(?:private\s*key|recovery\s*(?:phrase|words)|seed\s*phrase|password|passcode|credential|privacy|personal\s*data|gdpr|data\s*(?:export|delet)|delete\s*(?:my|our)|refund|chargeback|invoice|billing|payment|my\s+(?:account|wallet|balance|funds|money|deposit|withdrawal|transaction)|(?:deposit|withdraw|transfer|send|recover|restore|unlock|credit|debit)\s+(?:my|our|me|us)|stolen|hacked|lost\s+(?:funds|money)|account\s*(?:access|recovery|closure|deletion))\b/i.test(
      text,
    ) ||
    /\b(?:i|we|my|our)\b[\s\S]{0,100}\b(?:deposited|withdrew|withdrawn|repaid|balance|funds|money|payment|account|wallet|transaction)\b/i.test(
      text,
    ) ||
    /\b(?:should|recommend|advise|better off|best investment)\b[\s\S]{0,160}\b(?:invest|move|deposit|withdraw|lend|borrow|buy|sell|USDC|USDT|ETH|SOL|money|funds)\b/i.test(
      text,
    ) ||
    /\b(?:move|send|transfer|recover|lost|missing)\b[\s\S]{0,80}\b(?:tokens?|crypto|stablecoins?|USDC|USDT|DAI|ETH|SOL)\b/i.test(
      text,
    ) ||
    /\b0x[a-f0-9]{40,64}\b|\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/i.test(text) ||
    (await detectStoredSecret(text))
  )
    return null;
  return sha256Hex(
    JSON.stringify(
      rows.map((row) => [row.id, row.revision ?? 1, row.author, row.text]),
    ),
  );
}
async function eligible(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  assist = false,
) {
  if (
    context.headers.get("X-Conversations") !== "true" ||
    context.headers.get("X-Support-Workflow") !== "true" ||
    record.deleting ||
    record.archivedAt !== undefined ||
    record.stopped ||
    record.state !== "open" ||
    !record.handoff ||
    (!assist &&
      (record.assignment ||
        record.handoff.by !== "agent" ||
        record.handoff.reason !== "unsure"))
  )
    return null;
  const data = await supportRecord(storage, record);
  if (
    !data.requestedAt ||
    record.handoff.requestAt !== data.requestedAt ||
    !Number.isSafeInteger(data.caseSeq) ||
    (data.caseSeq ?? 0) < 1 ||
    !["open", "waiting"].includes(data.state)
  )
    return null;
  const held = readStoredSupportContext(data.context);
  if (held === "unreadable" || held?.transactions?.length) return null;
  const ai = await readAiState(storage, record, data);
  if (ai.effective.mode !== "answers") return null;
  const support = await readProductSupport(
    storage,
    context.now,
    context.mediaEnv,
  );
  const product = await readProductState(
    storage,
    context.now,
    context.mediaEnv,
  );
  if (
    !support.enabled ||
    ["paused", "suspended"].includes(productMode(product)) ||
    standardPlanForState(product)?.status === "demo"
  )
    return null;
  const bot = await currentBot(context);
  const turnHash =
    bot &&
    (await memberTurn(storage, context, record, data.requestedAt, assist));
  if (!bot || !turnHash) return null;
  const controls = {
    revision: record.revision,
    ai: record.ai ?? null,
    mode: ai.effective,
    context: data.context,
  };
  // Keep pre-feature jobs byte-compatible while default-off. A source-read
  // permission change invalidates queued results and unapproved proposals.
  const plainHash = await sha256Hex(JSON.stringify(controls));
  const sourceHash = await sha256Hex(
    JSON.stringify({ ...controls, appTelegramDrafts: true }),
  );
  const sourceDrafts =
    (await featureOn(context.mediaEnv, storage, "appTelegramDrafts")) &&
    (await featureOn(context.mediaEnv, storage, "aiDrafts"));
  return {
    data,
    bot,
    turnHash,
    controlHash: sourceDrafts ? sourceHash : plainHash,
    // Only an explicit restart may reuse team facts across this flag change.
    restartControlHashes: [plainHash, sourceHash],
  };
}
async function matches(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  job: TelegramAiHelp,
  row: NativeTelegramRecord,
  allowSourceFlagChange = false,
) {
  if (
    job.schemaVersion !== 1 ||
    job.conversation !== record.id ||
    job.approvalId !== row.approvalId ||
    job.relay !== row.relayPrincipalId ||
    job.relayNonce !== (row.relayNonce ?? null) ||
    context.now - job.createdAt >= MAX_AGE ||
    job.createdAt > context.now ||
    record.handoff?.at !== job.handoffAt
  )
    return false;
  const current = await eligible(storage, context, record, job.assist === true);
  if (
    !current ||
    current.bot !== job.bot ||
    current.data.requestedAt !== job.requestAt ||
    current.data.caseSeq !== job.caseSeq ||
    current.turnHash !== job.turnHash ||
    (allowSourceFlagChange
      ? !current.restartControlHashes.includes(job.controlHash)
      : current.controlHash !== job.controlHash)
  )
    return false;
  try {
    await assertLatest(storage, record.id, job.latest);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return false;
    throw error;
  }
}
async function parsedResult(
  value: unknown,
  stage: TelegramAiHelp["stage"],
): Promise<Result> {
  if (
    !object(value) ||
    !exact(value, [
      "kind",
      "problem",
      "answered",
      "question",
      "text",
      "knowledgeChanges",
    ]) ||
    Object.keys(value).length !== 6 ||
    !["summary", "question", "answer", "human"].includes(String(value.kind))
  )
    throw invalid();
  const result: Result = {
    kind: value.kind as Result["kind"],
    problem: await safeText(value.problem, 1200),
    answered: await safeText(value.answered, 1500),
    question: await safeText(value.question, 1500),
    text: await safeText(value.text, 4000),
    knowledgeChanges: [],
  };
  if (
    (stage === "summary" && !["summary", "human"].includes(result.kind)) ||
    (stage === "answer" && result.kind === "summary") ||
    (result.kind === "answer" && !result.text) ||
    (["summary", "question"].includes(result.kind) && !result.question)
  )
    throw invalid();
  {
    if (
      !Array.isArray(value.knowledgeChanges) ||
      value.knowledgeChanges.length > 3
    )
      throw invalid();
    result.knowledgeChanges =
      value.knowledgeChanges as TelegramKnowledgeChange[];
    if (result.knowledgeChanges.length) {
      try {
        await telegramKnowledgePayloadHash({
          actorId: "1",
          changes: result.knowledgeChanges,
        });
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        // Keep a valid case answer private to the case when learning is refused.
        result.knowledgeChanges = [];
      }
    }
  }
  return result;
}

/** All state changes run in the room transaction. Telegram actor IDs are
 * accepted only from the current native relay, never from a member or bot. */
export async function telegramAiRoute(
  storage: Storage,
  context: ConversationContext,
  deps: Deps,
): Promise<Response | null> {
  if (!TELEGRAM_AI_PATH.test(context.pathname)) return null;
  if (
    !deps.team ||
    !context.viewer.principalId ||
    context.viewer.banned ||
    context.viewer.mutedUntil
  )
    throw hidden();
  const row = await relay(storage, context);
  const bot =
    context.isBot === true &&
    (context.registeredBots ?? []).some((id) => context.aliases.includes(id)) &&
    (await templAiPrincipal(context.room, context.aliases)) ===
      context.viewer.principalId;
  const isRelay =
    !context.isBot &&
    context.viewer.principalId === row.relayPrincipalId &&
    context.aliases.includes(row.relayPrincipalId);
  if (!bot && !isRelay) throw hidden();
  const match = THREAD_PATH.exec(context.pathname);
  if (!match) {
    if (!bot || context.method !== "GET") throw hidden();
    await storage.put(RUNNER, {
      at: context.now,
      principal: context.viewer.principalId,
    });
    const pending = await storage.list<{ conversation: string; id: string }>({
      prefix: INDEX,
      limit: PAGE,
    });
    const jobs = [];
    for (const [key, ref] of pending) {
      const auth = await deps
        .authorize(ref.conversation)
        .catch((error: unknown) => {
          if (error instanceof HttpError && [403, 404].includes(error.status))
            return null;
          throw error;
        });
      const job = auth?.record.telegramAi;
      if (job && job.bot !== context.viewer.principalId) continue;
      if (
        !auth ||
        auth.role !== "team" ||
        !job ||
        job.id !== ref.id ||
        job.status !== "pending" ||
        !(await matches(storage, context, auth.record, job, row))
      ) {
        await storage.delete(key);
        continue;
      }
      jobs.push(view(job));
    }
    return json({ jobs });
  }
  const id = match[1];
  const { record, role } = await deps.authorize(id);
  if (role !== "team") throw hidden();
  let job = record.telegramAi ?? null;
  if (context.method === "GET")
    return json({
      help:
        job &&
        (job.status === "completed"
          ? isRelay &&
            job.relay === row.relayPrincipalId &&
            job.approvalId === row.approvalId
          : await matches(storage, context, record, job, row))
          ? view(job)
          : null,
    });
  if (context.method !== "POST") throw hidden();
  if (
    context.body.expectedPrincipalId !== undefined &&
    context.body.expectedPrincipalId !== context.viewer.principalId
  )
    throw hidden();
  const { expectedPrincipalId: _expectedPrincipalId, ...body } = context.body;
  if (body.action === "start") {
    const assist = body.assist === true;
    if (
      !isRelay ||
      !exact(body, ["action", "ifLatest", ...(assist ? ["assist"] : [])])
    )
      throw hidden();
    const latest = parseIfLatest(body.ifLatest);
    if (!latest) throw invalid();
    const current = await eligible(storage, context, record, assist);
    if (!current) throw unavailable();
    await assertLatest(storage, id, latest);
    if (job && (await matches(storage, context, record, job, row)))
      return json({ help: view(job) });
    const runner = await storage.get<{
      at: number;
      principal: ChatPrincipalId;
    }>(RUNNER);
    if (
      !runner ||
      runner.principal !== current.bot ||
      !Number.isSafeInteger(runner.at) ||
      runner.at > context.now ||
      context.now - runner.at > RUNNER_SEEN_MS
    )
      throw unavailable();
    const entries = await storage.list({ prefix: INDEX, limit: LIMIT });
    if (entries.size >= LIMIT && (!job || !entries.has(indexKey(job))))
      throw new HttpError(
        429,
        "The team help queue is full. Reply directly to the user.",
        60,
      );
    if (job) await storage.delete(indexKey(job));
    const helpId = await sha256Hex(JSON.stringify([id, record.handoff!.at]));
    const retained =
      job &&
      job.id === helpId &&
      job.status !== "completed" &&
      (await matches(storage, context, record, job, row, true))
        ? job.replies
        : [];
    job = {
      ...(assist ? { assist: true as const } : {}),
      schemaVersion: 1,
      id: helpId,
      conversation: id,
      revision: job?.id === helpId ? job.revision + 1 : 1,
      stage: assist || retained.length ? "answer" : "summary",
      status: assist ? "waiting" : "pending",
      latest,
      handoffAt: record.handoff!.at,
      requestAt: current.data.requestedAt!,
      caseSeq: current.data.caseSeq!,
      createdAt: context.now,
      approvalId: row.approvalId,
      relay: row.relayPrincipalId,
      relayNonce: row.relayNonce ?? null,
      bot: current.bot,
      controlHash: current.controlHash,
      turnHash: current.turnHash,
      replies: retained,
      receipts: job?.id === helpId ? job.receipts : [],
    };
    await save(storage, record, job);
    return json({ help: view(job) });
  }
  if (
    !job ||
    body.id !== job.id ||
    !Number.isSafeInteger(body.revision) ||
    (body.revision as number) < 1
  )
    throw stale();
  const expectedKeys = {
    reply: ["actorId", "text", "updateId"],
    result: ["result"],
    wait: [],
    send: ["clientId", "approvedBy"],
    learn: [],
  };
  const action = body.action as keyof typeof expectedKeys;
  if (
    !Object.hasOwn(expectedKeys, action) ||
    !exact(body, ["action", "id", "revision", ...expectedKeys[action]])
  )
    throw invalid();
  if (
    (action === "result"
      ? !bot || job.bot !== context.viewer.principalId
      : !isRelay) ||
    job.relay !== row.relayPrincipalId ||
    job.approvalId !== row.approvalId ||
    job.relayNonce !== (row.relayNonce ?? null)
  )
    throw hidden();
  // The relay retries the original update after an unknown transport result.
  // Its original revision can already be spent by that exact accepted reply.
  let replyHash: string | undefined;
  if (action === "reply") {
    if (!integer(body.actorId) || !integer(body.updateId)) throw invalid();
    await safeText(body.text, 2000, false);
    replyHash = await sha256Hex(
      JSON.stringify({
        id: body.id,
        revision: body.revision,
        actorId: body.actorId,
        text: body.text,
        updateId: body.updateId,
      }),
    );
    const receipt = job.receipts.find(
      (entry) => entry.updateId === body.updateId,
    );
    if (receipt) {
      if (receipt.hash !== replyHash) throw stale();
      if (
        job.status !== "completed" &&
        !(await matches(storage, context, record, job, row))
      )
        throw stale();
      return json({ help: view(job) });
    }
  }
  if (action === "send" && job.status === "completed" && job.sent) {
    if (
      body.revision !== job.revision ||
      body.clientId !== job.sent.clientId ||
      body.approvedBy !== job.sent.approvedBy
    )
      throw stale();
    return json({ help: view(job) });
  }
  if (
    body.revision !== job.revision ||
    !(await matches(storage, context, record, job, row))
  )
    throw stale();
  if (action === "reply") {
    if (
      !["ready", "waiting"].includes(job.status) ||
      job.result?.kind === "human" ||
      job.replies.length >= REPLIES ||
      job.receipts.length >= 64
    )
      throw unavailable();
    job = {
      ...job,
      revision: job.revision + 1,
      stage: "answer",
      status: "pending",
      replies: [
        ...job.replies,
        {
          actorId: body.actorId as string,
          text: (body.text as string).normalize("NFC").trim(),
        },
      ],
      receipts: [
        ...job.receipts,
        { updateId: body.updateId as string, hash: replyHash! },
      ],
    };
    delete job.result;
    delete job.resultHash;
    delete job.learning;
  } else if (action === "result") {
    const result = await parsedResult(body.result, job.stage);
    const resultHash = await sha256Hex(JSON.stringify(result));
    if (job.resultHash) {
      if (job.resultHash !== resultHash) throw stale();
      return json({ help: view(job) });
    }
    if (job.status !== "pending") throw stale();
    if (
      result.knowledgeChanges?.length &&
      (job.stage !== "answer" ||
        !job.replies.length ||
        !["question", "answer"].includes(result.kind))
    )
      throw invalid();
    job = { ...job, status: "ready", result, resultHash };
  } else if (action === "wait") {
    if (
      !["ready", "waiting"].includes(job.status) ||
      !job.result ||
      !["summary", "question"].includes(job.result.kind)
    )
      throw stale();
    job = { ...job, status: "waiting" };
  } else if (action === "send") {
    if (
      job.status !== "ready" ||
      job.result?.kind !== "answer" ||
      !job.result.text ||
      !job.replies.length ||
      !integer(body.approvedBy) ||
      typeof body.clientId !== "string" ||
      !UUID7.test(body.clientId)
    )
      throw invalid();
    const text = job.result.text;
    const plan = await standardPlanView(storage, context.now);
    const sendBody = {
      text,
      clientId: body.clientId,
      ifLatest: job.latest,
      ...(plan.status === "paid" && plan.period?.source === "verified-payment"
        ? { replyIntent: "answer" as const }
        : {}),
    };
    const accepted = job;
    return withMessageBudget(
      context.mediaEnv,
      {
        scope: context.room,
        path: `/conversations/${id}/messages`,
        method: "POST",
        body: sendBody,
        principal: context.viewer.principalId,
        aliases: [...context.aliases],
      },
      async (available) => {
        const headers = new Headers(context.headers);
        if (available !== undefined)
          headers.set(MESSAGE_BUDGET_AVAILABLE_HEADER, String(available));
        const response = await deps.send(id, sendBody, headers);
        if (!response?.ok)
          return response ?? json({ error: "The reply was not sent." }, 503);
        const fresh = await storage.get<TeamConversationRecord>(recordKey(id));
        if (!fresh) throw stale();
        const completed: TelegramAiHelp = {
          ...accepted,
          status: "completed",
          sent: {
            approvedBy: body.approvedBy as string,
            clientId: body.clientId as string,
            textHash: await sha256Hex(text),
          },
        };
        await save(storage, fresh, completed);
        return json(
          { help: view(completed) },
          response.status,
          response.headers,
        );
      },
    );
  } else if (action === "learn") {
    if (
      job.status !== "ready" ||
      !job.result ||
      !["answer", "question"].includes(job.result.kind) ||
      !job.replies.length ||
      !job.result.knowledgeChanges?.length
    )
      throw invalid();
    // Opted-in workspaces use the channel-independent accepted-reply path.
    // It writes only the Learned FAQ and preserves every original source.
    if (await featureOn(context.mediaEnv, storage, "handoffLearning"))
      return json({ help: view(job), learning: { mode: "handoff-learning" } });
    if (job.learning) return json({ help: view(job), learning: job.learning });
    const actorId = job.replies.at(-1)!.actorId,
      changes = job.result.knowledgeChanges;
    try {
      const learning = await knowledgeCall<TelegramKnowledgeResult>(
        context.mediaEnv as unknown as KnowledgeEnv,
        context.room,
        "knowledge.telegram",
        {
          principal: row.relayPrincipalId,
          role: "staff",
          telegramAuthorized: true,
        },
        {
          operationId: await sha256Hex(`${job.id}:${job.revision}`),
          payloadHash: await telegramKnowledgePayloadHash({ actorId, changes }),
          actorId,
          changes,
        },
      );
      job = { ...job, learning };
      await save(storage, record, job);
      return json({ help: view(job), learning });
    } catch (error) {
      // A failed knowledge change must not discard a valid member answer.
      if (!(error instanceof HttpError)) throw error;
      return json({
        help: view(job),
        learning: {
          error: error.message,
          reason: error.reason ?? "knowledge-unavailable",
        },
      });
    }
  }
  await save(storage, record, job);
  return json({ help: view(job) });
}
