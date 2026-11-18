import {
  parseSupportLeadInput,
  SupportLeadError,
  type SupportLeadInput,
} from "@templ/chat/support-lead";
import { parseCaip10 } from "@templ/chat/widget-wallet";
import { HttpError } from "./common";
import { screenSupportLeadText } from "./secret-guard";
import type { ConversationContext } from "./team-conversations";
import type { SupportRecord } from "./support-workflow";

/** The checked widget member can submit to Templ's configured workspace. */
export async function checkedSupportLead(
  context: ConversationContext,
): Promise<SupportLeadInput | undefined> {
  if (context.body.lead === undefined) return undefined;
  if (
    !context.room.startsWith("room:") ||
    context.room.slice(5) !== context.mediaEnv.TEMPL_SUPPORT_WORKSPACE ||
    context.headers.get("X-Support-Widget") !== "member" ||
    !context.headers.get("X-Support-Widget-Origin") ||
    context.isBot
  )
    throw new HttpError(404, "Support action not found.");
  if (
    typeof context.body.text !== "string" ||
    !context.body.text.trim() ||
    typeof context.body.clientId !== "string"
  )
    throw new HttpError(400, "Send your app details with a message.");
  let lead: SupportLeadInput;
  try {
    lead = parseSupportLeadInput(context.body.lead);
  } catch (error) {
    if (error instanceof SupportLeadError)
      throw new HttpError(400, error.message, undefined, "lead-invalid");
    throw error;
  }
  if (lead.kind === "qualified" || lead.kind === "email") {
    const text = lead.kind === "qualified" ? lead.appUrl : lead.email;
    await screenSupportLeadText(text);
  } else if (
    context.headers.get("X-Support-Access-Level") !== "signed" ||
    !parseCaip10(context.headers.get("X-Support-Wallet"))
  )
    throw new HttpError(
      403,
      "Sign in with your wallet first.",
      undefined,
      "wallet-proof-required",
    );
  return lead;
}

export function assertSupportLeadRetry(
  data: SupportRecord,
  context: ConversationContext,
  lead: SupportLeadInput,
): void {
  const submission = data.leadSubmission;
  if (
    !submission ||
    submission.clientId !== context.body.clientId ||
    submission.input !== JSON.stringify(lead)
  )
    throw new HttpError(
      409,
      "This message retry has different app details.",
      undefined,
      "lead-retry-conflict",
    );
}

/** Saved in the member-message transaction; it never creates authority. */
export function recordSupportLead(
  data: SupportRecord,
  context: ConversationContext,
  input: SupportLeadInput,
): void {
  data.lead = {
    ...data.lead,
    submittedAt: new Date(context.now).toISOString(),
  };
  if (input.kind === "qualified") {
    const { kind: _kind, ...qualified } = input;
    data.lead.qualified = qualified;
  } else if (input.kind === "email") data.lead.email = input.email;
  else data.lead.wallet = parseCaip10(context.headers.get("X-Support-Wallet"))!;
  data.leadSubmission = {
    clientId: context.body.clientId as string,
    input: JSON.stringify(input),
  };
}
