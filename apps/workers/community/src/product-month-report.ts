/** The monthly email to billing managers and the finance address: the
 * past UTC month's resolved cases and charges from charge metadata, and
 * its cases from the case ledger. Counts, amounts and times only. It goes
 * once per month, from the room alarm, early in the next month. */
import { billingManagedForWorkspace } from "./customer-debt-access";
import {
  PRODUCT_CHARGE_CLOSERS,
  type ProductChargeCloser,
  type ProductMonthActivity,
} from "@templ/chat/product-catalog";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { monthActivity, monthRange } from "./product-case-facts";
import { readChargeMonth } from "./product-charges";
import { PRODUCT_STATE_KEY, readProductState } from "./product-entitlements";
import { usageStatement, usageTotals } from "./product-usage-billing";
import { monthReportEmail } from "./product-alert-email";
import { queueFinanceEmail } from "./product-finance-email";
import { roomPermissionHolders } from "./support-alert-emit";
import { queueNotificationJob } from "./support-notifications";
import type { TemplStaffEnv } from "./templ-staff";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
const SENT_PREFIX = "product-month-report-v1:";

/** What the monthly email says. */
export type MonthReportFacts = {
  /** `yyyymm`. */
  month: string;
  cases: number;
  cents: number;
  free: number;
  grant: number;
  voided: number;
  excluded: number;
  noReply: number;
  noContribution?: number;
  duplicate: number;
  memberConfirmed: number;
  byCloser: Record<ProductChargeCloser, number>;
  activity: ProductMonthActivity | null;
  balanceCents: number;
  usage?: {
    chargedCents: number;
    paidCents: number;
    creditedCents: number;
    dueCents: number;
  };
};

/** The month before `month` (`yyyymm`). */
export function previousMonth(month: string) {
  const range = monthRange(month)!;
  return resolutionMonth(range.from - 1);
}

/** Queues last month's email once, when the month had any case or charge.
 * Returns when the room should wake for next month's, or null when this
 * month has nothing to report yet. */
export async function queueMonthReport(
  storage: Storage,
  env: { APP_ORIGIN?: string } & TemplStaffEnv,
  now: number,
): Promise<number | null> {
  const nativeRoom = await storage.get<{ room?: { id?: string } }>("native-room");
  if (await billingManagedForWorkspace(storage, nativeRoom?.room?.id ?? "")) return null;
  if (!(await storage.get(PRODUCT_STATE_KEY))) return null;
  const current = resolutionMonth(now);
  const next = monthRange(current)!.to;
  const month = previousMonth(current);
  const sentKey = `${SENT_PREFIX}${month}`;
  const active = async (id: string) => {
    const totals = await readChargeMonth(storage, id);
    const usage = await usageStatement(storage, id);
    return (
      totals.cases +
        totals.free +
        totals.grant +
        totals.exempt +
        totals.voided +
        totals.excluded +
        totals.noReply +
        totals.noContribution +
        totals.duplicate +
        totals.off >
        0 ||
      Boolean(
        usage &&
        usage.chargedCents +
          usage.paidCents +
          usage.disputedCents +
          usage.forgivenCents >
          0,
      )
    );
  };
  if (!(await storage.get(sentKey))) {
    await storage.put(sentKey, now);
    const activity = await monthActivity(storage as never, month);
    if ((await active(month)) || (activity?.opened ?? 0) > 0) {
      const totals = await readChargeMonth(storage, month);
      const state = await readProductState(storage, now, env);
      const usage = await usageStatement(storage, month);
      const facts: MonthReportFacts = {
        ...(usage
          ? {
              usage: {
                chargedCents: usage.chargedCents,
                paidCents: usage.paidCents,
                creditedCents: usage.disputedCents + usage.forgivenCents,
                dueCents: (await usageTotals(storage)).dueCents,
              },
            }
          : {}),
        month,
        cases: totals.cases,
        cents: totals.cents,
        free: totals.free,
        grant: totals.grant,
        voided: totals.voided,
        excluded: totals.excluded,
        noReply: totals.noReply,
        noContribution: totals.noContribution,
        duplicate: totals.duplicate,
        memberConfirmed: totals.memberConfirmed,
        byCloser: Object.fromEntries(
          PRODUCT_CHARGE_CLOSERS.map((closer) => [
            closer,
            totals.byCloser[closer] ?? 0,
          ]),
        ) as MonthReportFacts["byCloser"],
        activity,
        balanceCents: state.balanceCents,
      };
      const native = await storage.get<{ room?: { id?: string } }>(
        "native-room",
      );
      if (native?.room?.id) {
        const room = `room:${native.room.id}`;
        const appOrigin = env.APP_ORIGIN ?? "https://templ.vip";
        const holders = await roomPermissionHolders(
          storage as never,
          "manageBilling",
          env,
          now,
        );
        const recipients = [
          ...new Set([
            ...(holders.manager ? [holders.manager] : []),
            ...holders.handlers,
          ]),
        ];
        for (const [offset, recipient] of recipients.entries())
          await queueNotificationJob(storage, {
            now: now + offset,
            room,
            appOrigin,
            recipient,
            kind: "workspace",
            conversation: null,
            bucketMs: 1,
            facts: { month: facts },
          }, env);
        const email = monthReportEmail(
          facts,
          `${appOrigin}/inbox/${native.room.id}?team=1`,
        );
        await queueFinanceEmail(storage, now, {
          id: `month-${month}`,
          ...email,
        });
      }
    }
  }
  return (await active(current)) ? next : null;
}
