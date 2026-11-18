import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { HttpError } from "./common";
import {
  productMode,
  readProductState,
  standardPlanForState,
} from "./product-entitlements";
import { readCaseRef, synthesizeThreadLedger } from "./support-cases";
import { supportRecord } from "./support-workflow";
import { standardCoveredAt } from "./product-standard-plan";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

/** The existing case ledger counts accepted replies, including deleted messages and reopened cases. */
export async function assertFreeTeamReply(
  storage: DurableObjectTransaction,
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  const product = await readProductState(
    storage,
    context.now,
    context.mediaEnv,
  );
  if (
    productMode(product) === "exempt" ||
    standardPlanForState(product)?.status !== "demo"
  )
    return;
  const data = await supportRecord(storage, record);
  if (data.ledgerVersion !== 1)
    await synthesizeThreadLedger(storage, record, data, context.now);
  if (!data.caseSeq)
    throw new HttpError(
      409,
      "Ask a test user to send a question before your team replies.",
    );
  const ticket = await readCaseRef(storage, record, data, data.caseSeq);
  if (await standardCoveredAt(storage, ticket.openedAt)) return;
  if (
    ticket.counts.humanReplies + ticket.counts.botReplies >=
    PRODUCT_LIMITS.freeTeamRepliesPerTicket
  )
    throw new HttpError(
      409,
      `This test ticket has used its ${PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies. Pay for workspace access to continue.`,
      undefined,
      "standard-test-reply-limit",
    );
}
