/** Alert text and bodies use types only. They cannot read support records
 * or messages. Lines use fixed codes, counts, times and validated links. */
import type {
  AlertEventFacts,
  AlertEventType,
  AlertWebhookBody,
  AlertWebhookMember,
  SupportAlertDestination,
} from "@templ/chat/support-alerts";
import type {
  SupportHandoffReason,
  SupportRefusalReason,
} from "@templ/chat/support";
import type { ProductBillingAlert } from "@templ/chat/product-catalog";

/** A queued event as stored (room-local, no text a person wrote). */
export type StoredAlertEvent = AlertEventFacts & { v: 1; id: string };
/** The inbox numbers a post ends with, read from the pulse at send time. */
export type AlertInboxFooter = {
  needsReply: number;
  oldestWaitingSince: number | null;
};

/** Staff labels, exhaustive so a new code fails the type check. */
const HANDOFF_LABELS: Record<SupportHandoffReason, string> = {
  quote: "Quote request",
  privacy: "Privacy or data request",
  account: "Account change",
  billing: "Billing or refund",
  legal: "Legal request",
  safety: "Security or safety",
  transaction: "Transaction problem",
  bug: "Possible bug",
  person: "Asked for a person",
  unsure: "The agent wasn't sure",
  other: "Other",
  strategy: "Strategy action",
  access: "Access or permission change",
  recovery: "Fund or account recovery",
  decision: "Needs a team decision",
  internal: "Needs internal information",
};
const REFUSAL_LABELS: Record<SupportRefusalReason, string> = {
  paused: "Support paused until a top-up",
  suspended: "Workspace suspended by Templ",
  "demo-limit": "Free ticket limit reached",
  "credit-limit": "Usage credit limit reached",
  "open-limit": "Open case limit reached",
  "record-limit": "Stored case limit reached",
  "daily-limit": "Daily new-case limit reached",
  "member-limit": "One user opened too many cases",
  "guest-limit": "Too many new guest chats from one network",
  "message-limit": "Message limit reached",
  "storage-busy": "Storage was catching up",
  "origin-not-approved": "Widget opened on a site you haven't approved",
};
/** Billing alerts in team channels: the code in words, never an amount. */
const BILLING_ALERT_LINES: Record<ProductBillingAlert, string> = {
  "invoice-failed": "Stripe could not collect an invoice. Support keeps running.",
  "used-80": "80% of the balance from the last top-up is used.",
  "used-100": "The available balance is used up. Support keeps running.",
  negative: "The balance is below zero.",
  "pause-soon": "The balance is close to the point where Support pauses.",
  paused: "Support is paused until someone adds balance.",
  "free-start-used": "The free resolved cases are used.",
  burst: "More cases were resolved today than usual.",
  runway: "The balance lasts under a week at the recent pace.",
  "grant-80": "Most of the credit's cases are used.",
  "grant-14d": "The credit ends within 14 days.",
  "grant-3d": "The credit ends within 3 days.",
  "budget-50": "This month's charges passed half of the budget.",
  "budget-80": "This month's charges passed 80% of the budget.",
  "budget-100": "This month's charges reached the budget.",
  suspended: "Templ suspended this workspace. Open cases stay answerable.",
  "price-change": "Templ published new prices. Billing managers have the date by email.",
};
/** A code without a label reads "Other", never the raw code. */
function label(table: Record<string, string>, code: unknown): string {
  if (typeof code === "string" && Object.hasOwn(table, code)) return table[code];
  console.warn(JSON.stringify({ event: "TEMPL_ALERT_LABEL_UNKNOWN" }));
  return "Other";
}
export const handoffLabel = (code: unknown) => label(HANDOFF_LABELS, code);
export const refusalLabel = (code: unknown) => label(REFUSAL_LABELS, code);

const MINUTE = 60_000;
/** "12 min", "3 h 5 min", "2 days". */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;

/** One line of a team-chat post. */
export function chatLine(event: StoredAlertEvent, now: number): string {
  const wait = event.waitingSince ? formatAge(now - event.waitingSince) : null;
  switch (event.type) {
    case "request.new":
      return event.test ? "New case (test)." : "New case.";
    case "request.reopened":
      return event.test ? "A case was reopened (test)." : "A case was reopened.";
    case "request.handoff":
      return `Needs a person: ${handoffLabel(event.reason)}. ${
        event.by === "agent"
          ? "The AI agent handed it off."
          : event.by === "member"
            ? "The user asked for a person."
            : "A teammate handed it off."
      }`;
    case "request.escalated":
      return event.level === 2
        ? `A case is still waiting after ${wait ?? "a while"}. Sent to the whole team.`
        : `A case has waited ${wait ?? "a while"} with no reply.`;
    case "request.waiting":
      return "Cases are waiting for a reply.";
    case "follow-up.assigned":
      return "A follow-up was assigned.";
    case "follow-up.due":
      return "A follow-up is due in 24 hours.";
    case "follow-up.overdue":
      return "A follow-up is overdue.";
    case "follow-up.escalated":
      return "A follow-up is still overdue a day later.";
    case "follow-up.update-missed":
      return "A follow-up missed its promised update.";
    case "follow-up.done":
      return "A follow-up is done.";
    case "refusal":
      return `A case was turned away today: ${refusalLabel(event.reason)}. ${count(
        event.refusal?.count,
      )} so far today.`;
    case "capacity":
      return `Billing: ${label(BILLING_ALERT_LINES, event.capacity?.alert)} See the Plan tab.`;
    case "member.reply_unseen":
      return "A user hasn't opened the team's reply yet.";
    case "ping":
      return "Test alert from Templ. This channel will get support alerts with a link and no message text.";
    case "overflow":
      return overflowLine(count(event.overflow?.count));
  }
}
export function overflowLine(n: number): string {
  return `${n} more ${n === 1 ? "alert wasn't" : "alerts weren't"} sent because too many were waiting. Every case is still in the inbox.`;
}
const REQUEST_EVENTS: readonly AlertEventType[] = [
  "request.new",
  "request.reopened",
  "request.handoff",
  "request.escalated",
  "request.waiting",
];

/** The link a post or email carries: one request, or the inbox's Needs
 * reply view. Built only from the workspace id and a tc- id; it
 * authenticates nothing. */
export function alertLink(
  appOrigin: string,
  workspace: string,
  thread?: string | null,
): string {
  const room = /^[0-9a-f-]{36}$/.test(workspace) ? workspace : "";
  const base = `${appOrigin.replace(/\/$/, "")}/inbox/${room}?team=1`;
  return thread && /^tc-[0-9a-f]{32}$/.test(thread)
    ? `${base}&support=${thread}`
    : `${base}&view=needs-reply`;
}

export type ChatPost = { text: string; link: string; lines: string[] };
const CHAT_LIMITS: Record<Exclude<SupportAlertDestination, "webhook">, number> = {
  slack: 3_000,
  discord: 1_900,
  telegram: 4_000,
};
/** The lines of one post for a team chat: the due events, the overflow
 * line and the inbox footer. Lines past the kind's size fold into "+{n}
 * more". */
export function chatPost(
  kind: Exclude<SupportAlertDestination, "webhook">,
  events: readonly StoredAlertEvent[],
  input: {
    appOrigin: string;
    workspace: string;
    footer: AlertInboxFooter | null;
    overflow: number;
    now: number;
  },
): ChatPost {
  const lines = events.map((event) => chatLine(event, input.now));
  if (input.overflow > 0) lines.push(overflowLine(input.overflow));
  const threads = [...new Set(events.map((event) => event.case?.thread).filter(Boolean))];
  const link = alertLink(
    input.appOrigin,
    input.workspace,
    events.length === 1 && threads.length === 1 ? threads[0] : null,
  );
  const hasRequest = events.some((event) => REQUEST_EVENTS.includes(event.type));
  if (hasRequest && input.footer && input.footer.needsReply > 0)
    lines.push(
      `${input.footer.needsReply} need a reply.${
        input.footer.oldestWaitingSince
          ? ` Oldest waiting ${formatAge(input.now - input.footer.oldestWaitingSince)}.`
          : ""
      }`,
    );
  const limit = CHAT_LIMITS[kind];
  const kept: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    const rest = lines.length - index;
    if (size + line.length + 1 > limit - 20 && rest > 0) {
      kept.push(`+${rest} more`);
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return { text: kept.join("\n"), link, lines: kept };
}
const escapeSlack = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The provider JSON for a team chat. Telegram's chat id is added by the
 * sender, which alone holds it. */
export function chatBody(
  kind: Exclude<SupportAlertDestination, "webhook">,
  post: ChatPost,
): Record<string, unknown> {
  if (kind === "slack")
    return {
      text: escapeSlack(post.text),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: escapeSlack(post.text) } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open in Templ" },
              url: post.link,
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    };
  if (kind === "discord")
    return {
      content: `${post.text}\n[Open in Templ](<${post.link}>)`,
      allowed_mentions: { parse: [] },
      flags: 4,
    };
  return {
    text: post.text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "Open in Templ", url: post.link }]] },
  };
}

const isoOf = (at: number | undefined) => (at ? new Date(at).toISOString() : undefined);
/** A signed webhook's body. `member` only when the endpoint opted in and
 * the caller read it at send time. */
export function webhookBody(
  event: StoredAlertEvent,
  input: {
    appOrigin: string;
    workspace: string;
    inbox: AlertInboxFooter | null;
    member?: AlertWebhookMember;
  },
): AlertWebhookBody {
  const data: AlertWebhookBody["data"] = {
    workspace: input.workspace,
    event: event.id,
    link: alertLink(input.appOrigin, input.workspace, event.case?.thread),
  };
  if (event.case)
    data.request = {
      id: event.case.thread,
      case: event.case.seq,
      ...(event.type === "request.handoff" && typeof event.reason === "string"
        ? { reason: event.reason }
        : {}),
      ...(event.by ? { by: event.by } : {}),
      ...(event.level ? { level: event.level } : {}),
      ...(event.waitingSince ? { waitingSince: isoOf(event.waitingSince) } : {}),
      test: event.test === true,
    };
  if (event.followUp)
    data.followUp = {
      id: event.followUp.id,
      type: event.followUp.type,
      ...(event.followUp.dueAt ? { dueAt: isoOf(event.followUp.dueAt) } : {}),
    };
  if (event.capacity) data.capacity = { alert: event.capacity.alert };
  if (event.refusal && typeof event.reason === "string")
    data.refusal = { reason: event.reason, day: event.refusal.day, count: event.refusal.count };
  if (event.overflow)
    data.overflow = {
      count: event.overflow.count,
      since: isoOf(event.overflow.since)!,
      byType: Object.fromEntries(
        Object.entries(event.overflow.byType).filter(([, value]) => count(value) > 0),
      ) as Record<string, number>,
    };
  if (input.inbox)
    data.inbox = {
      needsReply: input.inbox.needsReply,
      oldestWaitingSince: isoOf(input.inbox.oldestWaitingSince ?? undefined) ?? null,
    };
  if (input.member)
    data.member = {
      wallet: input.member.wallet
        ? { account: input.member.wallet.account, verified: input.member.wallet.verified }
        : null,
      transactions: input.member.transactions.map(transaction => ({
        ...(transaction.network ? { network: transaction.network } : {}),
        hash: transaction.hash,
      })),
    };
  return { type: event.type, timestamp: new Date(event.at).toISOString(), data };
}
