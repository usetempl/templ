/** The AI agent's side of a team reply, and AI off hiding the thread.
 *
 * - AI off hides the request from the workspace's registered AI agent: the
 *   conversation module's one access predicate asks `hiddenFromAgent`, so
 *   every read, write, list, event, search hit and export that uses it
 *   leaves the thread out for the agent. People are never affected.
 * - An agent's reply may carry provenance and [ev:n] markers. The markers
 *   are removed before the message is stored; with the workspace's number
 *   check set to hold, a reply whose figures fail the check becomes a held
 *   draft instead of a message.
 * - A person's reply may name the draft it was sent from (`fromDraft`).
 *
 * The caller checks current access first and writes in the room
 * transaction. Nothing here grants anything or reaches the member. */
import type { ChatMessage } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { aiPrincipals, BOT_SETTINGS_ERROR } from "./bots";
import { assertAiInteractionReply } from "./support-ai-interactions";
import { HttpError } from "./common";
import { supportKnowledgeOn } from "./workspace-flags";
import type { KnowledgeEnv } from "./support-knowledge-client";
import { DIAGNOSIS_NETWORKS_HEADER, enabledFromHeader } from "./support-diagnosis";
import { applyCaseEvent } from "./support-cases";
import {
  checkAgentReply,
  deleteMessageProvenance,
  heldReplyRetry,
  holdAgentReply,
  linkDraftUse,
  problemKinds,
  provenancePage,
  writeAgentProvenance,
  type AgentReplyCheck,
  type HeldReply,
} from "./support-drafts";
import {
  readAiState,
  recordSupportActivity,
  supportRecord,
  supportSettings,
} from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { encryptedCaseExists } from "./support-encryption";
import { ownEncryptedAiReader } from "./support-own-ai";

type Storage = DurableObjectTransaction;

/** True when a registered AI agent reads a request whose AI is off. When
 * the caller does not know whether the viewer is an agent (the delivery
 * paths outside the conversation routes), it is worked out from the
 * workspace's retained AI identities, read only when the request's AI is off. */
export async function hiddenFromAgent(
  storage: Pick<Storage, "get">,
  context: {
    isBot?: boolean;
    aliases: readonly ChatPrincipalId[];
  },
  record: TeamConversationRecord,
): Promise<boolean> {
  if (context.isBot === false) return false;
  // The record's own mode first: most threads follow a default that isn't
  // off, and reading it costs nothing more.
  const { effective } = await readAiState(storage, record);
  const encrypted = record.encryptedCases && await encryptedCaseExists(storage, record.id, (await supportRecord(storage, record)).caseSeq ?? 0);
  if (effective.mode !== "off" && encrypted && await ownEncryptedAiReader(storage, record, context.aliases)) return false;
  if (effective.mode !== "off" && !encrypted) return false;
  if (context.isBot === true) return true;
  // An unreadable bot list refuses the request (503), as it does for every
  // conversation route.
  const settings = await storage.get<object>("chat-settings");
  if (!settings) throw new HttpError(503, BOT_SETTINGS_ERROR);
  const agents = await aiPrincipals(storage, settings);
  return context.aliases.some((id) => agents.includes(id));
}

/** What a reply carries beyond its text, checked before anything is
 * written: provenance comes from AI agents only, `fromDraft` from people on
 * the team only. */
export function assertReplyExtras(
  body: Record<string, unknown>,
  role: "member" | "team",
  isBot: boolean,
): void {
  if (body.provenance !== undefined && !(role === "team" && isBot))
    throw new HttpError(
      400,
      "Only an AI agent sends provenance.",
      undefined,
      "invalid-provenance",
    );
  if (body.fromDraft !== undefined && !(role === "team" && !isBot))
    throw new HttpError(
      400,
      "Only a person on the team replies from a draft.",
      undefined,
      "invalid-draft",
    );
}

/** A registered AI agent's reply before admission: a held retry answers
 * again with its hold; otherwise the reply is checked. Null for people. */
export async function agentReplyCheck(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  text: string,
  body: Record<string, unknown>,
): Promise<
  { held: HeldReply } | { reply: AgentReplyCheck; caseSeq: number } | null
> {
  if (role !== "team" || !context.isBot) return null;
  const clientId =
    typeof body.clientId === "string" ? body.clientId.toLowerCase() : undefined;
  const held = await heldReplyRetry(storage, record.id, clientId, text);
  if (held) return { held };
  const data = await supportRecord(storage, record);
  const caseSeq = data.ledgerVersion === 1 ? (data.caseSeq ?? 0) : 0;
  const reply = await checkAgentReply(storage, {
    thread: record.id,
    diagnosisNetworks: enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
    caseSeq: caseSeq > 0 ? caseSeq : null,
    text,
    provenance: body.provenance,
    settings: await supportSettings(storage),
    knowledge: supportKnowledgeOn(context.mediaEnv)
      ? { env: context.mediaEnv as unknown as KnowledgeEnv, room: context.room, actor: context.viewer.principalId! }
      : undefined,
  });
  await assertAiInteractionReply(storage, { context, record, data, caseSeq, text, provenance: reply.provenance, body });
  // A reply with no member request to answer has no case to hold it in:
  // it goes, and its provenance records the problem.
  if (caseSeq < 1) reply.hold = false;
  if (reply.hold && !clientId)
    throw new HttpError(
      400,
      "Send a clientId with replies the number check may hold.",
      undefined,
      "invalid-draft",
    );
  return { reply, caseSeq };
}

/** Holds a failing agent reply as a draft for the team, after admission
 * decided the reply could go and before anything counted it. */
export async function holdReply(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  checked: { reply: AgentReplyCheck; caseSeq: number },
  body: Record<string, unknown>,
): Promise<HeldReply> {
  const data = await supportRecord(storage, record);
  const ifLatest = body.ifLatest as
    | { id: string; revision: number }
    | undefined;
  const held = await holdAgentReply(storage, {
    thread: record.id,
    caseSeq: checked.caseSeq,
    clientId: (body.clientId as string).toLowerCase(),
    author: context.viewer.principalId!,
    now: context.now,
    reply: checked.reply,
    forMessage: ifLatest
      ? { id: ifLatest.id, revision: ifLatest.revision }
      : null,
    data,
  });
  await recordSupportActivity(storage, record.id, data, {
    actor: context.viewer.principalId!,
    action: "draft-held",
    at: context.now,
    detail: problemKinds(checked.reply.check.problems),
  });
  return held;
}

/** After the message is written: the agent reply's provenance, or the
 * person's draft link. A draft that can't be used never blocks the reply. */
export async function afterReplyWritten(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  message: ChatMessage,
  input: {
    agent: { reply: AgentReplyCheck; caseSeq: number } | null;
    fromDraft: unknown;
  },
): Promise<{ draftLinked?: boolean }> {
  const author = context.viewer.principalId!;
  if (input.agent) {
    await writeAgentProvenance(storage, {
      thread: record.id,
      messageId: message.id,
      caseSeq: input.agent.caseSeq,
      author,
      now: context.now,
      reply: input.agent.reply,
    });
    return {};
  }
  if (input.fromDraft === undefined) return {};
  const data = await supportRecord(storage, record);
  const caseSeq = data.ledgerVersion === 1 ? (data.caseSeq ?? 0) : 0;
  const linked = await linkDraftUse(storage, {
    thread: record.id,
    diagnosisNetworks: enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
    caseSeq,
    draftId: input.fromDraft,
    messageId: message.id,
    text: message.text,
    actor: author,
    now: context.now,
    data,
  });
  if (!linked.linked) return { draftLinked: false };
  const { effective } = await readAiState(storage, record, data);
  await applyCaseEvent(storage, record, data, {
    kind: "ai-draft-used",
    seq: caseSeq,
    at: context.now,
    mode: effective.mode,
    edited: linked.edited,
  });
  await recordSupportActivity(storage, record.id, data, {
    actor: author,
    action: "draft-used",
    at: context.now,
    detail: linked.edited ? "edited" : "as-written",
  });
  return { draftLinked: true };
}

/** An AI agent's edit of its own reply: the same markers and check as a
 * reply. With the number check on hold, a failing edit is refused (422
 * `citation-check`) and the old text stays. Null for people. */
export async function agentEditCheck(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  body: Record<string, unknown>,
  messageId?: string,
): Promise<{ reply: AgentReplyCheck; caseSeq: number } | null> {
  if (role !== "team" || !context.isBot || typeof body.text !== "string")
    return null;
  const data = await supportRecord(storage, record);
  const caseSeq = data.ledgerVersion === 1 ? (data.caseSeq ?? 0) : 0;
  const reply = await checkAgentReply(storage, {
    thread: record.id,
    diagnosisNetworks: enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
    caseSeq: caseSeq > 0 ? caseSeq : null,
    text: body.text.trim(),
    provenance: body.provenance,
    settings: await supportSettings(storage),
    knowledge: supportKnowledgeOn(context.mediaEnv)
      ? { env: context.mediaEnv as unknown as KnowledgeEnv, room: context.room, actor: context.viewer.principalId! }
      : undefined,
  });
  const previous = messageId ? (await provenancePage(storage, record.id, [messageId], () => supportSettings(storage)))[messageId]?.ai : null;
  if (previous?.interaction && (!reply.provenance?.interaction || previous.interaction.kind !== "answer"))
    throw new HttpError(409, "This checked reply cannot be rewritten by the AI. A person can review it.", undefined, "ai-interaction-changed");
  await assertAiInteractionReply(storage, { context, record, data, caseSeq, text: body.text.trim(), provenance: reply.provenance, body });
  if (reply.hold)
    throw new HttpError(
      422,
      `This edit wasn't saved: ${problemKinds(reply.check.problems)}.`,
      undefined,
      "citation-check",
    );
  return { reply, caseSeq };
}
/** Replaces the provenance of an edited agent reply. */
export async function afterAgentEdit(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  messageId: string,
  checked: { reply: AgentReplyCheck; caseSeq: number },
): Promise<void> {
  // An edit to plain text leaves nothing the old provenance described.
  if (checked.reply.plain)
    return deleteMessageProvenance(storage, record.id, messageId);
  await writeAgentProvenance(storage, {
    thread: record.id,
    messageId,
    caseSeq: checked.caseSeq,
    author: context.viewer.principalId!,
    now: context.now,
    reply: checked.reply,
  });
}
