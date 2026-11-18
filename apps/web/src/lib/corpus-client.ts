/** The app's calls for Templ's de-identified copies. The counts and the
 * member actions answer the manager and support leads only; every route
 * answers 404 while the copy is off, and the app shows nothing then. */
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  isCorpusPurpose,
  type CorpusWorkspaceView,
} from "@templ/chat/support-corpus";
import { chatMutation } from "./chat-api";
import { CommunityApiError, communityFetch, roomPath } from "./community-client";

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
/** The room's answer when it has the view's shape; null otherwise. */
function checkedView(value: unknown): CorpusWorkspaceView | null {
  const view = value as Partial<CorpusWorkspaceView> | null;
  const reads = view?.reads;
  return view &&
    count(view.rows) &&
    reads &&
    typeof reads.month === "string" &&
    /^\d{4}-\d{2}$/.test(reads.month) &&
    count(reads.rows) &&
    Array.isArray(reads.purposes) &&
    reads.purposes.every(isCorpusPurpose)
    ? { rows: view.rows, reads: { month: reads.month, rows: reads.rows, purposes: reads.purposes } }
    : null;
}
/** The workspace's counts, or null when the viewer can't see them or the
 * copy is off. */
export async function readCorpus(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<CorpusWorkspaceView | null> {
  try {
    return checkedView(
      await communityFetch<unknown>(
        roomPath(room, "conversations/corpus"),
        undefined,
        signal,
      ),
    );
  } catch (reason) {
    if (reason instanceof CommunityApiError && [403, 404].includes(reason.status))
      return null;
    throw reason;
  }
}
/** Whether this workspace's requests are copied, and whether the viewer
 * may act on a member's request; null while the copy is off. A cheap read:
 * no counts and no call to Templ's directory. */
export async function readCorpusOn(
  room: ChatRoomId,
  signal?: AbortSignal,
): Promise<{ lead: boolean } | null> {
  try {
    const answer = await communityFetch<{ on?: unknown; lead?: unknown }>(
      roomPath(room, "conversations/corpus/on"),
      undefined,
      signal,
    );
    return answer?.on === true ? { lead: answer.lead === true } : null;
  } catch (reason) {
    if (reason instanceof CommunityApiError && [403, 404].includes(reason.status))
      return null;
    throw reason;
  }
}
/** Privacy controls for generated workspace knowledge stay available after
 * learning stops. This does not enable Templ's separate improvement copy. */
export async function readCaseCopyPrivacy(room: ChatRoomId, signal?: AbortSignal): Promise<{
  corpus: boolean; learning: boolean; lead: boolean;
} | null> {
  try {
    const answer = await communityFetch<{ on?: unknown; learning?: unknown; lead?: unknown }>(
      roomPath(room, "conversations/corpus/on"), undefined, signal,
    );
    return answer?.on === true || answer?.learning === true
      ? { corpus: answer.on === true, learning: answer.learning === true, lead: answer.lead === true }
      : null;
  } catch (reason) {
    if (reason instanceof CommunityApiError && [403, 404].includes(reason.status)) return null;
    throw reason;
  }
}
/** A member's privacy request (`delete`) or objection (`object`). */
export const corpusAction = (
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  thread: string,
  action: "delete" | "object",
) =>
  chatMutation<{ deleted: number }>(
    account,
    roomPath(room, `conversations/${thread}/corpus`),
    { action },
  );
