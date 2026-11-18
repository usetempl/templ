/** Own's approved Telegram relay receives a secure link and routing metadata
 * only. It receives no device grant, ciphertext key, excerpt or private draft. */
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import { encryptedCaseStateKey, readEncryptedAudienceRecord, type RelayCaseState } from "@templ/e2ee/relay";
import { checkedNativeTelegram, nativeTelegramApproved, NATIVE_TELEGRAM_KEY } from "./native-telegram-access";
import { HttpError, json, roomKey } from "./common";
import { supportRecord } from "./support-workflow";
import { featureOn } from "./workspace-flags";
import type { ConversationContext, TeamConversationRecord } from "./team-conversations";

export async function ownEncryptedNotice(storage: DurableObjectTransaction, context: ConversationContext,
  authorize: (id: string) => Promise<TeamConversationRecord>) {
  const match = /^\/conversations\/(tc-[a-f0-9]{32})\/encryption-notice$/.exec(context.pathname);
  if (!match) return null;
  const noAccess = () => new HttpError(404, "Support tools not found.");
  if (context.method !== "GET" || context.appOrigin !== "https://usetempl.com" ||
      roomKey(context.room) !== `room:${OWN_SUPPORT_ENDPOINT.workspace}` || context.isBot ||
      !await featureOn(context.mediaEnv, storage, "nativeTelegram")) throw noAccess();
  const relay = checkedNativeTelegram(await storage.get(NATIVE_TELEGRAM_KEY));
  if (!relay?.relayPrincipalId || context.viewer.principalId !== relay.relayPrincipalId ||
      !await nativeTelegramApproved(storage, context.mediaEnv, relay as typeof relay & {relayPrincipalId: string})) throw noAccess();
  const record = await authorize(match[1]), data = await supportRecord(storage, record);
  const ref = {environment: "production" as const, workspace: OWN_SUPPORT_ENDPOINT.workspace, conversation: record.id, caseSeq: data.caseSeq ?? 0};
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey(ref));
  if (!state) return json({encrypted: null});
  if (state.deleted || state.profile.custody !== "templ-own-support" ||
      state.profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT ||
      state.profile.clientOrigin !== OWN_SUPPORT_ENDPOINT.clientOrigin) throw noAccess();
  const latest = await readEncryptedAudienceRecord(storage, ref, "conversation", state.acceptedByAudience.conversation);
  if (!latest) throw noAccess();
  return json({encrypted: {caseSeq: ref.caseSeq, clientOrigin: OWN_SUPPORT_ENDPOINT.clientOrigin},
    state: record.state, stopped: Boolean(record.stopped), handoffAt: record.handoff ? new Date(record.handoff.at).toISOString() : null,
    latest: {messageId: latest.record.id, revision: record.revision}});
}
