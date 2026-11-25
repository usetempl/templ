import {
  SUPPORT_IDENTITY_LABELS,
  threadIdentity,
} from "@templ/chat/support-identity";
/** Where support work turns into alert events. The hook sites call these
 * right after `applyCaseEvent`, inside the same room transaction; nothing
 * here throws for an alert reason, because a thrown error would roll back
 * the member's request. Events carry codes, counts and times only. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError } from "./common";
import { enqueueNativeTelegramHandoff } from "./native-telegram";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import {
  ALERT_ESCALATION_DEFAULT_MINUTES,
  ALERT_ESCALATION_MINUTES,
  SUPPORT_ALERT_LIMITS,
  type AlertEscalationMinutes,
  type AlertEventFacts,
  type AlertWebhookMember,
} from "@templ/chat/support-alerts";
import type { SupportRefusalReason } from "@templ/chat/support";
import { readStoredSupportContext } from "@templ/chat/support-context";
import {
  formatCaip10,
  readStoredWidgetWallet,
} from "@templ/chat/widget-wallet";
import { aiPrincipals, BOT_SETTINGS_ERROR } from "./bots";
import { currentStaffRoleIds, templStaffAccount, type TemplStaffEnv } from "./templ-staff";
import {
  alertsEnabled,
  emitAlert,
  readDestinationIndex,
  type AlertEnv,
} from "./alert-outbox";
import type { AlertInboxFooter } from "./alert-render";
import type { OutboxDeps } from "./alert-outbox";
import { queueStaffNotification } from "./support-notifications";
import {
  AWAITING_PREFIX,
  applyCaseEvent,
  type CaseEvent,
  type CaseTransition,
} from "./support-cases";
import { wakeRoomAt } from "./room-alarm";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import type { SupportRecord } from "./support-workflow";

type Tx = DurableObjectTransaction;

/** The escalation target (`{ minutes }`), manager-set with privileged
 * confirmation. Absent reads as 30 minutes; an unreadable value reads as 30
 * and logs a fixed label. */
export const ESCALATION_KEY = "support-escalation-v1";
export const UNSEEN_DUE_PREFIX = "support-unseen-due-v1:";
/** The member's newest seen team reply, kept under the staff read-marker
 * prefix so thread deletion removes it with the thread. "member" is never a
 * principal id. */
export const memberSeenKey = (thread: string) =>
  `support-seen-v1:${thread}:member`;
const pad16 = (value: number) =>
  String(Math.max(0, Math.floor(value))).padStart(16, "0");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export async function readEscalationMinutes(
  storage: Pick<Tx, "get">,
): Promise<AlertEscalationMinutes> {
  const stored = await storage.get<{ minutes?: unknown }>(ESCALATION_KEY);
  if (stored === undefined) return ALERT_ESCALATION_DEFAULT_MINUTES;
  if (
    (ALERT_ESCALATION_MINUTES as readonly unknown[]).includes(stored?.minutes)
  )
    return stored.minutes as AlertEscalationMinutes;
  console.warn(
    JSON.stringify({
      event: "TEMPL_SUPPORT_FAILURE",
      route: "alert-escalation",
      reason: "unreadable",
    }),
  );
  return ALERT_ESCALATION_DEFAULT_MINUTES;
}

/** The inbox footer from the awaiting index: how many wait (up to 1,000)
 * and since when the oldest has waited. */
export async function inboxFooter(
  storage: Pick<Tx, "list">,
): Promise<AlertInboxFooter> {
  const rows = await storage.list({ prefix: AWAITING_PREFIX, limit: 1_000 });
  const first = [...rows.keys()][0];
  const since = first
    ? Number(first.slice(AWAITING_PREFIX.length, AWAITING_PREFIX.length + 16))
    : NaN;
  return {
    needsReply: rows.size,
    oldestWaitingSince: Number.isSafeInteger(since) ? since : null,
  };
}

/** The manager and the people who handle conversations now, registered
 * bots left out (bots never get email). Read from storage alone, for the
 * alarm; every email is authorized again when it is sent. */
export async function roomSupportStaff(
  storage: Pick<Tx, "get" | "list">,
  env: TemplStaffEnv = {},
  now = Date.now(),
): Promise<{ manager: ChatPrincipalId | null; handlers: ChatPrincipalId[] }> {
  return roomPermissionHolders(storage, "handleConversations", env, now);
}

/** The manager and the people who hold `permission` through an enabled
 * manual role now, registered bots left out. */
export async function roomPermissionHolders(
  storage: Pick<Tx, "get" | "list">,
  permission: "handleConversations" | "manageBilling",
  env: TemplStaffEnv = {},
  now = Date.now(),
  complete = false,
): Promise<{ manager: ChatPrincipalId | null; handlers: ChatPrincipalId[] }> {
  const native = await storage.get<{ room?: { manager?: string } }>(
    "native-room",
  );
  const storedManager = normalizeChatPrincipal(native?.room?.manager);
  const manager = storedManager && !(await templStaffAccount(storage, [storedManager], env))
    ? storedManager
    : null;
  const settings = await storage.get<{
    roles?: {
      id: string;
      enabled?: boolean;
      moderationPermissions?: string[];
    }[];
  }>("chat-settings");
  const manual =
    (await storage.get<Record<string, { mode?: string; enabled?: boolean }>>(
      "native-manual-roles",
    )) ?? {};
  let bots: ChatPrincipalId[];
  try {
    if (!settings) throw new HttpError(503, BOT_SETTINGS_ERROR);
    bots = await aiPrincipals(storage, settings);
  } catch {
    if (complete)
      throw new HttpError(503, "Billing managers could not be checked.");
    // Unreadable AI settings cannot establish that anyone is a person.
    return { manager: null, handlers: [] };
  }
  const handling = new Set(
    (settings?.roles ?? [])
      .filter(
        (role) =>
          role.enabled !== false &&
          manual[role.id]?.mode === "manual" &&
          manual[role.id]?.enabled !== false &&
          role.moderationPermissions?.includes(permission),
      )
      .map((role) => role.id),
  );
  const handlers: ChatPrincipalId[] = [];
  const assignments = await storage.list<string[]>({
    prefix: "roles:",
    limit: complete ? 1_001 : 1_000,
  });
  if (complete && assignments.size > 1_000)
    throw new HttpError(503, "Billing managers could not be checked.");
  for (const [key] of assignments) {
    const id = normalizeChatPrincipal(key.slice("roles:".length));
    if (!id || id === manager || bots.includes(id)) continue;
    const assigned = await currentStaffRoleIds(storage, id, env, now);
    if (assigned.some((role) => handling.has(role))) handlers.push(id);
    if (complete && handlers.length > 100)
      throw new HttpError(503, "Billing managers could not be checked.");
    if (!complete && handlers.length >= 100) break;
  }
  return {
    manager: manager && !bots.includes(manager) ? manager : null,
    handlers,
  };
}

/** An opted-in webhook's member block, read at send time: the proven
 * wallet, else the guest's claimed wallet marked unverified, and the
 * member's shared transactions. Null when the thread is gone. */
export async function alertMember(
  storage: Pick<Tx, "get">,
  thread: string,
): Promise<AlertWebhookMember | null> {
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${thread}`,
  );
  if (!record || record.deleting) return null;
  const data = await storage.get<SupportRecord>(
    `support-workflow-v1:${thread}`,
  );
  if (!data) return null;
  const proven = data.wallet ? readStoredWidgetWallet(data.wallet) : null;
  const claimed =
    !proven && data.access?.claimedWallet
      ? readStoredWidgetWallet(data.access.claimedWallet)
      : null;
  const context = readStoredSupportContext(data.context);
  const transactions =
    context && context !== "unreadable"
      ? (context.transactions ?? []).map((tx) => ({
          ...(tx.network ? { network: tx.network } : {}),
          hash: tx.hash,
        }))
      : [];
  return {
    identity: threadIdentity(data),
    identityLabel: SUPPORT_IDENTITY_LABELS[threadIdentity(data)],
    wallet: proven
      ? { account: formatCaip10(proven), verified: true }
      : claimed
        ? { account: formatCaip10(claimed), verified: false }
        : null,
    transactions,
  };
}

const envOf = (context: ConversationContext) =>
  context.mediaEnv as unknown as AlertEnv;
/** Alerts for one case change. `excluded` with the canary sends nothing;
 * test accounts and staff previews send, marked `test`. */
export async function emitCaseAlerts(
  storage: Tx,
  context: ConversationContext,
  record: TeamConversationRecord,
  event: CaseEvent,
  transition: CaseTransition | void,
): Promise<void> {
  try {
    if (!transition || transition.seq === null) return;
    if (transition.excluded.includes("canary")) return;
    if (context.canary && record.member === context.canary) return;
    const env = envOf(context);
    const test = transition.excluded.some(
      (cause) =>
        cause === "test-account" ||
        cause === "staff-preview" ||
        cause === "install-preview",
    );
    const workflow = await storage.get<SupportRecord>(
      `support-workflow-v1:${record.id}`,
    );
    const base: Pick<AlertEventFacts, "at" | "case" | "identity"> & {
      test?: true;
    } = {
      identity: threadIdentity(workflow ?? {}),
      at: context.now,
      case: { thread: record.id, seq: transition.seq },
      ...(test ? { test: true as const } : {}),
    };
    // A visitor can ask for a person before the first message opens the case.
    if (transition.handoffOpened)
      await enqueueNativeTelegramHandoff(storage, context, record);
    if (alertsEnabled(env)) {
      if (transition.reopened)
        await emitAlert(
          storage,
          env,
          { ...base, type: "request.reopened" },
          context.now,
        );
      else if (transition.opened)
        await emitAlert(
          storage,
          env,
          { ...base, type: "request.new" },
          context.now,
        );
      if (transition.handoffOpened && event.kind === "handoff")
        await emitAlert(
          storage,
          env,
          {
            ...base,
            type: "request.handoff",
            reason: event.reason,
            by: event.by,
          },
          context.now,
        );
    }
    // A new wait: the escalation timer wakes the room when it is due.
    if (
      transition.awaitingAfter !== null &&
      transition.awaitingAfter !== transition.awaitingBefore
    ) {
      const minutes = await readEscalationMinutes(storage);
      if (minutes > 0)
        await wakeRoomAt(storage, transition.awaitingAfter + minutes * 60_000);
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "TEMPL_SUPPORT_FAILURE",
        route: "alert-emit",
        reason: "unreadable",
      }),
    );
  }
}

/** `applyCaseEvent` followed by the case alerts, for every site whose event
 * can open or reopen a request or start a new wait: a status change (team
 * or member reopen, "Did this solve it? No" through the member's reopen),
 * and "Ask the team again" after a stop. */
export async function applyCaseEventWithAlerts(
  storage: Tx,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: Parameters<typeof applyCaseEvent>[2],
  event: CaseEvent,
): Promise<CaseTransition> {
  const transition = await applyCaseEvent(storage, record, data, event, context.mediaEnv);
  await emitCaseAlerts(storage, context, record, event, transition);
  return transition;
}

/** After a team reply (person or agent): the unseen-reply check for a
 * signed member when a webhook asked for it. */
export async function emitReplyAlerts(
  storage: Tx,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: SupportRecord,
): Promise<void> {
  try {
    const env = envOf(context);
    if (!alertsEnabled(env)) return;
    if (context.canary && record.member === context.canary) return;
    const index = await readDestinationIndex(storage);
    const unseenWanted = index.some(
      (entry) =>
        entry.status === "active" &&
        entry.kind === "webhook" &&
        (entry.events as readonly string[]).includes("member.reply_unseen"),
    );
    // Signed members only: a guest's claimed wallet never makes a protocol
    // notify someone.
    if (
      unseenWanted &&
      data.wallet &&
      natural(data.caseSeq) &&
      data.caseSeq > 0
    )
      await storage.put(
        `${UNSEEN_DUE_PREFIX}${pad16(context.now + SUPPORT_ALERT_LIMITS.unseenReplyMs)}:${record.id}`,
        { replyAt: context.now, seq: data.caseSeq },
      );
    if (unseenWanted)
      await wakeRoomAt(
        storage,
        context.now + SUPPORT_ALERT_LIMITS.unseenReplyMs,
      );
  } catch {
    console.error(
      JSON.stringify({
        event: "TEMPL_SUPPORT_FAILURE",
        route: "alert-emit",
        reason: "unreadable",
      }),
    );
  }
}

/** The first refusal of a reason in a UTC day. Called by the refusal
 * wrapper after the day record is written, in its own transaction. */
export async function emitRefusalAlert(
  storage: Tx,
  env: AlertEnv,
  input: { reason: SupportRefusalReason; day: string; count: number },
  now: number,
) {
  try {
    await emitAlert(
      storage,
      env,
      {
        type: "refusal",
        at: now,
        reason: input.reason,
        refusal: { day: input.day, count: input.count },
      },
      now,
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "TEMPL_SUPPORT_FAILURE",
        route: "alert-emit",
        reason: "refusal",
      }),
    );
  }
}

/** What the outbox consumer reads at send time: the inbox footer, an
 * opted-in webhook's member block, and the manager's email when a channel
 * pauses after failing for three days. */
export function alertOutboxDeps(env: AlertEnv): OutboxDeps {
  return {
    footer: (storage) => inboxFooter(storage),
    member: (storage, thread) => alertMember(storage, thread),
    notifyPaused: async (storage, row, now) => {
      const native = await storage.get<{
        room?: { id?: string; manager?: string };
      }>("native-room");
      const manager = normalizeChatPrincipal(native?.room?.manager);
      if (!native?.room?.id || !manager || await templStaffAccount(storage, [manager], env)) return;
      await queueStaffNotification(storage, {
        now,
        room: `room:${native.room.id}`,
        appOrigin: env.APP_ORIGIN ?? "https://templ.vip",
        recipient: manager,
        kind: "workspace",
        conversation: null,
        pausedKind: row.kind,
      }, env);
    },
  };
}
