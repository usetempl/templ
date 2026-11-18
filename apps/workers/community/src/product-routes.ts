import { customerBillingManagedByTempl } from "./customer-debt-access";
import { standardPlanRecords, standardPlanView } from "./product-standard-plan";
import {
  releaseIdentity,
  nativeReleaseSourceHeaders,
} from "./release-identity";
import { usageRows, disputeUsageCharge } from "./product-usage-billing";
import { workspaceFeatures } from "./workspace-flags";
import type { ChatViewer } from "@templ/chat/index";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  productPriceSource,
  PRODUCT_CHARGE_STATES,
  memberProductView,
  type ProductChargeState,
  type ProductPriceSource,
} from "@templ/chat/product-catalog";
import { PRODUCT_TOP_UP } from "@templ/chat/plans";
import { identityRequest } from "./account-identity";
import { HttpError, json, type Env } from "./common";
import { requirePrivilegedHeaders } from "./privileged-auth";
import { BUDGET_KEY } from "./product-alerts";
import { disputeCharge, listCharges } from "./product-charges";
import {
  readProductState,
  standardPlanForState,
  type ProductStorage,
} from "./product-entitlements";
import {
  prepareProductPayment,
  settleProductPayment,
  productReceipts,
  productPaymentRequests,
  productPaymentRequest,
  refreshProductPaymentTransaction,
  requireProductPaymentRail,
  updateProductPaymentEvent,
  type ProductBillingEnv,
  type ProductPaymentScannerDeferral,
} from "./product-billing";
import { productStatement, statementCsv } from "./product-statement";
import { monthActivity } from "./product-case-facts";
import {
  financeEmailView,
  setFinanceEmail,
  verifyFinanceEmail,
  type FinanceEmailEnv,
} from "./product-finance-email";
import { readProductAccess } from "./product-view";
import { managerStripeAction } from "./stripe-store";
import type { ResolutionPriceTable } from "@templ/chat/resolution-pricing";
import { corpusRowFor, type CorpusEnv } from "./support-corpus";
import type { ProductPaymentIntent } from "@templ/chat/product-payment";
import type { PaymentReservation } from "./product-payment-ledger";

type RouteStorage = ProductStorage &
  Pick<
    DurableObjectTransaction,
    "get" | "list" | "delete" | "getAlarm" | "setAlarm"
  >;
const PATH =
  /^\/product(?:\/(standard|usage|runtime|receipts|budget|statement|activity|card\/(?:setup|portal|method)|finance-email(?:\/verify)?|charges(?:\/([0-9a-f]{16})\/dispute)?|crypto\/(?:prepare|receipt|requests|check|transaction)))?$/;
const MONTH = /^\d{6}$/;

/** `/product*` in a workspace's room: the plan view for everyone who
 * belongs, and billing (charges, disputes, top-ups, receipts, the budget
 * and statements) for the manager and billing managers only. Billing grants
 * no ticket access: a charge names its thread only for a viewer who can
 * read the inbox now. */
export async function productRoute(
  storage: RouteStorage,
  input: {
    pathname: string;
    method: string;
    body: Record<string, unknown>;
    query?: URLSearchParams;
    viewer: ChatViewer;
    nowMs: number;
    room: string;
    headers: Headers;
    env: ProductBillingEnv;
    deferScanner?: ProductPaymentScannerDeferral["deferScanner"];
    scannerResult?: ProductPaymentScannerDeferral["scannerResult"];
    /** The room runs this authorized billing step after its transaction commits. */
    deferStripeAction?: (input: {
      action: string;
      room: string;
      nowMs: number;
      body: Record<string, unknown>;
      creator: string;
      priceTable: ResolutionPriceTable;
      priceSource: ProductPriceSource;
    }) => void;
    walletOwner?: (
      network: number | "solana",
      address: string,
    ) => Promise<ChatPrincipalId | null>;
    reservationCreated?: (
      reservation: PaymentReservation,
      replaced: PaymentReservation | null,
    ) => void;
    deferRegistration?: (
      intent: ProductPaymentIntent,
      principalId: ChatPrincipalId,
      replaced: PaymentReservation | null,
    ) => void;
  },
) {
  const match = PATH.exec(input.pathname);
  if (!match) return null;
  // A widget session never reaches the plan, checkout or receipts: its
  // wallet is a support claim, not a payer (the worker refuses it first).
  if (input.headers.get("X-Support-Widget") !== null)
    throw new HttpError(404, "Not found.");
  if (!input.viewer.principalId)
    throw new HttpError(401, "Sign in to view this workspace's plan.");
  const permissions = input.viewer.permissions.map(String);
  const canManage =
    input.viewer.isManager || permissions.includes("manageBilling");
  const canReadInbox =
    input.viewer.isManager || permissions.includes("handleConversations");
  const query = input.query ?? new URLSearchParams();
  if (input.pathname === "/product" && input.method === "GET") {
    const view = await readProductAccess(storage, input.nowMs, input.env);
    // Members and staff without billing get whether Support is open, never
    // an amount or a count.
    return json(
      canManage && !view.billingManagedByTempl
        ? {
            ...view,
            canManage,
            features: await workspaceFeatures(input.env, storage),
          }
        : { ...memberProductView(view), canManage: false },
      200,
      canManage ? nativeReleaseSourceHeaders(input.env) : {},
    );
  }
  if (!canManage)
    throw new HttpError(403, "Billing access is required to manage this plan.");
  const section = match[1];
  if (customerBillingManagedByTempl(input.room) && [
    "standard", "usage", "receipts", "charges", "budget", "statement",
    "finance-email", "crypto/requests", "crypto/prepare", "card/checkout",
  ].includes(section ?? ""))
    throw new HttpError(403, "Billing is handled by Templ.");
  if (
    input.method === "POST" &&
    (section?.startsWith("card/") ||
      section === "crypto/prepare" ||
      section === "crypto/receipt") &&
    standardPlanForState(
      await readProductState(storage, input.nowMs, input.env),
    )
  ) {
    if (section?.startsWith("card/"))
      throw new HttpError(409, "Card payments are unavailable for this plan.");
    if (section === "crypto/prepare") {
      if (
        !["standard-period", "standard-credit"].includes(
          String(input.body.purpose),
        )
      )
        throw new HttpError(409, "Choose a monthly payment or prepaid credit.");
      requirePrivilegedHeaders(
        input.headers,
        input.body.confirmed,
        input.nowMs,
      );
    } else {
      const intent = await productPaymentRequest(
        storage,
        String(input.body.requestId),
      );
      if (!intent || intent.settlement !== "standard-prepaid")
        throw new HttpError(
          409,
          "This plan accepts only its prepaid payment requests.",
        );
    }
  }
  if (section === "runtime" && input.method === "GET") {
    if (!input.viewer.isManager)
      throw new HttpError(403, "Workspace manager access is required.");
    return releaseIdentity(input.env as Env);
  }
  if (section?.startsWith("card/") && input.method === "POST") {
    requirePrivilegedHeaders(input.headers, input.body.confirmed, input.nowMs);
    if (input.deferStripeAction) {
      const product = await readProductState(storage, input.nowMs, input.env);
      input.deferStripeAction({
        action: section.slice(5),
        room: input.room,
        nowMs: input.nowMs,
        body: input.body,
        creator: product.creator,
        priceTable: product.prices.table,
        priceSource: productPriceSource(product.priceVersion)!,
      });
      return json({});
    }
    return managerStripeAction(storage as never, input.env as never, {
      action: section.slice(5),
      room: input.room,
      nowMs: input.nowMs,
      body: input.body,
    });
  }
  if (section === "standard" && input.method === "GET")
    return json(
      {
        schemaVersion: 1,
        plan: await standardPlanView(storage, input.nowMs),
        ...(await standardPlanRecords(storage)),
      },
      200,
      nativeReleaseSourceHeaders(input.env),
    );
  if (section === "usage" && input.method === "GET")
    return json(
      await usageRows(storage, {
        after: query.get("after") ?? undefined,
        month: query.get("month") ?? undefined,
      }),
    );
  if (section === "receipts" && input.method === "GET")
    return json({ receipts: await productReceipts(storage) });
  if (section === "charges" && input.method === "GET") {
    const state = query.get("state");
    const cursor = query.get("cursor");
    if (
      state !== null &&
      state !== "billing-soon" &&
      !PRODUCT_CHARGE_STATES.includes(state as ProductChargeState)
    )
      throw new HttpError(400, "Choose a charge state.");
    if (cursor !== null && !/^\d{16}:[0-9a-f]{16}$/.test(cursor))
      throw new HttpError(400, "Start the list again.");
    return json(
      await listCharges(storage as never, {
        cursor,
        state: state as ProductChargeState | "billing-soon" | null,
        canRead: async () => canReadInbox,
      }),
    );
  }
  if (match[2] && input.method === "POST") {
    requirePrivilegedHeaders(input.headers, input.body.confirmed, input.nowMs);
    const charge =
      (await disputeUsageCharge(storage, {
        ref: match[2],
        reason: input.body.reason,
        text: input.body.text,
        nowMs: input.nowMs,
      })) ??
      (await disputeCharge(storage as never, {
        env: input.env,
        ref: match[2],
        reason: input.body.reason,
        text: input.body.text,
        nowMs: input.nowMs,
        corpusRow: (at) =>
          corpusRowFor(
            storage as never,
            input.env as CorpusEnv,
            input.room,
            at,
          ),
      }));
    return json({
      dispute: {
        ref: charge.ref,
        status: charge.dispute!.status,
        reason: charge.dispute!.reason,
      },
    });
  }
  if (section === "budget" && input.method === "POST") {
    requirePrivilegedHeaders(input.headers, input.body.confirmed, input.nowMs);
    const cents = input.body.cents;
    if (cents === null) await storage.delete(BUDGET_KEY);
    else if (
      Number.isSafeInteger(cents) &&
      (cents as number) >= PRODUCT_TOP_UP.stepUsdCents &&
      (cents as number) % PRODUCT_TOP_UP.stepUsdCents === 0 &&
      (cents as number) <= PRODUCT_TOP_UP.maxUsdCents * 10
    )
      await storage.put(BUDGET_KEY, { cents });
    else throw new HttpError(400, "Enter a monthly budget in whole dollars.");
    return json({ budget: cents });
  }
  if (section === "budget" && input.method === "GET") {
    const value = await storage.get<{ cents?: number }>(BUDGET_KEY);
    return json({ budget: value?.cents ?? null });
  }
  if (section === "statement" && input.method === "GET") {
    const month = query.get("month");
    if (!month || !MONTH.test(month))
      throw new HttpError(400, "Choose a month.");
    const statement = await productStatement(
      storage as never,
      month,
      input.nowMs,
    );
    if (query.get("format") === "csv")
      return new Response(statementCsv(statement), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="templ-statement-${month}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    return json(statement);
  }
  if (section === "finance-email" && input.method === "GET")
    return json({ financeEmail: await financeEmailView(storage) });
  if (section === "finance-email" && input.method === "POST") {
    requirePrivilegedHeaders(input.headers, input.body.confirmed, input.nowMs);
    return json({
      financeEmail: await setFinanceEmail(
        storage as never,
        input.env as FinanceEmailEnv,
        { room: input.room, email: input.body.email, now: input.nowMs },
      ),
    });
  }
  if (section === "finance-email/verify" && input.method === "POST") {
    requirePrivilegedHeaders(input.headers, input.body.confirmed, input.nowMs);
    return json({
      financeEmail: await verifyFinanceEmail(
        storage as never,
        input.env as FinanceEmailEnv,
        { room: input.room, code: input.body.code, now: input.nowMs },
      ),
    });
  }
  if (section === "activity" && input.method === "GET") {
    const month = query.get("month");
    const activity = month
      ? await monthActivity(storage as never, month)
      : null;
    if (!activity) throw new HttpError(400, "Choose a month.");
    return json(activity);
  }
  const owner =
    input.walletOwner ??
    ((network: number | "solana", address: string) =>
      walletOwner(input.env, network, address));
  if (section === "crypto/requests" && input.method === "GET")
    return json({
      requests: await productPaymentRequests(storage, input.nowMs),
    });
  if (section === "crypto/transaction" && input.method === "POST") {
    const intent = await productPaymentRequest(
      storage,
      String(input.body.requestId),
    );
    if (!intent) throw new HttpError(404, "Payment request not found.");
    if ((await owner(intent.network, intent.payer)) !== intent.principalId)
      throw new HttpError(
        403,
        "The paying wallet is not linked to this account.",
      );
    return json(
      await refreshProductPaymentTransaction(
        storage,
        input.env,
        intent.id,
        input.nowMs,
        undefined,
        input,
      ),
    );
  }
  if (section === "crypto/check" && input.method === "POST") {
    const intent = await productPaymentRequest(
      storage,
      String(input.body.requestId),
    );
    if (!intent) throw new HttpError(404, "Payment request not found.");
    await requireProductPaymentRail(input.env, intent.rail, storage);
    if (intent.verificationReviewRequired)
      throw new HttpError(
        409,
        "This transfer needs a payment review. Do not send it again.",
        undefined,
        "product-payment-review-required",
      );
    if (intent.settlement === "standard-prepaid" && !intent.submittedTx)
      throw new HttpError(400, "Submit the transfer hash before checking it.");
    if (!input.env.PRODUCT_PAYMENT_SCANNERS)
      throw new HttpError(
        503,
        "Payments are unavailable.",
        undefined,
        "product-checkout-unavailable",
      );
    if (input.deferScanner && !input.scannerResult) {
      input.deferScanner({ action: "check", intent });
      return json({ intent });
    }
    if (
      input.scannerResult &&
      (input.scannerResult.action !== "check" ||
        input.scannerResult.requestId !== intent.id)
    )
      throw new HttpError(409, "The payment request changed. Review it again.");
    const response = input.scannerResult
      ? Response.json(input.scannerResult.value)
      : await input.env.PRODUCT_PAYMENT_SCANNERS.get(
          input.env.PRODUCT_PAYMENT_SCANNERS.idFromName(String(intent.network)),
        ).fetch(
          new Request("https://internal/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: intent.id }),
          }),
        );
    const value = await response.json<Record<string, unknown>>();
    if (!response.ok)
      throw new HttpError(
        response.status,
        typeof value.error === "string"
          ? value.error
          : "Payments are unavailable.",
        Number(response.headers.get("Retry-After")) || undefined,
        typeof value.reason === "string" ? value.reason : undefined,
      );
    return json(
      await updateProductPaymentEvent(
        storage,
        {
          requestId: intent.id,
          status: value.status as typeof intent.status,
          ...(value.verificationReviewRequired === true
            ? { verificationReviewRequired: true }
            : {}),
          ...(typeof value.tx === "string" ? { tx: value.tx } : {}),
          ...(value.confirmation !== undefined
            ? { confirmation: value.confirmation }
            : {}),
          ...(typeof value.nextCheckAt === "number"
            ? { nextCheckAt: value.nextCheckAt }
            : {}),
          ...(typeof value.checkAgainAt === "number"
            ? { checkAgainAt: value.checkAgainAt }
            : {}),
        },
        input.nowMs,
      ),
    );
  }
  if (section === "crypto/prepare" && input.method === "POST")
    return json(
      await prepareProductPayment(storage, {
        ...input,
        principalId: input.viewer.principalId,
        walletOwner: owner,
      }),
    );
  if (section === "crypto/receipt" && input.method === "POST") {
    const result = await settleProductPayment(storage, {
      ...input,
      principalId: input.viewer.principalId,
      walletOwner: owner,
    });
    if (result.intent && !result.receipt && !result.unmatched)
      return json(
        {
          ...result,
          error: "The transfer is still confirming.",
          reason: "product-payment-confirming",
        },
        409,
      );
    return json(result);
  }
  throw new HttpError(405, "This plan action is not available.");
}

/** Looks up current ownership of a wallet proof in the identity store. */
export async function walletOwner(
  env: ProductBillingEnv,
  network: number | "solana",
  address: string,
): Promise<ChatPrincipalId | null> {
  const found = (await identityRequest(env as unknown as Env, {
    op: "wallet-owner",
    network,
    address,
  })) as unknown as { principalId?: unknown };
  return normalizeChatPrincipal(found.principalId);
}
