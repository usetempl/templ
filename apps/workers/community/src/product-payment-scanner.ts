import { toHex } from "viem";
import {
  PRODUCT_RAILS,
  productTransferPaymentId,
  type ProductPaymentIntent,
  type ProductPaymentNetwork,
} from "@templ/chat/product-payment";
import { productPaymentRpcEnv } from "./product-payment-rpc";
import { authorizationEndpoints, type ChainRpcEnv } from "./chain-rpc";
import { HttpError, errorBody, json, readJson, type Env } from "./common";
import {
  paymentRpc,
  rpcQuantity,
  normalizeReceipt,
  paymentReceiptTime,
  paymentRpcResponseError,
  type PaymentFetcher,
} from "./chain-payment-rpc";
import {
  paymentRecipients,
  requireProductPaymentRail,
  readProductPayment,
  matchEvmProductTransfer,
  verifyInboundProductPayment,
  verifyProductPayment,
  createProductPaymentProofCache,
  type ProductPaymentRpc,
  PRODUCT_TRANSFER_TOPIC,
  type ProductBillingEnv,
} from "./product-billing";
import {
  productTokenAccount,
  matchSolanaProductTransfer,
  isSolanaPaymentSignature,
} from "./product-billing-solana";
import { paymentLedgerCall } from "./product-payment-ledger";
import { solanaEndpoints, type SolanaRpcEnv } from "./solana";
import { RPC_BUDGET, createRpcBudget } from "./rpc-budget";
import {
  workspaceFeatureEnvFor,
  workspaceFeatureEnvFromValues,
  workspaceFeatureValues,
} from "./workspace-flags";
import { WORKSPACE_FLAG_KEYS } from "@templ/chat/workspace-flags";

/** Finality spacing is an estimate, never payment authority. Ethereum uses
 * two 32-slot epochs (ethereum.org/developers/docs/consensus-mechanisms/pos).
 * Base waits for L1 finality (docs.base.org/base-chain/specs/protocol/consensus/derivation).
 * BNB exposes finalized blocks (docs.bnbchain.org/bnb-smart-chain/introduction).
 * Solana waits for finalized commitment (solana.com/docs/rpc). Checked 2026-09-30.
 * All EVM credit reads require finalized; an unsupported tag fails closed. */
export const PRODUCT_PAYMENT_FINALITY_SECONDS: Readonly<
  Record<ProductPaymentNetwork, number>
> = { 1: 768, 8453: 1200, 56: 3, 4663: 1200, solana: 32 };
export const expectedPaymentFinalitySeconds = (
  network: ProductPaymentNetwork,
) => PRODUCT_PAYMENT_FINALITY_SECONDS[network];
export const PRODUCT_PAYMENT_SCAN_LIMITS = {
  rpcPerMinute: 120,
  providerErrors: 3,
  cooldownMs: 60_000,
  requestCooldownMs: 30_000,
  maxSubmissionsPerRequest: 10,
  latestCacheMs: 15_000,
  missingReceiptGraceMs: 120_000,
  maxRange: { 1: 512, 8453: 2048, 56: 4096, 4663: 2048 },
  reorgOverlap: { 1: 64, 8453: 128, 56: 256, 4663: 128 },
} as const;
export const STANDARD_PAYMENT_CHECK_LIMITS = {
  finalityAttempts: 6,
  submissions: 3,
  backoffMs: [30_000, 90_000, 300_000, 600_000, 900_000],
  windowMs: 45 * 60_000,
  roomTimeoutMs: 45_000,
} as const;
export function paymentScanSpacing(
  createdAt: number,
  now: number,
): number | null {
  const age = Math.max(0, now - createdAt);
  return age < 120_000
    ? 10_000
    : age < 600_000
      ? 30_000
      : age < 3_600_000
        ? 120_000
        : null;
}
type ScannedRequest = {
  intent: ProductPaymentIntent;
  nextScanAt: number | null;
  nextFinalityAt?: number;
  lastFinalityAttemptAt?: number;
  checkAgainAt?: number;
  submittedTx?: string;
  submittedTransactions?: string[];
  recoveryTx?: string;
  attemptUntil?: number;
  forceScan?: boolean;
  finalityRetries?: number;
  missingReceiptSince?: number;
  verificationAttempts?: number;
};
type ScannerData = {
  network: ProductPaymentNetwork;
  requests: Record<string, ScannedRequest>;
  cursor?: string;
  catchingUp?: boolean;
  nextDiscoveryAt?: number;
  lastDiscoveryAt?: number;
  solanaCursors: Record<string, string>;
  solanaPages?: Record<
    string,
    { pages: { before: string; until?: string }[]; catchUpNext: boolean }
  >;
  pendingSolana: string[];
  pendingEvm?: string[];
  observedEvm?: Record<string, string>;
  candidates?: Record<
    string,
    {
      nextCheckAt: number;
      expiresAt: number;
      observedAfter?: number;
      needsMatch?: boolean;
    }
  >;
  latest?: { number: string; at: number };
  solanaBlockhash?: {
    blockhash: string;
    lastValidBlockHeight: number;
    at: number;
  };
  budget: { minute: number; calls: number };
  errors: number;
  openUntil: number;
};
export async function paymentScannerCall(
  env: Partial<Pick<Env, "PRODUCT_PAYMENT_SCANNERS">>,
  network: ProductPaymentNetwork,
  action: string,
  body: Record<string, unknown>,
) {
  if (!env.PRODUCT_PAYMENT_SCANNERS)
    throw new HttpError(
      503,
      "Payments are unavailable.",
      undefined,
      "product-checkout-unavailable",
    );
  const response = await env.PRODUCT_PAYMENT_SCANNERS.get(
    env.PRODUCT_PAYMENT_SCANNERS.idFromName(String(network)),
  ).fetch(
    new Request(`https://internal/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const result = await response.json<Record<string, unknown>>();
  if (!response.ok) {
    const error = new HttpError(
      response.status,
      typeof result.error === "string"
        ? result.error
        : "Payments are unavailable.",
      Number(response.headers.get("Retry-After")) || undefined,
      typeof result.reason === "string" ? result.reason : undefined,
    );
    if (action === "verify" && response.status === 422)
      Object.assign(error, {
        ...(Number.isSafeInteger(result.paymentIndex) &&
        (result.paymentIndex as number) >= 0
          ? { paymentIndex: result.paymentIndex }
          : {}),
        ...(Number.isSafeInteger(result.actualCents) &&
        (result.actualCents as number) > 0
          ? { actualCents: result.actualCents }
          : {}),
        ...(typeof result.creditEligible === "boolean"
          ? { creditEligible: result.creditEligible }
          : {}),
      });
    throw error;
  }
  return result;
}
/** A singleton per network owns the cursor, RPC budget and one alarm. No
 * per-workspace scan exists; every ranged result serves the whole network. */
export class ProductPaymentScanner {
  private data?: ScannerData;
  private loading: Promise<void>;
  private flight?: Promise<void>;
  private proofCache?: ProductPaymentRpc;
  private blockhashFlight?: Promise<
    NonNullable<ScannerData["solanaBlockhash"]>
  >;
  private providerFailures = 0;
  private providerSuccesses = 0;
  private readonly now: () => number;
  private readonly fetcher: PaymentFetcher;
  private readonly env: ProductBillingEnv & Partial<Pick<Env, "ROOMS">>;
  constructor(
    private readonly state: DurableObjectState,
    env: Env,
    options: {
      fetcher?: PaymentFetcher;
      now?: () => number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.env = {
      ...env,
      [RPC_BUDGET]: createRpcBudget(env),
    };
    this.loading = this.state.blockConcurrencyWhile(async () => {
      this.data = await this.state.storage.get<ScannerData>(
        "product-payment-scanner",
      );
    });
  }
  private async save() {
    if (this.data)
      await this.state.storage.put("product-payment-scanner", this.data);
  }
  private railOpen(rail: unknown) {
    try {
      requireProductPaymentRail(this.env, rail);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) return false;
      throw error;
    }
  }
  private async paymentEnv(intent: ProductPaymentIntent) {
    if (this.railOpen(intent.rail)) return productPaymentRpcEnv(this.env);
    if (this.env.PRODUCT_PAYMENTS_ENABLED !== "true" || !this.env.ROOMS)
      throw new HttpError(503, "Payments are unavailable.");
    const env = await workspaceFeatureEnvFor(
      this.env as ProductBillingEnv & Pick<Env, "ROOMS">,
      intent.workspace.replace(/^room:/, ""),
    );
    requireProductPaymentRail(env, intent.rail);
    return productPaymentRpcEnv(env);
  }
  private async openRequests(rows: ScannedRequest[]) {
    const checks = await Promise.all(
      rows.map(async (row) => {
        try {
          await this.paymentEnv(row.intent);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return rows.filter((_, index) => checks[index]);
  }
  private async scanEnv(rows: ScannedRequest[]) {
    const features = workspaceFeatureValues(this.env);
    for (const row of rows) {
      const scoped = workspaceFeatureValues(await this.paymentEnv(row.intent));
      for (const key of WORKSPACE_FLAG_KEYS)
        if (key.startsWith("pay.")) features[key] ||= scoped[key];
    }
    return workspaceFeatureEnvFromValues(this.env, features);
  }
  private validateTransaction(network: ProductPaymentNetwork, tx: string) {
    if (network === "solana") {
      if (!isSolanaPaymentSignature(tx))
        throw new HttpError(400, "Enter the Solana transaction signature.");
    } else if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
      throw new HttpError(400, "Enter the transaction hash.");
    }
  }
  private standard(row: ScannedRequest) {
    return row.intent.settlement === "standard-prepaid";
  }
  private needsReview(row: ScannedRequest, now = this.now()) {
    return (
      this.standard(row) &&
      (row.intent.verificationReviewRequired === true ||
        (row.verificationAttempts ?? 0) >=
          STANDARD_PAYMENT_CHECK_LIMITS.finalityAttempts ||
        (row.attemptUntil !== undefined && now >= row.attemptUntil))
    );
  }
  private stopChecks(row: ScannedRequest) {
    row.intent.verificationReviewRequired = true;
    row.nextScanAt = null;
    delete row.nextFinalityAt;
    delete row.forceScan;
  }
  private assertChecksOpen(row: ScannedRequest) {
    if (!this.needsReview(row)) return;
    this.stopChecks(row);
    this.state.waitUntil(
      this.emit(row, row.intent.status).catch(() => undefined),
    );
    throw new HttpError(
      409,
      "This transfer needs a payment review. Do not send it again.",
      undefined,
      "product-payment-review-required",
    );
  }
  private resumeDiscovery(row: ScannedRequest, recoverMissing = false) {
    if (this.standard(row)) {
      this.stopChecks(row);
      return;
    }
    if (recoverMissing) row.recoveryTx = row.submittedTx;
    else delete row.recoveryTx;
    if (row.submittedTx && this.data?.observedEvm)
      delete this.data.observedEvm[row.submittedTx];
    delete row.submittedTx;
    delete row.intent.confirmation;
    delete row.nextFinalityAt;
    delete row.attemptUntil;
    delete row.finalityRetries;
    delete row.missingReceiptSince;
    row.intent.status = "open";
    const spacing = paymentScanSpacing(
      Date.parse(row.intent.createdAt),
      this.now(),
    );
    row.nextScanAt = spacing === null ? null : this.now() + spacing;
    if (row.nextScanAt !== null) this.data!.nextDiscoveryAt ??= row.nextScanAt;
  }
  private retryFinality(row: ScannedRequest, now: number) {
    if (this.needsReview(row, now)) {
      this.stopChecks(row);
      return;
    }
    const retries = row.finalityRetries ?? 0;
    row.nextFinalityAt =
      now +
      (this.standard(row)
        ? STANDARD_PAYMENT_CHECK_LIMITS.backoffMs[
            Math.min(
              retries,
              STANDARD_PAYMENT_CHECK_LIMITS.backoffMs.length - 1,
            )
          ]
        : Math.min(120_000, 30_000 * 2 ** Math.min(retries, 2)));
    row.finalityRetries = retries + 1;
    if (this.standard(row) && row.attemptUntil !== undefined)
      row.nextFinalityAt = Math.min(row.nextFinalityAt, row.attemptUntil);
  }
  private firstProofAt(network: ProductPaymentNetwork, paidAt?: number) {
    const now = this.now();
    return Math.max(
      now,
      (paidAt !== undefined && paidAt <= now ? paidAt : now) +
        expectedPaymentFinalitySeconds(network) * 1000,
    );
  }
  private discoverySpacing(row: ScannedRequest, now: number) {
    if (this.standard(row)) return null;
    return this.data!.requests[row.intent.id] && row.intent.status === "open"
      ? paymentScanSpacing(Date.parse(row.intent.createdAt), now)
      : null;
  }
  private discoveryActive(rows: ScannedRequest[]) {
    return rows.some((row) => this.discoverySpacing(row, this.now()) !== null);
  }
  private advanceDiscovery(rows: ScannedRequest[]) {
    const data = this.data!,
      now = this.now(),
      intervals = rows
        .map((row) => this.discoverySpacing(row, now))
        .filter((spacing): spacing is number => spacing !== null),
      next = intervals.length ? now + Math.min(...intervals) : undefined;
    data.nextDiscoveryAt = next;
    data.lastDiscoveryAt = now;
    for (const row of rows) {
      if (!data.requests[row.intent.id]) continue;
      row.nextScanAt =
        this.discoverySpacing(row, now) === null ? null : (next ?? null);
      row.forceScan = false;
    }
  }
  private primary() {
    const network = this.data!.network,
      env = productPaymentRpcEnv(this.env);
    return network === "solana"
      ? solanaEndpoints(env as SolanaRpcEnv)[0]
      : authorizationEndpoints(env as ChainRpcEnv, network)[0];
  }
  private async call(url: string, method: string, params: unknown[]) {
    return paymentRpc(this.env, url, method, params, this.transport);
  }
  private transport: PaymentFetcher = async (url, init) => {
    const data = this.data!,
      now = this.now(),
      minute = Math.floor(now / 60_000);
    if (data.openUntil > now)
      throw new HttpError(
        503,
        "Payment checks will resume shortly.",
        Math.ceil((data.openUntil - now) / 1000),
      );
    if (data.openUntil > 0) data.openUntil = 0;
    if (data.budget.minute !== minute) data.budget = { minute, calls: 0 };
    if (data.budget.calls >= PRODUCT_PAYMENT_SCAN_LIMITS.rpcPerMinute)
      throw new HttpError(
        429,
        "Payment checks will resume shortly.",
        Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)),
      );
    data.budget.calls++;
    await this.save();
    try {
      const response = await this.fetcher(url, init);
      if (!response.ok) throw paymentRpcResponseError(response, this.now());
      const copy = response.clone(),
        reader = copy.body?.getReader();
      if (!reader)
        throw new HttpError(503, "Payment verification is unavailable.");
      let length = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1_048_576) {
          await reader.cancel();
          throw new HttpError(503, "Payment verification is unavailable.");
        }
        chunks.push(chunk.value);
      }
      reader.releaseLock();
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const checked = JSON.parse(new TextDecoder().decode(bytes)) as {
        error?: unknown;
      };
      if (checked.error)
        throw new HttpError(503, "Payment verification is unavailable.");
      this.providerSuccesses++;
      await this.save();
      return response;
    } catch (error) {
      const failedAt = this.now();
      data.errors++;
      this.providerFailures++;
      if (error instanceof HttpError && error.status === 429)
        data.openUntil = Math.max(
          data.openUntil,
          failedAt + (error.retryAfterSeconds ?? 60) * 1000,
        );
      if (data.errors >= PRODUCT_PAYMENT_SCAN_LIMITS.providerErrors)
        data.openUntil = Math.max(
          data.openUntil,
          failedAt + PRODUCT_PAYMENT_SCAN_LIMITS.cooldownMs,
        );
      await this.save();
      throw error;
    }
  };
  private async room(
    row: ScannedRequest,
    action: "event" | "credit",
    body: Record<string, unknown>,
  ) {
    if (!this.env.ROOMS)
      throw new HttpError(503, "Payment workspace is unavailable.");
    return this.env.ROOMS.get(
      this.env.ROOMS.idFromName(
        `native-room:${row.intent.workspace.replace(/^room:/, "")}`,
      ),
    ).fetch(
      new Request(`https://internal/private/product/payment-${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: row.intent.id, ...body }),
        ...(this.standard(row)
          ? {
              signal: AbortSignal.timeout(
                STANDARD_PAYMENT_CHECK_LIMITS.roomTimeoutMs,
              ),
            }
          : {}),
      }),
    );
  }
  private async emit(
    row: ScannedRequest,
    status: ProductPaymentIntent["status"],
    clearSubmission = false,
  ) {
    const response = await this.room(row, "event", {
      status,
      ...(clearSubmission && !this.standard(row)
        ? { clearSubmission: true }
        : {}),
      ...(row.intent.verificationReviewRequired
        ? { verificationReviewRequired: true }
        : {}),
      ...(row.submittedTx ? { tx: row.submittedTx } : {}),
      ...(!clearSubmission && row.intent.confirmation
        ? { confirmation: row.intent.confirmation }
        : {}),
      ...(row.nextFinalityAt ? { nextCheckAt: row.nextFinalityAt } : {}),
      ...(row.checkAgainAt ? { checkAgainAt: row.checkAgainAt } : {}),
    });
    if (!response.ok)
      throw new HttpError(503, "Payment status could not be saved.");
  }
  private async schedule() {
    if (!this.data || !Object.keys(this.data.requests).length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const now = this.now();
    let recovered = false;
    for (const row of Object.values(this.data.requests)) {
      // An unavailable initial receipt read must not defer its first real
      // proof for the network's estimated finality window. Keep the existing
      // attempt count, deadline and provider budget, including after restart.
      const firstCheck = now + STANDARD_PAYMENT_CHECK_LIMITS.backoffMs[0];
      if (
        this.standard(row) &&
        row.submittedTx &&
        row.intent.status === "open" &&
        !row.intent.confirmation &&
        !row.verificationAttempts &&
        !this.needsReview(row, now) &&
        row.nextFinalityAt !== undefined &&
        row.nextFinalityAt > firstCheck
      ) {
        row.nextFinalityAt = firstCheck;
        recovered = true;
      }
    }
    if (recovered) await this.save();
    const rows = Object.values(this.data.requests).filter(
      (row) =>
        !this.standard(row) ||
        (row.nextFinalityAt !== undefined &&
          !row.intent.verificationReviewRequired),
    );
    const active = new Set(
      (await this.openRequests(rows)).map((row) => row.intent.id),
    );
    const times = rows.flatMap((row) =>
      this.standard(row)
        ? [
            Math.min(
              row.attemptUntil!,
              active.has(row.intent.id) ? row.nextFinalityAt! : now + 60_000,
            ),
          ]
        : active.has(row.intent.id)
          ? [
              Date.parse(row.intent.expiresAt),
              ...(row.nextFinalityAt ? [row.nextFinalityAt] : []),
            ]
          : [Date.parse(row.intent.expiresAt), now + 60_000],
    );
    if (rows.some((row) => !this.standard(row) && active.has(row.intent.id)))
      times.push(
        ...Object.values(this.data.candidates ?? {}).map((candidate) =>
          candidate.needsMatch ? candidate.expiresAt : candidate.nextCheckAt,
        ),
      );
    if (
      this.data.nextDiscoveryAt !== undefined &&
      rows.some(
        (row) =>
          active.has(row.intent.id) &&
          row.nextScanAt !== null &&
          this.discoverySpacing(row, now) !== null,
      )
    )
      times.push(this.data.nextDiscoveryAt);
    if (!times.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    let next = Math.min(...times);
    if (this.data.openUntil > now) next = Math.max(next, this.data.openUntil);
    if (
      this.data.budget.calls >= PRODUCT_PAYMENT_SCAN_LIMITS.rpcPerMinute &&
      this.data.budget.minute === Math.floor(now / 60_000)
    )
      next = Math.max(next, (this.data.budget.minute + 1) * 60_000);
    await this.state.storage.setAlarm(Math.max(now + 1, next));
  }
  async fetch(request: Request): Promise<Response> {
    try {
      await this.loading;
      if (request.method !== "POST") throw new HttpError(404, "Not found.");
      const body = await readJson(request),
        action = new URL(request.url).pathname.slice(1),
        now = this.now();
      if (action === "register") {
        const intent = body.intent as ProductPaymentIntent;
        if (
          !intent ||
          typeof intent.id !== "string" ||
          !Object.hasOwn(PRODUCT_RAILS, intent.rail) ||
          PRODUCT_RAILS[intent.rail].network !== intent.network ||
          intent.workspace !== intent.room ||
          !(Date.parse(intent.expiresAt) > now) ||
          !["open", "seen"].includes(intent.status)
        )
          throw new HttpError(400, "Invalid payment request.");
        requireProductPaymentRail(await this.paymentEnv(intent), intent.rail);
        const config = paymentRecipients(this.env)[intent.rail];
        if (
          !config ||
          config.chain !== intent.network ||
          config.recipient !== intent.recipient ||
          config.asset !== intent.asset.address ||
          config.decimals !== intent.asset.decimals
        )
          throw new HttpError(503, "Payments are unavailable.");
        if (this.data && this.data.network !== intent.network)
          throw new HttpError(400, "Invalid payment network.");
        if (!this.data)
          this.data = {
            network: intent.network,
            requests: {},
            solanaCursors: {},
            pendingSolana: [],
            budget: { minute: Math.floor(now / 60_000), calls: 0 },
            errors: 0,
            openUntil: 0,
          };
        for (const [key, prior] of Object.entries(this.data.requests))
          if (this.standard(prior) && Date.parse(prior.intent.expiresAt) <= now)
            delete this.data.requests[key];
        if (
          Object.keys(this.data.requests).length >= 4096 &&
          !this.data.requests[intent.id]
        )
          throw new HttpError(503, "Payment checks are busy.");
        if (this.data.requests[intent.id]) {
          await this.schedule();
          return json({ ok: true });
        }
        if (!Object.keys(this.data.requests).length) {
          delete this.data.cursor;
          delete this.data.latest;
          delete this.data.nextDiscoveryAt;
          delete this.data.lastDiscoveryAt;
          delete this.data.catchingUp;
          this.data.solanaCursors = {};
          this.data.solanaPages = {};
          this.data.observedEvm = {};
        }
        const spacing =
          intent.status === "open" && intent.settlement !== "standard-prepaid"
            ? paymentScanSpacing(Date.parse(intent.createdAt), now)
            : null;
        if (spacing !== null)
          this.data.nextDiscoveryAt = Math.min(
            this.data.nextDiscoveryAt ?? now + 10_000,
            now + spacing,
          );
        this.data.requests[intent.id] = {
          intent,
          nextScanAt: spacing === null ? null : this.data.nextDiscoveryAt!,
        };
        await this.save();
        await this.schedule();
        return json({ ok: true });
      }
      if (!this.data) throw new HttpError(404, "Payment request not found.");
      const id = body.requestId;
      if (typeof id !== "string")
        throw new HttpError(400, "Choose a payment request.");
      const row = this.data.requests[id];
      if (action === "close") {
        if (row) {
          delete this.data.requests[id];
          await this.save();
          if (body.status === "replaced")
            this.state.waitUntil(
              this.emit(row, "replaced").catch(() => undefined),
            );
        }
        await this.schedule();
        return json({ ok: true });
      }
      if (!row) throw new HttpError(404, "Payment request not found.");
      if (Date.parse(row.intent.expiresAt) <= now) {
        delete this.data.requests[id];
        await this.save();
        await this.schedule();
        throw new HttpError(409, "This payment request has expired.");
      }
      const paymentEnv = await this.paymentEnv(row.intent);
      requireProductPaymentRail(paymentEnv, row.intent.rail);
      if (action === "verify") {
        const intent = body.intent as ProductPaymentIntent;
        const tx =
          typeof body.tx === "string" && row.intent.network !== "solana"
            ? body.tx.toLowerCase()
            : body.tx;
        if (
          !intent ||
          intent.id !== row.intent.id ||
          intent.network !== this.data.network ||
          intent.workspace !== row.intent.workspace ||
          typeof tx !== "string" ||
          tx !== row.submittedTx
        )
          throw new HttpError(503, "Payment checks are unavailable.");
        if (
          this.standard(row) &&
          (row.intent.verificationReviewRequired ||
            !row.verificationAttempts ||
            row.verificationAttempts >
              STANDARD_PAYMENT_CHECK_LIMITS.finalityAttempts ||
            row.attemptUntil === undefined ||
            now >= row.attemptUntil)
        )
          throw new HttpError(
            409,
            "This transfer needs a payment review. Do not send it again.",
            undefined,
            "product-payment-review-required",
          );
        const budget = createRpcBudget(this.env as Env);
        budget.setRoom(
          this.env.ROOMS!.get(
            this.env.ROOMS!.idFromName(
              `native-room:${intent.workspace.replace(/^room:/, "")}`,
            ),
          ),
        );
        return json({
          transfer: await verifyProductPayment(
            { ...paymentEnv, [RPC_BUDGET]: budget },
            intent,
            tx,
            {
              nowMs: now,
              rpc:
                this.proofCache ??
                createProductPaymentProofCache(this.transport),
              observeConfirmation: async (confirmation) => {
                if (this.data?.requests[id] !== row || row.submittedTx !== tx)
                  throw new HttpError(
                    409,
                    "The payment request changed. Review it again.",
                  );
                row.intent.confirmation = confirmation;
                // The Room is awaiting verification. Publish only after its credit call returns.
                await this.save();
              },
            },
          ),
        });
      }
      if (action === "blockhash") {
        if (this.data.network !== "solana")
          throw new HttpError(400, "Choose a Solana request.");
        const data = this.data;
        let latest = data.solanaBlockhash;
        if (!latest || now - latest.at >= 30_000) {
          this.blockhashFlight ??= (async () => {
            const failuresBefore = this.providerFailures;
            const result = (await this.call(
              this.primary(),
              "getLatestBlockhash",
              [{ commitment: "finalized" }],
            )) as {
              value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
            };
            if (
              typeof result?.value?.blockhash !== "string" ||
              !Number.isSafeInteger(result.value.lastValidBlockHeight)
            )
              throw new HttpError(503, "Payment transaction is unavailable.");
            const latest = {
              blockhash: result.value.blockhash,
              lastValidBlockHeight: Number(result.value.lastValidBlockHeight),
              at: now,
            };
            data.solanaBlockhash = latest;
            if (this.providerFailures === failuresBefore) data.errors = 0;
            await this.save();
            return latest;
          })().finally(() => {
            this.blockhashFlight = undefined;
          });
          latest = await this.blockhashFlight;
        }
        return json({
          recentBlockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        });
      }
      if (action === "submit") {
        this.assertChecksOpen(row);
        if (typeof body.tx !== "string")
          throw new HttpError(400, "Enter the transaction.");
        this.validateTransaction(row.intent.network, body.tx);
        const submittedTx =
          row.intent.network === "solana" ? body.tx : body.tx.toLowerCase();
        if (
          row.submittedTx === submittedTx ||
          row.submittedTransactions?.includes(submittedTx)
        ) {
          return json({
            seen: row.intent.status === "seen",
            nextCheckAt: row.nextFinalityAt,
            confirmation: row.intent.confirmation,
          });
        }
        if (
          (row.submittedTransactions?.length ?? 0) >=
          (this.standard(row)
            ? STANDARD_PAYMENT_CHECK_LIMITS.submissions
            : PRODUCT_PAYMENT_SCAN_LIMITS.maxSubmissionsPerRequest)
        )
          throw new HttpError(
            429,
            "You tried too many transactions for this payment request.",
          );
        if (row.checkAgainAt && row.checkAgainAt > now)
          throw new HttpError(
            429,
            "Wait a few seconds before you try another transaction.",
            Math.ceil((row.checkAgainAt - now) / 1000),
          );
        row.checkAgainAt = now + PRODUCT_PAYMENT_SCAN_LIMITS.requestCooldownMs;
        row.submittedTransactions = [
          ...(row.submittedTransactions ?? []),
          submittedTx,
        ];
        const previous = structuredClone(row);
        if (row.submittedTx !== submittedTx) delete row.intent.confirmation;
        row.submittedTx = submittedTx;
        delete row.recoveryTx;
        if (!this.standard(row)) {
          delete row.finalityRetries;
          delete row.lastFinalityAttemptAt;
        }
        delete row.missingReceiptSince;
        if (!this.standard(row) || row.attemptUntil === undefined)
          row.attemptUntil = Math.min(
            Date.parse(row.intent.expiresAt),
            now +
              (this.standard(row)
                ? STANDARD_PAYMENT_CHECK_LIMITS.windowMs
                : 86_400_000),
          );
        row.nextFinalityAt =
          now + expectedPaymentFinalitySeconds(row.intent.network) * 1000;
        const failuresBefore = this.providerFailures;
        const seen = await readProductPayment(
          paymentEnv,
          row.intent,
          submittedTx,
          {
            nowMs: now,
            fetcher: this.transport,
          },
        ).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 422) return null;
          throw error;
        });
        if (this.providerFailures === failuresBefore) this.data.errors = 0;
        if (seen) {
          try {
            await paymentLedgerCall(this.env, "claim", {
              paymentId: productTransferPaymentId(
                row.intent.network,
                seen.txHash,
                seen.logIndex ?? seen.instructionIndex ?? 0,
              ),
              workspace: row.intent.workspace,
              existingOnly: true,
            });
          } catch (error) {
            if (
              this.data.requests[id] === row &&
              row.submittedTx === submittedTx
            ) {
              previous.checkAgainAt = row.checkAgainAt;
              previous.submittedTransactions = row.submittedTransactions;
              this.data.requests[id] = previous;
            }
            throw error;
          }
          row.nextFinalityAt = this.firstProofAt(
            row.intent.network,
            seen.paidAt,
          );
          row.intent.status = "seen";
          row.intent.confirmation = seen.confirmation;
          row.nextScanAt = null;
        }
        await this.save();
        await this.schedule();
        return json({
          seen: Boolean(seen),
          nextCheckAt: row.nextFinalityAt,
          confirmation: row.intent.confirmation,
        });
      }
      if (action === "check" && this.standard(row)) {
        this.assertChecksOpen(row);
        if (!row.submittedTx)
          throw new HttpError(
            400,
            "Submit the transfer hash before checking it.",
          );
        // A status check cannot spend RPCs, advance a finality check or restart its deadline.
        await this.schedule();
        return json({
          status: row.intent.status,
          tx: row.submittedTx,
          nextCheckAt: row.nextFinalityAt,
          checkAgainAt: row.checkAgainAt,
          confirmation: row.intent.confirmation,
        });
      }
      if (action === "check") {
        if (row.checkAgainAt && row.checkAgainAt > now)
          throw new HttpError(
            429,
            "Wait before checking again.",
            Math.ceil((row.checkAgainAt - now) / 1000),
          );
        row.checkAgainAt = now + PRODUCT_PAYMENT_SCAN_LIMITS.requestCooldownMs;
        row.forceScan = true;
        row.nextScanAt = now;
        const discoveryAt = Math.max(
          now,
          (this.data.lastDiscoveryAt ?? 0) +
            PRODUCT_PAYMENT_SCAN_LIMITS.requestCooldownMs,
        );
        this.data.nextDiscoveryAt = Math.min(
          this.data.nextDiscoveryAt ?? discoveryAt,
          discoveryAt,
        );
        await this.save();
        if (row.submittedTx) {
          try {
            this.validateTransaction(row.intent.network, row.submittedTx);
          } catch (error) {
            this.resumeDiscovery(row);
            throw error;
          }
          row.attemptUntil = Math.min(
            Date.parse(row.intent.expiresAt),
            now + 86_400_000,
          );
          const failuresBefore = this.providerFailures;
          const seen = await readProductPayment(
            paymentEnv,
            row.intent,
            row.submittedTx,
            { nowMs: now, fetcher: this.transport },
          ).catch((error: unknown) => {
            if (error instanceof HttpError && error.status === 422) return null;
            throw error;
          });
          if (seen) {
            row.intent.status = "seen";
            row.intent.confirmation = seen.confirmation;
            row.nextScanAt = null;
            if (
              row.lastFinalityAttemptAt === undefined &&
              (seen.paidAt !== undefined || row.nextFinalityAt === undefined)
            )
              row.nextFinalityAt = this.firstProofAt(
                row.intent.network,
                seen.paidAt,
              );
          }
          if (this.providerFailures === failuresBefore) this.data.errors = 0;
          if (
            row.nextFinalityAt &&
            (row.nextFinalityAt <= now ||
              row.lastFinalityAttemptAt !== undefined)
          )
            row.nextFinalityAt = now;
        }
        await this.save();
        await this.schedule();
        return json({
          checkAgainAt: row.checkAgainAt,
          status: row.intent.status,
          tx: row.submittedTx,
          nextCheckAt: row.nextFinalityAt,
          confirmation: row.intent.confirmation,
        });
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      await this.save();
      await this.schedule();
      const mismatch = error as HttpError & {
        paymentIndex?: number;
        actualCents?: number | null;
        creditEligible?: boolean;
      };
      return json(
        {
          ...errorBody(error, "Payment checks are unavailable."),
          ...(new URL(request.url).pathname === "/verify" &&
          error instanceof HttpError &&
          error.status === 422
            ? {
                paymentIndex: mismatch.paymentIndex,
                actualCents: mismatch.actualCents,
                creditEligible: mismatch.creditEligible,
              }
            : {}),
        },
        error instanceof HttpError ? error.status : 503,
        error instanceof HttpError && error.retryAfterSeconds
          ? { "Retry-After": String(error.retryAfterSeconds) }
          : {},
      );
    }
  }
  async alarm() {
    await this.loading;
    if (this.flight) return this.flight;
    this.flight = this.tick().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  private async latest() {
    const data = this.data!,
      now = this.now();
    if (
      data.latest &&
      now - data.latest.at < PRODUCT_PAYMENT_SCAN_LIMITS.latestCacheMs
    )
      return BigInt(data.latest.number);
    const number = rpcQuantity(
      await this.call(this.primary(), "eth_blockNumber", []),
    );
    data.latest = { number: number.toString(), at: now };
    return number;
  }
  private async discoverEvm(rows: ScannedRequest[]) {
    const data = this.data!,
      network = data.network as Exclude<ProductPaymentNetwork, "solana">,
      configs = Object.entries(paymentRecipients(this.env))
        .filter(
          ([rail, row]) =>
            row.chain === network &&
            (this.railOpen(rail) ||
              rows.some((row) => row.intent.rail === rail)),
        )
        .map(([, row]) => row);
    if (!configs.length || !this.discoveryActive(rows)) return;
    const latest = await this.latest(),
      max = BigInt(PRODUCT_PAYMENT_SCAN_LIMITS.maxRange[network]),
      oldest = Math.min(...rows.map((row) => Date.parse(row.intent.createdAt))),
      blockMs =
        network === 1
          ? 12_000
          : network === 8453
            ? 2_000
            : network === 56
              ? 450
              : 100,
      lookback = BigInt(
        Math.ceil((Math.max(0, this.now() - oldest) + 120_000) / blockMs) + 2,
      ),
      overlap = BigInt(PRODUCT_PAYMENT_SCAN_LIMITS.reorgOverlap[network]),
      cursor = data.cursor
        ? data.catchingUp
          ? BigInt(data.cursor)
          : BigInt(data.cursor) > overlap
            ? BigInt(data.cursor) - overlap
            : 0n
        : latest > lookback
          ? latest - lookback
          : 0n,
      from = cursor > latest ? latest : cursor,
      to = from + max - 1n < latest ? from + max - 1n : latest;

    if (from > to) return;
    const receivers = [
      ...new Set(
        configs.map(
          (row) =>
            `0x${row.recipient.slice(2).toLowerCase().padStart(64, "0")}`,
        ),
      ),
    ];
    if (!this.discoveryActive(rows)) return;
    const logs = await this.call(this.primary(), "eth_getLogs", [
      {
        address: [...new Set(configs.map((row) => row.asset))],
        topics: [
          PRODUCT_TRANSFER_TOPIC,
          null,
          receivers.length === 1 ? receivers[0] : receivers,
        ],
        fromBlock: toHex(from),
        toBlock: toHex(to),
      },
    ]);
    if (!Array.isArray(logs) || logs.length > 4096)
      throw new HttpError(503, "Payment discovery is unavailable.");
    if (
      logs.some(
        (row) =>
          !row ||
          typeof row.transactionHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(row.transactionHash),
      )
    )
      throw new HttpError(503, "Payment discovery is unavailable.");
    const transactions = [
      ...new Set(
        logs
          .filter((row) => row.removed !== true)
          .map((row) => row.transactionHash.toLowerCase())
          .filter(
            (tx): tx is string =>
              typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx),
          ),
      ),
    ];
    data.pendingEvm = [
      ...new Set([...transactions, ...(data.pendingEvm ?? [])]),
    ];
    data.cursor = (to + 1n).toString();
    data.catchingUp = to < latest;
    this.advanceDiscovery(rows);
    // Keep parsed hashes only while their blocks can appear in the overlap.
    for (const [tx, blockNumber] of Object.entries(data.observedEvm ?? {}))
      if (BigInt(blockNumber) < from) delete data.observedEvm![tx];
    await this.save();
    for (const tx of [...data.pendingEvm]) {
      if (
        ((data.observedEvm?.[tx] || data.candidates?.[tx]) &&
          !data.candidates?.[tx]?.needsMatch) ||
        rows.some(
          (row) => row.submittedTx === tx && row.intent.status === "seen",
        )
      ) {
        data.pendingEvm = data.pendingEvm.filter((hash) => hash !== tx);
        continue;
      }
      if (!this.discoveryActive(rows)) return;
      const rawReceipt = await this.call(
          this.primary(),
          "eth_getTransactionReceipt",
          [tx],
        ),
        receipt = normalizeReceipt(rawReceipt);
      if (!receipt) continue;
      if (receipt.transactionHash !== tx.toLowerCase())
        throw new HttpError(503, "Payment receipt cannot be verified.");
      const paidAt = paymentReceiptTime(rawReceipt);
      let matched = false;
      for (const row of rows) {
        if (!data.requests[row.intent.id]) continue;
        try {
          const seen =
            row.intent.kind === "evm"
              ? matchEvmProductTransfer(receipt, row.intent)
              : null;
          if (seen) {
            if (
              paidAt !== undefined &&
              (paidAt < Date.parse(row.intent.createdAt) - 120_000 ||
                paidAt > this.now())
            )
              continue;
            const submitted = row.submittedTx ?? row.recoveryTx;
            if (
              submitted &&
              submitted !== tx &&
              seen.amountRaw !== row.intent.amountRaw
            )
              continue;
            const changed = row.submittedTx !== tx;
            row.submittedTx = tx;
            delete row.recoveryTx;
            row.intent.status = "seen";
            row.intent.confirmation = {
              kind: "evm",
              transactionBlock: rpcQuantity(receipt.blockNumber).toString(),
              finalizedBlock: null,
              remainingBlocks: null,
              checkedAt: new Date(this.now()).toISOString(),
            };
            row.nextScanAt = null;
            if (
              changed ||
              (row.lastFinalityAttemptAt === undefined &&
                (paidAt !== undefined || row.nextFinalityAt === undefined))
            )
              row.nextFinalityAt = this.firstProofAt(network, paidAt);
            if (changed) {
              delete row.finalityRetries;
              delete row.lastFinalityAttemptAt;
              delete row.missingReceiptSince;
            }
            row.attemptUntil = Math.min(
              Date.parse(row.intent.expiresAt),
              this.now() + 86_400_000,
            );
            await this.emit(row, "seen");
            delete data.candidates?.[tx];
            matched = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 422)
            throw error;
        }
      }
      if (!matched) {
        data.candidates ??= {};
        data.candidates[tx] = {
          nextCheckAt:
            this.now() + expectedPaymentFinalitySeconds(network) * 1000,
          expiresAt: this.now() + 86_400_000,
          observedAfter:
            Math.min(...rows.map((row) => Date.parse(row.intent.createdAt))) -
            120_000,
        };
      }
      data.observedEvm ??= {};
      data.observedEvm[tx] = rpcQuantity(receipt.blockNumber).toString();
      data.pendingEvm = data.pendingEvm.filter((hash) => hash !== tx);
      await this.save();
    }
  }
  /** Each accepted mint needs one ATA query per tick. Fresh-head queries
   * alternate with catch-up pages, bounded by the oldest request's payment time.
   * Signatures are persisted before parsing so budget delays retain them. */
  private async discoverSolana(rows: ScannedRequest[]) {
    const data = this.data!,
      configs = Object.entries(paymentRecipients(this.env))
        .filter(
          ([rail, row]) =>
            row.chain === "solana" &&
            (this.railOpen(rail) ||
              rows.some((row) => row.intent.rail === rail)),
        )
        .map(([, row]) => row);
    for (const config of configs) {
      if (!this.discoveryActive(rows)) return;
      const ata = productTokenAccount(config.asset, config.recipient),
        backlog = data.solanaPages?.[ata],
        page = backlog?.catchUpNext ? backlog.pages[0] : undefined,
        until = page ? page.until : data.solanaCursors[ata],
        result = await this.call(this.primary(), "getSignaturesForAddress", [
          ata,
          {
            commitment: "confirmed",
            limit: 1000,
            ...(until ? { until } : {}),
            ...(page ? { before: page.before } : {}),
          },
        ]);
      if (!Array.isArray(result) || result.length > 1000)
        throw new HttpError(503, "Payment discovery is unavailable.");
      if (
        result.some(
          (row) =>
            !isSolanaPaymentSignature(row?.signature) ||
            (row.blockTime !== null && !Number.isSafeInteger(row.blockTime)),
        )
      )
        throw new HttpError(503, "Payment discovery is unavailable.");
      const oldest =
          Math.min(...rows.map((row) => Date.parse(row.intent.createdAt))) -
          120_000,
        boundary = result.findIndex(
          (row) => row.blockTime !== null && row.blockTime * 1000 < oldest,
        ),
        recent = boundary < 0 ? result : result.slice(0, boundary),
        signatures = recent
          .map((row) => row?.signature)
          .filter((signature): signature is string =>
            isSolanaPaymentSignature(signature),
          );
      data.pendingSolana = [...new Set([...signatures, ...data.pendingSolana])];
      const more = result.length === 1000 && boundary < 0;
      if (page && backlog) {
        if (more) page.before = signatures.at(-1)!;
        else backlog.pages.shift();
        backlog.catchUpNext = false;
        if (!backlog.pages.length) delete data.solanaPages![ata];
      } else {
        const newest = result[0]?.signature;
        if (newest) data.solanaCursors[ata] = newest;
        if (more) {
          data.solanaPages ??= {};
          data.solanaPages[ata] ??= { pages: [], catchUpNext: false };
          data.solanaPages[ata].pages.push({
            before: signatures.at(-1)!,
            ...(until ? { until } : {}),
          });
        }
        if (data.solanaPages?.[ata])
          data.solanaPages[ata].catchUpNext = Boolean(backlog);
      }
      await this.save();
    }
    this.advanceDiscovery(rows);
    for (const signature of [...data.pendingSolana]) {
      if (
        (data.candidates?.[signature] &&
          !data.candidates[signature].needsMatch) ||
        rows.some(
          (row) =>
            row.submittedTx === signature && row.intent.status === "seen",
        )
      ) {
        data.pendingSolana = data.pendingSolana.filter(
          (item) => item !== signature,
        );
        continue;
      }
      if (!this.discoveryActive(rows)) return;
      const tx = await this.call(this.primary(), "getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (tx === null) continue;
      let matched = false;
      for (const row of rows) {
        if (!data.requests[row.intent.id]) continue;
        try {
          const seen =
            row.intent.kind === "solana"
              ? matchSolanaProductTransfer(tx, row.intent, this.now())
              : null;
          if (seen) {
            const submitted = row.submittedTx ?? row.recoveryTx;
            if (
              submitted &&
              submitted !== signature &&
              seen.amountRaw !== row.intent.amountRaw
            )
              continue;
            const changed = row.submittedTx !== signature;
            row.submittedTx = signature;
            delete row.recoveryTx;
            row.intent.status = "seen";
            row.intent.confirmation = {
              kind: "solana",
              slot: String((tx as { slot: number }).slot),
              commitment: "confirmed",
              checkedAt: new Date(this.now()).toISOString(),
            };
            row.nextScanAt = null;
            if (
              changed ||
              (row.lastFinalityAttemptAt === undefined &&
                (seen.paidAt !== undefined || row.nextFinalityAt === undefined))
            )
              row.nextFinalityAt = this.firstProofAt("solana", seen.paidAt);
            if (changed) {
              delete row.finalityRetries;
              delete row.lastFinalityAttemptAt;
              delete row.missingReceiptSince;
            }
            row.attemptUntil = Math.min(
              Date.parse(row.intent.expiresAt),
              this.now() + 86_400_000,
            );
            await this.emit(row, "seen");
            delete data.candidates?.[signature];
            matched = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 422)
            throw error;
        }
      }
      if (!matched) {
        data.candidates ??= {};
        data.candidates[signature] = {
          nextCheckAt:
            this.now() + expectedPaymentFinalitySeconds("solana") * 1000,
          expiresAt: this.now() + 86_400_000,
          observedAfter:
            Math.min(...rows.map((row) => Date.parse(row.intent.createdAt))) -
            120_000,
        };
      }
      data.pendingSolana = data.pendingSolana.filter((tx) => tx !== signature);
      await this.save();
    }
  }
  private async tick() {
    if (!this.data || !Object.keys(this.data.requests).length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const data = this.data,
      now = this.now();
    this.proofCache = createProductPaymentProofCache(this.transport);
    const failuresBefore = this.providerFailures,
      successesBefore = this.providerSuccesses;
    try {
      for (const [id, row] of Object.entries(data.requests)) {
        if (Date.parse(row.intent.expiresAt) <= now) {
          row.intent.status = "expired";
          delete data.requests[id];
          await this.save();
          try {
            await this.emit(row, "expired");
          } catch (error) {
            console.warn(
              JSON.stringify({
                event: "TEMPL_PAYMENT_EVENT_DELAYED",
                network: data.network,
                cause: error instanceof HttpError ? error.status : 503,
              }),
            );
          }
        }
      }
      for (const row of Object.values(data.requests)) {
        if (
          this.needsReview(row, now) &&
          !row.intent.verificationReviewRequired
        ) {
          this.stopChecks(row);
          await this.emit(row, row.intent.status);
        }
      }
      if (!Object.keys(data.requests).length) return;
      const active = await this.openRequests(Object.values(data.requests));
      if (!active.length) return;
      for (const row of [...active].sort(
        (a, b) =>
          (a.lastFinalityAttemptAt ?? -1) - (b.lastFinalityAttemptAt ?? -1),
      )) {
        if (!row.submittedTx || !row.nextFinalityAt || row.nextFinalityAt > now)
          continue;
        try {
          this.validateTransaction(row.intent.network, row.submittedTx);
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 400)
            throw error;
          this.resumeDiscovery(row);
          await this.emit(row, "open", true);
          continue;
        }
        if (row.attemptUntil && now >= row.attemptUntil) {
          if (this.standard(row)) {
            this.stopChecks(row);
            await this.emit(row, row.intent.status);
          }
          row.nextFinalityAt = undefined;
          continue;
        }
        if (data.openUntil > now)
          throw new HttpError(503, "Payment checks will resume shortly.");
        if (data.budget.minute !== Math.floor(now / 60_000))
          data.budget = { minute: Math.floor(now / 60_000), calls: 0 };
        if (data.budget.calls >= PRODUCT_PAYMENT_SCAN_LIMITS.rpcPerMinute)
          throw new HttpError(429, "Payment checks will resume shortly.", 60);
        row.lastFinalityAttemptAt = now;
        if (this.standard(row))
          row.verificationAttempts = (row.verificationAttempts ?? 0) + 1;
        await this.save();
        const errorsBeforeProof = data.errors;
        const response = await this.room(row, "credit", {
          tx: row.submittedTx,
        });
        if (!response.ok) {
          const refused = await response
            .clone()
            .json<{ reason?: unknown; error?: unknown }>()
            .catch(() => ({}) as { reason?: unknown; error?: unknown });
          const reasons = [
            "product-payment-receipt-missing",
            "product-payment-review-required",
            "product-payment-already-credited",
            "product-checkout-unavailable",
          ];
          const errors: Record<string, string> = {
            "Chat usage is temporarily unavailable.":
              "usage-budget-unavailable",
            "Payment verification is unavailable.": "provider-unavailable",
            "Payment network could not be verified.": "network-unverified",
            "Independent payment reads disagree.": "provider-disagreement",
            "Finalized chain state is unavailable.": "finalized-head-invalid",
            "Payment receipt cannot be verified.": "receipt-invalid",
            "Payments are unavailable.": "payments-unavailable",
            "The workspace could not answer.": "workspace-unavailable",
            "The transfer is still confirming.": "awaiting-finality",
          };
          const reason =
            typeof refused.reason === "string" &&
            reasons.includes(refused.reason)
              ? refused.reason
              : typeof refused.error === "string" &&
                  Object.hasOwn(errors, refused.error)
                ? errors[refused.error]
                : "other";
          console.warn(
            JSON.stringify({
              event: "TEMPL_PAYMENT_PROOF_RETRY",
              stage: "room-credit",
              status: response.status,
              reason,
            }),
          );
        }
        if (response.ok) {
          const answer = await response.json<{
            receipt?: unknown;
            unmatched?: unknown;
            intent?: ProductPaymentIntent;
          }>();
          if (answer.receipt) {
            if (answer.intent?.status === "credited") {
              delete data.requests[row.intent.id];
            } else {
              this.resumeDiscovery(row);
            }
          } else if (answer.unmatched) {
            this.resumeDiscovery(row);
          }
          if (
            this.standard(row) &&
            data.requests[row.intent.id] &&
            !row.intent.verificationReviewRequired
          ) {
            this.retryFinality(row, now);
            await this.emit(row, row.intent.status);
          }
        } else if (response.status === 400) {
          this.resumeDiscovery(row);
          await this.emit(row, "open", true);
        } else if (response.status === 403 || response.status === 404) {
          delete data.requests[row.intent.id];
        } else {
          const result = await response.json<{ reason?: string }>();
          if (response.status === 503 && data.errors === errorsBeforeProof) {
            data.errors++;
            this.providerFailures++;
            if (data.errors >= PRODUCT_PAYMENT_SCAN_LIMITS.providerErrors)
              data.openUntil = Math.max(
                data.openUntil,
                now + PRODUCT_PAYMENT_SCAN_LIMITS.cooldownMs,
              );
          }
          if (
            response.status === 409 &&
            result.reason === "product-payment-receipt-missing" &&
            !this.standard(row)
          ) {
            row.missingReceiptSince ??= now;
            if (
              now - row.missingReceiptSince >=
              PRODUCT_PAYMENT_SCAN_LIMITS.missingReceiptGraceMs
            ) {
              this.resumeDiscovery(row, true);
              delete data.cursor;
              delete data.catchingUp;
              data.solanaCursors = {};
              data.solanaPages = {};
              for (const [tx, candidate] of Object.entries(
                data.candidates ?? {},
              )) {
                candidate.needsMatch = true;
                delete data.observedEvm?.[tx];
              }
              row.nextScanAt = now;
              row.forceScan = true;
              data.nextDiscoveryAt = now;
              await this.emit(row, "open", true);
              continue;
            }
          } else {
            delete row.missingReceiptSince;
          }
          if (response.status === 429)
            data.openUntil = Math.max(
              data.openUntil,
              now +
                Math.min(
                  300,
                  Math.max(
                    1,
                    Number(response.headers.get("Retry-After")) || 60,
                  ),
                ) *
                  1000,
            );
          this.retryFinality(row, now);
          if (row.nextFinalityAt !== undefined)
            row.nextFinalityAt = Math.max(row.nextFinalityAt, data.openUntil);
          await this.emit(row, row.intent.status);
        }
      }
      for (const row of active)
        if (
          this.data.requests[row.intent.id] &&
          row.intent.verificationReviewRequired
        )
          await this.emit(row, row.intent.status);
      if (!Object.keys(data.requests).length) return;
      const scanning = await this.openRequests(
        Object.values(data.requests).filter((row) => !this.standard(row)),
      );
      for (const row of scanning)
        if (this.discoverySpacing(row, this.now()) === null)
          row.nextScanAt = null;
      if (!this.discoveryActive(scanning)) delete data.nextDiscoveryAt;
      if (
        data.nextDiscoveryAt !== undefined &&
        data.nextDiscoveryAt <= now &&
        scanning.some((row) => row.nextScanAt !== null)
      ) {
        if (data.network === "solana") await this.discoverSolana(scanning);
        else await this.discoverEvm(scanning);
        this.advanceDiscovery(scanning);
        if (!data.catchingUp && !Object.keys(data.solanaPages ?? {}).length)
          for (const [tx, candidate] of Object.entries(data.candidates ?? {}))
            if (
              !data.pendingEvm?.includes(tx) &&
              !data.pendingSolana.includes(tx)
            )
              delete candidate.needsMatch;
      }
      for (const [tx, candidate] of Object.entries(
        scanning.length ? (data.candidates ?? {}) : {},
      )) {
        if (candidate.expiresAt <= now) {
          delete data.candidates![tx];
          continue;
        }
        if (candidate.needsMatch) continue;
        if (candidate.nextCheckAt > now) continue;
        try {
          const inbound = await verifyInboundProductPayment(
            await this.scanEnv(scanning),
            data.network,
            tx,
            { nowMs: now, rpc: this.proofCache },
          );
          const oldest =
            candidate.observedAfter ??
            Math.min(
              ...Object.values(data.requests).map((row) =>
                Date.parse(row.intent.createdAt),
              ),
            ) - 120_000;
          for (const row of inbound)
            if (row.paidAt >= oldest)
              await paymentLedgerCall(this.env, "unmatched", { row });
          delete data.candidates![tx];
        } catch (error) {
          if (error instanceof HttpError && error.status === 422) {
            delete data.candidates![tx];
            continue;
          }
          candidate.nextCheckAt = now + 30_000;
          throw error;
        }
      }
      if (
        this.providerFailures === failuresBefore &&
        this.providerSuccesses > successesBefore
      )
        data.errors = 0;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "TEMPL_PAYMENT_SCAN_DELAYED",
          network: data.network,
          cause: error instanceof HttpError ? error.status : 503,
        }),
      );
      const failedAt = this.now(),
        retryAt = Math.max(
          failedAt + 10_000,
          error instanceof HttpError && error.retryAfterSeconds
            ? failedAt + error.retryAfterSeconds * 1000
            : 0,
          data.openUntil,
          data.budget.calls >= PRODUCT_PAYMENT_SCAN_LIMITS.rpcPerMinute
            ? (Math.floor(failedAt / 60_000) + 1) * 60_000
            : 0,
        );
      if (
        !(await this.openRequests(Object.values(data.requests))).some(
          (row) => this.discoverySpacing(row, retryAt) !== null,
        )
      )
        delete data.nextDiscoveryAt;
      else if (
        data.nextDiscoveryAt !== undefined &&
        data.nextDiscoveryAt <= failedAt
      )
        data.nextDiscoveryAt = retryAt;
      for (const candidate of Object.values(data.candidates ?? {})) {
        if (candidate.nextCheckAt <= now)
          candidate.nextCheckAt = Math.max(retryAt, now + 30_000);
      }
      for (const row of Object.values(data.requests)) {
        if (this.discoverySpacing(row, retryAt) === null) row.nextScanAt = null;
        else if (row.nextScanAt !== null && row.nextScanAt <= failedAt)
          row.nextScanAt = retryAt;
        if (row.nextFinalityAt && row.nextFinalityAt <= now)
          this.retryFinality(row, now);
        if (row.nextFinalityAt)
          row.nextFinalityAt = Math.max(row.nextFinalityAt, retryAt);
        if (row.intent.verificationReviewRequired)
          await this.emit(row, row.intent.status).catch(() => undefined);
      }
    } finally {
      this.proofCache = undefined;
      await this.save();
      await this.schedule();
    }
  }
}
