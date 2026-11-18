import { deliverQueuedEmails, OUTBOX_COUNT_KEY } from "./email-outbox";
import {
  FEEDBACK_REPLY_OUTBOX,
  feedbackOperationRoute,
  type FeedbackEnv,
} from "./feedback";
import { HttpError, json } from "./common";

/** Sends the queued feedback replies. */
export function deliverFeedbackNotifications(
  state: DurableObjectState,
  env: FeedbackEnv,
  fetcher: typeof fetch = fetch,
) {
  return deliverQueuedEmails<FeedbackEnv>(
    state,
    env,
    [FEEDBACK_REPLY_OUTBOX],
    fetcher,
  );
}

const DAY = 86_400_000;
const RETIRED_CONTACT = {
  /** How long a stored contact request is kept. */
  retentionDays: 365,
  statuses: ["new", "contacted", "closed"],
  batch: 100,
} as const;
const stamp = (time: number) => String(time).padStart(16, "0");
/** Stored contact requests stay private, and no route adds or reads them.
 * Each one is deleted 365 days after it arrived. Their notices and daily
 * counters are deleted at once, since nothing sends or reads them. */
export async function sweepRetiredContactRequests(
  state: DurableObjectState,
  now = Date.now(),
) {
  const cutoff = now - RETIRED_CONTACT.retentionDays * DAY;
  for (const status of RETIRED_CONTACT.statuses) {
    const prefix = `contact-index:${status}:`;
    const rows = await state.storage.list<string>({
      prefix,
      end: `${prefix}${stamp(cutoff)}`,
      limit: RETIRED_CONTACT.batch,
    });
    for (const [key, id] of rows)
      await state.storage.delete([key, `contact-request:${id}`]);
  }
  await state.storage.transaction(async (storage) => {
    const notices = await storage.list({
      prefix: "contact-outbox:",
      limit: RETIRED_CONTACT.batch,
    });
    if (!notices.size) return;
    await storage.delete([...notices.keys()]);
    await storage.put(
      OUTBOX_COUNT_KEY,
      Math.max(
        0,
        ((await storage.get<number>(OUTBOX_COUNT_KEY)) ?? 0) - notices.size,
      ),
    );
  });
  for (const prefix of ["contact-owner:", "contact-operator-sends:"]) {
    const counters = await state.storage.list({ prefix, limit: 1000 });
    if (counters.size) await state.storage.delete([...counters.keys()]);
  }
  const remaining = await state.storage.list({
    prefix: "contact-request:",
    limit: 1,
  });
  if (!remaining.size) return;
  const alarm = await state.storage.getAlarm();
  if (alarm === null || alarm > now + DAY || alarm <= now)
    await state.storage.setAlarm(now + DAY);
}

/** The private `templ-feedback:v1` object. It keeps feedback tickets, their
 * email outbox and, until they expire, stored contact requests. */
export class FeedbackStore {
  constructor(
    private state: DurableObjectState,
    private env: FeedbackEnv,
  ) {}
  async fetch(request: Request) {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/feedback" && request.method === "POST")
        return await feedbackOperationRoute(this.state, this.env, request);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Feedback is temporarily unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
        error instanceof HttpError && error.retryAfterSeconds
          ? { "Retry-After": String(error.retryAfterSeconds) }
          : {},
      );
    }
  }
  async alarm() {
    await deliverFeedbackNotifications(this.state, this.env);
    await sweepRetiredContactRequests(this.state);
  }
}
