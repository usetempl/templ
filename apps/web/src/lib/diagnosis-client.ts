import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  DIAGNOSIS_CLIENT_ID,
  SUPPORT_DIAGNOSIS_RATINGS,
  type SupportDiagnosisList,
  type SupportDiagnosisRating,
  type SupportDiagnosisView,
} from "@templ/chat/support-diagnosis";
import { chatMutation } from "./chat-api";
import { communityFetch, roomPath } from "./community-client";

/** Transaction checks for the team: read the list, run one, rate one.
 * Every call goes through the service's access check; a member, a guest or
 * anyone outside the team gets 404. Nothing here signs or sends anything on
 * a chain. */
const THREAD = /^tc-[0-9a-f]{32}$/;
const path = (room: ChatRoomId, thread: string) => {
  if (!THREAD.test(thread)) throw new Error("Invalid case.");
  return roomPath(room, `conversations/${thread}/diagnosis`);
};

/** A request id per click; a retry of the same click reuses it. */
export function newDiagnosisClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `dx_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function readDiagnoses(
  room: ChatRoomId,
  thread: string,
  signal?: AbortSignal,
): Promise<SupportDiagnosisList> {
  return communityFetch<SupportDiagnosisList>(
    path(room, thread),
    undefined,
    signal,
  );
}

export type RunDiagnosisResult =
  | { diagnosis: SupportDiagnosisView; cached: boolean }
  | { running: SupportDiagnosisList["running"] };

export function runDiagnosis(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  thread: string,
  input: {
    clientId: string;
    hash?: string;
    link?: string;
    network?: string;
    force?: boolean;
  },
): Promise<RunDiagnosisResult> {
  if (!DIAGNOSIS_CLIENT_ID.test(input.clientId))
    throw new Error("Invalid request id.");
  if ((input.hash === undefined) === (input.link === undefined))
    throw new Error("Send a hash or a link.");
  return chatMutation<RunDiagnosisResult>(account, path(room, thread), {
    clientId: input.clientId,
    subject: {
      ...(input.hash !== undefined
        ? { hash: input.hash }
        : { link: input.link }),
      ...(input.network ? { network: input.network } : {}),
    },
    ...(input.force ? { force: true } : {}),
  });
}

export function rateDiagnosis(
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  thread: string,
  input: { diagnosis: string; rating: SupportDiagnosisRating },
): Promise<{ rating: { diagnosis: string; rating: string; at: string } }> {
  if (!SUPPORT_DIAGNOSIS_RATINGS.includes(input.rating))
    throw new Error("Invalid rating.");
  return chatMutation(account, path(room, thread), {
    action: "rate",
    diagnosis: input.diagnosis,
    rating: input.rating,
  });
}
