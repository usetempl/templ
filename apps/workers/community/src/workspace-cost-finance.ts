import type { WorkspaceCostFinance } from "@templ/chat/workspace-costs";
import { standardPlanRecords } from "./product-standard-plan";
import { manualPostedMonth } from "./product-manual-billing";
import { checkedCase, CASE_OPENED_PREFIX, CASE_PREFIX } from "./support-cases";
import { PRODUCT_ANNUAL_PRICES, PRODUCT_LIMITS } from "@templ/chat/plans";
import { COST_MONTH } from "./workspace-cost-store";
import { HttpError, sha256Hex } from "./common";
import { PRODUCT_STATE_KEY } from "./product-entitlements";

type Storage = DurableObjectStorage | DurableObjectTransaction;
const natural = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const pad = (v: number) => String(v).padStart(16, "0");
const CENT = 10_000_000n;
/** Read-only ledger projection. No finalization, receipt, grant or billing mutation. */
export async function workspaceCostFinance(
  storage: Storage,
  month: string,
  asOf: number,
): Promise<WorkspaceCostFinance> {
  if (!COST_MONTH.test(month) || !Number.isSafeInteger(asOf))
    throw new HttpError(400, "Choose a valid accounting month.");
  const from = Date.parse(month + "-01T00:00:00.000Z"),
    date = new Date(from);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    to = Math.min(end, asOf);
  const missing: string[] = [],
    basis = [
      "Monthly access fees are allocated over their recorded service period, by UTC time.",
      "Payments are recorded cash receipts. Founder coverage without a monthly receivable earns no subscription revenue.",
      "Totals include recorded product ledgers; unrecorded founder labour and business expenses are excluded.",
    ];
  let revenue = 0n,
    payments = 0n,
    aiResolutions = 0;
  const cashSeen = new Set<string>();
  const rememberCash = async (id: string) => {
    cashSeen.add(id);
    cashSeen.add(await sha256Hex(id));
  };
  const sawCash = async (id: string) =>
    cashSeen.has(id) || cashSeen.has(await sha256Hex(id));
  const records = await standardPlanRecords(storage);
  if (records.partial)
    missing.push("Standard billing history exceeds the bounded snapshot.");
  const references = new Map(
    records.references.map((row) => [row.referenceSha256, row]),
  );
  const manualCashReferences = records.references.filter(
    (ref) => ref.cents > 0,
  );
  const unmatchedCash = () =>
    missing.push(
      "Some payment references cannot yet be matched across ledgers.",
    );
  for (const period of records.periods) {
    if (period.source === "verified-payment") {
      const overlap = Math.max(0, Math.min(to, period.endsAt, period.revokedAt ?? Infinity) - Math.max(from, period.startsAt));
      // Allocate the paid annual cents across service months without rounding away a cent.
      const year = period.annual;
      const months = PRODUCT_ANNUAL_PRICES.months;
      const fee = year
        ? Math.floor(year.totalCents * (year.month + 1) / months) - Math.floor(year.totalCents * year.month / months)
        : period.workspaceMonthlyCents;
      revenue += (BigInt(fee) * CENT * BigInt(overlap)) / BigInt(period.endsAt - period.startsAt);
      if (period.revokedAt !== null)
        missing.push("Refund or credit treatment for revoked access needs review.");
      continue;
    }
    const ref = references.get(period.referenceSha256);
    if (!ref) {
      missing.push("A paid access reference is missing.");
      continue;
    }
    if (period.source === "manual-payment" || period.monthlyDebt) {
      const overlap = Math.max(
        0,
        Math.min(to, period.endsAt, period.revokedAt ?? Infinity) -
          Math.max(from, period.startsAt),
      );
      revenue +=
        (BigInt(period.monthlyDebt?.chargedCents ?? ref.cents) * CENT * BigInt(overlap)) /
        BigInt(period.endsAt - period.startsAt);
    }
    if (period.revokedAt !== null)
      missing.push(
        "Refund or credit treatment for revoked access needs review.",
      );
  }
  for (const ref of records.references) {
    if (ref.recordedAt >= from && ref.recordedAt < to)
      payments += BigInt(ref.cents) * CENT;
    cashSeen.add(ref.referenceSha256);
  }
  for (const row of records.cases)
    if (row.countedAt !== null && row.countedAt >= from && row.countedAt < to) {
      revenue += BigInt(row.chargedCents) * CENT;
      aiResolutions++;
    }
  const monthId = month.replace("-", "");
  const prepaidUsage = await storage.list<{ at: number; period: string; answeredCaseCents: number; aiCents: number; cents: number }>({
    prefix: "product-prepaid-usage-v1:", limit: 5001,
  });
  if (prepaidUsage.size > 5000) missing.push("Prepaid usage history exceeds the bounded snapshot.");
  for (const [key, row] of [...prepaidUsage].slice(0, 5000)) {
    if (!row || !natural(row.at) || !natural(row.answeredCaseCents) || !natural(row.aiCents) ||
        !natural(row.cents) || row.cents !== row.answeredCaseCents + row.aiCents ||
        !/^\d{16}$/.test(row.period) || !key.startsWith(`product-prepaid-usage-v1:${row.period}:`))
      throw new HttpError(503, "Recorded prepaid revenue is unavailable.");
    if (row.at >= from && row.at < to) revenue += BigInt(row.cents) * CENT;
  }
  const manual = await manualPostedMonth(storage, from);
  revenue += BigInt(manual.chargedCents - manual.creditedCents) * CENT;
  const usage = await storage.get<{
    chargedCents: number;
    disputedCents: number;
    forgivenCents: number;
  }>("product-usage-month-v1:" + monthId);
  if (usage) {
    if (
      ![usage.chargedCents, usage.disputedCents, usage.forgivenCents].every(
        natural,
      )
    )
      throw new HttpError(503, "Recorded revenue is unavailable.");
    revenue += BigInt(usage.chargedCents - usage.disputedCents) * CENT;
    if (usage.forgivenCents)
      basis.push(
        "Recorded debt forgiveness is a write-off, separately from service revenue and received cash.",
      );
  }
  type Row = {
    kind?: string;
    at?: number;
    cents?: number;
    paymentId?: string;
    referenceSha256?: string;
    receipt?: unknown;
    receipts?: unknown[];
  };
  const intents = await storage.list<Row>({
    prefix: "product-payment-intent-v1:",
    limit: 5001,
  });
  if (intents.size > 5000)
    missing.push("Payment receipt history exceeds the bounded snapshot.");
  for (const intent of [...intents.values()].slice(0, 5000)) {
    for (const raw of intent.receipts ??
      (intent.receipt ? [intent.receipt] : [])) {
      const receipt = raw as {
        paymentId: string;
        usdCents: number;
        paidAt: string;
      };
      if (
        typeof receipt.paymentId !== "string" ||
        !natural(receipt.usdCents) ||
        !Number.isFinite(Date.parse(receipt.paidAt))
      )
        throw new HttpError(503, "Recorded payments are unavailable.");
      if (await sawCash(receipt.paymentId)) continue;
      if (manualCashReferences.length) {
        unmatchedCash();
        await rememberCash(receipt.paymentId);
        continue;
      }
      await rememberCash(receipt.paymentId);
      if (Date.parse(receipt.paidAt) >= from && Date.parse(receipt.paidAt) < to)
        payments += BigInt(receipt.usdCents) * CENT;
    }
  }
  for (const period of records.periods)
    if (period.source === "verified-payment" && !(await sawCash(period.paymentId!)))
      missing.push("A prepaid access payment receipt is missing.");
  for (const prefix of ["product-usage-row-v1:", "brain-storage-row-v1:"]) {
    const rows = await storage.list<Row>({ prefix, limit: 5001 });
    if (rows.size > 5000)
      missing.push("Retained service ledger exceeds the bounded snapshot.");
    for (const row of [...rows.values()].slice(0, 5000)) {
      if (!natural(row.at) || !natural(row.cents))
        throw new HttpError(503, "Recorded service totals are unavailable.");
      const id = row.paymentId ?? row.referenceSha256;
      if (row.kind === "payment" && row.at >= from && row.at < to) {
        if (!id)
          missing.push("A received payment lacks a deduplication reference.");
        else if (!(await sawCash(id))) {
          if (manualCashReferences.length) {
            unmatchedCash();
            await rememberCash(id);
            continue;
          }
          payments += BigInt(row.cents) * CENT;
          await rememberCash(id);
        }
      }
      if (prefix === "brain-storage-row-v1:" && row.at >= from && row.at < to) {
        if (row.kind === "storage") revenue += BigInt(row.cents) * CENT;
        if (row.kind === "credit") revenue -= BigInt(row.cents) * CENT;
      }
    }
  }
  if ((await storage.list({ prefix: "stripe-invoice-v1:", limit: 1 })).size)
    missing.push("Stripe records do not contain verified received amounts.");
  let tickets: number | null = 0,
    testTickets = 0;
  const opened = await storage.list({
    prefix: CASE_OPENED_PREFIX,
    start: CASE_OPENED_PREFIX + pad(from),
    end: CASE_OPENED_PREFIX + pad(to),
    limit: 5001,
  });
  if (
    opened.size > 5000 ||
    from < asOf - PRODUCT_LIMITS.supportHistoryDays * 86_400_000
  ) {
    tickets = null;
    missing.push("The complete ticket count is unavailable for this month.");
  } else {
    const keys = [...opened.keys()];
    for (let offset = 0; offset < keys.length; offset += 128) {
      const page = keys.slice(offset, offset + 128);
      const ids = page.map((key) => {
        const parts = key.split(":");
        return CASE_PREFIX + parts[2] + ":" + parts[3];
      });
      const values = await storage.get<unknown>(ids);
      for (const key of page) {
        const parts =
          /^support-case-open-v1:([0-9]{16}):(tc-[a-f0-9]{32}):([0-9]{8})$/.exec(
            key,
          );
        if (!parts) {
          tickets = null;
          continue;
        }
        const row = checkedCase(
          values.get(CASE_PREFIX + parts[2] + ":" + parts[3]),
          parts[2],
          Number(parts[3]),
        );
        if (!row || row.openedAt !== Number(parts[1])) {
          tickets = null;
          continue;
        }
        if (tickets !== null) tickets++;
        if (
          row.excluded.some((reason) =>
            ["test-account", "install-preview", "staff-preview"].includes(
              reason,
            ),
          )
        )
          testTickets++;
      }
    }
  }
  const noPlan =
    !(await storage.get(PRODUCT_STATE_KEY)) && records.periods.length === 0;
  if (noPlan) missing.push("The workspace billing ledger is not initialized.");
  const financialMissing = missing.some(
    (line) => !line.includes("ticket count"),
  );
  return {
    month,
    asOf: new Date(asOf).toISOString(),
    earnedRevenueUsdNanos: financialMissing ? null : revenue.toString(),
    paymentsReceivedUsdNanos: financialMissing ? null : payments.toString(),
    knownRevenueUsdNanos: revenue.toString(),
    knownPaymentsUsdNanos: payments.toString(),
    ticketsOpened: tickets,
    testTicketsOpened: testTickets,
    confirmedAiResolutions: records.partial ? null : aiResolutions,
    missing: [...new Set(missing)],
    basis,
  };
}
