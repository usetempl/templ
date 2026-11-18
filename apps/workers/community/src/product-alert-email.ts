/** The email a billing manager gets for each billing alert. Codes and
 * numbers only: no thread, member, wallet or message text. */
import {
  PRODUCT_BALANCE_ALERTS,
  PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
  PRODUCT_FREE_START,
  PRODUCT_RESOLUTION_RULES,
} from "@templ/chat/plans";
import {
  aiOnlyPriceLine,
  formatBalanceCents,
  formatUsdCents,
  tablePriceWords,
} from "@templ/chat/resolution-copy";
import type { BalanceAlertFacts } from "./product-alerts";
import type { MonthReportFacts } from "./product-month-report";

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** The workspace's Plan tab, from the room link a workspace job carries. */
export function planLink(href: string) {
  return `${href.split("?")[0]}?tab=plan`;
}

/** The docs page that says what counts as a resolved case, on the docs
 * site beside the app the link points to. */
export function resolvedCasesLink(href: string) {
  return `https://docs.${new URL(href).hostname}/pricing/resolved-cases`;
}

/** A billing alert email, ending with the page that says what counts as a
 * resolved case. */
export function billingAlertEmail(facts: BalanceAlertFacts, href: string) {
  const email = alertEmail(facts, href);
  return {
    subject: email.subject,
    text: `${email.text}\n\nWhat counts as a resolved case: ${resolvedCasesLink(href)}`,
  };
}

function alertEmail(facts: BalanceAlertFacts, href: string) {
  const link = planLink(href);
  const balance = formatBalanceCents(facts.balanceCents);
  const available = formatBalanceCents(facts.availableCents);
  const pauseAt = `-${formatUsdCents(PRODUCT_FREE_NEGATIVE_LIMIT_CENTS)}`;
  const topUp = `Top up on the Plan tab:\n\n${link}`;
  switch (facts.alert) {
    case "invoice-failed":
      return {
        subject: "Your Templ invoice needs payment",
        text: `Stripe could not collect your payment. Support keeps running.\n\nCheck your card and invoices on the Plan tab:\n\n${link}`,
      };
    case "used-80":
      return {
        subject: "Your Templ balance is running low",
        text: `Less than ${100 - PRODUCT_BALANCE_ALERTS.usedPercent}% of your balance after your last top-up remains. Available balance: ${available}, after charges waiting to become final.\n\nSupport continues if your balance runs out. New charges take it below zero. ${topUp}`,
      };
    case "used-100":
      return {
        subject: "Your Templ balance is used up",
        text: `Your available balance is ${available}. Support continues. New charges take the balance below zero. ${topUp}`,
      };
    case "negative":
      return {
        subject: "Your Templ balance is below zero",
        text: `Your balance is ${balance}. ${topUp}`,
      };
    case "pause-soon":
      return {
        subject: `Support pauses at ${pauseAt}`,
        text: `Your balance is ${balance}. Before your first top-up, support pauses when your balance reaches ${pauseAt}. ${topUp}`,
      };
    case "paused":
      return {
        subject: "Support is paused",
        text: `Support is paused: your balance is ${balance}. New cases and replies wait until you add balance. Your team can still read and export every case.\n\nAdd balance on the Plan tab to turn it back on:\n\n${link}`,
      };
    case "free-start-used":
      return {
        subject: `Your ${PRODUCT_FREE_START.resolvedCases} free team-handled cases are used`,
        text: `Team-handled cases cost ${tablePriceWords(facts.table)}. ${aiOnlyPriceLine(facts.table.aiOnlyUsdCents)} Your balance pays new charges. ${topUp}`,
      };
    case "burst":
      return {
        subject: "Many cases were resolved today",
        text: `Your workspace had more new resolved cases today than usual. User-confirmed cases become final after ${PRODUCT_RESOLUTION_RULES.memberFinalHours} hours. Other resolved cases become final after ${PRODUCT_RESOLUTION_RULES.finalAfterDays} days. Check them on the Plan tab under Billing soon and mark any spam before then:\n\n${link}`,
      };
    case "runway":
      return {
        subject: `About ${plural(facts.days ?? 0, "day", "days")} of balance left`,
        text: `At the last 7 days' pace, your balance of ${balance} lasts about ${plural(facts.days ?? 0, "day", "days")}. ${topUp}`,
      };
    case "grant-80":
    case "grant-14d":
    case "grant-3d":
      return {
        subject:
          facts.alert === "grant-80"
            ? "Most of your Templ credit is used"
            : `Your Templ credit ends in ${plural(facts.days ?? 0, "day", "days")}`,
        text: `Your credit covers ${plural(facts.cases ?? 0, "resolved case", "resolved cases")}. It ends in ${plural(facts.days ?? 0, "day", "days")}. After that, team-handled cases cost ${tablePriceWords(facts.table)}. ${aiOnlyPriceLine(facts.table.aiOnlyUsdCents)} Your balance pays new charges.\n\n${link}`,
      };
    case "budget-50":
    case "budget-80":
    case "budget-100": {
      const percent = facts.alert.slice("budget-".length);
      return {
        subject: `This month's Templ charges reached ${percent}% of your budget`,
        text: `Charges this month: ${formatUsdCents(facts.cents ?? 0)}. This is an alert only.\n\n${link}`,
      };
    }
    case "price-change": {
      const date = new Date(facts.appliesAt ?? 0).toISOString().slice(0, 10);
      const next = facts.newTable ?? facts.table;
      return {
        subject: `Templ prices change on ${date}`,
        text: `From ${date}, new pending cases use these prices. Team-handled cases cost ${tablePriceWords(next)}. ${aiOnlyPriceLine(next.aiOnlyUsdCents)}\n\nUntil then, team-handled cases cost ${tablePriceWords(facts.table)}. ${aiOnlyPriceLine(facts.table.aiOnlyUsdCents)} Cases already waiting to become final keep their price.\n\nSee the new prices on the Plan tab:\n\n${link}`,
      };
    }
    case "suspended":
      return {
        subject: "Templ suspended this workspace",
        text: `New cases are turned away. Your team can still read and export every case. They can answer open cases. Your balance is ${balance}.\n\nUse Ask a question on the Templ site to contact us.\n\n${link}`,
      };
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "September 2026" from `yyyymm`. */
export function monthName(month: string) {
  return `${MONTHS[Number(month.slice(4, 6)) - 1] ?? month} ${month.slice(0, 4)}`;
}
/** A duration in minutes, hours or days, rounded. */
export function durationText(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(Math.max(1, minutes), "minute", "minutes");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return plural(hours, "hour", "hours");
  return plural(Math.round(ms / 86_400_000), "day", "days");
}

/** The monthly email: last month's resolved cases, charges and cases from
 * metadata. Counts, amounts and times only. */
export function monthReportEmail(facts: MonthReportFacts, href: string) {
  const name = monthName(facts.month);
  const count = (value: number) => value.toLocaleString("en-US");
  const lines = [
    `Your Templ workspace in ${name}.`,
    "",
    `- Billed: ${plural(facts.cases, "resolved case", "resolved cases")}, ${formatUsdCents(facts.cents)}.`,
    `- Free: ${count(facts.free)}. From credit: ${count(facts.grant)}.`,
    `- Not billed: ${count(facts.voided)} reopened, ${count(facts.excluded)} spam, test or preview, ${count(facts.noReply)} with no team reply, ${count(facts.duplicate)} from the same user within a day.`,
    `- Not billed: ${count(facts.noContribution ?? 0)} with no Templ step.`,
    `- Resolved by the user: ${count(facts.byCloser.member)}. By your team: ${count(facts.byCloser.person)}. By your AI: ${count(facts.byCloser.bot)}. By Templ AI: ${count(facts.byCloser.managed)}.`,
  ];
  const a = facts.activity;
  if (a) {
    lines.push(
      `- Cases opened: ${count(a.opened)}. Answered: ${count(a.answered)}. Resolved: ${count(a.resolved)}.`,
      `- Users who said "No" to "Did this solve it?": ${count(a.notSolved)}. Reopened: ${count(a.reopened)}.`,
    );
    if (a.medianFirstReplyMs !== null)
      lines.push(
        `- Median first reply: ${durationText(a.medianFirstReplyMs)}.`,
      );
    if (a.medianResolveMs !== null)
      lines.push(
        `- Median time to resolve: ${durationText(a.medianResolveMs)}.`,
      );
    lines.push(
      `- Wallet sign-ins verified: ${count(a.walletVerified)}. Transaction checks: ${count(a.transactionChecks)}. AI drafts used: ${count(a.aiDraftsUsed)}.`,
      `- AI answers: ${count(a.aiAnswers ?? 0)}.`,
    );
    if (!a.complete)
      lines.push(
        `- Case counts cover the first ${count(a.opened)} cases of the month.`,
      );
  }
  if (facts.usage)
    lines.push(
      `- Usage charged: ${formatUsdCents(facts.usage.chargedCents)}. Payments: ${formatUsdCents(facts.usage.paidCents)}. Credits: ${formatUsdCents(facts.usage.creditedCents)}.`,
      `- Usage amount due now: ${formatUsdCents(facts.usage.dueCents)}.`,
    );
  lines.push(
    ...(!facts.usage
      ? [`- Balance now: ${formatBalanceCents(facts.balanceCents)}.`]
      : []),
    "",
    `The statement and receipts are on the Plan tab:\n\n${planLink(href)}`,
    "",
    `What counts as a resolved case: ${resolvedCasesLink(href)}`,
  );
  return { subject: `Your Templ month: ${name}`, text: lines.join("\n") };
}
