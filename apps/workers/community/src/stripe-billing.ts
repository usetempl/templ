import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
import {
  isPriceTable,
  priceTableSteps,
  resolutionPriceSteps,
  resolutionPriceTable,
  type ResolutionPriceTable,
} from "@templ/chat/resolution-pricing";
import { HttpError } from "./common";

/** Billing Meters use the API pinned in the hosted card trial. */
export const STRIPE_API_VERSION = "2025-06-30.basil";
export type StripeBillingEnv = WorkspaceFlagEnv & {
  APP_ORIGIN: string;
  CARD_BILLING_ENABLED?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CASE_PRICE_ID?: string;
  STRIPE_API_VERSION?: string;
  STRIPE_ALLOW_LIVE_KEY?: string;
};
export type StripeFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type StripeObject = Record<string, unknown> & { id: string };
export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: StripeObject };
};
export type StripeCard = { brand: string; last4: string };
type Fields = Record<string, string | number | boolean>;
export type StripePrice = {
  priceId: string;
  meterId: string;
  eventName: string;
  table: ResolutionPriceTable;
};
export type StripeActivationRequest = StripePrice & {
  customerId: string;
  paymentMethodId: string;
  billingCycleAnchor: number;
  idempotencyKey: string;
  card: StripeCard | null;
};
const unavailable = () =>
  new HttpError(
    503,
    "Card billing is not available.",
    undefined,
    "card-billing-unavailable",
  );
const upstream = () =>
  new HttpError(
    503,
    "Stripe could not complete this step.",
    undefined,
    "stripe-unavailable",
  );
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function stripeId(value: unknown, prefix: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)
  )
    throw upstream();
  return value;
}
export function stripeObjectId(value: unknown): string | null {
  return typeof value === "string"
    ? value
    : record(value) && typeof value.id === "string"
      ? value.id
      : null;
}

/** Signed event intake still needs the kill switch and verified credentials. */
export function cardBillingIngressEnabled(env: StripeBillingEnv): boolean {
  const key = env.STRIPE_SECRET_KEY ?? "";
  const test = /^(?:sk|rk)_test_[A-Za-z0-9_]+$/.test(key);
  const live = /^(?:sk|rk)_live_[A-Za-z0-9_]+$/.test(key);
  const keyAllowed =
    test ||
    (live &&
      env.APP_ORIGIN === "https://usetempl.com" &&
      env.STRIPE_ALLOW_LIVE_KEY === "true");
  return (
    env.CARD_BILLING_ENABLED === "true" &&
    env.STRIPE_API_VERSION === STRIPE_API_VERSION &&
    /^price_[A-Za-z0-9]+$/.test(env.STRIPE_CASE_PRICE_ID ?? "") &&
    /^whsec_[A-Za-z0-9_]+$/.test(env.STRIPE_WEBHOOK_SECRET ?? "") &&
    keyAllowed &&
    ["https://templ.vip", "https://usetempl.com"].includes(env.APP_ORIGIN)
  );
}

/** False prevents all outbound Stripe calls, including reads. */
export function cardBillingEnabled(env: StripeBillingEnv): boolean {
  return (
    featureOn(env, undefined, "cardBilling") && cardBillingIngressEnabled(env)
  );
}
export function assertCardBillingEnabled(env: StripeBillingEnv) {
  if (!cardBillingEnabled(env)) throw unavailable();
}

/** This client accepts Stripe ids and usage only. Payment details stay on Stripe's pages. */
export class StripeClient {
  private price?: Promise<StripePrice>;
  constructor(
    private readonly env: StripeBillingEnv,
    private readonly fetcher: StripeFetcher = (url, init) => fetch(url, init),
  ) {}

  async request<T = StripeObject>(
    method: "GET" | "POST",
    path: string,
    fields: Fields = {},
    idempotencyKey?: string,
  ): Promise<T> {
    assertCardBillingEnabled(this.env);
    if (
      !/^\/[A-Za-z0-9_/-]+$/.test(path) ||
      (method === "POST" &&
        (!idempotencyKey || !/^[A-Za-z0-9:._-]{1,200}$/.test(idempotencyKey)))
    )
      throw upstream();
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(fields))
      form.set(name, String(value));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Idempotency-Key"] = idempotencyKey!;
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.stripe.com/v1${path}${method === "GET" && form.size ? `?${form}` : ""}`,
        {
          method,
          headers,
          ...(method === "POST" ? { body: form.toString() } : {}),
          // Workers support only "follow" and "manual"; a 3xx is not ok and fails below.
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw upstream();
      return (await response.json()) as T;
    } catch {
      // Provider bodies and thrown transport errors can contain credentials.
      throw upstream();
    }
  }

  /** Each isolate checks the configured price before creating or changing billing. A mismatch fails closed. */
  assertPrice() {
    this.price ??= this.readPrice(
      this.env.STRIPE_CASE_PRICE_ID!,
      resolutionPriceTable(),
    ).catch(() => {
      this.price = undefined;
      throw unavailable();
    });
    return this.price;
  }
  async readPrice(
    priceId: string,
    expected?: ResolutionPriceTable,
  ): Promise<StripePrice> {
    const price = await this.request<StripeObject>(
      "GET",
      `/prices/${priceId}`,
      { "expand[]": "tiers" },
    );
    const tiers = price.tiers;
    const recurring = price.recurring;
    const table =
      Array.isArray(tiers) &&
      tiers.length === 2 &&
      record(tiers[0]) &&
      record(tiers[1])
        ? {
            aiOnlyUsdCents: (expected ?? resolutionPriceTable()).aiOnlyUsdCents,
            usdCents: tiers[0].unit_amount,
            stepOneAfterCases: tiers[0].up_to,
            stepOneUsdCents: tiers[1].unit_amount,
          }
        : null;
    if (!isPriceTable(table)) throw unavailable();
    const steps = priceTableSteps(expected ?? table);
    if (
      price.id !== priceId ||
      price.active !== true ||
      price.currency !== "usd" ||
      price.billing_scheme !== "tiered" ||
      price.tiers_mode !== "graduated" ||
      !record(recurring) ||
      recurring.interval !== "month" ||
      recurring.interval_count !== 1 ||
      recurring.usage_type !== "metered" ||
      price.transform_quantity != null ||
      !Array.isArray(tiers) ||
      tiers.length !== steps.length ||
      tiers.some(
        (tier, index) =>
          !record(tier) ||
          tier.up_to !== steps[index].toCase ||
          tier.unit_amount !== steps[index].usdCents ||
          (tier.flat_amount != null && tier.flat_amount !== 0) ||
          (tier.unit_amount_decimal != null &&
            Number(tier.unit_amount_decimal) !== steps[index].usdCents),
      )
    )
      throw unavailable();
    const meterId = stripeId(recurring.meter, "mtr");
    const meter = await this.request<StripeObject>(
      "GET",
      `/billing/meters/${meterId}`,
    );
    if (
      meter.id !== meterId ||
      meter.status !== "active" ||
      typeof meter.event_name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(meter.event_name) ||
      !record(meter.default_aggregation) ||
      meter.default_aggregation.formula !== "sum" ||
      !record(meter.customer_mapping) ||
      meter.customer_mapping.type !== "by_id" ||
      meter.customer_mapping.event_payload_key !== "stripe_customer_id" ||
      !record(meter.value_settings) ||
      meter.value_settings.event_payload_key !== "value" ||
      meter.event_time_window != null
    )
      throw unavailable();
    return { priceId, meterId, eventName: meter.event_name, table };
  }

  async createCustomer(owner: string) {
    await this.assertPrice();
    // The same canonical owner always gets the same customer creation request.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(owner),
    );
    const key = Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    const customer = await this.request(
      "POST",
      "/customers",
      { "metadata[templ_billing_owner]": owner },
      `templ-owner:${key}`,
    );
    return { id: stripeId(customer.id, "cus") };
  }
  private appUrl(value: string) {
    try {
      const url = new URL(value);
      if (url.origin !== this.env.APP_ORIGIN || url.username || url.password)
        throw upstream();
      return url.href;
    } catch {
      throw upstream();
    }
  }
  private hostedUrl(value: unknown, host: string) {
    try {
      const url = new URL(String(value));
      if (
        url.protocol !== "https:" ||
        url.hostname !== host ||
        url.username ||
        url.password
      )
        throw upstream();
      return url.href;
    } catch {
      throw upstream();
    }
  }
  async setupSession(input: {
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }) {
    await this.assertPrice();
    const session = await this.request(
      "POST",
      "/checkout/sessions",
      {
        mode: "setup",
        customer: stripeId(input.customerId, "cus"),
        "payment_method_types[0]": "card",
        success_url: this.appUrl(input.successUrl),
        cancel_url: this.appUrl(input.cancelUrl),
      },
      input.idempotencyKey,
    );
    return {
      id: stripeId(session.id, "cs"),
      url: this.hostedUrl(session.url, "checkout.stripe.com"),
    };
  }
  async portalSession(input: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }) {
    await this.assertPrice();
    const session = await this.request(
      "POST",
      "/billing_portal/sessions",
      {
        customer: stripeId(input.customerId, "cus"),
        return_url: this.appUrl(input.returnUrl),
      },
      input.idempotencyKey,
    );
    return { url: this.hostedUrl(session.url, "billing.stripe.com") };
  }
  /** Called only after a signed setup event matched the stored customer and session ids. */
  async prepareActivation(
    input: {
      customerId: string;
      setupIntentId: string;
      idempotencyKey: string;
      nowMs?: number;
    },
    selectedPrice?: StripePrice,
  ) {
    const price = selectedPrice
      ? await this.readPrice(selectedPrice.priceId, selectedPrice.table)
      : await this.assertPrice();
    const customerId = stripeId(input.customerId, "cus");
    const setup = await this.request(
      "GET",
      `/setup_intents/${stripeId(input.setupIntentId, "seti")}`,
      { "expand[]": "payment_method" },
    );
    if (setup.customer !== customerId || setup.status !== "succeeded")
      throw upstream();
    const paymentMethodId = stripeId(
      stripeObjectId(setup.payment_method),
      "pm",
    );
    const pm = record(setup.payment_method)
      ? setup.payment_method
      : await this.request("GET", `/payment_methods/${paymentMethodId}`);
    if (pm.type !== "card" || stripeObjectId(pm.customer) !== customerId)
      throw upstream();
    const at = new Date(input.nowMs ?? Date.now());
    return {
      ...price,
      customerId,
      paymentMethodId,
      idempotencyKey: input.idempotencyKey,
      billingCycleAnchor: Math.floor(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) / 1_000,
      ),
      card:
        record(pm.card) &&
        typeof pm.card.brand === "string" &&
        /^[a-zA-Z0-9 _-]{1,24}$/.test(pm.card.brand) &&
        typeof pm.card.last4 === "string" &&
        /^\d{4}$/.test(pm.card.last4)
          ? { brand: pm.card.brand, last4: pm.card.last4 }
          : null,
    } satisfies StripeActivationRequest;
  }
  async activateSubscription(
    input:
      | StripeActivationRequest
      | {
          customerId: string;
          setupIntentId: string;
          idempotencyKey: string;
          nowMs?: number;
        },
    reconcile = false,
    reconcileOnly = false,
  ) {
    const frozen =
      "billingCycleAnchor" in input
        ? input
        : await this.prepareActivation(input);
    const { customerId, paymentMethodId, priceId } = frozen;
    let subscription: StripeObject | undefined;
    if (reconcile) {
      const list = await this.request<{
        data: StripeObject[];
        has_more: boolean;
      }>("GET", "/subscriptions", {
        customer: customerId,
        status: "all",
        limit: 100,
      });
      if (!Array.isArray(list.data) || list.has_more) throw upstream();
      const matches = list.data.filter(
        (row) =>
          stripeObjectId(row.customer) === customerId &&
          record(row.metadata) &&
          row.metadata.templ_activation === frozen.idempotencyKey,
      );
      if (matches.length > 1) throw upstream();
      subscription = matches[0];
    }
    if (!subscription) {
      if (reconcileOnly)
        throw new HttpError(
          409,
          "Card billing needs an operator review.",
          undefined,
          "stripe-retry-review",
        );
      await this.request(
        "POST",
        `/customers/${customerId}`,
        { "invoice_settings[default_payment_method]": paymentMethodId },
        `${frozen.idempotencyKey}:default`,
      );
      subscription = await this.request(
        "POST",
        "/subscriptions",
        {
          customer: customerId,
          collection_method: "charge_automatically",
          "items[0][price]": priceId,
          default_payment_method: paymentMethodId,
          billing_cycle_anchor: frozen.billingCycleAnchor,
          proration_behavior: "none",
          "metadata[templ_activation]": frozen.idempotencyKey,
        },
        `${frozen.idempotencyKey}:subscription`,
      );
    }
    if (
      !subscription ||
      stripeObjectId(subscription.customer) !== customerId ||
      !record(subscription.items) ||
      !Array.isArray(subscription.items.data) ||
      subscription.items.data.length !== 1
    )
      throw upstream();
    const item = subscription.items.data[0];
    if (
      !record(item) ||
      stripeObjectId(item.price) !== priceId ||
      (reconcile &&
        subscription.billing_cycle_anchor !== frozen.billingCycleAnchor) ||
      (reconcile &&
        stripeObjectId(subscription.default_payment_method) !== paymentMethodId)
    )
      throw upstream();
    return {
      subscriptionId: stripeId(subscription.id, "sub"),
      subscriptionItemId: stripeId(item.id, "si"),
      ...frozen,
      status:
        typeof subscription.status === "string"
          ? subscription.status
          : "incomplete",
      periodStart: natural(item.current_period_start)
        ? item.current_period_start
        : null,
      periodEnd: natural(item.current_period_end)
        ? item.current_period_end
        : null,
    };
  }
  async cancelAtPeriodEnd(subscriptionId: string, key: string) {
    await this.assertPrice();
    await this.request(
      "POST",
      `/subscriptions/${stripeId(subscriptionId, "sub")}`,
      { cancel_at_period_end: true },
      key,
    );
  }
  async reportUsage(input: {
    customerId: string;
    chargeId: string;
    finalAt: number;
    eventName?: string;
  }) {
    const eventName = input.eventName ?? (await this.assertPrice()).eventName;
    const identifier = stripeUsageIdentifier(input.chargeId);
    if (!natural(input.finalAt)) throw upstream();
    await this.request(
      "POST",
      "/billing/meter_events",
      {
        event_name: eventName,
        identifier,
        "payload[stripe_customer_id]": stripeId(input.customerId, "cus"),
        "payload[value]": 1,
        timestamp: Math.floor(input.finalAt / 1_000),
      },
      identifier,
    );
    return identifier;
  }
  async cancelUsage(
    chargeId: string,
    key = `templ-cancel:${chargeId}`,
    storedEventName?: string,
  ) {
    const eventName = storedEventName ?? (await this.assertPrice()).eventName;
    await this.request(
      "POST",
      "/billing/meter_event_adjustments",
      {
        event_name: eventName,
        type: "cancel",
        "cancel[identifier]": stripeUsageIdentifier(chargeId),
      },
      key,
    );
  }
  async creditCustomer(input: {
    customerId: string;
    chargeId: string;
    cents: number;
  }) {
    if (!natural(input.cents) || input.cents === 0) throw upstream();
    await this.adjustCustomerBalance(input, `templ-credit:${input.chargeId}`);
  }
  /** A signed adjustment preserves the charge's fixed price when canceling meter quantity crosses a tier. */
  async adjustCustomerBalance(
    input: { customerId: string; chargeId: string; cents: number },
    key: string,
  ) {
    await this.assertPrice();
    if (!Number.isSafeInteger(input.cents) || input.cents === 0)
      throw upstream();
    await this.request(
      "POST",
      `/customers/${stripeId(input.customerId, "cus")}/balance_transactions`,
      {
        amount: -input.cents,
        currency: "usd",
        "metadata[templ_charge_ref]": input.chargeId,
      },
      key,
    );
  }
}

export function stripeUsageIdentifier(chargeId: string) {
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(chargeId)) throw upstream();
  return `templ-case:${chargeId}`;
}

/** Verify the raw bytes before parsing. Any matching v1 signature is accepted. */
export async function verifyStripeWebhook(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
): Promise<StripeEvent> {
  const invalid = () =>
    new HttpError(
      400,
      "Stripe signature is invalid.",
      undefined,
      "stripe-signature-invalid",
    );
  if (
    !header ||
    !/^whsec_[A-Za-z0-9_]+$/.test(secret) ||
    !natural(nowMs) ||
    rawBody.length > 1_000_000 ||
    header.length > 4_096
  )
    throw invalid();
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const entry of header.split(",")) {
    const match = /^\s*([A-Za-z0-9]+)=([^\s,]+)\s*$/.exec(entry);
    if (!match) throw invalid();
    if (match[1] === "t") timestamps.push(match[2]);
    if (match[1] === "v1") {
      if (!/^[a-fA-F0-9]{64}$/.test(match[2])) throw invalid();
      signatures.push(match[2].toLowerCase());
    }
  }
  if (
    timestamps.length !== 1 ||
    !/^\d{1,12}$/.test(timestamps[0]) ||
    !signatures.length
  )
    throw invalid();
  const timestamp = Number(timestamps[0]);
  if (
    !natural(timestamp) ||
    Math.abs(Math.floor(nowMs / 1_000) - timestamp) > 300
  )
    throw invalid();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamps[0]}.${rawBody}`),
    ),
  );
  let any = 0;
  for (const signature of signatures) {
    let difference = 0;
    for (let i = 0; i < digest.length; i++)
      difference |=
        digest[i] ^ Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
    any |= Number(difference === 0);
  }
  if (any === 0) throw invalid();
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw invalid();
  }
  if (
    !record(event) ||
    typeof event.id !== "string" ||
    !/^evt_[A-Za-z0-9]+$/.test(event.id) ||
    typeof event.type !== "string" ||
    !natural(event.created) ||
    typeof event.livemode !== "boolean" ||
    !record(event.data) ||
    !record(event.data.object) ||
    typeof event.data.object.id !== "string"
  )
    throw invalid();
  return event as StripeEvent;
}

/** The meter's quantity and catalog estimate must match the final-charge ledger. */
export function reconcileStripeUsage(input: {
  billableFinalCases: number;
  reportedCases: number;
}) {
  if (
    !natural(input.billableFinalCases) ||
    !natural(input.reportedCases) ||
    input.billableFinalCases !== input.reportedCases
  )
    throw new HttpError(
      409,
      "Card usage needs a review.",
      undefined,
      "stripe-usage-mismatch",
    );
  let estimateCents = 0;
  for (const step of resolutionPriceSteps()) {
    const count = Math.max(
      0,
      Math.min(input.reportedCases, step.toCase ?? input.reportedCases) -
        step.fromCase +
        1,
    );
    estimateCents += count * step.usdCents;
  }
  return { cases: input.reportedCases, estimateCents };
}
