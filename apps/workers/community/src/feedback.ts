import type {
  FeedbackMessage,
  FeedbackNotification,
  FeedbackTicket,
  FeedbackTicketSummary,
} from "@templ/chat/feedback";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  normalizeEmail,
  resendSenderConfigured,
  reserveFeedbackEmail,
  type EmailEnv,
} from "./email-delivery";
import {
  OUTBOX_COUNT_KEY,
  OUTBOX_LIMITS,
  type Outbox,
  type OutboxKind,
  type OutboxState,
} from "./email-outbox";
import { HttpError, json, readJson } from "./common";
import { principal, principalList } from "./principal";
import { servicePrincipals } from "./service-principals";

export interface FeedbackEnv extends EmailEnv {
  FEEDBACK_ENABLED?: string;
  FEEDBACK_STORE?: DurableObjectNamespace;
  /** Comma-separated canonical principals. Never accepted from a browser header or body. */
  FEEDBACK_ADMIN_PRINCIPALS?: string;
}

export const FEEDBACK_LIMITS = {
  list: 30,
  page: 100,
  text: 4000,
  subject: 120,
  openTickets: 10,
  ticketsPerDay: 3,
  messagesPerDay: 100,
  messagesPerTicket: 1000,
  ticketsPerAccount: 100,
  serviceTickets: 20_000,
  serviceTicketsPerDay: 300,
} as const;
const DAY = 86_400_000;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stamp = (time: number) => String(time).padStart(16, "0");
function id(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value))
    throw new HttpError(400, "Start a new feedback request.");
  return value;
}
function text(value: unknown, max: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new HttpError(400, "Write your feedback in plain text.");
  return value.trim();
}
const feedbackAdmins = (env: FeedbackEnv) =>
  principalList(env.FEEDBACK_ADMIN_PRINCIPALS);
/** Needs the flag, the store, the Resend sender and an operator. Email
 * sign-in may stay off: a ticket uses the account's verified email. */
export function feedbackAvailable(env: FeedbackEnv) {
  return (
    env.FEEDBACK_ENABLED === "true" &&
    !!env.FEEDBACK_STORE &&
    resendSenderConfigured(env) &&
    feedbackAdmins(env).length > 0
  );
}
/** The list names wallets; an account whose retained original
 * wallet alias is listed acts as that operator too (`aliases` is the
 * session's service principal set, validated here). Linked wallets never do. */
export function feedbackIsAdmin(
  env: FeedbackEnv,
  actor: ChatPrincipalId,
  aliases?: unknown,
) {
  const admins = feedbackAdmins(env);
  return servicePrincipals(actor, aliases).some((id) => admins.includes(id));
}
export async function feedbackRequest(
  env: FeedbackEnv,
  body: Record<string, unknown>,
) {
  if (!feedbackAvailable(env))
    throw new HttpError(
      503,
      "Feedback is being set up. Please try again later.",
    );
  return env
    .FEEDBACK_STORE!.get(env.FEEDBACK_STORE!.idFromName("templ-feedback:v1"))
    .fetch(
      new Request("https://internal/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
}
type Ticket = FeedbackTicketSummary & {
  owner: ChatPrincipalId;
  email: string;
  sequence: number;
};
type StoredMessage = FeedbackMessage & {
  sequence: number;
  actor: ChatPrincipalId;
};
type AccountCount = {
  total: number;
  open: number;
  tickets: number[];
  messages: number[];
};
const OUTBOX_PREFIX = "feedback-outbox:";
/** Durable per-reply delivery state for operators; it outlives the outbox job and holds no recipient. */
const notificationKey = (ticketId: string, messageId: string) =>
  `feedback-notification:${ticketId}:${messageId}`;
async function recordNotification(
  storage: DurableObjectTransaction,
  job: Pick<
    Outbox,
    "ticketId" | "messageId" | "attempts" | "providerMessageId"
  >,
  state: OutboxState,
  now: number,
) {
  if (state === "failed") {
    await storage.put(
      `feedback-notification-failed:${job.ticketId}:${job.messageId}`,
      { at: now },
    );
    await storage.put(
      "feedback-failed-notifications",
      ((await storage.get<number>("feedback-failed-notifications")) ?? 0) + 1,
    );
  }
  await storage.put(notificationKey(job.ticketId, job.messageId), {
    messageId: job.messageId,
    state,
    providerMessageId: job.providerMessageId,
    attempts: job.attempts,
    updatedAt: now,
  } satisfies FeedbackNotification & { updatedAt: number });
}
const summary = (ticket: Ticket): FeedbackTicketSummary => ({
  id: ticket.id,
  subject: ticket.subject,
  status: ticket.status,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
});
const indexKey = (ticket: Ticket) => `${stamp(ticket.createdAt)}:${ticket.id}`;
async function view(
  storage: DurableObjectTransaction,
  ticket: Ticket,
  before?: unknown,
  admin = false,
): Promise<FeedbackTicket> {
  if (
    before !== undefined &&
    before !== null &&
    (typeof before !== "string" || !/^[1-9][0-9]{0,5}$/.test(before))
  )
    throw new HttpError(400, "Invalid feedback page.");
  const rows = await storage.list<StoredMessage>({
    prefix: `feedback-message:${ticket.id}:`,
    reverse: true,
    limit: FEEDBACK_LIMITS.page + 1,
    ...(before
      ? { end: `feedback-message:${ticket.id}:${stamp(Number(before))}` }
      : {}),
  });
  const selected = [...rows.values()].slice(0, FEEDBACK_LIMITS.page).reverse();
  const result: FeedbackTicket = {
    ...summary(ticket),
    messages: selected.map(
      ({ sequence: _sequence, actor: _actor, ...message }) => message,
    ),
    before:
      rows.size > FEEDBACK_LIMITS.page ? String(selected[0].sequence) : null,
  };
  if (admin) {
    // Operators see delivery state per team reply; members never receive provider details.
    const jobs = await storage.list<
      FeedbackNotification & { updatedAt: number }
    >({
      prefix: `feedback-notification:${ticket.id}:`,
      limit: FEEDBACK_LIMITS.page,
    });
    result.notifications = [...jobs.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map(({ messageId, state, providerMessageId, attempts }) => ({
        messageId,
        state,
        providerMessageId,
        attempts,
      }));
  }
  return result;
}
function count(value: AccountCount | undefined, now: number): AccountCount {
  return {
    total: value?.total ?? 0,
    open: value?.open ?? 0,
    tickets: (value?.tickets ?? []).filter((at) => at > now - DAY),
    messages: (value?.messages ?? []).filter((at) => at > now - DAY),
  };
}
const notFound = () => new HttpError(404, "Feedback not found.");
export async function feedbackOperation(
  storage: DurableObjectTransaction,
  body: Record<string, unknown>,
  env: FeedbackEnv,
  now = Date.now(),
) {
  const actor = principal(body.principalId),
    admin = feedbackIsAdmin(env, actor, body.servicePrincipals);
  const reply = async (ticket: Ticket, before?: unknown) =>
    json({
      principalId: actor,
      ticket: await view(storage, ticket, before, admin),
    });
  if (body.op === "stats") {
    if (!admin) throw new HttpError(403, "Not allowed.");
    return json({
      failedNotifications:
        (await storage.get<number>("feedback-failed-notifications")) ?? 0,
    });
  }
  if (body.op === "list" || body.op === "admin-list") {
    if (body.op === "admin-list" && !admin)
      throw new HttpError(403, "Not allowed.");
    const status = body.status ?? "open";
    if (
      body.op === "admin-list" &&
      !["open", "resolved"].includes(String(status))
    )
      throw new HttpError(400, "Choose open or resolved feedback.");
    const cursor = body.cursor;
    if (
      cursor != null &&
      (typeof cursor !== "string" || !/^\d{16}:[0-9a-f-]{36}$/.test(cursor))
    )
      throw new HttpError(400, "Invalid feedback page.");
    const prefix =
      body.op === "admin-list"
        ? `feedback-status:${status}:`
        : `feedback-owner:${actor}:`;
    const rows = await storage.list<FeedbackTicketSummary>({
      prefix,
      reverse: true,
      limit: FEEDBACK_LIMITS.list + 1,
      ...(cursor ? { end: `${prefix}${cursor}` } : {}),
    });
    const tickets = [...rows.values()].slice(0, FEEDBACK_LIMITS.list);
    return json({
      principalId: actor,
      tickets,
      cursor:
        rows.size > FEEDBACK_LIMITS.list
          ? `${stamp(tickets.at(-1)!.createdAt)}:${tickets.at(-1)!.id}`
          : null,
    });
  }
  const ticketId = id(body.ticketId ?? body.id),
    key = `feedback-ticket:${ticketId}`;
  let ticket = await storage.get<Ticket>(key);
  if (body.op === "create") {
    const subject = text(body.subject, FEEDBACK_LIMITS.subject),
      first = text(body.text, FEEDBACK_LIMITS.text);
    if (ticket) {
      const original = await storage.get<StoredMessage>(
        `feedback-message-id:${ticketId}:${ticketId}`,
      );
      if (
        ticket.owner !== actor ||
        ticket.subject !== subject ||
        original?.text !== first
      )
        throw new HttpError(
          409,
          "This feedback ID was already used. Retry the original request.",
        );
      return reply(ticket);
    }
    const email = normalizeEmail(body.verifiedEmail);
    const mine = count(
      await storage.get<AccountCount>(`feedback-count:${actor}`),
      now,
    );
    const global = (await storage.get<{ total: number; dates: number[] }>(
      "feedback-count",
    )) ?? { total: 0, dates: [] };
    global.dates = global.dates.filter((at) => at > now - DAY);
    if (
      mine.open >= FEEDBACK_LIMITS.openTickets ||
      mine.total >= FEEDBACK_LIMITS.ticketsPerAccount
    )
      throw new HttpError(
        429,
        "You have reached the feedback limit. Reply to an existing case.",
        3600,
      );
    if (
      mine.tickets.length >= FEEDBACK_LIMITS.ticketsPerDay ||
      global.total >= FEEDBACK_LIMITS.serviceTickets ||
      global.dates.length >= FEEDBACK_LIMITS.serviceTicketsPerDay
    )
      throw new HttpError(
        429,
        "Feedback is at capacity. Please try again tomorrow.",
        3600,
      );
    ticket = {
      id: ticketId,
      subject,
      status: "open",
      createdAt: now,
      updatedAt: now,
      owner: actor,
      email,
      sequence: 0,
    };
    mine.total++;
    mine.open++;
    mine.tickets.push(now);
    global.total++;
    global.dates.push(now);
    await storage.put(`feedback-count:${actor}`, mine);
    await storage.put("feedback-count", global);
    body = { ...body, op: "message", id: ticketId, text: first };
  } else if (!ticket || (ticket.owner !== actor && !admin)) throw notFound();
  if (!ticket) throw notFound();
  if (body.op === "read") return reply(ticket, body.before);
  if (body.op === "status") {
    if (!admin) throw new HttpError(403, "Not allowed.");
    if (!["open", "resolved"].includes(String(body.status)))
      throw new HttpError(400, "Choose open or resolved feedback.");
    if (ticket.status !== body.status) {
      const mine = count(
        await storage.get<AccountCount>(`feedback-count:${ticket.owner}`),
        now,
      );
      if (body.status === "open" && mine.open >= FEEDBACK_LIMITS.openTickets)
        throw new HttpError(
          409,
          "This account has too many open cases.",
        );
      mine.open += body.status === "open" ? 1 : -1;
      await storage.put(`feedback-count:${ticket.owner}`, mine);
      await storage.delete(
        `feedback-status:${ticket.status}:${indexKey(ticket)}`,
      );
      ticket.status = body.status as Ticket["status"];
      ticket.updatedAt = Math.max(ticket.updatedAt, now);
    }
  } else if (body.op === "message") {
    const messageId = id(body.id),
      content = text(body.text, FEEDBACK_LIMITS.text);
    const dedup = `feedback-message-id:${ticketId}:${messageId}`;
    const prior = await storage.get<StoredMessage>(dedup);
    if (prior) {
      if (prior.actor !== actor || prior.text !== content)
        throw new HttpError(
          409,
          "This message ID was already used. Retry the original message.",
        );
      return reply(ticket);
    }
    if (ticket.status !== "open") {
      const ownerCount = count(
        await storage.get<AccountCount>(`feedback-count:${ticket.owner}`),
        now,
      );
      if (ownerCount.open >= FEEDBACK_LIMITS.openTickets)
        throw new HttpError(
          409,
          "Resolve another case before reopening this one.",
        );
      ownerCount.open++;
      await storage.put(`feedback-count:${ticket.owner}`, ownerCount);
      await storage.delete(
        `feedback-status:${ticket.status}:${indexKey(ticket)}`,
      );
      ticket.status = "open";
    }
    if (ticket.sequence >= FEEDBACK_LIMITS.messagesPerTicket)
      throw new HttpError(
        429,
        "This case is full. Start a new feedback request.",
        3600,
      );
    const mine = count(
      await storage.get<AccountCount>(`feedback-count:${actor}`),
      now,
    );
    if (mine.messages.length >= FEEDBACK_LIMITS.messagesPerDay)
      throw new HttpError(
        429,
        "You have sent enough feedback for today. Try again tomorrow.",
        3600,
      );
    mine.messages.push(now);
    await storage.put(`feedback-count:${actor}`, mine);
    ticket.sequence++;
    ticket.updatedAt = Math.max(now, ticket.updatedAt);
    const message: StoredMessage = {
      id: messageId,
      text: content,
      author: admin && actor !== ticket.owner ? "team" : "member",
      createdAt: ticket.updatedAt,
      sequence: ticket.sequence,
      actor,
    };
    await storage.put(
      `feedback-message:${ticketId}:${stamp(ticket.sequence)}`,
      message,
    );
    await storage.put(dedup, message);
    if (message.author === "team") {
      const queued = (await storage.get<number>(OUTBOX_COUNT_KEY)) ?? 0;
      if (queued >= OUTBOX_LIMITS.queuedEmails)
        throw new HttpError(
          503,
          "Reply notifications are at capacity. Try again later.",
        );
      const notification: Outbox = {
        ticketId,
        messageId,
        email: ticket.email,
        from: env.EMAIL_FROM!,
        url: `${env.APP_ORIGIN}/feedback?ticket=${ticketId}`,
        createdAt: now,
        attempts: 0,
        firstAttemptAt: null,
        nextAt: now,
        status: "queued",
        providerMessageId: null,
      };
      await storage.put(
        `${OUTBOX_PREFIX}${ticketId}:${messageId}`,
        notification,
      );
      await recordNotification(storage, notification, "queued", now);
      await storage.put(OUTBOX_COUNT_KEY, queued + 1);
      await storage.setAlarm(now + 1000);
    }
  } else throw new HttpError(400, "Invalid feedback operation.");
  await storage.put(key, ticket);
  await storage.put(
    `feedback-owner:${ticket.owner}:${indexKey(ticket)}`,
    summary(ticket),
  );
  await storage.put(
    `feedback-status:${ticket.status}:${indexKey(ticket)}`,
    summary(ticket),
  );
  return reply(ticket);
}

/** FeedbackStore dispatch for `/feedback`. */
export async function feedbackOperationRoute(
  state: DurableObjectState,
  env: FeedbackEnv,
  request: Request,
): Promise<Response> {
  if (!feedbackAvailable(env))
    throw new HttpError(
      503,
      "Feedback is being set up. Please try again later.",
    );
  const body = await readJson(request, 12_000);
  return state.storage.transaction((storage) =>
    feedbackOperation(storage, body, env),
  );
}
/** Team replies notify the ticket owner. The email names no ticket content;
 * failures are counted for the operators' stats. */
export const FEEDBACK_REPLY_OUTBOX: OutboxKind<FeedbackEnv> = {
  prefix: OUTBOX_PREFIX,
  available: (env) => feedbackAvailable(env),
  async reserve(_storage, env, job) {
    await reserveFeedbackEmail(env, `${job.ticketId}/${job.messageId}`);
    return 0;
  },
  record: (storage, job, state, now) =>
    recordNotification(storage, job, state, now),
  message: (job) => ({
    subject: "Templ replied to your feedback",
    text: `You have a reply from Templ. Sign in to read it:\n\n${job.url}`,
  }),
};
