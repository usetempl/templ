import { customerBillingManagedByTempl } from "./customer-debt-access";
import {
  usageView,
  USAGE_ACCESS_KEY,
  USAGE_TOTALS_KEY,
} from "./product-usage-billing";
/** The billing manager's view of the offer: mode, free start, grants,
 * balance, this month's resolved cases and what waits to go final. Members
 * and staff without billing get `memberProductView` of it. */
import {
  PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
  PRODUCT_FREE_START,
  PRODUCT_OFFER_VERSION,
} from "@templ/chat/plans";
import {
  productPriceSource,
  type ProductAccessView,
} from "@templ/chat/product-catalog";
import {
  priceTableCents,
  priceTableSteps,
  productBalanceLevel,
  resolutionCustomVolume,
} from "@templ/chat/resolution-pricing";
import { billingSoonCount, monthView, recentDebits } from "./product-charges";
import {
  availableCents,
  balancePaused,
  productMode,
  productOptions,
  productSupport,
  readProductState,
  scheduledPrices,
  standardPlanForState,
  type ProductStorage,
} from "./product-entitlements";

import type { TemplStaffEnv } from "./templ-staff";
import { readStripeView } from "./stripe-store";
import {
  readProductOrderForms,
  activeProductOrderForm,
  scheduledOrderFormPrices,
} from "./product-order-forms";
import {
  readProductPilotView,
  readProductPendingPilotView,
} from "./product-pilot";
import { featureOn } from "./workspace-flags";
import {
  manualPostedMonth,
  manualAgreement,
  manualTotals,
} from "./product-manual-billing";
import { standardPlanView } from "./product-standard-plan";

type ReadStorage = Pick<DurableObjectTransaction, "get" | "list">;
const iso = (at: number) => new Date(at).toISOString();

/** Days the balance lasts at the last 7 days' pace. */
export async function runwayDays(
  storage: Pick<DurableObjectTransaction, "get">,
  balanceCents: number,
  now: number,
) {
  const pace = (await recentDebits(storage, now, 7)) / 7;
  if (pace <= 0 || balanceCents <= 0)
    return { days: null, paceCentsPerDay: pace };
  return { days: Math.floor(balanceCents / pace), paceCentsPerDay: pace };
}

export async function readProductAccess(
  storage: ReadStorage,
  nowMs: number,
  env?: unknown,
): Promise<ProductAccessView> {
  const staffEnv = (env ?? {}) as TemplStaffEnv;
  const state = await readProductState(storage, nowMs, staffEnv);
  const mode = productMode(state);
  const standard = standardPlanForState(state);
  const earlierStandard = standard ? null : await standardPlanView(storage, nowMs);
  const month = await monthView(storage, nowMs);
  const available = availableCents(state);
  const change =
    (await scheduledOrderFormPrices(storage, state, staffEnv)) ??
    scheduledPrices(state);
  const forms = await readProductOrderForms(storage);
  const source = productPriceSource(state.priceVersion)!;
  const activeForm = await activeProductOrderForm(storage, nowMs);
  const form = activeForm?.usage
    ? activeForm
    : source.kind === "order-form"
      ? forms.history.find(
          (item) => item.id === source.id && item.revision === source.revision,
        )
      : null;
  const manualOn = await featureOn(staffEnv, storage, "manualBilling");
  const manual = await manualTotals(storage);
  const agreed = manualOn ? await manualAgreement(storage, state) : null;
  const usage =
    (await storage.get(USAGE_ACCESS_KEY)) ||
    (await storage.get(USAGE_TOTALS_KEY)) ||
    form?.usage
      ? await usageView(storage, nowMs, staffEnv)
      : undefined;
  return {
    ...(await readStripeView(storage, nowMs)),
    ...(customerBillingManagedByTempl(state.room) ? { billingManagedByTempl: true as const } : {}),
    ...(usage ? { usageBilling: usage } : {}),
    ...(standard && mode !== "exempt" ? { standardPlan: standard } : {}),
    ...(earlierStandard?.period && mode !== "exempt" ? { standardPlanDebtCents: earlierStandard.dueCents } : {}),
    offerVersion: PRODUCT_OFFER_VERSION,
    mode,
    support: {
      ...productSupport(mode),
      canAdmit:
        productSupport(mode).canAdmit &&
        usage?.status !== "credit-limit" &&
        (mode === "exempt" ||
          !standard ||
          standard.status === "paid" ||
          standard.ticketsUsed < standard.ticketsTotal),
    },
    billing: !manualOn && productOptions(env).billing ? "on" : "off",
    ...((manualOn && !usage) || manual.chargedCents > 0
      ? {
          manualBilling: {
            ...manual,
            month: await manualPostedMonth(storage, nowMs),
            status: manualOn
              ? agreed
                ? ("ready" as const)
                : ("setup-needed" as const)
              : ("off" as const),
          },
        }
      : {}),
    free: {
      total:
        state.freeStart.status === "reserved"
          ? PRODUCT_FREE_START.resolvedCases
          : 0,
      used: state.freeStart.used,
      pending: state.freeStart.pending,
      status: state.freeStart.status,
    },
    grants: state.grants
      .filter((grant) => grant.endsAt > state.asOf)
      .map((grant) => ({
        kind: grant.kind,
        cases: grant.cases,
        used: grant.used,
        pending: grant.pending,
        endsAt: iso(grant.endsAt),
      })),
    balance: {
      balanceCents: state.balanceCents,
      pendingCents: state.pendingCents,
      availableCents: available,
      creditBaseCents: state.creditBaseCents,
      everFunded: state.everFunded,
      level: productBalanceLevel({
        creditBaseCents: state.creditBaseCents,
        availableCents: available,
        balanceCents: state.balanceCents,
        everFunded: state.everFunded,
        paused: balancePaused(state),
        pauseWaived: state.pauseWaived,
      }),
      pauseAtCents:
        agreed || state.everFunded || state.cardCoverage || state.pauseWaived
          ? null
          : -PRODUCT_FREE_NEGATIVE_LIMIT_CENTS,
      runwayDays: (await runwayDays(storage, state.balanceCents, nowMs)).days,
    },
    month,
    steps: priceTableSteps(state.prices.table),
    aiOnlyPriceCents: state.prices.table.aiOnlyUsdCents,
    priceSource: source,
    pilot: await readProductPilotView(storage, nowMs),
    pendingPilot: await readProductPendingPilotView(storage, nowMs),
    pilotEnabled: await featureOn(staffEnv, storage, "pilotOrderForms"),
    orderForm: form
      ? {
          id: form.id,
          revision: form.revision,
          service: form.service,
          startsAt: iso(form.startsAt),
          endsAt: iso(form.endsAt),
        }
      : null,
    priceChange: change
      ? {
          appliesAt: change.appliesAt === null ? null : iso(change.appliesAt),
          ...(change.noticeAt !== undefined
            ? {
                noticeAt:
                  change.noticeAt === null ? null : iso(change.noticeAt),
                priceSource: change.priceSource,
              }
            : {}),
          steps: priceTableSteps(change.table),
          aiOnlyPriceCents: change.table.aiOnlyUsdCents,
        }
      : null,
    nextPriceCents: priceTableCents(state.prices.table, month.teamHandledCases),
    customVolume: resolutionCustomVolume(month.cases),
    suspended: state.suspended !== null,
    billingSoon: await billingSoonCount(storage),
  };
}
