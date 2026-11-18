/** What a thread view says about billing and "Solved": the latest case's
 * charge status for the team (never an amount), and for the member whether
 * the request can be marked solved or the widget should ask. */
import { PRODUCT_ASK_AFTER_MS } from "@templ/chat/product-catalog";
import type { TeamConversation } from "@templ/chat/index";
import { caseBilling } from "./product-charges";
import { CASE_PREFIX, checkedCase } from "./support-cases";

type Storage = Pick<DurableObjectTransaction, "get">;
type Thread = {
  id: string;
  state: "open" | "resolved";
  confirmation?: { askedAt: number; answer: string | null } | null;
};

async function latestCase(storage: Storage, thread: string) {
  const data = await storage.get<{ caseSeq?: number }>(
    `support-workflow-v1:${thread}`,
  );
  const seq = data?.caseSeq;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return null;
  return checkedCase(
    await storage.get(`${CASE_PREFIX}${thread}:${String(seq).padStart(8, "0")}`),
    thread,
    seq as number,
  );
}

/** Team views: whether the latest request bills. */
export async function latestCaseBilling(
  storage: Storage,
  record: Thread,
): Promise<TeamConversation["billing"] | null> {
  const c = await latestCase(storage, record.id);
  return c ? await caseBilling(storage, record.id, c.seq) : null;
}

/** Member views: `ready` on an open request the team has answered, `ask`
 * once the team's latest reply is the thread's latest message and
 * `askAfterHours` old, unless the member already said no to it. */
export async function memberSolve(
  storage: Storage,
  record: Thread,
  now: number,
): Promise<TeamConversation["solve"] | null> {
  const c = await latestCase(storage, record.id);
  if (record.state !== "open" && c?.abandonedAt == null) return null;
  if (!c || c.resolvedAt !== null || c.lastReplyAt === null) return null;
  if (c.counts.humanReplies + c.counts.botReplies === 0) return null;
  const declined =
    record.confirmation?.answer === "not-solved" &&
    record.confirmation.askedAt >= c.lastReplyAt;
  return c.lastReplyAt >= c.lastMemberAt &&
    now - c.lastReplyAt >= PRODUCT_ASK_AFTER_MS &&
    !declined
    ? "ask"
    : "ready";
}
