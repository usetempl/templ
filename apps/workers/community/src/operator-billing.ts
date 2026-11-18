import {
  grantStandardPeriod,
  markStandardDebtPaid,
  revokeStandardPeriod,
  reviewStandardUsage,
  standardDebtPeriods,
  standardPlanView,
  standardCashCents,
  standardPlanRecords,
  standardReferenceCents,
} from "./product-standard-plan";
import { setPrepaidMode } from "./product-prepaid";
import { probePrepaidGptCount } from "./managed-agent/gpt";
import { probeAiConnection } from "./managed-agent/provider-probe";
import {
  PRODUCT_STANDARD_QUALIFICATION_PRICES,
  PRODUCT_STANDARD_PRICES,
} from "@templ/chat/plans";
import { PRODUCT_USAGE_PAYMENT_RECIPIENT } from "@templ/chat/plans";
import {
  openUsageDisputes,
  answerUsageDispute,
  approveUsageAccess,
  usagePaymentAgreement,
  usageView,
  usageRows,
  settleUsagePayment,
  USAGE_ACCESS_KEY,
  USAGE_TOTALS_KEY,
} from "./product-usage-billing";
import {
  manualPostedMonth,
  manualAgreement,
  manualTotals,
} from "./product-manual-billing";
/** `/operator/billing`: Templ operators' view of resolved-case billing
 * across workspaces, and the audited actions only an operator takes.
 *
 * The view lists each workspace that reached the offer (its first real
 * member request, a top-up request or a grant) with fixed fields: mode,
 * free start, balance, this month's cases and amount, cash collected,
 * disputes and unmatched payments waiting, the monitors, and whether the
 * negative balance passed the review guideline. No thread text, no thread
 * or case id, no member: charges are named by `ref` only.
 *
 * Actions (reason required, recorded in the workspace's audit rows with
 * the acting operator and when they signed in): suspend, unsuspend, resume
 * (lift a never-funded pause), incident credit, credit or return an
 * unmatched payment, and answer a dispute. Nothing here runs
 * automatically. */
import {
  activeProductOrderForm,
  readProductOrderForms,
} from "./product-order-forms";
import {
  readProductPilotView,
  readProductPendingPilotView,
} from "./product-pilot";
import { featureOn } from "./workspace-flags";
import { templStaffCount } from "./templ-staff";
import { PRODUCT_RESOLUTION_RULES } from "@templ/chat/plans";
import { resolutionMonth } from "@templ/chat/resolution-pricing";
import { HttpError, json, readJson, type Env } from "./common";
import { releaseSourceIdentity } from "./release-identity";
import {
  approvedManualBillingTrial,
  assertManualBillingTrialWorkspace,
  assertManualBillingTrialForm,
  assertManualBillingTrialAction,
} from "./manual-billing-trial-access";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  standardMonthlyTrialEligible,
  standardMonthlyTrialSourceSeal,
  assertStandardMonthlyTrialSource,
  assertStandardMonthlyTrialAction,
  assertStandardMonthlyTrialWorkspace,
} from "./standard-monthly-trial-access";
import { requireWalletAuth } from "./privileged-auth";
import { normalizeChatPrincipal, type AuthMethod } from "@templ/chat/principal";
import { emitBalanceAlerts } from "./product-alerts";
import {
  answerUnmatched,
  productReceipts,
  unmatchedPayments,
  prepareProductPayment,
  recordUnmatched,
  UNMATCHED_PREFIX,
  type InboundProductTransfer,
  type UnmatchedPayment,
  type ProductBillingEnv,
} from "./product-billing";
import {
  paymentLedgerCall,
  type PaymentReservation,
} from "./product-payment-ledger";
import type { ProductPaymentIntent } from "@templ/chat/product-payment";
import {
  answerDispute,
  openDisputes,
  readChargeMonth,
  recentDebits,
} from "./product-charges";
import {
  PRODUCT_STATE_KEY,
  TOP_UP_WHILE_SUSPENDED_KEY,
  GRANT_PAYMENT_PREFIX,
  noteMonthBalance,
  noteStatementRow,
  productMode,
  readProductState,
  standardPlanForState,
  recordProductEvent,
  setProductSuspension,
  refundableCents,
} from "./product-entitlements";
import { readCasesOpened } from "./support-case-data";
import {
  readStripeView,
  STRIPE_ROOM_KEY,
  type StripeRoomState,
} from "./stripe-store";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import {
  billingTrackingMeta,
  billingTrackingRegister,
  updateBillingTracking,
  BILLING_TRACKING_START,
} from "./operator-billing-tracking";

export const ROOM_OPERATOR_BILLING_PATH = "/private/product/operator";
export const BILLING_INDEX_PATH = "/private/product/billing-index";
/** The one object that lists workspaces on the offer. */
export const BILLING_INDEX_OBJECT = "product-billing-index";
const INDEX_PREFIX = "product-billing-workspace-v1:";
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE = 25;
const ROOM_TIMEOUT_MS = 10_000;
const DAY = 86_400_000;
/** The review guideline (the founder's call each time): a negative balance
 * past the larger of this or the last 30 days' charges, or negative for
 * this many days. */
const REVIEW_NEGATIVE_CENTS = 25_000;
const REVIEW_NEGATIVE_DAYS = 30;
const NEVER_RESOLVED_DAYS = 14;
const MONITOR_MIN_CASES = 20;
const REASON_MAX = 280;

type BillingEnv = OperatorAdminEnv &
  Pick<Env, "ROOMS" | "PRODUCT_PAYMENT_LEDGER"> &
  Partial<
    Pick<
      Env,
      | "APP_ORIGIN"
      | "PRODUCT_MANUAL_BILLING_ENABLED"
      | "STANDARD_MONTHLY_TRIAL_AUTHORIZATION"
      | "RELEASE_IDENTITY"
      | "AI"
      | "MANAGED_AGENT_GATEWAY_ID"
    >
  > & {
    MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
    SUPPORT_KNOWLEDGE?: DurableObjectNamespace;
  };
type Storage = DurableObjectTransaction;

/** Adds a workspace to the index, once. Idempotent. */
export async function billingIndexRequest(
  storage: Pick<Storage, "get" | "put" | "list" | "delete">,
  request: {
    method: string;
    body: Record<string, unknown>;
    query: URLSearchParams;
  },
) {
  if (request.method === "POST") {
    if (request.body.op === "tracking-update")
      return updateBillingTracking(storage, request.body);
    if (request.body.op === "orderform-id") {
      const { workspace, requestKey } = request.body;
      if (
        typeof workspace !== "string" ||
        !WORKSPACE.test(workspace) ||
        typeof requestKey !== "string" ||
        !/^[0-9a-f]{64}$/.test(requestKey)
      )
        throw new HttpError(400, "Invalid order form request.");
      const reservationKey = `product-order-form-id-v1:${workspace}:${requestKey}`;
      const reserved = await storage.get<{ id: string }>(reservationKey);
      if (reserved !== undefined) {
        if (
          !reserved ||
          typeof reserved.id !== "string" ||
          !/^OF-\d{4}-\d{3}$/.test(reserved.id) ||
          reserved.id.endsWith("-000")
        )
          throw new HttpError(503, "The order form ID could not be read.");
        return json(reserved);
      }
      const year = new Date().getUTCFullYear();
      const key = `product-order-form-sequence-v1:${year}`;
      const stored = await storage.get<unknown>(key);
      if (
        stored !== undefined &&
        (!Number.isSafeInteger(stored) ||
          (stored as number) < 0 ||
          (stored as number) > 999)
      )
        throw new HttpError(503, "The order form sequence could not be read.");
      const sequence = (stored === undefined ? 0 : (stored as number)) + 1;
      if (sequence > 999)
        throw new HttpError(503, "Order form IDs need an operator review.");
      await storage.put(key, sequence);
      const result = { id: `OF-${year}-${String(sequence).padStart(3, "0")}` };
      await storage.put(reservationKey, result);
      return json(result);
    }
    const workspace = request.body.workspace;
    if (typeof workspace !== "string" || !WORKSPACE.test(workspace))
      throw new HttpError(400, "Invalid workspace.");
    await billingTrackingRegister(storage, workspace);
    return json({ ok: true });
  }
  const after = request.query.get("after");
  if (after !== null && !WORKSPACE.test(after))
    throw new HttpError(400, "Invalid cursor.");
  const rows = await storage.list({
    prefix: INDEX_PREFIX,
    limit: PAGE,
    ...(after ? { startAfter: `${INDEX_PREFIX}${after}` } : {}),
  });
  const workspaces = [...rows.keys()].map((key) =>
    key.slice(INDEX_PREFIX.length),
  );
  return json({
    workspaces,
    next: workspaces.length === PAGE ? workspaces.at(-1) : null,
    ...(await billingTrackingMeta(storage)),
  });
}

/** Asks the index object to list `workspace`. Failure is logged, never
 * fatal: the operator view then misses the workspace until its next top-up
 * or request. */
export async function registerBillingWorkspace(
  env: Partial<Pick<Env, "ROOMS">>,
  workspace: string,
) {
  if (!env.ROOMS || !WORKSPACE.test(workspace)) return;
  try {
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(BILLING_INDEX_OBJECT),
    ).fetch(
      new Request(`https://internal${BILLING_INDEX_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace }),
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    console.error(JSON.stringify({ event: "TEMPL_PRODUCT_INDEX_FAILED" }));
  }
}

async function roomRequest(
  env: BillingEnv,
  workspace: string,
  body: Record<string, unknown>,
) {
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${workspace}`),
  ).fetch(
    new Request(`https://internal${ROOM_OPERATOR_BILLING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ROOM_TIMEOUT_MS),
    }),
  );
  const text = await response.text();
  if (!response.ok) {
    let message = "The workspace could not answer.";
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      // Keep the fixed message.
    }
    throw new HttpError(response.status, message);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function operatorBillingRoute<
  S extends ServiceSession & {
    authenticatedAt?: number;
    authMethod?: AuthMethod;
  },
>(
  request: Request,
  env: BillingEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/operator/billing/tracking") {
    const session = await auth.session();
    if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
      throw new HttpError(404, "Not found.");
    const target = env.ROOMS.get(env.ROOMS.idFromName(BILLING_INDEX_OBJECT));
    if (request.method === "GET") {
      const after = url.searchParams.get("after");
      return target.fetch(
        new Request(
          `https://internal${BILLING_INDEX_PATH}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        ),
      );
    }
    if (request.method !== "POST")
      throw new HttpError(405, "Choose a billing tracking action.");
    if (
      request.headers.get("Origin") !==
      (env.APP_ORIGIN ?? "https://usetempl.com")
    )
      throw new HttpError(403, "Use the signed-in Templ page.");
    const body = await readJson(request, 12_288);
    if (body.expectedPrincipalId !== session.principalId)
      throw new HttpError(409, "Your sign-in changed. Try again.");
    requireWalletAuth(session, body.confirmed);
    return target.fetch(
      new Request(`https://internal${BILLING_INDEX_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "tracking-update",
          operationId: body.operationId,
          expectedRevision: body.expectedRevision,
          archive: body.archive,
          restore: body.restore,
          names: body.names,
          operator: session.principalId,
          reason: body.reason,
        }),
      }),
    );
  }
  if (url.pathname === "/operator/payments") {
    const session = await auth.session();
    if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
      throw new HttpError(404, "Not found.");
    if (request.method !== "GET")
      throw new HttpError(405, "This action is not available.");
    return json(
      await paymentLedgerCall(env, "payments", {
        after: url.searchParams.get("after") ?? "",
      }),
    );
  }
  const match = /^\/operator\/billing(?:\/([0-9a-f-]{36}))?$/.exec(
    url.pathname,
  );
  if (!match) return null;
  const session = await auth.session();
  const manualTrial = approvedManualBillingTrial(
    env,
    session.principalId,
    match[1],
  );
  const monthlyTrial =
    request.method === "POST" &&
    standardMonthlyTrialEligible(env, session.principalId, match[1]);
  if (
    !isOperatorAdmin(env, session.principalId, sessionPrincipals(session)) &&
    !manualTrial &&
    !monthlyTrial
  )
    throw new HttpError(404, "Not found.");
  if (
    !match[1] &&
    request.method === "GET" &&
    url.searchParams.get("input-token-probe") === "1"
  ) {
    if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
      throw new HttpError(404, "Not found.");
    if (
      !env.AI ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? "")
    )
      throw new HttpError(503, "AI token counting is unavailable.");
    return json(
      await probePrepaidGptCount(env.AI, env.MANAGED_AGENT_GATEWAY_ID!),
    );
  }
  const posted =
    request.method === "POST"
      ? ((await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null)
      : null;
  if (
    !match[1] &&
    request.method === "POST" &&
    posted?.action === "ai-provider-probe"
  ) {
    if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
      throw new HttpError(404, "Not found.");
    if (
      request.headers.get("Origin") !==
      (env.APP_ORIGIN ?? "https://usetempl.com")
    )
      throw new HttpError(403, "Use the signed-in Templ page.");
    if (posted.expectedPrincipalId !== session.principalId)
      throw new HttpError(409, "Your sign-in changed. Try again.");
    if (
      Object.keys(posted).some(
        (key) => !["action", "expectedPrincipalId", "confirmed"].includes(key),
      )
    )
      throw new HttpError(400, "This check uses a fixed test request.");
    requireWalletAuth(session, posted.confirmed);
    return json(await probeAiConnection(env));
  }
  const workspace =
    match[1] ??
    (posted?.action === "payment-request" &&
    typeof posted.workspace === "string"
      ? posted.workspace
      : undefined);
  if (workspace && !WORKSPACE.test(workspace))
    throw new HttpError(404, "Not found.");
  if (!workspace && request.method === "GET") {
    const after = url.searchParams.get("after");
    const index = await env.ROOMS.get(
      env.ROOMS.idFromName(BILLING_INDEX_OBJECT),
    ).fetch(
      new Request(
        `https://internal${BILLING_INDEX_PATH}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      ),
    );
    if (!index.ok)
      throw new HttpError(503, "The workspace list could not be read.");
    const page = (await index.json()) as {
      workspaces: string[];
      next: string | null;
      names?: Record<string, string>;
    };
    const rows = [];
    for (const id of page.workspaces) {
      try {
        rows.push({
          workspace: id,
          name: page.names?.[id],
          ...(await roomRequest(env, id, { op: "summary" })),
        });
      } catch {
        rows.push({ workspace: id, unavailable: true });
      }
    }
    return json({
      workspaces: rows,
      next: page.next,
      inputTokenProbeAvailable: isOperatorAdmin(
        env,
        session.principalId,
        sessionPrincipals(session),
      ),
    });
  }
  if (workspace && request.method === "GET") {
    if (manualTrial) requireWalletAuth(session, true);
    return json(
      await roomRequest(env, workspace, {
        op: "detail",
        manualTrialPrincipal: manualTrial ? session.principalId : null,
      }),
    );
  }
  if (workspace && request.method === "POST") {
    const body = posted;
    if (!body) throw new HttpError(400, "Send a JSON action.");
    if (body.expectedPrincipalId !== session.principalId)
      throw new HttpError(401, "Your sign-in changed. Try again.");
    if (manualTrial) assertManualBillingTrialAction(body, workspace);
    if (monthlyTrial) assertStandardMonthlyTrialAction(body);
    const reason = body.reason;
    if (
      typeof reason !== "string" ||
      reason.trim().length < 3 ||
      reason.length > REASON_MAX
    )
      throw new HttpError(400, "Write the reason for this action.");
    try {
      requireWalletAuth(session, body.confirmed);
    } catch (error) {
      if (
        body.action === "payment-request" &&
        error instanceof HttpError &&
        error.reason === "strong-auth-required"
      )
        throw new HttpError(
          401,
          "Sign in with your wallet again.",
          undefined,
          error.reason,
        );
      throw error;
    }
    if (monthlyTrial) {
      const admission = await roomRequest(env, workspace, {
        op: "standard-monthly-trial-admission",
        standardMonthlyTrialPrincipal: session.principalId,
        standardMonthlyTrialSource: standardMonthlyTrialSourceSeal(env),
        operator: session.principalId,
        authenticatedAt: session.authenticatedAt ?? null,
        authMethod: session.authMethod,
        confirmed: true,
      });
      if (
        JSON.stringify(admission) !==
        JSON.stringify(standardMonthlyTrialSourceSeal(env))
      )
        throw new HttpError(404, "Not found.");
    }
    const result = await roomRequest(env, workspace, {
      ...body,
      op: "action",
      manualTrialPrincipal: manualTrial ? session.principalId : null,
      standardMonthlyTrialPrincipal: monthlyTrial ? session.principalId : null,
      standardMonthlyTrialSource: monthlyTrial
        ? standardMonthlyTrialSourceSeal(env)
        : null,
      operator: session.principalId,
      authenticatedAt: session.authenticatedAt ?? null,
      authMethod: session.authMethod,
    });
    console.log(
      JSON.stringify({
        event: "TEMPL_PRODUCT_OPERATOR_ACTION",
        action: body.action,
        operator: session.principalId,
      }),
    );
    return json(result);
  }
  throw new HttpError(405, "This action is not available.");
}

/** The room side, inside one storage transaction. */
export async function roomOperatorBillingRequest(
  storage: Storage,
  body: Record<string, unknown>,
  now: number,
  payment?: {
    env: ProductBillingEnv;
    room: string;
    payerManager: (
      network: number | "solana",
      payer: string,
    ) => Promise<import("@templ/chat/principal").ChatPrincipalId | null>;
    reservationCreated?: (
      reservation: PaymentReservation,
      replaced: PaymentReservation | null,
    ) => void;
    deferRegistration?: (
      intent: ProductPaymentIntent,
      principalId: import("@templ/chat/principal").ChatPrincipalId,
      replaced: PaymentReservation | null,
    ) => void;
  },
): Promise<Response> {
  if (body.manualTrialPrincipal) {
    if (!payment) throw new HttpError(404, "Not found.");
    await assertManualBillingTrialWorkspace(
      storage,
      payment.env,
      body.manualTrialPrincipal,
      now,
    );
    const form = await activeProductOrderForm(storage, now);
    if (!form) throw new HttpError(404, "Not found.");
    assertManualBillingTrialForm(form);
    if (body.op === "action")
      assertManualBillingTrialAction(
        body,
        form.workspace.replace(/^room:/, ""),
      );
  }
  if (body.standardMonthlyTrialPrincipal) {
    if (
      !payment ||
      !["action", "standard-monthly-trial-admission"].includes(String(body.op))
    )
      throw new HttpError(404, "Not found.");
    assertStandardMonthlyTrialSource(
      payment.env,
      body.standardMonthlyTrialSource,
    );
    await assertStandardMonthlyTrialWorkspace(
      storage,
      payment.env,
      body.standardMonthlyTrialPrincipal,
      payment.room.replace(/^room:/, ""),
      now,
    );
    if (body.operator !== body.standardMonthlyTrialPrincipal)
      throw new HttpError(404, "Not found.");
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    if (body.op === "standard-monthly-trial-admission")
      return json(standardMonthlyTrialSourceSeal(payment.env));
    assertStandardMonthlyTrialAction(
      Object.fromEntries(
        Object.entries(body).filter(
          ([key]) =>
            ![
              "op",
              "operator",
              "authenticatedAt",
              "authMethod",
              "manualTrialPrincipal",
              "standardMonthlyTrialPrincipal",
              "standardMonthlyTrialSource",
            ].includes(key),
        ),
      ),
    );
  }
  if (!(await storage.get(PRODUCT_STATE_KEY)))
    throw new HttpError(404, "This workspace has no plan.");
  if (body.op === "summary")
    return json(await summary(storage, now, payment?.env));
  if (body.op === "detail")
    return json({
      nativeSource: releaseSourceIdentity(payment?.env ?? {}),
      ...(await summary(storage, now, payment?.env)),
      disputes: [
        ...(await openDisputes(storage)),
        ...(await openUsageDisputes(storage)),
      ],
      unmatched: await unmatchedPayments(storage),
      usageRows: await usageRows(storage),
      standardDebtPeriods: await standardDebtPeriods(storage),
      standardRecords: await standardPlanRecords(storage),
    });
  if (body.op !== "action") throw new HttpError(400, "Unknown request.");
  const operator = normalizeChatPrincipal(body.operator);
  if (!operator) throw new HttpError(401, "Sign in as a Templ operator.");
  const signedInAt = Number.isSafeInteger(body.authenticatedAt)
    ? { authenticatedAt: body.authenticatedAt as number }
    : {};
  const reason = String(body.reason).trim().slice(0, REASON_MAX);
  const action = body.action;
  const audit = (detail: { cents?: number } = {}) =>
    recordProductEvent(storage, `operator:${String(action)}:${now}`, {
      action: `operator.${String(action)}`,
      at: now,
      reason,
      operator,
      ...signedInAt,
      ...detail,
    });
  if (action === "standard-payment-mode") {
    if (body.manualTrialPrincipal || !payment)
      throw new HttpError(404, "Not found.");
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    await setPrepaidMode(storage, {
      mode: body.mode as "prepaid" | "debt" | "custom",
      expectedRevision: body.expectedRevision as number,
      operator,
      reason,
      at: now,
    });
    await audit();
    return json({ standardPlan: await standardPlanView(storage, now) });
  }
  if (action === "tracking-reset") {
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    if (reason.length < 3 || !payment)
      throw new HttpError(400, "Write the reason for this tracking reset.");
    const previous = await storage.get<{ at: number }>(BILLING_TRACKING_START);
    if (previous) return json({ trackingStartedAt: previous.at });
    const current = await summary(storage, now, payment.env);
    const amounts = [
      current.balanceCents,
      current.pendingCents,
      current.month.cents,
      current.month.cases,
      current.cashCents,
      current.standardPlan?.chargedCents ?? 0,
      current.standardPlan?.paidCents ?? 0,
      current.usageBilling?.dueCents ?? 0,
      current.manualBilling?.chargedCents ?? 0,
      current.manualBilling?.pendingCents ?? 0,
      current.manualBilling?.creditedCents ?? 0,
    ];
    if (
      amounts.some((value) => value !== 0) ||
      (await productReceipts(storage)).length ||
      current.cardOutreach ||
      current.unmatched ||
      current.disputes
    )
      throw new HttpError(
        409,
        "Keep this workspace's recorded financial activity. Review its ledger before resetting tracking.",
      );
    await storage.put(BILLING_TRACKING_START, { at: now, operator, reason });
    await audit();
    return json({ trackingStartedAt: now });
  }
  if (
    action === "standard-access" ||
    action === "standard-debt-paid" ||
    action === "standard-usage-review" ||
    action === "standard-access-revoke"
  ) {
    if (body.manualTrialPrincipal || !payment)
      throw new HttpError(404, "Not found.");
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    if (reason.length < 3)
      throw new HttpError(400, "Write the reason for this action.");
    if (
      !body.standardMonthlyTrialPrincipal &&
      !(await featureOn(payment.env, storage, "manualBilling"))
    )
      throw new HttpError(503, "Manual billing is unavailable.");
    let view;
    if (action === "standard-access") {
      if (await activeProductOrderForm(storage, now))
        throw new HttpError(
          409,
          "Keep this workspace's active signed agreement.",
        );
      const current = await readProductState(storage, now, payment.env);
      if (productMode(current) === "exempt")
        throw new HttpError(
          409,
          "This workspace already has full access under Templ's grant.",
        );
      if (
        current.cardCoverage ||
        current.creditedPayments.some(
          (id) => !id.startsWith(GRANT_PAYMENT_PREFIX),
        )
      )
        throw new HttpError(409, "Keep this workspace's funded legacy plan.");
      const approvedBy =
        body.source === "founder-approved"
          ? normalizeChatPrincipal(body.approvedBy)
          : null;
      if (
        body.source === "founder-approved" &&
        (!approvedBy ||
          !String(payment.env.FOUNDER_PRINCIPALS ?? "")
            .split(",")
            .map((value) => normalizeChatPrincipal(value.trim()))
            .includes(approvedBy))
      )
        throw new HttpError(400, "Name the founder who approved this access.");
      view = await grantStandardPeriod(
        storage,
        {
          source: body.source as "manual-payment" | "founder-approved",
          referenceSha256: String(body.referenceSha256),
          approvedBy,
          expectedPeriod: body.expectedPeriod as string | null,
          operator,
          reason,
          now,
        },
        body.standardMonthlyTrialPrincipal
          ? PRODUCT_STANDARD_QUALIFICATION_PRICES
          : PRODUCT_STANDARD_PRICES,
      );
    } else if (action === "standard-access-revoke")
      view = await revokeStandardPeriod(storage, body.period, now);
    else if (action === "standard-usage-review")
      view = await reviewStandardUsage(storage, {
        period: body.period as string,
        referenceSha256: body.referenceSha256 as string,
        expectedReviewedThrough: body.expectedReviewedThrough as number | null,
        reviewedThrough: body.reviewedThrough as number,
        answeredCases: body.answeredCases as number,
        providerAiUsageUsdNanos: body.providerAiUsageUsdNanos as string,
        aiUsageMissing: body.aiUsageMissing as number,
        operator,
        reason,
        now,
      });
    else
      view = await markStandardDebtPaid(storage, {
        period: String(body.period),
        cents: Number(body.cents),
        referenceSha256: String(body.referenceSha256),
        operator,
        reason,
        now,
      });
    if (
      action === "standard-debt-paid" ||
      (action === "standard-access" && body.source === "manual-payment")
    )
      await paymentLedgerCall(payment.env, "claim-external", {
        workspace: payment.room,
        scope: "standard",
        referenceSha256: body.referenceSha256,
        cents: await standardReferenceCents(storage, body.referenceSha256),
      });
    await audit(
      action === "standard-debt-paid" ? { cents: Number(body.cents) } : {},
    );
    return json({ standardPlan: view });
  }
  if (
    ["usage-approve", "usage-payment", "usage-forgive"].includes(String(action))
  ) {
    if (
      typeof body.reason !== "string" ||
      body.reason.trim().length < 3 ||
      body.reason.length > REASON_MAX
    )
      throw new HttpError(400, "Write a short reason for this change.");
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
    if (!payment || !(await featureOn(payment.env, storage, "manualBilling")))
      throw new HttpError(503, "Usage billing is unavailable.");
    if (action === "usage-approve") {
      const approvedBy = normalizeChatPrincipal(body.approvedBy);
      const form = await activeProductOrderForm(storage, now);
      if (
        !approvedBy ||
        !form?.usage ||
        approvedBy !== form.approvedBy ||
        !String(payment.env.FOUNDER_PRINCIPALS ?? "")
          .split(",")
          .map((value) => normalizeChatPrincipal(value.trim()))
          .includes(approvedBy)
      )
        throw new HttpError(400, "A listed founder must approve access.");
      if (typeof body.enabled !== "boolean")
        throw new HttpError(400, "Choose approve or revoke.");
      await approveUsageAccess(storage, {
        formId: String(body.formId),
        revision: Number(body.revision),
        enabled: body.enabled,
        operator,
        approvedBy,
        authenticatedAt: body.authenticatedAt as number,
        reason,
        now,
      });
      await audit();
      return json({ usageBilling: await usageView(storage, now, payment.env) });
    }
    if (
      !Number.isSafeInteger(body.cents) ||
      (body.cents as number) <= 0 ||
      (body.cents as number) > 100_000
    )
      throw new HttpError(400, "Enter an amount from $0.01 to $1,000.");
    if (action === "usage-payment") {
      if (!(await usagePaymentAgreement(storage, now, payment.env)))
        throw new HttpError(409, "This workspace has no recorded usage debt.");
      if (
        typeof body.referenceSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.referenceSha256)
      )
        throw new HttpError(
          400,
          "Record the received payment's document hash.",
        );
      await paymentLedgerCall(payment.env, "claim-external", {
        workspace: payment.room,
        referenceSha256: body.referenceSha256,
        cents: body.cents,
      });
    } else if (
      typeof body.referenceSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.referenceSha256)
    )
      throw new HttpError(400, "Record a unique credit reference.");
    const result = await settleUsagePayment(storage, {
      id: `${action}:${body.referenceSha256}`,
      referenceSha256: String(body.referenceSha256),
      cents: body.cents as number,
      at: now,
      operator,
      reason,
      forgiveness: action === "usage-forgive",
    });
    if (result.posted) await audit({ cents: body.cents as number });
    return json({ usageBilling: await usageView(storage, now, payment.env) });
  }
  if (action === "payment-request") {
    if (!payment) throw new HttpError(503, "Payments are unavailable.");
    const orderFormId = body.orderFormId;
    if (
      typeof orderFormId !== "string" ||
      !/^OF-\d{4}-\d{3}$/.test(orderFormId)
    )
      throw new HttpError(400, "Choose an active order form.");
    const forms = await readProductOrderForms(storage);
    const signedPilot = [...forms.history]
      .reverse()
      .find((form) => form.id === orderFormId && form.pilot);
    const orderForm =
      signedPilot ?? (await activeProductOrderForm(storage, now));
    if (
      !orderForm ||
      orderForm.id !== orderFormId ||
      orderForm.endsAt <= now ||
      forms.ended[orderFormId] !== undefined
    )
      throw new HttpError(400, "Choose an active order form.");
    if (orderForm.pilot && body.orderFormRevision !== orderForm.revision)
      throw new HttpError(409, "Read the current pilot form and try again.");
    const result = await prepareProductPayment(storage, {
      env: payment.env,
      room: payment.room,
      principalId: operator,
      nowMs: now,
      body,
      walletOwner: payment.payerManager,
      orderForm: {
        orderFormId,
        ...(orderForm.pilot ? { orderFormRevision: orderForm.revision } : {}),
        expiresAt: body.expiresAt,
      },
      reservationCreated: payment.reservationCreated,
      deferRegistration: payment.deferRegistration,
    });
    await audit({ cents: body.usdCents as number });
    return json(result);
  }
  if (action === "suspend" || action === "unsuspend" || action === "resume") {
    const state = await setProductSuspension(storage, {
      action,
      nowMs: now,
      env: payment?.env,
    });
    if (action === "unsuspend")
      await storage.delete(TOP_UP_WHILE_SUSPENDED_KEY);
    await audit();
    if (action === "suspend")
      await emitBalanceAlerts(
        storage,
        state,
        now,
        { suspended: true },
        payment?.env,
      );
    return json({ mode: productMode(state) });
  }
  if (action === "incident-credit") {
    const cents = body.cents;
    if (
      !Number.isSafeInteger(cents) ||
      (cents as number) < 1 ||
      (cents as number) > 1_000_000
    )
      throw new HttpError(400, "Enter the credit in cents.");
    const state = await readProductState(storage, now, payment?.env);
    state.balanceCents += cents as number;
    if (state.balanceCents >= 0) state.pausedAt = null;
    await storage.put(PRODUCT_STATE_KEY, state);
    await noteMonthBalance(storage, state);
    await noteStatementRow(storage, state, `incident:${now}`, {
      kind: "incident",
      at: now,
      cents: cents as number,
    });
    await audit({ cents: cents as number });
    return json({ balanceCents: state.balanceCents });
  }
  if (action === "unmatched") {
    if (typeof body.paymentId !== "string")
      throw new HttpError(400, "Choose the payment.");
    if (body.answer !== "credit" && body.answer !== "return")
      throw new HttpError(400, "Choose credit or return.");
    if (
      payment &&
      !(await storage.get(`${UNMATCHED_PREFIX}${body.paymentId}`))
    ) {
      const global = await paymentLedgerCall(payment.env, "unmatched-get", {
        paymentId: body.paymentId,
      });
      const inbound = global.row as InboundProductTransfer | null;
      const usageAgreement = await usagePaymentAgreement(
        storage,
        now,
        payment.env,
      );
      if (
        inbound &&
        usageAgreement &&
        (![1, 8453].includes(Number(inbound.network)) ||
          inbound.recipient.toLowerCase() !==
            PRODUCT_USAGE_PAYMENT_RECIPIENT.toLowerCase())
      )
        throw new HttpError(409, "This transfer does not settle usage debt.");
      if (inbound?.status === "open")
        await recordUnmatched(storage, {
          ...(usageAgreement ? { settlement: "manual-usage" as const } : {}),
          paymentId: inbound.paymentId,
          chainId: inbound.network,
          txHash: inbound.txHash,
          usdCents: inbound.usdCents ?? 0,
          creditEligible: inbound.creditEligible,
          reason: inbound.reason,
          at: inbound.paidAt,
          status: "open",
        });
    }
    if (body.answer === "credit") {
      if (!payment) throw new HttpError(503, "Payments are unavailable.");
      const verified = await storage.get<UnmatchedPayment>(
        `${UNMATCHED_PREFIX}${body.paymentId}`,
      );
      if (!verified || verified.status !== "open")
        throw new HttpError(404, "No open unmatched payment with that ID.");
      if (
        verified.creditEligible !== true ||
        body.usdCents !== verified.usdCents
      )
        throw new HttpError(400, "Credit only the verified amount received.");
      await paymentLedgerCall(payment.env, "claim", {
        paymentId: body.paymentId,
        workspace: payment.room,
      });
    }
    const row = await answerUnmatched(storage, {
      paymentId: body.paymentId,
      action: body.answer === "credit" ? "credit" : "return",
      ...(Number.isSafeInteger(body.usdCents)
        ? { usdCents: body.usdCents as number }
        : {}),
      nowMs: now,
      operator,
      env: payment?.env,
    });
    await audit(
      body.answer === "credit" ? { cents: body.usdCents as number } : {},
    );
    return json({ unmatched: row });
  }
  if (action === "dispute") {
    if (typeof body.ref !== "string" || typeof body.accept !== "boolean")
      throw new HttpError(400, "Choose the charge and the answer.");
    const usage = await answerUsageDispute(storage, {
      ref: body.ref,
      accept: body.accept,
      nowMs: now,
      operator,
    });
    if (usage) {
      await audit();
      return json({ ref: usage.ref, status: usage.dispute.status });
    }
    const charge = await answerDispute(storage, {
      ref: body.ref,
      accept: body.accept,
      nowMs: now,
      operator,
      env: payment?.env,
    });
    await audit();
    return json({ ref: charge.ref, status: charge.dispute?.status });
  }
  throw new HttpError(400, "Unknown action.");
}

async function summary(
  storage: Storage,
  now: number,
  env: ProductBillingEnv = {},
) {
  const trackingStartedAt =
    (await storage.get<{ at: number }>(BILLING_TRACKING_START))?.at ?? null;
  const state = await readProductState(storage, now, env);
  const month = resolutionMonth(now);
  const totals = await readChargeMonth(storage, month);
  const receipts = await productReceipts(storage);
  const monthStart = Date.UTC(
    Number(month.slice(0, 4)),
    Number(month.slice(4, 6)) - 1,
    1,
  );
  const nextMonth = Date.UTC(
    Number(month.slice(0, 4)),
    Number(month.slice(4, 6)),
    1,
  );
  const standardPaymentsCents = await standardCashCents(
    storage,
    monthStart,
    nextMonth,
  );
  const cashCents =
    standardPaymentsCents +
    receipts
      .filter(
        (receipt) => resolutionMonth(Date.parse(receipt.creditedAt)) === month,
      )
      .reduce((sum, receipt) => sum + receipt.usdCents, 0);
  const railTotals: Record<string, number> = {};
  for (const receipt of receipts) {
    if (resolutionMonth(Date.parse(receipt.creditedAt)) !== month) continue;
    railTotals[receipt.rail] =
      (railTotals[receipt.rail] ?? 0) + receipt.usdCents;
  }
  const last30 = await recentDebits(storage, now, 30);
  const negativeSince = await storage.get<{ since: number }>(
    "product-alert-negative-v1",
  );
  const review =
    state.balanceCents < 0 &&
    (-state.balanceCents > Math.max(REVIEW_NEGATIVE_CENTS, last30) ||
      (negativeSince !== undefined &&
        now - negativeSince.since >= REVIEW_NEGATIVE_DAYS * DAY));
  const card = await readStripeView(storage, now);
  const cardState = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
  const cardOutreach =
    card.cardBilling.status === "past-due" ||
    Boolean(cardState?.unpaidInvoiceIds?.length);
  const orderForm = await activeProductOrderForm(storage, now);
  const manualOn = await featureOn(env, storage, "manualBilling");
  const manual = await manualTotals(storage);
  const agreement = manualOn ? await manualAgreement(storage, state) : null;
  const standard =
    standardPlanForState(state) ?? (await standardPlanView(storage, now));
  const canRecordStandard =
    productMode(state) !== "exempt" &&
    !state.cardCoverage &&
    state.creditedPayments.every((id) => id.startsWith(GRANT_PAYMENT_PREFIX)) &&
    !(await activeProductOrderForm(storage, now));
  return {
    ...card,
    trackingStartedAt,
    ...((await storage.get(USAGE_ACCESS_KEY)) ||
    (await storage.get(USAGE_TOTALS_KEY)) ||
    orderForm?.usage
      ? { usageBilling: await usageView(storage, now, env) }
      : {}),
    ...((manualOn && !orderForm?.usage) || manual.chargedCents > 0
      ? {
          manualBilling: {
            ...manual,
            month: await manualPostedMonth(storage, now),
            status: manualOn ? (agreement ? "ready" : "setup-needed") : "off",
          },
        }
      : {}),
    pilot: await readProductPilotView(storage, now),
    pendingPilot: await readProductPendingPilotView(storage, now),
    pilotEnabled: await featureOn(env, storage, "pilotOrderForms"),
    orderForm: orderForm
      ? {
          id: orderForm.id,
          revision: orderForm.revision,
          service: orderForm.service,
          startsAt: new Date(orderForm.startsAt).toISOString(),
          endsAt: new Date(orderForm.endsAt).toISOString(),
        }
      : null,
    templStaffCount: await templStaffCount(storage),
    cardOutreach,
    ...(standardPlanForState(state) || standard.period || canRecordStandard
      ? { standardPlan: standard }
      : {}),
    mode: productMode(state),
    freeStart: state.freeStart.status,
    everFunded: state.everFunded,
    balanceCents: state.balanceCents,
    pendingCents: state.pendingCents,
    suspended: state.suspended !== null,
    month: { id: month, cases: totals.cases, cents: totals.cents },
    cashCents,
    standardPaymentsCents,
    railTotals,
    disputes:
      (await openDisputes(storage)).length +
      (await openUsageDisputes(storage)).length,
    unmatched: (await unmatchedPayments(storage)).filter(
      (row) => row.status === "open",
    ).length,
    monitors: {
      ...(await monitors(storage, now, trackingStartedAt ?? 0)),
      spamOnConfirmed: totals.spamOnConfirmed,
      teamReopenedBeforeFinal: totals.teamReopened,
    },
    reviewSuggested: review || cardOutreach,
    /** A verified top-up credited while the workspace was suspended, since
     * the last lift. */
    topUpWhileSuspended:
      (await storage.get<{ at: number }>(TOP_UP_WHILE_SUSPENDED_KEY))?.at ??
      null,
    /** What a closure refund would pay: the paid part of top-ups under
     * 12 months old, less charges waiting to go final. */
    refundableCents: await refundableCents(storage, state),
  };
}

/** Case and charge metadata only: the spam share of answered cases in 30
 * days (with a floor of cases), spam marks on member-confirmed charges, and
 * answered cases nobody resolved and the member left for 14 days. */
async function monitors(storage: Storage, now: number, since = 0) {
  const cases = (
    await readCasesOpened(storage, {
      from: Math.max(now - 30 * DAY, since),
      to: now,
      limit: 1_000,
    })
  ).map((read) => read.case);
  let answered = 0;
  let spam = 0;
  let neverResolved = 0;
  for (const c of cases) {
    const replies = c.counts.humanReplies + c.counts.botReplies;
    if (replies === 0) continue;
    answered++;
    if (c.excluded.includes("spam")) spam++;
    else if (
      c.firstResolvedAt === null &&
      c.lastMemberAt < now - NEVER_RESOLVED_DAYS * DAY
    )
      neverResolved++;
  }
  const share = (count: number) =>
    answered ? Math.round((count * 100) / answered) : 0;
  return {
    answered,
    spamPercent: share(spam),
    spamFlag:
      answered >= MONITOR_MIN_CASES &&
      share(spam) > PRODUCT_RESOLUTION_RULES.spamReviewPercent,
    neverResolvedPercent: share(neverResolved),
  };
}
