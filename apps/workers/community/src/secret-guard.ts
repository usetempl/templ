import { detectSupportSecret } from "@templ/chat/support-secret-check";
import {
  screenTeamText,
  type SecretKind,
  type TeamTextRefusal,
  type TeamTextOptions,
} from "@templ/chat/support-safety";
import { HttpError } from "./common";
import { CONVERSATION_ROUTE } from "./team-conversations";

/** Recognized secrets are refused before storage. */
export const SECRET_REFUSED = "secret-refused";
/** Team text that asks for a private key or recovery phrase is refused. */
export const SECRET_REQUEST_REFUSED = "secret-request-refused";
export const SECRET_COPY = {
  sent: "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone.",
  saved:
    "This looks like a wallet recovery phrase, so it wasn't saved. Don't share it with anyone.",
  keySent: "This looks like a private key, so it wasn't sent. Don't share it with anyone.",
  keySaved: "This looks like a private key, so it wasn't saved. Don't share it with anyone.",
  ask: "Templ doesn't send text that asks for a private key or recovery phrase. Remove that text and try again.",
  unsafeAsk: "Templ blocks messages that ask the user to sign, approve or send anything. Sign-in happens only in the sign-in card.",
} as const;

/** 422 `secret-refused` for recognized keys or recovery phrases, for every author. */
export async function detectStoredSecret(text: string): Promise<SecretKind | null> {
  try { return await detectSupportSecret(text); }
  catch { throw new HttpError(503, "The secret check is unavailable. Try again.", undefined, "secret-check-unavailable"); }
}
export async function refusePhrase(text: unknown, copy: "sent" | "saved"): Promise<void> {
  const kind = typeof text === "string" ? await detectStoredSecret(text) : null;
  if (kind)
    throw new HttpError(422, kind === "phrase" ? SECRET_COPY[copy] : SECRET_COPY[copy === "sent" ? "keySent" : "keySaved"], undefined, SECRET_REFUSED);
}
/** Lead fields must pass the plain and decoded secret checks before storage. */
export async function screenSupportLeadText(text: unknown): Promise<void> {
  await refusePhrase(text, "sent");
  if (typeof text !== "string") return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(text.replace(/\+/g, " "));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new HttpError(400, "Check your app details.", undefined, "lead-invalid");
  }
  await refusePhrase(decoded, "sent");
}
/** Every saved team response uses the shared ask screen. */
export function refuseSecretRequest(text: unknown, options: TeamTextOptions = {}): void {
  refuseTeamText(text, options);
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The edge screen for conversation writes: secrets, for every author,
 * before pacing, open reservations, the room object and every count. The
 * room repeats these checks with the author's role. */
export async function screenConversationWrite(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (method !== "POST") return;
  const match = CONVERSATION_ROUTE.exec(path);
  if (!match) return;
  const [, action, thread, sub, messageId, messageAction] = match;
  if (action === "ask") {
    await refusePhrase(body.text, "sent");
    await refusePhrase(record(body.context).description, "sent");
    for (const field of ["appUrl", "email"]) {
      await screenSupportLeadText(record(body.lead)[field]);
    }
  } else if (action === "start") await refusePhrase(body.text, "sent");
  else if (action === "saved-replies") {
    await refusePhrase(body.title, "saved");
    await refusePhrase(body.text, "saved");
  } else if (action === "settings") {
    await refusePhrase(body.acknowledgment, "saved");
    await refusePhrase(body.businessHours, "saved");
  } else if (thread && sub === "messages") {
    if (!messageId || messageAction === "edit") await refusePhrase(body.text, "sent");
  } else if (thread && sub === "workflow") {
    if (body.action === "note") await refusePhrase(body.text, "saved");
    else if (body.action === "context")
      await refusePhrase(record(body.context).description, "sent");
    else if (body.action === "report-answer")
      await refusePhrase(body.reason, "sent");
    // AI drafts and Ask AI questions are candidate replies; frames and
    // evidence rows are saved team text.
    else if (body.action === "draft") await refusePhrase(body.text, "sent");
    else if (body.action === "draft-request")
      await refusePhrase(body.instruction, "sent");
    else if (body.action === "frame") await screenCaseText(record(body.set));
    else if (body.action === "evidence" && Array.isArray(body.rows))
      for (const row of body.rows.slice(0, 10)) await screenCaseText(record(row));
  }
}
/** Every string in a frame change or an evidence row, two levels deep. */
async function screenCaseText(value: Record<string, unknown>) {
  for (const entry of Object.values(value)) {
    if (typeof entry === "string") await refusePhrase(entry, "saved");
    else
      for (const inner of Object.values(record(entry)))
        if (typeof inner === "string") await refusePhrase(inner, "saved");
  }
}

/** Team text uses one screen for staff, registered bots and managed replies. */
export function refuseTeamText(text: unknown, options: TeamTextOptions = {}): void {
  const refusal = typeof text === "string" ? screenTeamText(text, options) : null;
  if (refusal) throw teamTextRefusal(refusal);
}
/** 422 `secret-request-refused` for an ask for a key or phrase, 422
 * `unsafe-ask` for every other credential, signature or transaction ask. */
export function teamTextRefusal(kind: TeamTextRefusal): HttpError {
  const error = kind === "asks for a secret"
    ? new HttpError(422, SECRET_COPY.ask, undefined, SECRET_REQUEST_REFUSED)
    : new HttpError(422, SECRET_COPY.unsafeAsk, undefined, "unsafe-ask");
  Object.assign(error, { refusalKind: kind });
  return error;
}
