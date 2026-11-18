/** Per-case Own AI choices are current consent, not restorable history. */
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import { encryptedCaseStateKey, type RelayCaseState } from "@templ/e2ee/relay";
import { checkedAiControl, type StoredAiControl } from "./support-ai-mode";
import { HttpError } from "./common";
import type { TeamConversationRecord } from "./team-conversations";

export const OWN_AI_CONTROL_PREFIX = "support-encryption-own-ai-v1:";
type Reader = Pick<DurableObjectTransaction, "get">;
const modeKey = (record: TeamConversationRecord, seq: number) => `${OWN_AI_CONTROL_PREFIX}${record.id}:${seq}:mode`;
async function ownCase(storage: Reader, record: TeamConversationRecord, caseSeq: number) {
  if (record.room !== `room:${OWN_SUPPORT_ENDPOINT.workspace}` || !Number.isSafeInteger(caseSeq) || caseSeq < 1) return null;
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey({environment: "production", workspace: OWN_SUPPORT_ENDPOINT.workspace,
    conversation: record.id, caseSeq}));
  return state && !state.deleted && state.profile.custody === "templ-own-support" ? state : null;
}
export async function readOwnAiControl(storage: Reader, record: TeamConversationRecord, caseSeq: number) {
  const state = await ownCase(storage, record, caseSeq);
  if (!state) return undefined;
  const checkpoint = await storage.get<{v: number; rootKey: string; control: StoredAiControl}>(modeKey(record, caseSeq));
  if (checkpoint === undefined) return undefined;
  if (checkpoint?.v !== 1 || checkpoint.rootKey !== state.profile.rootKey || !checkpoint.control ||
      !checkedAiControl(checkpoint.control) || checkpoint.control.caseSeq !== caseSeq) throw new HttpError(503, "AI consent could not be checked.");
  return checkpoint.control;
}
export async function checkpointOwnAiControl(storage: Pick<DurableObjectTransaction, "get" | "put">, record: TeamConversationRecord, control: StoredAiControl) {
  const state = await ownCase(storage, record, control.caseSeq);
  if (state) await storage.put(modeKey(record, control.caseSeq), {v: 1, rootKey: state.profile.rootKey, control});
}
