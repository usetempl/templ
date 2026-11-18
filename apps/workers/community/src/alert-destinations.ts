/** Alert destinations: the stored record, the target rules per kind and the
 * masked text the manager sees. Pure; node-tested. The record holds the
 * target only encrypted (alert-crypto.ts). */
import {
  ALERT_SUMMARY_MINUTES,
  SUPPORT_ALERT_DESTINATIONS,
  SUPPORT_ALERT_LIMITS,
  checkedAlertEvents,
  type AlertDestinationStatus,
  type AlertDestinationView,
  type AlertPauseReason,
  type AlertSubscribableEvent,
  type AlertSummaryMinutes,
  type SupportAlertDestination,
} from "@templ/chat/support-alerts";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { servicePrincipals } from "./service-principals";
import { checkPublicHttpsUrl, SafeFetchRefused } from "./safe-fetch";
import type { AlertSecretBox } from "./alert-crypto";

export const DEST_PREFIX = "alert-dest-v1:";
export const DEST_INDEX_KEY = "alert-dest-index-v1";
export const DEST_ID = /^ad-[0-9a-f]{16}$/;

/** What each kind keeps encrypted. */
export type AlertTarget =
  | { kind: "slack"; url: string }
  | { kind: "discord"; url: string }
  | { kind: "telegram"; token: string; chatId: string; threadId?: number }
  | {
      kind: "webhook";
      url: string;
      secrets: { id: string; value: string; notAfter?: number }[];
    };

export type AlertDestinationRecord = {
  v: 1;
  id: string;
  kind: SupportAlertDestination;
  label: string;
  events: AlertSubscribableEvent[];
  summaryMinutes: AlertSummaryMinutes;
  /** Webhooks only; false for every other kind. */
  walletContext: boolean;
  secret: AlertSecretBox;
  /** The masked target, computed at save. */
  hint: string;
  status: AlertDestinationStatus;
  pausedReason?: AlertPauseReason;
  /** The human who approved it. Delegated approval also binds the current owner. */
  approvedBy: ChatPrincipalId;
  approvalOwner?: ChatPrincipalId;
  approvalAliases?: ChatPrincipalId[];
  approvedAt: number;
  createdAt: number;
  updatedAt: number;
  /** Telegram: the pending six-digit confirmation. */
  verify?: { codeHash: string; expiresAt: number; attempts: number };
  lastSentAt?: number;
  lastOkAt?: number;
  lastFailure?: { at: number; status: number | null; reason: string };
  failingSince?: number;
  consecutiveFailures: number;
  leaseUntil?: number;
};
export type DestinationIndexEntry = {
  id: string;
  kind: SupportAlertDestination;
  events: AlertSubscribableEvent[];
  status: AlertDestinationStatus;
};

export class AlertTargetInvalid extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = "AlertTargetInvalid";
  }
}
const invalid = (message: string): never => {
  throw new AlertTargetInvalid(message);
};

const SLACK_PATH = /^\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/;
const DISCORD_HOSTS = [
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
];
const DISCORD_PATH = /^\/api\/(?:v\d+\/)?webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,80}$/;
const TELEGRAM_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,50}$/;
const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

function strictUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2_048) invalid("Paste the full https address.");
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return invalid("Paste the full https address.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    invalid("Paste the full https address.");
  return url;
}

/** The target for a kind from the manager's form fields, or
 * `AlertTargetInvalid` with the sentence to show. */
export function checkedTarget(
  kind: SupportAlertDestination,
  input: Record<string, unknown>,
  options: { workersDevSubdomain?: string } = {},
): AlertTarget {
  if (kind === "slack") {
    const url = strictUrl(input.url);
    if (url.hostname !== "hooks.slack.com" || !SLACK_PATH.test(url.pathname) || url.search || url.hash)
      invalid("Paste a Slack incoming webhook address that starts with https://hooks.slack.com/services/.");
    return { kind, url: url.toString() };
  }
  if (kind === "discord") {
    const url = strictUrl(input.url);
    if (!DISCORD_HOSTS.includes(url.hostname) || !DISCORD_PATH.test(url.pathname) || url.search || url.hash)
      invalid("Paste a Discord channel webhook address that starts with https://discord.com/api/webhooks/.");
    return { kind, url: url.toString() };
  }
  if (kind === "telegram") {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
    if (!TELEGRAM_TOKEN.test(token)) invalid("Paste the bot token @BotFather gave you.");
    if (!TELEGRAM_CHAT.test(chatId)) invalid("Enter the group's chat id, such as -1001234567890.");
    const threadId = input.threadId;
    if (
      threadId !== undefined &&
      threadId !== null &&
      !(Number.isSafeInteger(threadId) && (threadId as number) > 0)
    )
      invalid("Enter the topic id as a whole number, or leave it empty.");
    return {
      kind,
      token,
      chatId,
      ...(typeof threadId === "number" ? { threadId } : {}),
    };
  }
  if (kind === "webhook") {
    let url: URL;
    try {
      url = checkPublicHttpsUrl(String(input.url ?? ""), {
        allowQuery: true,
        workersDevSubdomain: options.workersDevSubdomain,
      });
    } catch (error) {
      if (error instanceof SafeFetchRefused)
        invalid(
          error.reason === "not-https"
            ? "Use an https address on port 443 with no user name or password."
            : "Use a public https address on your own server. Local, private and Templ addresses aren't allowed.",
        );
      throw error;
    }
    return { kind, url: url!.toString(), secrets: [] };
  }
  return invalid("Choose Slack, Discord, Telegram or a webhook.");
}

/** What the list shows for a target: never the secret part. */
export function maskedTarget(target: AlertTarget, display?: string): string {
  if (target.kind === "telegram")
    return display ? `Telegram: ${display.slice(0, 40)}` : "Telegram group";
  const url = new URL(target.url);
  if (target.kind === "slack") {
    const channel = url.pathname.split("/")[3] ?? "";
    return `hooks.slack.com/…/${channel.slice(0, 4)}…${channel.slice(-3)}`;
  }
  if (target.kind === "discord") {
    const id = url.pathname.split("/").at(-2) ?? "";
    return `discord.com/…/${id.slice(0, 4)}…${id.slice(-3)}`;
  }
  return `${url.hostname}/…`;
}

/** A label is plain text the manager chose, at most 40 characters. */
export function checkedLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (
    !label ||
    [...label].length > SUPPORT_ALERT_LIMITS.labelChars ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f<>]/.test(label)
  )
    invalid(`Name this channel in ${SUPPORT_ALERT_LIMITS.labelChars} characters or fewer.`);
  return label;
}
export function checkedSummaryMinutes(value: unknown): AlertSummaryMinutes {
  if (value === undefined) return 0;
  if (!(ALERT_SUMMARY_MINUTES as readonly unknown[]).includes(value))
    invalid("Choose off, 30 minutes or 1 hour for waiting summaries.");
  return value as AlertSummaryMinutes;
}

const PAUSE_REASONS: readonly AlertPauseReason[] = [
  "manager-paused",
  "manager-changed",
  "failing",
  "provider-disabled",
  "secret-unreadable",
  "unreadable",
  "unverified-expired",
];
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const optionalNatural = (value: unknown) => value === undefined || natural(value);

/** A stored destination row, checked field by field; null when any field
 * fails, so an unreadable row is never sent. */
export function checkedDestination(value: unknown, id?: string): AlertDestinationRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as AlertDestinationRecord;
  if (
    row.v !== 1 ||
    typeof row.id !== "string" ||
    !DEST_ID.test(row.id) ||
    (id !== undefined && row.id !== id) ||
    !SUPPORT_ALERT_DESTINATIONS.includes(row.kind) ||
    typeof row.label !== "string" ||
    typeof row.hint !== "string" ||
    typeof row.walletContext !== "boolean" ||
    (row.walletContext && row.kind !== "webhook") ||
    !checkedAlertEvents(row.events, row.kind, row.walletContext) ||
    !(ALERT_SUMMARY_MINUTES as readonly unknown[]).includes(row.summaryMinutes) ||
    !row.secret ||
    row.secret.kv !== 1 ||
    typeof row.secret.iv !== "string" ||
    typeof row.secret.ct !== "string" ||
    !["unverified", "active", "paused"].includes(row.status) ||
    (row.pausedReason !== undefined && !PAUSE_REASONS.includes(row.pausedReason)) ||
    (row.status === "paused") !== (row.pausedReason !== undefined) ||
    !normalizeChatPrincipal(row.approvedBy) ||
    (row.approvalOwner !== undefined && (!normalizeChatPrincipal(row.approvalOwner) ||
      !Array.isArray(row.approvalAliases) || row.approvalAliases.length < 1 || row.approvalAliases.length > 2 ||
      !row.approvalAliases.includes(row.approvedBy) || row.approvalAliases.some(id => normalizeChatPrincipal(id) !== id))) ||
    (row.approvalAliases !== undefined && row.approvalOwner === undefined) ||
    !natural(row.approvedAt) ||
    !natural(row.createdAt) ||
    !natural(row.updatedAt) ||
    !natural(row.consecutiveFailures) ||
    !optionalNatural(row.lastSentAt) ||
    !optionalNatural(row.lastOkAt) ||
    !optionalNatural(row.failingSince) ||
    !optionalNatural(row.leaseUntil) ||
    (row.verify !== undefined &&
      (typeof row.verify?.codeHash !== "string" ||
        !natural(row.verify.expiresAt) ||
        !natural(row.verify.attempts)))
  )
    return null;
  if (row.approvalOwner !== undefined) {
    try { servicePrincipals(row.approvedBy, row.approvalAliases); }
    catch { return null; }
  }
  return row;
}

const iso = (at: number) => new Date(at).toISOString();
export function destinationView(
  row: AlertDestinationRecord,
  overflow: { count: number; since: number } | null,
  override?: { status: AlertDestinationStatus; pausedReason?: AlertPauseReason },
): AlertDestinationView {
  const status = override?.status ?? row.status;
  const pausedReason = override ? override.pausedReason : row.pausedReason;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    target: row.hint,
    status,
    ...(pausedReason ? { pausedReason } : {}),
    events: row.events,
    summaryMinutes: row.summaryMinutes,
    ...(row.kind === "webhook" ? { walletContext: row.walletContext } : {}),
    createdAt: iso(row.createdAt),
    lastDeliveredAt: row.lastOkAt ? iso(row.lastOkAt) : null,
    lastFailure: row.lastFailure
      ? {
          at: iso(row.lastFailure.at),
          status: row.lastFailure.status,
          reason: row.lastFailure.reason,
        }
      : null,
    overflow: overflow && overflow.count > 0 ? { count: overflow.count, since: iso(overflow.since) } : null,
  };
}
/** An unreadable row still shows, as paused, so the manager can remove it. */
export function unreadableView(id: string): AlertDestinationView {
  return {
    id,
    kind: "webhook",
    label: "Unreadable channel",
    target: "",
    status: "paused",
    pausedReason: "unreadable",
    events: [],
    summaryMinutes: 0,
    createdAt: new Date(0).toISOString(),
    lastDeliveredAt: null,
    lastFailure: null,
    overflow: null,
  };
}
export function indexEntry(row: AlertDestinationRecord): DestinationIndexEntry {
  return { id: row.id, kind: row.kind, events: row.events, status: row.status };
}
export function newDestinationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `ad-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
