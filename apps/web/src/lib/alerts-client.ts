import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRoomId } from "@templ/chat/index";
import type {
  AlertDestinationView,
  AlertEscalationMinutes,
  AlertLogEntry,
  AlertsView,
  AlertSubscribableEvent,
  AlertSummaryMinutes,
  MemberAlertView,
  SupportAlertDestination,
} from "@templ/chat/support-alerts";
import { chatMutation } from "@/lib/chat-api";
import type { NativeTelegramView } from "@templ/chat/support-telegram";
import {
  COMMUNITY_API,
  CommunityApiError,
  chatRetryAfter,
  communityFetch,
  roomPath,
} from "@/lib/community-client";

/** Team alert channels (manager only), the escalation target and the
 * member reply-email page. Every call goes to the community service, which
 * checks current access; a 404 means the viewer has no such tool. */

export const readAlerts = (room: ChatRoomId, signal?: AbortSignal) =>
  communityFetch<AlertsView>(roomPath(room, "conversations/integrations"), undefined, signal);

export const readNativeTelegram = (room: ChatRoomId, signal?: AbortSignal) =>
  communityFetch<NativeTelegramView>(roomPath(room, "conversations/telegram"), undefined, signal);
export const changeNativeTelegram = (account: ChatPrincipalId | undefined, room: ChatRoomId,
  op: "prepare" | "approve" | "disconnect", approvalId?: string) =>
  chatMutation<NativeTelegramView>(account, roomPath(room, "conversations/telegram"),
    { op, ...(approvalId ? { approvalId } : {}), confirmed: true });

export type NewAlertChannel = {
  kind: SupportAlertDestination;
  label: string;
  url?: string;
  token?: string;
  chatId?: string;
  threadId?: number;
  walletContext?: boolean;
  events?: AlertSubscribableEvent[];
  summaryMinutes?: AlertSummaryMinutes;
};
export const createAlertChannel = (
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  input: NewAlertChannel,
) =>
  chatMutation<{ destination: AlertDestinationView; signingSecret?: string }>(
    account,
    roomPath(room, "conversations/integrations"),
    { op: "create", ...input, confirmed: true },
  );

export type AlertChannelOp =
  | { op: "pause" }
  | { op: "resume"; confirmed?: boolean }
  | { op: "test" }
  | { op: "verify"; code: string }
  | { op: "delete"; confirmed: true }
  | { op: "rotate"; confirmed: true }
  | { op: "wallet-context"; enabled: boolean; confirmed: true }
  | {
      op: "update";
      confirmed: true;
      label?: string;
      events?: AlertSubscribableEvent[];
      summaryMinutes?: AlertSummaryMinutes;
    };
export const alertChannelAction = (
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  id: string,
  action: AlertChannelOp,
) =>
  chatMutation<{
    destination?: AlertDestinationView;
    signingSecret?: string;
    error?: string;
    ok?: boolean;
  }>(account, roomPath(room, `conversations/integrations/${id}`), action);

export const readAlertLog = (room: ChatRoomId, id: string, before?: string | null) =>
  communityFetch<{ entries: AlertLogEntry[]; next: string | null }>(
    roomPath(
      room,
      `conversations/integrations/${id}/log${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  );

export const readEscalation = (room: ChatRoomId, signal?: AbortSignal) =>
  communityFetch<{ escalateAfterMinutes: AlertEscalationMinutes }>(
    roomPath(room, "conversations/escalation"),
    undefined,
    signal,
  );
export const saveEscalation = (
  account: ChatPrincipalId | undefined,
  room: ChatRoomId,
  escalateAfterMinutes: AlertEscalationMinutes,
) =>
  chatMutation<{ escalateAfterMinutes: AlertEscalationMinutes }>(
    account,
    roomPath(room, "conversations/escalation"),
    { escalateAfterMinutes, confirmed: true },
  );

/** When the member last opened a team reply; team only. */
export const readMemberSeen = (room: ChatRoomId, thread: string, signal?: AbortSignal) =>
  communityFetch<{ memberSeenAt: string | null }>(
    roomPath(room, `conversations/${thread}/member-seen`),
    undefined,
    signal,
  );

/* The member reply-email page (`/alerts`). It holds no session: the ticket
 * from the widget becomes a 15-minute grant cookie on the community host. */

async function memberCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${COMMUNITY_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new CommunityApiError(
      (data as { error?: string }).error ?? "Templ is unavailable. Try again.",
      response.status,
      data,
      chatRetryAfter(response),
    );
  return data as T;
}
/** `#t=<workspace>.<ticket>`, or null. */
export function parseAlertTicket(hash: string): { workspace: string; ticket: string } | null {
  const match = /^#t=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  return match ? { workspace: match[1], ticket: match[2] } : null;
}
export const redeemAlertTicket = (workspace: string, ticket: string) =>
  memberCall<MemberAlertView>("/alerts/member/redeem", { workspace, ticket });
export const readMemberAlerts = (workspace: string) =>
  memberCall<MemberAlertView>(`/alerts/member?w=${workspace}`);
export const setMemberAlerts = (workspace: string, enabled: boolean) =>
  memberCall<MemberAlertView>("/alerts/member/preference", { workspace, enabled });
export const startMemberEmail = (workspace: string, email: string, requestId: string) =>
  memberCall<{ ok: true; expiresAt: number; resendAfter: number }>(
    `/alerts/member/email/start?w=${workspace}`,
    { email, requestId },
  );
export const verifyMemberEmail = (workspace: string, email: string, code: string) =>
  memberCall<{ emailVerified: boolean; emailMasked: string | null }>(
    `/alerts/member/email/verify?w=${workspace}`,
    { email, code },
  );
