/** Billing alerts. Nothing here holds, caps or stops Support: each alert
 * is a line to the workspace's billing managers (email) and, as a
 * `capacity` event with its code only, to the team channels that asked for
 * it.
 *
 * Alerts are queued as rows in the room and sent by the `product-billing`
 * alarm consumer (product-alert-delivery.ts), which has the worker's
 * environment; request paths only queue. Each alert fires once per its own key:
 * - used-80 and used-100: once per credit;
 * - negative, pause-soon and paused: once per episode below zero, then
 *   negative every `negativeReminderDays` while it lasts;
 * - runway: once per episode under 7 days;
 * - free-start-used and burst: once (burst once per UTC day);
 * - grant-80, grant-14d and grant-3d: once per grant;
 * - budget-50, -80 and -100: once per UTC month;
 * - price-change: once per price version that makes a case cost more. */
import { customerBillingManagedByTempl } from "./customer-debt-access";
import type { StripeRoomState } from "./stripe-store";
import type { ProductBillingAlert } from "@templ/chat/product-catalog";
import {
  negativeBalanceReminderAt,
  productBalanceLevel,
  resolutionMonth,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import {
  PRODUCT_STATE_KEY,
  availableCents,
  balancePaused,
  readProductState,
  scheduledPrices,
  type ProductState,
} from "./product-entitlements";
import { wakeRoomAt } from "./room-alarm";
import type { TemplStaffEnv } from "./templ-staff";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
export const PENDING_PREFIX = "product-alert-pending-v1:";
const SENT_PREFIX = "product-alert-sent-v1:";
const NEGATIVE_KEY = "product-alert-negative-v1";
export const BUDGET_KEY = "product-budget-v1";
const DAY = 86_400_000;
const RUNWAY_DAYS = 7;
const pad16 = (value: number) =>
  String(Math.max(0, Math.floor(value))).padStart(16, "0");
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** What a billing alert email says: the code and the numbers behind it. */
export type BalanceAlertFacts = {
  alert: ProductBillingAlert;
  balanceCents: number;
  availableCents: number;
  /** The step price of the next billable case, and the table the
   * workspace pays now. */
  nextPriceCents: number;
  table: ResolutionPriceTable;
  /** runway: days left at the last 7 days' pace. grant: days to its end. */
  days?: number;
  /** grant: cases left. budget: the month's charges. */
  cases?: number;
  cents?: number;
  /** price-change: when the new table applies, and the table. */
  appliesAt?: string;
  newTable?: ResolutionPriceTable;
  card?: { invoiceId: string | null };
};

async function queue(
  storage: Storage,
  now: number,
  sentKey: string,
  facts: BalanceAlertFacts,
) {
  const native = await storage.get<{ room?: { id?: string } }>("native-room");
  if (
    facts.alert !== "suspended" &&
    customerBillingManagedByTempl(native?.room?.id ?? "")
  )
    return;
  if (await storage.get(`${SENT_PREFIX}${sentKey}`)) return;
  await storage.put(`${SENT_PREFIX}${sentKey}`, now);
  await storage.put(`${PENDING_PREFIX}${pad16(now)}:${facts.alert}`, facts);
  await wakeRoomAt(storage, now + 1_000);
}

/** A monthly budget a billing manager set, in cents, or null. */
export async function readBudget(storage: Pick<Storage, "get">) {
  const value = await storage.get<{ cents?: unknown }>(BUDGET_KEY);
  return natural(value?.cents) && value.cents > 0 ? value.cents : null;
}

/** Queues the alerts the workspace's balance, grants and month now call
 * for. `extra` carries the one-off events a caller saw. */
export async function emitBalanceAlerts(
  storage: Storage,
  state: ProductState | null,
  now: number,
  extra: {
    burst?: boolean;
    freeStartUsed?: boolean;
    suspended?: boolean;
    paceCentsPerDay?: number;
    monthCents?: number;
  },
  env: TemplStaffEnv = {},
) {
  if (!state) {
    if (!(await storage.get(PRODUCT_STATE_KEY))) return;
    state = await readProductState(storage, now, env);
  }
  if (customerBillingManagedByTempl(state.room) && !extra.suspended) return;
  const available = availableCents(state);
  const base = {
    balanceCents: state.balanceCents,
    availableCents: available,
    nextPriceCents: state.prices.table.usdCents,
    table: state.prices.table,
  };
  const change = scheduledPrices(state);
  if (change && change.noticeAt === undefined && change.appliesAt !== null)
    await queue(storage, now, `price-change:${change.priceVersion}`, {
      alert: "price-change",
      ...base,
      appliesAt: new Date(change.appliesAt).toISOString(),
      newTable: change.table,
    });
  if (extra.burst)
    await queue(
      storage,
      now,
      `burst:${new Date(now).toISOString().slice(0, 10)}`,
      {
        alert: "burst",
        ...base,
      },
    );
  if (extra.freeStartUsed)
    await queue(storage, now, "free-start-used", {
      alert: "free-start-used",
      ...base,
    });
  if (extra.suspended)
    await queue(storage, now, `suspended:${now}`, {
      alert: "suspended",
      ...base,
    });
  if (customerBillingManagedByTempl(state.room)) return;
  const level = productBalanceLevel({
    creditBaseCents: state.creditBaseCents,
    availableCents: available,
    balanceCents: state.balanceCents,
    everFunded: state.everFunded,
    paused: balancePaused(state),
    pauseWaived: state.pauseWaived,
  });
  if (level === "used-80" || level === "used-100")
    await queue(storage, now, `${level}:${state.credits}`, {
      alert: level,
      ...base,
    });
  if (state.balanceCents >= 0) await storage.delete(NEGATIVE_KEY);
  if (level === "negative" || level === "pause-soon" || level === "paused") {
    const episode = await storage.get<{ since: number; lastAt: number }>(
      NEGATIVE_KEY,
    );
    if (!episode) {
      await storage.put(NEGATIVE_KEY, { since: now, lastAt: now });
      await queue(storage, now, `negative:${now}`, {
        alert: "negative",
        ...base,
      });
    } else if (now >= negativeBalanceReminderAt(episode.lastAt)) {
      await storage.put(NEGATIVE_KEY, { ...episode, lastAt: now });
      await queue(storage, now, `negative:${now}`, {
        alert: "negative",
        ...base,
      });
    }
    const since = episode?.since ?? now;
    if (level === "pause-soon" || level === "paused")
      await queue(storage, now, `pause-soon:${since}`, {
        alert: "pause-soon",
        ...base,
      });
    if (level === "paused")
      await queue(storage, now, `paused:${since}`, {
        alert: "paused",
        ...base,
      });
  }
  // Runway: at the last 7 days' pace, the balance lasts under a week.
  const pace = extra.paceCentsPerDay ?? 0;
  if (pace > 0 && state.balanceCents > 0) {
    const days = Math.floor(state.balanceCents / pace);
    if (days < RUNWAY_DAYS)
      await queue(storage, now, `runway:${state.credits}`, {
        alert: "runway",
        ...base,
        days,
      });
  }
  for (const grant of state.grants) {
    if (grant.endsAt <= now) continue;
    const left = grant.cases - grant.used;
    const daysLeft = Math.ceil((grant.endsAt - now) / DAY);
    if (grant.cases > 0 && grant.used * 100 >= grant.cases * 80)
      await queue(storage, now, `grant-80:${grant.id}`, {
        alert: "grant-80",
        ...base,
        cases: left,
        days: daysLeft,
      });
    for (const [alert, within] of [
      ["grant-14d", 14],
      ["grant-3d", 3],
    ] as const)
      if (daysLeft <= within)
        await queue(storage, now, `${alert}:${grant.id}`, {
          alert,
          ...base,
          cases: left,
          days: daysLeft,
        });
  }
  const budget = await readBudget(storage);
  if (budget !== null && extra.monthCents !== undefined) {
    const month = resolutionMonth(now);
    for (const [alert, percent] of [
      ["budget-50", 50],
      ["budget-80", 80],
      ["budget-100", 100],
    ] as const)
      if (extra.monthCents * 100 >= budget * percent)
        await queue(storage, now, `${alert}:${month}`, {
          alert,
          ...base,
          cents: extra.monthCents,
        });
  }
}

/** Old sent markers go after 400 days. */
export async function pruneBalanceAlerts(storage: Storage, now: number) {
  const rows = await storage.list<number>({ prefix: SENT_PREFIX, limit: 50 });
  const stale = [...rows]
    .filter(([, at]) => natural(at) && at < now - 400 * DAY)
    .map(([key]) => key);
  if (stale.length) await storage.delete(stale);
}

/** Unpaid invoices ask for human outreach. They never stop support. */
export async function emitCardAlerts(
  storage: Storage,
  card: StripeRoomState,
  now: number,
  env: TemplStaffEnv = {},
): Promise<number | null> {
  if (card.status !== "past-due" && !card.unpaidInvoiceIds?.length) return null;
  const invoices = card.unpaidInvoiceIds?.length
    ? card.unpaidInvoiceIds
    : [card.latestInvoice?.id ?? card.subscriptionId].filter(
        (id): id is string => id !== null,
      );
  if (!invoices.length) return null;
  const product = await readProductState(storage, now, env);
  if (customerBillingManagedByTempl(product.room)) return null;
  const reminders: number[] = [];
  for (const [index, invoice] of invoices.entries()) {
    const key = `product-card-reminder-v1:${invoice}`;
    const last = await storage.get<number>(key);
    const next = last === undefined ? now : negativeBalanceReminderAt(last);
    if (now >= next) {
      await queue(
        storage,
        now + index,
        `invoice-failed:${invoice}:${last === undefined ? "first" : now}`,
        {
          alert: "invoice-failed",
          balanceCents: product.balanceCents,
          availableCents: availableCents(product),
          nextPriceCents: product.prices.table.usdCents,
          table: product.prices.table,
          card: { invoiceId: invoice },
        },
      );
      await storage.put(key, now);
      reminders.push(negativeBalanceReminderAt(now));
    } else reminders.push(next);
  }
  return Math.min(...reminders);
}
