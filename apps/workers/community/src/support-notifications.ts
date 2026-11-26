import { billingManagedForWorkspace } from "./customer-debt-access";
import { queueRoomResources } from "./workspace-resource-observations";
import { featureOn } from "./workspace-flags";
import { releaseActivationReadUnknown } from "./release-activation";
import { acknowledgeOrderFormNotice, orderFormNoticeEmail, type OrderFormNotice } from "./product-order-forms";
import { currentGuestFollowUp, guestCredentialActive, guestEmailContent } from "./guest-follow-up";
import { specialistMayReceive } from "./support-specialist";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRole, ModeratorPermission } from "@templ/chat/index";
import type { AlertEventFacts } from "@templ/chat/support-alerts";
import type { BalanceAlertFacts } from "./product-alerts";
import { billingAlertEmail, monthReportEmail } from "./product-alert-email";
import type { MonthReportFacts } from "./product-month-report";
import type { SupportHandoffBy } from "@templ/chat/support";
import { identityRequest, type AccountIdentity } from "./account-identity";
import {
  deliverEmail,
  resendSenderConfigured,
  reserveSupportEmail,
  type EmailEnv,
} from "./email-delivery";
import type { Env } from "./common";
import { HttpError, siteOrigins } from "./common";
import { wakeRoomAt } from "./room-alarm";
import { chatLine, formatAge, handoffLabel } from "./alert-render";
import { inboxFooter, memberSeenKey } from "./support-alert-emit";
import { keyedHex, sha256Hex } from "./alert-crypto";
import { UNSUBSCRIBE_PREFIX } from "./alert-outbox";
import type { NativeRoomRecord } from "./native-rooms";
import type { TeamConversationRecord } from "./team-conversations";
import type { SupportNotification } from "./support-workflow";
import { actsAs } from "./service-principals";
import { aiPrincipals } from "./bots";
import { currentStaffRoleIds, templStaffAccount, type TemplStaffEnv } from "./templ-staff";

const PREFIX = "support-notification-v1:";
const PREFERENCE = "support-alert-preference-v1:";
const COUNT = "support-notification-count-v1";
const CURSOR = "support-notification-scan-v1";
const DIAGNOSTICS = "support-notification-diagnostics-v1";
const HOUR = 60 * 60_000;
// Unsent jobs can wait through the shared 24-hour budget rollover, for at most
// 72 hours total. This bounds the backlog; it does not increase sender capacity.
const QUEUE_LIFETIME = 72 * HOUR;
// Resend retains keys for 24 hours. Start this conservative window immediately
// before the first dispatch, never at a budget reservation or a retry.
// https://resend.com/docs/dashboard/emails/idempotency-keys
const ATTEMPT_LIFETIME = 23 * HOUR;
const DIAGNOSTIC_LIFETIME = 7 * 24 * HOUR;
const DIAGNOSTIC_LIMIT = 200;
const LEASE = 30_000;
type Outcome = "sent" | "failed" | "unknown" | "cancelled" | "expired";
type TerminalReason =
  | "provider-accepted"
  | "provider-rejected"
  | "attempts-exhausted"
  | "retry-deadline"
  | "budget-deadline"
  | "queue-deadline"
  | "authorization-lost"
  | "recipient-changed"
  | "seen"
  | "nothing-waiting";
type Job = SupportNotification & {
  attempts?: number;
  firstAttemptAt?: number;
  uncertain?: boolean;
  nextAt?: number;
  leaseUntil?: number;
  deferredBy?: "budget" | "reservation-unavailable" | "identity-unavailable";
  outcome?: Outcome;
  providerId?: string | null;
  addressHash?: string;
  from?: string;
};
type Diagnostic = {
  jobHash: string;
  createdAt: number;
  completedAt: number;
  firstAttemptAt?: number;
  attempts: number;
  outcome: Outcome;
  reason: TerminalReason;
};
function deadline(job: Job) {
  // Older attempted jobs have no trustworthy first-attempt timestamp. Do not
  // give them a fresh retry window during a deployment.
  const firstAttemptAt =
    job.firstAttemptAt ?? ((job.attempts ?? 0) > 0 ? job.createdAt : null);
  return Math.min(
    job.createdAt + QUEUE_LIFETIME,
    firstAttemptAt === null ? Infinity : firstAttemptAt + ATTEMPT_LIFETIME,
  );
}
function expiryReason(job: Job): TerminalReason {
  if ((job.attempts ?? 0) > 0 || job.firstAttemptAt !== undefined)
    return job.createdAt + QUEUE_LIFETIME <=
      (job.firstAttemptAt ?? job.createdAt) + ATTEMPT_LIFETIME
      ? "queue-deadline"
      : "retry-deadline";
  return job.deferredBy === "budget" ? "budget-deadline" : "queue-deadline";
}
export function supportNotificationsConfigured(env: Partial<EmailEnv>) {
  return (
    featureOn(env, undefined, "emailNotices") &&
    !!env.AUTH_RECORDS &&
    !!env.APP_ORIGIN &&
    resendSenderConfigured(env as Env)
  );
}
/** Counts and fixed sender states for a current workspace manager or lead.
 * Reads never run the alarm, reserve a send, or expose routing metadata. */
export async function readNotificationStatus(
  storage: Pick<DurableObjectTransaction, "get" | "list" | "getAlarm">,
  env: Partial<EmailEnv> & TemplStaffEnv,
  now: number,
) {
  const rows = await storage.list<Job>({ prefix: PREFIX, limit: 101 });
  const kinds = {
    request: 0,
    "guest-confirmation": 0,
    reply: 0,
    assignment: 0,
    mention: 0,
    handoff: 0,
    digest: 0,
    escalation: 0,
    workspace: 0,
    "follow-up": 0,
  };
  const deferred = {
    budget: 0,
    "reservation-unavailable": 0,
    "identity-unavailable": 0,
  };
  let pending = 0,
    due = 0,
    attempts = 0;
  let oldestPendingAt: number | null = null,
    nextAttemptAt: number | null = null;
  for (const job of [...rows.values()].slice(0, 100)) {
    if (job.outcome) continue;
    pending++;
    if (Object.hasOwn(kinds, job.kind)) kinds[job.kind]++;
    if (job.deferredBy && Object.hasOwn(deferred, job.deferredBy))
      deferred[job.deferredBy]++;
    if (Number.isSafeInteger(job.attempts) && job.attempts! >= 0)
      attempts += Math.min(5, job.attempts!);
    if (Number.isSafeInteger(job.createdAt) && job.createdAt >= 0)
      oldestPendingAt = Math.min(oldestPendingAt ?? Infinity, job.createdAt);
    const at = Math.max(job.nextAt ?? 0, job.leaseUntil ?? 0);
    if (Number.isSafeInteger(at) && at >= 0) {
      if (at <= now) due++;
      nextAttemptAt = Math.min(nextAttemptAt ?? Infinity, at);
    }
  }
  const outcomes = { sent: 0, failed: 0, unknown: 0, cancelled: 0, expired: 0 };
  const reasons = {
    "provider-accepted": 0,
    "provider-rejected": 0,
    "attempts-exhausted": 0,
    "retry-deadline": 0,
    "budget-deadline": 0,
    "queue-deadline": 0,
    "authorization-lost": 0,
    "recipient-changed": 0,
    seen: 0,
    "nothing-waiting": 0,
  };
  const records = (await storage.get<Diagnostic[]>(DIAGNOSTICS)) ?? [];
  let lastCompletedAt: number | null = null;
  for (const record of records.slice(-DIAGNOSTIC_LIMIT)) {
    if (
      !Number.isSafeInteger(record.completedAt) ||
      record.completedAt > now ||
      record.completedAt + DIAGNOSTIC_LIFETIME <= now
    )
      continue;
    if (Object.hasOwn(outcomes, record.outcome)) outcomes[record.outcome]++;
    if (Object.hasOwn(reasons, record.reason)) reasons[record.reason]++;
    lastCompletedAt = Math.max(lastCompletedAt ?? 0, record.completedAt);
  }
  const stored = await storage.get<number>(COUNT);
  const alarm = await storage.getAlarm();
  return {
    schemaVersion: 1,
    configured: supportNotificationsConfigured(env),
    featureEnabled: featureOn(env, undefined, "emailNotices"),
    activationReadUnknown: releaseActivationReadUnknown(env),
    authRecordsBound: !!env.AUTH_RECORDS,
    appOriginConfigured: !!env.APP_ORIGIN,
    senderConfigured: resendSenderConfigured(env as Env),
    alarmAt: Number.isSafeInteger(alarm) && alarm! >= 0 ? alarm : null,
    queue: {
      stored:
        Number.isSafeInteger(stored) && stored! >= 0 && stored! <= QUEUE_CAP
          ? stored
          : null,
      scanned: Math.min(rows.size, 100),
      hasMore: rows.size > 100,
      pending,
      due,
      attempts,
      oldestPendingAt,
      nextAttemptAt,
      kinds,
      deferred,
    },
    recent: { outcomes, reasons, lastCompletedAt },
  };
}
/** Fixed codes an email's text is built from at send time. */
export type SupportNotificationFacts = {
  orderFormNotice?: Pick<OrderFormNotice, "id" | "source" | "table">;
  orderFormStaffRemoval?: true;
  guestGeneration?: string;
  /** Handoff reason code and who handed off. */
  reason?: string;
  by?: SupportHandoffBy;
  /** Escalation: when the wait started. */
  waitingSince?: number;
  /** Workspace email: the alert it repeats. */
  alert?: AlertEventFacts;
  /** Workspace email to billing managers: a billing alert and its numbers. */
  balance?: BalanceAlertFacts;
  /** Workspace email to billing managers: last month's cases and charges. */
  month?: MonthReportFacts;
  /** Workspace email: an alert channel paused after failing deliveries. */
  paused?: { kind: string };
};
export type NotificationJobInput = {
  now: number;
  /** "room:<uuid>". */
  room: string;
  appOrigin: string;
  recipient: ChatPrincipalId;
  kind: SupportNotification["kind"];
  /** Null for room-level jobs; `digest` and `workspace` are always room-level. */
  conversation: string | null;
  notBefore?: number;
  /** One job per recipient, kind and bucket; five minutes by default. */
  bucketMs?: number;
  replyAt?: number;
  /** The member's own view (no `team=1`). */
  memberLink?: boolean;
  facts?: SupportNotificationFacts;
  /** False when a room alarm consumer reports its own next run instead. */
  wake?: boolean;
};
const BUCKETS: Partial<Record<SupportNotification["kind"], number>> = {
  digest: 10 * 60_000,
  workspace: 60 * 60_000,
};
export const NOTIFICATION_OVERFLOW_PREFIX = "support-notification-overflow-v1:";
const QUEUE_CAP = 5_000;
const OVERFLOW_DAYS = 35;
type Queue = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
/** Queues one email job for an authorized recipient who turned alerts on. A full queue
 * is counted per UTC day and shown on the Alerts page; nothing is dropped
 * silently. Returns whether a job was written. */
export async function queueNotificationJob(
  storage: Queue,
  input: NotificationJobInput,
  env: TemplStaffEnv,
): Promise<boolean> {
  const roomLevel = input.kind === "digest" || input.kind === "workspace";
  // A digest waits a minute so a burst of requests becomes one email with
  // the count.
  const notBefore =
    input.notBefore ?? (input.kind === "digest" ? input.now + 60_000 : undefined);
  const conversation = roomLevel ? null : input.conversation;
  const bucketMs = input.bucketMs ?? BUCKETS[input.kind] ?? 300_000;
  const bucket = Math.floor(input.now / bucketMs);
  const idFor = (recipient: ChatPrincipalId) => `${conversation ?? "room"}:${recipient}:${input.kind}:${bucket}`;
  const id = idFor(input.recipient);
  if (await storage.get(`${PREFIX}${id}`)) return false;
  if ((input.kind === "digest" || input.kind === "request") &&
      !input.facts?.orderFormNotice && !input.facts?.orderFormStaffRemoval) {
    // Opaque accounts have their own preference. A legacy wallet can belong
    // to another principal, so only an empty preference range rules it out.
    const couldReceive = input.recipient.startsWith("account:")
      ? (await storage.get<{ enabled: boolean }>(PREFERENCE + input.recipient))?.enabled === true
      : (await storage.list({ prefix: PREFERENCE, limit: 1 })).size > 0;
    if (!couldReceive) return false;
  }
  const roomPath = `/inbox/${input.room.slice(5)}`;
  const href = conversation
    ? `${input.appOrigin}${roomPath}?${input.memberLink ? "" : "team=1&"}support=${encodeURIComponent(conversation)}`
    : `${input.appOrigin}${roomPath}?team=1&view=needs-reply`;
  const job = {
    id,
    recipient: input.recipient,
    conversation,
    kind: input.kind,
    createdAt: input.now,
    status: "pending",
    href,
    ...(notBefore ? { nextAt: notBefore } : {}),
    ...(input.replyAt ? { replyAt: input.replyAt } : {}),
    ...(input.facts ? { facts: input.facts } : {}),
  } satisfies SupportNotification;
  let account: NotificationIdentity;
  try {
    account = await notificationIdentity(storage, env as Env, job);
  } catch {
    console.error(
      JSON.stringify({ event: "TEMPL_SUPPORT_FAILURE", route: "alert-delivery", kind: "email", statusClass: "none", reason: "identity-unavailable" }),
    );
    return false;
  }
  if (!(await supportNotificationAuthorized(storage, job, account, env)))
    return false;
  // Retained alias jobs keep their keys. Any current alias suppresses a repeat.
  for (const alias of account.servicePrincipals)
    if (await storage.get(`${PREFIX}${idFor(alias)}`)) return false;
  job.id = idFor(account.principalId);
  const outboxKey = `${PREFIX}${job.id}`;
  const count = (await storage.get<number>(COUNT)) ?? 0;
  if (count >= QUEUE_CAP) {
    await countOverflow(storage, input.kind, input.now);
    return false;
  }
  await storage.put(outboxKey, job);
  await storage.put(COUNT, count + 1);
  if (input.wake !== false)
    await wakeRoomAt(storage, Math.max(input.now + 1000, notBefore ?? 0));
  return true;
}
/** Staff email from a timer or the outbox (escalation, billing, a paused
 * channel). */
export function queueStaffNotification(
  storage: Queue,
  input: Omit<NotificationJobInput, "facts" | "memberLink"> & {
    waitingSince?: number;
    alert?: AlertEventFacts;
    pausedKind?: string;
    balance?: BalanceAlertFacts;
  },
  env: TemplStaffEnv,
) {
  const { waitingSince, alert, pausedKind, balance, ...rest } = input;
  return queueNotificationJob(storage, {
    ...rest,
    facts: {
      ...(waitingSince ? { waitingSince } : {}),
      ...(alert ? { alert } : {}),
      ...(pausedKind ? { paused: { kind: pausedKind } } : {}),
      ...(balance ? { balance } : {}),
    },
  }, env);
}
async function countOverflow(storage: Queue, kind: string, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `${NOTIFICATION_OVERFLOW_PREFIX}${day}`;
  const stored = await storage.get<{ count: number; byKind: Record<string, number> }>(key);
  const row = stored && Number.isSafeInteger(stored.count) ? stored : { count: 0, byKind: {} };
  row.count++;
  row.byKind[kind] = (row.byKind[kind] ?? 0) + 1;
  await storage.put(key, row);
  console.error(
    JSON.stringify({ event: "TEMPL_SUPPORT_FAILURE", route: "alert-delivery", kind: "email", statusClass: "none", reason: "queue-full" }),
  );
  const cutoff = new Date(now - OVERFLOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const old = await storage.list({ prefix: NOTIFICATION_OVERFLOW_PREFIX, end: `${NOTIFICATION_OVERFLOW_PREFIX}${cutoff}`, limit: 10 });
  if (old.size) await storage.delete([...old.keys()]);
}
/** Emails not queued today because the queue was full. */
export async function readNotificationOverflow(
  storage: Pick<DurableObjectStorage, "get">,
  now: number,
): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await storage.get<{ count: number }>(`${NOTIFICATION_OVERFLOW_PREFIX}${day}`);
  return row && Number.isSafeInteger(row.count) ? row.count : 0;
}
/** The one-click unsubscribe token of a member's reply emails in one
 * workspace; the room keeps only its hash, pointing at the member. */
export { UNSUBSCRIBE_PREFIX };
export async function unsubscribeToken(secret: string, room: string, principal: string) {
  return keyedHex(secret, `unsub:${room}:${principal}`);
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** Notification authorization is rebuilt from current membership and manual grants.
 * Contract-backed rooms require their live provider verification and currently fail closed here. */
export async function supportNotificationAuthorized(
  storage: Pick<DurableObjectStorage, "get" | "list">,
  job: Job,
  account: NotificationIdentity,
  env: TemplStaffEnv = {},
): Promise<boolean> {
  if (job.conversation) {
    const guest = await currentGuestFollowUp(storage, job.conversation);
    if (guest?.principal === job.recipient) return account.principalId === guest.principal && account.email === guest.email && !!account.emailVerifiedAt &&
      (job.kind === "guest-confirmation" ? guest.generation === job.facts?.guestGeneration && !guest.confirmedAt && guest.expiresAt > Date.now() : job.kind === "reply" && !!guest.confirmedAt);
  }
  if (job.kind === "guest-confirmation") return false;
  const aliases = account.servicePrincipals;
  if (
    !aliases.includes(job.recipient) ||
    !account.email ||
    !account.emailVerifiedAt
  )
    return false;
  const settings = await storage.get<object>("chat-settings");
  if (!settings) return false;
  try {
    const agents = await aiPrincipals(storage, settings);
    if (aliases.some((id) => agents.includes(id))) return false;
  } catch {
    return false;
  }
  const pref = await storage.get<{ enabled: boolean }>(
    PREFERENCE + account.principalId,
  );
  if (pref?.enabled !== true && !job.facts?.orderFormNotice && !job.facts?.orderFormStaffRemoval) return false;
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) return false;
  if (await billingManagedForWorkspace(storage, native.room.id) && (
    job.facts?.month ||
    (job.facts?.balance && job.facts.balance.alert !== "suspended") ||
    (job.facts?.alert?.type === "capacity" && job.facts.alert.capacity?.alert !== "suspended")
  )) return false;
  const manager = actsAs(aliases, native.room.manager) &&
    !(await templStaffAccount(storage, aliases, env));
  // Room-level jobs: the digest reaches the manager and people who handle
  // conversations; workspace email the manager and billing managers.
  if (job.conversation === null) {
    if (job.kind === "digest")
      return manager || (await holdsPermission(storage, aliases, "handleConversations", env));
    if (job.kind === "workspace")
      return manager || (await holdsPermission(storage, aliases, "manageBilling", env));
    return false;
  }
  if (job.kind === "digest" || job.kind === "workspace") return false;
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${job.conversation}`,
  );
  if (
    !record ||
    record.deleting ||
    record.room !== `room:${native.room.id}` ||
    record.stopped
  )
    return false;
  const member =
    manager ||
    (
      await Promise.all(aliases.map((id) => storage.get(`room-member:${id}`)))
    ).some(Boolean);
  const privacy = await storage.get<{ visibility: string }>("room-privacy");
  if ((privacy?.visibility ?? native.room.visibility) === "private" && !member)
    return false;
  if (actsAs(aliases, record.member)) return job.kind === "reply";
  if (job.kind === "reply") return false;
  if (manager) return true;
  if (await holdsPermission(storage, aliases, "handleConversations", env))
    return true;
  // A specialist gets follow-up and mention emails only
  // while the role and its scope on this request still hold, or, for a
  // follow-up email, while their group has an open follow-up nobody owns.
  return (
    (job.kind === "follow-up" || job.kind === "mention") &&
    (await holdsPermission(storage, aliases, "handleFollowUps", env)) &&
    (await specialistMayReceive(storage, {
      aliases,
      thread: job.conversation,
      now: Date.now(),
      kind: job.kind,
    }))
  );
}
/** Whether any of the account's principals holds `permission` through an
 * enabled manual staff role now. */
async function holdsPermission(
  storage: Pick<DurableObjectStorage, "get">,
  aliases: readonly ChatPrincipalId[],
  permission: ModeratorPermission,
  env: TemplStaffEnv,
): Promise<boolean> {
  const settings = await storage.get<{
    moderationRoleModel?: number;
    roles: {
      id: string;
      enabled?: boolean;
      moderationPermissions?: ModeratorPermission[];
    }[];
  }>("chat-settings");
  const manual = await storage.get<Record<string, Omit<ChatRole, "name">>>(
    "native-manual-roles",
  );
  if (!settings || !manual) return false;
  const assigned = await currentStaffRoleIds(storage, aliases, env, Date.now());
  return assigned.some(
    (id) =>
      manual[id]?.mode === "manual" &&
      manual[id]?.enabled !== false &&
      settings.roles.some(
        (role) =>
          role.id === id &&
          role.enabled !== false &&
          role.moderationPermissions?.includes(permission),
      ),
  );
}
async function remove(storage: DurableObjectTransaction, key: string) {
  if (!(await storage.get(key))) return;
  await storage.delete(key);
  await storage.put(
    COUNT,
    Math.max(0, ((await storage.get<number>(COUNT)) ?? 1) - 1),
  );
}
async function finish(
  storage: DurableObjectTransaction,
  key: string,
  job: Job,
  jobHash: string,
  now: number,
  outcome: Outcome,
  reason: TerminalReason,
) {
  if (job.outcome) return;
  if (outcome === "sent" && job.facts?.orderFormNotice)
    await acknowledgeOrderFormNotice(storage, { id: job.facts.orderFormNotice.id, recipient: job.recipient, now });
  // Operator diagnostics stay in room storage, without recipients, addresses,
  // conversation IDs, links or content. Keep only the last 200 for seven days.
  const records = ((await storage.get<Diagnostic[]>(DIAGNOSTICS)) ?? [])
    .filter((record) => record.completedAt + DIAGNOSTIC_LIFETIME > now)
    .slice(-(DIAGNOSTIC_LIMIT - 1));
  records.push({
    jobHash,
    createdAt: job.createdAt,
    completedAt: now,
    ...(job.firstAttemptAt !== undefined
      ? { firstAttemptAt: job.firstAttemptAt }
      : {}),
    attempts: job.attempts ?? 0,
    outcome,
    reason,
  });
  await storage.put(DIAGNOSTICS, records);
  // Preserve the enqueue deduplication key until its five-minute bucket ends.
  if (job.createdAt + 300_000 > now)
    await storage.put(key, { ...job, outcome, leaseUntil: 0 });
  else await remove(storage, key);
}
type NotificationIdentity = Pick<AccountIdentity, "principalId" | "servicePrincipals" | "email" | "emailVerifiedAt">;
async function notificationIdentity(storage: Pick<DurableObjectStorage, "get">, env: Env, job: Pick<Job, "recipient" | "conversation">): Promise<NotificationIdentity> {
  const guest = job.conversation ? await currentGuestFollowUp(storage, job.conversation) : null;
  if (guest?.principal === job.recipient) {
    const native = await storage.get<NativeRoomRecord>("native-room");
    const active = native && await guestCredentialActive(env, native.room.id, guest);
    return { principalId: guest.principal, servicePrincipals: [guest.principal], email: active ? guest.email : null, emailVerifiedAt: active ? guest.confirmedAt ?? 1 : null };
  }
  return identityRequest(env, { op: "read", principalId: job.recipient });
}
type EmailContent = {
  subject: string;
  text: string;
  headers?: Record<string, string>;
};
function withoutContent<T extends { content?: unknown }>(job: T): Omit<T, "content"> {
  const { content: _content, ...rest } = job;
  void _content;
  return rest;
}
/** A job whose reason passed: a member who saw the reply, an empty inbox
 * for a digest, an escalated wait that got its reply. */
async function cancelReason(
  storage: Pick<DurableObjectTransaction, "get" | "list">,
  job: Job,
): Promise<TerminalReason | null> {
  if (job.kind === "reply" && job.conversation && Number.isSafeInteger(job.replyAt)) {
    const seen = await storage.get<number>(memberSeenKey(job.conversation));
    if (Number.isSafeInteger(seen) && seen! >= job.replyAt!) return "seen";
  }
  if (job.kind === "digest" && (await inboxFooter(storage)).needsReply === 0)
    return "nothing-waiting";
  if (job.kind === "escalation" && job.conversation && job.facts?.waitingSince) {
    const data = await storage.get<{ awaitingSince?: number | null }>(
      `support-workflow-v1:${job.conversation}`,
    );
    if (data?.awaitingSince !== job.facts.waitingSince) return "nothing-waiting";
  }
  return null;
}
/** Subject and text, built at send time from fixed codes and live counts.
 * No message, note, member name, workspace name, wallet or hash enters an
 * email. Null when nothing is left to say. */
async function emailContent(
  storage: Pick<DurableObjectTransaction, "get" | "put" | "list">,
  job: Job,
  env: Partial<EmailEnv> & TemplStaffEnv,
  now: number,
): Promise<EmailContent | null> {
  if (job.conversation && (job.kind === "guest-confirmation" || job.kind === "reply") && await currentGuestFollowUp(storage, job.conversation))
    return guestEmailContent(storage as DurableObjectTransaction, job, env, now);
  const facts = job.facts ?? {};
  if (facts.orderFormNotice) return orderFormNoticeEmail(facts.orderFormNotice, job.href.split("?")[0] + "?tab=plan");
  if (facts.orderFormStaffRemoval) return { subject: "Remove Templ team roles",
    text: "Templ people can no longer open or answer your cases. Remove their roles on the Team page.\n\n" + job.href.split("?")[0] + "?tab=team" };
  switch (job.kind) {
    case "reply": {
      const native = await storage.get<NativeRoomRecord>("native-room");
      let unsubscribe: string | null = null;
      if (native && env.EMAIL_AUTH_SECRET && env.APP_ORIGIN) {
        const room = `room:${native.room.id}`;
        const token = await unsubscribeToken(env.EMAIL_AUTH_SECRET, room, job.recipient);
        await storage.put(`${UNSUBSCRIBE_PREFIX}${await sha256Hex(token)}`, {
          principal: job.recipient,
        });
        unsubscribe = `${siteOrigins(env as Env).communityOrigin}/alerts/unsubscribe?w=${native.room.id}&t=${token}`;
      }
      return {
        subject: "The team replied in Templ Support",
        text: `The team replied to your case. Sign in with your wallet to read it:\n\n${job.href}\n\nTo stop these emails, open the chat and choose Turn off${
          unsubscribe ? `, or use this link: ${unsubscribe}` : "."
        }`,
        ...(unsubscribe
          ? {
              headers: {
                "List-Unsubscribe": `<${unsubscribe}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }
          : {}),
      };
    }
    case "digest": {
      const footer = await inboxFooter(storage);
      if (!footer.needsReply) return null;
      const oldest = footer.oldestWaitingSince
        ? ` The oldest has waited ${formatAge(now - footer.oldestWaitingSince)}.`
        : "";
      return {
        subject: "Support cases are waiting",
        text: `${footer.needsReply} ${footer.needsReply === 1 ? "case needs" : "cases need"} a reply.${oldest} Sign in to answer:\n\n${job.href}\n\nChange these emails in Templ under Settings.`,
      };
    }
    case "escalation": {
      const age = formatAge(now - (facts.waitingSince ?? now));
      return {
        subject: "A support case is still waiting",
        text: `A case in your Templ inbox has waited ${age} with no reply. Sign in to answer:\n\n${job.href}`,
      };
    }
    case "handoff":
      return {
        subject: "A support case needs a person",
        text: `The case needs a person’s reply. Reason: ${handoffLabel(facts.reason)}. Sign in to answer:\n\n${job.href}`,
      };
    case "workspace": {
      if (facts.paused)
        return {
          subject: "A team alert channel was paused",
          text: `Templ paused a team alert channel after deliveries failed for 3 days. Check it in Templ under Settings, then turn it back on:\n\n${job.href}`,
        };
      if (facts.balance) return billingAlertEmail(facts.balance, job.href);
      if (facts.month) return monthReportEmail(facts.month, job.href);
      if (!facts.alert) return null;
      return {
        subject: "A Templ support alert",
        text: `${chatLine({ ...facts.alert, v: 1, id: "email" }, now)}\n\n${job.href}`,
      };
    }
    default:
      return {
        subject: "New activity in Templ Support",
        text: `Your private support case has new activity. Sign in to view it:\n\n${job.href}\n\nYou can turn off these alerts in the case’s notification settings.`,
      };
  }
}
/** Bounded durable sender. No message, note, member name or community name enters email.
 * Returns when the queue next needs to run, or null when it holds nothing
 * timed; the room alarm schedules it (room-alarm.ts). */
export async function supportNotificationAlarm(
  state: DurableObjectState,
  env: Partial<EmailEnv> & TemplStaffEnv,
): Promise<number | null> {
  const configured = supportNotificationsConfigured(env);
  const cursor = await state.storage.get<string>(CURSOR);
  let entries = await state.storage.list<Job>({
    prefix: PREFIX,
    limit: 100,
    ...(cursor ? { startAfter: cursor } : {}),
  });
  if (!entries.size && cursor)
    entries = await state.storage.list<Job>({ prefix: PREFIX, limit: 100 });
  let next = Infinity;
  for (const [key, item] of entries) {
    const now = Date.now();
    const jobHash = await digest(item.id);
    if (item.outcome && item.createdAt + 300_000 <= now) {
      await state.storage.transaction((storage) => remove(storage, key));
      continue;
    }
    if (item.outcome) {
      next = Math.min(next, item.createdAt + 300_000);
      continue;
    }
    const expiresAt = deadline(item);
    if (expiresAt <= now) {
      await state.storage.transaction((storage) =>
        finish(
          storage,
          key,
          item,
          jobHash,
          now,
          (item.attempts ?? 0) > 0 ? "unknown" : "expired",
          expiryReason(item),
        ),
      );
      continue;
    }
    if ((item.attempts ?? 0) >= 5) {
      await state.storage.transaction((storage) =>
        finish(
          storage,
          key,
          item,
          jobHash,
          now,
          "unknown",
          "attempts-exhausted",
        ),
      );
      continue;
    }
    next = Math.min(next, expiresAt);
    if (!configured) {
      if (
        env.SUPPORT_NOTIFICATIONS_ENABLED === "true" &&
        releaseActivationReadUnknown(env)
      )
        next = Math.min(next, now + 60_000);
      continue;
    }
    const due = Math.max(item.nextAt ?? 0, item.leaseUntil ?? 0);
    if (due > now) {
      next = Math.min(next, due);
      continue;
    }
    let account: NotificationIdentity;
    try {
      account = await notificationIdentity(state.storage, env as Env, item);
    } catch {
      next = Math.min(next, now + 60_000);
      continue;
    }
    let hash = await digest(`${account.email ?? ""}`);
    const providerKey = `templ-support/${jobHash}`;
    const leased = await state.storage.transaction(async (storage) => {
      const job = await storage.get<Job>(key);
      if (!job || job.outcome || (job.leaseUntil ?? 0) > now) return null;
      const cancelled = await cancelReason(storage, job);
      if (cancelled) {
        await finish(storage, key, job, jobHash, Date.now(), "cancelled", cancelled);
        return null;
      }
      if (
        !(await supportNotificationAuthorized(storage, job, account, env)) ||
        (job.addressHash && job.addressHash !== hash)
      ) {
        await finish(
          storage,
          key,
          job,
          jobHash,
          Date.now(),
          "cancelled",
          job.addressHash && job.addressHash !== hash
            ? "recipient-changed"
            : "authorization-lost",
        );
        return null;
      }
      job.leaseUntil = now + LEASE;
      job.addressHash = hash;
      job.from ??= env.EMAIL_FROM;
      await storage.put(key, job);
      return job;
    });
    if (!leased) continue;
    let delay = 0;
    let deferredBy: Job["deferredBy"];
    try {
      await reserveSupportEmail(env as Env, providerKey);
    } catch (error) {
      deferredBy =
        error instanceof HttpError && error.status === 429
          ? "budget"
          : "reservation-unavailable";
      delay =
        error instanceof HttpError
          ? Math.max(60_000, (error.retryAfterSeconds ?? 60) * 1000)
          : 60_000;
    }
    if (!delay) {
      try {
        // The shared reservation can yield to an email unlink or revocation.
        // Read the verified identity again before the final room authorization.
        account = await notificationIdentity(state.storage, env as Env, item);
        hash = await digest(`${account.email ?? ""}`);
      } catch {
        delay = 60_000;
        deferredBy = "identity-unavailable";
      }
    }
    const job = await state.storage.transaction(async (storage) => {
      const current = await storage.get<Job>(key);
      if (
        !current ||
        current.outcome ||
        current.leaseUntil !== leased.leaseUntil
      )
        return null;
      const authorized = await supportNotificationAuthorized(
        storage,
        current,
        account,
        env,
      );
      const dispatchAt = Date.now();
      if (deadline(current) <= dispatchAt) {
        await finish(
          storage,
          key,
          current,
          jobHash,
          dispatchAt,
          (current.attempts ?? 0) > 0 ? "unknown" : "expired",
          expiryReason(current),
        );
        return null;
      }
      if (!authorized || current.addressHash !== hash) {
        await finish(
          storage,
          key,
          current,
          jobHash,
          dispatchAt,
          "cancelled",
          current.addressHash !== hash
            ? "recipient-changed"
            : "authorization-lost",
        );
        return null;
      }
      if (delay || (current.leaseUntil ?? 0) <= dispatchAt) {
        const nextAt = Math.min(
          deadline(current),
          dispatchAt + (delay || 1000),
        );
        await storage.put(key, {
          ...current,
          leaseUntil: 0,
          nextAt,
          ...(deferredBy ? { deferredBy } : {}),
        });
        next = Math.min(next, nextAt);
        return null;
      }
      // Persist before dispatch: a crash after this write is an uncertain
      // attempt, even if it happened before the provider received the request.
      current.firstAttemptAt ??=
        (current.attempts ?? 0) > 0 ? current.createdAt : dispatchAt;
      const content = await emailContent(storage, current, env, dispatchAt);
      if (!content) {
        await finish(storage, key, current, jobHash, dispatchAt, "cancelled", "nothing-waiting");
        return null;
      }
      current.attempts = (current.attempts ?? 0) + 1;
      delete current.deferredBy;
      await storage.put(key, current);
      return { ...current, content };
    });
    if (!job) continue;
    const delivered = await deliverEmail(env as Env, fetch, {
      to: account.email!,
      from: job.from,
      idempotencyKey: providerKey,
      subject: job.content.subject,
      text: job.content.text,
      ...(job.content.headers ? { headers: job.content.headers } : {}),
    }, outcome => queueRoomResources(state, env, [
      { kind: "email", provider: "resend", metric: "email-attempts", quantity: "1", unit: "request", outcome: outcome === "sent" ? "accepted" : outcome },
      ...(outcome === "sent" ? [{ kind: "email" as const, provider: "resend" as const, metric: "email-accepted" as const, quantity: "1", unit: "request" as const, outcome: "accepted" as const }] : []),
    ])).catch(() => ({
      outcome: "unknown" as const,
      status: null,
      providerMessageId: null,
    }));
    const terminal =
      delivered.outcome === "sent" ||
      job.attempts! >= 5 ||
      (delivered.status !== null &&
        delivered.status >= 400 &&
        delivered.status < 500 &&
        ![408, 409, 429].includes(delivered.status));
    const completedAt = Date.now();
    job.uncertain ||= delivered.outcome === "unknown";
    const nextAt = Math.min(
      deadline(job),
      completedAt + Math.min(HOUR, 60_000 * 2 ** job.attempts!),
    );
    await state.storage.transaction(async (storage) => {
      if (!(await storage.get(key))) return;
      if (terminal)
        await finish(
          storage,
          key,
          { ...withoutContent(job), providerId: delivered.providerMessageId },
          jobHash,
          completedAt,
          delivered.outcome === "sent"
            ? "sent"
            : job.uncertain
              ? "unknown"
              : delivered.outcome,
          delivered.outcome === "sent"
            ? "provider-accepted"
            : job.attempts! >= 5
              ? "attempts-exhausted"
              : "provider-rejected",
        );
      else await storage.put(key, { ...withoutContent(job), leaseUntil: 0, nextAt });
    });
    next = Math.min(
      next,
      terminal ? Math.max(completedAt + 1000, job.createdAt + 300_000) : nextAt,
    );
  }
  // Rotate bounded scans so a deferred first page cannot hide later jobs.
  if (entries.size >= 100) {
    await state.storage.put(CURSOR, [...entries.keys()].at(-1)!);
    next = Math.min(next, Date.now() + 60_000);
  } else {
    await state.storage.delete(CURSOR);
    if (cursor) next = Math.min(next, Date.now() + 60_000);
  }
  await state.storage.transaction(async (storage) => {
    const diagnostics = await storage.get<Diagnostic[]>(DIAGNOSTICS);
    if (!diagnostics) return;
    const retained = diagnostics.filter(
      (record) => record.completedAt + DIAGNOSTIC_LIFETIME > Date.now(),
    );
    if (retained.length) {
      if (retained.length !== diagnostics.length)
        await storage.put(DIAGNOSTICS, retained);
      next = Math.min(
        next,
        ...retained.map((record) => record.completedAt + DIAGNOSTIC_LIFETIME),
        ...retained.map((record) =>
          record.createdAt + 300_000 > Date.now()
            ? record.createdAt + 300_000
            : Infinity,
        ),
      );
    } else await storage.delete(DIAGNOSTICS);
  });
  return Number.isFinite(next) ? Math.max(Date.now() + 1000, next) : null;
}
