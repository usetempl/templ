/** Team alerts: destinations, event types and payload shapes. Alerts carry
 * no message text, and chat destinations carry no wallet.
 *
 * Browser-safe: this module imports types only. The worker's outbox,
 * renderers and routes, the web Alerts page and the agent client read these
 * names. Operating bounds that are also offer terms (destinations per
 * workspace, pending events, deliveries per day) live in `feature-limits.ts`
 * as `alertDestinationsPerWorkspace`, `alertPendingEvents` and
 * `alertDeliveriesPerDay`; the worker reads them there. */

import type { SupportHandoffBy, SupportHandoffReason } from "./support";
import type { ProductBillingAlert } from "./product-catalog";

/** Alert destinations, in the order they ship. Each has its own release
 * flag under `supportAlerts` in v4-release.json. */
export const SUPPORT_ALERT_DESTINATIONS = [
  "webhook",
  "slack",
  "discord",
  "telegram",
] as const;
export type SupportAlertDestination =
  (typeof SUPPORT_ALERT_DESTINATIONS)[number];
/** Slack, Discord and Telegram: team chats other people and bots can read,
 * so their alerts carry no wallet, name or message text. */
export const SUPPORT_ALERT_CHAT_DESTINATIONS = [
  "slack",
  "discord",
  "telegram",
] as const satisfies readonly SupportAlertDestination[];

/** Every alert event. Follow-up events come from the follow-up timers;
 * `ping` is a manager's test and `overflow` tells a webhook how many events
 * were not sent. */
export const ALERT_EVENT_TYPES = [
  "request.new",
  "request.reopened",
  "request.handoff",
  "request.escalated",
  "request.waiting",
  "follow-up.assigned",
  "follow-up.due",
  "follow-up.overdue",
  "follow-up.escalated",
  "follow-up.update-missed",
  "follow-up.done",
  "refusal",
  "capacity",
  "member.reply_unseen",
  "ping",
  "overflow",
] as const;
export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];
/** Reserved for transaction diagnosis; not accepted in subscriptions until
 * it ships. */
export type ReservedAlertEventType = "diagnosis.ready";
/** What a destination can subscribe to. `ping` and `overflow` always go. */
export const ALERT_SUBSCRIBABLE_EVENTS = ALERT_EVENT_TYPES.filter(
  (type) => type !== "ping" && type !== "overflow",
) as readonly Exclude<AlertEventType, "ping" | "overflow">[];
export type AlertSubscribableEvent = (typeof ALERT_SUBSCRIBABLE_EVENTS)[number];
/** `member.reply_unseen` names a member, so only a webhook with the wallet
 * option may take it; team chats never do. */
export const ALERT_CHAT_EVENTS = ALERT_SUBSCRIBABLE_EVENTS.filter(
  (type) => type !== "member.reply_unseen",
);
/** Defaults for a new Slack, Discord or Telegram channel. */
export const ALERT_CHAT_DEFAULT_EVENTS: readonly AlertSubscribableEvent[] = [
  "request.new",
  "request.reopened",
  "request.handoff",
  "request.escalated",
  "follow-up.overdue",
  "refusal",
  "capacity",
];
/** Defaults for a new webhook: everything except the member notice. */
export const ALERT_WEBHOOK_DEFAULT_EVENTS: readonly AlertSubscribableEvent[] =
  ALERT_SUBSCRIBABLE_EVENTS.filter((type) => type !== "member.reply_unseen");

/** Operating bounds of the outbox and its timers, not offer terms. */
export const SUPPORT_ALERT_LIMITS = {
  perKind: { slack: 3, discord: 3, telegram: 3, webhook: 5 },
  pendingPerDestination: 500,
  chatWindowMs: 60_000,
  chatDeadlineMs: 6 * 3_600_000,
  webhookDeadlineMs: 24 * 3_600_000,
  webhookPayloadBytes: 16_384,
  labelChars: 40,
  logDays: 7,
  logEntriesPerDestination: 1_000,
  testsPerHour: 10,
  createsPerDay: 20,
  telegramCodeMs: 15 * 60_000,
  telegramCodeAttempts: 5,
  secretRotationMs: 24 * 3_600_000,
  failingPauseMs: 72 * 3_600_000,
  memberReplyDelayMs: 2 * 60_000,
  memberReplyBucketMs: 30 * 60_000,
  unseenReplyMs: 10 * 60_000,
} as const;

/** "Alert the team when a request waits longer than": 0 is off. */
export const ALERT_ESCALATION_MINUTES = [0, 5, 15, 30, 60, 120] as const;
export type AlertEscalationMinutes = (typeof ALERT_ESCALATION_MINUTES)[number];
export const ALERT_ESCALATION_DEFAULT_MINUTES: AlertEscalationMinutes = 30;
/** Waiting summaries for one destination: 0 is off. */
export const ALERT_SUMMARY_MINUTES = [0, 30, 60] as const;
export type AlertSummaryMinutes = (typeof ALERT_SUMMARY_MINUTES)[number];

export type AlertPauseReason =
  | "manager-paused"
  | "manager-changed"
  | "failing"
  | "provider-disabled"
  | "secret-unreadable"
  | "unreadable"
  | "unverified-expired";
export type AlertDestinationStatus = "unverified" | "active" | "paused";
/** What the manager's Alerts page shows for one destination. It never
 * holds a URL, token, chat id or secret. */
export type AlertDestinationView = {
  /** "ad-" + 16 hex. */
  id: string;
  kind: SupportAlertDestination;
  label: string;
  /** Masked: "hooks.slack.com/…/B07Q…9ZK", "Telegram: Support team",
   * "hooks.example.org/…". */
  target: string;
  status: AlertDestinationStatus;
  pausedReason?: AlertPauseReason;
  events: AlertSubscribableEvent[];
  summaryMinutes: AlertSummaryMinutes;
  /** Webhooks only. */
  walletContext?: boolean;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastFailure: { at: string; status: number | null; reason: string } | null;
  overflow: { count: number; since: string } | null;
};
export type AlertLogOutcome =
  | "delivered"
  | "retrying"
  | "failed"
  | "expired"
  | "skipped";
export type AlertLogEntry = {
  at: string;
  event: AlertEventType;
  attempt: number;
  outcome: AlertLogOutcome;
  /** HTTP status; null for network errors and skips. */
  status: number | null;
  ms: number | null;
  /** A fixed label ("timeout", "redirect", "rate-limited", "paused", …). */
  reason: string | null;
};
/** `GET /conversations/integrations` (manager only). */
export type AlertsView = {
  /** False while `SUPPORT_ALERTS_ENABLED` is off or the key is missing:
   * the list still shows, and create, test and resume answer 503. */
  available: boolean;
  destinations: AlertDestinationView[];
  escalateAfterMinutes: AlertEscalationMinutes;
  limits: { destinations: number; perKind: Record<SupportAlertDestination, number> };
  /** Emails not queued today because the email queue was full. */
  emailOverflowToday?: number;
};
/** `GET /conversations/escalation` (the team): the escalation target the
 * inbox shows as "Past your {n} min target". */
export type AlertEscalationView = { escalateAfterMinutes: AlertEscalationMinutes };
/** The one-time answer of a webhook `create` or `rotate`. */
export type AlertSigningSecret = { signingSecret: string };

/** The stored fields an alert event may carry. Nothing here is text a
 * person wrote, and nothing identifies the member. */
export type AlertEventFacts = {
  identity?: import("./support-identity").SupportIdentity;
  type: AlertEventType;
  /** Epoch ms. */
  at: number;
  /** The request (tc- id) and its case number. */
  case?: { thread: string; seq: number };
  reason?: SupportHandoffReason | string;
  by?: SupportHandoffBy;
  /** Escalation level: 1 to the assignee or the team, 2 to everyone. */
  level?: 1 | 2;
  waitingSince?: number;
  followUp?: { id: string; type: string; dueAt?: number };
  /** A billing alert: the code only, never an amount. */
  capacity?: { alert: ProductBillingAlert };
  refusal?: { day: string; count: number };
  /** Counts of events a webhook did not get, by type. */
  overflow?: { count: number; since: number; byType: Partial<Record<AlertEventType, number>> };
  /** A listed test account or a staff preview. */
  test?: true;
};

/** Addresses in webhooks are CAIP-10: `eip155:<chain>:<0x…>` or
 * `solana:<genesis prefix>:<base58>`. */
export type AlertWebhookMember = {
  identity?: import("./support-identity").SupportIdentity;
  identityLabel?: string;
  wallet: { account: string; verified: boolean } | null;
  /** CAIP-2 network when the member named one. */
  transactions: { network?: string; hash: string }[];
};
/** A signed webhook's JSON body (Standard Webhooks). `member` appears only
 * when the endpoint turned wallet details on. */
export type AlertWebhookBody = {
  type: AlertEventType;
  timestamp: string;
  data: {
    workspace: string;
    event: string;
    request?: {
      id: string;
      case: number;
      identity?: import("./support-identity").SupportIdentity;
      identityLabel?: string;
      reason?: string;
      by?: SupportHandoffBy;
      level?: 1 | 2;
      waitingSince?: string;
      test: boolean;
    };
    followUp?: { id: string; type: string; dueAt?: string };
    capacity?: { alert: string };
    refusal?: { reason: string; day: string; count: number };
    overflow?: { count: number; since: string; byType: Record<string, number> };
    inbox?: { needsReply: number; oldestWaitingSince: string | null };
    link: string;
    member?: AlertWebhookMember;
  };
};

/** The Templ page a signed member opens from the widget to get reply
 * emails. The grant it holds reads no thread. */
export type MemberAlertView = {
  workspaceName: string;
  emailVerified: boolean;
  emailMasked: string | null;
  enabled: boolean;
};

/** Checks a subscription list for a destination kind. Returns the sorted,
 * de-duplicated list or null. `member.reply_unseen` needs a webhook with
 * wallet details on. */
export function checkedAlertEvents(
  value: unknown,
  kind: SupportAlertDestination,
  walletContext: boolean,
): AlertSubscribableEvent[] | null {
  if (!Array.isArray(value) || value.length > ALERT_SUBSCRIBABLE_EVENTS.length)
    return null;
  const allowed: readonly string[] =
    kind === "webhook" ? ALERT_SUBSCRIBABLE_EVENTS : ALERT_CHAT_EVENTS;
  const events = new Set<AlertSubscribableEvent>();
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry)) return null;
    events.add(entry as AlertSubscribableEvent);
  }
  if (events.has("member.reply_unseen") && !walletContext) return null;
  return ALERT_SUBSCRIBABLE_EVENTS.filter((type) => events.has(type));
}
