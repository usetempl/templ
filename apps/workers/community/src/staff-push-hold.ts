import type { StaffPushHold } from "./staff-push";
import { supportTurn } from "./support-turn";
import { agentState, readAiState } from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;

const reads = new WeakMap<
  ConversationContext,
  Map<string, Promise<StaffPushHold | null>>
>();

/** Whether the AI agent is answering this request now, by the same rule as
 * the AI is handling view: AI answers, no handoff, an active agent and a
 * wait that started within the AI reply window. Then staff are not alerted
 * yet: the returned hold delays their push to the end of that window.
 * Null means a person is needed now. Read once per request and thread. */
export function staffPushHold(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
): Promise<StaffPushHold | null> {
  let byThread = reads.get(context);
  if (!byThread) reads.set(context, (byThread = new Map()));
  let hold = byThread.get(record.id);
  if (!hold) byThread.set(record.id, (hold = read(storage, context, record)));
  return hold;
}

async function read(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
): Promise<StaffPushHold | null> {
  if (record.handoff || !(context.registeredBots ?? []).length) return null;
  const { data, effective } = await readAiState(storage, record);
  const since = data.awaitingSince;
  if (typeof since !== "number" || !Number.isSafeInteger(since)) return null;
  const turn = supportTurn({
    state: data.state,
    awaitingSince: since,
    handoffReason: null,
    aiMode: effective.mode,
    agentDraftAt: data.lastAgentNoteAt ?? null,
    agent: await agentState(context),
    now: context.now,
  });
  return turn?.turn === "ai" ? { thread: record.id, since } : null;
}
