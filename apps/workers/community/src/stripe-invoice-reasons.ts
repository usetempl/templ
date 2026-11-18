import type { SupportCaseContributions } from "@templ/chat/support";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { HttpError } from "./common";
import { StripeClient, stripeObjectId } from "./stripe-billing";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "list" | "delete"
>;
const TOTALS_PREFIX = "stripe-invoice-reasons-v1:";
const CASE_PREFIX = "stripe-invoice-reason-case-v1:";
const INVOICE_REASON_OUTBOX_PREFIX = "stripe-invoice-reason-outbox-v1:";
const AUDIT_PREFIX = "stripe-invoice-reason-audit-v1:";
const MAX_FOOTER = 500;
const RETRY_MS = 23 * 3_600_000;
const STEPS = ["transactionCheckAt", "walletVerifiedAt", "aiAnswerAt"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const review = () =>
  new HttpError(
    409,
    "This invoice needs an operator review.",
    undefined,
    "stripe-invoice-reasons-review",
  );

/** Reads only the worker's fixed contribution keys and completed timestamps. */
export function stripeContributions(
  value: unknown,
  finalAt: number,
): SupportCaseContributions | undefined {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !STEPS.includes(key as (typeof STEPS)[number]),
    ) ||
    Object.values(value).some((at) => !natural(at) || at > finalAt)
  )
    throw new HttpError(400, "Invalid case contribution.");
  return Object.fromEntries(
    STEPS.filter((key) => value[key] !== undefined).map((key) => [
      key,
      value[key],
    ]),
  );
}

type Counts = {
  cases: number;
  transactionCheckAt: number;
  walletVerifiedAt: number;
  aiAnswerAt: number;
  missing: number;
};
type CaseReasons = {
  subscriptionId: string;
  month: string;
  steps: SupportCaseContributions;
};
const blank = (): Counts => ({
  cases: 0,
  transactionCheckAt: 0,
  walletVerifiedAt: 0,
  aiAnswerAt: 0,
  missing: 0,
});
async function counts(
  storage: Pick<Storage, "get">,
  subscription: string,
  month: string,
) {
  const value = await storage.get<Counts>(
    `${TOTALS_PREFIX}${subscription}:${month}`,
  );
  if (value === undefined) return blank();
  if (
    !object(value) ||
    (Object.keys(blank()) as (keyof Counts)[]).some(
      (key) => !natural(value[key]),
    )
  )
    throw review();
  return value;
}

/** Records accepted usage once; meter cancellation removes its reason counts.
 * Late usage belongs to the month its next-invoice debit was recorded. */
export async function noteStripeInvoiceReasons(
  storage: Storage,
  usage: {
    chargeId: string;
    subscriptionId: string;
    month: string;
    contributions?: SupportCaseContributions;
    reported: boolean;
    meterCanceled?: boolean;
    invoiceClosedAtReport?: boolean;
    lateInvoiceDebited?: boolean;
    reportAttemptAt?: number;
  },
) {
  const key = `${CASE_PREFIX}${usage.chargeId}`;
  const old = await storage.get<CaseReasons | null>(key);
  const next: CaseReasons | null =
    usage.reported &&
    !usage.meterCanceled &&
    (!usage.invoiceClosedAtReport || usage.lateInvoiceDebited)
      ? {
          subscriptionId: usage.subscriptionId,
          month: usage.invoiceClosedAtReport
            ? resolutionMonth(usage.reportAttemptAt!)
            : usage.month,
          steps: usage.contributions ?? {},
        }
      : null;
  if (JSON.stringify(old ?? null) === JSON.stringify(next)) return;
  const changed = new Map<string, Counts>();
  for (const [row, direction] of [
    [old, -1],
    [next, 1],
  ] as const) {
    if (!row) continue;
    const id = `${TOTALS_PREFIX}${row.subscriptionId}:${row.month}`;
    const total =
      changed.get(id) ?? (await counts(storage, row.subscriptionId, row.month));
    total.cases += direction;
    for (const step of STEPS)
      if (row.steps[step] !== undefined) total[step] += direction;
    if (!STEPS.some((step) => row.steps[step] !== undefined))
      total.missing += direction;
    if (Object.values(total).some((value) => !natural(value))) throw review();
    changed.set(id, total);
  }
  await storage.put({ ...Object.fromEntries(changed), [key]: next });
}

type InvoiceReasonJob = {
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  eventId: string;
  at: number;
  footer: string;
  previousFooter: string;
  months: string[];
  status: "pending" | "review";
};

/** Stores the exact bounded footer before requesting any Stripe update. */
export async function queueStripeInvoiceReasons(
  storage: Storage,
  input: {
    invoiceId: string;
    customerId: string;
    subscriptionId: string;
    eventId: string;
    months: string[];
    footer: unknown;
    now: number;
  },
) {
  const key = `${INVOICE_REASON_OUTBOX_PREFIX}${input.invoiceId}`;
  const audit = await storage.get<{ status?: string }>(
    `${AUDIT_PREFIX}${input.invoiceId}`,
  );
  if (audit?.status === "written") return;
  if (audit?.status === "review") throw review();
  if (await storage.get(key)) return;
  const lines = [
    "Pay only for resolved cases with a transaction check, a verified wallet, or an AI answer.",
  ];
  const totals = blank();
  for (const month of input.months) {
    const total = await counts(storage, input.subscriptionId, month);
    if (total.missing > 0) throw review();
    for (const name of Object.keys(totals) as (keyof Counts)[])
      totals[name] += total[name];
  }
  lines.push(
    `Recorded cases for ${input.months.map((month) => `${month.slice(0, 4)}-${month.slice(4)}`).join(", ")}: ${totals.cases}.`,
    `Transaction check: ${totals.transactionCheckAt} ${totals.transactionCheckAt === 1 ? "case" : "cases"}. Wallet verified: ${totals.walletVerifiedAt} ${totals.walletVerifiedAt === 1 ? "case" : "cases"}. AI answer: ${totals.aiAnswerAt} ${totals.aiAnswerAt === 1 ? "case" : "cases"}.`,
    "A case can have several steps. Cases with no Templ step are not billed.",
    "See your Templ statement for each case's ref and reason.",
  );
  const existing = typeof input.footer === "string" ? input.footer : "";
  const footer = [existing, lines.join("\n")].filter(Boolean).join("\n\n");
  if (footer.length > MAX_FOOTER) throw review();
  await storage.put(key, {
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
    eventId: input.eventId,
    at: input.now,
    months: input.months,
    footer,
    previousFooter: existing,
    status: "pending",
  } satisfies InvoiceReasonJob);
}

async function reviewJob(
  storage: Storage,
  key: string,
  job: InvoiceReasonJob,
  now: number,
  reason: string,
) {
  await storage.put(`${AUDIT_PREFIX}${job.invoiceId}`, {
    ...job,
    queuedAt: job.at,
    at: now,
    status: "review",
    reason,
  });
  await storage.delete(key);
  throw review();
}

/** Updates a draft's footer only after matching its current customer and
 * subscription. Failures keep the immutable request for a bounded retry. */
export async function deliverStripeInvoiceReasons(
  storage: Storage,
  client: StripeClient,
  now: number,
  invoiceId?: string,
) {
  const jobs = invoiceId
    ? new Map([
        [
          `${INVOICE_REASON_OUTBOX_PREFIX}${invoiceId}`,
          await storage.get<InvoiceReasonJob>(
            `${INVOICE_REASON_OUTBOX_PREFIX}${invoiceId}`,
          ),
        ],
      ])
    : await storage.list<InvoiceReasonJob>({
        prefix: INVOICE_REASON_OUTBOX_PREFIX,
        limit: 5,
      });
  for (const [key, job] of jobs) {
    if (!job) continue;
    if (job.status === "review") {
      if (invoiceId) throw review();
      continue;
    }
    if (now - job.at >= RETRY_MS) {
      await reviewJob(storage, key, job, now, "retry-window");
    }
    const remote = await client.request<Record<string, unknown>>(
      "GET",
      `/invoices/${job.invoiceId}`,
    );
    const parent =
      object(remote.parent) && object(remote.parent.subscription_details)
        ? remote.parent.subscription_details
        : null;
    if (
      remote.id !== job.invoiceId ||
      stripeObjectId(remote.customer) !== job.customerId ||
      stripeObjectId(parent?.subscription) !== job.subscriptionId
    ) {
      await reviewJob(storage, key, job, now, "invoice-binding");
    }
    if (remote.footer !== job.footer) {
      if (remote.status !== "draft") {
        await reviewJob(storage, key, job, now, "invoice-finalized");
      }
      if ((remote.footer ?? "") !== job.previousFooter) {
        await reviewJob(storage, key, job, now, "footer-changed");
      }
      const updated = await client.request<Record<string, unknown>>(
        "POST",
        `/invoices/${job.invoiceId}`,
        { footer: job.footer },
        `templ-invoice-reasons:${job.invoiceId}`,
      );
      if (
        updated.id !== job.invoiceId ||
        stripeObjectId(updated.customer) !== job.customerId ||
        updated.footer !== job.footer
      )
        throw review();
    }
    await storage.put(`${AUDIT_PREFIX}${job.invoiceId}`, {
      eventId: job.eventId,
      at: now,
      status: "written",
      months: job.months,
    });
    await storage.delete(key);
  }
  return !invoiceId && jobs.size === 5;
}
