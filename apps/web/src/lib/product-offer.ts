import {
  PRODUCT_BALANCE_ALERTS,
  PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
  PRODUCT_FREE_START,
  PRODUCT_OFFER_VERSION,
  PRODUCT_TOP_UP,
  PRODUCT_STANDARD_PRICES,
  PRODUCT_STANDARD_RECORDED_PRICES,
} from "@templ/chat/plans";
import { prepaidRateCardMatches, starterPricesForVersion } from "@templ/chat/standard-plan";
import type {
  MemberProductView,
  ProductAccessView,
  ProductCaseAdded,
  ProductCaseBilling,
  ProductChargeView,
  ProductMonthActivity,
} from "@templ/chat/product-catalog";
import {
  productTopUp,
  type ResolutionPriceStep,
} from "@templ/chat/resolution-pricing";
import { ANNUAL_PAYMENT_NETWORKS, accessPaymentCents, type ProductPaymentIntent } from "@templ/chat/product-payment";
import {
  captureStandardAiRate,
  checkedStandardAiRate,
} from "@templ/chat/standard-usage";
import type { SupportCaseContributions } from "@templ/chat/support";
import {
  formatBalanceCents,
  stepsPriceWords,
  TOP_UP_BONUS,
  TOP_UP_BOUNDS,
} from "@templ/chat/resolution-copy";
import { SITE } from "./site-environment";
import { formatDay, formatUsd } from "./product-format";
// The resolved-case offer: the pricing line, the pause line, the price
// table and the definition of a resolved case, read from plans.ts. Public
// pages import them from here.
export {
  BILLABLE_CASE_LINE,
  NO_SEATS,
  RESOLUTION_DEFINITION,
  AI_ONLY_PRICE_LINE,
  AI_ONLY_DEFINITION,
  aiOnlyPriceLine,
  CUSTOM_PRICING_LINE,
  pauseLine,
  priceSteps,
  pricingLine,
} from "./resolution-offer";
export { PRODUCT_OFFER_VERSION, PRODUCT_TOP_UP, TOP_UP_BONUS, TOP_UP_BOUNDS };

/** What the plan route answers: the billing view for billing staff, the
 * open-or-closed view for everyone else. */
export type ProductView =
  | (ProductAccessView & { canManage: true })
  | (MemberProductView & { canManage: false });
export const isBillingView = (
  view: ProductView | ProductAccessView | MemberProductView,
): view is ProductAccessView & { canManage?: boolean } => "balance" in view;

export function countLabel(value: number): string {
  return value.toLocaleString("en-US");
}
const plural = (count: number, one: string, many: string) =>
  `${countLabel(count)} ${count === 1 ? one : many}`;

/** The top-up amounts the Plan tab offers first: the minimum, a middle
 * amount and the first bonus step. Any whole-dollar amount in bounds works
 * too. */
export const TOP_UP_SUGGESTIONS: readonly number[] = [
  PRODUCT_TOP_UP.minUsdCents,
  PRODUCT_TOP_UP.suggestedUsdCents,
  PRODUCT_TOP_UP.bonusTenFromUsdCents,
];
/** The amount a top-up form holds in dollars, as cents, or null when it
 * isn't whole dollars in bounds. */
export function topUpCents(dollars: string): number | null {
  if (!/^\d{1,6}$/.test(dollars.trim())) return null;
  return productTopUp(Number(dollars.trim()) * 100)?.usdCents ?? null;
}

/** "2 of 3 free eligible team-handled cases used." Null when this workspace has no free
 * start (another workspace of the owner or the app holds it). */
export function freeStartLine(view: ProductAccessView): string | null {
  if (view.billingManagedByTempl) return null;
  if (view.free.status === "denied") return null;
  const total = PRODUCT_FREE_START.resolvedCases;
  if (view.free.status === "unreserved")
    return `Your first ${plural(total, "eligible team-handled case is", "eligible team-handled cases are")} free.`;
  return `${countLabel(view.free.used)} of ${plural(total, "free eligible team-handled case", "free eligible team-handled cases")} used.`;
}
/** Each active grant's cases left and end date. */
export function grantLines(view: ProductAccessView): string[] {
  if (view.billingManagedByTempl) return [];
  const name = {
    founding: "Founding credit",
    pilot: "Pilot credit",
    "capacity-test": "Test credit",
    "managed-agent": "AI agent credit",
  } as const;
  return view.grants.map(
    (grant) =>
      `${name[grant.kind]}: ${plural(Math.max(0, grant.cases - grant.used), "case", "cases")} left, ends ${formatDay(grant.endsAt) ?? "soon"}.`,
  );
}
/** The balance as a signed dollar amount. */
export const balanceLabel = (cents: number) => formatBalanceCents(cents);
/** "At the last 7 days' pace your balance lasts about 12 days." */
export function runwayLine(view: ProductAccessView): string | null {
  if (view.billingManagedByTempl) return null;
  const days = view.balance.runwayDays;
  if (days === null) return null;
  return `At the last 7 days’ pace your balance lasts about ${plural(days, "day", "days")}.`;
}

/** The public page that says what counts as a resolved case, with worked
 * examples. The Plan tab, every charge row and every billing alert link
 * to it. */
export const RESOLVED_CASES_DOCS = `${SITE.docs}/pricing/resolved-cases`;

/** One line for the balance level the service reports; null when there is
 * nothing to say. Paused and suspended have their own message. */
export function balanceLevelLine(view: ProductAccessView): string | null {
  if (view.billingManagedByTempl) return null;
  switch (view.balance.level) {
    case "used-80":
      return `Less than ${100 - PRODUCT_BALANCE_ALERTS.usedPercent}% of your balance after your last top-up is left.`;
    case "used-100":
      return "Your balance is used up. Support keeps running, and new eligible charges take it below zero.";
    case "negative":
      return view.balance.everFunded
        ? "Your balance is below zero. Support keeps running. Add balance to cover it."
        : `Your balance is below zero. Support pauses at ${balanceLabel(-PRODUCT_FREE_NEGATIVE_LIMIT_CENTS)} until you add balance.`;
    case "pause-soon":
      return `Support pauses at ${balanceLabel(-PRODUCT_FREE_NEGATIVE_LIMIT_CENTS)} until you add balance.`;
    default:
      return null;
  }
}
/** "12 of 15 resolved cases were confirmed by the user." Null before any
 * case went final this month. */
export function confirmedShareLine(view: ProductAccessView): string | null {
  const month = view.month;
  const final = month.cases + month.free + month.grant + month.exempt;
  if (final === 0) return null;
  return `${countLabel(month.memberConfirmed)} of ${plural(final, "resolved case was", "resolved cases were")} confirmed by the user.`;
}

/** Whether new requests are turned away now. */
export const supportClosed = (view: { support: { canAdmit: boolean } }) =>
  !view.support.canAdmit;
/** What billing staff read while Support is paused or suspended; null
 * while it runs. */
export function supportClosedMessage(
  view: ProductAccessView | MemberProductView,
): string | null {
  if (isBillingView(view)) {
    if (
      view.standardPlan?.status === "demo" &&
      view.standardPlan.ticketsUsed >= view.standardPlan.ticketsTotal
    )
      return "The free ticket limit is reached. Finish existing tickets or pay for workspace access to take new ones.";
    if (view.mode === "paused")
      return `Support is paused: your balance is ${balanceLabel(view.balance.balanceCents)}. Add balance to turn it back on.`;
    if (view.mode === "suspended")
      return "Templ suspended this workspace. Your team can still answer open cases. Talk to us about reopening support.";
    return null;
  }
  return view.mode === "closed"
    ? "Your team can’t take new cases right now."
    : null;
}
/** Home and chat show free team-handled cases alongside any balance use. */
export function planSummary(view: ProductAccessView): string {
  const closed = supportClosedMessage(view);
  if (closed) return closed;
  if (view.billingManagedByTempl) return "Ongoing access";
  if (view.mode === "exempt") return "Templ covers this workspace.";
  const free =
    view.free.status === "reserved" &&
    view.free.used < PRODUCT_FREE_START.resolvedCases
      ? freeStartLine(view)
      : null;
  if (
    free &&
    view.balance.balanceCents === 0 &&
    view.balance.pendingCents === 0 &&
    view.month.cases === 0
  )
    return free;
  const pending =
    view.balance.pendingCents > 0
      ? ` Billing soon ${formatUsd(view.balance.pendingCents)}.`
      : "";
  const month = `${plural(view.month.cases, "resolved case", "resolved cases")} billed this month (${formatUsd(view.month.cents)}).`;
  return `${free ? `${free} ` : ""}Balance ${balanceLabel(view.balance.balanceCents)}.${pending} ${month}`;
}

/** How a charge row names who resolved it. */
export function chargeCloserLabel(
  charge: Pick<ProductChargeView, "resolvedBy" | "closer">,
) {
  if (charge.resolvedBy === "member") return "User confirmed";
  return charge.closer === "managed"
    ? "Marked by Templ AI"
    : charge.closer === "bot"
      ? "Marked by your AI"
      : "Marked by your team";
}
const NOT_BILLED: Record<
  Extract<ProductCaseBilling, { status: "not-billed" }>["reason"],
  string
> = {
  spam: "spam",
  "test-account": "test account",
  "staff-preview": "team preview",
  "install-preview": "install check",
  canary: "Templ check",
  "no-reply": "no team reply",
  duplicate: "same user within a day",
  voided: "reopened",
  exempt: "covered by Templ",
  credited: "credited back",
  "monthly cap": "monthly cap",
  "pilot cap": "pilot cap",
  "no Templ contribution": "no Templ step",
};
/** The worker-recorded steps that make a resolved case billable. */
export function contributionBillingLabel(
  contributions: SupportCaseContributions | undefined,
): string | null {
  const steps = [
    ...(contributions?.transactionCheckAt !== undefined
      ? ["transaction check"]
      : []),
    ...(contributions?.walletVerifiedAt !== undefined
      ? ["wallet verified"]
      : []),
    ...(contributions?.aiAnswerAt !== undefined ? ["AI answer"] : []),
  ];
  return steps.length > 0 ? `Billable: ${steps.join(", ")}` : null;
}
/** The case line the team sees under a resolved request: whether it bills,
 * never an amount. */
export function caseBillingLabel(billing: ProductCaseBilling): string {
  const billable = contributionBillingLabel(billing.contributions);
  const status =
    billing.status === "pending" && billing.contributions && !billable
      ? "Not billed: no Templ step"
      : billing.status === "billed"
        ? "Billed"
        : billing.status === "free"
          ? "Free"
          : billing.status === "pending"
            ? billing.awaitingMemberYes
              ? "Bills after user Yes"
              : "Bills unless reopened"
            : `Not billed: ${NOT_BILLED[billing.reason]}`;
  const label =
    billable && billing.status !== "not-billed"
      ? `${billable}${billing.status === "billed" ? "" : `. ${status}.`}`
      : status;
  return billing.templAi ? `Resolved by Templ AI. ${label}` : label;
}
/** How a charge row names its state. */
export function chargeStateLabel(charge: ProductChargeView): string {
  switch (charge.state) {
    case "pending":
    case "confirmed":
      if (
        charge.contributions &&
        !contributionBillingLabel(charge.contributions)
      )
        return "Not billed: no Templ step";
      if (charge.closer === "managed" && charge.finalDueAt === null)
        return "Bills after user Yes";
      return `Goes final ${formatDay(charge.finalDueAt) ?? "soon"}`;
    case "final":
      if (charge.reason === "monthly cap" || charge.reason === "pilot cap")
        return `Billed ${formatUsd(charge.priceCents)} (${charge.reason})`;
      return charge.source === "free"
        ? "Free"
        : charge.source === "grant"
          ? "From credit"
          : charge.source === "off"
            ? "Not billed: billing is off"
            : charge.source === "manual"
              ? `Due ${formatUsd(charge.priceCents)}, manual billing`
              : `Billed ${formatUsd(charge.priceCents)}`;
    case "credited":
      return charge.source === "manual"
        ? "Amount due reduced"
        : "Credited back";
    case "voided":
      return "Not billed: reopened";
    case "excluded":
      return `Not billed: ${charge.reason === "test-account" ? "test account" : charge.reason === "staff-preview" ? "team preview" : charge.reason === "install-preview" ? "install check" : charge.reason === "canary" ? "Templ check" : "spam"}`;
    case "no-reply":
      return "Not billed: no team reply";
    case "not-billable":
      return "Not billed: no Templ step";
    case "duplicate":
      return "Not billed: same user within a day";
    case "exempt":
      return "Not billed: covered by Templ";
  }
}

export const PAYMENT_MISMATCH =
  "This payment does not match the reviewed workspace, wallet and amount.";
/** A payment request checked before anyone signs: a top-up amount the
 * offer takes, and a preview that credits exactly that amount plus its
 * bonus. */
export function checkTopUp(intent: ProductPaymentIntent) {
  if (intent.settlement === "standard-prepaid") {
    const terms = intent.standard;
    const starter = starterPricesForVersion(terms?.priceVersion);
    const prices = starter ?? [
      PRODUCT_STANDARD_PRICES,
      PRODUCT_STANDARD_RECORDED_PRICES,
    ].find((entry) => entry.publishedOn === terms?.priceVersion);
    if (
      !terms ||
      !prices ||
      !["period", "annual", "credit"].includes(terms.purpose) ||
      (terms.purpose === "credit" && terms.annualPriceVersion !== undefined) ||
      (terms.purpose === "annual" && !ANNUAL_PAYMENT_NETWORKS.includes(intent.network)) ||
      (starter && terms.purpose === "credit") ||
      !(
        terms.expectedPeriod === null || /^\d{16}$/.test(terms.expectedPeriod)
      ) ||
      terms.priceVersion !== prices.publishedOn ||
      terms.workspaceMonthlyCents !== prices.workspaceMonthlyUsdCents ||
      terms.includedAnsweredCases !== prices.includedAnsweredCasesPerMonth ||
      terms.additionalAnsweredCaseCents !==
        prices.additionalAnsweredCaseUsdCents ||
      terms.includedAiCreditCents !== prices.includedAiCreditUsdCents ||
      !checkedStandardAiRate(terms) ||
      JSON.stringify(captureStandardAiRate(terms)) !==
        JSON.stringify(captureStandardAiRate(prices)) ||
      !prepaidRateCardMatches(terms.priceVersion, terms.aiRateCardVersion) ||
      !["ethereum-usdc", "base-usdc", "bnb-usdc", "solana-usdc"].includes(
        intent.rail,
      ) ||
      intent.asset.symbol !== "USDC" ||
      intent.orderFormId !== undefined ||
      !Number.isSafeInteger(intent.usdCents) ||
      intent.usdCents <= 0 ||
      intent.usdCents > PRODUCT_TOP_UP.maxUsdCents ||
      (terms.purpose !== "credit" && intent.usdCents !== accessPaymentCents(terms)) ||
      intent.preview?.bonusCents !== 0
    )
      throw new Error(PAYMENT_MISMATCH);
  } else if (intent.standard !== undefined) throw new Error(PAYMENT_MISMATCH);
  if (
    intent.offerVersion !== PRODUCT_OFFER_VERSION ||
    (intent.settlement === "standard-prepaid"
      ? false
      : intent.settlement === "manual-usage"
        ? !Number.isSafeInteger(intent.usdCents) ||
          intent.usdCents <= 0 ||
          intent.usdCents > 100_000 ||
          !intent.orderFormId ||
          !intent.orderFormRevision
        : intent.orderFormId
          ? !Number.isSafeInteger(intent.usdCents) ||
            intent.usdCents <= 0 ||
            intent.usdCents > 25_000_000 ||
            intent.usdCents % 100 !== 0
          : !productTopUp(intent.usdCents))
  )
    throw new Error(PAYMENT_MISMATCH);
  const preview = intent.preview;
  if (
    !preview ||
    preview.usdCents !== intent.usdCents ||
    !Number.isSafeInteger(preview.bonusCents) ||
    preview.bonusCents < 0 ||
    Boolean(intent.orderFormId && preview.bonusCents !== 0) ||
    preview.balanceAfterCents !==
      preview.balanceBeforeCents + preview.usdCents + preview.bonusCents ||
    !Number.isFinite(Date.parse(preview.calculatedAt))
  )
    throw new Error(
      "The top-up preview could not be verified. Review the payment again.",
    );
  return preview;
}

/** The Plan tab's team rate from the workspace's current price table. */
export function planPriceLine(steps: ResolutionPriceStep[]): string {
  const [first, volume] = steps;
  const price = formatUsd(first.usdCents);
  return volume && first.toCase !== null && volume.usdCents < first.usdCents
    ? `${price} per team-handled case. ${formatUsd(volume.usdCents)} after ${countLabel(first.toCase)} billed team-handled cases in a UTC month.`
    : `${price} per team-handled case.`;
}

/** A waiting price change, with its notice date and both case rates. */
export function priceChangeLine(view: ProductAccessView): string | null {
  if (view.billingManagedByTempl) return null;
  const change = view.priceChange;
  if (!change) return null;
  if (!change.appliesAt)
    return "Your price change waits for billing emails. Your current price still applies.";
  const notice = change.noticeAt
    ? `Notice sent ${formatDay(change.noticeAt)}. `
    : "";
  return `${notice}From ${formatDay(change.appliesAt)}, team-handled cases cost ${stepsPriceWords(change.steps)}. AI-only cases cost ${formatUsd(change.aiOnlyPriceCents)} each. Cases that go pending before then keep their price.`;
}

/** A duration as minutes, hours or days, rounded. */
export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(Math.max(1, minutes), "minute", "minutes");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return plural(hours, "hour", "hours");
  return plural(Math.round(ms / 86_400_000), "day", "days");
}

/** What Templ added to one case, as short points; empty when nothing was
 * recorded. */
export function addedPoints(added: ProductCaseAdded | null): string[] {
  if (!added) return [];
  const points: string[] = [];
  if (added.walletVerified) points.push("Wallet sign-in verified");
  if (added.transactionCheck) points.push("Transaction check");
  if (added.aiAnswered) points.push("AI answer");
  if (added.aiDraftUsed) points.push("AI draft used");
  if (added.firstReplyMs !== null)
    points.push(`First reply in ${durationLabel(added.firstReplyMs)}`);
  return points;
}

/** A month of cases as labelled counts, rates and times. */
export function activityRows(
  activity: ProductMonthActivity,
): { label: string; value: string }[] {
  const share = (count: number, of: number) =>
    of > 0
      ? `${countLabel(count)} (${Math.round((count * 100) / of)}%)`
      : countLabel(count);
  const rows = [
    { label: "Opened", value: countLabel(activity.opened) },
    { label: "Answered", value: countLabel(activity.answered) },
    { label: "Resolved", value: countLabel(activity.resolved) },
    { label: "Said “No”", value: share(activity.notSolved, activity.answered) },
    { label: "Reopened", value: share(activity.reopened, activity.resolved) },
  ];
  if (activity.medianFirstReplyMs !== null)
    rows.push({
      label: "Median first reply",
      value: durationLabel(activity.medianFirstReplyMs),
    });
  if (activity.medianResolveMs !== null)
    rows.push({
      label: "Median time to resolve",
      value: durationLabel(activity.medianResolveMs),
    });
  rows.push(
    {
      label: "Wallet sign-ins verified",
      value: countLabel(activity.walletVerified),
    },
    {
      label: "Transaction checks",
      value: countLabel(activity.transactionChecks),
    },
    { label: "AI drafts used", value: countLabel(activity.aiDraftsUsed) },
    { label: "AI answers", value: countLabel(activity.aiAnswers ?? 0) },
  );
  return rows;
}
