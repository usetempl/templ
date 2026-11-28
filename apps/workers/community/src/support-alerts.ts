import { canManageWorkspace } from "@templ/chat/moderation-permissions";
/** Team alert routes in the workspace's room:
 *
 * - `/conversations/integrations[/<ad-id>[/log]]`: the workspace Admin's alert
 *   channels. Everyone else, support leads and widget sessions included,
 *   gets the same 404. Changes need a valid signed-in session and a confirmed
 *   review; every change goes to the access log with the kind and id only.
 * - `/conversations/escalation`: the escalation target. The team reads it
 *   for the inbox chip; an Admin changes it with the same checks.
 * - `/conversations/alert-ticket`: a signed member asks for the Templ page
 *   that turns on reply emails. Answers 404 while email delivery is off.
 * - `/conversations/<tc>/member-seen`: the team reads when the member last
 *   saw a team reply.
 * - The member's own messages read with `seen=1` stores that time.
 * - `/conversations/preferences` from the widget: signed members only, and
 *   only to turn reply emails off.
 *
 * Responses never hold a URL, token, chat id or secret, except a webhook's
 * signing secret once, in the create and rotate answers. */
import {
  ALERT_CHAT_DEFAULT_EVENTS,
  ALERT_ESCALATION_MINUTES,
  ALERT_WEBHOOK_DEFAULT_EVENTS,
  SUPPORT_ALERT_DESTINATIONS,
  SUPPORT_ALERT_LIMITS,
  checkedAlertEvents,
  type AlertEscalationMinutes,
  type AlertsView,
  type SupportAlertDestination,
} from "@templ/chat/support-alerts";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import type { ChatAuditAction } from "@templ/chat/audit";
import { HttpError, errorBody, json } from "./common";
import { requirePrivilegedHeaders, requireWorkspaceAdminHeaders } from "./privileged-auth";
import { actsAs } from "./service-principals";
import {
  AlertTargetInvalid,
  DEST_ID,
  DEST_PREFIX,
  checkedDestination,
  checkedLabel,
  checkedSummaryMinutes,
  checkedTarget,
  destinationView,
  maskedTarget,
  newDestinationId,
  unreadableView,
  type AlertDestinationRecord,
  type AlertTarget,
} from "./alert-destinations";
import {
  AlertSecretUnreadable,
  alertAad,
  alertCodeHash,
  alertKeyConfigured,
  confirmationCode,
  newSigningSecret,
  openAlertSecret,
  randomToken,
  sameText,
  sealAlertSecret,
  sha256Hex,
} from "./alert-crypto";
import {
  CREATES_PREFIX,
  TEST_PREFIX,
  TICKET_OF_PREFIX,
  TICKET_PREFIX,
  alertFeatureOn,
  alertsEnabled,
  deleteDestinationData,
  destKey,
  emitAlert,
  readAlertLog,
  readDestinationIndex,
  pruneMemberTickets,
  readOverflow,
  saveDestination,
  type AlertEnv,
} from "./alert-outbox";
import { telegramCall, type SendDeps } from "./alert-send";
import { ESCALATION_KEY, memberSeenKey, readEscalationMinutes } from "./support-alert-emit";
import {
  readNotificationOverflow,
  supportNotificationsConfigured,
} from "./support-notifications";
import type { ConversationContext } from "./team-conversations";
import { conversationAuthority } from "./team-conversations";

type Tx = DurableObjectTransaction;
const INTEGRATIONS = /^\/conversations\/integrations(?:\/(ad-[0-9a-f]{16})(?:\/(log))?)?$/;
const MEMBER_SEEN = /^\/conversations\/(tc-[0-9a-f]{32})\/member-seen$/;
const MESSAGES = /^\/conversations\/(tc-[0-9a-f]{32})\/messages$/;
/** `alert-ticket-v1:<sha256 of ticket>` → `{ principal, expiresAt }`;
 * `alert-ticket-of-v1:<principal>` → that principal's live ticket hash. */
export { TICKET_PREFIX };
export const TICKET_MS = 10 * 60_000;
const notFound = () => new HttpError(404, "Support tools not found.");
const unavailable = () =>
  new HttpError(503, "Team channel alerts aren't available yet.", undefined, "alerts-unavailable");
const iso = (at: number) => new Date(at).toISOString();

export type AlertRouteDeps = SendDeps & {
  /** The shared read predicate (team or the thread's member). */
  canRead: (thread: string) => Promise<boolean>;
};

function envOf(context: ConversationContext): AlertEnv {
  return context.mediaEnv as unknown as AlertEnv;
}
/** Admin changes: a valid signed-in session, a confirmed review, and
 * the principal the page expected. Returns the proof time. */
function privileged(context: ConversationContext): number {
  const at = requireWorkspaceAdminHeaders(context.headers, context.viewer.isManager, context.body.confirmed, context.now);
  const expected = context.body.expectedPrincipalId;
  if (expected !== undefined && (typeof expected !== "string" || !actsAs(context.aliases, expected as never)))
    throw new HttpError(403, "Sign in again with the account you reviewed this change with.");
  return at;
}
function audit(
  context: ConversationContext,
  action: ChatAuditAction,
  after: Record<string, unknown>,
  authenticatedAt?: number,
) {
  context.pendingAudit.push({
    actor: context.viewer.principalId!,
    action,
    target: null,
    after,
    ...(authenticatedAt ? { authenticatedAt: iso(authenticatedAt) } : {}),
  });
}

async function alertsView(storage: Tx, context: ConversationContext): Promise<AlertsView> {
  const env = envOf(context);
  const rows = await storage.list<unknown>({
    prefix: DEST_PREFIX,
    limit: FEATURE_LIMITS.alertDestinationsPerWorkspace + 8,
  });
  const destinations = [];
  for (const [key, value] of rows) {
    const id = key.slice(DEST_PREFIX.length);
    const row = checkedDestination(value, id);
    if (!row) {
      destinations.push(unreadableView(id));
      continue;
    }
    const overflow = await readOverflow(storage, row.id);
    destinations.push(
      destinationView(
        row,
        overflow,
        !alertKeyConfigured(env) ? { status: "paused", pausedReason: "secret-unreadable" } : undefined,
      ),
    );
  }
  return {
    available: alertsEnabled(env),
    destinations,
    escalateAfterMinutes: await readEscalationMinutes(storage),
    limits: {
      destinations: FEATURE_LIMITS.alertDestinationsPerWorkspace,
      perKind: SUPPORT_ALERT_LIMITS.perKind,
    },
    emailOverflowToday: await readNotificationOverflow(storage, context.now),
  };
}

async function rateLimit(storage: Tx, key: string, limit: number, message: string, retryAfter: number) {
  const used = (await storage.get<number>(key)) ?? 0;
  if (used >= limit) throw new HttpError(429, message, retryAfter, "rate-limited");
  await storage.put(key, used + 1);
}

/** Telegram: the bot works, sees the chat, and posts the code. Templ calls
 * nothing else. Returns the chat title for the manager's list. */
async function telegramCheck(
  target: Extract<AlertTarget, { kind: "telegram" }>,
  code: string,
  deps: SendDeps,
): Promise<string> {
  const me = await telegramCall(target.token, "getMe", {}, deps);
  if (!me.ok)
    throw new HttpError(400, "Telegram didn't accept this bot token. Copy it again from @BotFather.");
  const chat = await telegramCall(target.token, "getChat", { chat_id: target.chatId }, deps);
  if (!chat.ok)
    throw new HttpError(400, "The bot can't see that chat. Add the bot to the group, then try again.");
  const sent = await telegramCall(
    target.token,
    "sendMessage",
    {
      chat_id: target.chatId,
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      text: `Templ alert check. Code: ${code}. Enter this code in Templ to finish connecting this chat.`,
      link_preview_options: { is_disabled: true },
    },
    deps,
  );
  if (!sent.ok)
    throw new HttpError(400, "The bot couldn't post in that chat. Let it send messages, then try again.");
  const title = chat.result?.title;
  return typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40) : "";
}

async function create(storage: Tx, context: ConversationContext, deps: SendDeps,
) {
  const env = envOf(context);
  const body = context.body;
  if (!alertsEnabled(env)) throw unavailable();
  const authenticatedAt = privileged(context);
  const kind = body.kind as SupportAlertDestination;
  if (!SUPPORT_ALERT_DESTINATIONS.includes(kind))
    throw new HttpError(400, "Choose Slack, Discord, Telegram or a webhook.");
  if (!alertFeatureOn(env, kind)) throw unavailable();
  const index = await readDestinationIndex(storage);
  if (index.length >= FEATURE_LIMITS.alertDestinationsPerWorkspace)
    throw new HttpError(400, `You can connect up to ${FEATURE_LIMITS.alertDestinationsPerWorkspace} alert channels.`);
  const perKind = SUPPORT_ALERT_LIMITS.perKind[kind];
  if (index.filter((entry) => entry.kind === kind).length >= perKind)
    throw new HttpError(400, `You can connect up to ${perKind} ${kind === "webhook" ? "webhooks" : `${kindName(kind)} channels`}.`);
  await rateLimit(
    storage,
    `${CREATES_PREFIX}${new Date(context.now).toISOString().slice(0, 10)}`,
    SUPPORT_ALERT_LIMITS.createsPerDay,
    "You've added many channels today. Try again tomorrow.",
    3_600,
  );
  // Every attempt counts toward the day's limit, so a refused one answers
  // here instead of throwing: a throw would roll the count back and let a
  // failing Telegram check be retried without end.
  try {
    return await createChecked(storage, context, deps, kind, authenticatedAt);
  } catch (error) {
    if (error instanceof AlertTargetInvalid) return json({ error: error.message }, 400);
    if (error instanceof HttpError && error.status < 500) return json(errorBody(error, ""), error.status);
    throw error;
  }
}
async function createChecked(
  storage: Tx,
  context: ConversationContext,
  deps: SendDeps,
  kind: SupportAlertDestination,
  authenticatedAt: number,
) {
  const env = envOf(context);
  const body = context.body;
  const walletContext = kind === "webhook" && body.walletContext === true;
  if (walletContext && !context.viewer.isManager) throw new HttpError(403, "Only the owner can share wallet details.");
  const events =
    body.events === undefined
      ? [...(kind === "webhook" ? ALERT_WEBHOOK_DEFAULT_EVENTS : ALERT_CHAT_DEFAULT_EVENTS)]
      : checkedAlertEvents(body.events, kind, walletContext);
  if (!events)
    throw new HttpError(400, "Choose alerts from the list. Unseen reply alerts need a webhook with wallet details on.");
  const id = newDestinationId();
  const room = context.room;
  const target = checkedTarget(kind, body, { workersDevSubdomain: env.WORKERS_DEV_SUBDOMAIN });
  let signingSecret: string | null = null;
  let display: string | undefined;
  let verify: AlertDestinationRecord["verify"];
  if (target.kind === "webhook") {
    signingSecret = newSigningSecret();
    target.secrets = [{ id: "s1", value: signingSecret }];
  }
  if (target.kind === "telegram") {
    const code = confirmationCode();
    display = await telegramCheck(target, code, deps);
    verify = {
      codeHash: await alertCodeHash(env, id, code),
      expiresAt: context.now + SUPPORT_ALERT_LIMITS.telegramCodeMs,
      attempts: 0,
    };
  }
  const row: AlertDestinationRecord = {
    v: 1,
    id,
    kind,
    label: checkedLabel(body.label),
    events,
    summaryMinutes: checkedSummaryMinutes(body.summaryMinutes),
    walletContext,
    secret: await sealAlertSecret(env, alertAad(room, id, kind), target),
    hint: maskedTarget(target, display),
    status: kind === "telegram" ? "unverified" : "active",
    approvedBy: context.viewer.isManager ? context.manager! : context.viewer.principalId!,
    ...(!context.viewer.isManager ? { approvalOwner: context.manager!, approvalAliases: [...context.aliases] } : {}),
    approvedAt: context.now,
    createdAt: context.now,
    updatedAt: context.now,
    ...(verify ? { verify } : {}),
    consecutiveFailures: 0,
  };
  await saveDestination(storage, row);
  audit(context, "integration.create", { kind, destId: id, events, walletContext, status: row.status }, authenticatedAt);
  return json(
    {
      destination: destinationView(row, null),
      ...(signingSecret ? { signingSecret } : {}),
    },
    201,
  );
}
const kindName = (kind: SupportAlertDestination) =>
  kind === "slack" ? "Slack" : kind === "discord" ? "Discord" : kind === "telegram" ? "Telegram" : "webhook";

async function destinationOp(
  storage: Tx,
  context: ConversationContext,
  id: string,
  deps: SendDeps,
) {
  const env = envOf(context);
  const body = context.body;
  const op = body.op;
  const raw = await storage.get(destKey(id));
  if (raw === undefined) throw new HttpError(404, "That alert channel isn't here any more.");
  const row = checkedDestination(raw, id);
  if (row?.walletContext && !context.viewer.isManager) throw new HttpError(403, "Only the owner can change this wallet-sharing channel.");
  if (op === "delete") {
    const at = privileged(context);
    await deleteDestinationData(storage, id);
    audit(context, "integration.remove", { kind: row?.kind ?? null, destId: id }, at);
    return json({ ok: true });
  }
  if (!row) throw new HttpError(409, "Templ can't read this channel's saved details. Remove it and add it again.");
  const aad = alertAad(context.room, id, row.kind);
  const openTarget = async () => {
    try {
      return await openAlertSecret<AlertTarget>(env, aad, row.secret);
    } catch (error) {
      if (error instanceof AlertSecretUnreadable) throw unavailable();
      throw error;
    }
  };
  const save = async (action: ChatAuditAction, after: Record<string, unknown>, at?: number) => {
    if (at) {
      row.approvedBy = context.viewer.isManager ? context.manager! : context.viewer.principalId!;
      row.approvalOwner = context.viewer.isManager ? undefined : context.manager!;
      row.approvalAliases = context.viewer.isManager ? undefined : [...context.aliases];
    }
    row.updatedAt = context.now;
    await saveDestination(storage, row);
    audit(context, action, { kind: row.kind, destId: id, ...after }, at);
    return json({ destination: destinationView(row, await readOverflow(storage, id)) });
  };
  switch (op) {
    case "update": {
      if (!alertsEnabled(env) || !alertFeatureOn(env, row.kind)) throw unavailable();
      const at = privileged(context);
      if (body.label !== undefined) row.label = checkedLabel(body.label);
      if (body.summaryMinutes !== undefined) row.summaryMinutes = checkedSummaryMinutes(body.summaryMinutes);
      if (body.events !== undefined) {
        const events = checkedAlertEvents(body.events, row.kind, row.walletContext);
        if (!events) throw new HttpError(400, "Choose alerts from the list.");
        row.events = events;
      }
      if (body.url !== undefined || body.token !== undefined || body.chatId !== undefined) {
        if (row.kind === "telegram")
          throw new HttpError(400, "Remove this Telegram chat and add it again to change the bot or chat.");
        const next = checkedTarget(row.kind, body, { workersDevSubdomain: env.WORKERS_DEV_SUBDOMAIN });
        const current = await openTarget();
        if (next.kind === "webhook" && current.kind === "webhook") next.secrets = current.secrets;
        row.secret = await sealAlertSecret(env, aad, next);
        row.hint = maskedTarget(next);
      }
      return save("integration.update", { events: row.events, status: row.status }, at);
    }
    case "wallet-context": {
      if (!context.viewer.isManager) throw new HttpError(403, "Only the owner can share wallet details.");
      const at = requirePrivilegedHeaders(context.headers, body.confirmed, context.now);
      if (row.kind !== "webhook") throw new HttpError(400, "Only webhooks can receive wallet details.");
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "Choose on or off.");
      row.walletContext = body.enabled;
      // The unseen-reply alert names a member, so it goes with the option.
      if (!row.walletContext) row.events = row.events.filter((type) => type !== "member.reply_unseen");
      return save("integration.update", { walletContext: row.walletContext }, at);
    }
    case "rotate": {
      if (!alertsEnabled(env) || !alertFeatureOn(env, row.kind)) throw unavailable();
      const at = privileged(context);
      if (row.kind !== "webhook") throw new HttpError(400, "Only webhooks have a signing secret.");
      const target = await openTarget();
      if (target.kind !== "webhook") throw unavailable();
      const signingSecret = newSigningSecret();
      target.secrets = [
        ...target.secrets
          .filter((secret) => !secret.notAfter || secret.notAfter > context.now)
          .map((secret) => ({ ...secret, notAfter: secret.notAfter ?? context.now + SUPPORT_ALERT_LIMITS.secretRotationMs }))
          .slice(-1),
        { id: `s${context.now}`, value: signingSecret },
      ];
      row.secret = await sealAlertSecret(env, aad, target);
      const response = await save("integration.update", { rotated: true }, at);
      const view = (await response.json()) as Record<string, unknown>;
      return json({ ...view, signingSecret });
    }
    case "pause":
      if (row.status === "paused" && row.pausedReason === "manager-paused") return json({ destination: destinationView(row, null) });
      row.status = "paused";
      row.pausedReason = "manager-paused";
      return save("integration.pause", { paused: true });
    case "resume": {
      if (!alertsEnabled(env)) throw unavailable();
      if (row.kind === "telegram" && (row.verify || row.pausedReason === "unverified-expired"))
        throw new HttpError(409, "Confirm the code Templ sent to the chat first.");
      // A channel another manager approved needs the new manager's review.
      const reapprove = row.approvedBy !== context.manager;
      const at = reapprove || row.pausedReason === "secret-unreadable" ? privileged(context) : undefined;
      row.status = "active";
      delete row.pausedReason;
      delete row.failingSince;
      row.consecutiveFailures = 0;
      if (reapprove) {
        row.approvedBy = context.manager!;
        row.approvedAt = context.now;
      }
      return save("integration.pause", { paused: false, reapproved: reapprove }, at);
    }
    case "test": {
      if (!alertsEnabled(env)) throw unavailable();
      if (row.status !== "active") throw new HttpError(409, "Turn this channel on before sending a test.");
      await rateLimit(
        storage,
        `${TEST_PREFIX}${id}:${Math.floor(context.now / 3_600_000)}`,
        SUPPORT_ALERT_LIMITS.testsPerHour,
        "You've sent 10 tests this hour. Try again later.",
        3_600,
      );
      await emitAlert(storage, env, { type: "ping", at: context.now }, context.now, { only: id });
      audit(context, "integration.test", { kind: row.kind, destId: id });
      return json({ ok: true, queued: true }, 202);
    }
    case "verify": {
      if (row.kind !== "telegram" || !row.verify) throw new HttpError(409, "This channel has no code to confirm.");
      if (typeof body.code !== "string" || !/^[0-9]{6}$/.test(body.code))
        throw new HttpError(400, "Enter the 6-digit code from the chat.");
      if (row.verify.expiresAt <= context.now || row.verify.attempts >= SUPPORT_ALERT_LIMITS.telegramCodeAttempts) {
        delete row.verify;
        row.status = "paused";
        row.pausedReason = "unverified-expired";
        await saveDestination(storage, row);
        return json({ destination: destinationView(row, null), error: "The code expired. Start again to send a new one." }, 409);
      }
      const hash = await alertCodeHash(env, id, body.code);
      if (!sameText(hash, row.verify.codeHash)) {
        row.verify.attempts++;
        if (row.verify.attempts >= SUPPORT_ALERT_LIMITS.telegramCodeAttempts) {
          delete row.verify;
          row.status = "paused";
          row.pausedReason = "unverified-expired";
        }
        await saveDestination(storage, row);
        return json(
          {
            destination: destinationView(row, null),
            error:
              row.status === "paused"
                ? "Too many wrong codes. Start again to send a new one."
                : "That code doesn't match. Check the chat and try again.",
          },
          400,
        );
      }
      delete row.verify;
      row.status = "active";
      delete row.pausedReason;
      return save("integration.update", { status: "active", verified: true });
    }
    default:
      throw new HttpError(400, "Unknown alert channel action.");
  }
}

async function integrations(
  storage: Tx,
  context: ConversationContext,
  match: RegExpExecArray,
  deps: SendDeps,
) {
  // Managers only: everyone else learns nothing, not even that it exists.
  if (!context.viewer.principalId || !canManageWorkspace(context.viewer, context.isBot) || !context.manager) throw notFound();
  const [, id, sub] = match;
  try {
    if (!id) {
      if (context.method === "GET") return json(await alertsView(storage, context));
      if (context.method === "POST" && context.body.op === "create") return await create(storage, context, deps);
      throw notFound();
    }
    if (!DEST_ID.test(id)) throw notFound();
    if (sub === "log") {
      if (context.method !== "GET") throw notFound();
      const before = context.query.get("before");
      return json(await readAlertLog(storage, id, before));
    }
    if (context.method === "GET") {
      const row = checkedDestination(await storage.get(destKey(id)), id);
      if (!row) throw new HttpError(404, "That alert channel isn't here any more.");
      return json({ destination: destinationView(row, await readOverflow(storage, id)) });
    }
    if (context.method === "POST") return await destinationOp(storage, context, id, deps);
    throw notFound();
  } catch (error) {
    if (error instanceof AlertTargetInvalid) throw new HttpError(400, error.message);
    throw error;
  }
}

async function escalation(storage: Tx, context: ConversationContext) {
  const authority = conversationAuthority(context.viewer);
  if (!authority.team || context.headers.get("X-Support-Widget") === "member") throw notFound();
  if (context.method === "GET")
    return json({ escalateAfterMinutes: await readEscalationMinutes(storage) });
  if (context.method !== "POST") throw notFound();
  if (!canManageWorkspace(context.viewer, context.isBot))
    throw new HttpError(403, "Only workspace admins can change escalation settings.");
  const at = privileged(context);
  const minutes = context.body.escalateAfterMinutes;
  if (!(ALERT_ESCALATION_MINUTES as readonly unknown[]).includes(minutes))
    throw new HttpError(400, "Choose off, 5, 15 or 30 minutes, 1 hour or 2 hours.");
  const before = await readEscalationMinutes(storage);
  await storage.put(ESCALATION_KEY, { minutes, updatedAt: context.now });
  context.pendingAudit.push({
    actor: context.viewer.principalId!,
    action: "support.settings",
    target: null,
    before: { escalateAfterMinutes: before },
    after: { escalateAfterMinutes: minutes },
    authenticatedAt: iso(at),
  });
  return json({ escalateAfterMinutes: minutes as AlertEscalationMinutes });
}

/** A signed member's ticket for the Templ page that turns on reply emails:
 * single use, ten minutes, bound to this workspace and principal. */
async function alertTicket(storage: Tx, context: ConversationContext) {
  const env = envOf(context);
  const actor = context.viewer.principalId;
  if (!actor || context.method !== "POST") throw notFound();
  if (!supportNotificationsConfigured(env as never)) throw notFound();
  const widget = context.headers.get("X-Support-Widget") === "member";
  // Guests hold no proven identity to keep an address for.
  if (widget && context.headers.get("X-Support-Access-Level") !== "signed") throw notFound();
  if (!widget && !["wallet", "solana", "bitcoin"].includes(context.headers.get("X-Session-Auth-Method") ?? ""))
    throw notFound();
  if (!(await storage.get(`conversation-member-v1:${actor}`))) throw notFound();
  const ticket = randomToken();
  const hash = await sha256Hex(ticket);
  // One live ticket per member: a new one replaces the last.
  const pointer = `${TICKET_OF_PREFIX}${actor}`;
  const previous = await storage.get<string>(pointer);
  if (typeof previous === "string") await storage.delete(`${TICKET_PREFIX}${previous}`);
  await storage.put(`${TICKET_PREFIX}${hash}`, {
    principal: actor,
    expiresAt: context.now + TICKET_MS,
  });
  await storage.put(pointer, hash);
  await pruneMemberTickets(storage, context.now);
  const workspace = context.room.slice("room:".length);
  return json({ url: `${context.appOrigin}/alerts#t=${workspace}.${ticket}` }, 201);
}

/** The widget reaches the reply-email preference as a signed member only,
 * and only to turn reply emails off: turning them on goes through the Templ
 * page, where the member proves an email address. Everyone else falls
 * through to the shared preference route. */
function widgetPreference(context: ConversationContext) {
  if (context.headers.get("X-Support-Widget") !== "member") return;
  if (context.headers.get("X-Support-Access-Level") !== "signed")
    throw new HttpError(404, "Support tools not found.");
  if (context.method === "POST" && context.body.enabled !== false)
    throw new HttpError(403, "Turn on reply emails from the page the chat opens.");
}

/** The member reads their thread with `seen=1` (panel open, tab visible):
 * the newest team or agent reply time is stored, forward only. A team read
 * never writes it. Returns nothing; the messages route answers. */
async function markMemberSeen(storage: Tx, context: ConversationContext, thread: string) {
  if (context.method !== "GET" || context.query.get("seen") !== "1" || context.query.has("before")) return;
  const actor = context.viewer.principalId;
  if (!actor) return;
  const record = await storage.get<{ room: string; member: string; deleting?: boolean }>(`conversation-v1:${thread}`);
  if (!record || record.deleting || record.room !== context.room || !actsAs(context.aliases, record.member as never))
    return;
  const data = await storage.get<{ lastStaffReplyAt?: number | null; lastAgentReplyAt?: number | null }>(
    `support-workflow-v1:${thread}`,
  );
  const newest = Math.max(data?.lastStaffReplyAt ?? 0, data?.lastAgentReplyAt ?? 0);
  if (!newest) return;
  const key = memberSeenKey(thread);
  const seen = (await storage.get<number>(key)) ?? 0;
  if (newest > seen) await storage.put(key, newest);
}

/** Dispatches the alert routes; null for any other path. */
export async function alertsFeatureRoute(
  storage: Tx,
  context: ConversationContext,
  deps: AlertRouteDeps,
): Promise<Response | null> {
  const path = context.pathname;
  const integrationsMatch = INTEGRATIONS.exec(path);
  if (integrationsMatch) return integrations(storage, context, integrationsMatch, deps);
  if (path === "/conversations/escalation") return escalation(storage, context);
  if (path === "/conversations/alert-ticket") return alertTicket(storage, context);
  if (path === "/conversations/preferences") {
    widgetPreference(context);
    return null;
  }
  const seen = MEMBER_SEEN.exec(path);
  if (seen) {
    const authority = conversationAuthority(context.viewer);
    if (
      context.method !== "GET" ||
      !authority.team ||
      context.headers.get("X-Support-Widget") === "member" ||
      !(await deps.canRead(seen[1]))
    )
      throw new HttpError(404, "Case not found.");
    const at = await storage.get<number>(memberSeenKey(seen[1]));
    return json({ memberSeenAt: Number.isSafeInteger(at) ? iso(at!) : null });
  }
  const messages = MESSAGES.exec(path);
  if (messages) await markMemberSeen(storage, context, messages[1]);
  return null;
}
