import {
  ACCESS_AUDIT_RETENTION,
  AUDIT_RETENTION,
  type AuditStream,
  type ChatAuditAction,
} from "@templ/chat/audit";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { SUPPORT_LIMITS, SUPPORT_REFUSAL_POLICY } from "@templ/chat/support";
import { listText } from "./operator";
import { BUILD_RELEASE, type PublicRelease } from "./release-public";
import { capabilityVerified } from "./support-availability";

/** Facts the Trust page, Privacy and the retention inventory state. Each one
 * mirrors code that runs today. trust-facts.test.ts reads the worker source,
 * wrangler.toml and the widget as text and fails when a value here drifts. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Worker constants, by the file and name the drift test reads. */
export const WORKER_FACTS = {
  /** common.ts SESSION_TTL */
  appSessionMs: 30 * DAY,
  /** common.ts NONCE_TTL */
  signInChallengeMs: 5 * MINUTE,
  /** support-widget.ts SESSION_MS */
  widgetSessionMs: HOUR,
  /** support-widget.ts GUEST_TTL */
  guestCredentialMs: 90 * DAY,
  /** team-conversations.ts DAY_MS: the rolling window of guest chats */
  guestNetworkWindowMs: DAY,
  /** team-conversations.ts GUEST_OPENS_PER_IP_PER_DAY */
  guestChatsPerNetworkPerDay: 60,
  /** message-store.ts MAX_MESSAGE_REVISIONS */
  messageRevisions: 10,
  /** message-store.ts MESSAGE_HISTORY_RETENTION_MS */
  messageHistoryMs: 90 * DAY,
  /** safety.ts REPORT_RETENTION_MS */
  reportMs: 90 * DAY,
  /** feedback-store.ts RETIRED_CONTACT.retentionDays */
  oldContactRequestDays: 365,
  /** message-retries.ts MESSAGE_RETRY_WINDOW_MS: how long a turned-away
   * request's retry ID stays, so a retry counts once */
  refusalRetryIdMs: 7 * DAY,
} as const;

/** What a handoff stores (support-handoff.ts StoredHandoff), by field. A
 * member's Talk to a person is a handoff; writeHandoff also adds an activity
 * entry naming the member's account and a case event with the time and
 * reason, and the person-requests row and Privacy say so. */
export const HANDOFF_FIELDS = {
  at: "the time",
  reason: "a reason code",
  by: "who asked",
  requestAt: "the case it is for",
} as const;

/** Browser-side limits in apps/web: support-local-state.ts MAX_AGE and
 * MAX_ENTRIES, and the widget's 7-day draft check in support-widget.ts. */
export const DEVICE_FACTS = {
  draftDays: 7,
  appDraftEntries: 50,
  /** support-widget-live.ts DAY: how long a waiting visitor's widget keeps
   * checking for replies after a reload. */
  replyCheckDays: 1,
} as const;

/** The only wallet methods the widget calls on an EVM wallet. The drift test
 * compares this with the literals in support-widget.ts, the built
 * support-widget.js and every chunk it loads. */
export const WIDGET_WALLET_METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "personal_sign",
] as const;
/** The only Wallet Standard features the widget uses on a Solana wallet,
 * compared the same way. */
export const WIDGET_SOLANA_WALLET_FEATURES = [
  "standard:connect",
  "standard:events",
  "solana:signMessage",
] as const;
/** What the widget calls on a wallet-adapter style Solana wallet instead. */
export const WIDGET_SOLANA_ADAPTER_METHODS = [
  "connect",
  "signMessage",
] as const;

export const days = (ms: number) => Math.round(ms / DAY);
const minutes = (ms: number) => Math.round(ms / MINUTE);
const plural = (count: number, unit: string) =>
  `${count.toLocaleString("en-US")} ${unit}${count === 1 ? "" : "s"}`;
const duration = (ms: number) =>
  ms % DAY === 0
    ? plural(days(ms), "day")
    : ms % HOUR === 0
      ? plural(ms / HOUR, "hour")
      : plural(minutes(ms), "minute");

export type ProviderStatus = "live" | "by-order" | "configured-off" | "not-used" | "planned";
export const PROVIDER_STATUS_LABELS: Record<ProviderStatus, string> = {
  live: "Live",
  "by-order": "By workspace order",
  "configured-off": "Configured, off",
  "not-used": "Not used",
  planned: "Planned",
};
/** Anthropic availability follows the verified managed-agent gate. */
export function anthropicStatus(release: {
  managedAgentVerified?: boolean;
}): ProviderStatus {
  return release.managedAgentVerified === true ? "by-order" : "configured-off";
}
/** OpenAI availability follows the verified Templ support gate. */
export function openaiStatus(release: {
  templSupport?: { verified?: boolean } | null;
}): ProviderStatus {
  return release.templSupport?.verified === true ? "live" : "configured-off";
}
export type Provider = {
  id: string;
  name: string;
  /** What Templ uses it for, in one sentence. */
  purpose: string;
  /** What it receives. */
  data: string;
  status: ProviderStatus;
};

/** Provider state follows the request's verified public projection. */
export function providers(
  RELEASE: PublicRelease = BUILD_RELEASE,
): readonly Provider[] {
  const SUPPORT_NOTIFICATIONS_VERIFIED = capabilityVerified(
    "SUPPORT_NOTIFICATIONS_VERIFIED",
    RELEASE,
  );
  const TRANSACTION_CHECKS_VERIFIED = capabilityVerified(
    "TRANSACTION_CHECKS_VERIFIED",
    RELEASE,
  );
  const teamAlertsVerified =
    RELEASE.supportAlertsVerified === true &&
    (RELEASE.supportAlerts?.slack === true ||
      RELEASE.supportAlerts?.discord === true);

  /** Outside providers and their state in this release. */
  return [
    {
      id: "cloudflare",
      name: "Cloudflare",
      purpose:
        "Runs the site, support software, databases, private file storage and logs. Its AI Gateway routes enabled hosted model requests.",
      data: "Stored service data and network details. For requests through AI Gateway, permitted model inputs, outputs and usage metadata.",
      status: "live",
    },
    {
      id: "alchemy",
      name: "Alchemy",
      purpose:
        "Reads public blockchain data, such as a balance or a payment. Requests come from Templ's servers, not your browser.",
      data: "Public wallets and transaction details.",
      status: "live",
    },
    {
      id: "drpc",
      name: "dRPC",
      purpose:
        "Makes the same blockchain reads as a second source. Templ uses an answer only when both agree.",
      data: "Public wallets and transaction details.",
      status: "live",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      purpose: "Generates answers or drafts for an existing workspace when its order specifies Anthropic and managed AI is enabled.",
      data: "Relevant case messages, selected context and knowledge for enabled AI. Improvement copies never go to Anthropic.",
      status: anthropicStatus(RELEASE),
    },
    {
      id: "openai",
      name: "OpenAI",
      purpose:
        "Runs Templ’s own support AI. The new prepaid Templ AI route uses OpenAI when the workspace enables it and meets its service requirements. Existing workspaces follow their applicable orders.",
      data: "Selected case messages, checked transaction facts and approved knowledge. Improvement copies never go to OpenAI.",
      status: openaiStatus(RELEASE),
    },
    {
      id: "resend",
      name: "Resend",
      purpose:
        "Sends enabled sign-in codes, verification emails, support alerts and reply emails.",
      data: "The email address, a one-time code, confirmation links and case resume links. Never message text.",
      status:
        SUPPORT_NOTIFICATIONS_VERIFIED || RELEASE.emailSignInVerified === true
          ? "live"
          : "configured-off",
    },
    {
      id: "google-analytics",
      name: "Google Analytics",
      purpose:
        "Counts clicks on the landing page and in setup once it's on. It's off, so no Google code loads.",
      data: "Fixed event names and network details. No message text, wallets or chat links.",
      status: "configured-off",
    },
    {
      id: "solana-rpc",
      name: "Helius or Chainstack",
      purpose:
        "Checks stablecoin payments on Solana once checkout opens. Checkout is closed, and Solana sign-in needs no provider.",
      data: "Nothing today.",
      status: "not-used",
    },
    {
      id: "stripe",
      name: "Stripe",
      purpose: RELEASE.cardBillingVerified
        ? "Bills resolved cases by monthly card invoice. Card setup happens on Stripe."
        : "Monthly card billing is built and gated. It is not available yet.",
      data: "Stripe handles card details. Templ receives Stripe IDs, card brand, last 4 digits and invoice status.",
      status: RELEASE.cardBillingVerified ? "live" : "configured-off",
    },
    {
      id: "contract-sources",
      name: "Sourcify, Blockscout and Etherscan",
      purpose: TRANSACTION_CHECKS_VERIFIED
        ? "Look up a contract's published code to explain a transaction."
        : "Look up a contract's published code to explain a transaction, once transaction checks are on. Not used today.",
      data: "Contract addresses and chain IDs.",
      status: TRANSACTION_CHECKS_VERIFIED ? "live" : "not-used",
    },
    {
      id: "team-alerts",
      name: "Slack and Discord",
      purpose: teamAlertsVerified
        ? "Alerts your team in its own channel when a case needs a reply."
        : "Alerts your team in its own channel when a case needs a reply, once alerts are on. They are not on yet.",
      data: "That a case needs a reply. No message text.",
      status: teamAlertsVerified ? "live" : "not-used",
    },
  ];
}

export type RetentionRow = { id: string; what: string; howLong: string };

const history = PRODUCT_LIMITS.supportHistoryDays;
const entries = (count: number) => count.toLocaleString("en-US");
const refusalDays = SUPPORT_REFUSAL_POLICY.retentionDays;

/** How long each kind of data stays. Chat and request rules come from
 * plans.ts and support.ts, the activity log from audit.ts, and the rest from
 * WORKER_FACTS. */
export const RETENTION: readonly RetentionRow[] = [
  {
    id: "resolved-chats",
    what: "Resolved, abandoned and spam cases",
    howLong: `Deleted ${history} days after the last message`,
  },
  {
    id: "open-chats",
    what: "Open cases",
    howLong: "Kept",
  },
  {
    id: "legal-hold",
    what: "Cases under a legal hold approved by Templ, for a whole workspace or one case",
    howLong: `Kept while the hold applies. A hold stops an active deletion. Templ keeps the data that remains. Earlier versions of edited and deleted messages still go after ${days(WORKER_FACTS.messageHistoryMs)} days. The schedule above starts again when the hold ends`,
  },
  {
    id: "message-history",
    what: "Earlier versions of edited messages and the text of deleted ones",
    howLong: `Up to ${WORKER_FACTS.messageRevisions} versions per message, removed after ${days(WORKER_FACTS.messageHistoryMs)} days when the workspace next edits or deletes a message`,
  },
  {
    id: "request-records",
    what: "Times, counts and flags for each case, with no message text",
    howLong: `Deleted with the case, or ${history} days after the case was resolved if that comes first`,
  },
  {
    id: "person-requests",
    what: "A user's request for a person, from Talk to a person in the chat",
    howLong: `Saved as a handoff with ${listText(Object.values(HANDOFF_FIELDS))}. It stays open until a person replies or the case is resolved. The team's activity list shows the user's account and time until the case is deleted. The case records keep the time and code`,
  },
  {
    id: "ai-mode",
    what: "A case's AI mode, which only the team sees",
    howLong:
      "Deleted with the case, along with who or which rule set it, when and why",
  },
  {
    id: "activity-log",
    what: "Workspace activity log",
    howLong: `Access changes: ${days(ACCESS_AUDIT_RETENTION.ms)} days. Case activity: ${days(AUDIT_RETENTION.ms)} days. At most ${entries(ACCESS_AUDIT_RETENTION.count)} access changes and ${entries(AUDIT_RETENTION.count)} case entries stay. New entries remove older ones of the same kind`,
  },
  {
    id: "refusal-counts",
    what: "Counts of requests Templ turned away for a workspace, by day and reason, with no names, wallets or IP addresses",
    howLong: `${refusalDays} days. Older days go when the next refusal is counted`,
  },
  {
    id: "refusal-retry-ids",
    what: "The retry ID of a turned-away request, so a retry counts once",
    howLong: `${days(WORKER_FACTS.refusalRetryIdMs)} days. Older IDs go when the next refusal is counted`,
  },
  {
    id: "charge-records",
    what: "Resolved-case charges: times, state, price and a keyed user hash. No message text or wallet",
    howLong: `${history + 35} days after the case was resolved. Longer while it waits to go final or a dispute is open. Monthly totals stay with the workspace's balance`,
  },
  {
    id: "widget-refusal-counts",
    what: "Historical daily counts of refused widget opens, with no website or visitor details. New opens are no longer counted",
    howLong: `Kept until workspace deletion. Reports show at most ${refusalDays} days`,
  },
  {
    id: "app-session",
    what: "App sign-in",
    howLong: duration(WORKER_FACTS.appSessionMs),
  },
  {
    id: "sign-in-challenge",
    what: "One-time sign-in challenge",
    howLong: duration(WORKER_FACTS.signInChallengeMs),
  },
  {
    id: "email-sign-in-account",
    what: "Verified email sign-in account and keyed lookup records",
    howLong:
      "No automatic expiry is implemented. Retention depends on service needs and valid deletion requests",
  },
  {
    id: "widget-session",
    what: "Widget sign-in",
    howLong: `${duration(WORKER_FACTS.widgetSessionMs)}. The tab keeps a token in browser storage until it closes. Templ keeps a matching sign-in record on Templ's servers`,
  },
  {
    id: "guest-credential",
    what: "Guest credential that reopens a guest's case",
    howLong: `${duration(WORKER_FACTS.guestCredentialMs)} on Templ's servers. The browser keeps the credential and case ID until replacement or deletion. It stops working after ${duration(WORKER_FACTS.guestCredentialMs)}`,
  },
  {
    id: "guest-network",
    what: "Keyed one-way hash of a guest's IP address",
    howLong: `Counts for ${WORKER_FACTS.guestNetworkWindowMs / HOUR} hours toward the ${WORKER_FACTS.guestChatsPerNetworkPerDay} guest cases a day limit. Removed when the workspace next opens a guest case`,
  },
  {
    id: "drafts",
    what: "Unsent drafts on your device",
    howLong: `${DEVICE_FACTS.draftDays} days, at most ${DEVICE_FACTS.appDraftEntries} in the app`,
  },
  {
    id: "reply-check",
    what: "How long a waiting visitor's widget keeps checking for replies after a reload",
    howLong: `Up to ${duration(DEVICE_FACTS.replyCheckDays * DAY)}, as one time in the website's browser storage, with no message text`,
  },
  {
    id: "solve-declined",
    what: 'A "No, I still need help" answer to "Did this solve it?"',
    howLong:
      "Until cleared. The browser keeps the team reply ID for each case, with no message text",
  },
  {
    id: "after-send",
    what: 'Lines the widget shows after a send, such as "Received" or who replies next',
    howLong:
      "Only in the page's memory while it's open. The widget saves none of them",
  },
  {
    id: "agent-presence",
    what: "When the team's AI agent last checked in",
    howLong: `Only in the memory of Templ's servers, never saved, and forgotten when they restart. The agent counts as running for ${duration(SUPPORT_LIMITS.agentActiveMs)} after it checks in. Users see this only as "AI agent is typing"`,
  },
  {
    id: "reports",
    what: "Safety reports, with a copy of any reported message",
    howLong: `${days(WORKER_FACTS.reportMs)} days, longer while held for a legal case`,
  },
  {
    id: "old-contact-requests",
    what: "Stored contact requests",
    howLong: `${WORKER_FACTS.oldContactRequestDays} days after each arrived`,
  },
  {
    id: "count-logs",
    what: "Log lines for onboarding counts",
    howLong: "Up to 7 days in Cloudflare's logs",
  },
  {
    id: "no-expiry",
    what: "Staff roles, linked wallets, workspace settings and billing records",
    howLong:
      "No automatic age expiry. Enabled workspace deletion removes workspace roles and settings. Account wallet links and necessary billing records remain separately",
  },
];

export type ActivityLogRecord = {
  text: string;
  /** The actions in packages/chat/src/audit.ts behind the phrase. */
  actions: readonly ChatAuditAction[];
};
/** What each part of a workspace's activity log covers. `auditStream`
 * sends each action to its part: access changes read as "Access changes
 * cover ...", chat activity as "Chat activity covers ...". */
export const ACTIVITY_LOG_RECORDS: Record<
  Exclude<AuditStream, "reads">,
  readonly ActivityLogRecord[]
> = {
  access: [
    { text: "staff access", actions: ["role.save", "role.assign"] },
    { text: "AI agent labels", actions: ["bot.register", "bot.remove"] },
    {
      text: "manager handovers",
      actions: ["manager.nominate", "manager.accept"],
    },
    { text: "support settings", actions: ["support.settings"] },
    { text: "saved replies", actions: ["support.replies"] },
    { text: "widget settings", actions: ["widget.origins", "widget.level"] },
    { text: "case downloads", actions: ["conversation.export"] },
  ],
  chats: [
    { text: "assigning a case", actions: ["support.assign"] },
    {
      text: "resolving or reopening one",
      actions: ["conversation.resolve", "conversation.reopen"],
    },
    { text: "adding a note", actions: ["support.note"] },
    {
      text: "asking a user to verify a wallet",
      actions: ["support.verification"],
    },
    {
      text: "moving a guest case to a wallet",
      actions: ["conversation.transfer", "conversation.link"],
    },
    { text: "deleting someone else's message", actions: ["message.delete"] },
  ],
};
/** What it doesn't record yet. */
export const ACTIVITY_LOG_GAPS = [
  "reads",
  "status changes from the Status menu",
] as const;
