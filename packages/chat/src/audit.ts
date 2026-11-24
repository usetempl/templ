import type { ChatPrincipalId } from "./principal";

/** Manager-only, append-only record of management and moderation actions.
 * Entries carry ids and metadata, never message text or chain amounts. */
export type ChatAuditAction =
  | "channel.create"
  | "channel.update"
  | "channel.archive"
  | "channel.delete"
  | "orderform.create"
  | "orderform.amend"
  | "orderform.end"
  | "orderform.activate"
  | "role.save"
  | "role.assign"
  | "team-invite.create"
  | "team-invite.revoke"
  | "team-invite.redeem"
  | "moderator.set"
  | "mute"
  | "ban"
  | "message.delete"
  | "message.pin"
  | "appearance"
  // The workspace's name and icon.
  | "room.profile"
  | "manager.nominate"
  | "manager.accept"
  | "visibility"
  // Bot registry
  | "bot.register"
  | "bot.remove"
  | "bot.commands"
  // Channel sections
  | "channel-group.create"
  | "channel-group.update"
  | "channel-group.delete"
  // Section access and the whole channel order
  | "channel-group.access"
  | "channel.order"
  // Team conversations. Metadata only, never message text.
  | "conversation.open"
  | "conversation.start"
  | "conversation.resolve"
  | "conversation.reopen"
  | "conversation.stop"
  | "conversation.resume"
  | "conversation.denied"
  | "conversation.claim"
  | "conversation.release"
  | "conversation.takeover"
  // A widget guest proved a wallet: the thread moved to it, or was linked
  // to that wallet's existing thread. Target is the guest account id.
  | "conversation.transfer"
  | "conversation.link"
  | "support.settings"
  | "support.assign"
  | "support.verification"
  // Stored transaction action IDs, never calls.
  | "transaction.shared"
  | "transaction.removed"
  // Stored wallet action hashes.
  | "safe.link"
  | "safe.unlink"
  | "safe.propose"
  | "safe.confirm"
  | "squads.link"
  | "squads.unlink"
  // Widget settings: before/after approved origin lists (public URLs) and
  // the level a request needs ("anyone" | "connected" | "signed").
  | "widget.origins"
  | "widget.level"
  | "widget.wallet-fallback"
  | "widget.wallet-identification"
  | "widget.ask-person"
  | "widget.hosted-page"
  // Remembered widget sign-in turned on or off ({remember}), every member
  // signed out of the widget ({rememberEpoch, reason}), and the visitor
  // check for guests ({guestCheck}). Settings only, never a credential.
  | "widget.remember"
  | "widget.sessions-ended"
  | "widget.guest-check"
  // The widget's "We never DM you first." line turned on or off
  // ({safetyLine}).
  | "widget.safety-line"
  // Appearance settings changed. Revision numbers only, never notice text or URLs.
  | "widget.appearance"
  // Public question count and reply estimate only, never question text.
  | "widget.intro"
  // Frame mode required or not ({frameRequired}), and the verified domains
  // the widget may show ({domains}: domain names only).
  | "widget.frame"
  | "widget.domain"
  // A staff member or the member started a chat download.
  | "conversation.export"
  // Saved replies: after {op: "create" | "update" | "remove"}, target the
  // reply id. Notes: target the note id, after {mentions: number}. Never text.
  | "support.replies"
  | "support.note"
  // Integration and agent settings.
  | "integration.create"
  | "integration.update"
  | "integration.remove"
  | "integration.test"
  | "integration.pause"
  | "agent.enable"
  | "agent.update"
  | "agent.pause"
  | "agent.disable"
  // Export, deletion, incident and staff read-log actions.
  // The manager's workspace export: after {op: "start", exportId, notes,
  // asOf} or {op: "done", exportId, threads, messages, notes, skipped}.
  | "workspace.export"
  | "workspace.flag"
  // Workspace deletion: after {dueAt} on request, the manager's cancel and
  // the start of the purge. Ids and times only.
  | "workspace.deletion-requested"
  | "workspace.deletion-cancelled"
  | "workspace.deletion-started"
  // The staff read log (reads stream): a team principal opened a chat or a
  // screenshot, searched the inbox or kept the inbox feed open. Ids, counts
  // and a search kind; never message or search text.
  | "support.read"
  | "support.search"
  | "support.feed"
  // Follow-ups and the Specialist role. Ids, codes and
  // field names only, never a title, member line, note or link.
  // A follow-up was created, changed, taken or released: target the
  // follow-up id, after {op, state?, type?, source?, changed?}.
  | "support.follow-up"
  // Access stream: a follow-up's owner changed (ownership is a specialist's
  // access), routing groups or rules changed, a specialist first read a
  // request today, was mentioned on one, or a person ended that access.
  | "support.follow-up.owner"
  | "support.follow-up.settings"
  | "support.specialist.read"
  | "support.specialist.mention"
  | "support.specialist.end"
  // Case archive events.
  // Audit rows contain no member text.
  | "support.case.archived"
  // Safety refusals, redaction and import counts.
  // Values and message text stay out.
  // Current author kind and refusal kind explain a refused team write.
  | "support.text.refused"
  | "support.hex.redacted"
  | "support.replies.import"
  | "support.pilot";
/** Read-only action names. Writers reject them; Activity shows a generic change. */
export const RETIRED_AUDIT_ACTIONS = [
  "channel.create",
  "channel.update",
  "channel.archive",
  "channel.delete",
  "channel.order",
  "channel-group.create",
  "channel-group.update",
  "channel-group.delete",
  "channel-group.access",
  "message.pin",
  "moderator.set",
  "visibility",
  "bot.commands",
  "conversation.denied",
  "transaction.shared",
  "transaction.removed",
  "safe.link",
  "safe.unlink",
  "safe.propose",
  "safe.confirm",
  "squads.link",
  "squads.unlink",
] as const satisfies readonly ChatAuditAction[];
export type ChatAuditEntry = {
  /** Room-monotonic decimal sequence; compare with BigInt. */
  id: string;
  at: string;
  actor: ChatPrincipalId;
  /** Proof time for a privileged change, separate from its commit time. */
  authenticatedAt?: string;
  action: ChatAuditAction;
  target?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  before?: unknown;
  after?: unknown;
};
export type ChatAuditPage = {
  entries: ChatAuditEntry[];
  nextBefore: string | null;
};
export const MAX_AUDIT_PAGE = 50;
/** The chats stream: conversation, message and other workspace activity. */
export const AUDIT_RETENTION = {
  count: 2000,
  ms: 90 * 24 * 60 * 60_000,
} as const;
/** Three logs, each with its own ids, cursors and retention, so chat volume
 * never pushes access changes out and reads never push out either. */
export type AuditStream = "access" | "chats" | "reads";
/** The access stream: who holds which powers and how the workspace is set up. */
export const ACCESS_AUDIT_RETENTION = {
  count: 10_000,
  ms: 365 * 24 * 60 * 60_000,
} as const;
const ACCESS_ACTIONS: ReadonlySet<ChatAuditAction> = new Set<ChatAuditAction>([
  "orderform.create",
  "orderform.amend",
  "orderform.end",
  "orderform.activate",
  "role.save",
  "role.assign",
  "team-invite.create",
  "team-invite.revoke",
  "team-invite.redeem",
  "moderator.set",
  "manager.nominate",
  "manager.accept",
  "visibility",
  "room.profile",
  "bot.register",
  "bot.remove",
  "bot.commands",
  "mute",
  "ban",
  "support.settings",
  "support.replies",
  // Import counts use the saved-reply settings stream.
  // The audit contains counts and no imported text.
  "support.replies.import",
  "widget.origins",
  "widget.level",
  "widget.wallet-fallback",
  "widget.wallet-identification",
  "widget.ask-person",
  "widget.hosted-page",
  "widget.remember",
  "widget.sessions-ended",
  "widget.guest-check",
  "widget.safety-line",
  "widget.appearance",
  "widget.intro",
  "widget.frame",
  "widget.domain",
  "conversation.export",
  "integration.create",
  "integration.update",
  "integration.remove",
  "integration.test",
  "integration.pause",
  "agent.enable",
  "agent.update",
  "agent.pause",
  "agent.disable",
  "support.pilot",
  "workspace.export",
  "workspace.flag",
  "workspace.deletion-requested",
  "workspace.deletion-cancelled",
  "workspace.deletion-started",
  // Who can read which request through a follow-up.
  "support.follow-up.owner",
  "support.follow-up.settings",
  "support.specialist.read",
  "support.specialist.mention",
  "support.specialist.end",
]);
/** The reads stream: the staff read log. The manager
 * sees the newest 20,000 reads from the last 90 days. */
export const READ_AUDIT_RETENTION = {
  count: 20_000,
  ms: 90 * 24 * 60 * 60_000,
} as const;
/** One read log entry per principal and chat (or feed) per 30 minutes. */
export const READ_LOG_COALESCE_MS = 30 * 60_000;
export const READ_AUDIT_ACTIONS: ReadonlySet<ChatAuditAction> =
  new Set<ChatAuditAction>(["support.read", "support.search", "support.feed"]);
export function auditStream(action: ChatAuditAction): AuditStream {
  return READ_AUDIT_ACTIONS.has(action)
    ? "reads"
    : ACCESS_ACTIONS.has(action)
      ? "access"
      : "chats";
}
