import type { ProductPaymentReceipt } from "@templ/chat/product-payment";
import { HttpError, errorBody, json, readJson, type Env } from "./common";

export const PRODUCT_PAYMENT_LEDGER_OBJECT = "product-payment-ledger";
const PAYMENT_PREFIX = "product-payment-claim:";
const REQUEST_PREFIX = "product-payment-payer:";
const CANCELLED_PREFIX = "product-payment-cancelled:";
const UNMATCHED_PREFIX = "product-unmatched-v1:";
const PAYMENT_ID =
  /^(?:1|56|8453|4663):0x[0-9a-f]{64}:[0-9]+$|^solana:[1-9A-HJ-NP-Za-km-z]{64,88}:[0-9]+$/;
type Claim = {
  workspace: string;
  paymentId: string;
  receipt?: ProductPaymentReceipt;
  operatorCredit?: {
    usdCents: number;
    creditedAt: string;
    rail?: string;
    network?: number | "solana";
    asset?: string;
    recipient?: string;
  };
};
export type PaymentReservation = {
  payer: string;
  rail: string;
  workspace: string;
  principalId: string;
  requestId: string;
  expiresAt: string;
};
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;
const requestKey = (payer: string, rail: string) =>
  `${REQUEST_PREFIX}${rail}:${payer.startsWith("0x") ? payer.toLowerCase() : payer}`;

/** One private object arbitrates payer requests and payment ids across workspaces. */
export async function paymentLedgerRequest(
  storage: Storage,
  action: string,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<Response> {
  if (action === "claim-external") {
    const scope = body.scope ?? "usage";
    if (scope !== "usage" && scope !== "storage" && scope !== "standard") throw new HttpError(400, "Invalid payment allocation.");
    if (
      typeof body.referenceSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.referenceSha256) ||
      typeof body.workspace !== "string" ||
      !/^room:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        body.workspace,
      ) ||
      !Number.isSafeInteger(body.cents) ||
      (body.cents as number) <= 0 ||
      (scope !== "standard" && (body.cents as number) > 100_000)
    )
      throw new HttpError(400, "Invalid external payment reference.");
    const key = `product-external-payment-claim-v1:${body.referenceSha256}`;
    const current = await storage.get<{ workspace: string; cents: number; scope?: "usage" | "storage" | "standard" }>(
      key,
    );
    if (
      current &&
      (current.workspace !== body.workspace || current.cents !== body.cents || (current.scope ?? "usage") !== scope)
    )
      throw new HttpError(409, "This payment reference was already recorded.");
    if (!current)
      await storage.put(key, { workspace: body.workspace, cents: body.cents, ...(scope !== "usage" ? { scope } : {}) });
    return json({ claimed: true });
  }
  if (action === "reserve") {
    const row = body as unknown as PaymentReservation;
    if (
      ![
        row.payer,
        row.rail,
        row.workspace,
        row.principalId,
        row.requestId,
        row.expiresAt,
      ].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length < 160,
      ) ||
      !(Date.parse(row.expiresAt) > now)
    )
      throw new HttpError(400, "Invalid payment request.");
    const key = requestKey(row.payer, row.rail);
    const current = await storage.get<PaymentReservation>(key);
    if (
      current &&
      Date.parse(current.expiresAt) > now &&
      current.principalId !== row.principalId
    )
      throw new HttpError(409, "This wallet has an open payment request.");
    await storage.put(key, row);
    return json({
      replaced: current && Date.parse(current.expiresAt) > now ? current : null,
    });
  }
  if (action === "release") {
    const key = requestKey(String(body.payer), String(body.rail));
    const current = await storage.get<PaymentReservation>(key);
    if (
      current &&
      current.requestId === body.requestId &&
      current.workspace === body.workspace
    )
      await storage.delete(key);
    return json({ ok: true });
  }
  if (action === "cancel-reservation") {
    const row = body.reservation as PaymentReservation;
    if (!row || typeof row.payer !== "string" || typeof row.rail !== "string")
      throw new HttpError(400, "Invalid payment request.");
    const key = requestKey(row.payer, row.rail);
    const current = await storage.get<PaymentReservation>(key);
    let replaced = body.replaced as PaymentReservation | null;
    await storage.put(`${CANCELLED_PREFIX}${row.requestId}`, { replaced });
    if (
      current?.requestId === row.requestId &&
      current.workspace === row.workspace
    ) {
      const visited = new Set<string>();
      while (replaced) {
        if (
          visited.has(replaced.requestId) ||
          Date.parse(replaced.expiresAt) <= now
        ) {
          replaced = null;
          break;
        }
        visited.add(replaced.requestId);
        const cancelled = await storage.get<{
          replaced: PaymentReservation | null;
        }>(`${CANCELLED_PREFIX}${replaced.requestId}`);
        if (!cancelled) break;
        replaced = cancelled.replaced;
      }
      if (replaced && Date.parse(replaced.expiresAt) > now)
        await storage.put(key, replaced);
      else await storage.delete(key);
    }
    return json({ ok: true });
  }
  if (action === "current") {
    const current = await storage.get<PaymentReservation>(
      requestKey(String(body.payer), String(body.rail)),
    );
    return json({
      current: Boolean(
        current &&
        current.requestId === body.requestId &&
        current.workspace === body.workspace &&
        Date.parse(current.expiresAt) > now,
      ),
    });
  }
  if (action === "requests") {
    const rows = await storage.list<PaymentReservation>({
      prefix: REQUEST_PREFIX,
    });
    return json({
      requests: [...rows.values()].filter(
        (row) => Date.parse(row.expiresAt) > now,
      ),
    });
  }
  if (action === "payments") {
    const after = typeof body.after === "string" ? body.after : "";
    const rows = await storage.list<Claim>({
      prefix: PAYMENT_PREFIX,
      ...(after ? { startAfter: `${PAYMENT_PREFIX}${after}` } : {}),
      limit: 100,
    });
    const unmatched = await storage.list({
      prefix: UNMATCHED_PREFIX,
      limit: 100,
    });
    return json({
      payments: [...rows.values()],
      unmatched: [...unmatched.values()],
      next: rows.size === 100 ? [...rows.values()].at(-1)?.paymentId : null,
    });
  }
  if (action === "unmatched") {
    const row = body.row as Record<string, unknown> | undefined;
    if (
      !row ||
      typeof row.paymentId !== "string" ||
      !PAYMENT_ID.test(row.paymentId)
    )
      throw new HttpError(400, "Invalid unmatched payment.");
    const key = `${UNMATCHED_PREFIX}${row.paymentId}`;
    if (!(await storage.get(key)))
      await storage.put(key, { ...row, status: "open" });
    return json({ ok: true });
  }
  if (action === "unmatched-get") {
    if (typeof body.paymentId !== "string" || !PAYMENT_ID.test(body.paymentId))
      throw new HttpError(400, "Invalid unmatched payment.");
    return json({
      row: (await storage.get(`${UNMATCHED_PREFIX}${body.paymentId}`)) ?? null,
    });
  }
  const paymentId = body.paymentId;
  const workspace = body.workspace;
  if (
    typeof paymentId !== "string" ||
    !PAYMENT_ID.test(paymentId) ||
    typeof workspace !== "string" ||
    !workspace
  )
    throw new HttpError(400, "Invalid payment claim.");
  const key = `${PAYMENT_PREFIX}${paymentId}`;
  const current = await storage.get<Claim>(key);
  if (current && current.workspace !== workspace)
    throw new HttpError(
      409,
      "This transaction was already credited.",
      undefined,
      "product-payment-already-credited",
    );
  if (action === "claim") {
    if (body.existingOnly === true)
      return json({ receipt: current?.receipt ?? null });
    if (!current && body.requestId !== undefined) {
      const reservation = await storage.get<PaymentReservation>(
        requestKey(String(body.payer), String(body.rail)),
      );
      if (
        !reservation ||
        reservation.requestId !== body.requestId ||
        reservation.workspace !== workspace ||
        Date.parse(reservation.expiresAt) <= now
      )
        throw new HttpError(409, "This payment request has closed.");
    }
    if (!current) await storage.put(key, { workspace, paymentId });
    return json({ receipt: current?.receipt ?? null });
  }
  if (action === "complete") {
    if (!current)
      throw new HttpError(409, "Claim the payment before crediting it.");
    if (!body.receipt || typeof body.receipt !== "object")
      throw new HttpError(400, "Invalid payment receipt.");
    if (!current.receipt)
      await storage.put(key, { ...current, receipt: body.receipt });
    return json({ receipt: current.receipt ?? body.receipt });
  }
  if (action === "operator-complete") {
    if (!current)
      throw new HttpError(409, "Claim the payment before crediting it.");
    if (!Number.isSafeInteger(body.usdCents) || (body.usdCents as number) <= 0)
      throw new HttpError(400, "Invalid payment credit.");
    const unmatched = await storage.get<Record<string, unknown>>(
      `${UNMATCHED_PREFIX}${paymentId}`,
    );
    const operatorCredit = {
      usdCents: body.usdCents as number,
      creditedAt: new Date(now).toISOString(),
      ...(typeof unmatched?.rail === "string" ? { rail: unmatched.rail } : {}),
      ...(typeof unmatched?.network === "number" ||
      unmatched?.network === "solana"
        ? { network: unmatched.network }
        : {}),
      ...(typeof unmatched?.asset === "string"
        ? { asset: unmatched.asset }
        : {}),
      ...(typeof unmatched?.recipient === "string"
        ? { recipient: unmatched.recipient }
        : {}),
    };
    if (!current.operatorCredit)
      await storage.put(key, { ...current, operatorCredit });
    if (unmatched?.status === "open")
      await storage.put(`${UNMATCHED_PREFIX}${paymentId}`, {
        ...unmatched,
        status: "credited",
        workspace,
        creditedCents: body.usdCents,
      });
    return json({ ok: true });
  }
  if (action === "unmatched-return") {
    const unmatched = await storage.get<Record<string, unknown>>(
      `${UNMATCHED_PREFIX}${paymentId}`,
    );
    if (unmatched?.status === "open")
      await storage.put(`${UNMATCHED_PREFIX}${paymentId}`, {
        ...unmatched,
        status: "returned",
        workspace,
      });
    return json({ ok: true });
  }
  throw new HttpError(404, "Not found.");
}

export class ProductPaymentLedger {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") throw new HttpError(404, "Not found.");
      const body = await readJson(request);
      return await this.state.storage.transaction((storage) =>
        paymentLedgerRequest(
          storage,
          new URL(request.url).pathname.slice(1),
          body,
        ),
      );
    } catch (error) {
      return json(
        errorBody(error, "Payments are unavailable."),
        error instanceof HttpError ? error.status : 503,
      );
    }
  }
}

export async function paymentLedgerCall(
  env: Partial<Pick<Env, "PRODUCT_PAYMENT_LEDGER">>,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!env.PRODUCT_PAYMENT_LEDGER)
    throw new HttpError(
      503,
      "Payments are unavailable.",
      undefined,
      "product-checkout-unavailable",
    );
  const response = await env.PRODUCT_PAYMENT_LEDGER.get(
    env.PRODUCT_PAYMENT_LEDGER.idFromName(PRODUCT_PAYMENT_LEDGER_OBJECT),
  ).fetch(
    new Request(`https://internal/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const result = await response.json<Record<string, unknown>>();
  if (!response.ok)
    throw new HttpError(
      response.status,
      typeof result.error === "string"
        ? result.error
        : "Payments are unavailable.",
      undefined,
      typeof result.reason === "string" ? result.reason : undefined,
    );
  return result;
}
