import { deliverEmail, type EmailEnv } from "./email-delivery";
import { HttpError } from "./common";

/** The email outbox in the `templ-feedback:v1` object. Each kind of email
 * queues jobs under its own prefix; the object's alarm drains every kind with
 * one lease, attempt cap and backoff. */

/** Shared by every kind of queued email: jobs waiting at once, provider
 * attempts per job and days a job may wait before it fails. */
export const OUTBOX_LIMITS = {
  queuedEmails: 1000,
  emailAttempts: 4,
  emailQueueDays: 7,
} as const;
/** Jobs waiting across every kind; nothing more is queued at OUTBOX_LIMITS.queuedEmails. */
export const OUTBOX_COUNT_KEY = "feedback-outbox-count";
const DAY = 86_400_000;

export type Outbox = {
  ticketId: string;
  messageId: string;
  email: string;
  from: string;
  url: string;
  createdAt: number;
  attempts: number;
  firstAttemptAt: number | null;
  leaseId?: string;
  nextAt: number;
  status: "queued" | "sending";
  providerMessageId: string | null;
};
export type OutboxState = "queued" | "sending" | "sent" | "failed";
/** One kind of queued email. The alarm drains every kind through the same
 * lease, attempt cap, backoff and provider idempotency window. */
export type OutboxKind<E extends EmailEnv = EmailEnv> = {
  /** Storage prefix of this kind's jobs. */
  prefix: string;
  /** False while this kind cannot send: the job waits an hour. */
  available(env: E): boolean;
  /** Reserves send capacity before the provider call. Answers 0 to send
   * now or a delay in milliseconds; a thrown 429 waits for its Retry-After. */
  reserve(
    storage: DurableObjectStorage,
    env: E,
    job: Outbox,
    now: number,
  ): Promise<number>;
  /** Records the job's delivery state where this kind reports it. */
  record(
    storage: DurableObjectTransaction,
    job: Outbox,
    state: OutboxState,
    now: number,
  ): Promise<void>;
  /** The fixed email for a job; it never carries the queued content. */
  message(job: Outbox): { subject: string; text: string };
};

async function finishNotification<E extends EmailEnv>(
  storage: DurableObjectTransaction,
  kind: OutboxKind<E>,
  key: string,
  job: Outbox,
  sent: boolean,
  now: number,
) {
  await kind.record(storage, job, sent ? "sent" : "failed", now);
  await storage.delete(key);
  await storage.put(
    OUTBOX_COUNT_KEY,
    Math.max(0, ((await storage.get<number>(OUTBOX_COUNT_KEY)) ?? 1) - 1),
  );
}
function deliveryDeadline(job: Outbox) {
  return Math.min(
    job.createdAt + OUTBOX_LIMITS.emailQueueDays * DAY,
    job.firstAttemptAt === null
      ? Infinity
      : job.firstAttemptAt + 23 * 3_600_000,
  );
}
/** Drains the given kinds. Each email carries only a fixed notification and
 * a private URL, never the queued content. */
export async function deliverQueuedEmails<E extends EmailEnv>(
  state: DurableObjectState,
  env: E,
  kinds: readonly OutboxKind<E>[],
  fetcher: typeof fetch = fetch,
) {
  const now = Date.now(),
    jobs: [string, Outbox, OutboxKind<E>][] = [];
  for (const kind of kinds)
    for (const [key, job] of await state.storage.list<Outbox>({
      prefix: kind.prefix,
      limit: OUTBOX_LIMITS.queuedEmails,
    }))
      jobs.push([key, job, kind]);
  let processed = 0,
    next = Infinity;
  for (const [key, job, kind] of jobs) {
    if (job.nextAt > now || processed >= 10) {
      next = Math.min(next, Math.max(now + 1000, job.nextAt));
      continue;
    }
    const leased = await state.storage.transaction(async (storage) => {
      const latest = await storage.get<Outbox>(key);
      if (!latest || latest.nextAt > now) return null;
      if (
        deliveryDeadline(latest) <= now ||
        latest.attempts >= OUTBOX_LIMITS.emailAttempts
      ) {
        await finishNotification(storage, kind, key, latest, false, now);
        return null;
      }
      const lease = {
        ...latest,
        status: "sending" as const,
        leaseId: crypto.randomUUID(),
        nextAt: now + 60_000,
      };
      await storage.put(key, lease);
      await kind.record(storage, lease, "sending", now);
      await storage.setAlarm(lease.nextAt);
      return lease;
    });
    if (!leased) continue;
    processed++;
    let defer = 0;
    if (!kind.available(env)) defer = 3_600_000;
    else
      try {
        defer = await kind.reserve(state.storage, env, leased, now);
      } catch (error) {
        defer =
          error instanceof HttpError && error.status === 429
            ? Math.max(1000, (error.retryAfterSeconds ?? 60) * 1000 + 1000)
            : 60_000;
      }
    if (defer) {
      await state.storage.transaction(async (storage) => {
        const latest = await storage.get<Outbox>(key);
        if (!latest || latest.leaseId !== leased.leaseId) return;
        latest.status = "queued";
        delete latest.leaseId;
        latest.nextAt = Math.min(now + defer, deliveryDeadline(latest));
        await storage.put(key, latest);
        await kind.record(storage, latest, "queued", now);
        next = Math.min(next, latest.nextAt);
      });
      continue;
    }
    // Persist admission before fetch. A crash here conservatively counts one actual delivery attempt.
    const admitted = await state.storage.transaction(async (storage) => {
      const latest = await storage.get<Outbox>(key);
      if (!latest || latest.leaseId !== leased.leaseId) return null;
      latest.attempts++;
      latest.firstAttemptAt ??= now;
      await storage.put(key, latest);
      return latest;
    });
    if (!admitted) continue;
    // An ambiguous delivery retries only with the identical provider key and payload.
    const delivery = await deliverEmail(env, fetcher, {
      to: admitted.email,
      from: admitted.from,
      idempotencyKey: `templ-feedback/${admitted.ticketId}/${admitted.messageId}`,
      ...kind.message(admitted),
    });
    const sent = delivery.outcome === "sent",
      permanent =
        delivery.status !== null &&
        delivery.status >= 400 &&
        delivery.status < 500 &&
        ![408, 409, 429].includes(delivery.status);
    await state.storage.transaction(async (storage) => {
      const latest = await storage.get<Outbox>(key);
      if (!latest || latest.leaseId !== admitted.leaseId) return;
      if (sent) latest.providerMessageId = delivery.providerMessageId;
      if (sent || permanent || latest.attempts >= OUTBOX_LIMITS.emailAttempts)
        await finishNotification(storage, kind, key, latest, sent, now);
      else {
        latest.status = "queued";
        delete latest.leaseId;
        latest.nextAt = Math.min(
          now + [60_000, 300_000, 3_600_000][Math.min(latest.attempts - 1, 2)],
          deliveryDeadline(latest),
        );
        await storage.put(key, latest);
        await kind.record(storage, latest, "queued", now);
        next = Math.min(next, latest.nextAt);
      }
    });
  }
  if (Number.isFinite(next)) await state.storage.setAlarm(next);
}
